#!/usr/bin/env node
/**
 * hok-bp/tools/smoke.mjs —— 集成冒烟（零依赖，node 直接跑）
 *
 *   运行：node hok-bp/tools/smoke.mjs
 *   断言依据：docs/engine-contract.md §4（HTTP API）、§6.3（验收）
 *
 * 检查项：
 *  1. 语法：node --check web/engine.js、web/app.js、web/ai.js、server.mjs
 *  2. 数据：data/meta.json、relations.json、store.json、combos.json、combo-bans.json 可解析（缺失 → SKIP，不算失败）
 *  3. 服务：spawn `node server.mjs --port 0`（系统分配空闲端口，避免与真实服务/并发冒烟撞 3799），
 *     从子进程 stdout 解析实际端口 → /api/health、/api/meta、/api/relations、/api/store、
 *     /api/presets（combos + 用户必 ban 适配，≥20 套且含 jiangwang-boshi）、/api/combos、
 *     GET /（200 且含 <title>）→ 结束一定 kill 子进程（先 child.kill，再 taskkill /PID /F 兜底）
 *  4. 引擎：require web/engine.js 后跑 banRecommend / pickRecommend / lineupCheck / analyzePool，
 *     以及 v2.4 的 presetsFromCombos / presetPlan / teamReview，确认返回非空
 *
 * 汇总 PASS/FAIL/SKIP；有 FAIL 时 exit 1。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // hok-bp/
let BASE = ''; // 服务实际端口确定后填入（--port 0 由系统分配）

// 真实存档是运行期数据（不进仓库）：缺失时回退 data/store.sample.json
function readStoreRaw() {
  for (const f of ['store.json', 'store.sample.json']) {
    const p = path.join(ROOT, 'data', f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('data/store.json 与 data/store.sample.json 都不存在');
}

const results = [];

function record(level, name, detail = '') {
  results.push({ level, name, detail });
  console.log(`${level.padEnd(4)}  ${name}${detail ? `\n      ↳ ${detail}` : ''}`);
}
const pass = (n, d) => record('PASS', n, d);
const fail = (n, d) => record('FAIL', n, d);
const skip = (n, d) => record('SKIP', n, d);

const snip = (v, n = 320) => {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) s = String(v);
  return s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字符）` : s;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────── 1. 语法检查 ─────────────────────── */

console.log('== 1. 语法检查（node --check）==\n');

const SYNTAX_TARGETS = ['web/engine.js', 'web/app.js', 'web/ai.js', 'server.mjs'];

for (const rel of SYNTAX_TARGETS) {
  const abs = path.join(ROOT, rel);
  const name = `node --check ${rel}`;
  if (!fs.existsSync(abs)) {
    fail(name, `文件不存在：${abs}`);
    continue;
  }
  // 注意：受限沙箱下不能用管道 stdio 抓子进程输出（会 EPERM），这里用 inherit，
  // 语法错误会由 node 自己打印到当前终端，退出码照样可取。
  let r = null;
  try {
    r = spawnSync(process.execPath, ['--check', abs], { stdio: 'inherit', windowsHide: true });
  } catch (err) {
    fail(name, `无法启动子进程 ${process.execPath}：${err.message}`);
    continue;
  }
  if (r.error) {
    fail(name, `子进程失败：${r.error.message}`);
  } else if (r.status === 0) {
    pass(name);
  } else {
    fail(name, `exit=${r.status}（语法错误已在上面由 node 打印）`);
  }
}

/* ─────────────────────── 2. 数据文件可解析 ─────────────────────── */

console.log('\n== 2. 数据文件（缺失 SKIP）==\n');

const DATA_FILES = ['data/meta.json', 'data/relations.json', 'data/store.json', 'data/combos.json', 'data/combo-bans.json'];
const dataState = {};

for (const rel of DATA_FILES) {
  const abs = path.join(ROOT, rel);
  const name = `JSON 可解析 ${rel}`;
  if (!fs.existsSync(abs)) {
    skip(name, '文件尚不存在（data-kit 可能还在生成）');
    dataState[rel] = null;
    continue;
  }
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const json = JSON.parse(raw);
    dataState[rel] = json;
    const keys = json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json) : [];
    pass(name, `${raw.length} 字节，顶层键 = ${snip(keys)}`);
  } catch (err) {
    fail(name, `JSON.parse 失败：${err.message}`);
  }
}

