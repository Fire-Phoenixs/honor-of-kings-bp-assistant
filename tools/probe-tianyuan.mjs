// 天元之弈（tianyuanzhiyi.com）API 探测 — 只读，不写任何业务数据
// 目标：确认 date 参数格式 / gameMode 取值 / 各端点是否需要登录鉴权 / 返回字段结构
const BASE = 'https://tianyuanzhiyi.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  referer: 'https://tianyuanzhiyi.com/heroes',
};

async function probe(path) {
  try {
    const r = await fetch(BASE + path, { headers: H });
    const t = await r.text();
    return { status: r.status, ct: r.headers.get('content-type'), len: t.length, head: t.slice(0, 300) };
  } catch (e) {
    return { err: String(e) };
  }
}

const log = (label, r) => {
  const body = r.err ? 'ERR ' + r.err : `${r.status} [${r.len}B] ${(r.head || '').replace(/\s+/g, ' ')}`;
  console.log(`${label} => ${body}`);
};

for (const d of ['2026-10-22', '20261022', '2026-10-22T00:00:00.000Z', '1761062400000']) {
  log(`herostats date=${d} gm=1`, await probe(`/api/herostats?date=${encodeURIComponent(d)}&gameMode=1`));
}
for (const gm of ['0', '2', '3']) {
  log(`herostats 2026-10-22 gm=${gm}`, await probe(`/api/herostats?date=2026-10-22&gameMode=${gm}`));
}
log('hero/bp 105', await probe('/api/hero/bp?heroId=105&date=2026-10-22'));
log('detail/specifyherostats 105 position=1', await probe('/api/detail/specifyherostats?date=2026-10-22&position=1&heroId=105'));
log('hero/analysis 105', await probe('/api/hero/analysis?heroId=105'));
log('herostats/combined 105', await probe('/api/herostats/combined?date=2026-10-22&heroId=105'));
log('hero/view 105', await probe('/api/hero/view?heroId=105'));
log('global/hotheroes', await probe('/api/global/hotheroes'));
log('herostats/position/trends 105', await probe('/api/herostats/position/trends?heroId=105&days=7'));
log('tier page', await probe('/tier'));
console.log('--- done ---');
