// 天元之弈：robots.txt / 梯度分段参数 / 名称对齐 / 数据完整性
import fs from 'node:fs';

const BASE = 'https://tianyuanzhiyi.com';
const H = { 'user-agent': 'Mozilla/5.0 Chrome/131.0', referer: 'https://tianyuanzhiyi.com/tier' };
const get = async (p) => (await fetch(BASE + p, { headers: H })).json();

// robots
const rb = await (await fetch(BASE + '/robots.txt', { headers: H })).text();
console.log('--- robots.txt ---\n' + rb.slice(0, 600));

// 梯度：默认 + 分段参数
for (const q of ['/api/global/tier?date=2026-10-23', '/api/global/tier?date=2026-10-23&gameMode=5', '/api/global/tier?date=2026-10-23&gameMode=4']) {
  const t = await get(q).catch((e) => ({ err: String(e) }));
  const rows = t.tiers || [];
  const label = {};
  rows.forEach((r) => (label[r.tierInRole] = (label[r.tierInRole] || 0) + 1));
  console.log(`\n${q} rows=${rows.length} tier分布=${JSON.stringify(label)}`);
  if (rows[0]) console.log('sample:', rows[0].heroName, rows[0].role, rows[0].tierInRole, rows[0].finalNormalizedTierScore);
}

// 名称对齐：天元 allheroes vs 本地 heroes.js
const all = await get('/api/allheroes');
const local = JSON.parse(fs.readFileSync('hok-bp/bp/data/heroes.js', 'utf8').replace('window.HEROES = ', '').replace(/;\s*$/, ''));
const tyNames = new Set(all.map((h) => h.name));
const localNames = new Set(local.map((h) => h.name));
console.log('\n天元', tyNames.size, '本地', localNames.size);
console.log('天元有本地无:', [...tyNames].filter((n) => !localNames.has(n)));
console.log('本地有天元无:', [...localNames].filter((n) => !tyNames.has(n)));

// 梯度里出现的 role 值
const t = await get('/api/global/tier?date=2026-10-23');
const roles = {};
t.tiers.forEach((r) => (roles[r.role] = (roles[r.role] || 0) + 1));
console.log('\n梯度 role 取值:', JSON.stringify(roles, null, 0).slice(0, 800));
console.log('--- done ---');
