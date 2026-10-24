# 改动方案：把两套 ban 率接进 ban 排序（v2.5）

> 状态：**方案，未执行**（等确认后落地）
> 目标：让 `data/integration-v1.json` 的 ban 参考值真正影响 ban 排序，同时**不破坏 v2.1「强度主导、T0 必排 T1 前」**。
> 关联数据：`data/integration-v1.json` v2.0（`score.ban` / `kpl.banRate`）、`GET /api/integration`（已存在）

---

## 1. 现状（先看清楚，再动手）

### 1.1 当前 ban 打分（`web/engine.js` `banScoreOf`）

```
score = w.tier × tierW(h)                        // 默认 10 × tierW
      + w.threat × threat                        // 1.5，Σ 全队 exposure（我方池被它克多狠）
      + w.fragility × fragility                  // 0.8，池子平均受伤
      − w.answerable × answerable                // 1.0，我方能否反制（能则 −1）
```

候选过滤：已 ban/已选 → 剔除；预选核心 → 不 ban；**我方池内英雄 → 不 ban**（预选 must 除外）。
排序：`score` 降序；预选 must 单独前置。

### 1.2 为什么不能简单「加分」（关键约束）

- T0 最低 ≈ `10×10 − 1×1 = 99`
- T1 最高 ≈ `10×6 + 1.5×11.4 + 0.8×1.9 ≈ 78.6`
- **余量只有 20.4 分**

而 v2.4 的「AI 调研拆解点」watch 项已经硬加 **+20** → T1 可到 98.6，距 T0 最低只差 **0.4**。

> 结论：**任何在 score 上再加分的方案都会翻转 T0/T1**，除非同时下调 watch。而 watch 是 v2.4 刚定的行为，动它要重验预选场景。

### 1.3 数据通路（引擎在前端跑）

```
app.js  buildCtx() → { heroes, meta, relations, store, bans, picks, assignments, presets, preset }
       → HOKEngine.banRecommend(ctx)
数据来源：api('GET','/api/meta' | '/api/relations' | '/api/integration')
```

`engine.workCtx()` 是**白名单透传**，新数据必须显式加一行。

### 1.4 实测基线（当前 store 池子，2026-10-24）

```
当前 ban 前 6：镜(106.02) > 大乔(105.77) > 关羽(105) > 海月(104.58) > 元辅(104.48) > 裴擒虎(103.27)
             ↑ 全部 T0，彼此分差 0.1~1.2 分（差距极小）
```

这组数据说明：**同档内的先后本来就靠 threat/fragility 的零点几分辨输赢**，所以用 ban 参考值裁决是合理的。

---

## 2. 推荐方案：同档内「裁决」，不加分、不动权重

### 2.1 核心思路

ban 排序从「单一 score 排序」改成**分层比较**：

| 优先级 | 比较键 | 作用 |
|---|---|---|
| 1 | `tierWeight(tier)` 降序 | **硬约束**：任何 T0 恒在任何 T1 前（结构保证，不靠数值余量） |
| 2 | `presetWatch` 优先 | 保持 v2.4：预选拆解点在同档内先出 |
| 3 | `score` 差 > `EPS` → 按 score | 我方池被克更狠的优先（v2.1 贴身逻辑不变） |
| 4 | `score` 差 ≤ `EPS` → 按 `banValue` 降序 | **综合 ban 值裁决**（天元 55% + KPL 45% + 强度 20%） |
| 5 | score、名字 | 稳定排序 |

**裁决键为什么用 `score.ban` 而不是裸 `kpl.banRate`**：实测过裸 KPL 率会把大乔（KPL ban 0%）从第 2 压到第 6，因为职业 159 局确实没人 ban 她；而 `score.ban` 已融合天元 ban 率（大乔 28.67%），裁决结果更稳。

### 2.2 精确改动

#### ① `web/engine.js` — workCtx 透传（约 205 行）

```diff
       presets: isArr(c.presets) ? c.presets : [],
       preset: isObj(c.preset) ? c.preset : null,
+      // v2.5：三方整合参考表（只读；仅用于 ban 同档内裁决，不参与 pick 打分）
+      integration: isObj(c.integration) ? c.integration : null,
```

#### ② `web/engine.js` — 新增索引（放在 `banScoreOf` 之前）

