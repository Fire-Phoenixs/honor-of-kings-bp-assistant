# 功能契约：赛前预选阵容 + 赛后队伍总体评价（v2.4）

> 本文件是 2026-10-24 新需求（预选阵容 / BP 后总体评价）的唯一接口基线。
> 数据、引擎、UI、测试必须同时遵守；字段名不要自行改名。
> 现有 v2.3 契约（`docs/engine-contract-v2.md`）继续有效，本文件只做增量。

## 0. 产品目标（用户原话拆解）

1. **BP 做完之后，显示一个队伍总体评价**：双方阵容各一张评价卡（强度/结构/配合/克制/核心/打法/风险），再加一段对位结论与打法要点。只基于英雄强度、克制、配合、阵容结构，**不预测胜率，不写局内出装/操作**。
2. **赛前预选阵容**：BP 前先选一套想打的阵容（例如「鲁班七号 + 盾山」），BP 按这个方向走：
   - 队友倾向 = 保护、反开、跟盾山配合（显示成每路/每人的分工）；
   - Ban 位优先 ban 对这套组合威胁最大的英雄（鲁班+盾山 = 墨子、王昭君、钟馗，必须 ban）；
   - Pick 优先拿预选核心，其次拿推荐搭配；界面标明「预选核心 / 预选搭配」，并跟踪完成度。

约束：全程鼠标可点；不新增冗余配置项；不接外部模型；不改变 `store` 结构（预选是单局会话态，存 sessionStorage）。

---

## 1. 数据：复用 AI 调研成果（不重写组合/克制）

> **2026-10-24 调整**：组合与克制资料已经由 AI 调研完成，本功能只做「接口 + 消费」。
> 不再维护手写的 `data/presets.json`；服务端在内存里把调研数据适配成 UI/引擎可用的 preset 结构。

### 1.1 源数据

| 文件 | 内容 | 用途 |
|---|---|---|
| `data/combos.json` | 34 套组合（2/3/4/5 人）：`id/name/size/priority/core/flex/lanes/why/banTargets/counteredBy/confidence/stats/sources/type/phase` | 预选模板 + 核心/可替代件 + AI 拆解点 |
| `data/combo-bans.json` | 用户实战补充的「必 ban」（目前 `jiangwang-boshi` → 墨子/王昭君/钟馗） | 覆盖 AI 调研，必须优先 ban |
| `docs/强势组合与克制关系-调研.md` | 调研结论/证据/局限 | 说明文档；UI 的「AI 调研结论」取自 `why` |
| `data/research/counters-raw.md` | 35 位英雄克制明细 | 克制数据来源（已结构化进 combos 的 `counteredBy`） |

字段语义（来自调研文档）：

- `core`：缺一件即不成体系的核心件（2–5 个）。
- `flex`：某核心件的可替代件，如 `{"墨子":["大乔"]}`；引擎作为搭配/替代加分。
- `counteredBy`：会拆解这套组合的英雄 → 预选方案里的 must/watch 威胁。
- `banTargets`：对面大概率会 ban 的我方关键件（UI 提示「对面会 ban」，不是我们的 ban 建议）。
- `priority`：S/A/B；`stats`：本地统计对照（`idx/matches`，null 表示无记录）。

### 1.2 适配函数 `HOKEngine.presetsFromCombos(combosData, overridesData)`

服务端 `GET /api/presets` 与测试共用，输出 preset 数组（字段与 §3.1 一致，另带调研元数据）。合并规则：

1. `threats` 先放 `combo-bans.json` 的 `mustBans`（`level:'must'`, `source:'user'`）。
2. 再放 `combos.json` 的 `counteredBy`（`source:'research'`）：
   - 该组合有用户必 ban → 调研项全部 `level:'watch'`（提防，不占必 ban 进度）；
   - 没有用户必 ban → 前 3 个 `level:'must'`，其余 `watch`。
3. `partners` = `flex` 的可替代件（`note:'可替代 X（AI 调研）'`）。
4. `playstyle` 由 `type/phase/why/name` 推导（保护反打/带线/消耗/强开/阵地/控制/均衡），`winCondition` 取 `why`。
5. 元数据原样带出：`size/priority/type/phase/why/lanes/banTargets/counteredBy/confidence/stats/sources/flex`。

### 1.3 校验规则（`tools/validate-data.mjs`）

