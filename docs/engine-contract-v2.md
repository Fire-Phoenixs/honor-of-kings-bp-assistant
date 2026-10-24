# 引擎契约 v2.4（2026-10-24 新需求：赛前预选 + 赛后总体评价；v2.3 一人一英雄继续有效）

> **v2.4 增量（2026-10-24 新需求：赛前预选阵容 + 赛后队伍总体评价）**
> 以 `docs/feature-preset-review.md` 为准，本文件只做索引：
> - 组合/克制数据直接复用 AI 调研成果：`data/combos.json`（34 套）+ `data/combo-bans.json`（用户实战必 ban）。
> - 新增 `HOKEngine.presetsFromCombos(combosData, overridesData)`：服务端 `/api/presets` 与测试共用的适配函数。
> - ctx 新增 `presets`（适配后的模板库）与 `preset`（本局选择，`{id}` 或 `{id:'custom',core:[...]}`）。
> - 新增 `HOKEngine.presetPlan(ctx)`（预选方案：核心/必 ban/搭配/分工/进度）与 `HOKEngine.teamReview(ctx)`（双方评分/结构/核心/对位/预选完成度）。
> - `banRecommend` 在预选激活时把 `threats.level==='must'` 强制排前（即使英雄在我方池里），`level==='watch'` 小幅加权；返回 `preset` 摘要。
> - `pickRecommend` 对预选核心/搭配加分（`breakdown.preset`），候选带 `preset.role/label`，返回 `preset` 摘要。
> - 导出（`web/ai.js`）增加预选与总体评价段落。

> **v2.3 相对 v2.2 的变更（UI 与引擎必须同时遵守）**
> 1. **一人只能打一个英雄**：五排虽可换位/帮抢，但最终 5 个人各玩一个。引擎维护我方已选英雄与玩家的**一一匹配**；
>    候选必须能在「已选 + 该候选」上完成完整匹配（同一玩家不能同时打两个英雄），否则过滤掉。
> 2. **Pick 结果返回 `assignment`**：`[{hero, playerIndex, playerName, mastery, masteryLabel}]`，
>    已选列表/候选卡显示「谁去打」，不再是简单的「可打：所有池主」。
> 3. 候选额外返回 `assignedTo`（本次匹配中由谁去打）与 `fielders`（其它可行替换人，供「可换：…」展示）。
>    匹配优先让熟练度高的玩家打（best > normal > basic），再保证能铺满。
>
> 本文件其余部分（store、熟练度、Ban T0 优先、Pick 阶段/分路去重、只按分路筛）沿用 v2.1/v2.2。

---

## 1. store（data/store.json）v2 数据结构

```json
{
  "version": 2,
  "side": "blue",
  "players": [
    {
      "id": "p1",
      "name": "包",
      "floor": 1,
      "preferLanes": ["top"],
      "pool": [
        { "hero": "夏洛特", "mastery": "best" },
        { "hero": "曹操",   "mastery": "normal" }
      ]
    }
  ],
  "allowCrossLane": true,
  "weights": {},
  "history": []
}
```

约束：

- `players` 固定 5 人，`floor` 为 1..5 且**互不重复**（v2.1 起只作内部排序，**不参与 BP 计算，前端不再展示**）。
- **不再有 `lane` 字段**：分路不是身份。`preferLanes` 是 1~2 个倾向分路（`top/jungle/mid/adc/support`），只作为
  ① ban 分配时的先验、② 分路覆盖无解时的兜底提示；**绝不用来过滤英雄池，也不要求五人分路互不相同**。
- `pool[].mastery` ∈ `"best" | "normal" | "basic"`，缺省按 `normal` 处理。
- 兼容迁移：v1 的 `{lane, pool:[string]}` → `preferLanes:[lane]`、`pool:[{hero, mastery:"normal"}]`（`app.js` 与 `server.mjs` 都要能读旧档）。

## 2. 熟练度三档语义（评分核心）

