// HOK BP 平台 v2 — 零依赖本地服务
// node server.mjs [--port 3721] [--host 127.0.0.1]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argVal('--port', process.env.HOKBP_PORT || 3721));
const HOST = argVal('--host', '127.0.0.1');

const LANES = ['top', 'jungle', 'mid', 'adc', 'support'];
const MASTERIES = ['best', 'normal', 'basic'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadHeroes() {
  // 单一数据源：bp/data/heroes.js（官方表生成物）；兼容旧位置 data/heroes.js
  const candidates = [path.join(ROOT, 'bp', 'data', 'heroes.js'), path.join(DATA, 'heroes.js')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('找不到 heroes.js');
  const raw = fs.readFileSync(file, 'utf8').replace(/^window\.HEROES\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(raw);
}
const HERO_NAMES = (() => {
  try { return new Set(loadHeroes().map((h) => h.name)); } catch { return new Set(); }
})();

/* ---------------- store v2：归一化 + v1 迁移 ---------------- */

function defaultStore() {
  return {
    version: 2,
    side: 'blue',
    players: LANES.map((lane, i) => ({
      id: 'p' + (i + 1),
      name: '玩家' + (i + 1),
      floor: i + 1,
      preferLanes: [lane],
      pool: [],
    })),
    allowCrossLane: true,
    weights: {},
    history: [],
  };
}

function normMastery(m) {
  return MASTERIES.includes(m) ? m : 'normal';
}

function normPool(rawPool) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(rawPool) ? rawPool : []) {
    let hero = '';
    let mastery = 'normal';
    if (typeof item === 'string') hero = item;
    else if (item && typeof item === 'object') {
      hero = typeof item.hero === 'string' ? item.hero : (typeof item.name === 'string' ? item.name : '');
      mastery = normMastery(item.mastery);
    }
    hero = String(hero || '').trim();
    if (!hero || seen.has(hero)) continue;
    seen.add(hero);
    out.push({ hero, mastery });
  }
  return out;
}

function normPreferLanes(raw, fallbackLane) {
  let arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (!arr.length && fallbackLane && LANES.includes(fallbackLane)) arr = [fallbackLane];
  const out = [];
  for (const l of arr) {
    if (LANES.includes(l) && !out.includes(l)) out.push(l);
    if (out.length >= 2) break;
  }
  return out;
}

function normalizeStore(raw) {
  // 优先用引擎的 normalizeStore（与前端同一套 v1→v2 迁移逻辑，避免两份实现漂移）；
  // 引擎不可用时退回本文件的本地实现。
  try {
    const E = engine();
    if (E && typeof E.normalizeStore === 'function') {
      const out = E.normalizeStore(raw);
      if (out && Array.isArray(out.players) && out.players.length === 5) return out;
    }
  } catch { /* 引擎未就绪时走本地实现 */ }
  return normalizeStoreLocal(raw);
}

function normalizeStoreLocal(raw) {
  const base = defaultStore();
  if (!raw || typeof raw !== 'object') return base;
  const inPlayers = (Array.isArray(raw.players) ? raw.players : []).filter((p) => p && typeof p === 'object');
  // 楼层：合法且唯一才采信，否则按入参顺序重排
  const floors = inPlayers.map((p, i) => {
    const f = Number(p.floor);
    return (Number.isInteger(f) && f >= 1 && f <= 5) ? f : i + 1;
  });
  const seenFloor = new Set();
  const players = base.players.map((slot, i) => {
    const p = inPlayers[i] || {};
    let floor = floors[i];
    while (seenFloor.has(floor)) floor = floor >= 5 ? 1 : floor + 1;
    seenFloor.add(floor);
    return {
      id: typeof p.id === 'string' && p.id ? p.id : slot.id,
      name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim().slice(0, 12) : slot.name,
      floor,
      preferLanes: normPreferLanes(p.preferLanes, p.lane),
      pool: normPool(p.pool),
    };
  });
  return {
    version: 2,
    side: raw.side === 'red' ? 'red' : 'blue',
    players,
    allowCrossLane: raw.allowCrossLane !== false,
    weights: (raw.weights && typeof raw.weights === 'object' && !Array.isArray(raw.weights)) ? raw.weights : {},
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function validateStore(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['store 必须是对象'];
  if (!Array.isArray(raw.players)) return ['store.players 必须是数组'];
  if (raw.players.length !== 5) errors.push('players 必须是 5 人');
  const floors = new Set();
  raw.players.forEach((p, i) => {
    if (!p || typeof p !== 'object') { errors.push(`players[${i}] 非法`); return; }
    const f = Number(p.floor);
    if (!Number.isInteger(f) || f < 1 || f > 5) errors.push(`players[${i}].floor 必须是 1-5`);
    else if (floors.has(f)) errors.push(`楼层 ${f} 重复`);
    else floors.add(f);
    if (p.pool !== undefined && !Array.isArray(p.pool)) errors.push(`players[${i}].pool 必须是数组`);
    const pls = p.preferLanes;
    if (pls !== undefined) {
      if (!Array.isArray(pls)) errors.push(`players[${i}].preferLanes 必须是数组`);
      else if (pls.length > 2) errors.push(`players[${i}].preferLanes 最多 2 个`);
      else for (const l of pls) if (!LANES.includes(l)) errors.push(`players[${i}].preferLanes 含非法分路 ${l}`);
    }
    if (Array.isArray(p.pool)) {
      for (const it of p.pool) {
        const m = typeof it === 'string' ? 'normal' : (it && it.mastery);
        if (m !== undefined && !MASTERIES.includes(m)) errors.push(`熟练度非法：${isTruthy(m)}`);
      }
    }
  });
  return errors;
}
const isTruthy = (v) => String(v);

/* ---------------- 引擎 ---------------- */

function engine() {
  return require(path.join(WEB, 'engine.js'));
}

async function body(req, limit = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体超过 5MB');
    chunks.push(c);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON 解析失败'); }
}

function staticFile(res, rel) {
  // /data/heroes.js 是前端要加载的英雄表，实际文件在 bp/data/heroes.js（单一数据源）
  const file = rel === '/data/heroes.js'
    ? path.join(ROOT, 'bp', 'data', 'heroes.js')
    : path.join(rel.startsWith('/data/') ? ROOT : WEB, rel.replace(/^\//, ''));
  const resolved = path.normalize(file);
  if (!resolved.startsWith(ROOT)) return json(res, 403, { ok: false, error: 'forbidden' });
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + rel);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = decodeURIComponent(url.pathname);
  try {
    // ---- API ----
    if (p === '/api/health') {
      const meta = readJson(path.join(DATA, 'meta.json'), {});
      const rel = readJson(path.join(DATA, 'relations.json'), {});
      const combosData = readJson(path.join(DATA, 'combos.json'), { comps: [] });
      const bansData = readJson(path.join(DATA, 'combo-bans.json'), { overrides: {} });
      let heroCount = 0;
      try { heroCount = loadHeroes().length; } catch {}
      const iconDir = path.join(WEB, 'icons');
      let iconCount = 0;
      try { iconCount = fs.readdirSync(iconDir).filter((f) => f.endsWith('.png')).length; } catch {}
      return json(res, 200, {
        ok: true,
        version: 'v2.4',
        date: meta.version || (rel.date || null),
        source: meta.source || null,
        heroCount,
        iconCount,
        tierCount: Object.keys(meta.tiers || {}).length,
        tagCount: Object.keys(meta.tags || {}).length,
        relCount: (rel.counters || []).length + (rel.synergies || []).length,
        comboCount: Array.isArray(combosData.comps) ? combosData.comps.length : 0,
        comboBanCount: Object.keys(bansData.overrides || {}).length,
        engine: fs.existsSync(path.join(WEB, 'engine.js')),
        root: ROOT,
      });
    }
    if (p === '/api/combos') {
      if (req.method === 'GET') {
        return json(res, 200, readJson(path.join(DATA, 'combos.json'), { version: 1, comps: [] }));
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    // 三方整合参考表（天元 + KPL + 组合；solo 不含组合，comboPotential 仅提示）
    if (p === '/api/integration') {
      if (req.method === 'GET') {
        return json(res, 200, readJson(path.join(DATA, 'integration-v1.json'), {
          version: 0, principle: '未生成：先运行 node tools/integrate-data.mjs', heroes: [],
        }));
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/presets') {
      if (req.method === 'GET') {
        const combosData = readJson(path.join(DATA, 'combos.json'), { version: 1, comps: [] });
        const bansData = readJson(path.join(DATA, 'combo-bans.json'), { version: 1, overrides: {} });
        const E = engine();
        const presets = (E && typeof E.presetsFromCombos === 'function')
          ? E.presetsFromCombos(combosData, bansData)
          : [];
        return json(res, 200, {
          version: 1,
          source: 'data/combos.json + data/combo-bans.json',
          updated: combosData.date || null,
          note: '预选模板由 AI 调研组合（combos.json）适配；combo-bans.json 是用户实战补充的必 ban。',
          presets,
        });
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/meta') {
      if (req.method === 'GET') return json(res, 200, readJson(path.join(DATA, 'meta.json'), { tiers: {}, tags: {}, weights: {} }));
      if (req.method === 'PUT') {
        const data = await body(req);
        if (!data || typeof data !== 'object') return json(res, 400, { ok: false, error: '空请求体' });
        if (data.tiers) {
          const valid = ['T0', 'T0.5', 'T1', 'T2', 'T3', 'T4'];
          for (const [k, v] of Object.entries(data.tiers)) {
            if (HERO_NAMES.size && !HERO_NAMES.has(k)) return json(res, 400, { ok: false, error: `未知英雄: ${k}` });
            const t = typeof v === 'string' ? v : v && v.tier;
            if (!valid.includes(t)) return json(res, 400, { ok: false, error: `非法梯度: ${k} -> ${t}` });
          }
        }
        writeJson(path.join(DATA, 'meta.json'), data);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/relations') {
      if (req.method === 'GET') return json(res, 200, readJson(path.join(DATA, 'relations.json'), { counters: [], synergies: [] }));
      if (req.method === 'PUT') {
        const data = await body(req);
        for (const key of ['counters', 'synergies']) {
          for (const r of (data && data[key]) || []) {
            if (!r || !r.a || !r.b) return json(res, 400, { ok: false, error: `${key} 缺少 a/b` });
            if (r.a === r.b) return json(res, 400, { ok: false, error: `自反: ${r.a}` });
            if (HERO_NAMES.size && (!HERO_NAMES.has(r.a) || !HERO_NAMES.has(r.b))) return json(res, 400, { ok: false, error: `未知英雄: ${r.a}/${r.b}` });
            if (typeof r.w !== 'number' || r.w < 0.2 || r.w > 1) return json(res, 400, { ok: false, error: `w 越界: ${r.a}>${r.b}=${r.w}` });
          }
        }
        writeJson(path.join(DATA, 'relations.json'), data);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/store') {
      const file = path.join(DATA, 'store.json');
      if (req.method === 'GET') {
        return json(res, 200, normalizeStore(readJson(file, null)));
      }
      if (req.method === 'PUT') {
        const data = await body(req);
        const errors = validateStore(data);
        if (errors.length) return json(res, 400, { ok: false, error: errors.slice(0, 6).join('；'), errors });
        writeJson(file, normalizeStore(data));
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }
    if (p === '/api/ai/pool-advice' && req.method === 'POST') {
      const E = engine();
      const meta = readJson(path.join(DATA, 'meta.json'), { tiers: {}, tags: {}, weights: {} });
      const relations = readJson(path.join(DATA, 'relations.json'), { counters: [], synergies: [] });
      const store = normalizeStore(readJson(path.join(DATA, 'store.json'), defaultStore()));
      const heroes = loadHeroes();
      const result = E.analyzePool({ heroes, meta, relations, store, bans: { ours: [], theirs: [] }, picks: { blue: [], red: [] } });
      return json(res, 200, { ok: true, ...result });
    }

    // ---- 静态 ----
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (p === '/' || p === '') return staticFile(res, '/index.html');
    return staticFile(res, p);
  } catch (e) {
    console.error('[server]', e);
    return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log(`HOK BP v2 → http://${HOST}:${actual}`);
  const meta = readJson(path.join(DATA, 'meta.json'), {});
  console.log(`data: ${meta.version || '未生成'} | ${path.join(ROOT)}`);
  if (argv.includes('--open')) {
    import('node:child_process').then(({ exec }) => exec(`start "" http://${HOST}:${actual}`));
  }
});