- `data/combos.json`：≥30 条；`id` 唯一；`core` 2–5 个、英雄存在、无重复；`size === core.length`；`priority ∈ {S,A,B}`；`counteredBy/banTargets` 英雄存在；`stats` 为 `{idx:number|null,matches:number}`。
- `data/combo-bans.json`：`overrides` 的 key 必须是存在的 combo id；`mustBans[].hero` 存在且不在该 combo 的 `core` 里；`reason` 非空。
- 必须存在 `jiangwang-boshi`，其 core 含 `鲁班七号`、`盾山`，且用户必 ban 含 `墨子`、`王昭君`、`钟馗`。

### 1.4 接口

- `GET /api/combos` → 原始 `data/combos.json`。
- `GET /api/presets` → `{version, source, updated, note, presets:[...]}`（适配后，34 条）。

---

## 2. ctx 增量

```js
ctx = {
  ...v2.3 字段,
  presets: [<presetsFromCombos 适配后的 preset>],   // 模板库；可为空
  preset: { id: 'jiangwang-boshi' } | { id: 'custom', core: ['鲁班七号','盾山'] } | null
}
```

- `preset.id` 命中 `ctx.presets` → 用模板；未命中且 `preset.core` 有 1..5 个英雄 → 走「自定义推导」。
- 自定义核心如果与某套模板 core 完全一致（顺序无关）→ 直接复用模板的 must ban / 搭配 / 分工。
- `preset` 为 `null` / 空 → 所有新增函数返回 `active:false`，原有 ban/pick 行为完全不变。
- `workCtx` 必须透传 `presets` 与 `preset`（浅拷贝即可）。

---

## 3. 引擎 API（`web/engine.js`）

所有函数不抛异常；`active:false` 时返回 `warnings: []` 的空结构。代码风格沿用 ES5（`var/function`，无箭头函数/const/let/模板串）。

### 3.1 `presetPlan(ctx)`

```js
{
  active: true,
  custom: false,
  id: 'jiangwang-boshi',
  name: '僵王博士（鲁班七号 + 盾山）',
  subtitle: 'A档 · 移动扫射 / 射辅连体',
  tags: ['A','移动扫射 / 射辅连体','全期，对线强度 T0.5 起步'],
  core: [{
    hero: '鲁班七号', heroId: 133, tier: 'T2',
    lane: 'adc', laneLabel: '发育路',
    inPool: true,
    owners: [{ playerIndex: 1, name: '刘', mastery: 'best', masteryLabel: '绝活' }],
    status: 'available' | 'banned' | 'picked' | 'unavailable',
    statusLabel: '可拿' | '已被 ban' | '已被选' | '池里没人会'
  }],
  threats: [{
    hero: '墨子', heroId: 105, tier: 'T2', level: 'must',
    reason: '...', source: 'user' | 'research', inOurPool: false,
    owners: [{...}],
    status: 'available' | 'banned' | 'picked',
    banned: false
  }],
  partners: [{
    hero: '鲁班大师', heroId: 123, tier: 'T2', note: '...',
    inPool: true, owners: [{...}],
    status: 'available' | 'banned' | 'picked'
  }],
  playstyle: { key:'protect', label:'保护 + 反手', desc:'...' },
  winCondition: '...',
  teamPlan: [{ lane:'support', role:'辅助', instruction:'...' }],
  tips: ['...'],
  // AI 调研元数据（combos.json）
  size: 2, priority: 'A', type: '移动扫射 / 射辅连体', phase: '全期...',
  why: '盾山一技能可带鲁班穿墙...', lanes: { '发育路':['鲁班七号'], '游走':['盾山'] },
  banTargets: [], counteredBy: ['吕布','貂蝉','镜','澜'],
  confidence: 'high', stats: { idx: 3.88, matches: 6765 },
  sources: ['https://...'], flex: {},
  progress: {
    core: { picked: 1, total: 2 },
    partners: { picked: 0, total: 3 },
    bans: { banned: 2, total: 3 }
  },
  warnings: ['预选核心「盾山」不在任何队友池里…']
}
```

口径：

