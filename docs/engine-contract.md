# 契约冻结：BP 平台 v1（engine / server / UI / data）

> ⚠️ **已被 v2 取代**：2026-10-24 的实战反馈后，接口基线改为 [`docs/engine-contract-v2.md`](./engine-contract-v2.md)。
> 本文件保留作历史参考（v1 的「每人绑定分路」设计已废弃）。engine.js / app.js / server.mjs 均按 v2 实现。

> 本文件是并行开发的**唯一接口契约**。engine/server/UI/data 四条线都按此实现，改动需 Lead 同意。
> 目标运行环境：本机 Node v24.22.1，零 npm 依赖，浏览器访问 `http://127.0.0.1:3721`。

## 1. 目录与写范围

| 路径 | 归属 | 说明 |
|---|---|---|
| `hok-bp/server.mjs`、`hok-bp/start.cmd` | Lead | 本地服务 + 启动脚本 |
| `hok-bp/web/engine.js` | Lead | 决策引擎（UMD，浏览器+node 共用） |
| `hok-bp/web/index.html`、`app.js`、`style.css`、`ai.js` | ui-kit | 单页 UI |
| `hok-bp/data/meta.json`、`relations.json`、`store.json` | data-kit | 运行数据 |
| `hok-bp/tools/build-meta.mjs`、`validate-data.mjs` | data-kit | 数据构建 + 校验 |
| `hok-bp/tools/test-engine.mjs`、`smoke.mjs` | qa-kit | 测试 |
| `hok-bp/data/snapshot/**` | Lead（抓取工具产出） | 只读，勿改 |

禁止跨范围写。需要改别人范围时，报告 Lead。

## 2. 数据形状（必须严格遵守）

### 2.1 `bp/data/heroes.js`（已存在，勿改；`/data/heroes.js` 由 server 映射到这里）
```js
window.HEROES = [{ id:105, name:'廉颇', roles:['top','support'], alt:[], type:['坦克'] }, ...]; // 133 条
```
分路键：`top` 对抗路 / `jungle` 打野 / `mid` 中路 / `adc` 发育路 / `support` 游走。

### 2.2 `data/meta.json`
```jsonc
{
  "version": "2026-10-23",
  "source": "天元之弈 https://tianyuanzhiyi.com",
  "tiers": { "澜": { "tier": "T0", "score": 78.74, "role": "打野/对抗路", "winRate": 52.1, "pickRate": 8.3, "banRate": 21.4, "winRateDelta": 0.3 } },
  "tags":  { "澜": ["位移","爆发","收割","近战"] },
  "overrides": { "元流之子(刺客)": { "type": ["刺客"] } },
  "weights": { "tier":1.0, "threat":5.0, "fragility":1.5, "answerable":1.0, "counter":1.1, "countered":0.9, "synergy":1.0, "compNeed":1.4, "slot":1.0 }
}
```
- `tier` 取值：`T0 | T0.5 | T1 | T2 | T3 | T4`（缺失按 `T2`）。
- `tags` 允许的标签（固定集合，可扩展但 UI 按此显示）：`前排, 开团, 保护, 控制, 硬控, 免控, 回复, 护盾, 真伤, 爆发, 持续输出, 收割, 位移, 远程, 近战, 法伤, 物伤, 体系`。
- 所有 key 必须命中 `heroes.js` 的 `name`。

### 2.3 `data/relations.json`
```jsonc
{
  "date": "2026-10-23",
  "counters":  [ { "a":"张良", "b":"露娜", "w":0.85, "matches":420, "idx":4.2, "src":"stats" } ],
  "synergies": [ { "a":"明世隐", "b":"后羿", "w":0.60, "matches":310, "idx":2.9, "src":"stats" } ]
}
```
- `counters` 只写单向：`a` 克 `b`；反向由 engine 推导。
- `w` ∈ [0.3, 1.0]；`src ∈ stats | manual | inferred`。
- 每条 `a`/`b` 必须存在于 `heroes.js`，且 `a !== b`。

### 2.4 `data/store.json`
```jsonc
{
  "side": "blue",                       // 我方阵营，blue|red
  "players": [                          // 固定 5 条，lane 唯一
    { "lane":"top", "name":"玩家1", "floor":1, "pool":["廉颇","白起"] }
  ],
  "allowCrossLane": false,              // false = 只能选本分路英雄
  "weights": {},                        // 覆盖 meta.weights 的部分字段
  "history": []                         // 每次导出追加 { at, side, bans, picks, exported }
}
```

