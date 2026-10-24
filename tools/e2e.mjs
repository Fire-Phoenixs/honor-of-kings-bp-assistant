#!/usr/bin/env node
/**
 * tools/e2e.mjs — 王者荣耀 BP 平台 v2 浏览器端 E2E（零 npm 依赖）
 *
 * 用 Chrome DevTools Protocol 驱动无头 Chrome，逐条验证 2026-10-24 的 5 条反馈：
 *   1) 取消分路绑定；Pick 写清「谁（楼层+名字）选了什么」
 *   2) 补池建议不重复
 *   3) 三档熟练度可设置且进入评分
 *   4) BP 先 Ban 后 Pick；Ban 完缩略展示；支持对面空 ban
 *   5) 头像在名字旁 + 分类标签；全程鼠标可点
 *
 * 运行：node tools/e2e.mjs [--keep]
 *   产物：.e2e/*.png 截图 + 终端 PASS/FAIL 汇总；有 FAIL 时 exit 1。
 *   依赖：本机 Chrome（可用 CHROME_PATH 覆盖）、Node ≥ 22（原生 WebSocket）。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.e2e');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 结果汇总 ---------------- */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ↳ ${detail}` : ''}`);
}
const snip = (v, n = 300) => {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s == null) s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return '';
}

async function getJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text), text }; } catch { return { status: res.status, json: null, text }; }
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket 错误：' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'} (${msg.error.code})`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        const arr = this.listeners.get(msg.method) || [];
        arr.forEach((fn) => { try { fn(msg.params || {}); } catch { /* ignore */ } });
      }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('CDP 已断开'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const arr = this.listeners.get(method) || [];
    arr.push(fn);
    this.listeners.set(method, arr);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ---------------- 主流程 ---------------- */
let serverProc = null, chromeProc = null, cdp = null, browserCdp = null;
let serverLog = '', serverLogPath = '';
let pageErrors = [];
let currentPort = 0;
let storeBackup = null;
let seededStore = false;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* 0. 备份真实存档：E2E 会在设置页改池子并自动保存，跑完必须原样还原 */
  const storePath = path.join(ROOT, 'data', 'store.json');
  // 克隆后首次运行没有真实存档：用 data/store.sample.json 播种，跑完再删掉，保持工作区干净
  if (!fs.existsSync(storePath)) {
    const sample = path.join(ROOT, 'data', 'store.sample.json');
    if (fs.existsSync(sample)) {
      fs.copyFileSync(sample, storePath);
      seededStore = true;
      console.log('data/store.json 不存在 → 已用 data/store.sample.json 播种（跑完删除）');
    }
  }
  storeBackup = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null;
  console.log(storeBackup === null
    ? 'data/store.json 不存在（克隆后首次运行），跑完不落盘'
    : '已备份 data/store.json（跑完还原）');

  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH 环境变量');
  console.log(`浏览器：${chrome}`);

  /* 1. 启动服务（随机端口） */
  serverLogPath = path.join(os.tmpdir(), `hokbp-e2e-server-${process.pid}.log`);
  const fd = fs.openSync(serverLogPath, 'w');
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', '0'], {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
  });
  let port = 0;
  for (let i = 0; i < 60; i++) {
    try { serverLog = fs.readFileSync(serverLogPath, 'utf8'); } catch { serverLog = ''; }
    const m = serverLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { port = Number(m[1]); break; }
    await sleep(150);
  }
  if (!port) throw new Error('服务未启动：' + snip(serverLog || '(空)'));
  currentPort = port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`服务：${base}`);
  const home = await getJson(base + '/', 5000);
  check('服务首页可访问', home.status === 200 && /<title/.test(home.text), `status=${home.status}`);

  /* 2. 启动无头 Chrome */
  const dbgPort = 9400 + Math.floor(Math.random() * 400);
  const profile = path.join(os.tmpdir(), `hokbp-e2e-profile-${process.pid}-${Date.now()}`);
  chromeProc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1440,1400', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let dbg = null;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await getJson(`http://127.0.0.1:${dbgPort}/json/version`, 1500);
      if (v.json && v.json.webSocketDebuggerUrl) { dbg = v.json; break; }
    } catch { /* not ready */ }
    await sleep(150);
  }
  if (!dbg) throw new Error('Chrome 远程调试端口未就绪');
  browserCdp = new CDP(dbg.webSocketDebuggerUrl);
  await browserCdp.ready;

  /* 3. 新建标签页并连接 */
  const target = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  await sleep(200);
  const attach = await browserCdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  // flatten 模式下直接用 sessionId 发消息：这里简化 —— 改为通过 /json/list 拿页面 ws
  const list = await getJson(`http://127.0.0.1:${dbgPort}/json/list`, 3000);
  const page = (list.json || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可调试的页面 target');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;

  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && p.entry.level === 'error' && !/favicon/i.test(p.entry.text || '')) pageErrors.push(p.entry.text);
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.navigate', { url: base + '/' });
  await waitFor('页面加载完成', async () => {
    const r = await evalJs('document.readyState');
    return r === 'complete';
  }, 15000);

  /* ---------------- 工具 ---------------- */
  async function evalJs(expr, timeoutMs = 8000) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(function(){ try { return (${expr}); } catch(e) { return '__ERR__:'+(e&&e.message||e); } })()`,
      returnByValue: true, awaitPromise: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        r.exceptionDetails.text || '未知页面异常';
      throw new Error('页面异常：' + d + '\nEXPR: ' + String(expr).slice(0, 400));
    }
    const v = r.result ? r.result.value : undefined;
    if (typeof v === 'string' && v.startsWith('__ERR__:')) throw new Error('表达式异常：' + v.slice(8));
    return v;
  }
  async function waitFor(name, fn, timeoutMs = 10000, every = 150) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      try { if (await fn()) return true; } catch (e) { last = e.message; }
      await sleep(every);
    }
    throw new Error(`等待「${name}」超时${last ? '：' + last : ''}`);
  }
  async function click(sel) {
    const r = await evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NO_EL'; el.click(); return 'OK';})()`);
    if (r === 'NO_EL') throw new Error('找不到元素：' + sel);
    await sleep(120);
    return r;
  }
  async function count(sel) { return await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`); }
  async function text(sel) { return await evalJs(`(document.querySelector(${JSON.stringify(sel)})||{innerText:''}).innerText`); }
  async function shot(name) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const w = Math.min(1440, Math.max(1200, Math.ceil(m.cssContentSize.width)));
    const h = Math.min(4200, Math.ceil(m.cssContentSize.height));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 1400, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
    });
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.data, 'base64'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(100);
    console.log(`      截图：.e2e/${name}（${w}×${h}）`);
  }

  /* ---------------- A. 启动与初始状态 ---------------- */
  await waitFor('应用首屏渲染', async () => (await count('.panel')) > 0, 15000);
  await waitFor('数据加载完成', async () => (await count('.ban-card')) > 0, 15000);

  check('无页面脚本异常（初始）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('顶栏显示已连接', /已连接/.test(await text('#connState')), await text('#connState'));

  /* ---------------- B. 反馈 #4：先 Ban，Pick 不显示 ---------------- */
  const banTitle = await text('.stage h2');
  check('BP 首屏进入 Ban 阶段（反馈#4）', /① Ban/.test(banTitle), banTitle);
  check('Ban 阶段不渲染 Pick 面板（反馈#4）', (await count('.cands')) === 0 && !/② Pick/.test(await text('#view')));
  check('Ban 槽位共 10 个（我方 5 + 敌方 5）', (await count('.slot')) === 10, `slots=${await count('.slot')}`);
  const banCardText = await text('.ban-card');
  check('Ban 指令卡 5 条且只给英雄', (await count('.ban-card')) === 5 && (await count('.ban-card .bc-hero')) === 5, banCardText.slice(0, 60));
  check('Ban 不再写「建议由谁 ban」（反馈#3）', !/建议由|去 ban/.test(await text('.stage')), '无指派执行人文案');
  const banTiers = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.ban-card .tier'),function(x){return x.textContent.trim();})`);
  check('Ban 优先 T0（反馈#1：强度 > 克制）', banTiers.length === 5 && banTiers.every(function (t) { return t === 'T0'; }),
    'tiers=' + JSON.stringify(banTiers));
  const slotTexts = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.ban-slots'),function(x){return x.innerText;})`);
  check('敌方 Ban 允许留空（空 ban 提示）', slotTexts.length === 2 && /空 ban|未知/.test(slotTexts[1]), snip(slotTexts[1], 60));
  await shot('01-ban-phase.png');

  /* ---------------- B2. v2.4 赛前预选（Ban 阶段）：选 AI 调研组合 → 核心 / 必 ban 提示 ---------------- */
  await waitFor('预选模板加载完成（.preset-card）', async () => (await count('.preset-card')) > 0, 10000);
  check('Ban 阶段出现预选面板（.preset-panel）', (await count('.preset-panel')) === 1, `panels=${await count('.preset-panel')}`);
  let presetCards = await count('.preset-card');
  if (!(await evalJs(`!!document.querySelector('[data-act="usePreset"][data-id="jiangwang-boshi"]')`))) {
    // 兜底：把「人数 / 优先级」筛选切回全部（默认是 all，防止后续改了默认筛选）
    if ((await count('[data-act="presetFilterPriority"]')) > 0) {
      await click('[data-act="presetFilterPriority"][data-priority="all"]');
      await sleep(200);
    }
    if ((await count('[data-act="presetFilterSize"]')) > 0) {
      await click('[data-act="presetFilterSize"][data-size="all"]');
      await sleep(200);
    }
    presetCards = await count('.preset-card');
  }
  check('预选模板卡存在（.preset-card，来自 /api/presets 的 AI 调研组合）', presetCards >= 6, `cards=${presetCards}`);
  await click('[data-act="usePreset"][data-id="jiangwang-boshi"]');
  await sleep(400);
  const presetCoreText = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.preset-core'),function(x){return x.innerText;}).join(' ')`);
  check('预选核心显示鲁班七号 / 盾山', /鲁班七号/.test(presetCoreText) && /盾山/.test(presetCoreText),
    presetCoreText.replace(/\s+/g, ' ').slice(0, 120));
  const presetBansText = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.preset-bans'),function(x){return x.innerText;}).join(' ')`);
  check('必 ban 列表含墨子 / 王昭君 / 钟馗（用户实战补充）',
    /墨子/.test(presetBansText) && /王昭君/.test(presetBansText) && /钟馗/.test(presetBansText),
    presetBansText.replace(/\s+/g, ' ').slice(0, 160));
  const presetProgressText = await text('.preset-progress');
  check('预选进度显示核心 / 必 ban 完成度', /核心/.test(presetProgressText) && /ban/i.test(presetProgressText),
    presetProgressText.replace(/\s+/g, ' ').slice(0, 100));
  await shot('08a-preset.png');

  /* ---------------- C. 采用全部 ban，敌方 ban 一次选 5 个，进入 Pick ---------------- */
  await click('[data-act="adoptAllBans"]');
  await sleep(300);
  const filledOurs = await evalJs(`Array.prototype.filter.call(document.querySelectorAll('.ban-slots'),function(g,i){return i===0;})[0].querySelectorAll('.slot.filled').length`);
  check('「全部采用」填满我方 5 个 ban', filledOurs === 5, `filled=${filledOurs}`);
  // v2.4：预选必 ban 排在 ban 指令最前 → 「全部采用」后我方 ban 至少含 3 个必 ban
  const ourBanText = await evalJs(`document.querySelectorAll('.ban-slots')[0].innerText`);
  const mustBanHits = ['墨子', '王昭君', '钟馗'].filter(function (h) { return ourBanText.indexOf(h) >= 0; });
  check('「全部采用」后我方 ban 至少含 3 个必 ban（墨子/王昭君/钟馗）', mustBanHits.length >= 3,
    '命中=' + JSON.stringify(mustBanHits));

  /* 反馈#2：敌方 ban 支持一次多选 5 个（避开接下来要选的敖隐） */
  await click('[data-act="openBanBulk"]');
  await waitFor('敌方 ban 批量弹窗', async () => (await count('.modal .hero-opt')) > 10, 8000);
  check('敌方 ban 批量弹窗只按分路筛（无职业筛选）', (await count('.modal [data-act="pickerLane"]')) === 6 && (await count('.modal [data-act="pickerType"]')) === 0);
  for (let i = 0; i < 5; i++) {
    await evalJs(`(function(){var bs=document.querySelectorAll('.modal .hero-opt');for(var i=0;i<bs.length;i++){var h=bs[i].getAttribute('data-hero');if(h!=='敖隐'&&!bs[i].classList.contains('sel')){bs[i].click();return h;}}return '';})()`);
    await sleep(90);
  }
  const selCount = await evalJs(`(document.getElementById('pickerSelCount')||{}).textContent`);
  check('敌方 ban 可连续点选满 5 个', selCount === '5', 'sel=' + selCount);
  await click('[data-act="pickerConfirm"]');
  await sleep(350);
  const filledTheirs = await evalJs(`Array.prototype.filter.call(document.querySelectorAll('.ban-slots'),function(g,i){return i===1;})[0].querySelectorAll('.slot.filled').length`);
  check('敌方 5 个 ban 一次录入成功', filledTheirs === 5, `filled=${filledTheirs}`);

  await click('[data-act="enterPick"]');
  await sleep(400);

  check('进入 Pick 后顶部有 Ban 缩略条（反馈#4）', (await count('.ban-strip')) === 1);
  check('缩略条展示双方 ban 头像（反馈#4/#5）', (await count('.ban-strip .strip-chip')) >= 10, `chips=${await count('.ban-strip .strip-chip')}`);
  check('Pick 面板展开（② Pick）', /② Pick/.test(await text('#view')));
  await shot('02-pick-phase.png');

  /* ---------------- C2. v2.4：Pick 候选带预选标记，然后清掉预选还原基线 ---------------- */
  check('Pick 阶段顶部有预选紧凑条（.preset-strip）', (await count('.preset-strip')) === 1, `strips=${await count('.preset-strip')}`);
  const presetTags = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.cand .preset-tag'),function(x){return x.textContent.trim();})`);
  check('候选卡出现预选徽标（.preset-tag）', presetTags.length > 0, 'tags=' + JSON.stringify(presetTags.slice(0, 6)));
  check('预选徽标为「预选核心 / 预选搭配 / 契合方案」之一',
    presetTags.every(function (t) { return /预选核心|预选搭配|契合方案/.test(t); }),
    JSON.stringify(presetTags.slice(0, 6)));
  const candBdText = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.cand .cand-bd'),function(x){return x.innerText;}).join(' ')`);
  check('候选拆解显示「预选」加分项（.cand-bd）', /预选/.test(candBdText),
    (candBdText.match(/预选\s*[-+]?\d+(\.\d+)?/) || [''])[0] || candBdText.slice(0, 80));

  // 还原「未预选」基线：后续断言仍按原有强度/克制口径（不回归）
  await click('[data-act="backBan"]');
  await sleep(300);
  await click('[data-act="clearPreset"]');
  await sleep(300);
  check('可换掉预选（clearPreset 回到模板列表）', (await count('.preset-card')) >= 6, `cards=${await count('.preset-card')}`);
  await click('[data-act="enterPick"]');
  await sleep(400);

  /* ---------------- D. 反馈 #1 + #5：Pick 候选带归属人 + 头像标签 ---------------- */
  check('我方候选卡存在', (await count('.cand')) > 0, `cand=${await count('.cand')}`);
  const assignLine = await text('.cand .cand-assign');
  check('候选写「谁打：某队友（熟练度）」（反馈：一人一英雄）', /谁打：/.test(assignLine) && /绝活|正常|仅会玩/.test(assignLine), assignLine);
  check('候选卡不再显示楼层归属', !/楼/.test(await text('.cand')));
  check('候选英雄旁有头像（反馈#5）', (await count('.cand .av img')) > 0, `img=${await count('.cand .av img')}`);
  check('候选卡只带分路标签、不显示职业（反馈#2）', (await count('.cand .tag-lane')) > 0 && (await count('.cand .tag-type')) === 0);
  const candText = await text('.cand');
  check('候选卡带熟练度徽章（反馈#3）', /绝活|正常|仅会玩/.test(candText), (candText.match(/绝活|正常|仅会玩/) || [''])[0]);
  check('候选卡有分路补位评分项', /补分路/.test(candText), 'breakdown 含补分路');
  const phaseText = await text('.step-pill');
  check('第 1 手阶段为「先抢」（优先 T0，反馈#2）', /先抢/.test(phaseText), phaseText);
  const candTiers = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.cand .tier'),function(x){return x.textContent.trim();})`);
  check('先抢阶段首候选为 T0（反馈#2）', candTiers[0] === 'T0', 'candTiers=' + JSON.stringify(candTiers));
  const ownerNames = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.cand .cand-assign b'),function(x){return x.textContent.trim();})`);
  check('候选「谁打」来自队内真实玩家', ownerNames.length > 0 && ownerNames.every(function (n) { return /^[\u4e00-\u9fa5A-Za-z0-9()（）]{1,12}$/.test(n); }), 'assignees=' + JSON.stringify(ownerNames));
  check('候选卡带「换人」入口（v2.3）', (await count('.cand .cand-swap')) > 0);

  /* 先选一个纯射手（敖隐，T0/发育路），用于验证「选了射手不再推射手」 */
  const hasAoyin = await evalJs(`!!document.querySelector('[data-act="pickHero"][data-hero="敖隐"]')`);
  check('首手候选里有纯射手（用于回归验证）', hasAoyin, '敖隐在候选中');
  await click('[data-act="pickHero"][data-hero="敖隐"]');
  await sleep(400);
  const firstHero = '敖隐';
  const pickCard = await text('.picked-list .pick-card');
  check('选人后已选列表写「我方第 N 手 → 谁打」', /我方第1手/.test(pickCard) && /→/.test(pickCard), `${firstHero} → ${pickCard}`);

  /* v2.3：手动指定这个英雄由谁玩 */
  const curOwner = ((pickCard.match(/→\s*([^（(]+)/) || [])[1] || '').trim();
  await click('.picked-col.blue .pick-card[data-act="assignHero"]');
  await waitFor('指定谁玩弹窗', async () => (await count('.assign-opt')) === 5, 6000);
  await shot('03a-assign-picker.png');
  const chosen = await evalJs(`(function(){
    var cur=${JSON.stringify(curOwner)};
    var opts=document.querySelectorAll('.assign-opt:not([disabled])');
    for(var i=0;i<opts.length;i++){var n=opts[i].querySelector('.ao-name').textContent.trim(); if(n!==cur){opts[i].click(); return n;}}
    return '';
  })()`);
  await sleep(400);
  const newPick = await text('.picked-col.blue .pick-card');
  check('可手动指定英雄由谁玩（v2.3）', !!chosen, '换给 ' + chosen);
  check('手动指定后已选卡片更新「谁打」', !!chosen && newPick.indexOf(chosen) >= 0, newPick);

  /* 敌方回合录入 → 敌我双方都记录（红方连续两手：红1、红2楼） */
  await waitFor('轮到敌方录入', async () => (await count('.enemy-grid')) === 1, 8000);
  check('敌方回合出现头像英雄网格（反馈#5）', (await count('.enemy-grid .eh')) > 0 && (await count('.enemy-grid .av img')) > 0, `eh=${await count('.enemy-grid .eh')}`);
  const enemyHero = await evalJs(`document.querySelector('.enemy-grid .eh').getAttribute('data-hero')`);
  await click('.enemy-grid .eh');
  await sleep(400);
  check('敌方选人可鼠标点选录入', new RegExp(enemyHero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(await text('.picked-col.red')), `已录入 ${enemyHero}`);

  /* 红方还会再选一手（红 2 楼），继续点到轮到我方 2 楼（刘） */
  for (let i = 0; i < 3; i++) {
    if ((await count('.cand')) > 0) break;
    if ((await count('.enemy-grid .eh')) > 0) { await click('.enemy-grid .eh'); await sleep(350); }
    else break;
  }
  await waitFor('轮到我方 2 手', async () => (await count('.cand')) > 0, 8000);
  const phase2 = await text('.step-pill');
  check('我方第 2 手仍为「先抢」（反馈#2）', /我方第 2 手/.test(phase2) && /先抢/.test(phase2), phase2);
  check('第 2 手候选带「谁打」分配', (await count('.cand .cand-assign')) > 0);
  const pickedOwners = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.picked-col.blue .pick-card em'),function(x){return ((x.textContent.match(/→\\s*([^（]+)/)||[])[1]||'').trim();})`);
  const validOwners = pickedOwners.filter(Boolean);
  check('已选英雄由不同队友分别去打（一人一英雄）', validOwners.length >= 1 && new Set(validOwners).size === validOwners.length,
    'assign=' + JSON.stringify(pickedOwners));
  check('候选头部显示剩余待上场队友', /待上场：/.test(await text('.cand-owner')), (await text('.cand-owner')).slice(0, 70));

  /* 反馈#1 回归：选了射手之后，不能再推纯射手，候选必须能补待补分路 */
  const headText = await text('.cand-owner');
  check('已选射手后待补分路不含发育路（反馈#1）', /待补：/.test(headText) && !/发育路/.test(headText), headText);
  const pureAdc = await evalJs(`(function(){
    var m={}; (window.HEROES||[]).forEach(function(h){m[h.name]=h;});
    var bad=[];
    Array.prototype.forEach.call(document.querySelectorAll('.cand'),function(c){
      var n=c.getAttribute('data-hero'); var h=m[n]; if(!h) return;
      var ls=(h.roles||[]).concat(h.alt||[]);
      if(ls.length && ls.every(function(l){return l==='adc';})) bad.push(n);
    });
    return bad;
  })()`);
  check('选出射手后不再推荐纯射手英雄（反馈#1）', pureAdc.length === 0, 'pureADC=' + JSON.stringify(pureAdc));
  const laneOverlap = await evalJs(`(function(){
    var open=[];
    var t=(document.querySelector('.cand-owner')||{innerText:''}).innerText||'';
    var m=t.match(/待补：([^·]+)/); if(m){ open=m[1].split('/').map(function(s){return s.trim();}).filter(Boolean); }
    var bad=[];
    Array.prototype.forEach.call(document.querySelectorAll('.cand'),function(c){
      var lanes=Array.prototype.map.call(c.querySelectorAll('.tag-lane'),function(x){return x.textContent.trim();});
      if(open.length && lanes.length && !lanes.some(function(l){return open.indexOf(l)>=0;})) bad.push(c.getAttribute('data-hero')+':'+lanes.join('+'));
    });
    return { open:open, bad:bad };
  })()`);
  check('每个候选都能补至少一条待补分路（反馈#1）', laneOverlap.bad.length === 0,
    '待补=' + JSON.stringify(laneOverlap.open) + (laneOverlap.bad.length ? ' 违规=' + JSON.stringify(laneOverlap.bad) : ''));
  await shot('03-pick-progress.png');

  /* ---------------- E. 反馈 #3：熟练度（设置页 + 池编辑器） ---------------- */
  await click('[data-act="tab"][data-tab="settings"]');
  await sleep(500);
  check('设置页 5 个玩家卡', (await count('.player-card')) === 5, `cards=${await count('.player-card')}`);
  check('设置页没有强制分路下拉（反馈#1）', (await count('.lane-select')) === 0 && (await count('.pc-lane')) === 0);
  check('设置页不再显示楼层（反馈：不需要考虑楼层）', (await count('.pc-floor')) === 0 && (await count('.pc-floor-tag')) === 0,
    `floorUI=${await count('.pc-floor') + await count('.pc-floor-tag')}`);
  check('每人有倾向分路开关（反馈#1）', (await count('.lt')) === 25, `lane toggles=${await count('.lt')}`);
  check('设置页展示熟练度图例（反馈#3）', /绝活/.test(await text('.mastery-legend')) && /仅会玩/.test(await text('.mastery-legend')));
  await shot('04-settings.png');

  await click('.pool-btn');
  await waitFor('英雄池弹窗', async () => (await count('.modal .pcard')) > 10, 8000);
  check('英雄池弹窗列出全部英雄 + 头像（反馈#5）', (await count('.modal .pcard')) >= 100 && (await count('.modal .pcard .av img')) >= 100,
    `cards=${await count('.modal .pcard')} imgs=${await count('.modal .pcard .av img')}`);
  check('英雄池弹窗只按分路筛、无职业筛选（反馈#2）', (await count('.modal [data-act="poolLane"]')) === 6 && (await count('.modal [data-act="poolType"]')) === 0);
  /* 选一个未入池英雄并设为绝活 */
  const notSel = await evalJs(`(function(){var a=document.querySelectorAll('.modal .pcard');for(var i=0;i<a.length;i++){if(!a[i].classList.contains('sel'))return a[i].querySelector('.pcard-top').getAttribute('data-hero');}return '';})()`);
  await evalJs(`(function(){var a=document.querySelectorAll('.modal .pcard');for(var i=0;i<a.length;i++){if(!a[i].classList.contains('sel')){a[i].querySelector('.pcard-top').click();return 'OK';}}return 'NO';})()`);
  await sleep(250);
  await evalJs(`(function(){var cards=document.querySelectorAll('.modal .pcard.sel');var c=cards[cards.length-1];var b=c.querySelector('.mbtn.mb-best');if(b){b.click();return 'OK';}return 'NO';})()`);
  await sleep(250);
  const activeMastery = await evalJs(`(function(){var a=document.querySelectorAll('.modal .pcard.sel .mbtn.active');return Array.prototype.map.call(a,function(x){return x.textContent;}).join(',');})()`);
  check('可给池内英雄设置「绝活」熟练度（反馈#3）', /绝活/.test(activeMastery), `${notSel} → active=${activeMastery}`);

  /* 修复回归：正常 / 仅会玩 也要有颜色高亮（不能只有绝活亮） */
  async function clickMasteryOnLastSel(cls) {
    return await evalJs(`(function(){var cs=document.querySelectorAll('.modal .pcard.sel');var c=cs[cs.length-1];var b=c&&c.querySelector('.mbtn.${cls}');if(b){b.click();return 'OK';}return 'NO';})()`);
  }
  await clickMasteryOnLastSel('mb-normal');
  await sleep(250);
  const normInfo = await evalJs(`(function(){var cs=document.querySelectorAll('.modal .pcard.sel');var c=cs[cs.length-1];var a=c.querySelector('.mbtn.active');var off=c.querySelector('.mbtn.mb-basic');return {cls:a?a.className:'',bg:a?getComputedStyle(a).backgroundColor:'',offBg:off?getComputedStyle(off).backgroundColor:''};})()`);
  check('「正常」档有颜色高亮（bug 修复）', /mb-normal/.test(normInfo.cls) && normInfo.bg !== normInfo.offBg && normInfo.bg !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(normInfo));
  await clickMasteryOnLastSel('mb-basic');
  await sleep(250);
  const basicInfo = await evalJs(`(function(){var cs=document.querySelectorAll('.modal .pcard.sel');var c=cs[cs.length-1];var a=c.querySelector('.mbtn.active');var off=c.querySelector('.mbtn.mb-normal');return {cls:a?a.className:'',bg:a?getComputedStyle(a).backgroundColor:'',offBg:off?getComputedStyle(off).backgroundColor:''};})()`);
  check('「仅会玩」档有颜色高亮（bug 修复）', /mb-basic/.test(basicInfo.cls) && basicInfo.bg !== basicInfo.offBg && basicInfo.bg !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(basicInfo));
  await shot('05-pool-editor.png');
  await click('[data-act="poolDone"]');
  await sleep(300);

  /* ---------------- F. 反馈 #2：补池建议不重复 ---------------- */
  await click('[data-act="runAdvice"]');
  await waitFor('补池建议生成', async () => (await count('.advice-item')) > 0 || /覆盖良好/.test(await text('.panel:last-of-type')), 15000);
  const adviceHeroes = await evalJs(`Array.prototype.map.call(document.querySelectorAll('.advice-item .ai-hero b'),function(x){return x.textContent.trim();})`);
  const dupAdvice = adviceHeroes.filter((h, i) => adviceHeroes.indexOf(h) !== i);
  check('补池建议无重复英雄（反馈#2）', adviceHeroes.length === 0 || dupAdvice.length === 0,
    dupAdvice.length ? `重复：${dupAdvice.join('、')}` : `${adviceHeroes.length} 条：${adviceHeroes.slice(0, 6).join('、')}`);
  const targets = await count('.advice-targets .btn');
  check('补池建议给出「加到 谁」按钮', adviceHeroes.length === 0 || targets > 0, `buttons=${targets}`);
  check('补池建议仍带头像（反馈#5）', adviceHeroes.length === 0 || (await count('.advice-item .av img')) > 0);
  await shot('06-advice.png');

  /* ---------------- G. 导出文本（归属人 + 熟练度） ---------------- */
  await click('[data-act="tab"][data-tab="export"]');
  await sleep(500);
  const exportText = await evalJs(`(document.getElementById('exportText')||{value:''}).value`);
  check('导出文本含「我方第 N 手 + 谁打」（反馈：一人一英雄）', /我方第1手/.test(exportText) && /由 .+ 打/.test(exportText), '含选人记录与谁打');
  check('导出文本不再用楼层定位选人', !/(?:[蓝红]?[1-5]楼|第[1-5]楼)/.test(exportText), (exportText.match(/[^\n]*\d楼[^\n]*/) || ['无楼层定位'])[0].slice(0, 60));
  check('导出文本含三档熟练度（反馈#3）', /绝活|仅会玩/.test(exportText), (exportText.match(/绝活：[^\n]*/) || [''])[0].slice(0, 60));
  check('导出文本含五路覆盖', /五路覆盖/.test(exportText));
  await shot('07-export.png');

  /* ---------------- H. 空 ban 场景：返回 Ban，清空敌方，仍能进 Pick ---------------- */
  await click('[data-act="tab"][data-tab="bp"]');
  await sleep(400);
  await click('[data-act="backBan"]');
  await sleep(300);
  check('可从 Pick 返回 Ban 阶段补录（反馈#4）', /① Ban/.test(await text('.stage h2')));
  await click('[data-act="clearBans"][data-side="theirs"]');
  await sleep(200);
  await click('[data-act="enterPick"]');
  await sleep(400);
  check('敌方全部空 ban 仍可进入 Pick（反馈#4）', /空 ban|未知/.test(await text('.ban-strip')), (await text('.ban-strip')).replace(/\s+/g, ' ').slice(0, 80));

  /* ---------------- I. v2.4：预选 + 打满 10 手 → 队伍总体评价 ---------------- */
  await click('[data-act="backBan"]');
  await sleep(300);
  await click('[data-act="usePreset"][data-id="jiangwang-boshi"]');
  await sleep(300);
  await click('[data-act="enterPick"]');
  await sleep(400);
  let guard = 0;
  while (guard < 30 && (await count('.review-panel')) === 0) {
    guard += 1;
    if ((await count('.cands .cand[data-act="pickHero"]')) > 0) {
      await evalJs(`(function(){var b=document.querySelector('.cands .cand[data-act="pickHero"]'); if(b){b.click(); return 'OK';} return 'NO';})()`);
      await sleep(220);
      continue;
    }
    if ((await count('.enemy-grid .eh')) > 0) {
      await evalJs(`(function(){var b=document.querySelector('.enemy-grid .eh'); if(b){b.click(); return 'OK';} return 'NO';})()`);
      await sleep(220);
      continue;
    }
    if ((await count('[data-act="skipEnemy"]')) > 0) {
      await click('[data-act="skipEnemy"]');
      await sleep(220);
      continue;
    }
    if ((await count('[data-act="openPickOurs"]')) > 0) {
      // 我方回合没有候选（池子被 ban 空）→ 用「池外指定」兜底，保证能打满 10 手
      try {
        await click('[data-act="openPickOurs"]');
        await waitFor('池外指定弹窗', async () => (await count('.modal .hero-opt')) > 0, 4000);
        await evalJs(`(function(){var b=document.querySelector('.modal .hero-opt'); if(b){b.click(); return 'OK';} return 'NO';})()`);
      } catch { /* 兜底失败不致命：继续循环，最后由 waitFor 报错 */ }
      await sleep(220);
      continue;
    }
    await sleep(200);
  }
  await waitFor('队伍总体评价面板出现', async () => (await count('.review-panel')) === 1, 12000);
  check('打满 10 手后出现队伍总体评价（.review-panel）', (await count('.review-panel')) === 1, `loops=${guard}`);
  check('评价面板含双方评价卡（.review-side ×2）', (await count('.review-side')) === 2, `sides=${await count('.review-side')}`);
  check('评价卡含命中体系（.review-combos ×2）', (await count('.review-side .review-combos')) === 2,
    `combos=${await count('.review-side .review-combos')}`);
  check('评价面板含对位结论（.review-verdict）', (await count('.review-verdict')) === 1);
  check('评价面板含对位边（.review-matchup）', (await count('.review-matchup')) === 1);
  check('双方评价卡都有评分与结构维度', (await count('.review-side .rs-score')) === 2 && (await count('.review-side .review-dims')) === 2,
    `score=${await count('.review-side .rs-score')} dims=${await count('.review-side .review-dims')}`);
  const presetMatchText = await text('.preset-match');
  check('评价面板含预选完成度（.preset-match）', (await count('.preset-match')) === 1 && /核心|ban/i.test(presetMatchText),
    presetMatchText.replace(/\s+/g, ' ').slice(0, 140));
  await shot('08-review.png');

  /* ---------------- 收尾 ---------------- */
  check('全程无页面脚本异常', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
}

/* ---------------- 清理 + 汇总 ---------------- */
async function cleanup() {
  try { if (cdp) cdp.close(); } catch { /* ignore */ }
  try { if (browserCdp) browserCdp.close(); } catch { /* ignore */ }
  if (chromeProc && chromeProc.pid) {
    try { chromeProc.kill('SIGKILL'); } catch { /* ignore */ }
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
  }
  if (serverProc && serverProc.pid) {
    try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
  }
  if (!KEEP && serverLogPath) { try { fs.unlinkSync(serverLogPath); } catch { /* ignore */ } }
  /* 还原 E2E 改过的存档（先等服务退出，避免还原后被服务端再次覆盖） */
  if (seededStore) {
    await sleep(300);
    // 存档是本次从 store.sample.json 播种的 → 删掉，保持 clone 后的干净状态
    try {
      fs.rmSync(path.join(ROOT, 'data', 'store.json'), { force: true });
      console.log('已删除本次播种的 data/store.json');
    } catch { /* ignore */ }
  } else if (storeBackup !== null) {
    await sleep(300);
    try {
      fs.writeFileSync(path.join(ROOT, 'data', 'store.json'), storeBackup, 'utf8');
      console.log('已还原 data/store.json');
    } catch (e) {
      console.log('还原 data/store.json 失败：' + e.message);
    }
  } else {
    // 原本没有存档也没有样本：删掉 E2E 过程中生成的 store.json
    try {
      fs.rmSync(path.join(ROOT, 'data', 'store.json'), { force: true });
      console.log('已清理 E2E 生成的 data/store.json');
    } catch { /* ignore */ }
  }
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
  check('E2E 流程执行', false, e && e.message ? e.message : String(e));
  if (serverLog) console.log('服务输出片段：' + snip(serverLog, 400));
} finally {
  await cleanup();
}

console.log('\n=== E2E 汇总 ===');
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`共 ${results.length} 项：PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log('失败项：');
  results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`));
}
console.log(`截图目录：${OUT_DIR}`);
if (fatal) console.log(`致命错误：${fatal.message}`);
setTimeout(() => process.exit(fail || fatal ? 1 : 0), 300).unref();
process.exitCode = fail || fatal ? 1 : 0;
