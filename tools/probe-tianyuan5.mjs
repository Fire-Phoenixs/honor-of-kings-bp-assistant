// 天元之弈：梯度接口 /api/global/tier + BP 顺位槽位 + 覆盖抽样
const BASE = 'https://tianyuanzhiyi.com';
const H = { 'user-agent': 'Mozilla/5.0 Chrome/131.0', referer: 'https://tianyuanzhiyi.com/tier' };
const get = async (p) => (await fetch(BASE + p, { headers: H })).json();

// 1) 梯度接口
const tier = await get('/api/global/tier?date=2026-10-23');
console.log('tier keys:', Array.isArray(tier) ? 'array ' + tier.length : Object.keys(tier));
console.log(JSON.stringify(tier).slice(0, 1500));

// 2) BP 顺位槽位（取一个高出场英雄）
const all = await get('/api/allheroes');
const pick = all.find((h) => h.name === '张良') || all[0];
const bp = await get(`/api/hero/bp?heroId=${pick.id}&date=2026-10-23`);
console.log('\nhero/bp', pick.name, 'slots:', JSON.stringify(bp.pickOrderStats, null, 0).slice(0, 800));

// 3) 克制/配合覆盖抽样（5 个英雄）
console.log('\n--- analysis 抽样 ---');
for (const n of ['张良', '澜', '公孙离', '瑶', '吕布']) {
  const h = all.find((x) => x.name === n);
  if (!h) { console.log(n, '不在 allheroes'); continue; }
  const a = await get(`/api/hero/analysis?heroId=${h.id}`);
  console.log(`${n}(id=${h.id}): counters=${a.counters?.length ?? '?'} counteredBy=${a.counteredBy?.length ?? '?'} goodSyn=${a.goodSynergies?.length ?? '?'} badSyn=${a.badSynergies?.length ?? '?'}`);
  await new Promise((r) => setTimeout(r, 500));
}
console.log('--- done ---');