- `core/partners` 的 `owners` 来自我方 5 个池（按熟练度 best>normal>basic 排）；`inPool` = owners 非空。
- `status`：已出现在 `bans.ours/theirs` → `banned`；已出现在 `picks.blue/red` → `picked`；否则 `available`；核心不在任何池 → `unavailable`（优先于 available；若已被 ban/选仍按 banned/picked）。
- `progress.core.picked` = 我方已选中的 core 数；`progress.partners.picked` = 我方已选中的 partners 数；`progress.bans.banned` = 我方 ban 位里的 must 威胁数。
- `custom: true` 时从 `preset.core` 推导：
  - **partners**：与核心有数据配合（`synergyOf`）或标签互补（保护/前排/硬控 × 持续输出/远程/爆发）的前 6 个；
  - **threats**：对核心克制分 `Σ counterOf(x → core)` 最高的前 5 个，前 3 个 `level:'must'`；再叠加标签启发（核心是站桩射手时，硬控/开团/远程威胁加分）；
  - **playstyle/winCondition/teamPlan/tips**：按核心标签推导，至少覆盖「保护+反手」「强开冲阵」「阵地推进」「带线转线」「均衡」5 类。
- 无 preset / 数据为空 → `{ active:false, core:[], threats:[], partners:[], progress:{...0}, warnings:[] }`。
- 警告示例：核心不在任何池；核心已被 ban；必 ban 还没 ban（只在我方 ban 已满 5 个或已进入 Pick 时提示）。

### 3.2 `teamReview(ctx)`

只在 10 手选完后给出完整评价，但任何时刻都可调用（`done:false` 时也返回已有信息）。

```js
{
  done: true,
  date: '2026-10-23',
  side: 'blue',
  ours: sideReview,
  theirs: sideReview,
  matchup: {
    verdict: { key:'even'|'ours'|'theirs', label:'均势', note:'...' },
    edges: [{ key:'score', label:'阵容强度', ours:72, theirs:68, lead:'ours'|'theirs'|'even', note:'...' }],
    threats: [{ hero:'墨子', tier:'T2', reason:'克我方 鲁班七号（0.60）' }],
    winConditions: ['...'],
    tips: ['...']
  },
  preset: {
    active: true, id:'jiangwang-boshi', name:'僵王博士（鲁班七号 + 盾山）',
    matchScore: 86,
    coreHit: 2, coreTotal: 2,
    mustBansDone: 3, mustBansTotal: 3,
    partnerHit: 1, partnerTotal: 3,
    coreStatus: [{ hero:'鲁班七号', status:'picked', playerName:'刘' }],
    offPlan: ['花木兰'],
    notes: ['核心 2/2 全拿到', '墨子/王昭君/钟馗 全部 ban 掉', '第 3 手 花木兰 偏出方案']
  },
  warnings: []
}
```

`sideReview`：

```js
{
  side: 'blue',
  label: '我方',
  heroes: ['鲁班七号','盾山','...'],              // 只含已知英雄（过滤「空N」占位）
  assignment: [{ hero, playerName, mastery, masteryLabel }],  // 我方有；敌方为 []
  lanePlan: { assignments:[{lane,laneLabel,hero,playerName,floor}], uncovered:[label] },
  score: 78,
  grade: { key:'A', label:'强', tone:'good'|'ok'|'bad' },
  breakdown: { tier: 35.2, structure: 20, synergy: 12.4, matchup: 10.4 }, // 和 = score（±0.1）
  dimensions: [{ key:'front', label:'前排', value:2, need:1, level:'ok'|'warn'|'bad', detail:'2 个前排' }],
  playstyle: { key, label, desc },
  core: { hero, playerName, mastery, tier, reason },
  synergies: [{ a, b, w, note }],                 // 前 3 对，w>=0.5
  combos: [{ id, name, priority, type, hit, total, complete, flexHit, score }], // 命中的 AI 调研体系（最多 3 条）
  strengths: ['...'],
  risks: ['...'],
  bans: { ours: [...], theirs: [...] }           // 双方 ban 都展示，便于语境
}
```

评分口径（可解释、确定性）：

```
tierNorm     = mean(tierWeight(hero)/10)                       // 0..1
structure    = 满足的 5 项（前排/开团/保护/双伤害/控制≥2）/5     // 0..1
synergyNorm  = min(1, Σ队内 pair synergy / 2.5)
counterPush  = Σ_{我方英雄×敌方英雄} counterOf(ours→theirs)
counterFear  = Σ_{我方英雄×敌方英雄} counterOf(theirs→ours)
matchupNorm  = clamp(0.5 + (counterPush - counterFear)/8, 0, 1)
score        = round(45*tierNorm + 25*structure + 15*synergyNorm + 15*matchupNorm)
```

