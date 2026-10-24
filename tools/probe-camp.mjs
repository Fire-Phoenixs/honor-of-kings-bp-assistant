// 王者营地（kohcamp.qq.com）无登录态探测 —— 只发 2 个请求，不重试、不绕过鉴权
// 目的：确认「不登录能不能拿到英雄榜/梯度数据」，若被拒就停手，由用户登录后再取
const URL = 'https://kohcamp.qq.com/hero/getmaintranklist';

const header = {
  origin: 'https://kohcamp.qq.com',
  istrpcrequest: 'true',
  cchannelid: '2002',
  cclientversioncode: '2047933506',
  cclientversionname: '9.103.0723',
  ccurrentgameid: '20001',
  cgameid: '20001',
  cgzip: '1',
  cisarm64: 'true',
  csupportarm64: 'true',
  csystem: 'android',
  csystemversioncode: '35',
  csystemversionname: '15',
  cpuhardware: 'qcom',
  gameareaid: '0',
  gameid: '20001',
  gameserverid: '0',
  gameroleid: '0',
  gameusersex: '1',
  openid: 'E66DC1CFC7F2EFA94561DD7F09EF7975',
  tinkerid: '2047933506_64_0',
  'content-encrypt': '',
  'accept-encrypt': '',
  noencrypt: '1',
  'x-client-proto': 'https',
  'content-type': 'application/json; charset=UTF-8',
  'user-agent': 'okhttp/4.9.1',
  kohdimgender: '1',
};

async function call(label, payload) {
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { ...header, crand: String(Date.now()) },
      body: JSON.stringify({ recommendPrivacy: 0, ...payload }),
    });
    const t = await r.text();
    console.log(`\n[${label}] HTTP ${r.status} ${r.headers.get('content-type')}`);
    console.log(t.slice(0, 400));
  } catch (e) {
    console.log(`\n[${label}] ERR ${e}`);
  }
}

// segment: 1=所有段位 3=巅峰1350+ 4=顶端排位 5=赛事；position: 0=全部 1=对抗 ... 5=打野
await call('segment=4 顶端排位 position=0 全部', { segment: 4, position: 0 });
await new Promise((r) => setTimeout(r, 1200));
await call('segment=1 所有段位 position=0 全部', { segment: 1, position: 0 });
console.log('\n--- 若无 token 即拿到 resultList，说明营地榜单无需登录；若 returnCode!=0，则需要 CK ---');
