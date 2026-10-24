/*!
 * HOK BP Engine v2.1 — 王者荣耀五排 BP 决策引擎（纯函数，浏览器 + node 共用）
 * 契约见 docs/engine-contract-v2.md（v2.1 二轮反馈；返回字段名/结构严格照 §4，UI 直接渲染）
 *
 * v2 相对 v1 的破坏性变更（一轮反馈）：
 *   1. 取消「每人绑定一条分路」：玩家只有 preferLanes（倾向分路）与三档熟练度英雄池；
 *      BP 计算只关心「队伍最终覆盖五条分路」（按英雄 roles+alt 判路，见 lanePlan）。
 *   2. Pick 候选带归属人（ownerIndex/ownerName/owners），并清晰标注谁选的。
 *   3. 英雄池三档熟练度（best/normal/basic）真实进入 ban 威胁与 pick 评分（系数 §2）。
 *   4. 补池建议 analyzePool 全局按 hero 去重、合并 forPlayers。
 *
 * v2.1 二轮反馈变更：
 *   1. Ban 强度主导：DEFAULT_WEIGHTS.tier=10 / threat=1.5 / fragility=0.8，任何 T0 必排任何 T1 前，
 *      克制只在同 T 度内排序（见 §4.2 与 banScoreOf 的边界注释）。
 *   2. Pick 分阶段：我方第 1-2 手「先抢」只看强度、第 3 手「补强」、第 4-5 手「克制」（见 PICK_PHASES）。
 *   3. 取消楼层约束：候选 = 全队 5 个池的并集，每张候选带 owners（谁都能打 + 熟练度）。
 *
 * v2.2 三轮反馈变更：
 *   1. Pick 按分路去重：先用我方已选跑 lanePlan 得到 laneState.covered/open，open 非空时候选必须
 *      能补至少一条待补分路（选了射手后纯 adc 英雄不再出现），并返回 laneState 供 UI 显示。
 *   2. Ban 不再指派「谁去 ban」：commands 只保留 hero/tier/score/breakdown/reason/alternatives，
 *      理由里也不再出现执行人/楼层。
 *
 * v2.3 四轮反馈变更（一人一英雄 + 手动指定）：
 *   1. assignHeroes：我方已选英雄与 5 个玩家做二分图完整匹配（一人只能打一个英雄），
 *      按熟练度加权取最优（best 3 / normal 2 / basic 1）；pick 返回 assignment / freePlayers。
 *   2. 候选额外要求「已选 + 候选」能完整匹配，并返回 assignedTo（本次由谁打）/ fielders（可换的人）；
 *      理由改成「由 xxx（绝活）去打」。
 *   3. ctx.assignments（{英雄: playerIndex}）作为硬约束：不可行/重复指派会被忽略并 warning，
 *      指定后无法完整匹配则整体回退自动分配并 warning；assignment 每项带 manual 标记。
 *
 * 代码风格：ES5（var/function，无箭头函数/const/let/模板串），浏览器可 <script> 直接加载。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HOKEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================= 常量 ================= */

  var VERSION = '2.4';

  var LANES = { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' };
  var LANE_ORDER = ['top', 'jungle', 'mid', 'adc', 'support'];

  // 蓝1 红1 红2 蓝2 蓝3 红3 红4 蓝4 蓝5 红5
  var PICK_SEQUENCE = ['B', 'R', 'R', 'B', 'B', 'R', 'R', 'B', 'B', 'R'];

  var TIER_WEIGHT = { T0: 10, 'T0.5': 8, T1: 6, T2: 4, T3: 2, T4: 1 };

  var TAG_SET = ['前排', '开团', '保护', '控制', '硬控', '免控', '回复', '护盾', '真伤', '爆发',
    '持续输出', '收割', '位移', '远程', '近战', '法伤', '物伤', '体系'];

  // 契约 §2：三档熟练度系数（引擎只读这里，不在别处硬编码）
  // v2.5：绝活/仅会玩的分差拉大（1.5→3.0）——「高梯度但不会玩」不该无脑抢，
  //       「低梯度绝活」应有机会靠熟练度顶上半个梯度档。
  var MASTERY = {
    best: { key: 'best', label: '绝活', short: '绝', risk: 0.45, counterGain: 1.0, flat: 3.0, desc: '被克也能打，可盲抢' },
    normal: { key: 'normal', label: '正常', short: '常', risk: 1.0, counterGain: 1.0, flat: 0, desc: '正常发挥' },
    basic: { key: 'basic', label: '仅会玩', short: '会', risk: 1.9, counterGain: 1.25, flat: -3.0, desc: '需要 counter 对面才有正常表现' }
  };
  var MASTERY_ORDER = ['best', 'normal', 'basic'];

  // 默认权重 v2.1（可被 meta.weights / store.weights 覆盖；§4.2/§4.3 的公式系数即这里的默认值）
  // 强度主导：tier 权重 10，威胁/脆弱性只小幅加分 —— 保证「任何 T0 的 banScore > 任何 T1」。
  var DEFAULT_WEIGHTS = {
    tier: 10.0, threat: 1.5, fragility: 0.8, answerable: 1.0,
    counter: 1.1, countered: 0.9, synergy: 1.0, compNeed: 1.4, laneNeed: 1.4
  };

  // 每个顺位的定位（对应真实 BP 槽位，v1 沿用）
  var SLOT_DEF = [
    { slotType: 'first', weight: 0.35, counterCoef: 1.3, counteredCoef: 1.3, compNeedCoef: 0.5 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 0.5 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 0.5 },
    { slotType: 'middle', weight: 0.15, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'middle', weight: 0.15, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'middle', weight: 0.10, counterCoef: 1.0, counteredCoef: 1.0, compNeedCoef: 1.2 },
    { slotType: 'late', weight: 0.0, counterCoef: 1.6, counteredCoef: 1.0, compNeedCoef: 1.0 }
  ];

  // v2.1 阶段系数（§4.3）：我方第 1-2 手先抢（强度压倒克制）、第 3 手补强、第 4-5 手克制。
  // pickNo = 我方第几手（1..5，敌手不改变我方手数）；hint 供 UI 直接展示。
  var PICK_PHASES = [
    { pickNo: 1, key: 'grab', label: '先抢', hint: '优先强势，但被针对/不会玩就要让位', tier: 2.4, counter: 0.4, countered: 0.7, synergy: 0.8, compNeed: 0.5, laneNeed: 1.0, combo: 1.0 },
    { pickNo: 2, key: 'grab', label: '先抢', hint: '优先强势，但被针对/不会玩就要让位', tier: 2.4, counter: 0.4, countered: 0.7, synergy: 0.8, compNeed: 0.5, laneNeed: 1.0, combo: 1.0 },
    { pickNo: 3, key: 'mid', label: '补强', hint: '兼顾强度、阵容与组合', tier: 1.8, counter: 1.1, countered: 1.0, synergy: 1.1, compNeed: 1.0, laneNeed: 1.2, combo: 1.0 },
    { pickNo: 4, key: 'counter', label: '克制', hint: '专门 counter 对面核心（克 T0 收益最高）', tier: 0.5, counter: 3.0, countered: 1.0, synergy: 0.9, compNeed: 0.9, laneNeed: 1.0, combo: 0.8 },
    { pickNo: 5, key: 'counter', label: '克制', hint: '专门 counter 对面核心（克 T0 收益最高）', tier: 0.5, counter: 3.0, countered: 1.0, synergy: 0.9, compNeed: 0.9, laneNeed: 1.0, combo: 0.8 }
  ];

  // 阶段查表：pickNo 1..5 正常；>5（我方已选完）取克制阶段的系数，但 pickNo 返回 null（UI 据此隐藏徽标）
  function phaseDefFor(pickNo) {
    var n = pickNo;
    return PICK_PHASES[(n >= 1 && n <= 5) ? (n - 1) : (n > 5 ? 4 : 0)];
  }

  function phaseForPickNo(pickNo) {
    var n = pickNo;
    var def = phaseDefFor(n);
    return {
      key: def.key,
      label: def.label,
      hint: def.hint,
      pickNo: (n >= 1 && n <= 5) ? n : null
    };
  }

  function ourPicksCount(ctx) { return picksOf(ctx, ctx.store.side).length; }

  // 导出用：pickPhase(step, ctx) -> {key,label,hint,pickNo}。
  // 我方手数只看 ctx.picks 里我方（store.side）已选数量，step 仅作签名兼容；
  // 我方 5 手已满时 pickNo=null（系数仍按克制阶段，便于 UI 复用同一张表）。
  function pickPhase(step, ctx) {
    try {
      var c = ctx;
      // 容错：UI 可能只传 ctx（pickPhase(ctx)），此时第一个参数就是 ctx
      if (!c && step && step.store) c = step;
      var work = workCtx(c);
      return phaseForPickNo(ourPicksCount(work) + 1);
    } catch (err) {
      return phaseForPickNo(1);
    }
  }

  // 阵容体检五项（标签口径同 v1）
  var CHECKS = [
    { key: 'front', label: '前排', tag: '前排', need: 1 },
    { key: 'engage', label: '开团', tag: '开团', need: 1 },
    { key: 'protect', label: '保护', tag: '保护', need: 1 },
    { key: 'damage', label: '伤害类型', need: 'both' },
    { key: 'control', label: '控制', tag: '控制', need: 2 }
  ];
  var COVER_KEYS = ['front', 'engage', 'protect', 'damage', 'control'];
  var COVER_LABEL = { front: '前排', engage: '开团', protect: '保护', damage: '伤害类型', control: '控制' };

  /* ================= 小工具 ================= */

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return !!v && typeof v === 'object' && !isArr(v); }

  function trimStr(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/^\s+|\s+$/g, '');
  }

  // 名字数组容错：保留位置（'' 表示空位），非字符串转字符串
  function copyNames(v) {
    var out = [];
    if (!isArr(v)) return out;
    for (var i = 0; i < v.length; i++) {
      out.push(v[i] === null || v[i] === undefined ? '' : trimStr(v[i]));
    }
    return out;
  }

  function filterNames(v) {
    var out = [];
    (isArr(v) ? v : []).forEach(function (n) {
      var s = trimStr(n);
      if (s) out.push(s);
    });
    return out;
  }

  function round2(x) {
    var n = Number(x);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function copyObj(o) {
    var out = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k]; }
    return out;
  }

  function validLane(k) { return typeof k === 'string' && !!LANES[k]; }

  function laneLabels(keys) {
    var out = [];
    (isArr(keys) ? keys : []).forEach(function (k) {
      if (validLane(k) && out.indexOf(LANES[k]) === -1) out.push(LANES[k]);
    });
    return out;
  }

  function masteryOf(key) { return MASTERY[key] || MASTERY.normal; }

  // 权重读取：DEFAULT_WEIGHTS < meta.weights < store.weights（v1 机制保留）
  function w(ctx, key) {
    var base = DEFAULT_WEIGHTS[key];
    var ov = (ctx && ctx.meta && ctx.meta.weights) || {};
    var st = (ctx && ctx.store && ctx.store.weights) || {};
    if (typeof ov[key] === 'number') base = ov[key];
    if (typeof st[key] === 'number') base = st[key];
    return base;
  }

  /* ================= ctx 规整 ================= */

  // 所有公开函数入口都先过 workCtx：英雄表/关系表/阵营/禁选容错，store 强制 v2
  function workCtx(ctx) {
    var c = isObj(ctx) ? ctx : {};
    var bans = isObj(c.bans) ? c.bans : {};
    var picks = isObj(c.picks) ? c.picks : {};
    var heroes = [];
    (isArr(c.heroes) ? c.heroes : []).forEach(function (h) {
      if (isObj(h) && trimStr(h.name)) heroes.push(h);
    });
    return {
      heroes: heroes,
      meta: isObj(c.meta) ? c.meta : {},
      relations: isObj(c.relations) ? c.relations : {},
      store: normalizeStore(c.store),
      // v2.3：UI 手动指定的「英雄 → playerIndex」（可选，没有则空对象）
      assignments: isObj(c.assignments) ? copyObj(c.assignments) : {},
      // v2.4：预选阵容（模板库 + 本局选择）；原样透传，不改 store 结构
      presets: isArr(c.presets) ? c.presets : [],
      preset: isObj(c.preset) ? c.preset : null,
      // v2.5：组合原始数据（无预选时的通用组合加成用；只读）
      combos: (isArr(c.combos) ? c.combos : (isObj(c.combos) && isArr(c.combos.comps) ? c.combos.comps : [])),
      bans: { ours: copyNames(bans.ours), theirs: copyNames(bans.theirs) },
      picks: { blue: copyNames(picks.blue), red: copyNames(picks.red) }
    };
  }

  function heroMap(ctx) {
    var m = Object.create(null);
    (ctx && ctx.heroes ? ctx.heroes : []).forEach(function (h) { m[h.name] = h; });
    return m;
  }

  function heroOf(ctx, name) {
    var list = (ctx && ctx.heroes) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === name) return list[i];
    }
    return null;
  }

  function heroIdOf(ctx, name) {
    var h = heroOf(ctx, name);
    return h && h.id !== undefined ? h.id : null;
  }

  function tierOf(ctx, name) {
    var t = ctx && ctx.meta && ctx.meta.tiers && ctx.meta.tiers[name];
    if (!t) return 'T2';
    return typeof t === 'string' ? t : (t.tier || 'T2');
  }

  function tierWeight(t) {
    var tw = TIER_WEIGHT[t];
    return typeof tw === 'number' ? tw : TIER_WEIGHT.T2;
  }

  function tierW(ctx, name) { return tierWeight(tierOf(ctx, name)); }

  function tagsOf(ctx, name) {
    var t = (ctx && ctx.meta && ctx.meta.tags && ctx.meta.tags[name]) || [];
    return isArr(t) ? t : [];
  }

  function hasTag(ctx, name, tag) { return tagsOf(ctx, name).indexOf(tag) !== -1; }

  /* ================= 分路判定（roles + alt，反馈 #1 核心） ================= */

  // 英雄能打的分路 keys：roles 为主分路，alt 为次分路；去重保序
  function lanesOfHero(ctx, name) {
    var h = heroOf(ctx, name);
    if (!h) return [];
    var out = [];
    var push = function (k, arr) {
      (isArr(arr) ? arr : []).forEach(function (x) {
        if (validLane(x) && out.indexOf(x) === -1) out.push(x);
      });
    };
    push('roles', h.roles);
    push('alt', h.alt);
    return out;
  }

  function primaryLanesOfHero(ctx, name) {
    var h = heroOf(ctx, name);
    if (!h) return [];
    var out = [];
    (isArr(h.roles) ? h.roles : []).forEach(function (x) {
      if (validLane(x) && out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  function heroCanPlay(ctx, name, lane) {
    return lanesOfHero(ctx, name).indexOf(lane) !== -1;
  }

  // 取某英雄的一个代表分路（用于 ban 提示/文案）
  function laneKeyOfHero(ctx, name, fallback) {
    var p = primaryLanesOfHero(ctx, name);
    if (p.length) return p[0];
    var a = lanesOfHero(ctx, name);
    if (a.length) return a[0];
    if (isArr(fallback) && fallback.length && validLane(fallback[0])) return fallback[0];
    return null;
  }

  /* ================= 阵营 / 禁选 ================= */

  function ourLetter(ctx) { return ctx.store.side === 'red' ? 'R' : 'B'; }
  function otherSide(side) { return side === 'red' ? 'blue' : 'red'; }
  function picksOf(ctx, side) { return (ctx.picks && ctx.picks[side]) || []; }

  // 已 ban / 已选集合（英雄名）；'' 空位与非字符串一律忽略
  function usedSet(ctx) {
    var s = Object.create(null);
    var ban = (ctx && ctx.bans) || {};
    var pick = (ctx && ctx.picks) || {};
    var mark = function (list, kind) {
      filterNames(isArr(list) ? list : []).forEach(function (n) { s[n] = kind; });
    };
    mark(ban.ours, 'ban');
    mark(ban.theirs, 'ban');
    mark(pick.blue, 'pick');
    mark(pick.red, 'pick');
    return s;
  }

  function ourPoolSet(ctx) {
    var s = Object.create(null);
    ctx.store.players.forEach(function (p) {
      p.pool.forEach(function (e) { s[e.hero] = 1; });
    });
    return s;
  }

  /* ================= 克制 / 配合关系 ================= */

  function relationIndex(ctx) {
    var idx = { c: Object.create(null), s: Object.create(null) };
    var rel = (ctx && ctx.relations) || {};
    var counters = isArr(rel.counters) ? rel.counters : [];
    var synergies = isArr(rel.synergies) ? rel.synergies : [];
    counters.forEach(function (r) {
      if (!r || !r.a || !r.b) return;
      idx.c[r.a + '>' + r.b] = r;
    });
    synergies.forEach(function (r) {
      if (!r || !r.a || !r.b) return;
      var k1 = r.a + '|' + r.b;
      var k2 = r.b + '|' + r.a;
      if (!idx.s[k1] || (idx.s[k1].w || 0) < (r.w || 0)) { idx.s[k1] = r; idx.s[k2] = r; }
    });
    return idx;
  }

  // 标签启发（契约 v1 6.5 沿用）：只在显式表未覆盖时使用，0 表示没有
  function heuristicCounter(ctx, a, b) {
    var ta = tagsOf(ctx, a);
    var tb = tagsOf(ctx, b);
    var T = function (arr, x) { return arr.indexOf(x) !== -1; };
    var best = 0;
    if (T(ta, '硬控') && T(tb, '位移') && !T(tb, '免控')) best = Math.max(best, 0.6);
    if (T(ta, '真伤') && (T(tb, '护盾') || T(tb, '前排'))) best = Math.max(best, 0.5);
    if (T(ta, '护盾') && T(tb, '远程')) best = Math.max(best, 0.6);
    if (T(ta, '免控') && T(tb, '硬控')) best = Math.max(best, 0.5);
    if (T(ta, '远程') && (T(ta, '持续输出') || T(ta, '爆发') || T(ta, '收割')) && T(tb, '前排') && !T(tb, '位移')) best = Math.max(best, 0.4);
    return Math.min(best, 0.7);
  }

  // counter(a -> b)：a 克 b 的强度 0..1（显式优先，不叠加启发）
  function counterAt(idx, ctx, a, b) {
    if (!a || !b || a === b) return 0;
    var r = idx.c[a + '>' + b];
    if (r) return Math.max(0.3, Math.min(1, Number(r.w) || 0.6));
    return heuristicCounter(ctx, a, b);
  }

  function synergyAt(idx, ctx, a, b) {
    if (!a || !b || a === b) return 0;
    var r = idx.s[a + '|' + b];
    if (r) return Math.max(0.2, Math.min(1, Number(r.w) || 0.5));
    var ta = tagsOf(ctx, a);
    var tb = tagsOf(ctx, b);
    var T = function (arr, x) { return arr.indexOf(x) !== -1; };
    var both = function (x, y) { return (T(ta, x) && T(tb, y)) || (T(tb, x) && T(ta, y)); };
    if (both('前排', '持续输出')) return 0.4;
    if (both('开团', '爆发')) return 0.5;
    if (both('保护', '持续输出')) return 0.6;
    return 0;
  }

  /* ================= store v2 + v1→v2 迁移 ================= */

  function toFloor(v) {
    var n = parseInt(v, 10);
    return (n >= 1 && n <= 5) ? n : 0;
  }

  function preferLanesOf(p) {
    var out = [];
    var push = function (x) {
      if (validLane(x) && out.indexOf(x) === -1 && out.length < 2) out.push(x);
    };
    if (isArr(p.preferLanes)) p.preferLanes.forEach(push);
    else if (typeof p.preferLanes === 'string') push(p.preferLanes);
    // v1 迁移：旧档的 lane 字段 → preferLanes
    if (!out.length && validLane(p.lane)) out.push(p.lane);
    return out;
  }

  // 英雄池条目容错：支持 v1 的字符串、v2 对象；同一玩家内按 hero 去重（保留首次出现的熟练度）
  function normalizePool(pool) {
    var out = [];
    var seen = Object.create(null);
    (isArr(pool) ? pool : []).forEach(function (e) {
      var name = '';
      var mk = '';
      if (typeof e === 'string') {
        name = e;
      } else if (isObj(e)) {
        name = e.hero !== undefined && e.hero !== null ? e.hero : (e.name !== undefined ? e.name : '');
        mk = e.mastery;
      }
      name = trimStr(name);
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({ hero: name, mastery: MASTERY[mk] ? mk : 'normal' });
    });
    return out;
  }

  function normalizePlayer(raw, i) {
    var p = isObj(raw) ? raw : {};
    var name = trimStr(p.name);
    var id = p.id;
    return {
      id: (id !== undefined && id !== null && trimStr(id) !== '') ? trimStr(id) : ('p' + (i + 1)),
      name: name || ('玩家' + (i + 1)),
      floor: toFloor(p.floor),
      preferLanes: preferLanesOf(p),
      pool: normalizePool(p.pool)
    };
  }

  /**
   * normalizeStore(raw) -> store v2（纯函数，不修改入参）
   *  - v1 {lane, pool:[string]} → {preferLanes:[lane], pool:[{hero, mastery:'normal'}]}
   *  - 容错：players 不足 5 人补齐；超过 5 人截断；floor 重复/越界修正为 1..5 唯一；
   *          preferLanes 去重且最多 2 条；pool 条目去重、非法 mastery 归 normal。
   *  - 保持 players 的数组顺序（playerIndex 与 UI 的行顺序一致），只修 floor。
   */
  function normalizeStore(raw) {
    var src = isObj(raw) ? raw : {};
    var list = [];
    var rawPlayers = isArr(src.players) ? src.players : [];
    var i;
    for (i = 0; i < rawPlayers.length && list.length < 5; i++) {
      if (isObj(rawPlayers[i])) list.push(normalizePlayer(rawPlayers[i], list.length));
    }

    // floor 修正：先保留合法且不重复的，再把剩余玩家填到空楼层
    var taken = Object.create(null);
    var k;
    for (i = 0; i < list.length; i++) {
      var f = toFloor(list[i].floor);
      if (f && !taken[f]) {
        taken[f] = 1;
        list[i].floor = f;
      } else {
        list[i].floor = 0;
      }
    }
    for (i = 0; i < list.length; i++) {
      if (list[i].floor) continue;
      for (k = 1; k <= 5; k++) {
        if (!taken[k]) {
          taken[k] = 1;
          list[i].floor = k;
          break;
        }
      }
    }

    // 不足 5 人：补空玩家（楼层取剩余空位）
    var next = 1;
    while (list.length < 5) {
      while (next <= 5 && taken[next]) next++;
      if (next > 5) next = list.length + 1;
      taken[next] = 1;
      list.push({
        id: 'p' + (list.length + 1),
        name: '玩家' + (list.length + 1),
        floor: next,
        preferLanes: [],
        pool: []
      });
    }

    return {
      version: 2,
      side: src.side === 'red' ? 'red' : 'blue',
      players: list,
      allowCrossLane: typeof src.allowCrossLane === 'boolean' ? src.allowCrossLane : true,
      weights: isObj(src.weights) ? copyObj(src.weights) : {},
      history: isArr(src.history) ? src.history.slice() : []
    };
  }

  /* ================= 五条分路覆盖（lanePlan） ================= */

  // 谁在某玩家池里（按 players 顺序取第一个），用于 lanePlan 的归属展示
  function ownerOfHero(ctx, heroName) {
    var ps = ctx.store.players;
    for (var i = 0; i < ps.length; i++) {
      var pool = ps[i].pool;
      for (var j = 0; j < pool.length; j++) {
        if (pool[j].hero === heroName) {
          return { playerIndex: i, name: ps[i].name, floor: ps[i].floor };
        }
      }
    }
    return null;
  }

  /* ================= 一人一英雄：英雄↔玩家二分图完整匹配（v2.3） ================= */

  var MASTERY_SCORE = { best: 3, normal: 2, basic: 1 };

  function uniqueNames(list) {
    var out = [];
    (isArr(list) ? list : []).forEach(function (n) {
      var s = trimStr(n);
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  function poolEntryOf(player, heroName) {
    if (!player) return null;
    for (var i = 0; i < player.pool.length; i++) {
      if (player.pool[i].hero === heroName) return player.pool[i];
    }
    return null;
  }

  /**
   * 解析手动指定：只对 heroNames 里的英雄生效，返回 { heroIndex: playerIndex }。
   * 容错：玩家池里没有该英雄 / 同一玩家被指定两个英雄（保留先出现的那条）→ 忽略并 warning。
   */
  function manualFixesOf(ctx, heroes, assignments, warn) {
    var fixes = Object.create(null);
    var usedPlayer = Object.create(null);
    var spec = isObj(assignments) ? assignments : {};
    for (var hi = 0; hi < heroes.length; hi++) {
      var h = heroes[hi];
      if (!Object.prototype.hasOwnProperty.call(spec, h)) continue;
      var raw = spec[h];
      var pi = parseInt(raw, 10);
      var player = (pi >= 0 && pi < ctx.store.players.length) ? ctx.store.players[pi] : null;
      if (!player || !poolEntryOf(player, h)) {
        if (warn) {
          warn('指定 ' + h + '→' + (player ? player.name : String(raw)) +
            ' 不可行（' + (player ? player.name : '该玩家') + '池里没有' + h + '），已自动分配');
        }
        continue;
      }
      if (usedPlayer[pi]) {
        if (warn) {
          warn('指定 ' + h + '→' + player.name + ' 被忽略（' + player.name +
            '已被指定打 ' + usedPlayer[pi] + '），已自动分配');
        }
        continue;
      }
      usedPlayer[pi] = h;
      fixes[hi] = pi;
    }
    return fixes;
  }

  /**
   * 完整匹配枚举（带上手动固定边）：英雄 ↔ 玩家，边 = 英雄在该玩家池里；
   * 每人至多一个英雄、每个英雄必须有人。取熟练度总分最高（best 3 / normal 2 / basic 1）；
   * 同分时按「可选玩家更少的英雄先定」的确定性 DFS 顺序，第一个最优解即 assignment。
   * 不可完整匹配 → null。
   */
  function matchHeroesAll(ctx, heroes, fixes) {
    var players = ctx.store.players;
    if (heroes.length > players.length || heroes.length > 5) return null;
    var options = [];
    for (var i = 0; i < heroes.length; i++) {
      var h = heroes[i];
      var list = [];
      var fixedPlayer = fixes[i];
      for (var pi = 0; pi < players.length; pi++) {
        if (fixedPlayer !== undefined && fixedPlayer !== pi) continue;
        var entry = poolEntryOf(players[pi], h);
        if (!entry) continue;
        var m = masteryOf(entry.mastery);
        list.push({
          hero: h,
          playerIndex: pi,
          playerName: players[pi].name,
          floor: players[pi].floor,
          mastery: m.key,
          masteryLabel: m.label,
          score: MASTERY_SCORE[m.key] || 1
        });
      }
      if (!list.length) return null;
      options.push(list);
    }

    // 变量顺序：候选玩家更少的英雄先定（MRV）；同数按输入顺序 → 每次结果一致
    var order = [];
    for (i = 0; i < heroes.length; i++) order.push(i);
    order.sort(function (a, b) {
      if (options[a].length !== options[b].length) return options[a].length - options[b].length;
      return a - b;
    });

    var bestScore = -1;
    var bests = [];
    var used = Object.create(null);
    var cur = new Array(heroes.length);
    function dfs(pos, score) {
      if (pos >= order.length) {
        if (score > bestScore) {
          bestScore = score;
          bests = [cur.slice()];
        } else if (score === bestScore && bests.length < 200) {
          bests.push(cur.slice());
        }
        return;
      }
      var hi = order[pos];
      var list = options[hi];
      for (var j = 0; j < list.length; j++) {
        var o = list[j];
        if (used[o.playerIndex]) continue;
        used[o.playerIndex] = 1;
        cur[hi] = o;
        dfs(pos + 1, score + o.score);
        used[o.playerIndex] = 0;
        cur[hi] = null;
      }
    }
    dfs(0, 0);
    if (bestScore < 0) return null;
    return { score: bestScore, matchings: bests };
  }

  function entryOut(e, manual) {
    return {
      playerIndex: e.playerIndex,
      name: e.playerName,
      mastery: e.mastery,
      masteryLabel: e.masteryLabel,
      manual: !!manual
    };
  }

  function assignmentOut(matching, fixes) {
    return matching.map(function (e, hi) {
      return {
        hero: e.hero,
        playerIndex: e.playerIndex,
        playerName: e.playerName,
        mastery: e.mastery,
        masteryLabel: e.masteryLabel,
        manual: fixes[hi] === e.playerIndex
      };
    });
  }

  // 带手动指定 + 自动回退的匹配入口；返回 { heroes, matchings, fixes } 或 null
  //   strict=true：手动指定视为硬约束，无法完整匹配直接返回 null（候选级可行性检查用，不写 warning）
  //   strict=false：无法完整匹配时作废指定、回退自动匹配（并写一条 warning，只在基础分配时用）
  function assignHeroesSmart(ctx, heroNames, assignments, warn, strict) {
    var heroes = uniqueNames(heroNames);
    if (heroes.length > 5) return null;
    if (heroes.length > ctx.store.players.length) return null;
    if (!heroes.length) return { heroes: heroes, matchings: [[]], fixes: Object.create(null) };

    var fixes = manualFixesOf(ctx, heroes, assignments, strict ? null : warn);
    var all = matchHeroesAll(ctx, heroes, fixes);
    if (!all && Object.keys(fixes).length) {
      if (strict) return null;   // 候选级：手动指定与这个候选冲突 → 直接过滤，不串扰 warning
      // 指定后无法完整匹配 → 指定作废、回退自动匹配（基础分配时只报一次）
      if (warn) warn('手动指定无法构成完整匹配，已回退自动分配');
      fixes = Object.create(null);
      all = matchHeroesAll(ctx, heroes, fixes);
    }
    if (!all) return null;
    return { heroes: heroes, matchings: all.matchings, fixes: fixes };
  }

  // 私有：我方已选英雄的分配（含 manual 标记）；不可行 → null
  function assignHeroes(ctx, heroNames, assignments, warn) {
    var r = assignHeroesSmart(ctx, heroNames, assignments, warn);
    if (!r) return null;
    return assignmentOut(r.matchings[0], r.fixes);
  }

  function freePlayersOf(ctx, assignment) {
    var taken = Object.create(null);
    (assignment || []).forEach(function (a) { taken[a.playerIndex] = 1; });
    var out = [];
    ctx.store.players.forEach(function (p, pi) {
      if (taken[pi]) return;
      out.push({ playerIndex: pi, name: p.name, preferLanes: laneLabels(p.preferLanes) });
    });
    return out;
  }

  // assignment → {hero: {playerName, floor}}，供 lanePlan 显示正确的上场人
  function ownerMapOf(ctx, assignment) {
    var map = Object.create(null);
    (assignment || []).forEach(function (a) {
      var p = ctx.store.players[a.playerIndex];
      map[a.hero] = { playerName: a.playerName, floor: p ? p.floor : 0 };
    });
    return map;
  }

  /**
   * lanePlanOf(ctx, heroNames, ownerByName) -> { assignments, uncovered }
   * 把「我方已选英雄」尽量铺满五条分路：按 roles+alt 判路，穷举分配（≤5 个英雄，5! 级别）
   * 目标：覆盖路数最多；同覆盖数时优先用主分路（roles）而不是次分路（alt），保证结果稳定。
   * ownerByName（v2.3）：英雄 → 由谁打（来自一人一英雄匹配），没有则退化为「第一个池主」。
   */
  function lanePlanOf(ctx, heroNames, ownerByName) {
    var names = [];
    (isArr(heroNames) ? heroNames : []).forEach(function (n) {
      var s = trimStr(n);
      if (s && names.indexOf(s) === -1) names.push(s);
    });

    var canPlay = Object.create(null);
    names.forEach(function (n) { canPlay[n] = lanesOfHero(ctx, n); });

    var best = { covered: -1, primary: -1, assign: {} };
    var cur = {};

    function dfs(lanePos, used, covered, primary) {
      if (lanePos >= LANE_ORDER.length) {
        if (covered > best.covered || (covered === best.covered && primary > best.primary)) {
          best = { covered: covered, primary: primary, assign: copyObj(cur) };
        }
        return;
      }
      var lane = LANE_ORDER[lanePos];
      var i;
      // 先尝试「分配」，再尝试「留空」，first-best 保证同分时结果确定
      for (i = 0; i < names.length; i++) {
        var h = names[i];
        if (used[h]) continue;
        if (canPlay[h].indexOf(lane) === -1) continue;
        used[h] = 1;
        cur[lane] = h;
        var isPrimary = primaryLanesOfHero(ctx, h).indexOf(lane) !== -1 ? 1 : 0;
        dfs(lanePos + 1, used, covered + 1, primary + isPrimary);
        delete cur[lane];
        used[h] = 0;
      }
      dfs(lanePos + 1, used, covered, primary);
    }
    dfs(0, Object.create(null), 0, 0);

    var assignments = [];
    LANE_ORDER.forEach(function (lane) {
      var hero = best.assign[lane];
      if (!hero) return;
      // v2.3：优先用「一人一英雄」匹配结果里的上场人，其次才退化为第一个池主
      var mapped = ownerByName && ownerByName[hero];
      var owner = ownerOfHero(ctx, hero);
      assignments.push({
        lane: lane,
        laneLabel: LANES[lane],
        hero: hero,
        playerName: mapped ? mapped.playerName : (owner ? owner.name : ''),
        floor: mapped ? mapped.floor : (owner ? owner.floor : 0)
      });
    });
    var uncovered = LANE_ORDER.filter(function (lane) {
      return !best.assign[lane];
    }).map(function (lane) { return LANES[lane]; });

    return { assignments: assignments, uncovered: uncovered };
  }

  function uncoveredKeysOf(plan) {
    var covered = [];
    (plan && plan.assignments ? plan.assignments : []).forEach(function (a) { covered.push(a.lane); });
    return LANE_ORDER.filter(function (l) { return covered.indexOf(l) === -1; });
  }

  // 除了 excludeHero 之外，全队是否还有「存活（未 ban 未选）」英雄能打该路
  // v2.1：候选来自全队并集，所以只排除候选自己；返回 false = 该路只剩这一个选择（最后机会）
  function othersCanCoverLane(ctx, lane, excludeHero, used) {
    var ps = ctx.store.players;
    for (var i = 0; i < ps.length; i++) {
      var pool = ps[i].pool;
      for (var j = 0; j < pool.length; j++) {
        var h = pool[j].hero;
        if (h === excludeHero) continue;
        if (used[h]) continue;
        if (heroCanPlay(ctx, h, lane)) return true;
      }
    }
    return false;
  }

  /* ================= 阵容标签（同 v1 口径） ================= */

  function checkSatisfied(ctx, hero, key) {
    if (key === 'damage') return hasTag(ctx, hero, '法伤') || hasTag(ctx, hero, '物伤');
    var c = CHECKS.filter(function (x) { return x.key === key; })[0];
    return c ? hasTag(ctx, hero, c.tag) : false;
  }

  function lineupState(ctx, ally) {
    var state = { front: 0, engage: 0, protect: 0, control: 0, physical: 0, magic: 0 };
    (ally || []).forEach(function (n) {
      if (!n) return;
      if (hasTag(ctx, n, '前排')) state.front++;
      if (hasTag(ctx, n, '开团')) state.engage++;
      if (hasTag(ctx, n, '保护')) state.protect++;
      if (hasTag(ctx, n, '控制') || hasTag(ctx, n, '硬控')) state.control++;
      if (hasTag(ctx, n, '物伤')) state.physical++;
      if (hasTag(ctx, n, '法伤')) state.magic++;
    });
    return state;
  }

  function unmetChecks(ctx, ally) {
    var s = lineupState(ctx, ally);
    var unmet = [];
    if (s.front < 1) unmet.push('front');
    if (s.engage < 1) unmet.push('engage');
    if (s.protect < 1) unmet.push('protect');
    if (s.physical < 1 || s.magic < 1) unmet.push('damage');
    if (s.control < 2) unmet.push('control');
    return unmet;
  }

  function compNeedOf(ctx, hero, ally) {
    var unmet = unmetChecks(ctx, ally);
    if (!unmet.length) return 0;
    var s = lineupState(ctx, ally);
    var fills = 0;
    unmet.forEach(function (k) {
      var ok = false;
      if (k === 'damage') {
        if (s.physical < 1 && hasTag(ctx, hero, '物伤')) ok = true;
        if (s.magic < 1 && hasTag(ctx, hero, '法伤')) ok = true;
      } else {
        ok = checkSatisfied(ctx, hero, k);
      }
      if (ok) fills++;
    });
    return fills / unmet.length;
  }

  /* ================= Ban（契约 §4.2） ================= */

  /**
   * 单玩家 exposure：max_h(risk×counter(X,h)) + 0.2 × Σ_h(risk×counter(X,h)) / max(1,pool.length)
   * 同时产出 hits（被 X 克制的池内英雄，按 risk×counter 降序），供 UI 文案与分配用。
   */
  function banPlayerExposure(ctx, idx, xName, player) {
    var pool = player.pool || [];
    var sum = 0;
    var max = 0;
    var hits = [];
    for (var i = 0; i < pool.length; i++) {
      var m = masteryOf(pool[i].mastery);
      var c = counterAt(idx, ctx, xName, pool[i].hero);
      var v = m.risk * c;
      sum += v;
      if (v > max) max = v;
      if (c >= 0.3) {
        hits.push({
          hero: pool[i].hero,
          lane: laneKeyOfHero(ctx, pool[i].hero, player.preferLanes),
          risk: m.risk,
          c: c,
          impact: v
        });
      }
    }
    hits.sort(function (a, b) { return b.impact - a.impact; });
    var exposure = max + 0.2 * sum / Math.max(1, pool.length);
    return { exposure: exposure, sum: sum, hits: hits, poolLen: pool.length };
  }

  /**
   * 一个候选英雄 X 的 ban 分（v2.1 强度主导）：
   *   threat    = Σ_player exposure(player)
   *   fragility = mean_player( Σ risk×counter / max(1,pool.length) )
   *   answerable= 1 若我方任一池内英雄 counter(poolHero → X) ≥ 0.45
   *   score     = w.tier×tierW + w.threat×threat + w.fragility×fragility − w.answerable×answerable
   *
   * T0 硬性优先的边界（默认权重下成立）：T0 最低 100；
   * T1 最高 ≈ 60 + 1.5×(≤11.4) + 0.8×(≤1.9) ≈ 78.6 < 100。
   * 因此克制/池威胁只在同一 T 度内部决定先后，不会把 T1 顶到 T0 前面。
   */
  function banScoreOf(ctx, idx, xName) {
    var players = ctx.store.players;
    var perPlayer = [];
    var threat = 0;
    var fragSum = 0;
    var i;
    for (i = 0; i < players.length; i++) {
      var e = banPlayerExposure(ctx, idx, xName, players[i]);
      perPlayer.push(e);
      threat += e.exposure;
      fragSum += e.sum / Math.max(1, e.poolLen);
    }
    var fragility = players.length ? fragSum / players.length : 0;

    // 我方是否有人能反制 X（阈值 0.45）
    var answerable = 0;
    var answerHero = '';
    for (i = 0; i < players.length && !answerable; i++) {
      var pool = players[i].pool;
      for (var j = 0; j < pool.length; j++) {
        if (counterAt(idx, ctx, pool[j].hero, xName) >= 0.45) {
          answerable = 1;
          answerHero = pool[j].hero;
          break;
        }
      }
    }

    var tierTerm = w(ctx, 'tier') * tierW(ctx, xName);
    var score = tierTerm + w(ctx, 'threat') * threat + w(ctx, 'fragility') * fragility - w(ctx, 'answerable') * answerable;
    return {
      hero: xName,
      tier: tierOf(ctx, xName),
      score: round2(score),
      tierTerm: round2(tierTerm),
      threat: threat,
      fragility: fragility,
      answerable: answerable,
      answerHero: answerHero,
      perPlayer: perPlayer
    };
  }

  /**
   * v2.2：ban 理由只讲「为什么 ban 这个英雄」，不再出现执行人/楼层/建议由谁。
   * 结构：T 度强度优先 → 克制了哪个池（最受伤的一处）→ 我方能否反制。
   */
  function banReason(ctx, c) {
    var parts = [];
    if (tierWeight(c.tier) >= 8) parts.push(c.tier + ' 强度优先');
    else parts.push(c.tier + ' 强度');

    var worst = null;
    var worstPoolLen = 0;
    var worstHitCount = 0;
    c.perPlayer.forEach(function (e) {
      var h = e.hits && e.hits.length ? e.hits[0] : null;
      if (!h) return;
      if (!worst || h.impact > worst.impact) {
        worst = h;
        worstPoolLen = e.poolLen;
        worstHitCount = e.hits.length;
      }
    });
    if (!worst) {
      parts.push('我方池没有被它明显克制的点');
    } else {
      var laneLabel = worst.lane ? LANES[worst.lane] : '英雄';
      var tail = worstPoolLen <= 3
        ? '（该池只有 ' + worstPoolLen + ' 个，容错低）'
        : '（该池 ' + worstPoolLen + ' 个里 ' + worstHitCount + ' 个被克）';
      parts.push('克你' + laneLabel + '池的' + worst.hero + tail);
    }
    parts.push(c.answerable ? ('我方 ' + (c.answerHero || '池里') + ' 能反制，优先级可降') : '我方无人能反制');
    return parts.join('；');
  }

  // 全队里「被 X 克制最狠」的一处（只用于 breakdown 展示，不表示指派）
  function worstHitOf(c) {
    var worst = null;
    var worstPlayer = '';
    c.perPlayer.forEach(function (e, i) {
      var h = e.hits && e.hits.length ? e.hits[0] : null;
      if (!h) return;
      if (!worst || h.impact > worst.impact) {
        worst = h;
        worstPlayer = i;
      }
    });
    return { hit: worst, playerIndex: worstPlayer };
  }

  function banFallback(msg) {
    return {
      date: null,
      side: 'blue',
      commands: [],
      shortlist: [],
      warnings: [msg || '引擎内部异常，ban 建议不可用']
    };
  }

  function banRecommend(ctx) {
    try {
      return banRecommendImpl(ctx);
    } catch (err) {
      return banFallback('ban 计算异常：' + (err && err.message ? err.message : String(err)));
    }
  }

  function banRecommendImpl(ctx) {
    var work = workCtx(ctx);
    var idx = relationIndex(work);
    var used = usedSet(work);
    var ourPool = ourPoolSet(work);
    var warnings = [];
    var players = work.store.players;

    // v2.4：预选阵容的必 ban 威胁强制优先（即使在我方池里也要 ban，例如我方有人会钟馗，
    // 但钟馗会拆掉鲁班+盾山，必须按预选方案 ban 掉）。
    var spec = presetSpecOf(work);
    var coreSet = Object.create(null);
    var mustSet = Object.create(null);
    if (spec) {
      spec.core.forEach(function (h) { coreSet[h] = 1; });
      spec.threats.forEach(function (t) { if (t.level === 'must') mustSet[t.hero] = 1; });
    }

    var candidates = [];
    work.heroes.forEach(function (h) {
      var name = h.name;
      if (!name) return;
      if (used[name]) return;      // 已 ban / 已选
      if (coreSet[name]) return;   // 预选核心不 ban（我方要拿）
      if (ourPool[name] && !mustSet[name]) return;   // 自家池里的不 ban（预选必 ban 除外）
      candidates.push(banScoreOf(work, idx, name));
    });
    candidates.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return a.hero < b.hero ? -1 : (a.hero > b.hero ? 1 : 0);
    });

    var mustCandidates = [];
    if (spec) {
      spec.threats.forEach(function (t) {
        if (t.level !== 'must') return;
        if (used[t.hero] || coreSet[t.hero]) return;
        var c = banScoreOf(work, idx, t.hero);
        c.score = round2(c.score + 60);   // 展示分只用于强调优先级，排序仍按「必 ban 在前」
        c.preset = true;
        c.presetReason = t.reason;
        mustCandidates.push(c);
      });
    }
    var mustHeroSet = Object.create(null);
    mustCandidates.forEach(function (c) { mustHeroSet[c.hero] = 1; });

    // AI 调研的「拆解点」若不是用户必 ban，则作为提防项小幅加权（不强制压过 T0，但会在同分附近排前）
    var watchCandidates = [];
    if (spec) {
      spec.threats.forEach(function (t) {
        if (t.level !== 'watch') return;
        if (used[t.hero] || coreSet[t.hero] || mustHeroSet[t.hero]) return;
        var c = banScoreOf(work, idx, t.hero);
        c.score = round2(c.score + 20);
        c.presetWatch = true;
        c.presetWatchReason = t.reason;
        watchCandidates.push(c);
      });
    }
    var watchSet = Object.create(null);
    watchCandidates.forEach(function (c) { watchSet[c.hero] = 1; });
    var baseCandidates = candidates.filter(function (c) {
      return !mustHeroSet[c.hero] && !watchSet[c.hero];
    }).concat(watchCandidates);
    baseCandidates.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return a.hero < b.hero ? -1 : (a.hero > b.hero ? 1 : 0);
    });
    var combined = mustCandidates.concat(baseCandidates);

    var hasPool = false;
    players.forEach(function (p) { if (p.pool.length) hasPool = true; });
    if (!hasPool) warnings.push('我方英雄池为空：当前只按全局强度排序，请在「设置」页填池后重算');
    if (!combined.length) warnings.push('没有可用的 ban 候选（英雄表为空、全部已被 ban/选，或都已在我方池里）');
    if (spec) {
      mustCandidates.forEach(function (c) {
        if (!c) return;
        var owners = ownersOfHero(work, c.hero);
        if (owners.length) warnings.push('「' + c.hero + '」会拆掉预选组合，虽在 ' + owners[0].name + ' 池里也按方案 ban');
      });
      spec.threats.forEach(function (t) {
        if (t.level !== 'must' || !used[t.hero]) return;
        warnings.push('预选必 ban「' + t.hero + '」已经 ban/选过，无需再占 ban 位');
      });
    }

    // v2.2：不再指派「谁去 ban」。commands = 预选必 ban 在前，其余按 score 降序；
    // 谁 ban 谁由队内协调（UI 不再展示执行人）；shortlist 仍是全局前 8。
    var picked = combined.slice(0, 5);
    var commanded = Object.create(null);
    picked.forEach(function (c) { commanded[c.hero] = 1; });

    var commands = picked.map(function (c) {
      var worst = worstHitOf(c);
      var alts = combined.filter(function (x) {
        return !commanded[x.hero] && x.hero !== c.hero;
      }).slice(0, 3).map(function (x) {
        return { hero: x.hero, tier: x.tier, score: x.score };
      });
      return {
        hero: c.hero,
        tier: c.tier,
        score: c.score,
        preset: !!c.preset,
        mustBan: !!c.preset,
        presetWatch: !!c.presetWatch,
        presetReason: c.presetReason || c.presetWatchReason || '',
        breakdown: {
          tier: c.tierTerm,
          threat: round2(c.threat),
          fragility: round2(c.fragility),
          worstHero: worst.hit ? worst.hit.hero : '',
          worstPlayerName: worst.playerIndex === '' ? '' : work.store.players[worst.playerIndex].name,
          answerable: c.answerable
        },
        reason: c.preset
          ? ('预选必 ban：' + c.presetReason)
          : (c.presetWatch ? ('预选提防：' + c.presetWatchReason) : banReason(work, c)),
        alternatives: alts
      };
    });

    var shortlist = combined.slice(0, 8).map(function (c) {
      return {
        hero: c.hero,
        tier: c.tier,
        score: c.score,
        preset: !!c.preset,
        presetWatch: !!c.presetWatch,
        reason: c.preset
          ? ('预选必 ban：' + c.presetReason)
          : (c.presetWatch ? ('预选提防：' + c.presetWatchReason) : banReason(work, c))
      };
    });

    var presetOut = { active: false, id: '', name: '', mustBans: [], watchBans: [], warnings: [] };
    if (spec) {
      presetOut.active = true;
      presetOut.id = spec.id;
      presetOut.name = spec.name;
      presetOut.mustBans = spec.threats.filter(function (t) { return t.level === 'must'; }).map(function (t) {
        var owners = ownersOfHero(work, t.hero);
        var status = presetStatusOf(work, t.hero);
        return {
          hero: t.hero,
          reason: t.reason,
          source: t.source || '',
          banned: status === 'banned',
          picked: status === 'picked',
          inOurPool: owners.length > 0,
          owners: owners
        };
      });
      presetOut.watchBans = spec.threats.filter(function (t) { return t.level === 'watch'; }).map(function (t) {
        var status = presetStatusOf(work, t.hero);
        return {
          hero: t.hero,
          reason: t.reason,
          source: t.source || '',
          banned: status === 'banned',
          picked: status === 'picked'
        };
      });
    }

    return {
      date: (work.meta && work.meta.version) || null,
      side: work.store.side,
      commands: commands,
      shortlist: shortlist,
      preset: presetOut,
      warnings: warnings
    };
  }

  /* ================= 当前 BP 手（契约 §4.1） ================= */

  var FLOOR_B = [1, 0, 0, 2, 3, 0, 0, 4, 5, 0];
  var FLOOR_R = [0, 1, 2, 0, 0, 3, 4, 0, 0, 5];

  function floorToPlayerIndex(ctx, floor) {
    var ps = ctx.store.players;
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].floor === Number(floor)) return i;
    }
    return -1;
  }

  function currentStepImpl(ctx) {
    var b = picksOf(ctx, 'blue').length;
    var r = picksOf(ctx, 'red').length;
    var i = b + r;
    if (i >= PICK_SEQUENCE.length) return null;
    var letter = PICK_SEQUENCE[i];
    var def = SLOT_DEF[i];
    var our = ourLetter(ctx);
    var isOurs = letter === our;
    var floor = letter === 'B' ? FLOOR_B[i] : FLOOR_R[i];
    var label = (letter === 'B' ? '蓝方' : '红方') + floor + '楼';
    // 同一手包含两个楼层的文案（UI 展示用，兼容 v1 口径）
    if (letter === 'B' && (i === 3 || i === 4)) label = '蓝方2,3楼';
    if (letter === 'B' && (i === 7 || i === 8)) label = '蓝方4,5楼';
    if (letter === 'R' && (i === 1 || i === 2)) label = '红方1,2楼';
    return {
      index: i,
      letter: letter,
      side: letter === 'B' ? 'blue' : 'red',
      isOurs: isOurs,
      floor: floor,
      playerIndex: floorToPlayerIndex(ctx, floor),
      label: label,
      slotType: def.slotType,
      slot: def
    };
  }

  function currentStep(ctx) {
    try {
      return currentStepImpl(workCtx(ctx));
    } catch (err) {
      return null;
    }
  }

  /* ================= Pick（契约 §4.3，v2.1：全队池并集 + 阶段系数） ================= */

  // 净对位 = Σ我方克制 − Σ被克制（原始值，用于 basic 的 flat 判定）
  function masteryFlatTerm(mastery, net) {
    var m = masteryOf(mastery);
    if (m.key === 'basic') return net <= 0 ? m.flat : 0;
    return m.flat || 0;
  }

  /**
   * laneNeedValue：未覆盖分路集合 U（五路，按 roles+alt 判定）
   *   U 空 → 0；否则 = h 能打且在 U 中的分路数 / |U|
   *   v2.1 口径：若某条 U 中的分路「除 h 之外全队存活池已无人能打」（本手是最后机会）
   *   → 该候选 laneNeed 额外 ×1.3，并回传 risky 供 warning。
   */
  function laneNeedValue(ctx, heroName, uncovered, used) {
    if (!uncovered.length) return { value: 0, lanes: [], risky: [] };
    var heroLanes = lanesOfHero(ctx, heroName);
    var hit = [];
    heroLanes.forEach(function (l) {
      if (uncovered.indexOf(l) !== -1) hit.push(l);
    });
    if (!hit.length) return { value: 0, lanes: [], risky: [] };
    var risky = [];
    hit.forEach(function (l) {
      if (!othersCanCoverLane(ctx, l, heroName, used)) risky.push(l);
    });
    var mult = risky.length ? 1.3 : 1;
    return { value: (hit.length / uncovered.length) * mult, lanes: hit, risky: risky };
  }

  function masteryReason(m) {
    if (m.key === 'best') return '绝活（被克也能打）';
    if (m.key === 'basic') return '仅会玩（需要 counter 对面）';
    return '';
  }

  function pickReason(ctx, stats, hero, mastery, assignedTo, ally, enemy, laneInfo, phase) {
    var parts = [];
    parts.push(stats.tier + ' 强度');

    var counters = [];
    enemy.forEach(function (e) { if (counterAt(stats.idx, ctx, hero, e) >= 0.3) counters.push(e); });
    if (counters.length) parts.push('克 ' + counters.slice(0, 2).join('/'));

    var threatened = [];
    enemy.forEach(function (e) { if (counterAt(stats.idx, ctx, e, hero) >= 0.3) threatened.push(e); });
    if (threatened.length) parts.push('被 ' + threatened.slice(0, 2).join('/') + ' 克');

    var syn = [];
    ally.forEach(function (a) { if (synergyAt(stats.idx, ctx, hero, a) >= 0.3) syn.push(a); });
    if (syn.length) parts.push('配合 ' + syn.slice(0, 2).join('/'));

    var unmet = unmetChecks(ctx, ally);
    if (unmet.length) {
      var fills = [];
      var s = lineupState(ctx, ally);
      unmet.forEach(function (k) {
        var ok = false;
        if (k === 'damage') {
          if (s.physical < 1 && hasTag(ctx, hero, '物伤')) ok = true;
          if (s.magic < 1 && hasTag(ctx, hero, '法伤')) ok = true;
        } else {
          ok = checkSatisfied(ctx, hero, k);
        }
        if (ok) fills.push(COVER_LABEL[k]);
      });
      if (fills.length) parts.push('补' + fills.join('/') + '缺口');
    }

    if (laneInfo && laneInfo.lanes.length) {
      var laneText = laneInfo.lanes.map(function (l) { return LANES[l]; }).join('/');
      parts.push('补' + laneText + (laneInfo.risky.length ? '（最后机会）' : ''));
    }
    if (phase && phase.key === 'grab') parts.push('先抢强势');
    if (phase && phase.key === 'counter') parts.push('克制位');

    var mr = masteryReason(mastery);
    if (mr) parts.push(mr);
    // v2.3：明确「这个英雄由谁去打」，不再列「可打：所有人」
    if (assignedTo) parts.push('由 ' + assignedTo.name + '（' + assignedTo.masteryLabel + '）去打');
    return parts.join('；');
  }

  function emptyPlan() { return { assignments: [], uncovered: LANE_ORDER.map(function (l) { return LANES[l]; }) }; }

  function emptyLaneState() {
    return { covered: [], open: LANE_ORDER.map(function (l) { return LANES[l]; }) };
  }

  function pickFallback(msg) {
    return {
      step: null, phase: null, laneState: emptyLaneState(),
      assignment: [], freePlayers: [],
      candidates: [], lanePlan: emptyPlan(),
      warnings: [msg || '引擎内部异常，pick 建议不可用']
    };
  }

  function pickRecommend(ctx) {
    try {
      return pickRecommendImpl(ctx);
    } catch (err) {
      return pickFallback('pick 计算异常：' + (err && err.message ? err.message : String(err)));
    }
  }

  function pickRecommendImpl(ctx) {
    var work = workCtx(ctx);
    var idx = relationIndex(work);
    var used = usedSet(work);
    var warnings = [];
    var warnSeen = Object.create(null);
    var pushWarn = function (msg) {
      if (!msg || warnSeen[msg]) return;
      warnSeen[msg] = 1;
      warnings.push(msg);
    };

    var ourSide = work.store.side;
    var ally = filterNames(picksOf(work, ourSide));
    var enemy = filterNames(picksOf(work, otherSide(ourSide)));

    // v2.3 一人一英雄：我方已选英雄 ↔ 玩家的完整匹配（含 UI 手动指定；不可行时回退自动并 warning）
    var assignment = assignHeroes(work, ally, work.assignments, pushWarn);
    if (!assignment) assignment = [];
    // v2.3 容错：池外指定的英雄（不在任何人池里）会导致匹配不成立 → 明确提示，避免候选莫名全空
    if (!assignment.length && ally.length) {
      var offPool = [];
      for (var ai = 0; ai < ally.length; ai++) {
        if (!ownerOfHero(work, ally[ai])) offPool.push(ally[ai]);
      }
      if (offPool.length) {
        pushWarn('已选英雄「' + offPool.join('/') + '」不在任何人的池里，无法分配上场人；请先在「设置」里把它加进某人的池子');
      } else {
        pushWarn('我方已选英雄无法完成「一人一英雄」分配（池子冲突），请调整池子');
      }
    }
    var freePlayers = freePlayersOf(work, assignment);
    var ownerByName = ownerMapOf(work, assignment);

    var plan = lanePlanOf(work, ally, ownerByName);
    var coveredKeys = plan.assignments.map(function (a) { return a.lane; });
    var openKeys = LANE_ORDER.filter(function (l) { return coveredKeys.indexOf(l) === -1; });
    // v2.2：laneState 给 UI 显示「已覆盖 / 待补」（中文标签）
    var laneState = {
      covered: coveredKeys.map(function (l) { return LANES[l]; }),
      open: openKeys.map(function (l) { return LANES[l]; })
    };
    var uncovered = openKeys;   // laneNeed 的 U 直接取待补分路
    // 我方第几手：只看我方已选数量（敌手不改手数）。>5 时 phase.pickNo=null（我方已选完）。
    var ourPickNo = picksOf(work, ourSide).length + 1;
    var phase = phaseForPickNo(ourPickNo);
    var phaseDef = phaseDefFor(ourPickNo);   // 阶段系数（§4.3 表）
    var spec = presetSpecOf(work);
    var presetOut = presetPickSummary(work, spec);

    var step = currentStepImpl(work);
    if (!step) {
      return {
        step: null, phase: null, laneState: emptyLaneState(),
        assignment: assignment, freePlayers: freePlayers,
        candidates: [], lanePlan: plan, preset: presetOut,
        warnings: ['BP 已结束（10 手已满）']
      };
    }

    // 候选 = 全队 5 个池子的并集：去重、排除已 ban/已选，并收集每个英雄的 owners
    var ownersByHero = Object.create(null);
    var union = [];
    work.store.players.forEach(function (p, pi) {
      p.pool.forEach(function (entry) {
        var hero = entry.hero;
        if (!hero || used[hero]) return;
        var m = masteryOf(entry.mastery);
        if (!ownersByHero[hero]) {
          ownersByHero[hero] = [];
          union.push(hero);
        }
        ownersByHero[hero].push({
          playerIndex: pi,
          name: p.name,
          floor: p.floor,
          mastery: m.key,
          masteryLabel: m.label,
          _rank: MASTERY_ORDER.indexOf(m.key)
        });
      });
    });

    // v2.2：待补分路在全队池里都没人能打 → 明确 warning（UI 直接展示）
    openKeys.forEach(function (lane) {
      var anyone = false;
      for (var i = 0; i < union.length; i++) {
        if (heroCanPlay(work, union[i], lane)) { anyone = true; break; }
      }
      if (!anyone) pushWarn('「' + LANES[lane] + '」已无人可补：全队池里没有能打该路的英雄');
    });

    if (!step.isOurs) {
      // 敌手：不给候选，但 phase/laneState/assignment 仍然返回（UI 可显示「谁打谁、还缺哪路」）
      return {
        step: step, phase: phase, laneState: laneState,
        assignment: assignment, freePlayers: freePlayers,
        candidates: [], lanePlan: plan, preset: presetOut, warnings: warnings
      };
    }

    if (!union.length) {
      pushWarn('全队 5 个池都没有可选英雄（池为空或全被 ban/选），请先在「设置」页补池');
      return {
        step: step, phase: phase, laneState: laneState,
        assignment: assignment, freePlayers: freePlayers,
        candidates: [], lanePlan: plan, preset: presetOut, warnings: warnings
      };
    }

    // v2.2 硬要求：待补分路非空时，候选必须能补至少一条待补路
    //（选了射手后，纯 adc 英雄不再出现；能摇摆 adc+其它路的英雄仍可出现）
    var laneFiltered = union.filter(function (hero) {
      if (!openKeys.length) return true;   // 五路已齐：不过滤
      var heroLanes = lanesOfHero(work, hero);
      for (var i = 0; i < heroLanes.length; i++) {
        if (openKeys.indexOf(heroLanes[i]) !== -1) return true;
      }
      return false;
    });
    if (!laneFiltered.length && openKeys.length) {
      pushWarn('待补分路（' + openKeys.map(function (l) { return LANES[l]; }).join('/') +
        '）没有任何候选可打，请先在「设置」页补池');
    }

    // v2.3：候选还必须能加入「已选 + 该候选」的完整匹配（一人只能打一个英雄，含手动指定）
    // 注意：候选级可行性检查必须「静默」且手动指定为硬约束（strict）——
    // 某个候选不可行就过滤掉，不能把「手动指定无法完整匹配/回退」串扰出去，也不能为了候选而丢掉手动指定。
    var matchFiltered = [];
    var matchInfo = Object.create(null);
    laneFiltered.forEach(function (hero) {
      var r = assignHeroesSmart(work, ally.concat([hero]), work.assignments, null, true);
      if (!r) return;
      var hi = r.heroes.indexOf(hero);
      if (hi < 0) return;
      var first = r.matchings[0][hi];
      var seenPlayer = Object.create(null);
      var fielders = [];
      r.matchings.forEach(function (matching) {
        var e = matching[hi];
        if (!e || seenPlayer[e.playerIndex]) return;
        seenPlayer[e.playerIndex] = 1;
        fielders.push(entryOut(e, r.fixes[hi] === e.playerIndex));
      });
      matchInfo[hero] = {
        assignedTo: entryOut(first, r.fixes[hi] === first.playerIndex),
        fielders: fielders
      };
      matchFiltered.push(hero);
    });

    if (!matchFiltered.length) {
      if (ally.length >= 5) {
        pushWarn('我方 5 个英雄已选满，没有可上场的空位');
      } else if (assignment.length && laneFiltered.length && freePlayers.length) {
        var freeNames = freePlayers.map(function (p) { return p.name; }).join('/');
        var hasManual = Object.keys(work.assignments).length > 0;
        pushWarn('剩余队友（' + freeNames + '）没人能打这些待补分路的英雄，建议调整池子或换人' +
          (hasManual ? '（也可能与手动指定冲突，可取消指定后重试）' : ''));
      }
    }

    var seenWarn = Object.create(null);
    var cands = matchFiltered.map(function (hero) {
      // owners 按 熟练度从高到低（best>normal>basic），同档按 playerIndex 稳定排序
      var owners = ownersByHero[hero].slice();
      owners.sort(function (a, b) {
        if (a._rank !== b._rank) return a._rank - b._rank;
        return a.playerIndex - b.playerIndex;
      });
      var top = owners[0];
      var m = masteryOf(top.mastery);
      var tierLabel = tierOf(work, hero);

      // 原始对位（用于 basic 的净对位判定与理由文案）
      var sumC = 0;
      var sumE = 0;
      enemy.forEach(function (e) { sumC += counterAt(idx, work, hero, e); });
      enemy.forEach(function (e) { sumE += counterAt(idx, work, e, hero); });

      // 克制收益按敌方 T 度加权：克 T0 收益最高（0.5 + 0.5×tierW(e)/10）
      var counterRaw = 0;
      enemy.forEach(function (e) {
        counterRaw += counterAt(idx, work, hero, e) * (0.5 + 0.5 * tierW(work, e) / 10);
      });

      var syn = 0;
      ally.forEach(function (a) { syn += synergyAt(idx, work, hero, a); });
      var comp = compNeedOf(work, hero, ally);
      var laneInfo = laneNeedValue(work, hero, uncovered, used);
      laneInfo.risky.forEach(function (l) {
        var key = 'risk:' + l;
        if (seenWarn[key]) return;
        seenWarn[key] = 1;
        warnings.push('「' + LANES[l] + '」全队其他存活池里没人能打，这手是最后机会');
      });

      var tierWv = tierW(work, hero);
      // v2.4：预选方案契合度（核心 / 搭配 / 标签契合），单独计入 breakdown.preset
      var fit = presetFitOf(work, idx, spec, hero, ally, phase);
      // v2.5：通用组合加成（无预选也生效），按阶段衰减
      var comboFit = comboBoostOf(work, hero, ally, spec ? spec.id : null);
      var comboPhase = (phaseDef.combo != null) ? phaseDef.combo : 1;
      var breakdown = {
        tier: phaseDef.tier * tierWv,
        counter: w(work, 'counter') * phaseDef.counter * m.counterGain * counterRaw,
        countered: -w(work, 'countered') * phaseDef.countered * m.risk * sumE,
        synergy: w(work, 'synergy') * phaseDef.synergy * syn,
        compNeed: w(work, 'compNeed') * phaseDef.compNeed * comp,
        laneNeed: w(work, 'laneNeed') * phaseDef.laneNeed * laneInfo.value,
        mastery: masteryFlatTerm(top.mastery, sumC - sumE),
        preset: fit.bonus,
        combo: round2(comboPhase * comboFit.bonus)
      };
      var score = breakdown.tier + breakdown.counter + breakdown.countered + breakdown.synergy +
        breakdown.compNeed + breakdown.laneNeed + breakdown.mastery + breakdown.preset + breakdown.combo;
      var stats = { tier: tierLabel, idx: idx, sumC: sumC, sumE: sumE };
      var baseReason = pickReason(work, stats, hero, m, matchInfo[hero].assignedTo, ally, enemy, laneInfo, phase);
      var reason = fit.role ? (fit.label + '：' + fit.note + '；' + baseReason) : baseReason;
      if (comboFit.bonus > 0) reason = comboFit.label + '；' + reason;

      return {
        hero: hero,
        heroId: heroIdOf(work, hero),
        tier: tierLabel,
        mastery: m.key,
        masteryLabel: m.label,
        owners: owners.map(function (o) {
          return {
            playerIndex: o.playerIndex,
            name: o.name,
            floor: o.floor,
            mastery: o.mastery,
            masteryLabel: o.masteryLabel
          };
        }),
        // v2.3：本次完整匹配里由谁去打 + 其它可行替换人（可换位的人）
        assignedTo: matchInfo[hero].assignedTo,
        fielders: matchInfo[hero].fielders,
        // 兼容字段：ownerIndex/ownerName 取 owners[0]（池内熟练度最高的人）
        ownerIndex: top.playerIndex,
        ownerName: top.name,
        floor: top.floor,
        lanes: laneLabels(lanesOfHero(work, hero)),
        tags: tagsOf(work, hero).slice(),
        score: round2(score),
        breakdown: {
          tier: round2(breakdown.tier),
          counter: round2(breakdown.counter),
          countered: round2(breakdown.countered),
          synergy: round2(breakdown.synergy),
          compNeed: round2(breakdown.compNeed),
          laneNeed: round2(breakdown.laneNeed),
          mastery: round2(breakdown.mastery),
          preset: round2(breakdown.preset),
          combo: round2(breakdown.combo)
        },
        preset: { role: fit.role, label: fit.label, note: fit.note },
        comboInfo: { role: comboFit.role, label: comboFit.label, bonus: round2(breakdown.combo) },
        reason: reason
      };
    });

    cands.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return a.hero < b.hero ? -1 : (a.hero > b.hero ? 1 : 0);
    });

    return {
      step: step, phase: phase, laneState: laneState,
      assignment: assignment, freePlayers: freePlayers,
      candidates: cands.slice(0, 6), lanePlan: plan, preset: presetOut, warnings: warnings
    };
  }


  /* ================= 阵容体检（契约 §4.4） ================= */

  function lineupFallback(msg) {
    return {
      checks: CHECKS.map(function (c) {
        return { key: c.key, label: c.label, ok: false, value: 0, need: c.need, note: '数据不可用' };
      }),
      lanePlan: emptyPlan(),
      laneSurvival: LANE_ORDER.map(function (l) {
        return { lane: l, laneLabel: LANES[l], poolDepth: 0, owners: [], atRisk: true };
      }),
      survival: [],
      gaps: CHECKS.map(function (c) { return '缺' + c.label; }),
      warnings: [msg || '引擎内部异常，阵容体检不可用']
    };
  }

  function lineupCheck(ctx) {
    try {
      return lineupCheckImpl(ctx);
    } catch (err) {
      return lineupFallback('阵容体检异常：' + (err && err.message ? err.message : String(err)));
    }
  }

  function lineupCheckImpl(ctx) {
    var work = workCtx(ctx);
    var ourSide = work.store.side;
    var ally = filterNames(picksOf(work, ourSide));
    var used = usedSet(work);
    var s = lineupState(work, ally);
    // v2.3：lanePlan 里的 playerName 尽量用「一人一英雄」匹配结果里的上场人
    var assignment = assignHeroes(work, ally, work.assignments, null) || [];
    var plan = lanePlanOf(work, ally, ownerMapOf(work, assignment));
    var covered = plan.assignments.map(function (a) { return a.lane; });

    var checks = [
      { key: 'front', label: '前排', ok: s.front >= 1, value: s.front, need: 1, note: '' },
      { key: 'engage', label: '开团', ok: s.engage >= 1, value: s.engage, need: 1, note: '' },
      { key: 'protect', label: '保护', ok: s.protect >= 1, value: s.protect, need: 1, note: '' },
      {
        key: 'damage',
        label: '伤害类型',
        ok: s.physical >= 1 && s.magic >= 1,
        value: '物' + s.physical + '/法' + s.magic,
        need: '各≥1',
        note: s.physical && s.magic ? '' : (s.physical ? '缺法术伤害' : (s.magic ? '缺物理伤害' : '缺伤害'))
      },
      { key: 'control', label: '控制', ok: s.control >= 2, value: s.control, need: 2, note: '' }
    ];
    checks.forEach(function (c) {
      if (c.ok) return;
      var fillable = ally.length < 5;
      c.note = c.note || (fillable ? '还没补' : '阵容已满仍缺');
    });

    var gaps = checks.filter(function (c) { return !c.ok; }).map(function (c) { return '缺' + c.label; });
    // 五路覆盖缺口：与标签缺口并列展示（分路不再绑定到人，只看队伍是否铺满）
    uncoveredKeysOf(plan).forEach(function (lane) {
      gaps.push('缺' + LANES[lane]);
    });

    var laneSurvival = LANE_ORDER.map(function (lane) {
      var heroes = [];
      var owners = [];
      work.store.players.forEach(function (p) {
        var has = false;
        p.pool.forEach(function (e) {
          if (used[e.hero]) return;
          if (!heroCanPlay(work, e.hero, lane)) return;
          has = true;
          if (heroes.indexOf(e.hero) === -1) heroes.push(e.hero);
        });
        if (has && owners.indexOf(p.name) === -1) owners.push(p.name);
      });
      var isCovered = covered.indexOf(lane) !== -1;
      // atRisk：剩余池里没人能打该路；或该路还没被覆盖且只剩 1 个选择（一 ban 就没了）
      var atRisk = heroes.length === 0 || (!isCovered && heroes.length <= 1);
      return {
        lane: lane,
        laneLabel: LANES[lane],
        poolDepth: heroes.length,
        owners: owners,
        atRisk: atRisk
      };
    });

    var survival = work.store.players.map(function (p, pi) {
      var aliveHeroes = [];
      var masteryAlive = { best: 0, normal: 0, basic: 0 };
      p.pool.forEach(function (e) {
        if (used[e.hero]) return;
        aliveHeroes.push(e.hero);
        masteryAlive[masteryOf(e.mastery).key]++;
      });
      var total = p.pool.length;
      return {
        playerIndex: pi,
        name: p.name,
        floor: p.floor,
        total: total,
        alive: aliveHeroes.length,
        ratio: total ? round2(aliveHeroes.length / total) : 0,
        aliveHeroes: aliveHeroes,
        masteryAlive: masteryAlive
      };
    });

    return {
      checks: checks,
      lanePlan: plan,
      laneSurvival: laneSurvival,
      survival: survival,
      gaps: gaps
    };
  }

  /* ================= 补池建议（契约 §4.5，必须去重） ================= */

  function analyzeFallback(msg) {
    return {
      players: [],
      suggestions: [],
      notes: [],
      warnings: [msg || '引擎内部异常，补池建议不可用']
    };
  }

  function analyzePool(ctx) {
    try {
      return analyzePoolImpl(ctx);
    } catch (err) {
      return analyzeFallback('补池建议异常：' + (err && err.message ? err.message : String(err)));
    }
  }

  function analyzePoolImpl(ctx) {
    var work = workCtx(ctx);
    var used = usedSet(work);
    var players = work.store.players;
    var notes = [];
    var warnings = [];
    var i;
    var j;

    if (!players.length) {
      return { players: [], suggestions: [], notes: ['还没有玩家，先在「设置」页填 5 个人'], warnings: ['store.players 为空'] };
    }
    if (!work.heroes.length) {
      warnings.push('英雄表为空，无法给出补池建议');
    }

    var inAnyPool = Object.create(null);
    players.forEach(function (p) {
      p.pool.forEach(function (e) { inAnyPool[e.hero] = 1; });
    });

    // 每位玩家的体检（不再有 lane 归属，只有 preferLanes 与池的覆盖能力）
    var perPlayer = players.map(function (p, pi) {
      var depth = p.pool.length;
      var masteryCounts = { best: 0, normal: 0, basic: 0 };
      p.pool.forEach(function (e) { masteryCounts[masteryOf(e.mastery).key]++; });
      var coverage = {};
      COVER_KEYS.forEach(function (k) {
        coverage[k] = p.pool.some(function (e) { return checkSatisfied(work, e.hero, k); });
      });
      var laneCover = {};
      LANE_ORDER.forEach(function (l) {
        laneCover[l] = p.pool.some(function (e) { return heroCanPlay(work, e.hero, l); });
      });
      var missing = COVER_KEYS.filter(function (k) { return !coverage[k]; });
      return {
        playerIndex: pi,
        name: p.name,
        floor: p.floor,
        preferLanes: laneLabels(p.preferLanes),
        _prefKeys: p.preferLanes.slice(),
        depth: depth,
        masteryCounts: masteryCounts,
        coverage: coverage,
        laneCover: laneCover,
        _missing: missing,
        _needy: missing.length > 0 || depth < 4
      };
    });

    // notes：池深 / 空池 / 绝活 / 队伍五路覆盖
    perPlayer.forEach(function (x) {
      if (x.depth === 0) {
        notes.push(x.name + ' 池为空，先填 4-6 个英雄');
      } else if (x.depth < 4) {
        notes.push(x.name + ' 的池只有 ' + x.depth + ' 个，被 ban 后没有备选，建议补到 4+');
      }
    });
    // 「没人标绝活」按队聚合，避免 5 行重复提示
    var withPool = perPlayer.filter(function (x) { return x.depth > 0; });
    var noBest = withPool.filter(function (x) { return x.masteryCounts.best === 0; });
    if (withPool.length && noBest.length === withPool.length) {
      notes.push('全队都还没标「绝活」：ban 阶段对你们池子的威胁会被高估，建议给主力英雄标 best');
    } else {
      noBest.forEach(function (x) {
        notes.push(x.name + ' 还没标「绝活」，ban 阶段对其池的威胁估计会偏高');
      });
    }
    LANE_ORDER.forEach(function (lane) {
      var ok = perPlayer.some(function (x) { return x.laneCover[lane]; });
      if (!ok) notes.push('「' + LANES[lane] + '」没有任何人的池能打，五路覆盖会缺口，建议补一个该路英雄');
    });

    // 候选池：不在任何玩家池里、且未被 ban/选
    var candidates = work.heroes.filter(function (h) {
      var name = h.name;
      if (!name) return false;
      if (inAnyPool[name]) return false;   // 规则 3：已在任何池的英雄不进候选
      if (used[name]) return false;        // 已 ban / 已选也不建议
      return true;
    });

    // 每个候选英雄收集「需要它」的玩家（同一 hero 全局只产出一条，见规则 1）
    var scored = [];
    candidates.forEach(function (h) {
      var name = h.name;
      var heroLanes = lanesOfHero(work, name);
      var heroLanesLabels = laneLabels(heroLanes);
      var fillsUnion = Object.create(null);
      var targets = [];
      var laneMatchBest = 0;
      for (i = 0; i < perPlayer.length; i++) {
        var t = perPlayer[i];
        if (!t._needy) continue;
        var laneMatch = 0;
        t._prefKeys.forEach(function (k) {
          if (heroLanes.indexOf(k) !== -1) laneMatch++;
        });
        // 倾向分路不符也允许（五排可跨路）；只有显式关闭 allowCrossLane 时才强过滤
        if (!work.store.allowCrossLane && t._prefKeys.length && !laneMatch) continue;
        var fills = t._missing.filter(function (k) { return checkSatisfied(work, name, k); });
        if (!fills.length && t.depth >= 4) continue;   // 池够深又补不了缺口，不建议
        fills.forEach(function (k) { fillsUnion[k] = 1; });
        if (laneMatch > laneMatchBest) laneMatchBest = laneMatch;
        targets.push({ player: t, fills: fills, laneMatch: laneMatch });
      }
      if (!targets.length) return;   // 规则 2 的后半：所有目标玩家都不需要 → 整条丢弃

      var fillKeys = COVER_KEYS.filter(function (k) { return fillsUnion[k]; });
      var score = w(work, 'tier') * tierW(work, name) + 1.2 * fillKeys.length + 0.6 * laneMatchBest;
      scored.push({
        hero: name,
        heroId: heroIdOf(work, name),
        tier: tierOf(work, name),
        laneFit: heroLanesLabels,
        score: round2(score),
        targets: targets,
        fillKeys: fillKeys
      });
    });

    scored.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return a.hero < b.hero ? -1 : (a.hero > b.hero ? 1 : 0);
    });

    // 规则 1：全局按 hero 唯一（scored 天然一英雄一条），最多 12 条
    var suggestions = scored.slice(0, 12).map(function (s) {
      var reasons = [];
      var addReason = function (r) {
        if (r && reasons.indexOf(r) === -1) reasons.push(r);
      };
      s.fillKeys.forEach(function (k) { addReason('补' + COVER_LABEL[k]); });
      addReason(s.tier + ' 强度');
      if (!s.fillKeys.length) addReason('池深不足，补备选');

      var forPlayers = s.targets.map(function (t) {
        return { playerIndex: t.player.playerIndex, name: t.player.name, floor: t.player.floor };
      });
      // 同一玩家只出现一次（同一 hero 对同一玩家只合并一次）
      var seenPlayer = Object.create(null);
      forPlayers = forPlayers.filter(function (p) {
        var key = String(p.playerIndex);
        if (seenPlayer[key]) return false;
        seenPlayer[key] = 1;
        return true;
      });

      return {
        hero: s.hero,
        heroId: s.heroId,
        tier: s.tier,
        laneFit: s.laneFit,
        forPlayers: forPlayers,
        reasons: reasons
      };
    });

    if (!suggestions.length && work.heroes.length) {
      notes.push('已经找不到可补的英雄（候选都被池子占了或已 ban/选），可以考虑调低段位池或导入全英雄');
    }

    // 输出前去掉内部辅助字段
    var outPlayers = perPlayer.map(function (x) {
      return {
        playerIndex: x.playerIndex,
        name: x.name,
        floor: x.floor,
        preferLanes: x.preferLanes,
        depth: x.depth,
        masteryCounts: x.masteryCounts,
        coverage: x.coverage,
        laneCover: x.laneCover
      };
    });

    return { players: outPlayers, suggestions: suggestions, notes: notes, warnings: warnings };
  }

  /* ================= 预选阵容 + 队伍总体评价（feature v2.4） =================
   * 契约：docs/feature-preset-review.md
   * 预选是单局会话态（ctx.preset），模板库来自 ctx.presets（服务端由 combos.json + combo-bans.json 适配）。
   * 所有新增函数不抛异常；没有预选时 presetPlan/teamReview 返回 active:false 的空结构。
   */

  var PRESET_PLAYSTYLES = {
    protect: { key: 'protect', label: '保护 + 反手', desc: '不主动开无准备的团；前排顶住、核心跟团输出，靠反手接团和拆塔推进。' },
    split: { key: 'split', label: '带线拉扯', desc: '边线牵制，靠传送/支援形成局部多打少；避免无准备正面团。' },
    siege: { key: 'siege', label: '阵地推进', desc: '抱团推进，前排顶住，核心架炮/持续输出拆塔。' },
    poke: { key: 'poke', label: '远程拉扯', desc: '远程压血线，边打边退，抓对面强开后的反手机会。' },
    engage: { key: 'engage', label: '强开冲阵', desc: '先手开团，核心后手进场收割；中期控龙逼团。' },
    control: { key: 'control', label: '控制链团战', desc: '靠多段控制衔接打团，限制对面核心输出空间。' },
    balanced: { key: 'balanced', label: '均衡阵容', desc: '按阵容强势点打，避免被拖入对面节奏。' }
  };

  function presetStyle(key) { return PRESET_PLAYSTYLES[key] || PRESET_PLAYSTYLES.balanced; }

  function defaultPreferTags(styleKey) {
    if (styleKey === 'engage') return ['开团', '前排', '硬控'];
    if (styleKey === 'split' || styleKey === 'poke') return ['前排', '保护', '免控'];
    if (styleKey === 'control') return ['控制', '硬控', '前排'];
    return ['保护', '前排', '硬控'];
  }

  function winConditionOf(styleKey) {
    if (styleKey === 'protect') return '保护核心输出，靠反手接团和拆塔推进；不主动开无准备的团。';
    if (styleKey === 'split') return '边线施压，用传送/支援打人数差；避免无准备正面团。';
    if (styleKey === 'engage') return '中期抱团强开，控龙逼团，不给对面拖后期。';
    if (styleKey === 'siege') return '抱团推进，前排顶住让核心拆塔；稳扎稳打不追人。';
    if (styleKey === 'poke') return '远程压血线，拉扯后反打；不被对面强开贴脸。';
    if (styleKey === 'control') return '靠控制链接团，先手/反手都有说法；别把控制交空。';
    return '按阵容强势点打，避免被拖入对面节奏。';
  }

  function presetColorOf(key) {
    var s = presetStyle(key);
    return { key: s.key, label: s.label, desc: s.desc };
  }

  function presetStatusOf(ctx, hero) {
    var used = usedSet(ctx);
    if (!used[hero]) return 'available';
    return used[hero] === 'ban' ? 'banned' : 'picked';
  }

  function presetStatusLabel(status, inPool) {
    if (status === 'banned') return '已被 ban';
    if (status === 'picked') return '已被选';
    if (status === 'unavailable') return '池里没人会';
    return inPool ? '可拿' : '池里没人会';
  }

  function ownersOfHero(ctx, hero) {
    var out = [];
    ctx.store.players.forEach(function (p, pi) {
      var entry = poolEntryOf(p, hero);
      if (!entry) return;
      var m = masteryOf(entry.mastery);
      out.push({
        playerIndex: pi,
        name: p.name,
        floor: p.floor,
        mastery: m.key,
        masteryLabel: m.label,
        _rank: MASTERY_ORDER.indexOf(m.key)
      });
    });
    out.sort(function (a, b) {
      if (a._rank !== b._rank) return a._rank - b._rank;
      return a.playerIndex - b.playerIndex;
    });
    return out.map(function (o) {
      return {
        playerIndex: o.playerIndex,
        name: o.name,
        floor: o.floor,
        mastery: o.mastery,
        masteryLabel: o.masteryLabel
      };
    });
  }

  function findPresetById(ctx, id) {
    var list = (ctx && ctx.presets) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function normalizePresetCore(ctx, list) {
    var out = [];
    (isArr(list) ? list : []).forEach(function (n) {
      var name = trimStr(n);
      if (!name || out.indexOf(name) !== -1) return;
      if (!heroOf(ctx, name)) return;
      if (out.length < 5) out.push(name);
    });
    return out;
  }

  function normalizePresetPartners(ctx, list, core) {
    var out = [];
    var seen = Object.create(null);
    (isArr(list) ? list : []).forEach(function (p) {
      var hero = p && (typeof p === 'string' ? p : p.hero);
      hero = trimStr(hero);
      if (!hero || seen[hero] || core.indexOf(hero) !== -1 || !heroOf(ctx, hero)) return;
      seen[hero] = 1;
      out.push({
        hero: hero,
        note: (p && typeof p === 'object' && typeof p.note === 'string') ? p.note : '与核心有配合'
      });
    });
    return out;
  }

  function normalizePresetThreats(ctx, list, core) {
    var out = [];
    var seen = Object.create(null);
    (isArr(list) ? list : []).forEach(function (t) {
      var hero = t && (typeof t === 'string' ? t : t.hero);
      hero = trimStr(hero);
      if (!hero || seen[hero] || core.indexOf(hero) !== -1 || !heroOf(ctx, hero)) return;
      seen[hero] = 1;
      out.push({
        hero: hero,
        level: (t && t.level === 'watch') ? 'watch' : 'must',
        reason: (t && typeof t.reason === 'string' && t.reason) ? t.reason : '对预选组合威胁较大',
        source: (t && typeof t.source === 'string' && t.source) ? t.source : ''
      });
    });
    return out;
  }

  // 从英雄标签推导打法（预选自定义与赛后评价共用）
  function derivePlaystyle(ctx, heroNames) {
    var names = filterNames(heroNames || []);
    if (!names.length) return presetStyle('balanced');
    var tags = Object.create(null);
    names.forEach(function (n) {
      tagsOf(ctx, n).forEach(function (t) { tags[t] = 1; });
    });
    var has = function (t) { return !!tags[t]; };
    var count = function (t) {
      var n = 0;
      names.forEach(function (h) { if (hasTag(ctx, h, t)) n++; });
      return n;
    };
    if (names.indexOf('大乔') !== -1) return presetStyle('split');
    if (has('保护') && (has('持续输出') || has('远程'))) return presetStyle('protect');
    if (count('开团') >= 2) return presetStyle('engage');
    if (has('前排') && has('持续输出')) return presetStyle('siege');
    if (count('控制') + count('硬控') >= 3) return presetStyle('control');
    if (has('远程') && (has('爆发') || has('收割') || has('持续输出')) && !has('前排')) return presetStyle('poke');
    return presetStyle('balanced');
  }

  function derivePresetPartners(ctx, core, idx) {
    var style = derivePlaystyle(ctx, core);
    var prefer = defaultPreferTags(style.key);
    var out = [];
    (ctx.heroes || []).forEach(function (h) {
      var name = h && h.name;
      if (!name || core.indexOf(name) !== -1) return;
      var bestCore = '';
      var bestSyn = 0;
      var syn = 0;
      core.forEach(function (c) {
        var w = synergyAt(idx, ctx, name, c);
        syn += w;
        if (w > bestSyn) { bestSyn = w; bestCore = c; }
      });
      var tags = tagsOf(ctx, name);
      var fit = 0;
      prefer.forEach(function (t) { if (tags.indexOf(t) !== -1) fit++; });
      var score = syn + 0.22 * fit;
      if (score < 0.45) return;
      var note;
      if (bestSyn >= 0.5) note = '与 ' + bestCore + ' 有配合';
      else {
        var fitTags = tags.filter(function (t) { return prefer.indexOf(t) !== -1; }).slice(0, 2);
        note = fitTags.length ? ('提供' + fitTags.join('/')) : ('与 ' + (core[0] || '核心') + ' 同体系');
      }
      out.push({ hero: name, note: note, score: score });
    });
    out.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return tierW(ctx, b.hero) - tierW(ctx, a.hero);
    });
    return out.slice(0, 6).map(function (x) { return { hero: x.hero, note: x.note }; });
  }

  function derivePresetThreats(ctx, core, idx) {
    var immobile = false;
    var protect = false;
    core.forEach(function (c) {
      if (hasTag(ctx, c, '持续输出') && hasTag(ctx, c, '远程')) immobile = true;
      if (hasTag(ctx, c, '保护')) protect = true;
    });
    var out = [];
    (ctx.heroes || []).forEach(function (h) {
      var name = h && h.name;
      if (!name || core.indexOf(name) !== -1) return;
      var tags = tagsOf(ctx, name);
      var c = 0;
      core.forEach(function (x) { c += counterAt(idx, ctx, name, x); });
      var extra = 0;
      var notes = [];
      core.forEach(function (x) {
        var w = counterAt(idx, ctx, name, x);
        if (w >= 0.4) notes.push('克 ' + x + '（' + round2(w) + '）');
      });
      if (immobile) {
        if (tags.indexOf('硬控') !== -1) { extra += 0.45; notes.push('硬控能拆站桩输出'); }
        if (tags.indexOf('开团') !== -1) { extra += 0.3; notes.push('开团能冲保护阵'); }
        if (tags.indexOf('远程') !== -1) { extra += 0.2; notes.push('远程消耗压血线'); }
      }
      if (protect && tags.indexOf('硬控') !== -1) extra += 0.15;
      var total = c + extra;
      if (total < 0.5) return;
      if (!notes.length) notes.push('对预选组合有克制');
      out.push({ hero: name, reason: notes.slice(0, 2).join('；'), score: total });
    });
    out.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return tierW(ctx, b.hero) - tierW(ctx, a.hero);
    });
    return out.slice(0, 5).map(function (x, i) {
      return { hero: x.hero, level: i < 3 ? 'must' : 'watch', reason: x.reason };
    });
  }

  function genericTeamPlan(ctx, core, styleKey) {
    var plan = [];
    LANE_ORDER.forEach(function (lane) {
      var coreHero = '';
      core.forEach(function (h) { if (!coreHero && heroCanPlay(ctx, h, lane)) coreHero = h; });
      var prefix = coreHero ? ('拿 ' + coreHero + '；') : '';
      var text;
      if (styleKey === 'protect') {
        if (lane === 'support') text = '全程跟核心，优先保护/反手；别主动先手';
        else if (lane === 'top') text = '拿前排/反手开团位，替核心吃第一波';
        else if (lane === 'jungle') text = '反蹲/反打，对面切核心时从侧面接';
        else if (lane === 'mid') text = '清线 + 控制，反手接团';
        else text = '核心输出，跟保护走位，不单带不先手';
      } else if (styleKey === 'split') {
        if (lane === 'top') text = '主带线，盯小地图；被抓前先撤';
        else if (lane === 'support') text = '跟核心/放大传送，别自己先手';
        else if (lane === 'jungle') text = '控龙 + 反蹲，帮边线做视野';
        else if (lane === 'mid') text = '清线后跟转线，正面接团';
        else text = '选能自己活的，抱团推塔，不单走';
      } else if (styleKey === 'engage') {
        if (lane === 'jungle') text = '后手进场收割，等控制先交';
        else if (lane === 'support') text = '先手开团/报点，护盾留给核心';
        else if (lane === 'top') text = '前排/控制，跟第一波进场';
        else if (lane === 'mid') text = '控制链衔接，先手后接技能';
        else text = '跟团输出，别单带被抓';
      } else if (styleKey === 'siege') {
        if (lane === 'adc') text = '核心架炮跟团，注意钩子/突进';
        else if (lane === 'support') text = '贴身保护，护盾留给架炮期';
        else if (lane === 'top') text = '前排顶住，别追出阵型';
        else if (lane === 'jungle') text = '反蹲 + 控龙，别一个人冲';
        else text = '清线 + 控制，正面接团';
      } else if (styleKey === 'poke') {
        if (lane === 'adc') text = '保持距离输出，不追不贴脸';
        else if (lane === 'support') text = '链子/护盾留给核心，别乱开';
        else if (lane === 'top') text = '前排站侧翼挡突进';
        else if (lane === 'jungle') text = '反蹲后排，处理突进';
        else text = '清线 + 控制，帮压塔';
      } else if (styleKey === 'control') {
        if (lane === 'mid') text = '先手/反手控制链';
        else if (lane === 'support') text = '控制衔接，保护核心';
        else if (lane === 'top') text = '前排吃技能';
        else if (lane === 'jungle') text = '跟控制进场';
        else text = '跟团输出';
      } else {
        if (lane === 'support') text = '保护核心/反手';
        else if (lane === 'top') text = '前排/开团';
        else if (lane === 'jungle') text = '反蹲/控龙';
        else if (lane === 'mid') text = '清线 + 控制';
        else text = '跟团输出';
      }
      plan.push({ lane: lane, role: LANES[lane], instruction: prefix + text });
    });
    return plan;
  }

  function normalizeCuratedSpec(ctx, p) {
    var core = normalizePresetCore(ctx, p.core);
    if (!core.length) return null;
    var style = (p.playstyle && p.playstyle.key && PRESET_PLAYSTYLES[p.playstyle.key])
      ? presetStyle(p.playstyle.key)
      : derivePlaystyle(ctx, core);
    if (p.playstyle && typeof p.playstyle.desc === 'string' && p.playstyle.desc) {
      style = { key: style.key, label: p.playstyle.label || style.label, desc: p.playstyle.desc };
    }
    var plan = [];
    (isArr(p.teamPlan) ? p.teamPlan : []).forEach(function (x) {
      if (!x || LANE_ORDER.indexOf(x.lane) === -1) return;
      plan.push({ lane: x.lane, role: LANES[x.lane], instruction: String(x.instruction || '') });
    });
    if (!plan.length) plan = genericTeamPlan(ctx, core, style.key);
    var prefer = [];
    (isArr(p.preferTags) ? p.preferTags : []).forEach(function (t) {
      var s = trimStr(t);
      if (s && prefer.indexOf(s) === -1) prefer.push(s);
    });
    if (!prefer.length) prefer = defaultPreferTags(style.key);
    return {
      id: trimStr(p.id) || 'curated',
      name: trimStr(p.name) || core.join(' + '),
      subtitle: trimStr(p.subtitle) || style.label,
      tags: isArr(p.tags) ? p.tags.slice() : [style.label],
      core: core,
      partners: normalizePresetPartners(ctx, p.partners, core),
      threats: normalizePresetThreats(ctx, p.threats, core),
      watch: normalizePresetThreats(ctx, p.watch, core).map(function (x) { return { hero: x.hero, reason: x.reason }; }),
      playstyle: style,
      winCondition: trimStr(p.winCondition) || winConditionOf(style.key),
      teamPlan: plan,
      tips: (isArr(p.tips) ? p.tips : []).filter(function (x) { return typeof x === 'string' && x; }).slice(0, 5),
      preferTags: prefer,
      // 研究元数据（combos.json）：UI 展示用，不影响打分
      size: core.length,
      priority: trimStr(p.priority) || '',
      type: trimStr(p.type) || '',
      phase: trimStr(p.phase) || '',
      why: trimStr(p.why) || '',
      lanes: (p.lanes && typeof p.lanes === 'object') ? p.lanes : {},
      banTargets: isArr(p.banTargets) ? p.banTargets.slice() : [],
      counteredBy: isArr(p.counteredBy) ? p.counteredBy.slice() : [],
      confidence: trimStr(p.confidence) || '',
      stats: (p.stats && typeof p.stats === 'object') ? p.stats : null,
      sources: isArr(p.sources) ? p.sources.slice() : [],
      flex: (p.flex && typeof p.flex === 'object') ? p.flex : {},
      custom: false
    };
  }

  function buildCustomSpec(ctx, core) {
    var idx = relationIndex(ctx);
    var style = derivePlaystyle(ctx, core);
    var partners = derivePresetPartners(ctx, core, idx);
    var threats = derivePresetThreats(ctx, core, idx);
    return {
      id: 'custom',
      name: core.join(' + '),
      subtitle: style.label,
      tags: [style.label, '自定义'],
      core: core,
      partners: partners,
      threats: threats,
      watch: [],
      playstyle: style,
      winCondition: winConditionOf(style.key),
      teamPlan: genericTeamPlan(ctx, core, style.key),
      tips: [
        '核心被 ban 时按推荐搭配降级，不要硬拿',
        '优先保护核心发育，别让核心先手',
        '团战按「' + style.label + '」执行，不追无意义的单杀'
      ],
      preferTags: defaultPreferTags(style.key),
      size: core.length,
      priority: '',
      type: '自定义',
      phase: '',
      why: '',
      lanes: {},
      banTargets: [],
      counteredBy: [],
      confidence: 'custom',
      stats: null,
      sources: [],
      flex: {},
      custom: true
    };
  }

  // 从 combo.type / phase / why / name 推导打法（AI 调研文本 → 现有 7 类）
  function inferComboStyle(combo) {
    var text = [combo && combo.type, combo && combo.phase, combo && combo.why, combo && combo.name].filter(Boolean).join(' ');
    var core = (combo && isArr(combo.core)) ? combo.core : [];
    if (core.indexOf('大乔') !== -1) return presetStyle('split');
    if (/四保一|保人|连体|射辅|保护|续航|复活|站桩|养猪/.test(text)) return presetStyle('protect');
    if (/带线|牵制|运营|分推|转线/.test(text)) return presetStyle('split');
    if (/消耗|视野|远程|狙击|重伤|poke/i.test(text)) return presetStyle('poke');
    if (/强开|冲阵|秒杀|开团|突进|越塔|钩/.test(text)) return presetStyle('engage');
    if (/阵地|推进|架炮|拆塔/.test(text)) return presetStyle('siege');
    if (/控制链|双压制|嘲讽|定身|续控/.test(text)) return presetStyle('control');
    return presetStyle('balanced');
  }

  /**
   * 把 AI 调研的 data/combos.json（+ 用户实战必 ban 的 data/combo-bans.json）
   * 适配成引擎/ UI 使用的 preset 结构。服务端 /api/presets 与测试共用。
   * 不修改原数据；不依赖 store/heroes（英雄名校验留给 presetPlan/normalizeCuratedSpec）。
   */
  function presetsFromCombos(combosData, overridesData) {
    var comps = isArr(combosData) ? combosData : ((combosData && isArr(combosData.comps)) ? combosData.comps : []);
    var overrides = (overridesData && isObj(overridesData.overrides)) ? overridesData.overrides : {};
    var out = [];
    comps.forEach(function (c) {
      if (!c || !c.id || !isArr(c.core) || !c.core.length) return;
      var core = [];
      c.core.forEach(function (h) {
        h = trimStr(h);
        if (h && core.indexOf(h) === -1) core.push(h);
      });
      if (!core.length) return;
      var style = inferComboStyle(c);
      var userRaw = overrides[c.id];
      var userBans = isArr(userRaw) ? userRaw : ((userRaw && isArr(userRaw.mustBans)) ? userRaw.mustBans : []);
      var threats = [];
      var seen = Object.create(null);
      userBans.forEach(function (t) {
        var hero = trimStr(t && (t.hero || t));
        if (!hero || core.indexOf(hero) !== -1 || seen[hero]) return;
        seen[hero] = 1;
        threats.push({
          hero: hero, level: 'must', source: 'user',
          reason: (t && typeof t.reason === 'string' && t.reason) ? t.reason : '用户实战补充：必须 ban'
        });
      });
      var research = isArr(c.counteredBy) ? c.counteredBy : [];
      var researchMust = userBans.length ? 0 : Math.min(3, research.length);
      var ri = 0;
      research.forEach(function (h) {
        h = trimStr(h);
        if (!h || core.indexOf(h) !== -1 || seen[h]) return;
        seen[h] = 1;
        threats.push({
          hero: h, level: ri < researchMust ? 'must' : 'watch', source: 'research',
          reason: 'AI 调研：克制/拆解「' + (c.name || c.id) + '」这套组合'
        });
        ri++;
      });
      var partners = [];
      var pSeen = Object.create(null);
      var flex = (c.flex && typeof c.flex === 'object') ? c.flex : {};
      Object.keys(flex).forEach(function (slot) {
        (isArr(flex[slot]) ? flex[slot] : []).forEach(function (h) {
          h = trimStr(h);
          if (!h || core.indexOf(h) !== -1 || pSeen[h]) return;
          pSeen[h] = 1;
          partners.push({ hero: h, note: '可替代 ' + slot + '（AI 调研）', forSlot: slot });
        });
      });
      var banTargets = (isArr(c.banTargets) ? c.banTargets : []).map(trimStr).filter(Boolean);
      var tips = [];
      tips.push('优先凑齐核心件：' + core.join(' + '));
      if (banTargets.length) tips.push('对面可能 ban：' + banTargets.join('/'));
      if (c.phase) tips.push('强势期：' + c.phase);
      if (c.stats && c.stats.idx) tips.push('本地统计：idx ' + c.stats.idx + ' / 样本 ' + c.stats.matches);
      out.push({
        id: c.id,
        name: c.name || c.id,
        subtitle: (c.priority || 'B') + '档 · ' + (c.type || ''),
        tags: [c.priority, c.type, c.phase].filter(Boolean),
        core: core,
        partners: partners,
        threats: threats,
        watch: [],
        playstyle: style,
        winCondition: c.why || '',
        teamPlan: [],
        tips: tips,
        preferTags: defaultPreferTags(style.key),
        size: core.length,
        priority: c.priority || 'B',
        type: c.type || '',
        phase: c.phase || '',
        why: c.why || '',
        lanes: (c.lanes && typeof c.lanes === 'object') ? c.lanes : {},
        banTargets: banTargets,
        counteredBy: research.slice(),
        confidence: c.confidence || '',
        stats: c.stats || null,
        sources: isArr(c.sources) ? c.sources.slice() : [],
        flex: flex,
        custom: false
      });
    });
    return out;
  }

  function presetSpecOf(ctx) {
    var sel = ctx && ctx.preset;
    if (!isObj(sel)) return null;
    var id = trimStr(sel.id);
    var curated = (id && id !== 'custom') ? findPresetById(ctx, id) : null;
    if (curated) return normalizeCuratedSpec(ctx, curated);
    var core = normalizePresetCore(ctx, sel.core);
    if (!core.length) return null;
    // 自定义核心刚好等于某套模板 → 直接复用模板的必 ban / 搭配 / 分工（更准，避免推导漏掉关键克制）
    var matched = null;
    (ctx.presets || []).forEach(function (p) {
      if (matched || !p || !isArr(p.core) || p.core.length !== core.length) return;
      var same = true;
      for (var i = 0; i < core.length; i++) {
        if (p.core.indexOf(core[i]) === -1) { same = false; break; }
      }
      if (same) matched = p;
    });
    if (matched) {
      var spec = normalizeCuratedSpec(ctx, matched);
      if (spec) spec.custom = true;
      return spec;
    }
    return buildCustomSpec(ctx, core);
  }

  function laneKeyOfLabel(label) {
    for (var k in LANES) { if (LANES[k] === label) return k; }
    return '';
  }

  function comboLaneOf(spec, hero) {
    var lanes = (spec && spec.lanes) || {};
    var keys = Object.keys(lanes);
    for (var i = 0; i < keys.length; i++) {
      var arr = lanes[keys[i]];
      if (isArr(arr) && arr.indexOf(hero) !== -1) {
        return { label: keys[i], key: laneKeyOfLabel(keys[i]) };
      }
    }
    return null;
  }

  function presetPlanImpl(ctx) {
    var spec = presetSpecOf(ctx);
    var empty = {
      active: false, custom: false, id: '', name: '', subtitle: '', tags: [],
      core: [], threats: [], partners: [], playstyle: presetStyle('balanced'),
      winCondition: '', teamPlan: [], tips: [],
      progress: { core: { picked: 0, total: 0 }, partners: { picked: 0, total: 0 }, bans: { banned: 0, total: 0 } },
      warnings: []
    };
    if (!spec) return empty;

    var ourSide = ctx.store.side;
    var ourPicks = filterNames(picksOf(ctx, ourSide));
    var ourBans = filterNames((ctx.bans && ctx.bans.ours) || []);
    var warnings = [];
    var coreOut = [];
    var threatsOut = [];
    var partnersOut = [];

    spec.core.forEach(function (hero) {
      var owners = ownersOfHero(ctx, hero);
      var status = presetStatusOf(ctx, hero);
      if (status === 'available' && !owners.length) status = 'unavailable';
      var comboLane = comboLaneOf(spec, hero);
      var lane = comboLane ? comboLane.key : laneKeyOfHero(ctx, hero, null);
      coreOut.push({
        hero: hero,
        heroId: heroIdOf(ctx, hero),
        tier: tierOf(ctx, hero),
        lane: lane,
        laneLabel: comboLane ? comboLane.label : (lane ? LANES[lane] : ''),
        inPool: owners.length > 0,
        owners: owners,
        status: status,
        statusLabel: presetStatusLabel(status, owners.length > 0)
      });
      if (!owners.length) warnings.push('预选核心「' + hero + '」不在任何队友英雄池里：BP 里要用「池外指定」，或先补池/换一套方案');
      else if (status === 'banned') warnings.push('预选核心「' + hero + '」已被 ban，方案自动降级：优先拿推荐搭配');
      else if (status === 'picked' && ourPicks.indexOf(hero) === -1) warnings.push('预选核心「' + hero + '」被对面选走，方案自动降级');
    });

    spec.threats.forEach(function (t) {
      var owners = ownersOfHero(ctx, t.hero);
      var status = presetStatusOf(ctx, t.hero);
      threatsOut.push({
        hero: t.hero,
        heroId: heroIdOf(ctx, t.hero),
        tier: tierOf(ctx, t.hero),
        level: t.level === 'watch' ? 'watch' : 'must',
        reason: t.reason,
        source: t.source || '',
        inOurPool: owners.length > 0,
        owners: owners,
        status: status,
        banned: status === 'banned'
      });
    });

    spec.partners.forEach(function (p) {
      var owners = ownersOfHero(ctx, p.hero);
      var status = presetStatusOf(ctx, p.hero);
      partnersOut.push({
        hero: p.hero,
        heroId: heroIdOf(ctx, p.hero),
        tier: tierOf(ctx, p.hero),
        note: p.note,
        inPool: owners.length > 0,
        owners: owners,
        status: status
      });
    });

    var corePicked = 0;
    coreOut.forEach(function (c) { if (ourPicks.indexOf(c.hero) !== -1) corePicked++; });
    var partnerPicked = 0;
    partnersOut.forEach(function (c) { if (ourPicks.indexOf(c.hero) !== -1) partnerPicked++; });
    var mustBanned = 0;
    threatsOut.forEach(function (t) {
      if (t.level === 'must' && ourBans.indexOf(t.hero) !== -1) mustBanned++;
    });

    var mustTotal = threatsOut.filter(function (t) { return t.level === 'must'; }).length;
    var stageStarted = ourPicks.length > 0 || ourBans.length >= 5;
    if (stageStarted && mustTotal > mustBanned) {
      threatsOut.forEach(function (t) {
        if (t.level !== 'must' || t.banned) return;
        if (ourBans.indexOf(t.hero) !== -1) return;
        warnings.push('预选必 ban「' + t.hero + '」还没 ban 掉，对面可能拿到');
      });
    }

    return {
      active: true,
      custom: !!spec.custom,
      id: spec.id,
      name: spec.name,
      subtitle: spec.subtitle,
      tags: spec.tags,
      core: coreOut,
      threats: threatsOut,
      partners: partnersOut,
      playstyle: spec.playstyle,
      winCondition: spec.winCondition,
      teamPlan: spec.teamPlan,
      tips: spec.tips,
      // AI 调研元数据（combos.json → preset）
      size: spec.size || coreOut.length,
      priority: spec.priority || '',
      type: spec.type || '',
      phase: spec.phase || '',
      why: spec.why || '',
      lanes: spec.lanes || {},
      banTargets: spec.banTargets || [],
      counteredBy: spec.counteredBy || [],
      confidence: spec.confidence || '',
      stats: spec.stats || null,
      sources: spec.sources || [],
      flex: spec.flex || {},
      progress: {
        core: { picked: corePicked, total: coreOut.length },
        partners: { picked: partnerPicked, total: partnersOut.length },
        bans: { banned: mustBanned, total: mustTotal }
      },
      warnings: warnings
    };
  }

  function presetPlan(ctx) {
    try {
      return presetPlanImpl(workCtx(ctx));
    } catch (err) {
      return {
        active: false, custom: false, id: '', name: '', subtitle: '', tags: [],
        core: [], threats: [], partners: [], playstyle: presetStyle('balanced'),
        winCondition: '', teamPlan: [], tips: [],
        progress: { core: { picked: 0, total: 0 }, partners: { picked: 0, total: 0 }, bans: { banned: 0, total: 0 } },
        warnings: ['预选阵容计算异常：' + (err && err.message ? err.message : String(err))]
      };
    }
  }

  // v2.5：通用组合加成（**不需要预选**）——低梯度英雄的「奇招」主要靠这条路。
  //   命中 2 件 → 给「潜力」小分；凑满 core → 给「成型」大分（约半个~一个 T0 档，S 档最高 15）。
  //   已由 presetFitOf 计分的那套预选组合会被跳过，避免双计。
  function comboBoostOf(ctx, hero, ally, activePresetId) {
    var list = isArr(ctx.combos) ? ctx.combos : [];
    if (!list.length || !ally || !ally.length) return { bonus: 0, combo: null, role: null, label: '' };
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !isArr(c.core) || c.core.indexOf(hero) === -1) continue;
      if (activePresetId && c.id === activePresetId) continue;
      var have = 0;
      for (var j = 0; j < c.core.length; j++) {
        if (ally.indexOf(c.core[j]) !== -1) have++;
      }
      if (have < 1) continue;                    // 我方还没有任何一件 → 不给潜力分
      var after = have + 1;
      if (after < 2) continue;                   // 只拿到一件不算组合
      var pw = c.priority === 'S' ? 1.0 : (c.priority === 'A' ? 0.7 : 0.4);
      var complete = after >= c.core.length;
      var bonus = (complete ? 15 : 3) * pw;
      if (!best || bonus > best.bonus) {
        best = {
          bonus: round2(bonus),
          combo: c,
          role: complete ? 'complete' : 'partial',
          label: complete ? ('凑成「' + c.name + '」') : ('组合进度「' + c.name + '」' + after + '/' + c.core.length)
        };
      }
    }
    return best || { bonus: 0, combo: null, role: null, label: '' };
  }

  // 预选对某个候选的加分；返回 {bonus, role, label, note}
  function presetFitOf(ctx, idx, spec, hero, ally, phase) {
    if (!spec) return { bonus: 0, role: null, label: '', note: '' };
    if (spec.core.indexOf(hero) !== -1) {
      if (ally.indexOf(hero) !== -1) return { bonus: 0, role: null, label: '', note: '' };
      var mult = (phase && phase.key === 'grab') ? 1 : ((phase && phase.key === 'mid') ? 0.95 : 0.9);
      return {
        bonus: round2((20 + 2.2 * tierW(ctx, hero)) * mult),
        role: 'core',
        label: '预选核心',
        note: '核心位，优先拿'
      };
    }
    var partner = null;
    spec.partners.forEach(function (p) { if (p.hero === hero) partner = p; });
    if (partner) {
      var syn = 0;
      ally.forEach(function (a) {
        if (spec.core.indexOf(a) === -1) return;
        var w = synergyAt(idx, ctx, hero, a);
        if (w > syn) syn = w;
      });
      return {
        bonus: round2(8 + 4 * syn),
        role: 'partner',
        label: '预选搭配',
        note: partner.note || '与核心有配合'
      };
    }
    var hasCore = false;
    ally.forEach(function (a) { if (spec.core.indexOf(a) !== -1) hasCore = true; });
    if (hasCore) {
      var fit = 0;
      (spec.preferTags || []).forEach(function (t) { if (hasTag(ctx, hero, t)) fit++; });
      if (fit) {
        return {
          bonus: round2(3 * Math.min(2, fit)),
          role: 'fit',
          label: '契合方案',
          note: '提供保护/前排/控制，符合「' + spec.playstyle.label + '」'
        };
      }
    }
    return { bonus: 0, role: null, label: '', note: '' };
  }

  function presetPickSummary(ctx, spec) {
    if (!spec) return { active: false, id: '', name: '', nextCore: null, coreStatus: [], warnings: [] };
    var ourPicks = filterNames(picksOf(ctx, ctx.store.side));
    var coreStatus = [];
    var nextCore = null;
    var warnings = [];
    spec.core.forEach(function (hero) {
      var owners = ownersOfHero(ctx, hero);
      var status = presetStatusOf(ctx, hero);
      if (status === 'available' && !owners.length) status = 'unavailable';
      coreStatus.push({ hero: hero, status: status, owners: owners });
      if (!nextCore && status === 'available' && owners.length) {
        var lane = laneKeyOfHero(ctx, hero, null);
        nextCore = { hero: hero, roleLabel: lane ? LANES[lane] : '' };
      }
      if (status === 'banned') warnings.push('预选核心「' + hero + '」已被 ban');
      if (!owners.length) warnings.push('预选核心「' + hero + '」不在任何队友池里');
    });
    if (ourPicks.length && !nextCore) warnings.push('预选核心已全部拿完或不可用：按推荐搭配和克制位继续');
    return { active: true, id: spec.id, name: spec.name, nextCore: nextCore, coreStatus: coreStatus, warnings: warnings };
  }

  /* ---------------- 赛后队伍总体评价 ---------------- */

  function knownPicksOf(ctx, side) {
    return filterNames(picksOf(ctx, side)).filter(function (n) { return !!heroOf(ctx, n); });
  }

  function reviewGrade(score) {
    if (score >= 80) return { key: 'S', label: '极强', tone: 'good' };
    if (score >= 70) return { key: 'A', label: '强', tone: 'good' };
    if (score >= 60) return { key: 'B', label: '均衡', tone: 'ok' };
    if (score >= 50) return { key: 'C', label: '偏弱', tone: 'bad' };
    return { key: 'D', label: '吃力', tone: 'bad' };
  }

  function reviewDims(ctx, heroes) {
    var s = lineupState(ctx, heroes);
    var dims = [
      { key: 'front', label: '前排', value: s.front, need: 1, level: s.front >= 1 ? 'ok' : 'bad', detail: s.front ? s.front + ' 个前排' : '没有前排' },
      { key: 'engage', label: '开团', value: s.engage, need: 1, level: s.engage >= 1 ? 'ok' : 'bad', detail: s.engage ? s.engage + ' 个开团点' : '没有开团' },
      { key: 'protect', label: '保护', value: s.protect, need: 1, level: s.protect >= 1 ? 'ok' : 'bad', detail: s.protect ? s.protect + ' 个保护点' : '没有保护' },
      {
        key: 'damage', label: '伤害类型', value: '物' + s.physical + '/法' + s.magic, need: '各≥1',
        level: (s.physical >= 1 && s.magic >= 1) ? 'ok' : 'bad',
        detail: (s.physical && s.magic) ? '物法双伤' : (s.physical ? '只有物理伤害' : (s.magic ? '只有法术伤害' : '没有伤害标签'))
      },
      {
        key: 'control', label: '控制', value: s.control, need: 2,
        level: s.control >= 2 ? 'ok' : (s.control === 1 ? 'warn' : 'bad'),
        detail: s.control >= 2 ? (s.control + ' 个控制点') : (s.control === 1 ? '控制偏少（1 个）' : '没有控制')
      }
    ];
    return { state: s, dims: dims };
  }

  function reviewSynergies(ctx, idx, heroes) {
    var pairs = [];
    var sum = 0;
    for (var i = 0; i < heroes.length; i++) {
      for (var j = i + 1; j < heroes.length; j++) {
        var w = synergyAt(idx, ctx, heroes[i], heroes[j]);
        if (w <= 0) continue;
        sum += w;
        if (w >= 0.5) {
          pairs.push({ a: heroes[i], b: heroes[j], w: round2(w), note: '配合 ' + round2(w) });
        }
      }
    }
    pairs.sort(function (a, b) { return b.w - a.w; });
    return { pairs: pairs.slice(0, 3), sum: sum };
  }

  // 赛后识别双方命中的 AI 调研组合（含 flex 替代件），给总体评价补「体系完成度」
  function reviewCombosOf(ctx, heroes) {
    var out = [];
    (ctx.presets || []).forEach(function (p) {
      if (!p || !isArr(p.core) || !p.core.length) return;
      var core = p.core;
      var covered = [];
      var flexHit = [];
      heroes.forEach(function (h) {
        if (core.indexOf(h) !== -1) {
          if (covered.indexOf(h) === -1) covered.push(h);
          return;
        }
        var flex = p.flex || {};
        Object.keys(flex).forEach(function (slot) {
          if (!isArr(flex[slot]) || flex[slot].indexOf(h) === -1) return;
          if (covered.indexOf(slot) !== -1) return;
          covered.push(slot);
          flexHit.push({ hero: h, forSlot: slot });
        });
      });
      if (!covered.length) return;
      var total = core.length;
      var hit = covered.length;
      var complete = hit >= total;
      var prio = p.priority === 'S' ? 0.18 : (p.priority === 'A' ? 0.12 : 0.06);
      out.push({
        id: p.id,
        name: p.name,
        priority: p.priority || '',
        type: p.type || '',
        hit: hit,
        total: total,
        complete: complete,
        flexHit: flexHit,
        score: round2(hit / total + (complete ? 0.35 : 0) + prio)
      });
    });
    out.sort(function (a, b) {
      if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
      return b.hit - a.hit;
    });
    return out.slice(0, 3);
  }

  function reviewCounterTotals(ctx, idx, heroes, opp) {
    var push = 0;
    var fear = 0;
    heroes.forEach(function (h) {
      opp.forEach(function (e) {
        push += counterAt(idx, ctx, h, e);
        fear += counterAt(idx, ctx, e, h);
      });
    });
    return { push: push, fear: fear };
  }

  function reviewCoreOf(ctx, side, heroes, pairList, assignment) {
    if (!heroes.length) return null;
    var best = null;
    heroes.forEach(function (h) {
      var syn = 0;
      pairList.forEach(function (p) { if (p.a === h || p.b === h) syn = Math.max(syn, p.w); });
      var carry = 0;
      if (hasTag(ctx, h, '持续输出')) carry += 2.5;
      if (hasTag(ctx, h, '爆发') || hasTag(ctx, h, '收割')) carry += 1.5;
      if (hasTag(ctx, h, '远程')) carry += 0.5;
      var score = tierW(ctx, h) * 0.6 + 0.8 * syn + carry;
      var at = null;
      assignment.forEach(function (a) { if (a.hero === h) at = a; });
      if (at && at.mastery === 'best') score += 1.5;
      if (at && at.mastery === 'basic') score -= 1.0;
      if (!best || score > best.score) best = { hero: h, score: score, syn: syn, at: at };
    });
    var reason = tierOf(ctx, best.hero) + ' 核心';
    if (best.syn > 0) reason += '；队内配合 ' + round2(best.syn);
    if (best.at) reason += '；由 ' + best.at.playerName + '（' + best.at.masteryLabel + '）打';
    return {
      hero: best.hero,
      playerName: best.at ? best.at.playerName : '',
      mastery: best.at ? best.at.mastery : '',
      tier: tierOf(ctx, best.hero),
      reason: reason
    };
  }

  function reviewStrengths(ctx, side, heroes, data, isOurs) {
    var out = [];
    var dims = data.dims;
    var okDims = dims.filter(function (d) { return d.level === 'ok'; });
    if (okDims.length) out.push('结构达标：' + okDims.map(function (d) { return d.label; }).join('/'));
    if (data.tierNorm >= 0.65) out.push('整体强度在线（均值 ' + round2(data.tierNorm * 10) + '/10）');
    if (data.synergies.pairs.length) {
      var top = data.synergies.pairs[0];
      out.push('关键配合：' + top.a + ' × ' + top.b + '（' + round2(top.w) + '）');
    }
    if (!data.plan.uncovered.length) out.push('五路齐全，阵容能铺满');
    if (data.state.physical >= 1 && data.state.magic >= 1) out.push('物法双伤，输出类型不好针对');
    if (isOurs && data.assignment.length && data.assignment.every(function (a) { return a.mastery !== 'basic'; })) {
      out.push('上场英雄熟练度都在「正常」以上');
    }
    while (out.length < 2) out.push(heroes.length ? '阵容有明确的强势点，按打法执行即可' : '还没有选人，暂无评价');
    return out.slice(0, 4);
  }

  function reviewRisks(ctx, side, heroes, data, opp, isOurs, spec) {
    var out = [];
    data.dims.forEach(function (d) {
      if (d.level !== 'ok') out.push('缺' + d.label + '：' + d.detail);
    });
    data.plan.uncovered.forEach(function (l) { out.push('「' + l + '」没有英雄能覆盖'); });
    if (isOurs && heroes.length && data.assignment.length !== heroes.length) {
      out.push('我方英雄无法完成一人一英雄分配（同一队友被两个英雄占用），需要换人/调池');
    }
    data.threats.slice(0, 2).forEach(function (t) { if (t.w >= 0.5) out.push('「' + t.hero + '」被对面 ' + t.by + ' 克制（' + round2(t.w) + '）'); });
    if (isOurs) {
      data.assignment.forEach(function (a) {
        if (a.mastery === 'basic') out.push(a.hero + ' 只有「仅会玩」熟练度，逆风容易打不出效果');
      });
      if (spec) {
        var missed = spec.threats.filter(function (t) { return t.level === 'must'; }).filter(function (t) { return presetStatusOf(ctx, t.hero) === 'available'; });
        if (missed.length) out.push('预选必 ban 没执行：' + missed.map(function (t) { return t.hero; }).join('/'));
      }
    }
    if (!data.synergies.pairs.length) out.push('队内配合点少，团战更依赖个人发挥');
    while (out.length < 2) out.push('没有明显硬伤，注意别被拖入对面节奏');
    return out.slice(0, 5);
  }

  function reviewPlaystyleOf(ctx, side, heroes, spec) {
    if (side === ctx.store.side && spec) return { key: spec.playstyle.key, label: spec.playstyle.label, desc: spec.playstyle.desc };
    var st = derivePlaystyle(ctx, heroes);
    return { key: st.key, label: st.label, desc: st.desc };
  }

  function sideReviewOf(ctx, side, spec, idx) {
    var isOurs = side === ctx.store.side;
    var heroes = knownPicksOf(ctx, side);
    var opp = knownPicksOf(ctx, otherSide(side));
    var assignment = isOurs ? (assignHeroes(ctx, heroes, ctx.assignments, null) || []) : [];
    var ownerByName = ownerMapOf(ctx, assignment);
    var plan = lanePlanOf(ctx, heroes, ownerByName);
    var dim = reviewDims(ctx, heroes);
    var syn = reviewSynergies(ctx, idx, heroes);
    var counters = reviewCounterTotals(ctx, idx, heroes, opp);

    var satisfied = 0;
    if (dim.state.front >= 1) satisfied++;
    if (dim.state.engage >= 1) satisfied++;
    if (dim.state.protect >= 1) satisfied++;
    if (dim.state.physical >= 1 && dim.state.magic >= 1) satisfied++;
    if (dim.state.control >= 2) satisfied++;

    var tierNorm = 0;
    heroes.forEach(function (h) { tierNorm += tierW(ctx, h) / 10; });
    tierNorm = heroes.length ? tierNorm / heroes.length : 0;
    var synergyNorm = Math.min(1, syn.sum / 2.5);
    var matchupNorm = Math.max(0, Math.min(1, 0.5 + (counters.push - counters.fear) / 8));
    var structureNorm = satisfied / 5;

    var score = round2(45 * tierNorm + 25 * structureNorm + 15 * synergyNorm + 15 * matchupNorm);
    var threats = [];
    opp.forEach(function (e) {
      heroes.forEach(function (h) {
        var w = counterAt(idx, ctx, e, h);
        if (w >= 0.45) threats.push({ hero: h, by: e, w: w });
      });
    });
    threats.sort(function (a, b) { return b.w - a.w; });

    var core = reviewCoreOf(ctx, side, heroes, syn.pairs, assignment);
    var style = reviewPlaystyleOf(ctx, side, heroes, spec);
    var data = {
      dims: dim.dims, state: dim.state, plan: plan,
      synergies: syn, tierNorm: tierNorm, assignment: assignment,
      threats: threats, counters: counters
    };
    var strengths = reviewStrengths(ctx, side, heroes, data, isOurs);
    var risks = reviewRisks(ctx, side, heroes, data, opp, isOurs, spec);

    return {
      side: side,
      label: isOurs ? '我方' : '敌方',
      heroes: heroes,
      assignment: assignment.map(function (a) {
        return { hero: a.hero, playerName: a.playerName, mastery: a.mastery, masteryLabel: a.masteryLabel };
      }),
      lanePlan: plan,
      score: score,
      grade: reviewGrade(score),
      breakdown: {
        tier: round2(45 * tierNorm),
        structure: round2(25 * structureNorm),
        synergy: round2(15 * synergyNorm),
        matchup: round2(15 * matchupNorm)
      },
      dimensions: dim.dims,
      playstyle: style,
      core: core,
      synergies: syn.pairs,
      combos: reviewCombosOf(ctx, heroes),
      strengths: strengths,
      risks: risks,
      matchupPush: counters.push,
      matchupFear: counters.fear,
      bans: {
        ours: filterNames((ctx.bans && ctx.bans.ours) || []),
        theirs: filterNames((ctx.bans && ctx.bans.theirs) || [])
      }
    };
  }

  function reviewMatchupOf(ctx, ours, theirs, spec, idx) {
    var edge = function (key, label, a, b) {
      var lead = Math.abs(a - b) < 1e-9 ? 'even' : (a > b ? 'ours' : 'theirs');
      return { key: key, label: label, ours: round2(a), theirs: round2(b), lead: lead, note: '' };
    };
    var edges = [
      edge('score', '阵容强度', ours.score, theirs.score),
      edge('front', '前排', ours.dimensions[0].value, theirs.dimensions[0].value),
      edge('engage', '开团', ours.dimensions[1].value, theirs.dimensions[1].value),
      edge('protect', '保护', ours.dimensions[2].value, theirs.dimensions[2].value),
      edge('control', '控制', ours.dimensions[4].value, theirs.dimensions[4].value),
      edge('coreTier', '核心强度', ours.core ? tierW(ctx, ours.core.hero) : 0, theirs.core ? tierW(ctx, theirs.core.hero) : 0),
      edge('counter', '克制压力', ours.matchupPush || 0, theirs.matchupPush || 0)
    ];
    var scoreDiff = round2(ours.score - theirs.score);
    edges.forEach(function (e) {
      if (e.key === 'score') {
        e.note = scoreDiff === 0 ? '双方阵容强度持平'
          : (scoreDiff > 0 ? ('我方领先 ' + Math.abs(scoreDiff) + ' 分') : ('落后 ' + Math.abs(scoreDiff) + ' 分'));
      } else if (e.key === 'coreTier') {
        e.note = '按核心梯度权重比较（T0=10）';
      } else if (e.key === 'counter') {
        e.note = '双方互相克制的总量';
      } else {
        e.note = '我方 ' + e.ours + ' / 敌方 ' + e.theirs;
      }
    });
    var oursLead = 0;
    var theirsLead = 0;
    edges.forEach(function (e) {
      if (e.lead === 'ours') oursLead++;
      if (e.lead === 'theirs') theirsLead++;
    });
    var diff = ours.score - theirs.score;
    var verdict;
    if (diff >= 3 && oursLead >= theirsLead) {
      verdict = { key: 'ours', label: '我方小优', note: '阵容强度/结构/克制面占优，按方案执行即可。' };
    } else if (diff <= -3 && theirsLead >= oursLead) {
      verdict = { key: 'theirs', label: '敌方小优', note: '对面阵容更完整或克制面更足，先稳住不被滚雪球。' };
    } else if (oursLead - theirsLead >= 3) {
      verdict = { key: 'ours', label: '我方小优', note: '结构/克制面领先，按方案执行即可。' };
    } else if (theirsLead - oursLead >= 3) {
      verdict = { key: 'theirs', label: '敌方小优', note: '对面结构/克制面更足，先稳住不被滚雪球。' };
    } else {
      verdict = { key: 'even', label: '均势', note: '双方阵容接近，胜负更看执行和临场处理。' };
    }

    var threats = [];
    theirs.heroes.forEach(function (e) {
      var list = [];
      ours.heroes.forEach(function (h) {
        var w = counterAt(idx, ctx, e, h);
        if (w >= 0.4) list.push({ hero: h, w: w });
      });
      if (!list.length) return;
      list.sort(function (a, b) { return b.w - a.w; });
      threats.push({ hero: e, tier: tierOf(ctx, e), reason: '克我方 ' + list[0].hero + '（' + round2(list[0].w) + '）' });
    });
    threats.sort(function (a, b) { return tierW(ctx, b.hero) - tierW(ctx, a.hero); });

    var winConditions = [];
    var pk = ours.playstyle.key;
    if (pk === 'protect') winConditions.push('保核心输出，反手接团；别让对面先手开到核心');
    else if (pk === 'split') winConditions.push('边线施压，用传送/支援打人数差；避免无准备正面团');
    else if (pk === 'engage') winConditions.push('中期抱团强开，控龙逼团，不给对面拖后期');
    else if (pk === 'siege') winConditions.push('抱团推进，前排顶住让核心拆塔');
    else if (pk === 'poke') winConditions.push('远程压血线，拉扯后反打');
    else winConditions.push('按阵容强势点打，避免被拖入对面节奏');
    if (theirs.dimensions[1].value >= 2) winConditions.push('对面强开点多，先反手接团再打，不站太深');
    if (theirs.dimensions[2].value >= 1 && theirs.core) winConditions.push('对面有保护核心，优先分割/集火，别让核心舒服输出');
    if (spec) winConditions.push('按预选「' + spec.name + '」的分工执行，核心被 ban 就降级拿搭配');

    var tips = [];
    if (spec) {
      var missed = spec.threats.filter(function (t) { return t.level === 'must'; }).filter(function (t) { return presetStatusOf(ctx, t.hero) === 'available'; });
      if (missed.length) tips.push('预选必 ban 没执行：' + missed.map(function (t) { return t.hero; }).join('/') + ' 还在外面，注意站位');
      var coreHit = false;
      spec.core.forEach(function (h) { if (ours.heroes.indexOf(h) !== -1) coreHit = true; });
      if (coreHit) tips.push('预选核心已到手，按「' + spec.playstyle.label + '」保着打');
    }
    threats.slice(0, 3).forEach(function (t) { tips.push('注意敌方 ' + t.hero + '：' + t.reason); });
    ours.dimensions.forEach(function (d) {
      if (d.level !== 'ok') tips.push('我方缺' + d.label + '（' + d.detail + '），团战别硬接');
    });
    (ours.lanePlan.uncovered || []).forEach(function (l) {
      tips.push('我方「' + l + '」还没人覆盖，开局先协调换位/补位');
    });
    while (tips.length < 2) tips.push('按阵容强势点打，避免无准备团');

    return {
      verdict: verdict,
      edges: edges,
      threats: threats.slice(0, 3),
      winConditions: winConditions.slice(0, 4),
      tips: tips.slice(0, 5)
    };
  }

  function reviewPresetMatchOf(ctx, spec, plan) {
    if (!spec) {
      return { active: false, id: '', name: '', matchScore: null, coreHit: 0, coreTotal: 0, mustBansDone: 0, mustBansTotal: 0, partnerHit: 0, partnerTotal: 0, coreStatus: [], offPlan: [], notes: [] };
    }
    var ourPicks = knownPicksOf(ctx, ctx.store.side);
    var ourBans = filterNames((ctx.bans && ctx.bans.ours) || []);
    var coreHit = 0;
    var coreStatus = [];
    spec.core.forEach(function (h) {
      var owners = ownersOfHero(ctx, h);
      var status = presetStatusOf(ctx, h);
      if (status === 'available' && !owners.length) status = 'unavailable';
      var at = null;
      plan.core.forEach(function (c) {
        if (c.hero !== h) return;
        c.owners.forEach(function (o) { if (!at) at = o; });
      });
      if (ourPicks.indexOf(h) !== -1) coreHit++;
      coreStatus.push({ hero: h, status: status, playerName: at ? at.name : '' });
    });
    var mustBansDone = 0;
    var mustBansTotal = 0;
    spec.threats.forEach(function (t) {
      if (t.level !== 'must') return;
      mustBansTotal++;
      if (ourBans.indexOf(t.hero) !== -1) mustBansDone++;
    });
    var partnerHit = 0;
    spec.partners.forEach(function (p) { if (ourPicks.indexOf(p.hero) !== -1) partnerHit++; });
    var hasPartners = spec.partners.length > 0;
    var coreWeight = hasPartners ? 60 : 70;
    var partnerWeight = hasPartners ? 10 : 0;
    var matchScore = 0;
    if (spec.core.length) matchScore += coreWeight * coreHit / spec.core.length;
    if (mustBansTotal) matchScore += 30 * mustBansDone / mustBansTotal;
    if (hasPartners) matchScore += partnerWeight * partnerHit / spec.partners.length;
    matchScore = Math.round(matchScore);

    var offPlan = ourPicks.filter(function (h) {
      if (spec.core.indexOf(h) !== -1) return false;
      var isPartner = false;
      spec.partners.forEach(function (p) { if (p.hero === h) isPartner = true; });
      return !isPartner;
    });
    var notes = [];
    if (coreHit === spec.core.length) notes.push('核心 ' + coreHit + '/' + spec.core.length + ' 全拿到');
    else notes.push('核心 ' + coreHit + '/' + spec.core.length + '，没拿到的核心需要降级方案');
    if (mustBansTotal) {
      if (mustBansDone === mustBansTotal) notes.push('必 ban ' + mustBansDone + '/' + mustBansTotal + ' 全部执行');
      else notes.push('必 ban ' + mustBansDone + '/' + mustBansTotal + '，漏掉的威胁要重点盯');
    }
    if (partnerHit) notes.push('搭配拿到 ' + partnerHit + '/' + spec.partners.length);
    if (offPlan.length) notes.push('偏出方案：' + offPlan.join('/'));

    return {
      active: true,
      id: spec.id,
      name: spec.name,
      matchScore: matchScore,
      coreHit: coreHit,
      coreTotal: spec.core.length,
      mustBansDone: mustBansDone,
      mustBansTotal: mustBansTotal,
      partnerHit: partnerHit,
      partnerTotal: spec.partners.length,
      coreStatus: coreStatus,
      offPlan: offPlan,
      notes: notes
    };
  }

  function teamReviewImpl(ctx) {
    var idx = relationIndex(ctx);
    var spec = presetSpecOf(ctx);
    var plan = presetPlanImpl(ctx);
    var total = picksOf(ctx, 'blue').length + picksOf(ctx, 'red').length;
    var done = total >= 10;
    var ours = sideReviewOf(ctx, ctx.store.side, spec, idx);
    var theirs = sideReviewOf(ctx, otherSide(ctx.store.side), spec, idx);
    var warnings = [];
    if (!done) warnings.push('BP 还没结束（' + total + '/10 手），当前是阶段性评价');
    if (!ctx.heroes.length) warnings.push('英雄数据为空，评分按 T2 估计');
    if (!ctx.meta || !ctx.meta.tiers || !Object.keys(ctx.meta.tiers).length) warnings.push('梯度数据为空，评分参考价值有限');
    return {
      done: done,
      date: (ctx.meta && ctx.meta.version) || null,
      side: ctx.store.side,
      ours: ours,
      theirs: theirs,
      matchup: reviewMatchupOf(ctx, ours, theirs, spec, idx),
      preset: reviewPresetMatchOf(ctx, spec, plan),
      warnings: warnings
    };
  }

  function teamReview(ctx) {
    try {
      return teamReviewImpl(workCtx(ctx));
    } catch (err) {
      return {
        done: false, date: null, side: 'blue',
        ours: null, theirs: null,
        matchup: { verdict: { key: 'even', label: '均势', note: '' }, edges: [], threats: [], winConditions: [], tips: [] },
        preset: { active: false, id: '', name: '', matchScore: null, notes: [] },
        warnings: ['队伍评价计算异常：' + (err && err.message ? err.message : String(err))]
      };
    }
  }

  /* ================= 工具导出 ================= */

  function counterOf(ctx, a, b) {
    try {
      var work = workCtx(ctx);
      return counterAt(relationIndex(work), work, a, b);
    } catch (err) { return 0; }
  }

  function synergyOf(ctx, a, b) {
    try {
      var work = workCtx(ctx);
      return synergyAt(relationIndex(work), work, a, b);
    } catch (err) { return 0; }
  }

  function compNeedOfExport(ctx, hero, ally) {
    try {
      var work = workCtx(ctx);
      return compNeedOf(work, hero, filterNames(ally || []));
    } catch (err) { return 0; }
  }

  function lanePlanExport(ctx, heroNames) {
    try {
      return lanePlanOf(workCtx(ctx), filterNames(heroNames || []));
    } catch (err) { return emptyPlan(); }
  }

  return {
    VERSION: VERSION,
    LANES: LANES,
    LANE_ORDER: LANE_ORDER,
    PICK_SEQUENCE: PICK_SEQUENCE,
    TIER_WEIGHT: TIER_WEIGHT,
    TAG_SET: TAG_SET,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    SLOT_DEF: SLOT_DEF,
    MASTERY: MASTERY,
    MASTERY_ORDER: MASTERY_ORDER,
    PICK_PHASES: PICK_PHASES,
    CHECKS: CHECKS,

    normalizeStore: normalizeStore,
    currentStep: currentStep,
    pickPhase: pickPhase,
    banRecommend: banRecommend,
    pickRecommend: pickRecommend,
    lineupCheck: lineupCheck,
    analyzePool: analyzePool,
    lanePlan: lanePlanExport,

    // v2.4：赛前预选阵容 + 赛后队伍总体评价（契约 docs/feature-preset-review.md）
    presetPlan: presetPlan,
    teamReview: teamReview,
    presetsFromCombos: presetsFromCombos,

    counterOf: counterOf,
    synergyOf: synergyOf,
    compNeedOf: compNeedOfExport,
    tierOf: function (ctx, name) { try { return tierOf(workCtx(ctx), name); } catch (err) { return 'T2'; } },
    tierWeight: tierWeight
  };
});