| key | 中文 | 语义（面对同段位对手） | 系数 |
|---|---|---|---|
| `best` | 绝活 | 自认为被 counter 也能反打，胜负手 | `risk 0.45`（被克惩罚打折）、`counterGain 1.0`、`flat +1.5` |
| `normal` | 正常 | 正常发挥 | `risk 1.0`、`counterGain 1.0`、`flat 0` |
| `basic` | 仅会玩 | 只有 counter 对面时才能打出正常表现 | `risk 1.9`（被克惩罚放大）、`counterGain 1.25`、`flat -1.5`（净对位 ≤0 时） |

引擎导出：

```js
HOKEngine.MASTERY = {
  best:  { key:'best',  label:'绝活',  short:'绝', risk:0.45, counterGain:1.0, flat:1.5,  desc:'被克也能打，可盲抢' },
  normal:{ key:'normal',label:'正常',  short:'常', risk:1.0,  counterGain:1.0, flat:0,    desc:'正常发挥' },
  basic: { key:'basic', label:'仅会玩',short:'会', risk:1.9,  counterGain:1.25,flat:-1.5, desc:'需要 counter 对面才有正常表现' }
};
HOKEngine.MASTERY_ORDER = ['best','normal','basic'];
```

## 3. ctx 入参

```js
{
  heroes: [{ id, name, roles:['top',...], alt:[...], type:['坦克',...] }],
  meta:   { tiers:{ [name]:{tier,score,...} }, tags:{ [name]:[tag,...] }, weights:{...} },
  relations: { counters:[{a,b,w,...}], synergies:[{a,b,w,...}] },
  store:  <§1>,
  bans:   { ours:[name|''], theirs:[name|''] },   // 长度可 <5；'' 表示空位
  picks:  { blue:[name], red:[name] },
  assignments: { '英雄名': playerIndex },          // v2.3 可选：手动指定这个英雄由谁玩（硬约束）
  presets: [<preset>],                             // v2.4 可选：预选模板库（服务端由 data/combos.json + combo-bans.json 适配）
  preset: { id:'jiangwang-boshi' } | { id:'custom', core:[name] } | null  // v2.4 可选：本局预选
}
```

## 4. 必须导出的 API

所有函数**不抛异常**（空数据返回 `warnings`），返回对象字段名严格按下面写，UI 直接渲染。

### 4.1 `currentStep(ctx)` → step | null

```js
{ index:0, letter:'B', side:'blue', isOurs:true, floor:1, playerIndex:0,
  label:'蓝方1楼', slotType:'first', slot:{weight,counterCoef,counteredCoef,compNeedCoef} }
```

`playerIndex` = `store.players` 中 `floor` 等于 `step.floor` 的下标（找不到为 -1）。出手顺序仍是 `1-2-2-2-2-1`。
即使当前是敌方手，也返回该楼层对应的我方玩家下标（供 UI 显示「红 3 楼 ↔ 我方 3 楼 杜」这类信息），敌方手 `isOurs=false`。

### 4.2 `banRecommend(ctx)`

```js
{
  date, side,
  commands: [{
    hero, tier, score,
    breakdown: { tier, threat, fragility, worstHero, worstPlayerName, answerable },
    reason: 'T0 强度优先；克你中路池的甄姬（该池 11 个里 7 个被克）',
    alternatives: [{ hero, tier, score }]        // 至多 3 条
  }],                                            // 至多 5 条（v2.2：不再指派执行人）
  shortlist: [{ hero, tier, score, reason }],     // 全局候选前 8
  warnings: [string]
}
```

评分（v2.1，强度主导；权重走 `DEFAULT_WEIGHTS` / `store.weights` / `meta.weights`）：

```
exposure(player) = max_{h∈pool} ( masteryRisk(m_h) × counterOf(X, h) )
                 + 0.2 × (Σ_{h∈pool} masteryRisk(m_h) × counterOf(X, h)) / max(1,pool.length)
threat    = Σ_player exposure(player)            # 0..~11 量级
fragility = mean_player( Σ masteryRisk×counter(X,h) / max(1,pool.length) )
answerable= 1 若我方任一池内英雄 counter(poolHero → X) ≥ 0.45，否则 0
score     = 10.0×tierW(X) + 1.5×threat + 0.8×fragility − 1.0×answerable
```