```js
  // v2.5：ban 参考值索引（0~1）。优先用整合表的 score.ban；缺失则退化到 kpl.banRate；都没有 → 0。
  var _banValIdx = null;
  function banValueIndex(ctx) {
    if (_banValIdx && _banValIdx.ref === ctx.integration) return _banValIdx;
    var map = Object.create(null), kpl = Object.create(null);
    var list = (ctx.integration && isArr(ctx.integration.heroes)) ? ctx.integration.heroes : [];
    list.forEach(function (h) {
      if (!h || !h.hero) return;
      var bv = (h.score && typeof h.score.ban === 'number') ? h.score.ban : 0;
      var kb = (h.kpl && typeof h.kpl.banRate === 'number') ? h.kpl.banRate / 100 : 0;
      map[h.hero] = Math.max(0, Math.min(1, bv));
      kpl[h.hero] = Math.max(0, Math.min(1, kb));
    });
    _banValIdx = { ref: ctx.integration, banValue: map, kplBan: kpl };
    return _banValIdx;
  }
  function banValueOf(ctx, hero) {
    var i = banValueIndex(ctx).banValue;
    return typeof i[hero] === 'number' ? i[hero] : 0;
  }
  function kplBanOf(ctx, hero) {
    var i = banValueIndex(ctx).kplBan;
    return typeof i[hero] === 'number' ? i[hero] : 0;
  }
```

#### ③ `web/engine.js` — banScoreOf 带上字段（只加字段，score 不动）

```diff
     var tierTerm = w(ctx, 'tier') * tierW(ctx, xName);
     var score = tierTerm + w(ctx, 'threat') * threat + w(ctx, 'fragility') * fragility - w(ctx, 'answerable') * answerable;
     return {
       hero: xName,
       tier: tierOf(ctx, xName),
       score: round2(score),
+      banValue: banValueOf(ctx, xName),   // 0~1，仅用于排序裁决与文案
+      kplBan: kplBanOf(ctx, xName),       // 0~1，仅用于文案
       tierTerm: round2(tierTerm),
```

#### ④ `web/engine.js` — 比较函数 + 替换两处 sort

```js
  // v2.5：ban 候选排序。tierWeight 是第一键（硬约束），ban 参考值只在同档内接近平手时裁决。
  var BAN_TIE_EPS = 1;   // 同档内 score 差 ≤1 分视为「几乎平手」，用 ban 参考值裁决
  function compareBanCandidates(a, b) {
    var ta = tierWeight(a.tier), tb = tierWeight(b.tier);
    if (ta !== tb) return tb - ta;                                            // 1) 梯度硬约束
    if (!!a.presetWatch !== !!b.presetWatch) return a.presetWatch ? -1 : 1;   // 2) 预选提防
    if (Math.abs(a.score - b.score) > BAN_TIE_EPS) return b.score - a.score;  // 3) 明显差距按 score
    var va = a.banValue || 0, vb = b.banValue || 0;
    if (Math.abs(va - vb) > 1e-9) return vb - va;                             // 4) 接近时按综合 ban 值
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    return a.hero < b.hero ? -1 : (a.hero > b.hero ? 1 : 0);
  }
```

替换 `candidates.sort(...)` 与 `baseCandidates.sort(...)`。must 项不进这个比较（单独前置）。

#### ⑤ `web/engine.js` — banReason 补一句（可选）

```diff
+    var kb = kplBanOf(ctx, c.hero);
+    if (kb >= 0.3) parts.push('职业局被 ban ' + Math.round(kb * 100) + '%');
     parts.push(c.answerable ? ('我方 ' + (c.answerHero || '池里') + ' 能反制，优先级可降') : '我方无人能反制');
```

#### ⑥ `web/app.js` — 加载并注入

```diff
+    integration: null, integrationErr: null,

       presets: Array.isArray(state.presets) ? state.presets : [],
       preset: state.preset || null,
+      integration: state.integration || null,

+      api('GET', '/api/integration').then(function (d) {
+        state.integration = d; state.integrationErr = null;
+      }).catch(function (e) { state.integration = null; state.integrationErr = msgOf(e); }),
```

### 2.3 不需要改的东西（重要）

- ✅ **不加权重键**：不动 `meta.json` weights / `build-meta.mjs` 的 `WEIGHTS` / `validate-data.mjs` 的 `WEIGHT_KEYS`
- ✅ **score 数值不变**：既有断言 `score`/`breakdown` 的用例不受影响
- ✅ **不动 v2.4 预选逻辑**：must/watch 原样
- ✅ **向后兼容**：无 `integration` 时 `banValue` 全 0 → 排序退化为 v2.4

---

## 3. 边界证明 + 实测模拟

### 3.1 边界

