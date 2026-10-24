// 天元之弈：gameMode 映射 + 限流/缓存头 + 可能的梯度接口
const BASE = 'https://tianyuanzhiyi.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://tianyuanzhiyi.com/heroes',
};

// 1) 从 JS 里找 全分段/1350/顶端排位/巅峰千强 与 gameMode 的对应
const js = await (await fetch(BASE + '/_next/static/chunks/app/heroes/page-e0694b22304a5efe.js', { headers: H })).text();
const idx = [];
for (const kw of ['全分段', '1350', '顶端排位', '巅峰千强', 'gameMode']) {
  let i = -1;
  while ((i = js.indexOf(kw, i + 1)) !== -1) idx.push([kw, i]);
}
console.log('命中次数:', JSON.stringify(idx.reduce((a, [k]) => ((a[k] = (a[k] || 0) + 1), a), {})));
for (const [kw, i] of idx.slice(0, 14)) {
  console.log(`\n[${kw} @${i}] ...${js.slice(Math.max(0, i - 160), i + 120).replace(/\s+/g, ' ')}...`);
}

// 2) 检查缓存/限流响应头
const r = await fetch(BASE + '/api/herostats?date=2026-10-22&gameMode=1', { headers: H });
console.log('\nheaders:', JSON.stringify(Object.fromEntries([...r.headers].filter(([k]) => /cache|rate|limit|age/i.test(k)))));
console.log('status', r.status);

// 3) 试梯度接口（tier 页面的数据源可能不同）
for (const p of ['/api/tier', '/api/herotier', '/api/hero/tier', '/api/tiers', '/api/rank/tier', '/api/xiaomagao']) {
  try {
    const rr = await fetch(BASE + p, { headers: H });
    const t = await rr.text();
    console.log(p, '=>', rr.status, t.slice(0, 120).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(p, '=> ERR', String(e));
  }
}
console.log('--- done ---');