`tierW` 仍是 `{T0:10, T0.5:8, T1:6, T2:4, T3:2, T4:1}`。因此 T0 ≥ 100，而 T1 即使吃满威胁也 < 80：
**T0 永远排在 T1 前面**（这是二轮反馈的硬要求）。克制/池威胁只在同一 T 度内部决定先后。

v2.2：不再做「第 i 条分给某个玩家」的指派，`commands` 就是全局前 5 个英雄；每人 ban 一个的协调交给队内。

### 4.3 `pickRecommend(ctx)`

```js
{
  step,
  phase: { key:'grab'|'mid'|'counter', label:'先抢'|'补强'|'克制', pickNo:1..5 },
  laneState: { covered:['对抗路','打野'], open:['中路','发育路','游走'] },
  assignment: [{ hero, playerIndex, playerName, mastery, masteryLabel }],  // v2.3：我方已选英雄由谁去打（一人一个）
  freePlayers: [{ playerIndex, name, preferLanes:['打野'] }],              // 还没分到英雄的队友
  candidates: [{
    hero, heroId, tier, mastery, masteryLabel,
    owners: [{ playerIndex, name, mastery, masteryLabel }],   // 池子里所有能打的人
    assignedTo: { playerIndex, name, mastery, masteryLabel }, // v2.3：本次完整匹配里由谁去打
    fielders: [{ playerIndex, name, mastery, masteryLabel }], // 其它可行替换人（同一玩家可打多个则列出）
    ownerIndex, ownerName,
    lanes:['打野','对抗路'], tags:['刺客','位移'],
    score,
    breakdown: { tier, counter, countered, synergy, compNeed, laneNeed, mastery },
    reason: 'T0 强度；由 包（绝活）去打；补发育路'
  }],
  lanePlan: { assignments:[{lane,laneLabel,hero,playerName,floor}], uncovered:['游走'] },
  warnings: [string]
}
```

- **一人一英雄（v2.3 硬要求）**：用我方已选英雄 + 候选做二分图匹配（玩家 ↔ 英雄，边 = 英雄在该玩家池里），
  必须能完整匹配（每个英雄一个人、每个人至多一个英雄）才允许出现；匹配按熟练度加权（best 3 / normal 2 / basic 1）取最优，
  同分时优先让「选择更少的玩家」先定。
- `assignment` 始终返回（敌方手也返回我方当前已选英雄的分配），供 UI 显示「谁去打」；`freePlayers` 是尚未分配英雄的队友。
- 候选必须同时满足 ① v2.2 分路过滤（`heroLanes ∩ open ≠ ∅`）② v2.3 完整匹配可行。
- 若「已选 + 候选」无法完整匹配（例如只剩一个队友、而待补英雄只有别人池里有）→ 过滤该候选；
  若过滤后候选为空，warning 写明「剩余队友（杜/李）没人能打这些待补分路的英雄，建议调整池子或换人」。
- **手动指定（v2.3）**：`ctx.assignments` 是英雄→玩家的硬约束。匹配时先固定这些边（玩家池里必须有该英雄），
  再匹配剩余英雄；指定不可行（池里没有 / 同一玩家被指定两个英雄 / 指定后无法完整匹配）时忽略该条并写 warning。
  `assignment[]` 每项带 `manual:true|false`。UI 的「换人 / 指定谁玩」就是把选择写进 `store` 外的会话态再传进 ctx。

- **候选 = 全队 5 个池子的并集**（去重后「未被 ban、未被选」的英雄），不再只出自当前楼层玩家；
  每个英雄带 `owners`（哪些队友能打、各自熟练度），`mastery` 取 owners 里最高的那档
  （best > normal > basic）。理由：五排可以换位/帮抢，楼层不构成约束。
