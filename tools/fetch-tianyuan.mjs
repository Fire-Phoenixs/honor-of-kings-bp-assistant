// 天元之弈数据快照抓取（只读 GET，串行限速，失败重试）
// 用法: node hok-bp/tools/fetch-tianyuan.mjs [date]
// 输出: hok-bp/data/snapshot/<date>/{allheroes.json,tier.json,herostats-*.json,analysis.json,bp.json,fetch-log.json}
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://tianyuanzhiyi.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://tianyuanzhiyi.com/heroes',
  accept: 'application/json',
};
const ROOT = path.resolve('hok-bp/data/snapshot');
const GAP_MS = 450;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { requests: 0, retries: 0, errors: [], startedAt: new Date().toISOString() };

async function api(pathname, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) { stats.retries++; await sleep(1200 * attempt); }
    try {
      stats.requests++;
      const r = await fetch(BASE + pathname, { headers: H, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return { __status: 404, __url: pathname };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === retries) { stats.errors.push({ url: pathname, error: String(e) }); return null; }
    }
  }
  return null;
}

const toISO = (d) => d.toISOString().slice(0, 10);

// 1) 找到最新可用日期（T-1 起向前最多试 5 天）
let date = process.argv[2] || null;
if (!date) {
  for (let i = 0; i < 5 && !date; i++) {
    const d = toISO(new Date(Date.now() - i * 86400000));
    const probe = await api(`/api/herostats?date=${d}&gameMode=1`);
    if (Array.isArray(probe) && probe.length > 0) date = d;
    await sleep(GAP_MS);
  }
}
if (!date) { console.error('找不到可用日期'); process.exit(1); }
console.log(`[fetch] 目标日期 = ${date}`);

const outDir = path.join(ROOT, date);
fs.mkdirSync(path.join(outDir), { recursive: true });
const save = (name, data) => {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 1), 'utf8');
  const bytes = fs.statSync(path.join(outDir, name)).size;
  console.log(`  ✓ ${name} (${(bytes / 1024).toFixed(1)} KB)`);
};

// 2) 英雄表 + 梯度
const allheroes = await api('/api/allheroes');
if (!Array.isArray(allheroes)) { console.error('allheroes 拉取失败'); process.exit(1); }
save('allheroes.json', allheroes);
await sleep(GAP_MS);

const tier = await api(`/api/global/tier?date=${date}`);
save('tier.json', tier);
await sleep(GAP_MS);

// 3) 四个分段的胜率/出场/禁用
for (const gm of [1, 3, 4, 5]) {
  const d = await api(`/api/herostats?date=${date}&gameMode=${gm}`);
  save(`herostats-${gm}.json`, d || []);
  await sleep(GAP_MS);
}

// 4) 每个英雄的克制/配合 + BP 顺位
const analysis = {};
const bp = {};
let done = 0;
for (const h of allheroes) {
  const a = await api(`/api/hero/analysis?heroId=${h.id}`);
  if (a) analysis[h.id] = a;
  await sleep(GAP_MS);
  const b = await api(`/api/hero/bp?heroId=${h.id}&date=${date}`);
  if (b) bp[h.id] = b;
  await sleep(GAP_MS);
  done++;
  if (done % 20 === 0) console.log(`  … ${done}/${allheroes.length} 英雄 (requests=${stats.requests})`);
}
save('analysis.json', analysis);
save('bp.json', bp);

stats.finishedAt = new Date().toISOString();
stats.date = date;
stats.heroCount = allheroes.length;
stats.analysisCount = Object.keys(analysis).length;
stats.bpCount = Object.keys(bp).length;
save('fetch-log.json', stats);
console.log(`\n[fetch] 完成：${stats.heroCount} 英雄, ${stats.requests} 请求, ${stats.retries} 重试, ${stats.errors.length} 错误`);
if (stats.errors.length) console.log(JSON.stringify(stats.errors.slice(0, 10), null, 1));