## 3. engine API（`web/engine.js`，UMD）

必须同时支持浏览器 `<script>` 与 node `require`：
```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HOKEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () { /* ... */ return API; });
```

### 3.1 常量
```js
LANES = { top:'对抗路', jungle:'打野', mid:'中路', adc:'发育路', support:'游走' }
PICK_SEQUENCE = ['B','R','R','B','B','R','R','B','B','R']   // 蓝1 红1 红2 蓝2 蓝3 红3 红4 蓝4 蓝5 红5
TIER_WEIGHT = { T0:10, 'T0.5':8, T1:6, T2:4, T3:2, T4:1 }
TAG_SET = [...]   // 与 meta.tags 一致
```

### 3.2 上下文 `ctx`
```js
ctx = {
  heroes,        // HEROES 数组
  meta,          // meta.json
  relations,     // relations.json
  store,         // store.json
  bans: { ours: string[], theirs: string[] },   // 英雄名；未知可空
  picks: { blue: string[], red: string[] },     // 已选（按顺序）
}
```

### 3.3 `HOKEngine.banRecommend(ctx) -> BanResult`
```js
{
  date, side,
  commands: [{
    playerIndex: 0, playerName: '玩家1', lane: 'jungle', laneLabel: '打野',
    hero: '张良', tier: 'T1', score: 92.4,
    breakdown: { tier: 6, threat: 2.4, fragility: 1.1, answerable: 0 },
    reason: '硬控压制你池里的露娜/镜；你只有 2 个打野，容错最低',
    alternatives: [ { hero: '澜', score: 88.2, tier: 'T0' } ]
  }],
  shortlist: [ { hero, score, tier, reason } ],   // 全局 Top8
  warnings: [ '你的池子里已有 澜，已从 ban 候选中排除' ]
}
```
规则（Lead 实现）：
1. 候选 = 全英雄 − 我方池 − 已 ban；
2. `banScore = w.tier*tierW + w.threat*threat + w.fragility*fragility − w.answerable*answerable`；
3. 分配：按 `threat` 找「最受伤的一路」，每人 ≤1 个，冲突顺延；`alternatives` = 该玩家池被威胁的第 2/3 名；
4. 我方池里的英雄**从候选排除**（不是置 0），并在 warnings 说明。

### 3.4 `HOKEngine.pickRecommend(ctx) -> PickResult`
```js
{
  step: { index: 3, side: 'blue', isOurs: true, floor: 2, label: '蓝方2楼', slotType: 'first'|'middle'|'late' },
  candidates: [{
    hero: '澜', tier: 'T0', score: 12.3,
    breakdown: { tier: 10, counter: 1.2, countered: -0.9, synergy: 0.8, compNeed: 1.1, slot: 2.0 },
    reason: '首抢强势；对敌方镜有显式克制'
  }],
  warnings: [ '你的池子被打穿：打野 3/5 已被 ban' ]
}
```
- `step` 由 `picks.blue.length + picks.red.length` 推下一个槽位；
- 我方槽位：候选 = 该楼层玩家池 − 已 ban − 已选；敌方槽位：`candidates` 为空、`step.isOurs=false`（UI 让用户录入）；
- `slotType`：`first`（首抢，槽 1）→ slot 权重 +0.35、被克系数 1.3；`middle`（2-4 手）→ +0.15、compNeed×1.2；`late`（末选 counter 位，槽 10）→ 0、克制收益×1.6；其它 +0.1。
- `compNeed` 精确口径（与交接文档 §6.4 一致）：第 1-3 手（index 0/1/2）系数 **0.5**；第 4-9 手（index 3-8，即双方中段，蓝2/3 楼与红3/4 楼）系数 **1.2**；第 10 手（末选）系数 **1.0**。QA 断言请用「第 3 手 vs 第 9 手」对比，不要用第 4 手（第 4 手属于中段，系数 1.2）。

### 3.5 `HOKEngine.lineupCheck(ctx) -> LineupResult`
```js
{
  checks: [
    { key:'front', label:'前排', ok:true,  value:2, need:1, note:'廉颇、白起' },
    { key:'engage', label:'开团', ok:false, value:0, need:1, note:'' },
    { key:'protect', label:'保护', ok:false, value:0, need:1, note:'' },
    { key:'damage', label:'伤害类型', ok:true, value:'物2/法1', need:'各≥1', note:'' },
    { key:'control', label:'控制', ok:true, value:3, need:2, note:'' }
  ],
  survival: [ { lane:'jungle', laneLabel:'打野', total:3, alive:1, ratio:0.33, aliveHeroes:['澜'] } ],
  gaps: [ '缺开团', '缺保护' ]
}
```