`tierWeight` 严格单调（T0=10 > T0.5=8 > T1=6 > T2=4 > T3=2 > T4=1），第一键即它 → **跨档顺序由结构保证**，与 threat/fragility/watch 的数值范围无关。同档内 `score` 差 > EPS 时仍按 score → 「保护我方池」语义保留。

### 3.2 实测模拟（当前池子，eps 敏感性）

| EPS | 排序结果（前 6） |
|---|---|
| 现状 | 镜 > 大乔 > 关羽 > 海月 > 元辅 > 裴擒虎 |
| **1（推荐）** | **海月 > 关羽 > 大乔 > 镜 > 元辅 > 裴擒虎** |
| 2 | 海月 > 关羽 > 大乔 > 镜 > 裴擒虎 > 元辅 |
| 3 | 海月 > 关羽 > 大乔 > 镜 > 裴擒虎 > 元辅 |

各候选的参考值：

| 英雄 | 引擎 score | 综合 ban 值 | KPL ban | 天元 ban |
|---|---|---|---|---|
| 镜 | 106.02 | 0.305 | 28.9% | 0.81% |
| 大乔 | 105.77 | 0.308 | 0% | 28.67% |
| 关羽 | 105.00 | 0.442 | 54.7% | 4.48% |
| 海月 | 104.58 | 0.587 | 55.3% | 26.71% |
| 元辅 | 104.48 | 0.275 | 10.7% | 17.37% |
| 裴擒虎 | 103.27 | 0.286 | 26.4% | 0.37% |

**解读 EPS=1 的效果**：
- 海月（两套 ban 都高）从第 4 → 第 1，符合「双环境威胁」直觉；
- 关羽（KPL 54.7%）从第 3 → 第 2；
- 镜（两套 ban 都低，纯池威胁高）从第 1 → 第 4；
- 大乔只从第 2 → 第 3，没有被裸 KPL 率误伤（这正是选 `score.ban` 而非 `kpl.banRate` 的原因）。

> 若想更激进（让 ban 参考值影响更多），把 `BAN_TIE_EPS` 调到 3 —— 改动一行、仍是零翻转风险。

---

## 4. 测试计划

### 4.1 新增断言（`tools/test-engine.mjs`，+3 项）

1. **无 integration 回归**：ctx 不带 integration → ban 顺序与 v2.4 基线完全一致。
2. **同档裁决生效**：构造两个 T0、score 差 <1、banValue 一高一低 → 高者在前。
3. **跨档不翻转**：A=T1 且 banValue=1、B=T0 且 banValue=0 → B 仍在前。

### 4.2 既有测试影响

| 测试 | 预计影响 |
|---|---|
| `validate-data` | 无（建议顺手加 integration 结构校验） |
| `test-engine` 45 项 | 若有硬断言「ban 第 1 位是某英雄」，可能变（本方案会改同档次序）；结构类断言不受影响 |
| `smoke` 55 项 | 无（不校验 ban 排序内容） |
| `e2e` 79 项 | 若 UI 断言 ban 列表具体英雄，可能变；需跑一遍确认 |

### 4.3 执行顺序

```
node tools/test-engine.mjs      # 45 → 48
node tools/smoke.mjs            # 55
node tools/validate-data.mjs    # 0 错
node tools/e2e.mjs              # 79（需 full-access）
```

---

## 5. 备选与取舍

| 方案 | 做法 | 风险 |
|---|---|---|
| **B（推荐）** | 同档内分层比较，`score.ban` 裁决 | 零翻转风险；影响面受 EPS 控制 |
| A | `score += w.banRef × banValue` 加分法 | 必须同步 4 处权重文件，且要把 watch 从 +20 降到 ≤6，否则 T1 翻转 |
| C | 裸 `kpl.banRate` 裁决 | 实测会把大乔（KPL 0%）从第 2 压到第 6，不推荐 |

先上 B（EPS=1）；用起来若觉得 KPL 影响太弱，只调 `BAN_TIE_EPS` 一个常量即可，不需要回到 A。

---

## 6. 回滚

全部是追加式改动（engine 4 处 + app 1 处）：
- 删掉 `compareBanCandidates` → 退回 score 排序（即 v2.4）；
- 或前端不注入 `integration` → `banValue` 全 0，排序自动退化。

不改数据文件，回滚 ≈ 一次 revert。

---

## 7. 待确认

1. `BAN_TIE_EPS` 用 **1**（保守，只调相邻两三位）还是 **3**（更积极）？
2. 是否要在 ban 理由里显示「职业局被 ban X%」这一句？（我建议显示，不新增 UI 列）
3. 落地时是否顺带把 `validate-data` 加上 integration 结构校验？
