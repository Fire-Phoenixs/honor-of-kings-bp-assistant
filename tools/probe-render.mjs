#!/usr/bin/env node
/**
 * probe-render —— 页面渲染探针（一次性、单页、限速）
 *
 * 用途：给「数据由 JS 渲染、静态 HTML 拿不到」的页面取可见文本。
 * 合规口径：
 *   - 只打开 1 个页面（模拟真人浏览），不构造/重放任何数据接口请求；
 *   - 每次运行结束后关闭浏览器；不做翻页、不做批量、不做并发。
 * 依赖：本机 Chrome/Edge + Node ≥ 22（原生 WebSocket），需在 full-access 沙箱下运行。
 *
 * 用法：
 *   node tools/probe-render.mjs <url> [--wait 8000] [--out data/research/render.txt]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return '';
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0; this.pending = new Map(); this.closed = false; this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message || 'CDP error')) : resolve(msg.result || {});
        return;
      }
      if (msg.method) (this.listeners.get(msg.method) || []).forEach((fn) => { try { fn(msg.params || {}); } catch { /* ignore */ } });
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  on(method, fn) {
    const arr = this.listeners.get(method) || [];
    arr.push(fn); this.listeners.set(method, arr);
  }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('CDP 已断开'));
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//.test(a));
if (!url) { console.log('用法: node tools/probe-render.mjs <url> [--wait 8000] [--out 文件]'); process.exit(1); }
const getOpt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WAIT = Number(getOpt('--wait', '9000'));
const OUT = getOpt('--out', '');
const EVAL = getOpt('--eval', '');

const json = async (u, t = 2000) => {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(t) }); return await r.json(); } catch { return null; }
};

