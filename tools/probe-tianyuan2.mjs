// 天元之弈 API 结构探测 2：字段结构 + gameMode 映射 + 克制/BP 数据完整性
const BASE = 'https://tianyuanzhiyi.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://tianyuanzhiyi.com/heroes',
};
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: H });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { status: r.status, raw: t.slice(0, 200) }; }
};
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o) : typeof o);

// 1) herostats 字段
const hs = await get('/api/herostats?date=2026-10-22&gameMode=1');
console.log('herostats gm=1 rows:', Array.isArray(hs) ? hs.length : hs);
if (Array.isArray(hs)) {
  console.log('row keys:', keys(hs[0]));
  console.log('row sample:', JSON.stringify(hs[0], null, 0).slice(0, 900));
  const sorted = [...hs].sort((a, b) => b.banRate - a.banRate).slice(0, 8).map((x) => x.heroName + ' ban' + x.banRate);
  console.log('top ban:', sorted.join(' | '));
  const topWin = [...hs].filter((x) => x.pickRate > 3).sort((a, b) => b.winRate - a.winRate).slice(0, 8).map((x) => x.heroName + ' ' + x.winRate);
  console.log('top win(pick>3):', topWin.join(' | '));
}
const hs3 = await get('/api/herostats?date=2026-10-22&gameMode=3');
if (Array.isArray(hs3)) {
  const top = [...hs3].sort((a, b) => b.banRate - a.banRate).slice(0, 6).map((x) => x.heroName + ' ban' + x.banRate);
  console.log('gm=3 rows:', hs3.length, 'top ban:', top.join(' | '));
  console.log('gm=3 row keys:', keys(hs3[0]));
}

// 2) 单英雄 BP 全量
const bp = await get('/api/hero/bp?heroId=105&date=2026-10-22');
console.log('\n--- hero/bp ---');
console.log(JSON.stringify(bp, null, 1).slice(0, 1800));

// 3) 克制关系全量
const an = await get('/api/hero/analysis?heroId=105');
console.log('\n--- hero/analysis keys ---', keys(an));
for (const k of keys(an)) {
  const v = an[k];
  if (Array.isArray(v)) {
    console.log(`${k}: ${v.length} 条, 字段=${JSON.stringify(keys(v[0]))}`);
    console.log(`  前3: ${JSON.stringify(v.slice(0, 3))}`);
  }
}

// 4) 对位数据（按分路）
for (const pos of [0, 1, 2, 3, 4]) {
  const d = await get(`/api/detail/specifyherostats?date=2026-10-22&position=${pos}&heroId=105`);
  console.log(`specify 105 pos=${pos}:`, JSON.stringify(d).slice(0, 220));
}
const d2 = await get('/api/detail/specifyherostats?date=2026-10-22&position=1&heroId=513');
console.log('specify 513(婉儿) pos=1:', JSON.stringify(d2).slice(0, 300));

// 5) allheroes
const all = await get('/api/allheroes');
console.log('\nallheroes:', all.length, 'sample:', JSON.stringify(all[0]));
const roles = {};
all.forEach((h) => (roles[h.roles] = (roles[h.roles] || 0) + 1));
console.log('roles 分布:', JSON.stringify(roles));
console.log('--- done ---');