- **v2.2 分路过重（硬要求）**：先用我方已选英雄跑 `lanePlan` 得到已覆盖分路 C，待补 U = 五路 − C。
  `U` 非空时候选必须满足 `heroLanes(h) ∩ U ≠ ∅`（否则过滤掉，**选了射手就不再推射手**）；
  `U` 为空时不过滤。若某条待补分路在所有候选里都没人能打，写 warning。

- 阶段系数（`ourPickNo = 我方已选数 + 1`，仅我方手有效）：

| ourPickNo | phase | 含义 | tier | counter | countered | synergy | compNeed | laneNeed |
|---|---|---|---|---|---|---|---|---|
| 1-2 | grab | 先抢 T0 / 强势 | **3.0** | 0.25 | 0.5 | 0.7 | 0.4 | 1.0 |
| 3 | mid | 补强 | 2.0 | 1.1 | 1.0 | 1.1 | 1.0 | 1.2 |
| 4-5 | counter | 后两手克制 | **0.5** | **3.0** | 1.0 | 0.9 | 0.9 | 1.0 |

```
tier      = phase.tier × tierW(h)
counterRaw= Σ_enemy counterOf(h,e) × (0.5 + 0.5 × tierW(e)/10)   # 克 T0 收益最高
counter   = 1.1 × phase.counter × mastery.counterGain × counterRaw
countered = -0.9 × phase.countered × mastery.risk × Σ_enemy counterOf(e,h)
synergy   = 1.0 × phase.synergy × Σ_ally synergyOf(h,a)
compNeed  = 1.4 × phase.compNeed × compNeedOf(h, ally)
laneNeed  = 1.4 × phase.laneNeed × laneNeedValue(h)
mastery   = MASTERY[m].flat（basic 仅在净对位 ≤0 时扣）
score     = tier + counter + countered + synergy + compNeed + laneNeed + mastery
```

> 口径校验：先抢阶段 T0 = 30 分，被 3 个敌人克也只扣 1.35 → **强度压倒克制**；
> 后两手 T1 硬克对面 T0 ≈ 3.0 + 3.3 = 6.3，明显高于无克制的 T0（5.0）→ **末两手专门做 counter**；
> 若英雄既是 T0 又有克制（≈8.3）仍然排第一。

`laneNeedValue(h)`：我方已选阵容里还没被覆盖的分路集合 U（五条路，按英雄 `roles+alt` 判定）；`U` 空 → 0；
否则 = h 能打且在 U 中的分路数 / |U|。若某条分路**其他队友的存活池已无人能打**（即本手是最后机会），
该路英雄 `laneNeedValue` 额外 ×1.3 并写一条 warning（实现口径，避免「这手不补就永远补不上」）。

### 4.4 `lineupCheck(ctx)`

```js
{
  checks: [{ key,label,ok,value,need,note }],            // 前排/开团/保护/伤害类型/控制（同 v1）
  lanePlan: { assignments:[{lane,laneLabel,hero,playerName,floor}], uncovered:[label] },
  laneSurvival: [{ lane,laneLabel,poolDepth,owners:[name],atRisk:boolean }],  // 我方池能否覆盖该路
  survival: [{ playerIndex,name,floor,total,alive,ratio,aliveHeroes:[...],
               masteryAlive:{best,normal,basic} }],      // 按玩家（不再按分路）
  gaps: [string]
}
```

### 4.5 `analyzePool(ctx)`（补池建议，**必须去重**）

```js
{
  players: [{ playerIndex,name,floor,preferLanes:['打野'],depth,
              masteryCounts:{best,normal,basic},
              coverage:{front,engage,protect,damage,control},
              laneCover:{top:boolean,...} }],
  suggestions: [{
    hero, heroId, tier, laneFit:['打野','对抗路'],
    forPlayers: [{ playerIndex, name, floor }],   // 合并后的目标玩家
    reasons: ['补前排','T1 强度']
  }],                                             // 全局按 hero 唯一，最多 12 条
  notes: [string],
  warnings: [string]
}
```

