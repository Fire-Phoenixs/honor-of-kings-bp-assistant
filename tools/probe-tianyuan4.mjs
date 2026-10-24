// 天元之弈：梯度页数据源 + 数据新鲜度 + 变体英雄（李信光暗等）
const BASE = 'https://tianyuanzhiyi.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://tianyuanzhiyi.com/tier',
};

const html = await (await fetch(BASE + '/tier', { headers: H })).text();
const chunks = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
console.log('tier page chunks:', JSON.stringify(chunks));

for (const c of chunks) {
  const js = await (await fetch(BASE + c, { headers: H })).text();
  const hits = [...new Set([...js.matchAll(/["`'](\/api\/[a-zA-Z0-9_\-\/?=&\.\{\}\$\:]*)/g)].map((m) => m[1]))];
  if (hits.length) console.log('\n' + c + '\n' + hits.join('\n'));
}

// 数据新鲜度：哪些日期有数据
for (const d of ['2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21']) {
  const r = await fetch(`${BASE}/api/herostats?date=${d}&gameMode=1`, { headers: H });
  const j = await r.json().catch(() => null);
  console.log(`date=${d} status=${r.status} rows=${Array.isArray(j) ? j.length : JSON.stringify(j).slice(0, 80)}`);
}

// 变体英雄：baseHeroId != heroId
const all = await (await fetch(`${BASE}/api/herostats?date=2026-10-22&gameMode=3`, { headers: H })).json();
const variants = all.filter((h) => h.baseHeroId !== h.heroId);
console.log('\n变体条数:', variants.length);
console.log(variants.map((v) => `${v.heroName}(id=${v.heroId},base=${v.baseHeroId})`).join(', '));

// 段位抽样：巅峰千强(gm=5) 是否可用 + 各段位英雄条数
for (const gm of [4, 5]) {
  const r = await fetch(`${BASE}/api/herostats?date=2026-10-22&gameMode=${gm}`, { headers: H });
  const j = await r.json().catch(() => null);
  console.log(`gameMode=${gm} rows=${Array.isArray(j) ? j.length : 0}`, Array.isArray(j) && j[0] ? `sample=${j[0].heroName} win${j[0].winRate} ban${j[0].banRate}` : '');
}
console.log('--- done ---');