// 数据形状的最小提示（只报，不判失败 —— 深校验属 validate-data.mjs 的职责）
if (dataState['data/meta.json']) {
  const meta = dataState['data/meta.json'];
  const nTiers = meta.tiers ? Object.keys(meta.tiers).length : 0;
  const nTags = meta.tags ? Object.keys(meta.tags).length : 0;
  (nTiers > 0 ? pass : fail)(`meta.json 顶层形状`, `tiers=${nTiers} tags=${nTags} version=${snip(meta.version)}`);
}
if (dataState['data/relations.json']) {
  const rel = dataState['data/relations.json'];
  const nc = Array.isArray(rel.counters) ? rel.counters.length : 0;
  const ns = Array.isArray(rel.synergies) ? rel.synergies.length : 0;
  (nc + ns > 0 ? pass : fail)(`relations.json 顶层形状`, `counters=${nc} synergies=${ns}`);
}
if (dataState['data/store.json']) {
  const st = dataState['data/store.json'];
  const npl = Array.isArray(st.players) ? st.players.length : 0;
  (npl === 5 ? pass : fail)(`store.json 顶层形状`, `players=${npl}（契约 v2 要求固定 5 条）side=${snip(st.side)} version=${snip(st.version)}`);
  // v2 关键字段：不允许再有 lane 绑定；pool 必须是 {hero,mastery}
  const badLane = (st.players || []).filter((p) => p && p.lane !== undefined).length;
  (badLane === 0 ? pass : fail)('store.json 已取消分路绑定（v2）', badLane ? `仍有 ${badLane} 个玩家带 lane 字段` : 'players 无 lane 字段，使用 preferLanes');
  const preferOk = (st.players || []).every((p) => Array.isArray(p.preferLanes));
  (preferOk ? pass : fail)('store.json preferLanes 合法', preferOk ? '每个玩家都有 preferLanes 数组' : '有玩家缺少 preferLanes 数组');
  const poolItems = (st.players || []).flatMap((p) => (Array.isArray(p.pool) ? p.pool : []));
  const badPool = poolItems.filter((it) => !it || typeof it !== 'object' || !it.hero || !['best', 'normal', 'basic'].includes(it.mastery));
  (badPool.length === 0 ? pass : fail)('store.json 英雄池条目带三档熟练度', badPool.length ? `${badPool.length} 条非法：${snip(badPool.slice(0, 3))}` : `共 ${poolItems.length} 条 {hero,mastery}`);
}
if (dataState['data/combos.json']) {
  const cd = dataState['data/combos.json'];
  const comps = Array.isArray(cd.comps) ? cd.comps : [];
  const hasJiangwang = comps.some((c) => c && c.id === 'jiangwang-boshi');
  (comps.length > 0 && hasJiangwang ? pass : fail)('combos.json 顶层形状',
    `comps=${comps.length} jiangwang-boshi=${hasJiangwang} source=${snip(cd.source)}`);
}
if (dataState['data/combo-bans.json']) {
  const bd = dataState['data/combo-bans.json'];
  const ov = bd && bd.overrides && typeof bd.overrides === 'object' ? Object.keys(bd.overrides) : [];
  const jw = bd && bd.overrides && bd.overrides['jiangwang-boshi'];
  const musts = jw && Array.isArray(jw.mustBans) ? jw.mustBans.map((x) => x && x.hero).filter(Boolean) : [];
  (musts.length >= 3 ? pass : fail)('combo-bans.json 顶层形状',
    `overrides=${snip(ov)} jiangwang mustBans=${snip(musts)}`);
}

/* ─────────────────────── 3. HTTP 服务冒烟 ─────────────────────── */

console.log('\n== 3. 服务冒烟（node server.mjs --port 0，端口由系统分配）==\n');

await runServerChecks();

async function fetchJson(pathname, timeoutMs = 5000) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 null，由调用方判断 */
  }
  return { res, text, json };
}

/**
 * 杀掉子进程（服务是长驻进程，不杀会占住端口并让本进程句柄挂住）。
 * Windows 上优先 child.kill（TerminateProcess，对自己拉起的子进程最可靠），
 * 再补一发 taskkill /PID /T /F 清理可能的孙进程；最后等 exit 落地。
 */
async function killTree(child) {
  if (!child || !child.pid) return false;
  const pid = child.pid;
  const exitedAlready = () => child.exitCode !== null || child.signalCode !== null;
  if (exitedAlready()) return true;

  const waitExit = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* taskkill 不可用，child.kill 已尽力 */
    }
  }

  let ok = await waitExit;
  if (!ok) {
    // 兜底：解除句柄牵连，避免本进程被残留子进程挂住（不改变退出码）
    try {
      child.unref();
      if (typeof child.stdout?.destroy === 'function') child.stdout.destroy();
      if (typeof child.stderr?.destroy === 'function') child.stderr.destroy();
    } catch {
      /* ignore */
    }
  }
  return ok;
}