- 等级：`S ≥ 80`（极强）、`A ≥ 70`（强）、`B ≥ 60`（均衡）、`C ≥ 50`（偏弱）、`D < 50`（吃力）。
- `breakdown` 四项分别 = 45×tierNorm、25×structure、15×synergyNorm、15×matchupNorm（保留 1 位）。
- 敌方没有熟练度数据，**评分不加入熟练度**（避免不对称）；我方熟练度只作为 `risks`/`core.reason` 的信息。
- `playstyle` 推导：保护+持续输出 → 保护反打；开团≥2 → 强开冲阵；含大乔 → 带线转线；前排+持续输出 → 阵地推进；控制≥3 → 控制链；否则均衡。
- `core`：tierW 最高者；同分取与队内配合最高者；我方再同分取熟练度高者。
- `strengths` 至少 2 条（例：T0 核心、结构达标、双伤害、五人路齐、配合高）；`risks` 至少 2 条（例：缺保护、缺法术伤害、核心被克、熟练度「仅会玩」、无前排）。
- `matchup.threats`：敌方英雄对我方每个英雄的 `counterOf` 求和，取前 3；理由写「克我方 X（w）」。
- `matchup.winConditions/tips`：结合双方 playstyle、结构缺口、预选方案生成；winConditions 2–4 条、tips 2–5 条；只谈阵容层（保核心/反手/带线/开团时机），不写装备与操作细节。
- `done` = `picks.blue.length + picks.red.length >= 10`（跳过也计数）；占位「空N」不当作英雄。
- 预选匹配：
  - `matchScore`：默认 `core 60 + 必 ban 30 + 搭配 10`；若该组合没有可替代件/搭配（如 2 人组合），权重改为 `core 70 + 必 ban 30`（满分仍 100）。无预选时不算。
  - `mustBansDone` 只统计**我方 ban 位**；敌方 ban 掉也算「没拿到」，但不算我们执行。
  - `offPlan` = 我方 picks 里不属于 core/partners 的已知英雄。
  - 无预选 → `{active:false, matchScore:null, notes:[]}`。

### 3.3 `banRecommend` 增量

- 预选激活时，`threats` 里 `level==='must'` 的英雄**强制排在最前**（按模板顺序），即使它们在我方池里（覆盖「我方池内不 ban」规则）；理由前缀「预选必 ban：」并保留模板原因 + 现有池威胁说明（若有）。
- 每个 `commands[]` 增加字段：`preset: true|false`、`mustBan: true|false`、`presetReason: '...'`。
- 预选核心（core）不得出现在 ban 候选（我方要拿）；`shortlist` 也把 must ban 排在最前。
- `level:'watch'` 的威胁不强制占前，只在基础分上 +20 参与排序（不压过 T0），命令带 `presetWatch:true`，理由前缀「预选提防：」。
- 已被 ban / 已选的 must 威胁会跳过并写 warning（顶层 `warnings`，不重复占 ban 位）。
- 返回对象增加：

```js
preset: {
  active: true, id, name,
  mustBans: [{ hero, reason, banned, picked, inOurPool, owners }],
  warnings: []
}
```

- must ban 的 `score` 展示 = 基础 banScore + 60（仅展示排序用）；排序仍以「must 优先」为准。
- 我方 ban 位已满 / 威胁已被 ban 时跳过并写 warning，不重复占位。

### 3.4 `pickRecommend` 增量

- 返回对象增加：

```js
preset: {
  active: true, id, name,
  nextCore: { hero, roleLabel } | null,
  coreStatus: [{ hero, status, owners }],
  warnings: []
}
```

- 候选 `candidates[]` 增加：
  - `preset: { role:'core'|'partner'|'fit'|null, label:'预选核心'|'预选搭配'|'契合方案', note:'...' }`
  - `breakdown.preset`（数值，加入总分；可为 0）
  - `reason` 前缀「预选核心：…」/「预选搭配：…」。
- 加分口径（写在 `breakdown.preset`）：
  - core：`(20 + 2.2×tierWeight) × 阶段系数`（先抢 1.0 / 补强 0.95 / 克制 0.9）；保证 T0 核心先拿、T2 核心也能进前二；
  - 显式 partner：`8 + 4×与已选核心的最高 synergy`；
  - 仅标签契合（`preferTags`，且已有核心被选）：`3 × min(2, 命中标签数)`；
  - 无预选 / 不在方案内：0。