### 3.6 `HOKEngine.analyzePool(ctx) -> PoolAnalysis`（规则版 AI 补池）
```js
{
  lanes: [ { lane:'top', laneLabel:'对抗路', players:[ { name:'玩家1', depth:4, coverage:{front:true,engage:false,...} } ] } ],
  suggestions: [ { hero:'张飞', lane:'support', forPlayers:['玩家5'], tier:'T2', reasons:['补开团','T2 可接受'] } ],
  notes: [ '打野池只有 2 个，建议补到 4+ 以抗 ban' ]
}
```

## 4. HTTP API（`server.mjs`，127.0.0.1:3721）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/` | 返回 `web/index.html` |
| GET | `/api/health` | `{ ok:true, date, heroCount, tierCount, relCount, root }` |
| GET | `/api/meta` | `meta.json` |
| PUT | `/api/meta` | 覆盖写（校验 JSON）→ `{ok:true}` |
| GET | `/api/relations` | `relations.json` |
| PUT | `/api/relations` | 覆盖写（校验：英雄名存在、无自反）→ `{ok:true}` |
| GET | `/api/store` | `store.json`（不存在则返回默认空模板） |
| PUT | `/api/store` | 覆盖写 → `{ok:true}` |
| POST | `/api/ai/pool-advice` | 读当前 store + data，返回 `analyzePool` 结果（规则版；无 LLM key 时不报错） |

静态：`/index.html` `/app.js` `/engine.js` `/ai.js` `/style.css` 映射到 `web/`；`/data/heroes.js` 特殊映射到 `bp/data/heroes.js`（单一数据源），其余 `/data/*` 映射到 `data/`。
错误统一 `{ ok:false, error:'...' }` + 4xx/5xx。请求体上限 5MB。

## 5. UI 要求（ui-kit）

- 单页 5 个 Tab：**设置 / BP / 梯度 / 数据 / 导出**，纯原生 JS，无框架、无构建、非 module（普通 `<script>` 顺序加载：`data/heroes.js` → `engine.js` → `ai.js` → `app.js`）。
- 启动流程：`GET /api/health` 显示数据日期 → `GET /api/meta|relations|store` → 若 store 为空显示「空模板」（5 行：分路 + 名字 + 楼层 + 池）。
- 设置页：阵营切换、5 人分路/名字/楼层、英雄池多选（默认只列本分路 + 勾选「允许跨路」后列全部）、保存到 `PUT /api/store`。
- BP 页：
  1. **Ban 阶段**：显示 5 条执行指令（谁 ban 谁 + 分数 + 理由 + 备选）；可「一键采用」；录入实际我方 ban（多选 5 个）；再录入敌方 ban（可留空 = 未知）。
  2. **Pick 阶段**：按序列自动定位当前手；轮到我方显示 Top3-5（分数拆解 + 理由）并可点选；轮到敌方用搜索框录入。
  3. 右侧常驻阵容体检（5 项 + 池存活率 + gaps），每次选人刷新。
  4. 顶部显示「第 N/10 手 · 蓝方2楼 · 我方」。
- 梯度页：表格（英雄/分路/T度/分数/胜率/出场/禁用），支持按 T 度筛选；支持粘贴导入（`T0: 澜 镜` 每行一段）→ 改 `meta.tiers` → `PUT /api/meta`。
- 数据页：显示 relations 统计（条数/来源/样本量分布）+ 校验结果；只读为主。
- 导出页：生成可复制的 BP 文本（含推荐与实际）+ 下载 JSON；追加到 `store.history`。
- AI 按钮（设置页）：「体检 & 补池建议」→ `POST /api/ai/pool-advice` → 展示 suggestions 并支持「加入池」。
- 中文界面、窄屏可用（≤768px 单列）、大按钮（BP 时要点得快）。

## 6. 验收（Lead 集成时逐条跑）

1. `node hok-bp/tools/validate-data.mjs` → 0 错误；
2. `node hok-bp/tools/test-engine.mjs` → 全绿（12 用例，含「打野池只有露娜/镜时张良进 ban 前三」）；
3. `node hok-bp/tools/smoke.mjs` → 服务起得来、页面 200、API 全 200、engine 返回结构正确；
4. 手动：空模板 → 填 5 人 → ban 5 条指令 → 录 10 ban → 跑完 10 手 pick → 导出文本，全程 ≤90 秒。