let chromeProc = null, cdp = null;
async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');
  console.log('浏览器：' + chrome);
  console.log('目标页面：' + url);

  const dbgPort = 9600 + Math.floor(Math.random() * 300);
  const profile = path.join(os.tmpdir(), `hokprobe-${process.pid}-${Date.now()}`);
  chromeProc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,1600', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let dbg = null;
  for (let i = 0; i < 80; i++) {
    dbg = await json(`http://127.0.0.1:${dbgPort}/json/version`, 1500);
    if (dbg && dbg.webSocketDebuggerUrl) break;
    await sleep(150);
  }
  if (!dbg) throw new Error('Chrome 调试端口未就绪');

  const list = await json(`http://127.0.0.1:${dbgPort}/json/list`, 3000) || [];
  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可调试页面');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const netLog = [];
  const dumpIds = [];
  const DUMP = getOpt('--dump', '');
  if (argv.includes('--net') || DUMP) {
    await cdp.send('Network.enable');
    cdp.on('Network.responseReceived', (p) => {
      const r = p.response || {};
      const u = r.url || '';
      if (DUMP && u.includes(DUMP)) dumpIds.push({ u, id: p.requestId });
      if (argv.includes('--net')) {
        if (/\.(png|jpe?g|gif|css|woff2?|svg)(\?|$)/i.test(u)) return;
        if (/javascript|text\/css|image\//i.test(r.mimeType || '')) return;
        if (/xhr|json/i.test(r.mimeType || '') || /api|ajax|data|match/i.test(u)) {
          netLog.push({ u, m: r.mimeType, s: r.status });
        }
      }
    });
  }
  await cdp.send('Page.navigate', { url });

  // 等渲染：轮询可见文本长度，连续 3 次稳定或超时即取
  const t0 = Date.now();
  let last = -1, stable = 0, text = '';
  while (Date.now() - t0 < WAIT) {
    await sleep(700);
    const r = await cdp.send('Runtime.evaluate', {
      expression: '(document.body ? document.body.innerText : "")', returnByValue: true,
    }).catch(() => null);
    text = (r && r.result && r.result.value) || '';
    if (text.length === last) { stable++; if (stable >= 3) break; } else { stable = 0; last = text.length; }
  }

  const title = (await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    .catch(() => null))?.result?.value || '';
  const finalUrl = (await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
    .catch(() => null))?.result?.value || url;

  console.log('\n=== 渲染结果 ===');
  console.log('标题：' + title);
  console.log('最终 URL：' + finalUrl);
  console.log('可见文本长度：' + text.length + '（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  console.log('----------------');
  console.log(text.slice(0, 4000));
  if (text.length > 4000) console.log(`\n…（截断，全文 ${text.length} 字，见输出文件）`);

  // --links：列出页面上的链接与带行为的按钮，便于找到「数据/详情」入口
  if (argv.includes('--links')) {
    const expr = `JSON.stringify({
      links: [...document.querySelectorAll('a[href]')].map(a => ({ t: (a.innerText||'').trim().replace(/\\s+/g,' ').slice(0,24), h: a.getAttribute('href') })).filter(x => x.t || x.h).slice(0, 80),
      btns: [...document.querySelectorAll('button, [onclick], [data-url], [data-id], [data-matchid]')].map(b => ({ t: (b.innerText||'').trim().replace(/\\s+/g,' ').slice(0,20), onclick: (b.getAttribute('onclick')||'').slice(0,100), du: b.getAttribute('data-url'), di: b.getAttribute('data-id') || b.getAttribute('data-matchid') })).slice(0, 60)
    })`;
    const info = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }).catch(() => null);
    let parsed = null;
    try { parsed = JSON.parse(info.result.value); } catch { /* ignore */ }
    if (parsed) {
      console.log('\n=== 链接（a[href]）===');
      parsed.links.filter((x) => /数据|详情|回放|match|detail/i.test(x.t + x.h)).slice(0, 25)
        .forEach((x) => console.log(`  [${x.t}] → ${x.h}`));
      console.log('\n=== 按钮 / 带 data 属性元素 ===');
      parsed.btns.filter((x) => /数据|详情/.test(x.t) || x.du || x.di).slice(0, 25)
        .forEach((x) => console.log(`  [${x.t}] onclick=${x.onclick || '-'} data-url=${x.du || '-'} data-id=${x.di || '-'}`));
    }
  }

  // --eval：在页面上下文执行一段表达式（只读，用于查页面函数/结构）
  if (EVAL) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { try { return String(${EVAL}); } catch (e) { return 'ERR: ' + e.message; } })()`,
      returnByValue: true,
    }).catch(() => null);
    console.log('\n=== --eval 结果 ===');
    console.log((r && r.result && r.result.value || '(空)').slice(0, 2000));
  }

  // --net：列出本次渲染过程中页面自身发起的非静态资源请求（用于定位数据来源，不重放）
  if (argv.includes('--net')) {
    const seen = new Map();
    for (const n of netLog) if (!seen.has(n.u)) seen.set(n.u, n);
    console.log('\n=== 页面自身请求（--net，仅供定位数据来源）===');
    [...seen.values()].slice(0, 40).forEach((n) => console.log(`  ${n.s} ${n.m} ${n.u.slice(0, 160)}`));
    if (!seen.size) console.log('  (无 XHR/JSON 请求)');
  }

  // --dump：把页面自身已加载的匹配响应体原样存盘（只读取，不重发请求）
  if (DUMP && dumpIds.length) {
    const dir = path.join(ROOT, 'data/research/dump');
    fs.mkdirSync(dir, { recursive: true });
    console.log('\n=== --dump：页面自身加载的响应体 ===');
    for (const d of dumpIds) {
      const body = await cdp.send('Network.getResponseBody', { requestId: d.id }).catch(() => null);
      if (!body) { console.log('  (取不到) ' + d.u.slice(0, 120)); continue; }
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const m = /[?&](match_id|league_id)=(\d+)/.exec(d.u);
      const name = `dump-${(m ? m[1] + '-' + m[2] : 'resp')}-${Date.now() % 100000}.json`;
      fs.writeFileSync(path.join(dir, name), text, 'utf8');
      console.log(`  ${d.u.slice(0, 110)} → ${name}（${text.length} 字）`);
    }
  }

  if (OUT) {
    const p = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${title}\n# ${finalUrl}\n# fetched ${new Date().toISOString()}\n\n${text}`, 'utf8');
    console.log('\n已保存：' + p);
  }
}

main().catch((e) => { console.error('失败：' + e.message); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.close();
  if (chromeProc && chromeProc.pid) {
    try { chromeProc.kill('SIGKILL'); } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  await sleep(300);
});