- 自定义核心如果与某套模板 core 完全一致（顺序无关），直接复用该模板的 partners/threats/分工（比纯推导更准）。
- 不影响 v2.2 的分路过滤与 v2.3 的一人一英雄匹配；候选仍必须同时满足两者。
- 预选核心被 ban / 不在池 / 已选完时，`nextCore` 指向下一个可拿核心；全部拿完为 `null`。

### 3.5 导出

- `docs/engine-contract-v2.md` 的 API 列表补充 `presetPlan`、`teamReview`、`presetsFromCombos`（本文件为准）。
- `web/ai.js` 的 `buildBpText` 增加：
  - 「【赛前预选】」段：名称、核心/完成度、必 ban 执行情况；
  - 「【队伍总体评价】」段：双方评分/等级/打法/核心/优势/风险/对位结论/胜负手；只在 `state.review` 有值时输出。
- `buildBpJson` 增加 `preset`、`review` 字段。

---

## 4. UI 契约（`web/app.js` / `web/style.css`）

### 4.1 状态与加载

- `state.presets`（数组）、`state.presetsErr`；`loadAll` 增加 `GET /api/presets`。
- `state.preset`（`{id, core}` 或 null），持久化到现有 sessionStorage（键 `hokbp.v2.bp`，字段 `preset`）。
- `state.presetPlan`、`state.presetErr`、`state.review`、`state.reviewErr`；`recompute()` 调用 `presetPlan` / `teamReview`。
- `buildCtx()` 增加 `presets: state.presets || []`、`preset: state.preset`。

### 4.2 赛前预选（Ban 阶段）

BP 页 Ban 阶段顶部新增 `<section class="panel preset-panel">`（Pick 阶段改为紧凑条）：

- 未选预选时：模板卡片网格 `.preset-card[data-act="usePreset"][data-id]`，每张含 name、subtitle、核心头像、定位、必 ban 英雄；另有「自定义」按钮 `[data-act="openPresetCustom"]`。
- 已选预选时：`.preset-summary`：
  - `.preset-title`（名称 + subtitle + 「换一套」`[data-act="clearPreset"]` + 「自定义」）；
  - `.preset-core` 每个核心一张卡：头像、名字、状态（可拿/已选/被 ban/池里没人会）、谁打；
  - `.preset-bans` 必 ban 列表：英雄、理由、状态；未 ban 且处于 Ban 阶段时带 `[data-act="adoptPresetBan"][data-hero]`「ban 它」；
  - `.preset-partners` 推荐搭配：池内高亮 + 谁打；池外灰显；
  - `.preset-playstyle`：打法 + 胜负条件；
  - `.preset-plan`：队友分工列表；
  - `.preset-progress`：核心 x/y · 必 ban x/y · 搭配 x/y。
- 自定义：复用英雄选择弹窗，`kind:'presetCore'`、`multi:true`、`max:3`；确认后 `state.preset = { id:'custom', core:[...] }`。
- 预选改变后 `persist(); recompute(); renderAll();`，并 toast。

### 4.3 BP 中的提示

- Ban 卡：`cmd.preset` 时加 `.ban-card.preset` 与「预选必 ban」徽标，理由保留。
- 候选卡：`c.preset` 时加 `.preset-tag` 徽标（预选核心/预选搭配/契合方案），并展示 `breakdown.preset`。
- Pick 阶段顶部 `.preset-strip`：名称 + 进度 + 「查看方案」`[data-act="togglePresetPlan"]`（展开复用 `.preset-summary`，只读）；未预选时显示「本局未预选，按强度/克制推荐」。
- 若核心被 ban：顶部醒目提示「预选核心 X 已被 ban，方案自动降级」；若核心不在池：提示补池或换方案。

### 4.4 赛后队伍总体评价（BP 完成）

10 手选完后，在 BP 页 Pick 面板上方渲染 `<section class="panel review-panel">`：

- 标题「队伍总体评价」+ 副标题「BP 结束 · 只基于强度/克制/配合/结构，不预测胜率」。
- `.review-verdict`：对位结论（均势/我方小优/敌方小优）+ 一句话。
- `.review-grid`：两列 `.review-side.ours` / `.review-side.theirs`：
  - 头部：阵营、评分、等级徽标；
  - 核心 + 打法；
  - `.review-dims`：前排/开团/保护/控制/伤害类型（✓/✗ + 数值）；
  - `.review-strengths` / `.review-risks`；
  - `.review-synergies`：关键配合；
  - 五路覆盖。