async function runServerChecks() {
  const serverPath = path.join(ROOT, 'server.mjs');
  if (!fs.existsSync(serverPath)) {
    fail('server.mjs 存在', `文件不存在：${serverPath}`);
    return;
  }

  // 受限沙箱下子进程不能用管道 stdio（会 EPERM），改成把 stdout/stderr 写到临时文件，
  // 失败时再读回来做诊断；临时文件在系统 temp 目录，不污染仓库。
  let logFd = null;
  let logPath = '';
  try {
    logPath = path.join(os.tmpdir(), `hok-bp-smoke-server-${process.pid}.log`);
    logFd = fs.openSync(logPath, 'w');
  } catch {
    logFd = null;
  }
  const readLog = () => {
    if (!logPath) return '';
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  const closeLog = () => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* 已关闭 */
      }
      logFd = null;
    }
    if (logPath) {
      try {
        fs.unlinkSync(logPath);
      } catch {
        /* 已删除 */
      }
    }
  };

  let child = null;
  const FIXED_PORT = 3799;
  const useDynamicPort = logFd !== null; // 没有临时日志就解析不了实际端口 → 退回固定端口
  try {
    // --port 0：系统分配空闲端口，避免与开发中的真实服务或并发冒烟撞端口（EADDRINUSE）
    child = spawn(process.execPath, [serverPath, '--port', useDynamicPort ? '0' : String(FIXED_PORT)], {
      cwd: ROOT,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } catch (err) {
    closeLog();
    fail('server 子进程可启动', `spawn 失败：${err.message}`);
    return;
  }
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });

  try {
    let port = null;
    if (!useDynamicPort) {
      port = FIXED_PORT;
      BASE = `http://127.0.0.1:${port}`;
      pass('server 启动端口', `${BASE}（临时日志不可用，退回固定端口，无法解析 stdout）`);
    } else {
      // 从子进程 stdout（这里是落盘的临时日志）解析真实端口：server.mjs 启动后会打印
      //   HOK BP v1 → http://127.0.0.1:<实际端口>
      let startupLog = '';
      for (let i = 0; i < 40 && !exited; i++) {
        startupLog = readLog();
        const m = startupLog.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
        if (m) {
          port = Number(m[1]);
          break;
        }
        await sleep(150);
      }
      if (!port) {
        fail(
          'server 启动并打印实际端口',
          `未能从子进程输出解析到 http://127.0.0.1:<port>；输出 = ${snip(startupLog || '(空)', 400)}`
        );
        return;
      }
      BASE = `http://127.0.0.1:${port}`;
      pass('server 启动并打印实际端口', `${BASE}（--port 0 由系统分配，无端口冲突风险）`);
    }

    // 端口已知后再对 /api/health 做最多约 3s 的轮询，避免慢启动误判
    let health = null;
    let healthErr = '';
    for (let i = 0; i < 10; i++) {
      if (exited) break;
      try {
        health = await fetchJson('/api/health', 3000);
        break;
      } catch (err) {
        healthErr = err.message;
        await sleep(300);
      }
    }

    if (!health) {
      const log = readLog();
      fail(
        'server 可访问 /api/health',
        `未能连上 ${BASE}/api/health；最后错误 = ${snip(healthErr)}；子进程输出 = ${snip(log || '(空)', 400)}`
      );
      return;
    }

    // /api/health
    if (health.res.status === 200 && health.json && health.json.ok !== false) {
      for (const key of ['date', 'heroCount', 'iconCount', 'tierCount', 'relCount', 'root', 'version']) {
        if (health.json[key] === undefined) {
          fail(`/api/health 字段 ${key}`, `响应缺少 ${key}：${snip(health.json)}`);
        }
      }
      pass('/api/health 200 且 ok', snip(health.json, 400));
    } else {
      fail('/api/health 200 且 ok', `status=${health.res.status} body=${snip(health.text)}`);
    }

    // /api/meta
    const meta = await fetchJson('/api/meta');
    if (meta.res.status === 200 && meta.json && typeof meta.json === 'object') {
      const nTiers = meta.json.tiers ? Object.keys(meta.json.tiers).length : 0;
      (nTiers > 0 ? pass : fail)('/api/meta 200 且含 tiers', `tiers=${nTiers} version=${snip(meta.json.version)}`);
    } else {
      fail('/api/meta 200 且含 tiers', `status=${meta.res.status} body=${snip(meta.text)}`);
    }

    // /api/relations（契约 §4 也有该端点，一并冒烟）
    const rel = await fetchJson('/api/relations');
    if (rel.res.status === 200 && rel.json && typeof rel.json === 'object') {
      const nc = Array.isArray(rel.json.counters) ? rel.json.counters.length : -1;
      const ns = Array.isArray(rel.json.synergies) ? rel.json.synergies.length : -1;
      (nc >= 0 && ns >= 0 ? pass : fail)('/api/relations 200 且含 counters/synergies', `counters=${nc} synergies=${ns}`);
    } else {
      fail('/api/relations 200 且含 counters/synergies', `status=${rel.res.status} body=${snip(rel.text)}`);
    }

    // /api/store
    const store = await fetchJson('/api/store');
    if (store.res.status === 200 && store.json && Array.isArray(store.json.players)) {
      pass('/api/store 200 且含 players 数组', `players=${store.json.players.length} side=${snip(store.json.side)} version=${snip(store.json.version)}`);
    } else {
      fail(
        '/api/store 200 且含 players 数组',
        `status=${store.res.status} body=${snip(store.text)}`
      );
    }

    // /api/combos（v2.4 原始组合数据，可选端点）
    const combos = await fetchJson('/api/combos');
    if (combos.res.status === 200 && combos.json && Array.isArray(combos.json.comps)) {
      pass('/api/combos 200 且含 comps 数组', `comps=${combos.json.comps.length} date=${snip(combos.json.date)}`);
    } else {
      fail('/api/combos 200 且含 comps 数组', `status=${combos.res.status} body=${snip(combos.text)}`);
    }

    // /api/presets（v2.4：combos.json + combo-bans.json 由引擎 presetsFromCombos 适配）
    const presetsRes = await fetchJson('/api/presets');
    if (presetsRes.res.status === 200 && presetsRes.json && Array.isArray(presetsRes.json.presets)) {
      const list = presetsRes.json.presets;
      const jw = list.find((p) => p && p.id === 'jiangwang-boshi');
      const must = jw && Array.isArray(jw.threats)
        ? jw.threats.filter((t) => t && t.level === 'must').map((t) => t.hero) : [];
      const okList = list.length >= 20 && !!jw && ['墨子', '王昭君', '钟馗'].every((h) => must.includes(h));
      (okList ? pass : fail)('/api/presets 200 且 ≥20 套、含 jiangwang-boshi（must 含墨子/王昭君/钟馗）',
        okList
          ? `presets=${list.length}；僵王博士 must=${snip(must)}；前 5 个 id=${snip(list.slice(0, 5).map((p) => p.id))}`
          : `presets=${list.length} jiangwang=${!!jw} must=${snip(must)} body=${snip(presetsRes.text)}`);
    } else {
      fail('/api/presets 200 且 ≥20 套、含 jiangwang-boshi（must 含墨子/王昭君/钟馗）',
        `status=${presetsRes.res.status} body=${snip(presetsRes.text)}`);
    }

    // v1 存档迁移 + v2 PUT 校验（跑完必须还原真实存档）
    const storeFile = path.join(ROOT, 'data', 'store.json');
    let originalStore = null;
    const hadStore = fs.existsSync(storeFile);
    try {
      if (hadStore) originalStore = fs.readFileSync(storeFile, 'utf8');
      const v1 = {
        side: 'red',
        players: [
          { lane: 'top', name: '老档1', floor: 1, pool: ['廉颇', '妲己'] },
          { lane: 'jungle', name: '老档2', floor: 2, pool: ['露娜'] },
          { lane: 'mid', name: '老档3', floor: 3, pool: ['张良'] },
          { lane: 'adc', name: '老档4', floor: 4, pool: ['后羿'] },
          { lane: 'support', name: '老档5', floor: 5, pool: ['张飞'] },
        ],
        allowCrossLane: false,
        weights: {},
        history: [],
      };
      fs.writeFileSync(storeFile, JSON.stringify(v1, null, 2), 'utf8');
      const mig = await fetchJson('/api/store');
      const mp = (mig.json && mig.json.players) || [];
      const first = mp.find((p) => p.floor === 1) || {};
      const migOk = mig.json && mig.json.version === 2 && mp.length === 5 &&
        mp.every((p) => Array.isArray(p.preferLanes) && p.lane === undefined &&
          Array.isArray(p.pool) && p.pool.every((e) => e && e.hero && ['best', 'normal', 'basic'].includes(e.mastery))) &&
        Array.isArray(first.preferLanes) && first.preferLanes.includes('top') && first.pool.length === 2;
      (migOk ? pass : fail)('GET /api/store 自动迁移 v1 存档', migOk ? 'version=2 / preferLanes / pool{hero,mastery}' : snip(mig.json));

      // PUT：合法 v2 → 200；楼层重复 → 400
      const v2 = JSON.parse(JSON.stringify(mig.json));
      v2.players[0].pool[0].mastery = 'basic';
      v2.players[0].preferLanes = ['top', 'jungle'];
      const putRes = await fetch(BASE + '/api/store', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v2),
        signal: AbortSignal.timeout(5000),
      });
      (putRes.status === 200 ? pass : fail)('PUT /api/store 接受 v2 结构', `status=${putRes.status}`);
      const badFloor = JSON.parse(JSON.stringify(v2));
      badFloor.players[1].floor = badFloor.players[0].floor;
      const badRes = await fetch(BASE + '/api/store', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badFloor),
        signal: AbortSignal.timeout(5000),
      });
      (badRes.status === 400 ? pass : fail)('PUT /api/store 拒绝重复楼层', `status=${badRes.status}`);
    } catch (err) {
      fail('store 迁移 / PUT 校验', `抛异常：${err.message}`);
    } finally {
      if (originalStore !== null) {
        try { fs.writeFileSync(storeFile, originalStore, 'utf8'); } catch { /* 还原失败会影响下一次启动，但不再抛 */ }
      } else {
        // 原本没有存档（clone 后首次运行）：不要留下测试写入的 v1 草稿
        try { if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile); } catch { /* ignore */ }
      }
    }

    // GET /
    const home = await fetchJson('/');
    if (home.res.status === 200 && /<title[\s>]/i.test(home.text)) {
      const title = (home.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
      pass('GET / 200 且含 <title>', `title=${snip(title.trim(), 80)}；${home.text.length} 字节`);
      const hasIconsJs = /heroicons\.js/.test(home.text);
      (hasIconsJs ? pass : fail)('页面已引入 /heroicons.js', hasIconsJs ? 'index.html 含 script 标签' : 'index.html 未引入 heroicons.js，头像不会显示');
    } else {
      fail('GET / 200 且含 <title>', `status=${home.res.status} 含<title>=${/<title[\s>]/i.test(home.text)} body=${snip(home.text, 240)}`);
    }

    // /heroicons.js 与一张头像（反馈 #5 头像资源）
    const iconsJs = await fetchJson('/heroicons.js');
    if (iconsJs.res.status === 200 && /window\.HERO_ICON/.test(iconsJs.text)) {
      const m = iconsJs.text.match(/"([^"]+)"\s*:/g) || [];
      pass('/heroicons.js 200 且定义 HERO_ICON', `映射条数≈${m.length}`);
    } else {
      fail('/heroicons.js 200 且定义 HERO_ICON', `status=${iconsJs.res.status} body=${snip(iconsJs.text, 160)}`);
    }
    const iconRes = await fetch(BASE + '/icons/105.png', { signal: AbortSignal.timeout(5000) }).catch((e) => ({ ok: false, status: String(e.message) }));
    (iconRes.status === 200 ? pass : fail)('/icons/105.png 可访问', `status=${iconRes.status} content-type=${iconRes.headers ? iconRes.headers.get('content-type') : '—'}`);
  } finally {
    const killed = await killTree(child);
    if (killed) {
      pass('子进程已清理（kill）', `node server.mjs pid=${child.pid} 已退出，端口已释放`);
    } else {
      fail(
        '子进程已清理（kill）',
        `node server.mjs pid=${child.pid} 未能退出，请手动终止（否则会占住端口、影响下一次冒烟）`
      );
    }
    const log = readLog().trim();
    if (log) console.log(`      服务输出片段：${snip(log, 400)}`);
    closeLog();
  }
}