去重规则（反馈 #2，硬要求）：

1. 同一 `hero` 全局只出现一次；多个玩家都需要它 → 合并 `forPlayers`，不要产生第二条。
2. hero 已在目标玩家池中 → 不针对该玩家再建议；所有目标玩家都已有 → 整条丢弃。
3. 候选必须不在**任何**玩家池里。
4. 同一玩家同一职责缺口不重复堆同类英雄（每条 suggestion 的 `reasons` 内去重）。

### 4.6 辅助导出

```js
HOKEngine.LANES            // { top:'对抗路', ... }
HOKEngine.LANE_ORDER
HOKEngine.PICK_SEQUENCE    // ['B','R','R','B','B','R','R','B','B','R']
HOKEngine.TIER_WEIGHT
HOKEngine.MASTERY / MASTERY_ORDER
HOKEngine.DEFAULT_WEIGHTS   // v2.1：tier 10 / threat 1.5 / fragility 0.8 / answerable 1.0 / counter 1.1 / countered 0.9 / synergy 1.0 / compNeed 1.4 / laneNeed 1.4
HOKEngine.PICK_PHASES       // v2.1 新增：5 个我方手位对应的阶段系数（见 §4.3 表）
HOKEngine.pickPhase(step, ctx)  // 可选：返回该手的 {key,label,pickNo}
HOKEngine.lanePlan(ctx, heroNames)   // 同 §4.4 lanePlan
HOKEngine.counterOf(ctx,a,b) / synergyOf / compNeedOf / tierOf / tierWeight
HOKEngine.normalizeStore(raw)        // v1→v2 迁移（app.js 也用，避免两套逻辑）
HOKEngine.presetPlan(ctx)            // v2.4：预选方案（核心/必 ban/搭配/分工/进度），见 feature-preset-review.md §3.1
HOKEngine.teamReview(ctx)            // v2.4：赛后队伍总体评价（双方评分/结构/核心/对位/预选匹配），见 §3.2
HOKEngine.presetsFromCombos(combosData, overridesData)  // v2.4：combos.json + combo-bans.json → preset 数组（服务端 /api/presets 用）
```

## 5. 头像与标签（前端资源契约）

- `web/heroicons.js` 由资源脚本生成：`window.HERO_ICON = { "廉颇": "/icons/105.png", ... }`，键为英雄名。
- 缺失头像时 UI 用「名字首字 + 渐变底色」圆角方块兜底，不得留空。
- 英雄分类标签直接取 `heroes.js` 的 `type`（坦克/法师/射手/战士/刺客/辅助）与 `roles+alt`（五路），不新增数据源。

## 6. UI 必须体现的行为（验收口径，v2.2）

1. **设置页**：每个人只有 姓名 / 倾向分路（1-2 个）/ 英雄池，**没有强制分路选择，也不再展示楼层**；池子编辑只按五条分路筛选（**不要职业筛选**），支持三档熟练度并可批量导入。
2. **BP 页**：进入先只显示 **① Ban** 阶段，Pick 面板不渲染；我方 5 ban + 敌方 5 ban（支持空 ban / 未知、**敌方 ban 可一次多选 5 个**）；ban 完成后顶部缩略展示双方 ban 头像，再展开 **② Pick**。Ban 推荐只列英雄与理由，**不写「建议由谁 ban」**。
3. **Pick**：候选来自全队池并集，且**必须能补待补分路 + 能完成一人一英雄匹配**（选了射手后不再出现射手位英雄；不会出现「包一个人打三个英雄」）；每张卡写「**谁打：包（绝活）**」；已选列表写「我方第 N 手 → 包（绝活）」；**点已选英雄卡片或候选卡的「换人」可手动指定由谁玩**（只能选池里有该英雄且当前空闲的队友，可恢复自动）；回合提示用「先抢/补强/克制」；英雄名旁有头像与**分路标签（不要职业标签）**；全程可只用鼠标。
4. **补池建议**：同一英雄不重复出现，多玩家需要时合并展示。