- `.review-matchup`：对位边（阵容强度/前排/开团/保护/控制/核心强度/克制压力）、敌方关键威胁、胜负手/打法要点。
- `.preset-match`：预选完成度（matchScore、核心、必 ban、偏出方案）。
- 未完成时显示占位提示，不报错。

### 4.5 交互与验收

- 全部按钮 `data-act`，鼠标可点；不要引入键盘必需操作。
- 新增 `DS_KEYS` 不需要额外键（id/hero 已有）。
- 视觉沿用现有深色 + 金色体系；1440px 宽下不横向溢出。
- 空数据/接口失败：显示 notice，不抛异常；`engine` 无新函数时降级隐藏新面板。

---

## 5. 测试契约

### 5.1 `tools/test-engine.mjs`

新增用例（fixture 需加入 `presets`）：

1. `presetPlan` 命中 `jiangwang-boshi`：core=鲁班/盾山，threats must 含墨子/王昭君/钟馗（source=user），watch 含吕布/貂蝉/镜/澜（source=research），owners 正确，progress 正确。
2. 自定义 `{id:'custom',core:['鲁班七号','盾山']}`：能推导出 partners/threats/playstyle，不抛异常。
3. 激活预选时 `banRecommend`：前 3 条 = must ban，且**钟馗即使在我方池里也出现**；`commands[].preset===true`；核心不被 ban。
4. 激活预选时 `pickRecommend`：第 1 手候选前二含核心；候选带 `preset.role` 与 `breakdown.preset`；分路/一人一英雄约束仍成立（复用现有断言）。
5. `teamReview`：10 手完成 → `done:true`，ours/theirs 有 score/grade/dimensions/strengths/risks/combos；`breakdown` 和 ≈ score；敌方占位「空N」被过滤；命中 2 人组合时 `combos[0].complete===true`。
6. 预选匹配：核心 2/2 + must ban 3/3 → `preset.matchScore >= 90`；core 被 ban → 降级并提示。
7. 空 ctx / 无 presets / 无 preset：新增函数返回 `active:false` 且不抛异常。

### 5.2 `tools/smoke.mjs`

- GET `/api/presets` 200 且至少 30 条模板、`jiangwang-boshi` 存在；GET `/api/combos` 200。
- 引擎 `presetPlan` / `teamReview` 在真实 data 上返回对象。

### 5.3 `tools/e2e.mjs`

新增一段（插在进入 Pick 前/后均可，尽量少改动已有断言）：

1. Ban 阶段可见 `.preset-panel`、`.preset-card`；点 `[data-id="jiangwang-boshi"]`。
2. 断言 `.preset-bans` 文本含「墨子」「王昭君」「钟馗」，且 `.preset-core` 含「鲁班七号」「盾山」。
3. 点「全部采用」后，我方 ban 里至少有 3 个 must ban（断文本）。
4. 进入 Pick：候选卡出现 `.preset-tag`（预选核心/预选搭配）与 `.cand-bd` 的「预选」项。
5. 完成 10 手（复用现有流程，敌方用跳过/点卡），断言 `.review-panel` 出现、双方 `.review-side` 各 1 个、`.review-match` 含完成度；截图 `08-review.png`。
6. 页面无脚本异常。

> E2E 跑前会备份 `data/store.json`，跑后还原；需要 `danger-full-access`（Chrome 沙箱限制）。

### 5.4 `tools/validate-data.mjs`

- 按 §1 校验 presets；错误计入现有 errors 汇总。

---

## 6. 文件写入边界（多人协作）

| 范围 | 文件 |
|---|---|
| 引擎/数据/服务 | `web/engine.js`、`data/combos.json`、`data/combo-bans.json`、`server.mjs`、`docs/*` |
| UI | `web/app.js`、`web/style.css`、`web/ai.js` |
| 测试 | `tools/test-engine.mjs`、`tools/smoke.mjs`、`tools/e2e.mjs`、`tools/validate-data.mjs` |

共享文件不要交叉改；需要改别人的文件先发消息协调。最终由 Lead 统一跑验证链并审 diff。