/* ─────────────────────── 4. 引擎函数冒烟 ─────────────────────── */

console.log('\n== 4. 引擎函数冒烟 ==\n');

const ENGINE_PATH = path.join(ROOT, 'web', 'engine.js');

// 内嵌 mini fixture（与真实数据解耦，保证引擎检查不受 data 未就绪影响）
const MINI = {
  heroes: [
    { id: 1, name: '露娜', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 2, name: '镜', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 3, name: '张良', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 4, name: '澜', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 5, name: '妲己', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 6, name: '廉颇', roles: ['top'], alt: [], type: ['坦克'] },
    { id: 7, name: '后羿', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 8, name: '张飞', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  ],
  meta: {
    version: 'smoke-fixture',
    source: 'smoke.mjs 内嵌 fixture',
    tiers: {
      露娜: { tier: 'T0.5', score: 55.0, role: '打野' },
      镜: { tier: 'T1', score: 52.4, role: '打野' },
      张良: { tier: 'T1', score: 51.8, role: '中路' },
      澜: { tier: 'T0', score: 58.2, role: '打野' },
      妲己: { tier: 'T3', score: 44.1, role: '中路' },
      廉颇: { tier: 'T2', score: 47.5, role: '对抗路' },
      后羿: { tier: 'T1', score: 53.4, role: '发育路' },
      张飞: { tier: 'T2', score: 48.0, role: '游走' },
    },
    tags: {
      露娜: ['位移', '爆发', '收割'],
      镜: ['位移', '爆发', '收割'],
      张良: ['硬控', '控制', '法伤'],
      澜: ['位移', '收割', '近战'],
      妲己: ['爆发', '控制', '法伤'],
      廉颇: ['前排', '开团', '控制'],
      后羿: ['持续输出', '远程', '物伤'],
      张飞: ['前排', '开团', '保护'],
    },
    overrides: {},
    weights: { tier: 1.0, threat: 5.0, fragility: 1.5, answerable: 1.0, counter: 1.1, countered: 0.9, synergy: 1.0, compNeed: 1.4, slot: 1.0 },
  },
  relations: {
    date: '2026-10-23',
    counters: [{ a: '张良', b: '露娜', w: 0.8, matches: 420, idx: 4.2, src: 'stats' }],
    synergies: [],
  },
  store: {
    version: 2,
    side: 'blue',
    players: [
      { id: 'p1', name: '玩家1', floor: 1, preferLanes: ['top'], pool: [{ hero: '廉颇', mastery: 'normal' }, { hero: '妲己', mastery: 'basic' }] },
      { id: 'p2', name: '玩家2', floor: 2, preferLanes: ['jungle'], pool: [{ hero: '露娜', mastery: 'best' }, { hero: '镜', mastery: 'normal' }] },
      { id: 'p3', name: '玩家3', floor: 3, preferLanes: ['mid'], pool: [{ hero: '张良', mastery: 'normal' }] },
      { id: 'p4', name: '玩家4', floor: 4, preferLanes: ['adc'], pool: [{ hero: '后羿', mastery: 'normal' }] },
      { id: 'p5', name: '玩家5', floor: 5, preferLanes: ['support'], pool: [{ hero: '张飞', mastery: 'best' }] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  },
};

const mkMiniCtx = (over = {}) =>
  JSON.parse(
    JSON.stringify({
      heroes: MINI.heroes,
      meta: MINI.meta,
      relations: MINI.relations,
      store: Object.assign({}, MINI.store, over.store || {}),
      bans: Object.assign({ ours: [], theirs: [] }, over.bans || {}),
      picks: Object.assign({ blue: [], red: [] }, over.picks || {}),
      assignments: over.assignments || {},
    })
  );

if (!fs.existsSync(ENGINE_PATH)) {
  fail('require web/engine.js', `文件不存在：${ENGINE_PATH}`);
} else {
  let E = null;
  try {
    E = require(ENGINE_PATH);
    if (E && !E.banRecommend && E.default) E = E.default;
    pass('require web/engine.js', `导出键 = ${snip(Object.keys(E || {}))}`);
  } catch (err) {
    fail('require web/engine.js', `加载失败：${err.message}`);
  }

  if (E) {
    const need = ['banRecommend', 'pickRecommend', 'lineupCheck', 'analyzePool', 'normalizeStore'];
    const miss = need.filter((k) => typeof E[k] !== 'function');
    if (miss.length) {
      fail('引擎导出 v2 函数', `缺少 ${snip(miss)}；实测导出键 = ${snip(Object.keys(E))}`);
    } else {
      pass('引擎导出 v2 函数', snip(need));

      // normalizeStore：v1 → v2 迁移
      try {
        const migrated = E.normalizeStore({
          side: 'red',
          players: [{ lane: 'jungle', name: '老档', floor: 2, pool: ['露娜', '镜'] }],
        });
        const p = migrated.players.find((x) => x.floor === 2);
        const ok = migrated.version === 2 && p && Array.isArray(p.preferLanes) && p.preferLanes.includes('jungle') &&
          p.pool.length === 2 && p.pool.every((e) => e.hero && e.mastery === 'normal') && migrated.players.length === 5;
        (ok ? pass : fail)('normalizeStore v1→v2 迁移', ok ? snip(p) : snip(migrated));
      } catch (err) {
        fail('normalizeStore v1→v2 迁移', `抛异常：${err.message}`);
      }

      // banRecommend（v2.2：不再指派执行人）
      try {
        const ban = E.banRecommend(mkMiniCtx());
        const okShape = ban && typeof ban === 'object' && Array.isArray(ban.commands) && Array.isArray(ban.shortlist);
        const noAssign = (ban.commands || []).every((c) => c.playerName === undefined && c.floor === undefined && c.laneHints === undefined);
        if (okShape && ban.commands.length > 0 && noAssign) {
          pass('banRecommend 只给英雄、不指派执行人（反馈：不需要写建议谁 ban）', `commands=${ban.commands.length} 示例=${snip(ban.commands.map((c) => `${c.hero}/${c.tier}`))}`);
        } else {
          fail('banRecommend 只给英雄、不指派执行人', `实测 = ${snip(ban.commands && ban.commands[0])}`);
        }
        // v2.1/v2.2：T0 强度主导（fixture 里 T0=澜，且不在我方池）
        const topTier = ban.commands && ban.commands[0] ? ban.commands[0].tier : '';
        (topTier === 'T0' ? pass : fail)('ban 优先 T0（强度 > 克制）', `首条=${snip(ban.commands && ban.commands[0] && ban.commands[0].hero)} tier=${topTier}`);
      } catch (err) {
        fail('banRecommend 返回非空', `抛异常：${err.message}`);
      }

      // pickRecommend：v2.1 全队池并集 + 阶段
      try {
        const pick = E.pickRecommend(mkMiniCtx());
        const okShape = pick && typeof pick === 'object' && pick.step && typeof pick.step === 'object' && Array.isArray(pick.candidates);
        if (okShape) {
          const own = (pick.candidates || []).every((c) => Array.isArray(c.owners) && c.owners.length > 0 && c.ownerName);
          (own ? pass : fail)('pickRecommend 候选带 owners（全队可打，反馈：取消楼层）',
            own ? `候选 ${pick.candidates.length} 条，示例=${snip(pick.candidates[0] && pick.candidates[0].owners)}` : `缺少 owners：${snip(pick.candidates.slice(0, 2))}`);
          const union = new Set();
          MINI.store.players.forEach((p) => p.pool.forEach((e) => union.add(typeof e === 'string' ? e : e.hero)));
          const inUnion = (pick.candidates || []).every((c) => union.has(c.hero));
          (inUnion ? pass : fail)('pickRecommend 候选来自全队池并集', inUnion ? snip((pick.candidates || []).map((c) => c.hero)) : snip((pick.candidates || []).map((c) => c.hero)));
          // 玩家1 池只有 廉颇/妲己，但候选应包含其他队友池的英雄（不再受楼层限制）
          const beyondP1 = (pick.candidates || []).some((c) => !['廉颇', '妲己'].includes(c.hero));
          (beyondP1 ? pass : fail)('pickRecommend 不再按楼层过滤', beyondP1 ? '候选跨多名玩家池' : `仅玩家1池：${snip((pick.candidates || []).map((c) => c.hero))}`);
          (pick.phase && pick.phase.key === 'grab' ? pass : fail)('我方第 1 手为「先抢」阶段', snip(pick.phase));
          (pick.laneState && Array.isArray(pick.laneState.open) && Array.isArray(pick.laneState.covered)
            ? pass : fail)('pick 返回 laneState（已覆盖/待补分路，v2.2）', snip(pick.laneState));

          // v2.3：一人一英雄匹配 + 候选「谁打」
          const asg = Array.isArray(pick.assignment) ? pick.assignment : null;
          const poolOf = (pi) => {
            const p = MINI.store.players[pi];
            return p ? p.pool.map((e) => (typeof e === 'string' ? e : e.hero)) : [];
          };
          const asgOk = asg && asg.every((a) => a.hero && typeof a.playerIndex === 'number' && poolOf(a.playerIndex).includes(a.hero));
          const distinct = asg && new Set(asg.map((a) => a.playerIndex)).size === asg.length;
          (asgOk && distinct ? pass : fail)('pick 返回 assignment 且一人一英雄（v2.3）', snip(asg));
          const at = pick.candidates && pick.candidates[0] && pick.candidates[0].assignedTo;
          (at && at.name && Array.isArray(pick.candidates[0].fielders) ? pass : fail)('候选带 assignedTo / fielders（谁打）', snip(at));
          (Array.isArray(pick.freePlayers) ? pass : fail)('pick 返回 freePlayers（待上场队友）', snip(pick.freePlayers));

          // v2.3：手动指定（后羿目前在 4 号玩家池里，指定给 4 号）
          const manualPick = E.pickRecommend(mkMiniCtx({
            picks: { blue: ['后羿'], red: ['妲己', '张良'] },
            assignments: { 后羿: 3 },
          }));
          const a0 = manualPick.assignment && manualPick.assignment[0];
          (a0 && a0.hero === '后羿' && a0.playerIndex === 3 && a0.manual === true
            ? pass : fail)('手动指定「后羿→4 号」生效且 manual=true（v2.3）', snip(a0));
          // 不可行指定：露娜在 2 号池，指定给 1 号 → 忽略 + warning
          const badManual = E.pickRecommend(mkMiniCtx({
            picks: { blue: ['露娜'], red: ['妲己', '张良'] },
            assignments: { 露娜: 0 },
          }));
          const badA = badManual.assignment && badManual.assignment[0];
          const warned = (badManual.warnings || []).some((w) => /指定|不可行/.test(w));
          (badA && badA.playerIndex === 1 && !badA.manual && warned
            ? pass : fail)('无效手动指定被忽略并 warning（v2.3）', snip({ a: badA, w: badManual.warnings }));
        } else {
          fail('pickRecommend 返回非空', `实测 = ${snip(pick)}`);
        }
      } catch (err) {
        fail('pickRecommend 返回非空', `抛异常：${err.message}`);
      }

      // 第 4 手应为「克制」阶段（blue 3 picks / red 4 picks → 第 7 手 = 蓝 4 手）
      try {
        const late = E.pickRecommend(mkMiniCtx({
          picks: { blue: ['廉颇', '张良', '后羿'], red: ['澜', '镜', '露娜', '妲己'] },
        }));
        (late.phase && late.phase.key === 'counter' ? pass : fail)('我方第 4 手为「克制」阶段（反馈：后两手 counter）', snip(late.phase));
      } catch (err) {
        fail('末期阶段判定', `抛异常：${err.message}`);
      }

      // lineupCheck：五路覆盖
      try {
        const line = E.lineupCheck(mkMiniCtx());
        const okShape = line && typeof line === 'object' && Array.isArray(line.checks) && Array.isArray(line.survival) &&
          Array.isArray(line.gaps) && line.lanePlan && Array.isArray(line.lanePlan.assignments);
        if (okShape && line.checks.length === 5) {
          pass('lineupCheck 含五路覆盖', `checks=${line.checks.length} survival=${line.survival.length} lanePlan=${snip(line.lanePlan)}`);
        } else {
          fail('lineupCheck 含五路覆盖', `实测 = ${snip(line)}`);
        }
      } catch (err) {
        fail('lineupCheck 返回非空', `抛异常：${err.message}`);
      }

      // analyzePool 去重（反馈 #2 硬要求）
      try {
        const adv = E.analyzePool(mkMiniCtx());
        const sug = Array.isArray(adv.suggestions) ? adv.suggestions : [];
        const names = sug.map((s) => s.hero);
        const uniq = new Set(names);
        (uniq.size === names.length ? pass : fail)('analyzePool 建议无重复英雄（反馈#2）',
          uniq.size === names.length ? `${names.length} 条建议，hero 唯一` : `重复：${snip(names)}`);
        const inPool = sug.filter((s) => (s.forPlayers || []).some((fp) => {
          const player = MINI.store.players[fp.playerIndex];
          return player && player.pool.some((e) => (typeof e === 'string' ? e : e.hero) === s.hero);
        }));
        (inPool.length === 0 ? pass : fail)('analyzePool 不推荐池内已有英雄', inPool.length ? snip(inPool.map((s) => s.hero)) : '全部为池外英雄');
      } catch (err) {
        fail('analyzePool 去重', `抛异常：${err.message}`);
      }

      /* ---------- v2.4：presetsFromCombos / presetPlan / teamReview ---------- */
      const needV24 = ['presetPlan', 'teamReview', 'presetsFromCombos'];
      const missV24 = needV24.filter((k) => typeof E[k] !== 'function');
      if (missV24.length) {
        fail('引擎导出 v2.4 函数（presetPlan/teamReview/presetsFromCombos）',
          `缺少 ${snip(missV24)}；实测导出键 = ${snip(Object.keys(E))}`);
      } else {
        pass('引擎导出 v2.4 函数（presetPlan/teamReview/presetsFromCombos）', snip(needV24));

        // 真实 combos + 用户必 ban → preset 结构
        let presets = [];
        try {
          const combosData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'combos.json'), 'utf8'));
          const bansData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'combo-bans.json'), 'utf8'));
          presets = E.presetsFromCombos(combosData, bansData);
          const jw = presets.find((p) => p && p.id === 'jiangwang-boshi');
          const must = jw ? (jw.threats || []).filter((t) => t.level === 'must').map((t) => t.hero) : [];
          const okMerge = presets.length >= 20 && !!jw && ['墨子', '王昭君', '钟馗'].every((h) => must.includes(h));
          (okMerge ? pass : fail)('presetsFromCombos 真实 combos 合并用户必 ban',
            okMerge
              ? `presets=${presets.length}；僵王博士 must=${snip(must)}；watch=${snip((jw.threats || []).filter((t) => t.level === 'watch').map((t) => t.hero))}`
              : `presets=${presets.length} must=${snip(must)}`);
        } catch (err) {
          fail('presetsFromCombos 真实 combos 合并用户必 ban', `抛异常：${err.message}`);
        }

        // 真实数据 ctx：presetPlan / teamReview 必须返回对象
        try {
          const realHeroes = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'bp', 'data', 'heroes.js'), 'utf8')
              .replace(/^window\.HEROES\s*=\s*/, '')
              .replace(/;\s*$/, '')
          );
          const realMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
          const realRel = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'relations.json'), 'utf8'));
          const realStore = E.normalizeStore(JSON.parse(readStoreRaw()));
          const realCtx = {
            heroes: realHeroes, meta: realMeta, relations: realRel, store: realStore,
            bans: { ours: [], theirs: [] }, picks: { blue: [], red: [] },
            presets, preset: { id: 'jiangwang-boshi' },
          };
          const plan = E.presetPlan(realCtx);
          const mustCount = plan && Array.isArray(plan.threats)
            ? plan.threats.filter((t) => t.level === 'must').length : 0;
          const planOk = plan && typeof plan === 'object' && plan.active === true &&
            Array.isArray(plan.core) && plan.core.length === 2 && mustCount === 3 &&
            plan.progress && plan.progress.bans && plan.progress.bans.total === 3;
          (planOk ? pass : fail)('presetPlan 真实数据返回对象（active + core 2 + must 3 + progress）',
            snip({ active: plan && plan.active, core: plan && (plan.core || []).map((c) => c.hero), mustCount, progress: plan && plan.progress }));

          const review = E.teamReview(realCtx);
          const rvOk = review && typeof review === 'object' && review.ours && review.theirs &&
            typeof review.ours.score === 'number' && typeof review.theirs.score === 'number' &&
            review.preset && review.preset.active === true && Array.isArray(review.matchup && review.matchup.edges);
          (rvOk ? pass : fail)('teamReview 真实数据返回对象（ours/theirs 评分 + preset 段）',
            snip({ done: review && review.done, ours: review && review.ours && review.ours.score, theirs: review && review.theirs && review.theirs.score, presetMatch: review && review.preset && review.preset.matchScore }));
        } catch (err) {
          fail('presetPlan/teamReview 真实数据', `抛异常：${err.message}`);
        }
      }
    }
  }
}

/* ─────────────────────── 汇总 ─────────────────────── */

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) counts[r.level] = (counts[r.level] || 0) + 1;

console.log('\n=== 汇总 ===');
console.log(`共 ${results.length} 项：PASS ${counts.PASS} / FAIL ${counts.FAIL} / SKIP ${counts.SKIP}`);

const fails = results.filter((r) => r.level === 'FAIL');
if (fails.length) {
  console.log('失败明细：');
  for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? `\n    ${f.detail}` : ''}`);
  process.exitCode = 1;
} else {
  console.log('无 FAIL（SKIP 项 = 尚未生成的数据文件，不算失败）。');
}

// 兜底：即使有残留句柄（历史上子进程/keep-alive socket 曾把进程挂住），也保证按时退出，
// 且不改变退出码。定时器 unref 后不会拖住事件循环，只在确实有残留句柄时才触发。
const exitCode = process.exitCode || 0;
setTimeout(() => process.exit(exitCode), 400).unref();
