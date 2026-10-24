#!/usr/bin/env node
/**
 * tools/test-engine.mjs —— 决策引擎 v2 单元测试（零依赖，node 直接跑）
 *
 *   运行：node tools/test-engine.mjs
 *   断言依据：docs/engine-contract-v2.md §1（store v2）、§2（熟练度系数）、
 *             §4（各函数返回字段与评分公式）、§6（UI 行为口径）、
 *             docs/feature-preset-review.md §1/§2/§3/§5（预选阵容 + 队伍总体评价 v2.4）
 *
 * 覆盖点（v2.3，四轮反馈与引擎相关的部分）：
 *   - store v2 + v1→v2 迁移 + 容错（人数补齐 / floor 去重修正 / pool 非法熟练度）
 *   - 三档熟练度真实影响 ban 威胁（risk 0.45/1.0/1.9）与 pick 被克惩罚
 *   - Ban 强度主导（v2.1）：任何 T0 分数 > 吃满威胁的 T1；真实数据前 5 ban 全 T0
 *   - Ban 不再指派执行人（v2.2）：commands 无 playerName/floor/laneHints，理由不写「建议由谁」
 *   - Pick 分阶段（v2.1）：第 1-2 手先抢（强度优先）、第 3 手补强、第 4-5 手克制（克 T0 收益最高）
 *   - Pick 候选 = 全队池并集 + owners，且必须能补待补分路（v2.2），返回 laneState
 *   - Pick 一人一英雄（v2.3）：assignment/freePlayers/assignedTo/fielders，完整匹配按熟练度最优；
 *     候选必须能加入「已选 + 候选」的完整匹配；手动指定 ctx.assignments 作为硬约束（可回退 + warning）
 *   - 五路覆盖：lanePlan 按 roles+alt 判路、laneNeed 让能补缺路的英雄优先、跨路英雄算两路
 *   - analyzePool 全局按 hero 去重、合并 forPlayers、不推荐任何池内英雄
 *   - 空数据 / 空池 / 全被 ban / 空 ban 不抛异常且返回 warnings
 *
 * 覆盖点（v2.4，预选阵容 + 赛后总体评价；数据源 = data/combos.json + data/combo-bans.json）：
 *   - presetsFromCombos：AI 调研组合 + 用户实战必 ban 合并（必 ban → must，调研拆解点 → watch）
 *   - presetPlan：模板命中 / 自定义推导（partners/threats/playstyle/teamPlan）、core owners、progress
 *   - banRecommend 预选增量：must ban 强制排最前（即使在我方池里）、核心不 ban、preset/mustBan/presetWatch
 *   - pickRecommend 预选增量：第 1 手候选前二含核心、preset.role/breakdown.preset、分路与一人一英雄不变
 *   - teamReview：done/score/grade/dimensions/strengths/risks/breakdown/matchup/preset 匹配分
 *   - 无 presets / 无 preset / 空 ctx：新函数一律 active:false 且不抛异常
 *
 * 只读引擎，不修改实现文件。
 */

import { createRequire } from 'node:module';
import fs, { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.resolve(__dirname, '..', 'web', 'engine.js');

/* 真实存档是运行期数据（不进仓库）：缺失时回退 data/store.sample.json，保证 clone 后测试可直接跑。 */
function loadRealStoreRaw(root) {
  for (const f of ['store.json', 'store.sample.json']) {
    const p = path.join(root, 'data', f);
    if (fs.existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error('data/store.json 与 data/store.sample.json 都不存在');
}

/* ────────────────────────── 内嵌 fixture ──────────────────────────
 * 22 个英雄，覆盖 5 条分路；赵云是跨路英雄（jungle 主 + top 次）。
 * 我方 5 人：1 包(top) / 2 刘(adc) / 3 杜(mid) / 4 李(jungle,top) / 5 张(support)，
 * 每人池子带三档熟练度；张良/妲己/澜/韩信/鲁班七号/牛魔 等游离在池外，供 ban 用例。
 * 「测试射手/测试辅助」是合成英雄：T2、无标签、无关系，只用来隔离 laneNeed 的影响。
 */

const HEROES = [
  { id: 501, name: '露娜', roles: ['jungle'], alt: [], type: ['刺客', '战士'] },
  { id: 502, name: '镜', roles: ['jungle'], alt: [], type: ['刺客'] },
  { id: 503, name: '澜', roles: ['jungle'], alt: [], type: ['刺客'] },
  { id: 504, name: '兰陵王', roles: ['jungle'], alt: [], type: ['刺客'] },
  { id: 505, name: '赵云', roles: ['jungle'], alt: ['top'], type: ['战士', '刺客'] },
  { id: 506, name: '韩信', roles: ['jungle'], alt: [], type: ['刺客'] },
  { id: 507, name: '张良', roles: ['mid'], alt: [], type: ['法师'] },
  { id: 508, name: '妲己', roles: ['mid'], alt: [], type: ['法师'] },
  { id: 509, name: '王昭君', roles: ['mid'], alt: [], type: ['法师'] },
  { id: 510, name: '小乔', roles: ['mid'], alt: [], type: ['法师'] },
  { id: 511, name: '廉颇', roles: ['top'], alt: ['support'], type: ['坦克'] },
  { id: 512, name: '白起', roles: ['top'], alt: [], type: ['坦克'] },
  { id: 513, name: '吕布', roles: ['top'], alt: [], type: ['战士'] },
  { id: 514, name: '后羿', roles: ['adc'], alt: [], type: ['射手'] },
  { id: 515, name: '孙尚香', roles: ['adc'], alt: [], type: ['射手'] },
  { id: 516, name: '鲁班七号', roles: ['adc'], alt: [], type: ['射手'] },
  { id: 517, name: '张飞', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  { id: 518, name: '明世隐', roles: ['support'], alt: [], type: ['辅助'] },
  { id: 519, name: '东皇太一', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  { id: 520, name: '牛魔', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  { id: 601, name: '测试射手', roles: ['adc'], alt: [], type: ['射手'] },
  { id: 602, name: '测试辅助', roles: ['support'], alt: [], type: ['辅助'] },
];

const META = {
  version: '2026-10-24',
  source: 'fixture（内嵌，非真实数据）',
  tiers: {
    澜: { tier: 'T0', score: 58.2, role: '打野' },
    露娜: { tier: 'T0.5', score: 55.0, role: '打野' },
    吕布: { tier: 'T0.5', score: 55.4, role: '对抗路' },
    后羿: { tier: 'T1', score: 53.4, role: '发育路' },
    镜: { tier: 'T1', score: 52.4, role: '打野' },
    张良: { tier: 'T1', score: 51.8, role: '中路' },
    王昭君: { tier: 'T1', score: 50.2, role: '中路' },
    赵云: { tier: 'T1', score: 50.9, role: '打野/对抗路' },
    东皇太一: { tier: 'T2', score: 48.9, role: '游走' },
    张飞: { tier: 'T2', score: 48.0, role: '游走' },
    兰陵王: { tier: 'T2', score: 47.8, role: '打野' },
    廉颇: { tier: 'T2', score: 47.5, role: '对抗路/游走' },
    白起: { tier: 'T2', score: 47.0, role: '对抗路' },
    牛魔: { tier: 'T2', score: 47.1, role: '游走' },
    小乔: { tier: 'T2', score: 47.2, role: '中路' },
    韩信: { tier: 'T2', score: 47.6, role: '打野' },
    鲁班七号: { tier: 'T2', score: 46.8, role: '发育路' },
    孙尚香: { tier: 'T2', score: 48.2, role: '发育路' },
    明世隐: { tier: 'T3', score: 43.5, role: '游走' },
    妲己: { tier: 'T3', score: 44.1, role: '中路' },
    测试射手: { tier: 'T2', score: 47.0, role: '发育路' },
    测试辅助: { tier: 'T2', score: 47.0, role: '游走' },
  },
  tags: {
    露娜: ['位移', '爆发', '收割', '近战'],
    镜: ['位移', '爆发', '收割'],
    澜: ['位移', '爆发', '收割', '近战'],
    兰陵王: ['位移', '爆发', '收割'],
    赵云: ['位移', '爆发', '收割', '近战'],
    韩信: ['位移', '爆发', '收割'],
    张良: ['硬控', '控制', '法伤'],
    妲己: ['爆发', '控制', '法伤'],
    王昭君: ['控制', '法伤', '远程'],
    小乔: ['爆发', '法伤', '远程'],
    廉颇: ['前排', '开团', '控制', '近战'],
    白起: ['前排', '开团', '控制', '回复'],
    吕布: ['真伤', '爆发', '近战'],
    后羿: ['持续输出', '远程', '物伤'],
    孙尚香: ['爆发', '远程', '物伤'],
    鲁班七号: ['持续输出', '远程', '物伤'],
    张飞: ['前排', '开团', '保护', '近战'],
    明世隐: ['保护', '体系'],
    东皇太一: ['前排', '控制', '硬控'],
    牛魔: ['前排', '开团', '保护', '控制', '近战'],
    测试射手: [],
    测试辅助: [],
  },
  overrides: {},
};

const RELATIONS = {
  date: '2026-10-24',
  counters: [
    { a: '张良', b: '露娜', w: 0.8, matches: 420, idx: 4.2, src: 'stats' },
    { a: '张良', b: '镜', w: 0.7, matches: 380, idx: 3.6, src: 'stats' },
    { a: '东皇太一', b: '露娜', w: 0.6, matches: 260, idx: 2.9, src: 'stats' },
    { a: '妲己', b: '镜', w: 0.5, matches: 210, idx: 2.2, src: 'stats' },
    { a: '吕布', b: '白起', w: 0.7, matches: 300, idx: 3.3, src: 'stats' },
    { a: '兰陵王', b: '后羿', w: 0.75, matches: 350, idx: 3.9, src: 'stats' },
  ],
  synergies: [
    { a: '明世隐', b: '后羿', w: 0.6, matches: 310, idx: 2.9, src: 'stats' },
  ],
};

// v2 我方阵容（blue）：没有 lane 字段，只有 preferLanes + 三档熟练度池
const STORE = {
  version: 2,
  side: 'blue',
  players: [
    {
      id: 'p1', name: '包', floor: 1, preferLanes: ['top'],
      pool: [
        { hero: '廉颇', mastery: 'best' },
        { hero: '白起', mastery: 'normal' },
        { hero: '吕布', mastery: 'normal' },
      ],
    },
    {
      id: 'p2', name: '刘', floor: 2, preferLanes: ['adc'],
      pool: [
        { hero: '后羿', mastery: 'best' },
        { hero: '孙尚香', mastery: 'basic' },
      ],
    },
    {
      id: 'p3', name: '杜', floor: 3, preferLanes: ['mid'],
      pool: [
        { hero: '王昭君', mastery: 'normal' },
        { hero: '小乔', mastery: 'normal' },
      ],
    },
    {
      id: 'p4', name: '李', floor: 4, preferLanes: ['jungle', 'top'],
      pool: [
        { hero: '露娜', mastery: 'best' },
        { hero: '赵云', mastery: 'normal' },
        { hero: '镜', mastery: 'basic' },
        { hero: '兰陵王', mastery: 'normal' },
      ],
    },
    {
      id: 'p5', name: '张', floor: 5, preferLanes: ['support'],
      pool: [
        { hero: '张飞', mastery: 'normal' },
        { hero: '明世隐', mastery: 'basic' },
        { hero: '东皇太一', mastery: 'normal' },
      ],
    },
  ],
  allowCrossLane: true,
  weights: {},
  history: [],
};

/* ────────────────────────── helpers ────────────────────────── */

const clone = (v) => JSON.parse(JSON.stringify(v));

function mkCtx(over = {}) {
  const base = {
    heroes: clone(HEROES),
    meta: clone(META),
    relations: clone(RELATIONS),
    store: clone(STORE),
    bans: { ours: [], theirs: [] },
    picks: { blue: [], red: [] },
  };
  if (over.heroes) base.heroes = clone(over.heroes);
  if (over.meta) base.meta = clone(over.meta);
  if (over.relations) base.relations = clone(over.relations);
  if (over.store) base.store = Object.assign(base.store, clone(over.store));
  if (over.bans) base.bans = Object.assign({ ours: [], theirs: [] }, clone(over.bans));
  if (over.picks) base.picks = Object.assign({ blue: [], red: [] }, clone(over.picks));
  // v2.4：模板库始终透传（preset 缺省 null → 新函数必须返回 active:false，原有 ban/pick 行为不变）
  base.presets = over.presets !== undefined ? clone(over.presets) : clone(PRESETS);
  base.preset = over.preset === undefined ? null : (over.preset === null ? null : clone(over.preset));
  return clone(base);
}

/* ────────────────────────── v2.4 预选 fixture（combos 口径） ──────────────────────────
 * 数据源（2026-10-24 用户补充：组合/克制资料已由 AI 调研好，测试不要再自己编）：
 *   data/combos.json      —— 34 套 AI 调研组合（id/name/size/priority/core/flex/lanes/
 *                            why/banTargets/counteredBy/confidence/stats/sources/type/phase）
 *   data/combo-bans.json  —— 用户实战补充的「必 ban」（overrides[id].mustBans）
 * 引擎 HOKEngine.presetsFromCombos(combosData, overridesData) 把两者适配成 preset 结构
 * （core 可 2-5 个；额外字段 size/priority/type/phase/why/lanes/banTargets/counteredBy/
 * confidence/stats/sources/flex）；服务端 /api/presets 走同一条链路。
 *
 * 这里只放「最小 combos fixture」（结构与 data/combos.json 完全一致），不再手写整份 preset 模板；
 * PRESETS 在引擎加载后由 presetsFromCombos 生成。
 * 额外英雄只加在 PRESET_* 里，避免改动上面 v2.3 用例的 hero/meta/relations/store。
 * 我方池（PRESET_STORE）额外包含：鲁班七号(刘/发育路)、盾山(张/游走/绝活)、
 * 钟馗(张/游走，必 ban 却在我方池)、鲁班大师(包/游走，flex 搭配位)。
 */

const COMBOS_FIXTURE = {
  version: 1,
  date: '2026-10-24',
  source: 'fixture（最小 combos，结构同 data/combos.json）',
  note: '组合与克制结论来自 AI 调研；用户实战必 ban 见 COMBO_BANS_FIXTURE。',
  priorityWeights: { S: 1.6, A: 1.2, B: 0.8 },
  comps: [
    {
      id: 'jiangwang-boshi',
      name: '僵王博士（鲁班七号 + 盾山）',
      size: 2,
      priority: 'A',
      type: '移动扫射 / 射辅连体',
      phase: '全期，对线强度 T0.5 起步',
      core: ['鲁班七号', '盾山'],
      flex: { 盾山: ['鲁班大师'] },
      lanes: { 发育路: ['鲁班七号'], 游走: ['盾山'] },
      why: '盾山一技能可带鲁班穿墙并边移动边扫射，解决扫射罚站。',
      banTargets: ['盾山'],
      counteredBy: ['吕布', '貂蝉', '镜', '澜'],
      confidence: 'high',
      stats: { idx: 3.88, matches: 6765 },
      sources: ['https://example.com/fixture-jiangwang'],
    },
    {
      id: 'jing-zhangfei',
      name: '镜 + 张飞',
      size: 2,
      priority: 'B',
      type: '强开冲阵',
      phase: '中期',
      core: ['镜', '张飞'],
      flex: {},
      lanes: { 打野: ['镜'], 游走: ['张飞'] },
      why: '中期抱团强开，镜后手进场收割。',
      banTargets: [],
      counteredBy: ['东皇太一', '妲己'],
      confidence: 'medium',
      stats: { idx: null, matches: 0 },
      sources: [],
    },
  ],
};

// 用户实战补充的「必 ban」（结构同 data/combo-bans.json）：只覆盖僵王博士
const COMBO_BANS_FIXTURE = {
  version: 1,
  date: '2026-10-24',
  note: '用户实战必 ban（fixture）',
  overrides: {
    'jiangwang-boshi': {
      combo: '僵王博士（鲁班七号 + 盾山）',
      mustBans: [
        { hero: '墨子', reason: '远程炮击 + 超远控制，盾山举盾也挡不住鲁班被磨血；必须 ban（用户实战）' },
        { hero: '王昭君', reason: '大招封路 + 冰冻硬控，鲁班站桩输出被冻住直接崩；必须 ban（用户实战）' },
        { hero: '钟馗', reason: '钩子能把鲁班从盾山身后勾出来；必须 ban（用户实战）' },
      ],
    },
  },
};

// 引擎加载后由 API.presetsFromCombos(COMBOS_FIXTURE, COMBO_BANS_FIXTURE) 生成（与 /api/presets 同链路）
let PRESETS = [];

const PRESET_EXTRA_HEROES = [
  { id: 527, name: '盾山', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  { id: 528, name: '墨子', roles: ['mid'], alt: [], type: ['法师'] },
  { id: 529, name: '钟馗', roles: ['support'], alt: [], type: ['坦克', '辅助'] },
  { id: 530, name: '鲁班大师', roles: ['support'], alt: [], type: ['辅助'] },
  { id: 531, name: '貂蝉', roles: ['mid'], alt: [], type: ['法师', '刺客'] },
];

const PRESET_HEROES = HEROES.concat(PRESET_EXTRA_HEROES);

const PRESET_META = clone(META);
Object.assign(PRESET_META.tiers, {
  盾山: { tier: 'T2', score: 47.5, role: '游走' },
  墨子: { tier: 'T2', score: 47.0, role: '中路' },
  钟馗: { tier: 'T2', score: 46.5, role: '游走' },
  // fixture 把搭配位设为 T1，保证它在候选前 6（搭配加分本身很小，避免与 T1 打野贴脸）
  鲁班大师: { tier: 'T1', score: 50.5, role: '游走' },
  貂蝉: { tier: 'T1', score: 50.8, role: '中路' },
});
Object.assign(PRESET_META.tags, {
  盾山: ['前排', '保护', '开团'],
  墨子: ['控制', '远程', '法伤'],
  钟馗: ['硬控', '控制', '前排'],
  鲁班大师: ['保护', '体系', '前排'],
  貂蝉: ['爆发', '法伤', '近战'],
});

const PRESET_RELATIONS = {
  date: RELATIONS.date,
  counters: clone(RELATIONS.counters).concat([
    { a: '墨子', b: '鲁班七号', w: 0.7, matches: 260, idx: 2.8, src: 'stats' },
    { a: '钟馗', b: '鲁班七号', w: 0.8, matches: 280, idx: 3.1, src: 'stats' },
    { a: '王昭君', b: '鲁班七号', w: 0.65, matches: 240, idx: 2.6, src: 'stats' },
    { a: '兰陵王', b: '鲁班七号', w: 0.6, matches: 220, idx: 2.4, src: 'stats' },
    { a: '东皇太一', b: '盾山', w: 0.55, matches: 200, idx: 2.2, src: 'stats' },
    { a: '张良', b: '盾山', w: 0.5, matches: 190, idx: 2.1, src: 'stats' },
  ]),
  synergies: clone(RELATIONS.synergies).concat([
    { a: '鲁班大师', b: '鲁班七号', w: 0.75, matches: 330, idx: 3.0, src: 'stats' },
    { a: '盾山', b: '鲁班七号', w: 0.55, matches: 240, idx: 2.4, src: 'stats' },
    { a: '张飞', b: '鲁班七号', w: 0.5, matches: 210, idx: 2.2, src: 'stats' },
  ]),
};

const PRESET_STORE = clone(STORE);
PRESET_STORE.players[0].pool.push({ hero: '鲁班大师', mastery: 'normal' }); // 包（游走）= flex 搭配位
PRESET_STORE.players[1].pool.push({ hero: '鲁班七号', mastery: 'normal' }); // 刘（发育路）= 预选核心 1
PRESET_STORE.players[4].pool.push({ hero: '盾山', mastery: 'best' });       // 张（游走）= 预选核心 2
PRESET_STORE.players[4].pool.push({ hero: '钟馗', mastery: 'normal' });     // 必 ban 威胁却在我方池里

const PRESET_LANES = ['top', 'jungle', 'mid', 'adc', 'support'];
const GRADE_KEYS = ['S', 'A', 'B', 'C', 'D'];
const GRADE_TONES = ['good', 'ok', 'bad'];
const DIM_KEYS = ['front', 'engage', 'protect', 'damage', 'control'];

function mkPresetCtx(over = {}) {
  const ctx = {
    heroes: clone(PRESET_HEROES),
    meta: clone(PRESET_META),
    relations: clone(PRESET_RELATIONS),
    store: clone(PRESET_STORE),
    bans: { ours: [], theirs: [] },
    picks: { blue: [], red: [] },
    presets: clone(PRESETS),
    preset: { id: 'jiangwang-boshi' },
  };
  if (over.heroes) ctx.heroes = clone(over.heroes);
  if (over.meta) ctx.meta = clone(over.meta);
  if (over.relations) ctx.relations = clone(over.relations);
  if (over.store) ctx.store = clone(over.store);
  if (over.bans) ctx.bans = Object.assign({ ours: [], theirs: [] }, clone(over.bans));
  if (over.picks) ctx.picks = Object.assign({ blue: [], red: [] }, clone(over.picks));
  if (over.presets !== undefined) ctx.presets = clone(over.presets);
  if (over.preset !== undefined) ctx.preset = over.preset === null ? null : clone(over.preset);
  return ctx;
}

const heroList = (arr) => (arr || []).map((x) => (typeof x === 'string' ? x : x && x.hero));

const withMastery = (store, playerIndex, mastery) => {
  const s = clone(store);
  s.players[playerIndex].pool = s.players[playerIndex].pool.map((e) => ({
    hero: e.hero,
    mastery: typeof mastery === 'function' ? mastery(e) : mastery,
  }));
  return s;
};

/* ────────────────────────── 极简测试框架 ────────────────────────── */

const results = [];

function snip(v, n = 320) {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) s = String(v);
  return s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字符）` : s;
}
function fail(msg) { throw new Error(msg); }
function ok(cond, msg) { if (!cond) fail(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}：期望 ${snip(expected)}，实测 ${snip(actual)}`);
}
function near(actual, expected, eps, label) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    fail(`${label}：期望 ≈${expected}（容差 ±${eps}），实测 ${snip(actual)}`);
  }
}
function isArr(v, label) {
  if (!Array.isArray(v)) fail(`${label}：期望数组，实测 ${typeof v} ${snip(v)}`);
}
function isObj(v, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label}：期望对象，实测 ${snip(v)}`);
}
function isNum(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${label}：期望有限数字，实测 ${snip(v)}`);
}
function isStr(v, label) {
  if (typeof v !== 'string' || v.length === 0) fail(`${label}：期望非空字符串，实测 ${snip(v)}`);
}
function uniq(arr) { return new Set(arr).size === arr.length; }

function t(name, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${name}`);
    if (detail) console.log(`      ${detail}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message, ms: Date.now() - started });
    console.log(`FAIL  ${name}`);
    console.log(`      ↳ ${err.message}`);
  }
}

const r1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : n);
const banOrder = (res) =>
  (res.commands || [])
    .map((c, i) => `${i + 1}.${c.playerName || `#${c.playerIndex}`}(${c.floor}楼)/${(c.laneHints || []).join('+') || '?'}/${c.hero}(${r1(c.score)})`)
    .join('  ');
const banOrderV22 = (res) =>
  (res.commands || [])
    .map((c, i) => `${i + 1}.${c.tier} ${c.hero}(${r1(c.score)})`)
    .join('  ');
const candNames = (res, n = 20) =>
  (res.candidates || []).slice(0, n).map((c) => `${c.hero}/${c.mastery}(${r1(c.score)})`).join(' ');
const findCand = (res, hero) => (res.candidates || []).find((c) => c.hero === hero);

/* ────────────────────────── 加载引擎 ────────────────────────── */

let API = null;
try {
  API = require(ENGINE_PATH);
} catch (err) {
  console.error(`FAIL  [load] 无法加载引擎 ${ENGINE_PATH}`);
  console.error(`      ↳ ${err.message}`);
  process.exit(1);
}
if (API && !API.banRecommend && API.default) API = API.default;
const REQUIRED = ['banRecommend', 'pickRecommend', 'lineupCheck', 'analyzePool', 'currentStep',
  'normalizeStore', 'lanePlan', 'counterOf', 'synergyOf', 'compNeedOf', 'tierOf', 'tierWeight',
  'presetPlan', 'teamReview', 'presetsFromCombos'];
const missing = REQUIRED.filter((k) => typeof API?.[k] !== 'function');
if (missing.length) {
  console.error(`FAIL  [load] 引擎缺少契约 §4 要求的 API：${missing.join(', ')}`);
  console.error(`      实测导出键 = ${snip(Object.keys(API || {}))}`);
  process.exit(1);
}
/* v2.4：preset 库由 combos + 用户必 ban 生成（与 server.mjs 的 /api/presets 同一条链路） */
try {
  PRESETS = API.presetsFromCombos(clone(COMBOS_FIXTURE), clone(COMBO_BANS_FIXTURE));
} catch (err) {
  console.error(`FAIL  [load] presetsFromCombos 抛异常：${err.message}`);
  process.exit(1);
}
if (!Array.isArray(PRESETS) || PRESETS.length === 0) {
  console.error('FAIL  [load] presetsFromCombos 未返回非空数组（combos fixture 或实现有问题）');
  process.exit(1);
}
console.log(`引擎：${ENGINE_PATH}\n契约：docs/engine-contract-v2.md §1/§2/§4\n`);

/* ===================== a) v1 → v2 迁移 ===================== */

t('[a] normalizeStore：v1 {lane,pool:[string]} → v2 {preferLanes,pool:[{hero,mastery}]}', () => {
  const v1 = {
    side: 'red',
    players: [
      { lane: 'top', name: '包', floor: 1, pool: ['夏洛特', '曹操'] },
      { lane: 'jungle', name: '李', floor: 2, pool: ['澜'] },
    ],
    allowCrossLane: false,
    weights: { tier: 2 },
    history: [{ at: 1 }],
  };
  const rawSnapshot = JSON.stringify(v1);
  const s = API.normalizeStore(v1);

  eq(s.version, 2, 'version 应为 2');
  eq(s.side, 'red', 'side 保留');
  eq(s.players.length, 5, 'players 不足 5 人应补齐');
  eq(s.allowCrossLane, false, 'allowCrossLane 保留');
  eq(s.weights.tier, 2, 'weights 保留');
  eq(s.history.length, 1, 'history 保留');

  const p0 = s.players[0];
  eq(p0.preferLanes.join(','), 'top', 'v1 lane → preferLanes');
  eq(p0.lane, undefined, 'v2 不应再有 lane 字段');
  isObj(p0.pool[0], 'v1 字符串池条目 → v2 对象');
  eq(p0.pool[0].hero, '夏洛特', 'pool[0].hero');
  eq(p0.pool[0].mastery, 'normal', 'v1 迁移默认 mastery=normal');
  eq(p0.pool[1].hero, '曹操', 'pool[1].hero');
  eq(JSON.stringify(v1), rawSnapshot, 'normalizeStore 不应修改入参');
  return `5 人 floor=${s.players.map((p) => p.floor).join('/')}，包池=${snip(p0.pool)}`;
});

/* ===================== b) normalizeStore 容错 ===================== */

t('[b] normalizeStore：floor 重复/越界修正、池去重、非法 mastery 归 normal、preferLanes 截断', () => {
  const weird = {
    players: [
      {
        name: '甲', floor: 1, preferLanes: ['top', 'mid', 'adc'],
        pool: [
          '露娜',
          { hero: '镜', mastery: 'best' },
          { hero: '镜', mastery: 'basic' },
          { hero: '', mastery: 'x' },
          { name: '澜', mastery: 'god' },
        ],
      },
      { name: '乙', floor: 1, pool: [] },        // floor 与甲重复
      { name: '丙', floor: 9, pool: ['不存在'] }, // floor 越界
    ],
  };
  const s = API.normalizeStore(weird);
  eq(s.players.length, 5, 'players 补齐到 5');
  const floors = s.players.map((p) => p.floor);
  eq(uniq(floors), true, `floor 必须互不重复，实测 ${snip(floors)}`);
  eq(clone(floors).sort((a, b) => a - b).join(','), '1,2,3,4,5', `floor 应为 1..5，实测 ${snip(floors)}`);
  eq(s.players[0].floor, 1, '合法 floor 优先保留');
  eq(s.players[1].floor, 2, '重复 floor 顺延');
  eq(s.players[2].floor, 3, '越界 floor 重排');

  eq(s.players[0].preferLanes.join(','), 'top,mid', 'preferLanes 去重且最多 2 条');
  const pool = s.players[0].pool;
  eq(pool.length, 3, `池条目应去重/去空（露娜、镜、澜），实测 ${snip(pool)}`);
  eq(pool[0].mastery, 'normal', '字符串条目 → normal');
  eq(pool[1].mastery, 'best', '同一 hero 重复出现时保留首次出现的熟练度');
  eq(pool[2].hero, '澜', 'name 字段兼容为 hero');
  eq(pool[2].mastery, 'normal', '非法 mastery 归 normal');
  return `floors=${snip(floors)}，甲池=${snip(pool)}`;
});

/* ===================== c) ban 指令：不再指派执行人 ===================== */

t('[c] ban（v2.2）：commands 只含英雄/强度/理由，不再有 playerName/floor/laneHints', () => {
  const ctx = mkCtx();
  const res = API.banRecommend(ctx);
  isArr(res.commands, 'ban.commands');
  eq(res.commands.length, 5, `应给出 5 条 ban 指令，实测 ${res.commands.length}`);

  const names = res.commands.map((c) => c.hero);
  eq(uniq(names), true, `指令英雄应互不重复，实测 ${snip(names)}`);
  for (const c of res.commands) {
    // v2.2：不再指派「谁去 ban」
    ok(!('playerIndex' in c), `${c.hero}.playerIndex 不应再返回（v2.2 取消指派）`);
    ok(!('playerName' in c), `${c.hero}.playerName 不应再返回（v2.2 取消指派）`);
    ok(!('floor' in c), `${c.hero}.floor 不应再返回（v2.2 取消指派）`);
    ok(!('laneHints' in c), `${c.hero}.laneHints 不应再返回（v2.2 取消指派）`);
    ok(!/建议由|谁去 ban|由.+去 ban/.test(c.reason), `${c.hero}.reason 不应出现执行人/建议由：${c.reason}`);
    isStr(c.hero, 'command.hero');
    isStr(c.tier, 'command.tier');
    isNum(c.score, 'command.score');
    isArr(c.alternatives, `${c.hero}.alternatives`);
    ok(c.alternatives.length <= 3, `alternatives 最多 3 条，实测 ${c.alternatives.length}`);
    isObj(c.breakdown, `${c.hero}.breakdown`);
    for (const key of ['tier', 'threat', 'fragility', 'answerable']) {
      isNum(c.breakdown[key], `${c.hero}.breakdown.${key}`);
    }
    ok('worstHero' in c.breakdown, `${c.hero}.breakdown 缺 worstHero`);
    ok('worstPlayerName' in c.breakdown, `${c.hero}.breakdown 缺 worstPlayerName`);
    isStr(c.reason, `${c.hero}.reason`);
  }
  // 仍按 score 降序
  for (let i = 1; i < res.commands.length; i += 1) {
    ok(res.commands[i - 1].score >= res.commands[i].score,
      `commands 未按分数降序：${res.commands[i - 1].hero}(${res.commands[i - 1].score}) < ${res.commands[i].hero}(${res.commands[i].score})`);
  }
  return `指令：${banOrderV22(res)}`;
});

/* ===================== d) ban 排除我方池 ===================== */

t('[d] ban：我方池内英雄不进候选（commands/shortlist/alternatives）', () => {
  const ctx = mkCtx();
  const res = API.banRecommend(ctx);
  const pool = new Set(ctx.store.players.flatMap((p) => p.pool.map((e) => e.hero)));
  ok(pool.size > 0, 'fixture 错误：我方池为空');

  const leakedCmd = res.commands.filter((c) => pool.has(c.hero)).map((c) => c.hero);
  ok(leakedCmd.length === 0, `我方池英雄被当成 ban 目标：${snip(leakedCmd)}`);
  const leakedShort = (res.shortlist || []).filter((s) => pool.has(s.hero)).map((s) => s.hero);
  ok(leakedShort.length === 0, `shortlist 出现池内英雄：${snip(leakedShort)}`);
  const leakedAlt = res.commands.flatMap((c) => (c.alternatives || []).filter((a) => pool.has(a.hero)).map((a) => a.hero));
  ok(leakedAlt.length === 0, `alternatives 出现池内英雄：${snip(leakedAlt)}`);
  eq((res.shortlist || []).length, 8, `shortlist 应为全局前 8，实测 ${(res.shortlist || []).length}`);
  return `候选 = ${snip((res.shortlist || []).map((s) => s.hero))}`;
});

/* ===================== e) ban 威胁受熟练度影响 ===================== */

t('[e] ban：熟练度 risk 影响 threat（basic 池的 threat 应为 best 池的 1.9/0.45≈4.22 倍），且指派给 4 楼李', () => {
  // 把 T0 澜放进 4 楼李自己的池（既不进 ban 候选，也让李成为张良唯一的高暴露目标），
  // 否则 best 场景里澜会先抢走 4 楼李、张良顺延给别人，无法断言归属人。
  const base = clone(STORE);
  base.players[3].pool.push({ hero: '澜', mastery: 'normal' });
  const ctxBest = mkCtx({ store: withMastery(base, 3, 'best') });
  const ctxBasic = mkCtx({ store: withMastery(base, 3, 'basic') });
  const best = API.banRecommend(ctxBest);
  const basic = API.banRecommend(ctxBasic);

  const bestCmd = best.commands.find((c) => c.hero === '张良');
  const basicCmd = basic.commands.find((c) => c.hero === '张良');
  ok(bestCmd, `best 场景指令里没有张良：${banOrder(best)}`);
  ok(basicCmd, `basic 场景指令里没有张良：${banOrder(basic)}`);

  eq(bestCmd.playerName, undefined, 'v2.2 指令不应再有 playerName');
  eq(bestCmd.floor, undefined, 'v2.2 指令不应再有 floor');
  eq(bestCmd.breakdown.worstPlayerName, '李', 'breakdown.worstPlayerName 应为被克最狠的池主（仅展示用）');
  eq(bestCmd.breakdown.worstHero, '露娜', `worstHero 应为被克最狠的露娜，实测 ${bestCmd.breakdown.worstHero}`);
  ok(bestCmd.breakdown.threat > 0, 'threat 应大于 0');
  near(basicCmd.breakdown.threat / bestCmd.breakdown.threat, 1.9 / 0.45, 0.12,
    'basic/best 的 threat 比值应等于 risk 比值 1.9/0.45');
  return `张良 threat：best=${bestCmd.breakdown.threat}，basic=${basicCmd.breakdown.threat}，比值=${(basicCmd.breakdown.threat / bestCmd.breakdown.threat).toFixed(2)}`;
});

/* ===================== f) pick 候选：全队池并集 + owners ===================== */

t('[f] pick（v2.1）：候选是全队池并集的子集、跨多个玩家池，owners 取最高熟练度', () => {
  // 累计 4 手 → 第 5 手（index 4）= 蓝方 3 楼杜；但候选来自全队 5 个池
  const ctx = mkCtx({
    picks: { blue: ['廉颇', '王昭君'], red: ['妲己', '澜'] },
  });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 4, 'step.index');
  eq(res.step.isOurs, true, 'step.isOurs');
  eq(res.step.floor, 3, 'step.floor（回合归属，但候选不再受楼层限制）');
  eq(res.step.playerIndex, 2, 'step.playerIndex 仍按 floor 查（仅 UI 展示用）');

  // 1) 候选必须是「全队 5 个池的并集」的子集（不是只读当前楼层玩家的池），且英雄去重
  const union = new Set();
  ctx.store.players.forEach((p) => p.pool.forEach((e) => union.add(e.hero)));
  ok(res.candidates.length > 0, `候选为空：${snip(res.warnings)}`);
  const outside = res.candidates.filter((c) => !union.has(c.hero)).map((c) => c.hero);
  ok(outside.length === 0, `候选出现池外英雄：${snip(outside)}（并集=${snip([...union])}）`);
  eq(uniq(res.candidates.map((c) => c.hero)), true, '候选英雄应去重');

  // 2) 候选至少覆盖 2 个不同玩家的池（全队并集，而非单楼层）
  const ownerIdx = new Set(res.candidates.map((c) => c.ownerIndex));
  ok(ownerIdx.size >= 2, `候选应来自 ≥2 个不同玩家的池（全队并集），实测 ${snip([...ownerIdx])}`);
  const ownersPlayers = new Set();
  res.candidates.forEach((c) => c.owners.forEach((o) => ownersPlayers.add(o.playerIndex)));
  ok(ownersPlayers.size >= 2, `owners 覆盖的玩家应 ≥2，实测 ${snip([...ownersPlayers])}`);

  // 2.5) v2.2 laneState：已覆盖/待补（我方已选 廉颇 top + 王昭君 mid → 待补 jungle/adc/support）
  isObj(res.laneState, 'pick.laneState');
  isArr(res.laneState.covered, 'laneState.covered');
  isArr(res.laneState.open, 'laneState.open');
  ok(res.laneState.covered.length > 0, `laneState.covered 应非空，实测 ${snip(res.laneState.covered)}`);
  ok(res.laneState.open.length > 0, `本手待补分路应非空，实测 ${snip(res.laneState.open)}`);
  eq(res.laneState.open.length + res.laneState.covered.length, 5, 'covered + open 应恰好是五路');

  // 2.6) v2.3 一人一英雄：assignment / freePlayers
  isArr(res.assignment, 'pick.assignment');
  eq(res.assignment.length, 2, `我方已选 2 个英雄应各分配到 1 人，实测 ${snip(res.assignment)}`);
  const assignedPlayers = res.assignment.map((a) => a.playerIndex);
  eq(uniq(assignedPlayers), true, `assignment 里玩家不能重复，实测 ${snip(assignedPlayers)}`);
  res.assignment.forEach((a) => {
    isStr(a.hero, 'assignment.hero');
    isNum(a.playerIndex, 'assignment.playerIndex');
    isStr(a.playerName, 'assignment.playerName');
    eq(typeof a.manual, 'boolean', `${a.hero}.manual 应为布尔`);
    ok(ctx.store.players[a.playerIndex].pool.some((e) => e.hero === a.hero),
      `${a.hero} 不在 ${a.playerName} 的池里`);
  });
  isArr(res.freePlayers, 'pick.freePlayers');
  eq(res.freePlayers.length, 5 - res.assignment.length, 'freePlayers 应等于未分配玩家数');
  res.freePlayers.forEach((p) => {
    isNum(p.playerIndex, 'freePlayers.playerIndex');
    isStr(p.name, 'freePlayers.name');
    isArr(p.preferLanes, 'freePlayers.preferLanes');
  });

  // 3) 每张候选的字段与 owners 契约
  for (const c of res.candidates) {
    isArr(c.owners, `${c.hero}.owners`);
    ok(c.owners.length >= 1, `${c.hero}.owners 不应为空`);
    // owners 按 best>normal>basic 从高到低
    const ranks = c.owners.map((o) => API.MASTERY_ORDER.indexOf(o.mastery));
    let ordered = true;
    for (let i = 1; i < ranks.length; i += 1) if (ranks[i - 1] > ranks[i]) ordered = false;
    ok(ordered, `${c.hero}.owners 未按熟练度降序：${snip(c.owners)}`);
    for (const o of c.owners) {
      isNum(o.playerIndex, `${c.hero}.owners[].playerIndex`);
      isStr(o.name, `${c.hero}.owners[].name`);
      ok(API.MASTERY_ORDER.includes(o.mastery), `${c.hero}.owners[].mastery 非法：${snip(o.mastery)}`);
      isStr(o.masteryLabel, `${c.hero}.owners[].masteryLabel`);
    }
    // 兼容字段 = owners[0]（熟练度最高的人）
    eq(c.ownerIndex, c.owners[0].playerIndex, `${c.hero}.ownerIndex = owners[0].playerIndex`);
    eq(c.ownerName, c.owners[0].name, `${c.hero}.ownerName = owners[0].name`);
    eq(c.mastery, c.owners[0].mastery, `${c.hero}.mastery = owners[0].mastery（取最高档）`);
    eq(c.masteryLabel, c.owners[0].masteryLabel, `${c.hero}.masteryLabel = owners[0].masteryLabel`);
    isNum(c.heroId, `${c.hero}.heroId`);
    isArr(c.lanes, `${c.hero}.lanes`);
    isArr(c.tags, `${c.hero}.tags`);
    // v2.2：待补分路非空时，候选必须能补至少一条
    if (res.laneState.open.length) {
      const openLabels = res.laneState.open;
      ok(c.lanes.some((l) => openLabels.includes(l)),
        `${c.hero} 不能补任何待补分路（open=${snip(openLabels)}，lanes=${snip(c.lanes)}）`);
    }
    isStr(c.reason, `${c.hero}.reason`);
    ok(c.reason.includes('去打'), `${c.hero}.reason 应含「由 X（熟练度）去打」：${c.reason}`);
    ok(!c.reason.includes('可打：'), `${c.hero}.reason 不应再列「可打：所有人」：${c.reason}`);
    // v2.3：assignedTo / fielders
    isObj(c.assignedTo, `${c.hero}.assignedTo`);
    isNum(c.assignedTo.playerIndex, `${c.hero}.assignedTo.playerIndex`);
    isStr(c.assignedTo.name, `${c.hero}.assignedTo.name`);
    ok(API.MASTERY_ORDER.includes(c.assignedTo.mastery), `${c.hero}.assignedTo.mastery 非法`);
    isStr(c.assignedTo.masteryLabel, `${c.hero}.assignedTo.masteryLabel`);
    isArr(c.fielders, `${c.hero}.fielders`);
    ok(c.fielders.length >= 1, `${c.hero}.fielders 至少含 assignedTo`);
    ok(c.fielders.some((f) => f.playerIndex === c.assignedTo.playerIndex),
      `${c.hero}.fielders 应包含 assignedTo（${c.assignedTo.name}）：${snip(c.fielders)}`);
    eq(uniq(c.fielders.map((f) => f.playerIndex)), true, `${c.hero}.fielders 玩家应去重`);
    // assignedTo 必须是「已选 + 本候选」完整匹配里的一个人，且其池里有该英雄
    ok(ctx.store.players[c.assignedTo.playerIndex].pool.some((e) => e.hero === c.hero),
      `${c.hero} 的 assignedTo（${c.assignedTo.name}）池里没有该英雄`);
    // v2.1 breakdown 去掉了 slot
    for (const key of ['tier', 'counter', 'countered', 'synergy', 'compNeed', 'laneNeed', 'mastery']) {
      isNum(c.breakdown[key], `${c.hero}.breakdown.${key}`);
    }
    ok(!('slot' in c.breakdown), `${c.hero}.breakdown 不应再有 slot（v2.1 改为 phase）`);
  }

  // 4) 同一英雄多人拥有：owners 合并、按熟练度降序、mastery 取最高档
  //    专用 store：后羿同时在 刘(best) 与 包(normal) 池里 → 唯一候选，保证一定测得到
  const storeOverlap = clone(STORE);
  storeOverlap.players[0].pool = [{ hero: '后羿', mastery: 'normal' }];
  storeOverlap.players[1].pool = [{ hero: '后羿', mastery: 'best' }];
  storeOverlap.players[2].pool = [];
  storeOverlap.players[3].pool = [];
  storeOverlap.players[4].pool = [];
  const overlapRes = API.pickRecommend(mkCtx({ store: storeOverlap }));
  const hy = findCand(overlapRes, '后羿');
  ok(hy, `后羿应在候选里：${candNames(overlapRes)}`);
  eq(hy.owners.length, 2, `后羿 owners 应合并为 2 人（刘+包），实测 ${snip(hy.owners)}`);
  eq(hy.owners.map((o) => o.name).join('/'), '刘/包', 'owners 应按熟练度降序：刘(best) 在 包(normal) 前');
  eq(hy.ownerIndex, 1, '后羿 ownerIndex 应取熟练度最高的刘（playerIndex=1）');
  eq(hy.ownerName, '刘', '熟练度最高的 owner 应为刘(best)');
  eq(hy.mastery, 'best', '后羿 mastery 取最高档 best');
  eq(hy.masteryLabel, '绝活', 'masteryLabel 应为绝活');
  // v2.3：唯一候选 → 由熟练度最高的刘去打
  eq(hy.assignedTo.name, '刘', '后羿应分配给熟练度最高的刘');
  eq(hy.assignedTo.mastery, 'best', 'assignedTo 熟练度应为 best');
  eq(hy.fielders.map((f) => f.name).join('/'), '刘', '唯一最优匹配 → fielders 只有刘');
  return `候选(${res.candidates.length})：${candNames(res)}；后羿 owners=${snip(hy.owners.map((o) => `${o.name}(${o.masteryLabel})`))}`;
});

/* ===================== g) pick 被克惩罚受熟练度影响 ===================== */

t('[g] pick：countered 惩罚按 risk 放大（basic≈1.9×normal，best≈0.45×normal），basic 净对位≤0 扣 flat', () => {
  const picks = {
    blue: ['廉颇', '王昭君', '后羿', '张飞'],
    red: ['张良', '妲己', '澜'],   // 张良克露娜/镜，妲己也克镜
  };
  const mk = (m) => mkCtx({ store: withMastery(STORE, 3, m), picks });
  const A = findCand(API.pickRecommend(mk('best')), '露娜');
  const N = findCand(API.pickRecommend(mk('normal')), '露娜');
  const B = findCand(API.pickRecommend(mk('basic')), '露娜');
  ok(A && N && B, `三个熟练度场景都应出现露娜候选：${snip([A, N, B])}`);

  // 露娜被敌方张良克制 0.8（显式），slot index 7 的 counteredCoef = 1.0
  near(A.breakdown.countered, -0.9 * 0.45 * 0.8, 0.02, 'best 被克惩罚 = -0.9×0.45×0.8');
  near(N.breakdown.countered, -0.9 * 1.0 * 0.8, 0.02, 'normal 被克惩罚 = -0.9×1.0×0.8');
  near(B.breakdown.countered, -0.9 * 1.9 * 0.8, 0.02, 'basic 被克惩罚 = -0.9×1.9×0.8');
  ok(Math.abs(B.breakdown.countered) > Math.abs(N.breakdown.countered), 'basic 被克惩罚应大于 normal');
  ok(Math.abs(A.breakdown.countered) < Math.abs(N.breakdown.countered), 'best 被克惩罚应小于 normal（被克也能反打）');
  near(Math.abs(B.breakdown.countered) / Math.abs(A.breakdown.countered), 1.9 / 0.45, 0.2, 'basic/best 惩罚比值≈4.22');

  // flat：best +1.5；normal 0；basic 净对位≤0 → -1.5
  near(A.breakdown.mastery, 3.0, 0.01, 'best flat = +3.0（v2.5 绝活加分翻倍）');
  near(N.breakdown.mastery, 0, 0.01, 'normal flat = 0');
  near(B.breakdown.mastery, -3.0, 0.01, 'basic 净对位≤0 时 flat = -3.0（v2.5）');
  eq(A.masteryLabel, '绝活', 'best label');
  eq(B.masteryLabel, '仅会玩', 'basic label');
  return `countered：best=${A.breakdown.countered} normal=${N.breakdown.countered} basic=${B.breakdown.countered}；flat=${A.breakdown.mastery}/${N.breakdown.mastery}/${B.breakdown.mastery}`;
});

/* ===================== h) laneNeed 生效 ===================== */

t('[h] pick：laneNeed 让能补更多待补分路的英雄优先，最后机会 ×1.3 仍生效', () => {
  // 合成两个英雄：同 T2、无标签、无关系，只差能打的分路
  //   测试单补：support          → 待补 3 路里补 1 路
  //   测试双补：support + mid    → 补 2 路，且 mid 只有它能补（最后机会 ×1.3）
  const extraHeroes = [
    { id: 603, name: '测试单补', roles: ['support'], alt: [], type: ['辅助'] },
    { id: 604, name: '测试双补', roles: ['support'], alt: ['mid'], type: ['辅助'] },
  ];
  const store = clone(STORE);
  store.players[0].pool = [{ hero: '廉颇', mastery: 'normal' }];
  store.players[1].pool = [{ hero: '后羿', mastery: 'normal' }];
  store.players[2].pool = [];
  store.players[3].pool = [];
  store.players[4].pool = [
    { hero: '测试单补', mastery: 'normal' },
    { hero: '测试双补', mastery: 'normal' },
  ];
  // 累计 3 手 → 第 4 手（index 3）；我方已拿廉颇(top)+后羿(adc) → 待补 jungle/mid/support
  // ourPickNo = 2+1 = 3 → mid 阶段（laneNeed 系数 1.2）
  const ctx = mkCtx({
    heroes: HEROES.concat(extraHeroes),
    store,
    picks: { blue: ['廉颇', '后羿'], red: ['妲己'] },
  });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 3, 'step.index');
  eq(res.step.floor, 2, 'step.floor');
  eq(res.phase.key, 'mid', '第 3 手 phase 应为 mid');
  eq(res.phase.pickNo, 3, '第 3 手 phase.pickNo');
  eq(res.laneState.open.join('/'), '打野/中路/游走', '待补分路应为 打野/中路/游走');

  const single = findCand(res, '测试单补');
  const dual = findCand(res, '测试双补');
  ok(single && dual, `两个合成英雄都应在候选里：${candNames(res)}`);
  near(single.breakdown.laneNeed, 1.4 * 1.2 * (1 / 3), 0.02, '单补(游走) 补 1/3 待补路 → laneNeed=0.56');
  // 双补：support 不是最后机会（单补也能打），mid 只有它能打 → 整体 ×1.3
  near(dual.breakdown.laneNeed, 1.4 * 1.2 * (2 / 3) * 1.3, 0.02,
    '双补(游走+中路) 补 2/3 待补路 + 中路最后机会 ×1.3 → laneNeed≈1.456');
  ok(dual.score > single.score, `能补更多待补路的双补应排前：双补=${dual.score}，单补=${single.score}`);
  eq(res.candidates[0].hero, '测试双补', `候选排序第一位应为测试双补，实测 ${candNames(res)}`);
  ok(res.warnings.some((w) => w.includes('最后机会')), `「最后机会」应写进 warnings：${snip(res.warnings)}`);
  isObj(res.lanePlan, 'pick.lanePlan');
  isArr(res.lanePlan.assignments, 'lanePlan.assignments');
  return `候选：${candNames(res)}；laneNeed=${single.breakdown.laneNeed}/${dual.breakdown.laneNeed}`;
});

/* ===================== i) 敌方槽位 / 末选槽位 / 阶段 ===================== */

t('[i] pick：敌方槽位 candidates=[] 但 phase 仍返回；末选（第 10 手）slotType=late + counter 阶段', () => {
  const enemy = API.pickRecommend(mkCtx({ picks: { blue: ['王昭君'], red: ['妲己'] } }));
  eq(enemy.step.index, 2, '第 3 手 step.index');
  eq(enemy.step.side, 'red', 'PICK_SEQUENCE[2] 应为红方');
  eq(enemy.step.isOurs, false, '敌方槽位 isOurs=false');
  isArr(enemy.candidates, '敌方 candidates');
  eq(enemy.candidates.length, 0, `敌方槽位候选必须为空，实测 ${snip(enemy.candidates)}`);
  isArr(enemy.warnings, 'pick.warnings');
  isObj(enemy.lanePlan, '敌方槽位也应返回 lanePlan');
  isObj(enemy.phase, '敌方槽位也应返回 phase');
  eq(enemy.phase.key, 'grab', '敌方手 phase 按我方已选数+1 计算（我方已选 1 → 第 2 手先抢）');
  eq(enemy.phase.pickNo, 2, '敌方手 phase.pickNo');
  // v2.3：敌方手也返回我方已选英雄的 assignment / freePlayers
  isArr(enemy.assignment, '敌方手也应返回 assignment');
  eq(enemy.assignment.length, 1, '敌方手：我方已选 1 个英雄应分给 1 人');
  eq(enemy.assignment[0].hero, '王昭君', '敌方手 assignment 的英雄');
  isArr(enemy.freePlayers, '敌方手也应返回 freePlayers');
  eq(enemy.freePlayers.length, 4, '敌方手 freePlayers 应为 4 人');

  const late = API.pickRecommend(mkCtx({
    store: { side: 'red' },
    picks: {
      blue: ['廉颇', '澜', '孙尚香', '白起', '张飞'],
      red: ['后羿', '东皇太一', '兰陵王', '小乔'],
    },
  }));
  eq(late.step.index, 9, '末选 step.index');
  eq(late.step.slotType, 'late', '末选 slotType 应为 late');
  eq(late.step.isOurs, true, 'store.side=red 时第 10 手是我方');
  eq(late.step.floor, 5, '末选 floor 应为 5');
  eq(late.phase.key, 'counter', '末选（我方第 5 手）phase 应为 counter');
  eq(late.phase.pickNo, 5, '末选 phase.pickNo 应为 5');
  ok(late.candidates.length > 0, '末选我方应给出候选');
  // 候选来自全队并集，不再等于 5 楼张一个人的池
  late.candidates.forEach((c) => {
    eq(c.ownerIndex, c.owners[0].playerIndex, `${c.hero}.ownerIndex = owners[0]`);
    eq(c.ownerName, c.owners[0].name, `${c.hero}.ownerName = owners[0]`);
  });
  return `敌方 candidates=0 phase=${enemy.phase.key}/${enemy.phase.pickNo}；末选 ${late.step.label} phase=${late.phase.key} 候选 ${candNames(late, 5)}`;
});

/* ===================== j) 空 ban ===================== */

t("[j] 空 ban：bans.theirs 含 '' / 长度<5 时不崩，ban 仍 5 条、pick 正常排除已 ban", () => {
  const ctx = mkCtx({ bans: { ours: ['澜'], theirs: ['', '', '妲己'] } });
  const ban = API.banRecommend(ctx);
  eq(ban.commands.length, 5, '空 ban 不应影响我方 ban 指令数');
  const pick = API.pickRecommend(ctx);
  eq(pick.step.index, 0, '首手 step.index');
  ok(pick.candidates.length > 0, `空 ban 时首抢候选不应为空：${snip(pick.warnings)}`);
  ok(!pick.candidates.some((c) => c.hero === '澜'), '已被我方 ban 的澜不应出现在候选里');
  const line = API.lineupCheck(ctx);
  isArr(line.checks, 'lineupCheck.checks');
  const pool = API.analyzePool(ctx);
  isArr(pool.suggestions, 'analyzePool.suggestions');
  return `ban=${ban.commands.length} 条；首抢候选=${candNames(pick, 4)}`;
});

/* ===================== k) 空池 / 全部被 ban ===================== */

t('[k] 边界：空池 / 全部英雄被 ban / 空 ctx 都不抛异常且给 warnings', () => {
  // 1) 所有池为空
  const emptyStore = clone(STORE);
  emptyStore.players.forEach((p) => { p.pool = []; });
  const emptyCtx = mkCtx({ store: emptyStore });
  const emptyPick = API.pickRecommend(emptyCtx);
  eq(emptyPick.candidates.length, 0, '空池时我方候选应为空');
  ok(emptyPick.warnings.length > 0, '空池时应给 warnings');
  const emptyBan = API.banRecommend(emptyCtx);
  eq(emptyBan.commands.length, 5, '空池时仍应给出 5 条 ban 指令（按全局强度）');
  const emptyPool = API.analyzePool(emptyCtx);
  ok(emptyPool.notes.length > 0, '空池时 analyzePool 应有 notes');

  // 2) 全部英雄被 ban
  const allNames = HEROES.map((h) => h.name);
  const allBanCtx = mkCtx({ bans: { ours: allNames.slice(0, 11), theirs: allNames.slice(11) } });
  const allBanPick = API.pickRecommend(allBanCtx);
  eq(allBanPick.candidates.length, 0, '全部被 ban 时候选应为空');
  eq(API.banRecommend(allBanCtx).commands.length, 0, '全部被 ban 时不应再有 ban 指令');

  // 3) 空 ctx / 缺字段
  for (const bad of [{}, null, undefined, { store: {} }, { heroes: [] }]) {
    const b = API.banRecommend(bad);
    const p = API.pickRecommend(bad);
    const l = API.lineupCheck(bad);
    const a = API.analyzePool(bad);
    isArr(b.commands, '空 ctx: ban.commands');
    isArr(b.shortlist, '空 ctx: ban.shortlist');
    isArr(b.warnings, '空 ctx: ban.warnings');
    isArr(p.candidates, '空 ctx: pick.candidates');
    isArr(l.checks, '空 ctx: lineup.checks');
    isArr(l.laneSurvival, '空 ctx: lineup.laneSurvival');
    isArr(l.survival, '空 ctx: lineup.survival');
    isArr(a.players, '空 ctx: analyze.players');
    isArr(a.suggestions, '空 ctx: analyze.suggestions');
    isArr(a.warnings, '空 ctx: analyze.warnings');
  }
  return '空池 / 全 ban / 空 ctx 均未抛异常';
});

/* ===================== l) lineupCheck 结构 ===================== */

t('[l] lineupCheck：checks/lanePlan/laneSurvival/survival/gaps 结构齐全且数值自洽', () => {
  const ctx = mkCtx({ bans: { ours: ['露娜'], theirs: [] }, picks: { blue: ['妲己', '张良'], red: [] } });
  const res = API.lineupCheck(ctx);

  isArr(res.checks, 'checks');
  eq(res.checks.length, 5, 'checks 应有 5 项');
  const byKey = new Map(res.checks.map((c) => [c.key, c]));
  for (const key of ['front', 'engage', 'protect', 'damage', 'control']) {
    ok(byKey.has(key), `checks 缺 key=${key}`);
    const c = byKey.get(key);
    isStr(c.label, `checks[${key}].label`);
    ok(typeof c.ok === 'boolean', `checks[${key}].ok 应为布尔`);
    ok(c.need !== undefined && c.value !== undefined, `checks[${key}] 缺 value/need`);
  }
  eq(byKey.get('front').ok, false, '我方无前排 front.ok 应为 false');
  eq(byKey.get('engage').ok, false, '我方无开团 engage.ok 应为 false');
  eq(byKey.get('protect').ok, false, '我方无保护 protect.ok 应为 false');

  isArr(res.gaps, 'gaps');
  const gapText = res.gaps.join('|');
  for (const word of ['前排', '开团', '保护']) {
    ok(gapText.includes(word), `gaps 未提到「${word}」：${snip(res.gaps)}`);
  }
  ok(gapText.includes('游走'), `gaps 应包含五路缺口「游走」：${snip(res.gaps)}`);

  isObj(res.lanePlan, 'lanePlan');
  isArr(res.lanePlan.assignments, 'lanePlan.assignments');
  isArr(res.lanePlan.uncovered, 'lanePlan.uncovered');
  ok(res.lanePlan.assignments.length >= 1, 'lanePlan 至少应分出一条路');
  res.lanePlan.assignments.forEach((a) => {
    isStr(a.lane, 'assignment.lane');
    isStr(a.laneLabel, 'assignment.laneLabel');
    isStr(a.hero, 'assignment.hero');
    eq(a.laneLabel, API.LANES[a.lane], `assignment ${a.hero} 的 laneLabel`);
  });

  isArr(res.laneSurvival, 'laneSurvival');
  eq(res.laneSurvival.length, 5, 'laneSurvival 应覆盖五条路');
  for (const s of res.laneSurvival) {
    isStr(s.lane, 'laneSurvival.lane');
    isStr(s.laneLabel, 'laneSurvival.laneLabel');
    isNum(s.poolDepth, `laneSurvival[${s.lane}].poolDepth`);
    isArr(s.owners, `laneSurvival[${s.lane}].owners`);
    ok(typeof s.atRisk === 'boolean', `laneSurvival[${s.lane}].atRisk 应为布尔`);
  }
  const jungle = res.laneSurvival.find((s) => s.lane === 'jungle');
  eq(jungle.poolDepth, 3, '打野：我方 ban 露娜后剩赵云/镜/兰陵王 3 个');
  eq(jungle.owners.includes('李'), true, '打野拥有者应为李');

  isArr(res.survival, 'survival');
  eq(res.survival.length, 5, 'survival 应按玩家 5 条（不再按分路）');
  for (const s of res.survival) {
    isNum(s.playerIndex, 'survival.playerIndex');
    isStr(s.name, 'survival.name');
    isNum(s.floor, 'survival.floor');
    isNum(s.total, `survival[${s.name}].total`);
    isNum(s.alive, `survival[${s.name}].alive`);
    isNum(s.ratio, `survival[${s.name}].ratio`);
    isArr(s.aliveHeroes, `survival[${s.name}].aliveHeroes`);
    isObj(s.masteryAlive, `survival[${s.name}].masteryAlive`);
    for (const k of ['best', 'normal', 'basic']) isNum(s.masteryAlive[k], `survival[${s.name}].masteryAlive.${k}`);
    near(s.ratio, s.total === 0 ? 0 : Math.round((s.alive / s.total) * 100) / 100, 0.011, `survival[${s.name}].ratio = alive/total`);
  }
  const li = res.survival.find((s) => s.name === '李');
  eq(li.total, 4, '李的池深应为 4');
  eq(li.alive, 3, '我方 ban 掉露娜后李池剩 3 个');
  near(li.ratio, 0.75, 0.011, '李池存活率 3/4');
  eq(li.masteryAlive.best, 0, '露娜被 ban 后李池绝活数 0');
  eq(li.masteryAlive.normal, 2, '李池正常数 2（赵云/兰陵王）');
  eq(li.masteryAlive.basic, 1, '李池仅会玩数 1（镜）');
  eq(li.aliveHeroes.includes('露娜'), false, '被 ban 的露娜不应在存活名单里');
  return `gaps=${snip(res.gaps)}；lanePlan 覆盖=${snip(res.lanePlan.assignments.map((a) => a.laneLabel))}`;
});

/* ===================== m) 五路覆盖 / 跨路英雄 ===================== */

t('[m] 五路覆盖：lanePlan 铺满五路；赵云(jungle+top) 被算作两路，能顶到对抗路', () => {
  // 1) 五个正统英雄 → 五路全铺满
  const five = API.lanePlan(mkCtx(), ['廉颇', '露娜', '王昭君', '后羿', '张飞']);
  eq(five.assignments.length, 5, `五路都应分到人，实测 ${snip(five.assignments)}`);
  eq(five.uncovered.length, 0, `uncovered 应为空，实测 ${snip(five.uncovered)}`);
  eq(uniq(five.assignments.map((a) => a.lane)), true, '同一条路不应被分配两次');

  // 2) 跨路英雄：赵云(jungle 主/top 次) + 露娜(jungle) + 廉颇(top/support)
  //    最优解：赵云顶到对抗路(alt)，露娜留下打野，廉颇去游走 → 五路仍覆盖
  const cross = API.lanePlan(mkCtx(), ['赵云', '露娜', '王昭君', '后羿', '廉颇']);
  eq(cross.assignments.length, 5, `跨路阵容也应铺满五路，实测 ${snip(cross.assignments)}`);
  eq(cross.uncovered.length, 0, `跨路阵容 uncovered 应为空，实测 ${snip(cross.uncovered)}`);
  const byLane = new Map(cross.assignments.map((a) => [a.lane, a.hero]));
  eq(byLane.get('jungle'), '露娜', '打野应留给主分路打野的露娜');
  eq(byLane.get('top'), '赵云', '赵云应凭 alt=top 顶到对抗路');
  eq(byLane.get('support'), '廉颇', '廉颇应凭 alt=support 去游走');

  // 3) 单个跨路英雄：默认落主分路（roles 优先于 alt）
  const solo = API.lanePlan(mkCtx(), ['赵云']);
  eq(solo.assignments.length, 1, '赵云单体只能占一路');
  eq(solo.assignments[0].lane, 'jungle', '赵云默认走主分路打野');
  eq(solo.uncovered.length, 4, '其余四路未覆盖');
  return `五路=${snip(five.assignments.map((a) => `${a.laneLabel}:${a.hero}`))}；跨路=${snip(cross.assignments.map((a) => `${a.laneLabel}:${a.hero}`))}`;
});

/* ===================== n) analyzePool 去重 + 合并 ===================== */

t('[n] analyzePool：同一 hero 全局唯一、多玩家需求合并 forPlayers、reasons 去重', () => {
  // 只保留 4 个英雄，游离候选只有「牛魔」→ 必须一条 suggestion 合并多个玩家
  const heroes = HEROES.filter((h) => ['王昭君', '后羿', '廉颇', '牛魔'].includes(h.name));
  const store = {
    version: 2,
    side: 'blue',
    players: [
      { id: 'p1', name: '包', floor: 1, preferLanes: ['mid'], pool: [{ hero: '王昭君', mastery: 'normal' }] },
      { id: 'p2', name: '刘', floor: 2, preferLanes: ['adc'], pool: [{ hero: '后羿', mastery: 'normal' }] },
      { id: 'p3', name: '杜', floor: 3, preferLanes: ['top'], pool: [{ hero: '廉颇', mastery: 'normal' }] },
      { id: 'p4', name: '李', floor: 4, preferLanes: ['jungle'], pool: [] },
      { id: 'p5', name: '张', floor: 5, preferLanes: ['support'], pool: [] },
    ],
  };
  const res = API.analyzePool(mkCtx({ heroes, store }));
  isArr(res.suggestions, 'suggestions');
  ok(res.suggestions.length >= 1, `应至少给出 1 条补池建议，实测 ${snip(res.suggestions)}`);

  const heroesOut = res.suggestions.map((s) => s.hero);
  eq(uniq(heroesOut), true, `suggestions 里 hero 必须唯一，实测 ${snip(heroesOut)}`);

  const niu = res.suggestions.find((s) => s.hero === '牛魔');
  ok(niu, `应建议牛魔补不足：${snip(res.suggestions)}`);
  isArr(niu.forPlayers, 'forPlayers');
  ok(niu.forPlayers.length >= 2, `牛魔应合并多个玩家，实测 ${snip(niu.forPlayers)}`);
  for (const fp of niu.forPlayers) {
    isNum(fp.playerIndex, 'forPlayers.playerIndex');
    isStr(fp.name, 'forPlayers.name');
    isNum(fp.floor, 'forPlayers.floor');
  }
  eq(uniq(niu.forPlayers.map((p) => p.playerIndex)), true, 'forPlayers 里玩家不应重复');
  eq(uniq(niu.reasons), true, `reasons 必须去重，实测 ${snip(niu.reasons)}`);
  ok(niu.reasons.length > 0, 'reasons 不应为空');
  isArr(niu.laneFit, 'laneFit');
  eq(niu.laneFit.join('/'), '游走', '牛魔 laneFit 应为游走');
  return `suggestions=${res.suggestions.length} 条，牛魔 forPlayers=${snip(niu.forPlayers.map((p) => p.name))}，reasons=${snip(niu.reasons)}`;
});

/* ===================== o) analyzePool 真实结构 ===================== */

t('[o] analyzePool：players 体检字段齐全，且绝不推荐任何池内英雄、最多 12 条', () => {
  const ctx = mkCtx();
  const res = API.analyzePool(ctx);
  isArr(res.players, 'players');
  eq(res.players.length, 5, 'players 应有 5 条（按玩家而非分路）');
  for (const p of res.players) {
    isNum(p.playerIndex, 'players.playerIndex');
    isStr(p.name, 'players.name');
    isNum(p.floor, 'players.floor');
    isArr(p.preferLanes, 'players.preferLanes');
    isNum(p.depth, `players[${p.name}].depth`);
    isObj(p.masteryCounts, 'players.masteryCounts');
    for (const k of ['best', 'normal', 'basic']) isNum(p.masteryCounts[k], `players[${p.name}].masteryCounts.${k}`);
    isObj(p.coverage, 'players.coverage');
    for (const k of ['front', 'engage', 'protect', 'damage', 'control']) {
      ok(typeof p.coverage[k] === 'boolean', `players[${p.name}].coverage.${k} 应为布尔`);
    }
    isObj(p.laneCover, 'players.laneCover');
    for (const l of ['top', 'jungle', 'mid', 'adc', 'support']) {
      ok(typeof p.laneCover[l] === 'boolean', `players[${p.name}].laneCover.${l} 应为布尔`);
    }
  }
  const li = res.players.find((p) => p.name === '李');
  eq(li.preferLanes.join('/'), '打野/对抗路', 'preferLanes 应转成中文标签');
  eq(li.masteryCounts.best, 1, '李池绝活数');
  eq(li.coverage.front, false, '李池没有前排');
  eq(li.laneCover.top, true, '赵云 alt=top → 李池能打对抗路（跨路）');
  eq(li.laneCover.jungle, true, '李池能打打野');

  const poolHeroes = new Set(ctx.store.players.flatMap((p) => p.pool.map((e) => e.hero)));
  for (const s of res.suggestions) {
    ok(!poolHeroes.has(s.hero), `不应推荐已在池里的英雄：${s.hero}`);
    isNum(s.heroId, `${s.hero}.heroId`);
    isStr(s.tier, `${s.hero}.tier`);
    isArr(s.laneFit, `${s.hero}.laneFit`);
    isArr(s.forPlayers, `${s.hero}.forPlayers`);
    isArr(s.reasons, `${s.hero}.reasons`);
    eq(uniq(s.reasons), true, `${s.hero}.reasons 应去重`);
  }
  ok(res.suggestions.length <= 12, `suggestions 最多 12 条，实测 ${res.suggestions.length}`);
  ok(res.notes.some((n) => /补到\s*4/.test(n)), `notes 应提示补到 4+：${snip(res.notes)}`);
  return `suggestions=${res.suggestions.length}：${snip(res.suggestions.map((s) => `${s.hero}→${s.forPlayers.map((p) => p.name).join('/')}`))}`;
});

/* ===================== p) currentStep ===================== */

t('[p] currentStep：index/letter/floor/playerIndex/slotType 正确，10 手后返回 null', () => {
  const ctx = mkCtx();
  const s0 = API.currentStep(ctx);
  eq(s0.index, 0, '首手 index');
  eq(s0.letter, 'B', '首手 letter');
  eq(s0.side, 'blue', '首手 side');
  eq(s0.isOurs, true, '首手 isOurs');
  eq(s0.floor, 1, '首手 floor');
  eq(s0.playerIndex, 0, 'floor=1 的玩家下标应为 0');
  eq(s0.slotType, 'first', '首手 slotType');
  isStr(s0.label, 'step.label');
  ok(s0.label.includes('蓝方1楼'), `label 应含蓝方1楼：${s0.label}`);

  const s3 = API.currentStep(mkCtx({ picks: { blue: ['廉颇'], red: [], } }));
  eq(s3.index, 1, '累计 1 手 → index 1');
  eq(s3.side, 'red', '第二手是红方');
  eq(s3.isOurs, false, '第二手 isOurs=false');
  eq(s3.floor, 1, '红方 1 楼');
  eq(s3.playerIndex, 0, '§4.1 口径：playerIndex 按 floor 在我方 players 里查（红方 1 楼 → 我方 floor=1 的 0 号）');

  const full = mkCtx({
    picks: { blue: ['廉颇', '王昭君', '后羿', '孙尚香', '白起'], red: ['妲己', '澜', '韩信', '鲁班七号', '张良'] },
  });
  eq(API.currentStep(full), null, '10 手后 currentStep 返回 null');
  return `首手 ${s0.label}/${s0.slotType}；第二手 ${s3.side}/${s3.floor}楼/playerIndex=${s3.playerIndex}`;
});

/* ===================== q) 辅助导出 / 常量 ===================== */

t('[q] 辅助导出：MASTERY 系数、常量、counterOf/synergyOf/tierOf/tierWeight/compNeedOf', () => {
  isObj(API.LANES, 'LANES');
  eq(API.LANES.jungle, '打野', 'LANES.jungle');
  eq(API.LANE_ORDER.join(','), 'top,jungle,mid,adc,support', 'LANE_ORDER');
  eq(API.PICK_SEQUENCE.join(''), 'BRRBBRRBBR', 'PICK_SEQUENCE');
  isObj(API.TIER_WEIGHT, 'TIER_WEIGHT');
  for (const tier of ['T0', 'T0.5', 'T1', 'T2', 'T3', 'T4']) isNum(API.TIER_WEIGHT[tier], `TIER_WEIGHT.${tier}`);
  for (const tag of ['前排', '开团', '保护', '控制']) {
    ok(API.TAG_SET.includes(tag), `TAG_SET 缺「${tag}」`);
  }

  // §2 系数：必须一字不差
  isObj(API.MASTERY, 'MASTERY');
  eq(API.MASTERY_ORDER.join(','), 'best,normal,basic', 'MASTERY_ORDER');
  near(API.MASTERY.best.risk, 0.45, 1e-9, 'best.risk');
  near(API.MASTERY.best.counterGain, 1.0, 1e-9, 'best.counterGain');
  near(API.MASTERY.best.flat, 3.0, 1e-9, 'best.flat');
  near(API.MASTERY.normal.risk, 1.0, 1e-9, 'normal.risk');
  near(API.MASTERY.normal.flat, 0, 1e-9, 'normal.flat');
  near(API.MASTERY.basic.risk, 1.9, 1e-9, 'basic.risk');
  near(API.MASTERY.basic.counterGain, 1.25, 1e-9, 'basic.counterGain');
  near(API.MASTERY.basic.flat, -3.0, 1e-9, 'basic.flat');
  eq(API.MASTERY.best.label, '绝活', 'best.label');
  eq(API.MASTERY.normal.label, '正常', 'normal.label');
  eq(API.MASTERY.basic.label, '仅会玩', 'basic.label');

  // §4.2/§4.3/§4.6 v2.1：权重默认值 + 阶段表
  isObj(API.DEFAULT_WEIGHTS, 'DEFAULT_WEIGHTS');
  near(API.DEFAULT_WEIGHTS.tier, 10, 1e-9, 'DEFAULT_WEIGHTS.tier');
  near(API.DEFAULT_WEIGHTS.threat, 1.5, 1e-9, 'DEFAULT_WEIGHTS.threat');
  near(API.DEFAULT_WEIGHTS.fragility, 0.8, 1e-9, 'DEFAULT_WEIGHTS.fragility');
  near(API.DEFAULT_WEIGHTS.answerable, 1.0, 1e-9, 'DEFAULT_WEIGHTS.answerable');
  near(API.DEFAULT_WEIGHTS.counter, 1.1, 1e-9, 'DEFAULT_WEIGHTS.counter');
  near(API.DEFAULT_WEIGHTS.countered, 0.9, 1e-9, 'DEFAULT_WEIGHTS.countered');
  near(API.DEFAULT_WEIGHTS.synergy, 1.0, 1e-9, 'DEFAULT_WEIGHTS.synergy');
  near(API.DEFAULT_WEIGHTS.compNeed, 1.4, 1e-9, 'DEFAULT_WEIGHTS.compNeed');
  near(API.DEFAULT_WEIGHTS.laneNeed, 1.4, 1e-9, 'DEFAULT_WEIGHTS.laneNeed');

  isArr(API.PICK_PHASES, 'PICK_PHASES');
  eq(API.PICK_PHASES.length, 5, 'PICK_PHASES 应有 5 个我方手位');
  eq(API.PICK_PHASES.map((p) => p.key).join(','), 'grab,grab,mid,counter,counter', 'PICK_PHASES 阶段序列');
  eq(API.PICK_PHASES.map((p) => p.tier).join(','), '2.4,2.4,1.8,0.5,0.5', 'PICK_PHASES tier 系数（v2.5：先抢降为 2.4、补强 1.8，末两手仍 0.5）');
  eq(API.PICK_PHASES.map((p) => p.counter).join(','), '0.4,0.4,1.1,3,3', 'PICK_PHASES counter 系数（v2.5：先抢 0.4，末两手仍 3.0）');
  eq(API.PICK_PHASES.map((p) => p.countered).join(','), '0.7,0.7,1,1,1', 'PICK_PHASES countered 系数（v2.5：先抢也要躲被克）');
  eq(API.PICK_PHASES.map((p) => p.synergy).join(','), '0.8,0.8,1.1,0.9,0.9', 'PICK_PHASES synergy 系数');
  eq(API.PICK_PHASES.map((p) => p.compNeed).join(','), '0.5,0.5,1,0.9,0.9', 'PICK_PHASES compNeed 系数');
  eq(API.PICK_PHASES.map((p) => p.laneNeed).join(','), '1,1,1.2,1,1', 'PICK_PHASES laneNeed 系数');
  eq(typeof API.pickPhase, 'function', 'pickPhase 应导出');
  const ph0 = API.pickPhase(null, mkCtx());
  eq(ph0.key, 'grab', 'pickPhase 0 已选 → grab');
  eq(ph0.pickNo, 1, 'pickPhase 0 已选 → pickNo 1');
  const fourPicked = mkCtx({ picks: { blue: ['廉颇', '白起', '吕布', '后羿'], red: [] } });
  const ph4 = API.pickPhase(null, fourPicked);
  eq(ph4.key, 'counter', 'pickPhase 4 已选 → 第 5 手 counter');
  eq(ph4.pickNo, 5, 'pickPhase 4 已选 → pickNo 5');

  const ctx = mkCtx();
  near(API.counterOf(ctx, '张良', '露娜'), 0.8, 1e-9, 'counterOf(张良→露娜)');
  near(API.synergyOf(ctx, '明世隐', '后羿'), 0.6, 1e-9, 'synergyOf 正向（明世隐↔后羿）');
  near(API.synergyOf(ctx, '后羿', '明世隐'), 0.6, 1e-9, 'synergyOf 对称（后羿↔明世隐）');
  near(API.counterOf(ctx, '后羿', '明世隐'), 0, 1e-9, 'synergy 不能当 counter 用');
  eq(API.tierOf(ctx, '澜'), 'T0', 'tierOf 澜');
  eq(API.tierOf(ctx, '不存在'), 'T2', 'tierOf 缺省 T2');
  eq(API.tierWeight('T0'), 10, 'tierWeight T0');
  eq(API.tierWeight('不存在'), 4, 'tierWeight 缺省 T2=4');
  isNum(API.compNeedOf(ctx, '廉颇', []), 'compNeedOf 返回值');
  isArr(API.lanePlan(ctx, ['廉颇']).assignments, 'lanePlan 导出');
  eq(typeof API.normalizeStore, 'function', 'normalizeStore 导出');
  return `MASTERY=${snip(API.MASTERY_ORDER)}；counterOf 张良→露娜=${API.counterOf(ctx, '张良', '露娜')}`;
});

/* ===================== r) 权重覆盖机制（v2.1 新 key） ===================== */

t('[r] 权重：store.weights / meta.weights 覆盖 v2.1 新 key', () => {
  // ban：默认 tier=10（T1 张良 ≥ 60）；覆盖 tier=1 且抹平威胁 → score 就等于 tierW(T1)=6
  const base = mkCtx();
  const zl0 = API.banRecommend(base).commands.find((c) => c.hero === '张良');
  ok(zl0, `默认权重下张良应在指令里：${banOrder(API.banRecommend(base))}`);
  ok(zl0.score >= 10 * API.TIER_WEIGHT.T1 - 1e-9, `默认 T1 分数应 ≥ 10×6=60，实测 ${zl0.score}`);

  const storeB = clone(STORE);
  storeB.weights = { tier: 1, threat: 0, fragility: 0, answerable: 0 };
  const zl1 = API.banRecommend(mkCtx({ store: storeB })).commands.find((c) => c.hero === '张良');
  ok(zl1, '覆盖权重后张良仍应在指令里');
  near(zl1.score, API.TIER_WEIGHT.T1, 0.01, 'store.weights tier=1 + 威胁归零 → score=tierW(T1)=6');

  // pick：meta.weights.laneNeed=0 → laneNeed 分量归零（阶段系数不能绕过权重）
  const meta = clone(META);
  meta.weights = { laneNeed: 0 };
  const store2 = clone(STORE);
  store2.players[0].pool = [{ hero: '廉颇', mastery: 'normal' }];
  store2.players[1].pool = [{ hero: '后羿', mastery: 'normal' }];
  store2.players[2].pool = [];
  store2.players[3].pool = [];
  store2.players[4].pool = [
    { hero: '测试射手', mastery: 'normal' },
    { hero: '测试辅助', mastery: 'normal' },
  ];
  const ctxLane = mkCtx({ meta, store: store2, picks: { blue: ['廉颇', '后羿'], red: ['妲己'] } });
  const sup = findCand(API.pickRecommend(ctxLane), '测试辅助');
  ok(sup, `测试辅助应在候选里：${candNames(API.pickRecommend(ctxLane))}`);
  near(sup.breakdown.laneNeed, 0, 0.01, 'meta.weights.laneNeed=0 时 laneNeed 分量应为 0');

  // pick：meta.weights.counter=0 → 克制分量归零
  // （我方已选 4 手覆盖 top/mid/adc/support → 待补 jungle；用张飞克敌方妲己验证克制分量）
  const rel = clone(RELATIONS);
  rel.counters.push({ a: '张飞', b: '妲己', w: 0.7 });
  const picks = { blue: ['廉颇', '王昭君', '后羿', '露娜'], red: ['妲己', '澜', '韩信'] }; // index 7 → 我方第 5 手
  const tf = findCand(API.pickRecommend(mkCtx({ relations: rel, picks })), '张飞');
  ok(tf, `张飞应在候选里：${candNames(API.pickRecommend(mkCtx({ relations: rel, picks })))}`);
  ok(tf.breakdown.counter > 0, `默认权重下张飞克妲己应有正克制分，实测 ${tf.breakdown.counter}`);
  const meta2 = clone(META);
  meta2.weights = { counter: 0 };
  const tf0 = findCand(API.pickRecommend(mkCtx({ relations: rel, picks, meta: meta2 })), '张飞');
  near(tf0.breakdown.counter, 0, 0.01, 'meta.weights.counter=0 时克制分量应为 0');
  return `ban: 默认=${zl0.score} → 覆盖后=${zl1.score}；laneNeed 覆盖=${sup.breakdown.laneNeed}；counter: 默认=${tf.breakdown.counter} → 覆盖后=${tf0.breakdown.counter}`;
});

/* ===================== s) ban shortlist / alternatives 细节 ===================== */

t('[s] ban：shortlist 前 8 降序、alternatives 分数不高于主选且不含主选自身', () => {
  const res = API.banRecommend(mkCtx());
  isArr(res.shortlist, 'shortlist');
  eq(res.shortlist.length, 8, 'shortlist 应为 8 条');
  for (let i = 1; i < res.shortlist.length; i += 1) {
    ok(res.shortlist[i - 1].score >= res.shortlist[i].score,
      `shortlist 未按分数降序：${res.shortlist[i - 1].hero}(${res.shortlist[i - 1].score}) < ${res.shortlist[i].hero}(${res.shortlist[i].score})`);
  }
  for (const c of res.commands) {
    for (const a of c.alternatives) {
      isStr(a.hero, 'alternative.hero');
      isNum(a.score, 'alternative.score');
      ok(a.hero !== c.hero, 'alternatives 不应包含主选自身');
      ok(a.score <= c.score + 1e-9, `备选分数高于主选：${c.hero}=${c.score} vs ${a.hero}=${a.score}`);
    }
  }
  // 指令英雄互不重复（每人 ban 一个不同的英雄）
  eq(uniq(res.commands.map((c) => c.hero)), true, '5 条指令的英雄应互不重复');
  return `shortlist=${snip(res.shortlist.map((s) => `${s.hero}(${s.score})`))}`;
});

/* ===================== t) v2 store 原样幂等 ===================== */

t('[t] normalizeStore：已是 v2 的 store 幂等（熟人熟度/倾向分路原样保留）', () => {
  const s = API.normalizeStore(clone(STORE));
  eq(s.players.length, 5, 'players 数量');
  eq(s.players.map((p) => p.floor).join(','), '1,2,3,4,5', 'floor 不变');
  eq(s.players[3].preferLanes.join('/'), 'jungle/top', 'preferLanes 不变');
  eq(s.players[3].pool[0].mastery, 'best', '露娜仍为 best');
  eq(s.players[3].pool[2].mastery, 'basic', '镜仍为 basic');
  eq(s.players[0].pool.length, 3, '包池深不变');
  eq(s.side, 'blue', 'side 不变');
  eq(s.version, 2, 'version=2');
  eq(JSON.stringify(s.players[3].pool), JSON.stringify(STORE.players[3].pool), '池内容不变');
  return `5 人 floor=${s.players.map((p) => p.floor).join('/')}`;
});

/* ===================== u) ban：T0 强度主导（v2.1 硬要求） ===================== */

t('[u] ban：T0 零威胁 vs T1 吃满 5 人池克制 → T0 仍排前且分数更高（强度远大于克制）', () => {
  const targetNames = [1, 2, 3, 4, 5].map((i) => `靶子${i}`);
  const heroes = [
    { id: 901, name: '强度王', roles: ['top'], alt: [], type: ['战士'] },
    { id: 902, name: '克制王', roles: ['mid'], alt: [], type: ['法师'] },
  ].concat(targetNames.map((n, i) => ({ id: 910 + i, name: n, roles: ['mid'], alt: [], type: ['法师'] })));
  const meta = { version: 'u', tiers: {}, tags: {} };
  meta.tiers['强度王'] = { tier: 'T0' };
  meta.tiers['克制王'] = { tier: 'T1' };
  meta.tags['强度王'] = [];
  meta.tags['克制王'] = [];
  targetNames.forEach((n) => {
    meta.tiers[n] = { tier: 'T2' };
    meta.tags[n] = [];
  });
  const relations = {
    counters: targetNames.map((n) => ({ a: '克制王', b: n, w: 1.0 })),
    synergies: [],
  };
  const store = {
    version: 2,
    side: 'blue',
    players: targetNames.map((n, i) => ({
      name: `玩家${i + 1}`,
      floor: i + 1,
      preferLanes: [],
      // basic：risk=1.9，把「被克制」的威胁吃满
      pool: [{ hero: n, mastery: 'basic' }],
    })),
    allowCrossLane: true,
    weights: {},
    history: [],
  };
  const ctx = { heroes, meta, relations, store, bans: { ours: [], theirs: [] }, picks: { blue: [], red: [] } };
  const res = API.banRecommend(ctx);
  eq(res.commands.length, 2, `靶子都在我方池里，只剩 2 个 ban 候选，实测 ${banOrder(res)}`);
  eq(res.commands[0].hero, '强度王', `T0 应排第一：${banOrder(res)}`);
  eq(res.commands[0].tier, 'T0', '第一条 tier 应为 T0');
  eq(res.commands[1].tier, 'T1', '第二条 tier 应为 T1');
  near(res.commands[0].score, 100, 0.01, 'T0 零威胁时 score = 10×tierW(T0)=100');
  ok(res.commands[1].breakdown.threat > 5, `T1 应吃满 5 人池威胁，实测 threat=${res.commands[1].breakdown.threat}`);
  ok(res.commands[0].score > res.commands[1].score,
    `T0 分数必须大于吃满威胁的 T1：${res.commands[0].score} vs ${res.commands[1].score}`);
  ok(res.commands[0].score - res.commands[1].score > 10,
    `T0 应显著领先（契约说 T0=100 / T1 最高≈77）：${res.commands[0].score} vs ${res.commands[1].score}`);
  return `强度王(T0)=${res.commands[0].score} > 克制王(T1)=${res.commands[1].score}（threat=${res.commands[1].breakdown.threat}）`;
});

/* ===================== v) pick：全队池并集 ===================== */

t('[v] pick：候选=全队池并集 —— 1 楼池空仍非空；同一英雄多人拥有时 owners 合并取最高档', () => {
  // 1) 1 楼（包）池为空，其他 4 人有池 → 第 1 手候选仍非空（v2.1 不再受楼层限制）
  const storeEmptyFirst = clone(STORE);
  storeEmptyFirst.players[0].pool = [];
  const r1 = API.pickRecommend(mkCtx({ store: storeEmptyFirst }));
  eq(r1.step.floor, 1, '当前是第 1 手（1 楼）');
  ok(r1.candidates.length > 0, `1 楼池空时不应没有候选：${snip(r1.warnings)}`);
  ok(!r1.candidates.some((c) => c.ownerName === '包'), '包池为空，不应出现以包为 owner 的候选');
  ok(r1.candidates.every((c) => c.owners.length >= 1), '每张候选都应带 owners');

  // 2) 后羿在 刘(best) 与 包(normal) 两个人的池里 → 一条候选、owners 合并、mastery=best
  const storeOverlap = clone(STORE);
  storeOverlap.players[0].pool.push({ hero: '后羿', mastery: 'normal' });
  const r2 = API.pickRecommend(mkCtx({ store: storeOverlap }));
  const hy = findCand(r2, '后羿');
  ok(hy, `后羿应在候选里：${candNames(r2)}`);
  eq(hy.owners.length, 2, `后羿 owners 应合并为 2 人，实测 ${snip(hy.owners)}`);
  eq(hy.owners[0].name, '刘', '熟练度最高的 owner 应为刘(best)');
  eq(hy.mastery, 'best', '后羿 mastery 取最高档 best');
  eq(hy.masteryLabel, '绝活', 'masteryLabel 应为绝活');
  eq(hy.ownerName, '刘', '兼容字段 ownerName = owners[0]');
  return `1 楼池空候选=${r1.candidates.length}；后羿 owners=${snip(hy.owners.map((o) => `${o.name}(${o.masteryLabel})`))}`;
});

/* ===================== w) pick：阶段判定 ===================== */

t('[w] pick：我方第 1/2 手 grab、第 3 手 mid、第 4/5 手 counter；敌方手也返回 phase', () => {
  const cases = [
    { picks: { blue: [], red: [] }, index: 0, key: 'grab', pickNo: 1 },
    { picks: { blue: ['廉颇'], red: ['妲己', '澜'] }, index: 3, key: 'grab', pickNo: 2 },
    { picks: { blue: ['廉颇', '王昭君'], red: ['妲己', '澜'] }, index: 4, key: 'mid', pickNo: 3 },
    { picks: { blue: ['廉颇', '王昭君', '后羿'], red: ['妲己', '澜', '韩信', '张良'] }, index: 7, key: 'counter', pickNo: 4 },
    { picks: { blue: ['廉颇', '王昭君', '后羿', '张飞'], red: ['妲己', '澜', '韩信', '张良'] }, index: 8, key: 'counter', pickNo: 5 },
  ];
  for (const c of cases) {
    const res = API.pickRecommend(mkCtx({ picks: c.picks }));
    eq(res.step.index, c.index, `index=${c.index} 的 step.index`);
    eq(res.phase.key, c.key, `我方第 ${c.pickNo} 手 phase.key`);
    eq(res.phase.pickNo, c.pickNo, `我方第 ${c.pickNo} 手 phase.pickNo`);
    isStr(res.phase.label, 'phase.label');
    isStr(res.phase.hint, 'phase.hint（UI 直接展示）');
    ok(res.candidates.length > 0, `我方第 ${c.pickNo} 手候选不应为空：${snip(res.warnings)}`);
  }
  // 敌方手：candidates=[]，phase 仍按「我方已选数+1」返回
  const enemy = API.pickRecommend(mkCtx({ picks: { blue: ['廉颇'], red: ['妲己'] } }));
  eq(enemy.step.isOurs, false, '敌方手 isOurs=false');
  eq(enemy.candidates.length, 0, '敌方手 candidates 为空');
  eq(enemy.phase.key, 'grab', '敌方手 phase（我方已选 1 → 第 2 手先抢）');
  eq(enemy.phase.pickNo, 2, '敌方手 phase.pickNo');
  return `阶段：${cases.map((c) => `第${c.pickNo}手=${c.key}`).join(' / ')}；敌方手 phase=${enemy.phase.key}/${enemy.phase.pickNo}`;
});

/* ===================== x) pick 先抢阶段：强度压倒克制 ===================== */

t('[x] pick grab：T0 被两个敌人克，仍排在 T1 前（先抢只看强度，几乎不看克制）', () => {
  const heroes = [
    { id: 921, name: '丙', roles: ['support'], alt: [], type: ['辅助'] },
    { id: 922, name: '甲', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 923, name: '乙', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 924, name: '敌A', roles: ['top'], alt: [], type: ['战士'] },
    { id: 925, name: '敌B', roles: ['adc'], alt: [], type: ['射手'] },
  ];
  const meta = {
    version: 'x',
    tiers: { 丙: { tier: 'T2' }, 甲: { tier: 'T0' }, 乙: { tier: 'T1' }, 敌A: { tier: 'T2' }, 敌B: { tier: 'T2' } },
    tags: { 丙: ['前排'], 甲: [], 乙: [], 敌A: [], 敌B: [] },
  };
  const relations = {
    counters: [{ a: '敌A', b: '甲', w: 1.0 }, { a: '敌B', b: '甲', w: 1.0 }],
    synergies: [],
  };
  const store = {
    version: 2,
    side: 'blue',
    players: [
      { name: '包', floor: 1, preferLanes: [], pool: [{ hero: '丙', mastery: 'normal' }] },
      { name: '刘', floor: 2, preferLanes: [], pool: [] },
      { name: '杜', floor: 3, preferLanes: [], pool: [{ hero: '乙', mastery: 'normal' }] },
      { name: '李', floor: 4, preferLanes: [], pool: [{ hero: '甲', mastery: 'normal' }] },
      { name: '张', floor: 5, preferLanes: [], pool: [] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  };
  // 第 2 手（我方）：blue 已选丙，red 已选敌A/敌B → index 3
  const picks = { blue: ['丙'], red: ['敌A', '敌B'] };
  const res = API.pickRecommend({ heroes, meta, relations, store, bans: { ours: [], theirs: [] }, picks });
  eq(res.step.index, 3, 'step.index');
  eq(res.phase.key, 'grab', '第 2 手 phase 应为 grab');
  eq(res.phase.pickNo, 2, 'phase.pickNo');
  const jia = findCand(res, '甲');
  const yi = findCand(res, '乙');
  ok(jia && yi, `甲/乙都应在候选：${candNames(res)}`);
  eq(jia.tier, 'T0', '甲 tier 应为 T0');
  eq(yi.tier, 'T1', '乙 tier 应为 T1');
  ok(jia.breakdown.countered < 0, `甲被两个敌人克，countered 应为负：${jia.breakdown.countered}`);
  ok(jia.score > yi.score, `先抢阶段 T0 即使被克也应领先 T1：甲(T0)=${jia.score}，乙(T1)=${yi.score}`);
  eq(res.candidates[0].hero, '甲', `T0 应排第一：${candNames(res)}`);
  return `甲(T0)=${jia.score}（countered=${jia.breakdown.countered}）> 乙(T1)=${yi.score}`;
});

/* ===================== y) pick 克制阶段：末两手做 counter ===================== */

t('[y] pick counter：第 4 手 T1 克制英雄 > T2 无克制；且克 T0 的收益 > 克 T2', () => {
  const heroes = [
    { id: 931, name: '甲', roles: ['top'], alt: [], type: ['战士'] },
    { id: 932, name: '乙', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 933, name: '丙', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 934, name: '克星', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 935, name: '平庸', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 936, name: '敌T0A', roles: ['top'], alt: [], type: ['战士'] },
    { id: 937, name: '敌T0B', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 938, name: '敌X', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 939, name: '敌Y', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 940, name: '敌Z', roles: ['support'], alt: [], type: ['辅助'] },
    { id: 941, name: '敌W', roles: ['support'], alt: [], type: ['辅助'] },
  ];
  const tiers = {
    甲: 'T2', 乙: 'T2', 丙: 'T2', 克星: 'T1', 平庸: 'T2',
    敌T0A: 'T0', 敌T0B: 'T0', 敌X: 'T2', 敌Y: 'T2', 敌Z: 'T2', 敌W: 'T2',
  };
  const meta = { version: 'y', tiers: {}, tags: {} };
  Object.keys(tiers).forEach((n) => {
    meta.tiers[n] = { tier: tiers[n] };
    meta.tags[n] = [];
  });
  const mkStore = () => ({
    version: 2,
    side: 'blue',
    players: [
      { name: '包', floor: 1, preferLanes: [], pool: [{ hero: '克星', mastery: 'normal' }, { hero: '平庸', mastery: 'normal' }] },
      { name: '刘', floor: 2, preferLanes: [], pool: [{ hero: '甲', mastery: 'normal' }] },
      { name: '杜', floor: 3, preferLanes: [], pool: [{ hero: '乙', mastery: 'normal' }] },
      { name: '李', floor: 4, preferLanes: [], pool: [{ hero: '丙', mastery: 'normal' }] },
      { name: '张', floor: 5, preferLanes: [], pool: [] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  });
  const mk = (picks, relations) => ({
    heroes: clone(heroes), meta: clone(meta), relations: clone(relations),
    store: mkStore(), bans: { ours: [], theirs: [] }, picks,
  });
  // 我方 3 手已选 → 第 4 手（index 7）counter 阶段；敌方 4 手含 2 个 T0
  const picksA = { blue: ['甲', '乙', '丙'], red: ['敌T0A', '敌T0B', '敌X', '敌Y'] };
  const relA = {
    counters: [{ a: '克星', b: '敌T0A', w: 1.0 }, { a: '克星', b: '敌T0B', w: 1.0 }],
    synergies: [],
  };
  const resA = API.pickRecommend(mk(picksA, relA));
  eq(resA.step.index, 7, 'counter 用例 step.index');
  eq(resA.phase.key, 'counter', '第 4 手 phase 应为 counter');
  eq(resA.phase.pickNo, 4, 'phase.pickNo');
  const ks = findCand(resA, '克星');
  const py = findCand(resA, '平庸');
  ok(ks && py, `克星/平庸都应在候选：${candNames(resA)}`);
  ok(ks.breakdown.counter > 0, `克星克两个 T0，counter 应 > 0：${ks.breakdown.counter}`);
  ok(ks.score > py.score, `克制阶段 T1 克制英雄应优于 T2 无克制：克星=${ks.score}，平庸=${py.score}`);

  // 克 T0 的收益 > 克 T2：同样只克 1 个目标，目标 T0 vs T2
  const picksB = { blue: ['甲', '乙', '丙'], red: ['敌X', '敌Y', '敌Z', '敌W'] };
  const relB = { counters: [{ a: '克星', b: '敌X', w: 1.0 }], synergies: [] };
  const ksB = findCand(API.pickRecommend(mk(picksB, relB)), '克星');
  ok(ksB, '克 T2 场景克星也应在候选');
  ok(ks.breakdown.counter > ksB.breakdown.counter * 1.3,
    `克 T0 的 counter 收益应明显高于克 T2：T0=${ks.breakdown.counter} vs T2=${ksB.breakdown.counter}`);
  return `counter 阶段：克星(T1)=${ks.score} > 平庸(T2)=${py.score}；克 T0 counter=${ks.breakdown.counter} > 克 T2 counter=${ksB.breakdown.counter}`;
});

/* ===================== z) 真实数据验收 ===================== */

t('[z] 真实数据：ban 前 5 全是 T0；pick 候选带 owners/phase（我方池中的 T0 已排除）', () => {
  const root = path.resolve(__dirname, '..');
  const realHeroes = JSON.parse(
    readFileSync(path.join(root, 'bp', 'data', 'heroes.js'), 'utf8')
      .replace(/^window\.HEROES\s*=\s*/, '')
      .replace(/;\s*$/, '')
  );
  const realMeta = JSON.parse(readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'));
  const realRel = JSON.parse(readFileSync(path.join(root, 'data', 'relations.json'), 'utf8'));
  const realStore = API.normalizeStore(JSON.parse(loadRealStoreRaw(root)));
  const ctx = {
    heroes: realHeroes,
    meta: realMeta,
    relations: realRel,
    store: realStore,
    bans: { ours: [], theirs: [] },
    picks: { blue: [], red: [] },
  };

  const ban = API.banRecommend(ctx);
  eq(ban.commands.length, 5, `真实数据应给出 5 条 ban 指令，实测 ${ban.commands.length}`);
  const tiers = ban.commands.map((c) => c.tier);
  eq(tiers.every((t) => t === 'T0'), true, `真实数据 ban 前 5 必须全是 T0，实测 ${snip(tiers)}：${banOrder(ban)}`);

  // 前提校验：我方池里排除后仍有 ≥5 个 T0 可选（否则上面断言会因数据变化而误伤）
  const pool = new Set(realStore.players.flatMap((p) => p.pool.map((e) => e.hero)));
  const freeT0 = realHeroes.filter((h) => {
    const t = realMeta.tiers && realMeta.tiers[h.name];
    return t && t.tier === 'T0' && !pool.has(h.name);
  });
  ok(freeT0.length >= 5, `数据前提：池外 T0 应有 ≥5 个，实测 ${freeT0.length}（${snip(freeT0.map((h) => h.name))}）`);

  // pick：全队并集 + owners + phase
  const pick = API.pickRecommend(ctx);
  ok(pick.step && pick.step.index === 0, '真实数据首手 step.index 应为 0');
  eq(pick.phase.key, 'grab', '首手 phase 应为 grab');
  eq(pick.phase.pickNo, 1, '首手 phase.pickNo 应为 1');
  ok(pick.candidates.length > 0, '真实数据首手候选不应为空');
  pick.candidates.forEach((c) => {
    ok(c.owners.length >= 1, `${c.hero}.owners 不应为空`);
    eq(c.ownerName, c.owners[0].name, `${c.hero}.ownerName = owners[0].name`);
    eq(c.mastery, c.owners[0].mastery, `${c.hero}.mastery = owners[0].mastery`);
  });
  return `ban: ${ban.commands.map((c) => `${c.tier} ${c.hero}(${c.score})`).join(' / ')}；pick 首手 ${pick.candidates.length} 条候选`;
});

/* ===================== aa) pick 分路去重（选了射手不再推射手） ===================== */

t('[aa] pick v2.2：选了后羿（发育路已覆盖）→ 候选无纯射手，且都能补待补分路', () => {
  // 我方第 1 手已选 后羿；累计 3 手 → index 3
  const ctx = mkCtx({ picks: { blue: ['后羿'], red: ['妲己', '澜'] } });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 3, 'step.index');
  isObj(res.laneState, 'pick.laneState');
  ok(res.laneState.covered.includes('发育路'), `laneState.covered 应含发育路：${snip(res.laneState.covered)}`);
  ok(!res.laneState.open.includes('发育路'), `laneState.open 不应含发育路：${snip(res.laneState.open)}`);
  ok(res.candidates.length > 0, `候选不应为空：${snip(res.warnings)}`);

  const openLabels = res.laneState.open;
  const pureAdc = [];
  res.candidates.forEach((c) => {
    ok(c.lanes.some((l) => openLabels.includes(l)),
      `${c.hero} 不能补任何待补分路（open=${snip(openLabels)}，lanes=${snip(c.lanes)}）`);
    if (c.lanes.length === 1 && c.lanes[0] === '发育路') pureAdc.push(c.hero);
  });
  eq(pureAdc.length, 0, `不应再出现纯射手候选：${snip(pureAdc)}`);
  for (const h of ['鲁班七号', '孙尚香', '测试射手']) {
    ok(!res.candidates.some((c) => c.hero === h), `纯射手「${h}」不应出现在候选里`);
  }
  return `covered=${snip(res.laneState.covered)} open=${snip(res.laneState.open)} 候选=${candNames(res)}`;
});

/* ===================== ab) open 为空时不过滤 ===================== */

t('[ab] pick v2.2/v2.3：五路已齐（open 为空）时不做分路过滤，但一人一英雄会把 6 号人挡下', () => {
  const mkStore = () => {
    const store = clone(STORE);
    // 五个已选英雄各在一个人的池里（完整匹配）；孙尚香是纯 adc，且只有包池里有
    store.players[0].pool = [{ hero: '廉颇', mastery: 'normal' }, { hero: '孙尚香', mastery: 'normal' }];
    store.players[1].pool = [{ hero: '后羿', mastery: 'normal' }];
    store.players[2].pool = [{ hero: '王昭君', mastery: 'normal' }];
    store.players[3].pool = [{ hero: '露娜', mastery: 'normal' }];
    store.players[4].pool = [{ hero: '张飞', mastery: 'normal' }];
    return store;
  };
  // 我方 5 个英雄已铺满五路 → open 为空。分路过滤关闭，但「一人一英雄」已经没有第 6 个人
  const full = API.pickRecommend(mkCtx({
    store: mkStore(),
    picks: { blue: ['廉颇', '露娜', '王昭君', '后羿', '张飞'], red: ['妲己', '澜', '韩信'] },
  }));
  eq(full.laneState.open.length, 0, `五路已齐 open 应为空：${snip(full.laneState.open)}`);
  eq(full.laneState.covered.length, 5, `covered 应为五路：${snip(full.laneState.covered)}`);
  eq(full.assignment.length, 5, '5 个已选英雄都应分到人');
  eq(full.freePlayers.length, 0, '5 人全部上场 → freePlayers 为空');
  eq(full.candidates.length, 0, '一人一英雄：没有第 6 个人，候选应为空');
  ok(full.warnings.some((w) => w.includes('已选满')), `应提示没有可上场的空位：${snip(full.warnings)}`);

  // 对照：只铺了 4 路（open=游走）时，纯 adc 的孙尚香被 v2.2 分路过滤挡掉
  const partial = API.pickRecommend(mkCtx({
    store: mkStore(),
    picks: { blue: ['廉颇', '露娜', '王昭君', '后羿'], red: ['妲己', '澜', '韩信'] },
  }));
  ok(partial.laneState.open.length > 0, `四路时 open 不应为空：${snip(partial.laneState.open)}`);
  eq(partial.candidates.some((c) => c.hero === '孙尚香'), false,
    `open=游走时纯 adc 的孙尚香应被过滤：${candNames(partial)}`);
  return `open=[]：assignment=${full.assignment.length} 人、候选=${full.candidates.length}；open=${snip(partial.laneState.open)} 时候选=${candNames(partial)}`;
});

/* ===================== ac) 待补分路无人可补的 warning ===================== */

t('[ac] pick v2.2：待补分路无人能打 → warning「已无人可补」+ 过滤后无候选的明确提示', () => {
  const store = clone(STORE);
  // 池里只有两个中路英雄；已选王昭君 → 其余四路全都没人能打
  store.players[0].pool = [{ hero: '王昭君', mastery: 'normal' }, { hero: '小乔', mastery: 'normal' }];
  store.players[1].pool = [];
  store.players[2].pool = [];
  store.players[3].pool = [];
  store.players[4].pool = [];
  const ctx = mkCtx({ store, picks: { blue: ['王昭君'], red: ['妲己', '澜'] } });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 3, 'step.index');
  eq(res.laneState.open.join('/'), '对抗路/打野/发育路/游走', '待补分路');
  ok(res.warnings.some((w) => w.includes('已无人可补')),
    `应提示某路已无人可补：${snip(res.warnings)}`);
  ok(res.warnings.some((w) => w.includes('没有任何候选可打')),
    `过滤后候选为空时应给明确提示：${snip(res.warnings)}`);
  eq(res.candidates.length, 0, '小乔只能打中路（已覆盖）→ 过滤后无候选');
  return `open=${snip(res.laneState.open)}；warnings=${snip(res.warnings)}`;
});

/* ===================== ad) 真实数据 + 后羿验收 ===================== */

t('[ad] 真实数据 v2.2：已选后羿 → 候选无 adc-only、open 不含发育路；ban 前 3 无执行人字段', () => {
  const root = path.resolve(__dirname, '..');
  const realHeroes = JSON.parse(
    readFileSync(path.join(root, 'bp', 'data', 'heroes.js'), 'utf8')
      .replace(/^window\.HEROES\s*=\s*/, '')
      .replace(/;\s*$/, '')
  );
  const realMeta = JSON.parse(readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'));
  const realRel = JSON.parse(readFileSync(path.join(root, 'data', 'relations.json'), 'utf8'));
  const realStore = API.normalizeStore(JSON.parse(loadRealStoreRaw(root)));
  const ctx = {
    heroes: realHeroes,
    meta: realMeta,
    relations: realRel,
    store: realStore,
    bans: { ours: [], theirs: [] },
    picks: { blue: ['后羿'], red: ['妲己', '澜'] },
  };

  const pick = API.pickRecommend(ctx);
  eq(pick.step.index, 3, '真实数据 step.index');
  ok(pick.laneState.covered.includes('发育路'), `covered 应含发育路：${snip(pick.laneState.covered)}`);
  ok(!pick.laneState.open.includes('发育路'), `open 不应含发育路：${snip(pick.laneState.open)}`);
  ok(pick.candidates.length > 0, `真实数据候选不应为空：${snip(pick.warnings)}`);
  pick.candidates.forEach((c) => {
    ok(c.lanes.some((l) => pick.laneState.open.includes(l)),
      `${c.hero} 不能补待补分路（open=${snip(pick.laneState.open)}）`);
    ok(!(c.lanes.length === 1 && c.lanes[0] === '发育路'), `${c.hero} 是纯射手，不应出现在候选里`);
  });

  const ban = API.banRecommend(ctx);
  ok(ban.commands.length >= 3, `真实数据 ban 应 ≥3 条，实测 ${ban.commands.length}`);
  const top3 = ban.commands.slice(0, 3);
  eq(top3.every((c) => c.tier === 'T0'), true, `ban 前 3 应全是 T0，实测 ${snip(top3.map((c) => `${c.tier} ${c.hero}`))}`);
  top3.forEach((c) => {
    ok(!('playerIndex' in c) && !('playerName' in c) && !('floor' in c) && !('laneHints' in c),
      `${c.hero} 不应再返回执行人字段（v2.2）`);
    ok(!/建议由/.test(c.reason), `${c.hero}.reason 不应出现「建议由」：${c.reason}`);
  });
  return `pick 候选=${candNames(pick, 5)}；ban 前 3=${banOrderV22({ commands: top3 })}`;
});

/* ===================== ae) assignment：一人一英雄 ===================== */

t('[ae] pick v2.3：assignment 一人一英雄（玩家不重复、hero 在该玩家池里、freePlayers 正确）', () => {
  // 4 个已选，分别来自 4 个不同玩家 → 第 5 人（李）空着
  const ctx = mkCtx({
    picks: { blue: ['廉颇', '王昭君', '后羿', '张飞'], red: ['妲己', '澜', '韩信'] },
  });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 7, 'step.index');
  isArr(res.assignment, 'assignment');
  eq(res.assignment.length, 4, `4 个已选英雄应各分给 1 人，实测 ${snip(res.assignment)}`);
  const idxs = res.assignment.map((a) => a.playerIndex);
  eq(uniq(idxs), true, `同一玩家不能打两个英雄，实测 ${snip(idxs)}`);
  res.assignment.forEach((a) => {
    ok(ctx.store.players[a.playerIndex].pool.some((e) => e.hero === a.hero),
      `${a.hero} 应来自 ${a.playerName} 的池`);
    eq(a.manual, false, `${a.hero} 未手动指定 → manual=false`);
    isStr(a.masteryLabel, 'assignment.masteryLabel');
  });
  eq(res.assignment.map((a) => a.hero).sort().join('/'), ['后羿', '廉颇', '张飞', '王昭君'].sort().join('/'),
    'assignment 应覆盖全部已选英雄');
  eq(res.freePlayers.map((p) => p.name).join('/'), '李', `freePlayers 应只剩李，实测 ${snip(res.freePlayers)}`);
  // lanePlan 的 playerName 用 assignment 的上场人（不是「第一个池主」）
  res.lanePlan.assignments.forEach((a) => {
    const hit = res.assignment.find((x) => x.hero === a.hero);
    ok(hit, `lanePlan 英雄 ${a.hero} 应在 assignment 里`);
    eq(a.playerName, hit.playerName, `lanePlan ${a.hero} 的 playerName 应等于 assignment 的 ${hit.playerName}`);
  });
  return `assignment=${snip(res.assignment.map((a) => `${a.hero}→${a.playerName}`))}；free=${snip(res.freePlayers.map((p) => p.name))}`;
});

/* ===================== af) 匹配优先熟练度 ===================== */

t('[af] pick v2.3：同一英雄多人池里 → 优先让熟练度高的打（best 优先）', () => {
  const store = clone(STORE);
  store.players[0].pool = [{ hero: '后羿', mastery: 'normal' }, { hero: '小乔', mastery: 'normal' }];
  store.players[1].pool = [{ hero: '后羿', mastery: 'best' }];
  store.players[2].pool = [];
  store.players[3].pool = [];
  store.players[4].pool = [];
  const ctx = mkCtx({ store, picks: { blue: ['后羿'], red: ['妲己', '澜'] } });
  const res = API.pickRecommend(ctx);
  eq(res.assignment.length, 1, '已选 1 个英雄');
  eq(res.assignment[0].hero, '后羿', 'assignment 英雄');
  eq(res.assignment[0].playerName, '刘', '后羿同时被 包(normal)/刘(best) 拥有 → 应由刘(best)打');
  eq(res.assignment[0].mastery, 'best', 'assignment 熟练度取该玩家的 best');
  // 候选小乔只能由包打（刘已被后羿占用）
  const xq = findCand(res, '小乔');
  ok(xq, `小乔应在候选里：${candNames(res)}`);
  eq(xq.assignedTo.name, '包', '小乔应分配给包（刘已占用）');
  eq(xq.fielders.map((f) => f.name).join('/'), '包', '小乔只有包一个可行人选');
  return `后羿→${res.assignment[0].playerName}(${res.assignment[0].mastery})；小乔→${xq.assignedTo.name}`;
});

/* ===================== ag) 候选需要换位（包空出来） ===================== */

t('[ag] pick v2.3：候选需要换位 —— 阿古朵仅包能打、马超可换给李，候选出现且 assignedTo=包', () => {
  const heroes = [
    { id: 801, name: '盾山', roles: ['support'], alt: [], type: ['坦克'] },
    { id: 802, name: '敖隐', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 803, name: '马超', roles: ['top', 'jungle'], alt: [], type: ['战士'] },
    { id: 804, name: '阿古朵', roles: ['jungle'], alt: [], type: ['坦克'] },
    { id: 805, name: '小乔', roles: ['mid'], alt: [], type: ['法师'] },
    { id: 806, name: '沈梦溪', roles: ['mid'], alt: [], type: ['法师'] },
  ];
  const mkStore = () => ({
    version: 2,
    side: 'blue',
    players: [
      { name: '包', floor: 1, preferLanes: ['top'], pool: [{ hero: '马超', mastery: 'best' }, { hero: '阿古朵', mastery: 'normal' }] },
      { name: '刘', floor: 2, preferLanes: ['adc'], pool: [{ hero: '敖隐', mastery: 'normal' }] },
      { name: '杜', floor: 3, preferLanes: ['mid'], pool: [{ hero: '小乔', mastery: 'normal' }] },
      { name: '李', floor: 4, preferLanes: ['jungle'], pool: [{ hero: '马超', mastery: 'normal' }] },
      { name: '张', floor: 5, preferLanes: ['support'], pool: [{ hero: '盾山', mastery: 'normal' }] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  });
  // 用户截图局面：我方已选 盾山(张)/敖隐(刘)/马超(包)，敌方 4 手 → 我方下一手（index 7）
  const mk = (assignments) => ({
    heroes: clone(heroes), meta: clone(META), relations: { counters: [], synergies: [] },
    store: mkStore(), bans: { ours: [], theirs: [] },
    picks: { blue: ['盾山', '敖隐', '马超'], red: ['小乔', '沈梦溪', '女娲', '嬴政'] },
    assignments: assignments || {},
  });
  const res = API.pickRecommend(mk({}));
  eq(res.step.index, 7, 'step.index');
  eq(res.assignment.length, 3, '3 个已选英雄都应分到人');
  eq(uniq(res.assignment.map((a) => a.playerIndex)), true, '一人一英雄：玩家不重复');

  const agd = findCand(res, '阿古朵');
  ok(agd, `阿古朵应出现在候选里（马超可让位给李）：${candNames(res)}`);
  eq(agd.assignedTo.name, '包', '阿古朵只可能由包去打');
  ok(agd.fielders.some((f) => f.name === '包'), `fielders 应含包：${snip(agd.fielders)}`);
  eq(agd.reason.includes('由 包'), true, `reason 应写「由 包…去打」：${agd.reason}`);

  // 手动指定 马超→李：包空出来，阿古朵依旧可打，assignment 里马超 manual=true
  const manual = API.pickRecommend(mk({ 马超: 3 }));
  const m = manual.assignment.find((a) => a.hero === '马超');
  eq(m.playerName, '李', '手动指定后马超应由李去打');
  eq(m.manual, true, '马超 assignment 应标 manual=true');
  const agd2 = findCand(manual, '阿古朵');
  ok(agd2, '手动指定后阿古朵仍应在候选里');
  eq(agd2.assignedTo.name, '包', '手动指定后阿古朵→包');
  eq(manual.freePlayers.map((p) => p.name).sort().join('/'), '包/杜'.split('/').sort().join('/'),
    `freePlayers 应反映手动分配后的剩余（包/杜），实测 ${snip(manual.freePlayers)}`);
  return `阿古朵→${agd.assignedTo.name} fielders=${snip(agd.fielders.map((f) => f.name))}；手动马超→${m.playerName}(manual=${m.manual})`;
});

/* ===================== ah) 候选无法完整匹配 → 过滤 + warning ===================== */

t('[ah] pick v2.3：候选无人可打（4 人被占、候选仅占用人池里有）→ 过滤 + 「剩余队友」warning', () => {
  const store = clone(STORE);
  // 包池里有镜（jungle）；其余四人的池里没人能打 jungle
  store.players[0].pool = [{ hero: '廉颇', mastery: 'normal' }, { hero: '镜', mastery: 'normal' }];
  store.players[1].pool = [{ hero: '后羿', mastery: 'normal' }];
  store.players[2].pool = [{ hero: '王昭君', mastery: 'normal' }];
  store.players[3].pool = [];
  store.players[4].pool = [{ hero: '张飞', mastery: 'normal' }];
  // 我方已选 4 手：廉颇(包)/后羿(刘)/王昭君(杜)/张飞(张) → 剩李没人；待补 jungle
  const ctx = mkCtx({ store, picks: { blue: ['廉颇', '后羿', '王昭君', '张飞'], red: ['妲己', '澜', '韩信'] } });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 7, 'step.index');
  eq(res.assignment.length, 4, '4 个已选应分给 4 人');
  eq(res.freePlayers.map((p) => p.name).join('/'), '李', 'freePlayers 应为李');
  ok(res.laneState.open.includes('打野'), `待补应含打野：${snip(res.laneState.open)}`);
  eq(res.candidates.some((c) => c.hero === '镜'), false, '镜只有包能打（包已占）→ 应被过滤');
  eq(res.candidates.length, 0, `候选应为空，实测 ${candNames(res)}`);
  ok(res.warnings.some((w) => w.includes('剩余队友（李）') && w.includes('没人能打')),
    `应提示剩余队友没人能打：${snip(res.warnings)}`);
  return `open=${snip(res.laneState.open)}；warnings=${snip(res.warnings)}`;
});

/* ===================== ai) 手动指定容错 ===================== */

t('[ai] pick v2.3：不可行/重复的手动指定被忽略并 warning，整体匹配仍完整', () => {
  const heroes = [
    { id: 811, name: '马超', roles: ['top', 'jungle'], alt: [], type: ['战士'] },
    { id: 812, name: '阿古朵', roles: ['jungle'], alt: [], type: ['坦克'] },
    { id: 813, name: '盾山', roles: ['support'], alt: [], type: ['坦克'] },
    { id: 814, name: '敖隐', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 815, name: '小乔', roles: ['mid'], alt: [], type: ['法师'] },
  ];
  const mkStore = () => ({
    version: 2,
    side: 'blue',
    players: [
      { name: '包', floor: 1, preferLanes: ['top'], pool: [{ hero: '马超', mastery: 'best' }, { hero: '阿古朵', mastery: 'normal' }] },
      { name: '刘', floor: 2, preferLanes: ['adc'], pool: [{ hero: '敖隐', mastery: 'normal' }] },
      { name: '杜', floor: 3, preferLanes: ['mid'], pool: [{ hero: '小乔', mastery: 'normal' }] },
      { name: '李', floor: 4, preferLanes: ['jungle'], pool: [{ hero: '马超', mastery: 'normal' }] },
      { name: '张', floor: 5, preferLanes: ['support'], pool: [{ hero: '盾山', mastery: 'normal' }] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  });
  const mk = (assignments) => ({
    heroes: clone(heroes), meta: clone(META), relations: { counters: [], synergies: [] },
    store: mkStore(), bans: { ours: [], theirs: [] },
    // 我方 4 手已选（含阿古朵）→ 第 9 手（index 8）仍是我方
    picks: { blue: ['盾山', '敖隐', '马超', '阿古朵'], red: ['小乔', '女娲', '嬴政', '甄姬'] },
    assignments: assignments || {},
  });

  // 1) 指定的玩家池里没有这个英雄：杜池里没有马超 → 忽略 + warning，匹配仍完整
  const bad = API.pickRecommend(mk({ 马超: 2 }));
  ok(bad.warnings.some((w) => w.includes('指定 马超→杜 不可行') && w.includes('已自动分配')),
    `应提示不可行指定：${snip(bad.warnings)}`);
  eq(bad.assignment.length, 4, '忽略不可行指定后仍应完整分配');
  const mBad = bad.assignment.find((a) => a.hero === '马超');
  eq(mBad.manual, false, '不可行指定不应标 manual');
  eq(uniq(bad.assignment.map((a) => a.playerIndex)), true, '仍是一人一英雄');

  // 2) 同一个玩家被指定两个英雄：保留先出现的（马超→包），阿古朵→包 忽略 + warning；
  //    但阿古朵只有包能打 → 指定组合无法完整匹配 → 回退自动分配（阿古朵占包、马超去李）
  const dup = API.pickRecommend(mk({ 马超: 0, 阿古朵: 0 }));
  ok(dup.warnings.some((w) => w.includes('被忽略')), `重复指定应 warning：${snip(dup.warnings)}`);
  ok(dup.warnings.some((w) => w.includes('回退自动分配')), `无法完整匹配应回退：${snip(dup.warnings)}`);
  eq(dup.assignment.length, 4, '回退后仍应完整分配');
  const mDup = dup.assignment.find((a) => a.hero === '马超');
  eq(mDup.playerName, '李', '回退自动匹配后马超应由李去打（阿古朵占包）');
  eq(mDup.manual, false, '回退后 manual 应为 false');
  eq(dup.assignment.every((a) => a.manual === false), true, '回退自动分配后不应再有 manual=true');
  return `不可行指定 warnings=${snip(bad.warnings)}；重复指定 warnings=${snip(dup.warnings)}`;
});

/* ===================== aj) 池外指定容错 ===================== */

t('[aj] pick v2.3 容错：已选英雄不在任何人池里（池外指定）→ 明确 warning，不静默清空', () => {
  const store = clone(STORE);
  store.players[0].pool = [{ hero: '廉颇', mastery: 'normal' }];
  store.players[1].pool = [];
  store.players[2].pool = [{ hero: '王昭君', mastery: 'normal' }];
  store.players[3].pool = [];
  store.players[4].pool = [];
  // 我方已选 廉颇(包) + 后羿（不在任何人的池里，模拟 UI「池外指定」）
  const ctx = mkCtx({ store, picks: { blue: ['廉颇', '后羿'], red: ['妲己', '澜'] } });
  const res = API.pickRecommend(ctx);
  eq(res.step.index, 4, 'step.index');
  eq(res.assignment.length, 0, '含池外英雄 → 无法完成一人一英雄分配');
  ok(res.warnings.some((w) => w.includes('不在任何人的池里')),
    `应明确提示池外英雄：${snip(res.warnings)}`);
  ok(!res.warnings.some((w) => w.includes('剩余队友')),
    `不应误报「剩余队友」：${snip(res.warnings)}`);
  eq(res.candidates.length, 0, '无法完成一人一英雄时不给候选');
  return `warnings=${snip(res.warnings)}`;
});

/* ===================== ak) 手动指定 warning 不串扰 ===================== */

t('[ak] pick v2.3：可行手动指定不因「某个候选不可行」而误报回退；真正不可行只报一次', () => {
  const heroes = [
    { id: 821, name: '盾山', roles: ['support'], alt: [], type: ['坦克'] },
    { id: 822, name: '敖隐', roles: ['adc'], alt: [], type: ['射手'] },
    { id: 823, name: '马超', roles: ['top', 'jungle'], alt: [], type: ['战士'] },
    { id: 824, name: '阿古朵', roles: ['jungle'], alt: [], type: ['坦克'] },
    { id: 825, name: '专属', roles: ['jungle'], alt: [], type: ['刺客'] },
    { id: 826, name: '小乔', roles: ['mid'], alt: [], type: ['法师'] },
  ];
  const mkStore = () => ({
    version: 2,
    side: 'blue',
    players: [
      { name: '包', floor: 1, preferLanes: ['top'], pool: [{ hero: '马超', mastery: 'best' }, { hero: '阿古朵', mastery: 'normal' }] },
      { name: '刘', floor: 2, preferLanes: ['adc'], pool: [{ hero: '敖隐', mastery: 'normal' }, { hero: '专属', mastery: 'normal' }] },
      { name: '杜', floor: 3, preferLanes: ['mid'], pool: [{ hero: '小乔', mastery: 'normal' }] },
      { name: '李', floor: 4, preferLanes: ['jungle'], pool: [{ hero: '马超', mastery: 'normal' }] },
      { name: '张', floor: 5, preferLanes: ['support'], pool: [{ hero: '盾山', mastery: 'normal' }] },
    ],
    allowCrossLane: true,
    weights: {},
    history: [],
  });
  const mk = (assignments, blue) => ({
    heroes: clone(heroes), meta: clone(META), relations: { counters: [], synergies: [] },
    store: mkStore(), bans: { ours: [], theirs: [] },
    picks: { blue: blue, red: ['小乔', '女娲', '嬴政', '甄姬'] },
    assignments: assignments || {},
  });

  // 1) 可行手动指定 敖隐→刘：候选「专属」只有刘能打（被 manual 占住）→ 应静默过滤，
  //    不能报「手动指定无法构成完整匹配」；敖隐 manual=true 且不被回退。
  const okRes = API.pickRecommend(mk({ 敖隐: 1 }, ['盾山', '敖隐', '马超']));
  const ao = okRes.assignment.find((a) => a.hero === '敖隐');
  ok(ao, '敖隐应在 assignment 里');
  eq(ao.playerIndex, 1, '敖隐应由刘（playerIndex=1）去打');
  eq(ao.playerName, '刘', '敖隐 assignment playerName 应为刘');
  eq(ao.manual, true, '可行手动指定应标 manual=true');
  ok(okRes.candidates.some((c) => c.hero === '阿古朵'), `阿古朵应仍在候选：${candNames(okRes)}`);
  eq(okRes.candidates.some((c) => c.hero === '专属'), false, '专属只有刘能打（被 manual 占住）→ 静默过滤');
  ok(!okRes.warnings.some((w) => w.includes('手动指定无法构成完整匹配')),
    `候选不可行不应串扰出「手动指定…回退」warning：${snip(okRes.warnings)}`);
  ok(!okRes.warnings.some((w) => w.includes('回退自动分配')),
    `可行手动指定不应出现回退 warning：${snip(okRes.warnings)}`);

  // 2) 真正不可行的手动指定（马超→包 是合法边，但会让阿古朵无处可去）→ 回退只报一次
  const badRes = API.pickRecommend(mk({ 马超: 0 }, ['盾山', '马超', '阿古朵']));
  const fallbackWarns = badRes.warnings.filter((w) => w.includes('手动指定无法构成完整匹配，已回退自动分配'));
  eq(fallbackWarns.length, 1, `真正不可行时应恰好 1 条回退 warning，实测 ${snip(badRes.warnings)}`);
  const mc = badRes.assignment.find((a) => a.hero === '马超');
  eq(mc.manual, false, '回退后马超不应标 manual');
  eq(mc.playerName, '李', '回退自动匹配后马超应由李去打（阿古朵占包）');
  return `可行指定 warnings=${snip(okRes.warnings)}；不可行指定回退条数=${fallbackWarns.length}`;
});

/* ===================== al) presetsFromCombos：调研 + 用户必 ban 合并 ===================== */

t('[al] presetsFromCombos：用户必 ban 排最前标 must，AI 调研拆解点降级 watch，额外字段齐全', () => {
  isArr(PRESETS, 'PRESETS 应来自 presetsFromCombos（数组）');
  eq(PRESETS.length, COMBOS_FIXTURE.comps.length, '每套 combo 适配成 1 个 preset');

  const j = PRESETS.find((p) => p.id === 'jiangwang-boshi');
  ok(j, `应包含 jiangwang-boshi，实测 ${snip(PRESETS.map((p) => p.id))}`);
  eq(j.name, '僵王博士（鲁班七号 + 盾山）', 'name 来自 combo');
  eq(j.core.join(','), '鲁班七号,盾山', 'core 保留 combo 顺序');
  eq(j.size, 2, 'size = core.length');
  eq(j.priority, 'A', 'priority');
  eq(j.type, '移动扫射 / 射辅连体', 'type');
  eq(j.phase, '全期，对线强度 T0.5 起步', 'phase');
  eq(j.why, COMBOS_FIXTURE.comps[0].why, 'why 透传');
  isObj(j.lanes, 'lanes');
  eq((j.lanes['发育路'] || []).join(','), '鲁班七号', 'lanes 透传（发育路）');
  isArr(j.banTargets, 'banTargets');
  eq(j.banTargets.join(','), '盾山', 'banTargets 透传（对面可能 ban 的核心件）');
  isArr(j.counteredBy, 'counteredBy');
  eq(j.counteredBy.join(','), '吕布,貂蝉,镜,澜', 'counteredBy 透传（AI 调研克制点）');
  eq(j.confidence, 'high', 'confidence');
  isObj(j.stats, 'stats');
  eq(j.stats.matches, 6765, 'stats.matches');
  isNum(j.stats.idx, 'stats.idx');
  isArr(j.sources, 'sources');
  isObj(j.flex, 'flex');
  isObj(j.playstyle, 'playstyle');
  eq(j.playstyle.key, 'protect', 'playstyle 由 type/why 推断（射辅连体 → protect）');
  eq(j.winCondition, COMBOS_FIXTURE.comps[0].why, 'winCondition = why');

  // 合并口径：用户 mustBans 在前（level=must, source=user），AI counteredBy 在后（watch, research）
  isArr(j.threats, 'threats');
  const must = j.threats.filter((x) => x.level === 'must');
  eq(heroList(must).join(','), '墨子,王昭君,钟馗',
    `僵王博士 must 必须含用户必 ban（模板顺序），实测 ${snip(j.threats.map((x) => `${x.hero}/${x.level}`))}`);
  eq(must.every((x) => x.source === 'user'), true, 'must 来自用户实战补充');
  eq(must.every((x) => typeof x.reason === 'string' && x.reason.includes('用户实战')), true,
    'must 保留用户给的理由');
  const watch = j.threats.filter((x) => x.level === 'watch');
  eq(heroList(watch).join(','), '吕布,貂蝉,镜,澜', 'AI 调研拆解点降级为 watch');
  eq(watch.every((x) => x.source === 'research'), true, 'watch 来自 AI 调研');
  eq(j.threats.every((x) => j.core.indexOf(x.hero) === -1), true, 'threats 不含 core');

  // flex → partners（可替代核心位的搭配）
  isArr(j.partners, 'partners');
  eq(heroList(j.partners).join(','), '鲁班大师', 'flex 转成 partners');
  eq(j.partners[0].forSlot, '盾山', 'partners[].forSlot 记录被替代的核心件');

  // 没有用户 override 的组合：AI 调研前 3 个升为 must（本 fixture 只有 2 个 → 2 个 must）
  const k = PRESETS.find((p) => p.id === 'jing-zhangfei');
  ok(k, '应包含 jing-zhangfei');
  eq(k.threats.filter((x) => x.level === 'must').length, 2, '无 override 时调研前 3 个升 must（只有 2 个）');
  eq(k.threats.every((x) => x.source === 'research'), true, '无 override 时全部来自调研');
  eq(k.priority, 'B', 'B 档 priority');

  // 坏数据容错：不抛异常
  eq(API.presetsFromCombos(null, null).length, 0, '空 combos → []');
  eq(API.presetsFromCombos({ comps: [] }, null).length, 0, '空 comps → []');
  eq(API.presetsFromCombos({ comps: [{ id: 'no-core', core: [] }] }, null).length, 0,
    '没有 core 的 combo 被跳过');
  const arrInput = API.presetsFromCombos(COMBOS_FIXTURE.comps, null);
  eq(arrInput.length, 2, '直接传 comps 数组也能适配');

  return `presets=${PRESETS.length} 套；僵王博士 threats=${snip(j.threats.map((x) => `${x.hero}:${x.level}`))}；partners=${snip(heroList(j.partners))}`;
});

/* ===================== am) presetPlan：模板命中 ===================== */

t('[am] presetPlan（jiangwang-boshi）：core/threats/owners/progress 按契约 §3.1', () => {
  const ctx = mkPresetCtx();
  const res = API.presetPlan(ctx);

  eq(res.active, true, 'active');
  eq(res.custom, false, '模板命中 custom 应为 false');
  eq(res.id, 'jiangwang-boshi', 'id');
  eq(res.name, '僵王博士（鲁班七号 + 盾山）', 'name');
  eq(res.subtitle, 'A档 · 移动扫射 / 射辅连体', 'subtitle（priority + type）');
  isArr(res.tags, 'tags');
  eq(res.tags[0], 'A', 'tags 含 priority');
  isArr(res.warnings, 'warnings');

  // core：combos 顺序 + 字段齐全 + owners 来自我方池（契约 §3.1）
  isArr(res.core, 'core');
  eq(res.core.length, 2, `core 数量，实测 ${snip(heroList(res.core))}`);
  eq(heroList(res.core).join(','), '鲁班七号,盾山', 'core 顺序 = combo 顺序');
  const luban = res.core[0];
  eq(luban.hero, '鲁班七号', 'core[0].hero');
  eq(luban.heroId, 516, '鲁班七号.heroId');
  eq(luban.tier, 'T2', '鲁班七号.tier');
  eq(luban.lane, 'adc', '鲁班七号.lane');
  eq(luban.laneLabel, '发育路', '鲁班七号.laneLabel');
  eq(luban.inPool, true, '鲁班七号.inPool');
  eq(luban.status, 'available', '鲁班七号.status');
  eq(luban.statusLabel, '可拿', '鲁班七号.statusLabel');
  isArr(luban.owners, '鲁班七号.owners');
  eq(luban.owners.length, 1, '鲁班七号 owners 数');
  eq(luban.owners[0].playerIndex, 1, '鲁班七号 owner = 刘（playerIndex 1）');
  eq(luban.owners[0].name, '刘', '鲁班七号 owner.name');
  eq(luban.owners[0].mastery, 'normal', '鲁班七号 owner.mastery');
  eq(luban.owners[0].masteryLabel, '正常', '鲁班七号 owner.masteryLabel');
  const dunshan = res.core[1];
  eq(dunshan.heroId, 527, '盾山.heroId');
  eq(dunshan.lane, 'support', '盾山.lane');
  eq(dunshan.laneLabel, '游走', '盾山.laneLabel');
  eq(dunshan.inPool, true, '盾山.inPool');
  eq(dunshan.owners[0].playerIndex, 4, '盾山 owner = 张（playerIndex 4）');
  eq(dunshan.owners[0].mastery, 'best', '盾山 owner.mastery');
  eq(dunshan.owners[0].masteryLabel, '绝活', '盾山 owner.masteryLabel');

  // threats：用户必 ban（must）+ AI 调研（watch），钟馗在我方池也必须列出
  isArr(res.threats, 'threats');
  const must = res.threats.filter((x) => x.level === 'must');
  eq(must.length, 3, `must 威胁数，实测 ${snip(res.threats.map((x) => `${x.hero}/${x.level}`))}`);
  eq(heroList(must).join(','), '墨子,王昭君,钟馗', 'must 顺序 = 用户必 ban 顺序');
  for (const th of res.threats) {
    isNum(th.heroId, `${th.hero}.heroId`);
    isStr(th.tier, `${th.hero}.tier`);
    isStr(th.reason, `${th.hero}.reason`);
    ok(typeof th.inOurPool === 'boolean', `${th.hero}.inOurPool 应为布尔`);
    isArr(th.owners, `${th.hero}.owners`);
    isStr(th.status, `${th.hero}.status`);
    eq(th.banned, false, `${th.hero}.banned 初始应为 false`);
    ok(['must', 'watch'].includes(th.level), `${th.hero}.level 非法：${th.level}`);
  }
  eq(heroList(res.threats.filter((x) => x.level === 'watch')).join(','), '吕布,貂蝉,镜,澜',
    'AI 调研拆解点作为 watch 展示');
  eq(res.threats.find((x) => x.hero === '钟馗').inOurPool, true, '钟馗在我方池里 → inOurPool=true');
  eq(res.threats.find((x) => x.hero === '钟馗').owners.length, 1, '钟馗 owners 来自我方池');
  eq(res.threats.find((x) => x.hero === '墨子').inOurPool, false, '墨子不在我方池 → inOurPool=false');

  // partners：flex 转成的搭配位
  isArr(res.partners, 'partners');
  eq(res.partners.length, 1, `partners 数，实测 ${snip(heroList(res.partners))}`);
  eq(res.partners[0].hero, '鲁班大师', 'partners[0].hero');
  isNum(res.partners[0].heroId, '鲁班大师.heroId');
  isStr(res.partners[0].tier, '鲁班大师.tier');
  isStr(res.partners[0].note, '鲁班大师.note');
  eq(res.partners[0].inPool, true, '鲁班大师在我方池 → inPool=true');
  eq(res.partners[0].owners[0].name, '包', '鲁班大师 owner = 包');
  eq(res.partners[0].owners[0].mastery, 'normal', '鲁班大师 owner.mastery');
  isStr(res.partners[0].status, '鲁班大师.status');

  // playstyle / winCondition / teamPlan / tips
  isObj(res.playstyle, 'playstyle');
  eq(res.playstyle.key, 'protect', 'playstyle.key 来自 combo 推断');
  isStr(res.playstyle.label, 'playstyle.label');
  isStr(res.playstyle.desc, 'playstyle.desc');
  isStr(res.winCondition, 'winCondition');
  eq(res.winCondition, COMBOS_FIXTURE.comps[0].why, 'winCondition 来自 combo.why');
  isArr(res.teamPlan, 'teamPlan');
  eq(res.teamPlan.length, 5, 'combos 没有 teamPlan → 引擎按打法推导五路分工');
  for (const tp of res.teamPlan) {
    ok(PRESET_LANES.includes(tp.lane), `teamPlan.lane 非法：${tp.lane}`);
    isStr(tp.role, `teamPlan[${tp.lane}].role`);
    isStr(tp.instruction, `teamPlan[${tp.lane}].instruction`);
  }
  isArr(res.tips, 'tips');
  ok(res.tips.length > 0, 'tips 应非空');

  // progress（契约 §3.1 口径）
  isObj(res.progress, 'progress');
  eq(res.progress.core.total, 2, 'progress.core.total');
  eq(res.progress.core.picked, 0, 'progress.core.picked 初始 0');
  eq(res.progress.partners.total, 1, 'progress.partners.total');
  eq(res.progress.partners.picked, 0, 'progress.partners.picked 初始 0');
  eq(res.progress.bans.total, 3, 'progress.bans.total = must 威胁数');
  eq(res.progress.bans.banned, 0, 'progress.bans.banned 初始 0');

  // 状态推进：墨子已 ban / 盾山被对面 ban / 鲁班七号+鲁班大师已选
  const ctx2 = mkPresetCtx({
    bans: { ours: ['墨子'], theirs: ['盾山'] },
    picks: { blue: ['鲁班七号', '鲁班大师'], red: [] },
  });
  const r2 = API.presetPlan(ctx2);
  eq(r2.progress.bans.banned, 1, 'progress.bans.banned 只统计我方 ban 位里的 must 威胁');
  eq(r2.progress.core.picked, 1, 'progress.core.picked');
  eq(r2.progress.partners.picked, 1, 'progress.partners.picked');
  const ds2 = r2.core.find((c) => c.hero === '盾山');
  eq(ds2.status, 'banned', '被 ban 的核心 status=banned');
  eq(ds2.statusLabel, '已被 ban', '被 ban 的核心 statusLabel');
  const lb2 = r2.core.find((c) => c.hero === '鲁班七号');
  eq(lb2.status, 'picked', '已选核心 status=picked');
  eq(lb2.statusLabel, '已被选', '已选核心 statusLabel');
  ok(r2.warnings.some((w) => w.includes('盾山')), `核心被 ban 应给 warning：${snip(r2.warnings)}`);
  eq(r2.threats.find((x) => x.hero === '墨子').banned, true, 'threats[].banned 跟随 ban 状态');

  // 必 ban 未执行：我方 ban 位已满 5 个时提示（契约 §3.1 警告示例）
  const r3 = API.presetPlan(mkPresetCtx({ bans: { ours: ['澜', '镜', '露娜', '妲己', '小乔'], theirs: [] } }));
  eq(r3.progress.bans.banned, 0, '必 ban 一个都没执行');
  ok(r3.warnings.some((w) => ['墨子', '王昭君', '钟馗'].some((h) => w.includes(h))),
    `我方 ban 位已满且必 ban 未执行应提示：${snip(r3.warnings)}`);

  return `core=${snip(heroList(res.core))} must=${snip(heroList(must))} partners=${snip(heroList(res.partners))} progress=${snip(res.progress)}`;
});

/* ===================== an) presetPlan：自定义推导 ===================== */

t('[an] presetPlan（自定义 core=鲁班七号/盾山）：推导 partners/threats/playstyle，不抛异常', () => {
  // presets 为空 + id=custom → 走「自定义推导」（契约 §3.1）
  const ctx = mkPresetCtx({ presets: [], preset: { id: 'custom', core: ['鲁班七号', '盾山'] } });
  const res = API.presetPlan(ctx);

  eq(res.active, true, 'active');
  eq(res.custom, true, 'custom=true');
  eq(res.id, 'custom', 'id=custom');
  isArr(res.core, 'core');
  eq(heroList(res.core).join(','), '鲁班七号,盾山', 'core 按 preset.core 顺序');
  isStr(res.name, 'name 由核心推导');

  // partners：与核心有配合 / 标签互补的前 6 个
  isArr(res.partners, 'partners');
  ok(res.partners.length > 0, `自定义应推导出 partners：${snip(res.warnings)}`);
  ok(res.partners.length <= 6, `partners 最多 6 个，实测 ${res.partners.length}`);
  const coreSet = new Set(heroList(res.core));
  for (const p of res.partners) {
    ok(!coreSet.has(p.hero), `partners 不应包含核心：${p.hero}`);
    isStr(p.hero, 'partner.hero');
    isNum(p.heroId, `${p.hero}.heroId`);
    isStr(p.tier, `${p.hero}.tier`);
    isStr(p.note, `${p.hero}.note`);
    ok(typeof p.inPool === 'boolean', `${p.hero}.inPool`);
    isArr(p.owners, `${p.hero}.owners`);
    isStr(p.status, `${p.hero}.status`);
  }

  // threats：对核心克制分最高的前 5 个，前 3 个 must
  isArr(res.threats, 'threats');
  ok(res.threats.length > 0, `自定义应推导出 threats：${snip(res.warnings)}`);
  ok(res.threats.length <= 5, `threats 最多 5 个，实测 ${res.threats.length}`);
  eq(res.threats.slice(0, 3).every((x) => x.level === 'must'), true,
    `threats 前 3 个应为 must，实测 ${snip(res.threats.map((x) => `${x.hero}/${x.level}`))}`);
  for (const th of res.threats) {
    ok(!coreSet.has(th.hero), `threats 不应包含核心：${th.hero}`);
    isStr(th.hero, 'threat.hero');
    isNum(th.heroId, `${th.hero}.heroId`);
    isStr(th.tier, `${th.hero}.tier`);
    isStr(th.reason, `${th.hero}.reason`);
    ok(typeof th.banned === 'boolean', `${th.hero}.banned`);
    ok(['must', 'watch'].includes(th.level), `${th.hero}.level 非法：${th.level}`);
  }
  // fixture 里 钟馗/墨子/王昭君 都对核心有克制关系 → 至少一个进 threats
  ok(res.threats.some((x) => ['钟馗', '墨子', '王昭君'].includes(x.hero)),
    `对核心克制最高的英雄应进 threats：${snip(heroList(res.threats))}`);

  // playstyle / winCondition / teamPlan / tips 按核心标签推导
  isObj(res.playstyle, 'playstyle');
  eq(res.playstyle.key, 'protect', '鲁班七号(持续输出/远程)+盾山(保护/前排) → protect');
  isStr(res.playstyle.label, 'playstyle.label');
  isStr(res.playstyle.desc, 'playstyle.desc');
  isStr(res.winCondition, 'winCondition');
  isArr(res.teamPlan, 'teamPlan');
  ok(res.teamPlan.length > 0, '自定义应推导出 teamPlan');
  for (const tp of res.teamPlan) {
    ok(PRESET_LANES.includes(tp.lane), `teamPlan.lane 非法：${tp.lane}`);
    isStr(tp.instruction, `teamPlan[${tp.lane}].instruction`);
  }
  isArr(res.tips, 'tips');
  ok(res.tips.length > 0, '自定义应推导出 tips');
  isObj(res.progress, 'progress');
  eq(res.progress.core.total, 2, 'progress.core.total');

  // 自定义核心刚好等于某套 combo 的 core → 复用该模板的必 ban/搭配（custom 仍为 true）
  const reuse = API.presetPlan(mkPresetCtx({ preset: { id: 'custom', core: ['盾山', '鲁班七号'] } }));
  eq(reuse.active, true, 'presets 里有同 core 模板时仍 active');
  eq(reuse.custom, true, 'custom=true');
  eq(heroList(reuse.core).sort().join(','), '盾山,鲁班七号', 'core 集合一致');
  eq(reuse.threats.filter((x) => x.level === 'must').length, 3, '复用模板的 3 条用户必 ban');

  return `partners=${snip(heroList(res.partners))} threats=${snip(heroList(res.threats))} playstyle=${res.playstyle.key} plan=${res.teamPlan.length} 条`;
});

/* ===================== ao) banRecommend 预选增量 ===================== */

t('[ao] ban 预选：前 3 条 must ban（钟馗在我方池也必出现），核心不被 ban，commands 带 preset/mustBan', () => {
  const ctx = mkPresetCtx();
  const res = API.banRecommend(ctx);

  // preset 段（契约 §3.3）
  isObj(res.preset, 'ban.preset');
  eq(res.preset.active, true, 'ban.preset.active');
  eq(res.preset.id, 'jiangwang-boshi', 'ban.preset.id');
  isStr(res.preset.name, 'ban.preset.name');
  isArr(res.preset.mustBans, 'ban.preset.mustBans');
  eq(res.preset.mustBans.length, 3, 'mustBans 条数');
  eq(heroList(res.preset.mustBans).join(','), '墨子,王昭君,钟馗', 'mustBans 顺序 = 用户必 ban 顺序');
  for (const mb of res.preset.mustBans) {
    isStr(mb.reason, `${mb.hero}.reason`);
    eq(mb.banned, false, `${mb.hero}.banned`);
    eq(mb.picked, false, `${mb.hero}.picked`);
    ok(typeof mb.inOurPool === 'boolean', `${mb.hero}.inOurPool`);
    isArr(mb.owners, `${mb.hero}.owners`);
  }

  // fixture 前提：钟馗/王昭君在我方池里（覆盖「我方池内不 ban」规则）
  const pool = new Set(ctx.store.players.flatMap((p) => p.pool.map((e) => e.hero)));
  ok(pool.has('钟馗'), 'fixture 前提：钟馗在我方池里');
  ok(pool.has('王昭君'), 'fixture 前提：王昭君在我方池里');
  eq(res.preset.mustBans.find((x) => x.hero === '钟馗').inOurPool, true, '钟馗 inOurPool=true');

  // commands：must ban 强制排最前（按用户必 ban 顺序），即使在我方池里
  eq(res.commands.length, 5, 'commands 仍为 5 条');
  eq(res.commands.slice(0, 3).map((c) => c.hero).join(','), '墨子,王昭君,钟馗',
    `前 3 条 = must ban，实测 ${snip(res.commands.map((c) => c.hero))}`);
  for (const c of res.commands.slice(0, 3)) {
    eq(c.preset, true, `${c.hero}.preset=true`);
    eq(c.mustBan, true, `${c.hero}.mustBan=true`);
    isStr(c.presetReason, `${c.hero}.presetReason`);
    eq(c.reason.indexOf('预选必 ban：'), 0, `${c.hero}.reason 前缀「预选必 ban：」，实测 ${snip(c.reason)}`);
    ok(c.score >= 60, `${c.hero}.score 展示分应含 +60（实测 ${c.score}）`);
  }
  for (const c of res.commands.slice(3)) {
    eq(c.preset, false, `${c.hero}.preset=false（不是用户必 ban）`);
    eq(c.mustBan, false, `${c.hero}.mustBan=false`);
    if (c.presetWatch) {
      eq(c.reason.indexOf('预选提防：'), 0, `${c.hero}.reason 前缀「预选提防：」，实测 ${snip(c.reason)}`);
    }
  }
  // AI 调研拆解点（watch）也应进 ban 指令，但只标 presetWatch，不占必 ban 位
  eq(res.commands.slice(3).some((c) => c.presetWatch), true,
    `AI 调研拆解点应出现在 ban 指令并标 presetWatch，实测 ${snip(res.commands.map((c) => c.hero + '/' + (c.presetWatch ? 'watch' : '-')))}`);
  isArr(res.preset.watchBans, 'ban.preset.watchBans');
  eq(heroList(res.preset.watchBans).join(','), '吕布,貂蝉,镜,澜', 'watchBans = AI 调研拆解点（combo.counteredBy）');
  eq(res.preset.watchBans.every((x) => x.source === 'research'), true, 'watchBans.source=research');
  eq(res.preset.mustBans.every((x) => x.source === 'user'), true, 'mustBans.source=user（用户实战补充）');

  // 预选核心不得出现在 ban 候选（我方要拿）
  for (const hero of ['鲁班七号', '盾山']) {
    ok(!res.commands.some((c) => c.hero === hero), `核心 ${hero} 不应进 commands`);
    ok(!(res.shortlist || []).some((s) => s.hero === hero), `核心 ${hero} 不应进 shortlist`);
    ok(!res.commands.some((c) => (c.alternatives || []).some((a) => a.hero === hero)),
      `核心 ${hero} 不应进 alternatives`);
  }
  // shortlist 也把 must ban 排最前
  eq((res.shortlist || []).slice(0, 3).map((s) => s.hero).join(','), '墨子,王昭君,钟馗',
    `shortlist 前 3 条 = must ban，实测 ${snip((res.shortlist || []).map((s) => s.hero))}`);

  // 已被 ban 的 must 威胁：跳过、不重复占位、写 warning
  const r2 = API.banRecommend(mkPresetCtx({ bans: { ours: ['墨子'], theirs: [] } }));
  eq(r2.preset.mustBans.find((x) => x.hero === '墨子').banned, true, '墨子.banned=true');
  eq(r2.commands.slice(0, 2).map((c) => c.hero).join(','), '王昭君,钟馗', '已 ban 的 must 被跳过');
  ok(!r2.commands.some((c) => c.hero === '墨子'), '已 ban 的墨子不应重复占位');
  const allWarn = (r2.preset.warnings || []).concat(r2.warnings || []);
  ok(allWarn.some((w) => w.includes('墨子')),
    `已 ban 的 must 威胁应写 warning（契约 §3.3）：${snip(allWarn)}`);

  return `commands=${snip(res.commands.map((c) => `${c.hero}${c.mustBan ? '(必)' : ''}`))} shortlist=${snip((res.shortlist || []).map((s) => s.hero))}`;
});

/* ===================== ap) pickRecommend 预选增量 ===================== */

t('[ap] pick 预选：第 1 手候选前二含核心，候选带 preset.role/breakdown.preset，分路与一人一英雄约束不变', () => {
  // 必 ban 都已执行（真实 BP 里「全部采用」之后的状态）
  const ctx = mkPresetCtx({ bans: { ours: ['墨子', '王昭君', '钟馗'], theirs: [] } });
  const res = API.pickRecommend(ctx);

  eq(res.step.index, 0, 'step.index');
  eq(res.phase.key, 'grab', 'phase.key');
  eq(res.phase.pickNo, 1, 'phase.pickNo');

  // preset 段（契约 §3.4）
  isObj(res.preset, 'pick.preset');
  eq(res.preset.active, true, 'pick.preset.active');
  eq(res.preset.id, 'jiangwang-boshi', 'pick.preset.id');
  isArr(res.preset.coreStatus, 'pick.preset.coreStatus');
  eq(res.preset.coreStatus.length, 2, 'coreStatus 覆盖两个核心');
  isObj(res.preset.nextCore, 'pick.preset.nextCore');
  ok(['鲁班七号', '盾山'].includes(res.preset.nextCore.hero), `nextCore 应指向可拿核心，实测 ${snip(res.preset.nextCore)}`);
  isStr(res.preset.nextCore.roleLabel, 'nextCore.roleLabel');

  // 第 1 手候选前二含核心（契约 §5.1-4）
  ok(res.candidates.length >= 2, `候选应 ≥2，实测 ${res.candidates.length}`);
  const top2 = res.candidates.slice(0, 2);
  ok(top2.some((c) => c.preset && c.preset.role === 'core'),
    `第 1 手候选前二应含预选核心，实测 ${snip(top2.map((c) => `${c.hero}/${c.preset && c.preset.role}`))}`);

  // 核心候选：preset.role/label/note + breakdown.preset 计入总分
  for (const hero of ['鲁班七号', '盾山']) {
    const c = findCand(res, hero);
    ok(c, `核心 ${hero} 应在候选里：${candNames(res)}`);
    eq(c.preset.role, 'core', `${hero}.preset.role`);
    eq(c.preset.label, '预选核心', `${hero}.preset.label`);
    isStr(c.preset.note, `${hero}.preset.note`);
    isNum(c.breakdown.preset, `${hero}.breakdown.preset`);
    ok(c.breakdown.preset > 0, `${hero}.breakdown.preset 应 > 0，实测 ${c.breakdown.preset}`);
    eq(c.reason.indexOf('预选核心'), 0, `${hero}.reason 前缀「预选核心」，实测 ${snip(c.reason)}`);
    // breakdown 各项相加 = score（预选加分已计入）
    const sum = c.breakdown.tier + c.breakdown.counter + c.breakdown.countered + c.breakdown.synergy +
      c.breakdown.compNeed + c.breakdown.laneNeed + c.breakdown.mastery + c.breakdown.preset;
    near(sum, c.score, 0.11, `${hero}: breakdown 之和应 ≈ score（preset 已计入）`);
  }

  // flex 搭配位：preset.role=partner + 预选搭配 label
  const partner = findCand(res, '鲁班大师');
  ok(partner, `搭配位「鲁班大师」应在候选里：${candNames(res)}`);
  eq(partner.preset.role, 'partner', '鲁班大师.preset.role');
  eq(partner.preset.label, '预选搭配', '鲁班大师.preset.label');
  isStr(partner.preset.note, '鲁班大师.preset.note');
  isNum(partner.breakdown.preset, '鲁班大师.breakdown.preset');
  ok(partner.breakdown.preset > 0, '搭配位应有正的 breakdown.preset');
  eq(partner.reason.indexOf('预选搭配'), 0, `鲁班大师.reason 前缀「预选搭配」，实测 ${snip(partner.reason)}`);

  // 不在方案内的候选：preset.role 为 null、breakdown.preset=0
  for (const c of res.candidates) {
    if (['鲁班七号', '盾山', '鲁班大师'].includes(c.hero)) continue;
    eq(c.preset.role, null, `${c.hero} 不在方案内 → preset.role=null`);
    eq(c.breakdown.preset, 0, `${c.hero} 不在方案内 → breakdown.preset=0`);
  }

  // v2.2 分路过滤仍成立：每个候选都能补待补分路
  ok(res.laneState.open.length > 0, '首手待补分路应非空');
  for (const c of res.candidates) {
    ok(c.lanes.some((l) => res.laneState.open.includes(l)),
      `${c.hero} 不能补任何待补分路（open=${snip(res.laneState.open)}，lanes=${snip(c.lanes)}）`);
  }
  // v2.3 一人一英雄匹配仍成立
  eq(uniq(res.assignment.map((a) => a.playerIndex)), true, 'assignment 一人一英雄');
  for (const c of res.candidates) {
    isObj(c.assignedTo, `${c.hero}.assignedTo`);
    isArr(c.fielders, `${c.hero}.fielders`);
  }

  // 核心被 ban → nextCore 指向下一个可拿核心，并给 warning
  const r2 = API.pickRecommend(mkPresetCtx({ bans: { ours: ['墨子', '王昭君', '钟馗'], theirs: ['鲁班七号'] } }));
  eq(r2.preset.nextCore.hero, '盾山', `鲁班七号被 ban 后 nextCore 应指向盾山，实测 ${snip(r2.preset.nextCore)}`);
  ok((r2.preset.warnings || []).some((w) => w.includes('鲁班七号')),
    `核心被 ban 应给 warning：${snip(r2.preset.warnings)}`);
  eq(r2.preset.coreStatus.find((x) => x.hero === '鲁班七号').status, 'banned', 'coreStatus 标 banned');

  return `候选=${candNames(res, 6)}；top2=${snip(top2.map((c) => c.hero))}；nextCore=${snip(res.preset.nextCore)}`;
});

/* ===================== aq) teamReview：10 手完成 ===================== */

t('[aq] teamReview：10 手完成 → done=true、双方 score/grade/dimensions/strengths/risks，breakdown 和≈score，占位被过滤', () => {
  // 我方 5 手：核心 2 个 + 搭配 1 个 + 两个偏出方案（且能完成一人一英雄匹配）
  const ctx = mkPresetCtx({
    bans: { ours: ['墨子', '王昭君', '钟馗'], theirs: ['澜', '镜'] },
    picks: {
      blue: ['鲁班七号', '盾山', '鲁班大师', '露娜', '小乔'],
      red: ['后羿', '妲己', '白起', '兰陵王', '空1'],
    },
  });
  const res = API.teamReview(ctx);

  eq(res.done, true, 'done（10 手完成，占位也计数）');
  isStr(res.date, 'date');
  eq(res.side, 'blue', 'side');
  isArr(res.warnings, 'warnings');
  isObj(res.ours, 'ours');
  isObj(res.theirs, 'theirs');

  const sides = [['ours', res.ours, 'blue', '我方'], ['theirs', res.theirs, 'red', '敌方']];
  for (const [key, sr, side, label] of sides) {
    isObj(sr, `${key}`);
    eq(sr.side, side, `${key}.side`);
    eq(sr.label, label, `${key}.label`);
    isArr(sr.heroes, `${key}.heroes`);
    eq(sr.heroes.length, key === 'ours' ? 5 : 4, `${key}.heroes 应过滤占位「空N」`);
    ok(!sr.heroes.some((h) => /^空/.test(h)), `${key}.heroes 不应含占位英雄：${snip(sr.heroes)}`);
    for (const h of sr.heroes) ok(ctx.heroes.some((x) => x.name === h), `${key}.heroes 含未知英雄：${h}`);

    isNum(sr.score, `${key}.score`);
    ok(sr.score >= 0 && sr.score <= 100, `${key}.score 应在 0..100，实测 ${sr.score}`);
    isObj(sr.grade, `${key}.grade`);
    ok(GRADE_KEYS.includes(sr.grade.key), `${key}.grade.key 非法：${sr.grade.key}`);
    isStr(sr.grade.label, `${key}.grade.label`);
    ok(GRADE_TONES.includes(sr.grade.tone), `${key}.grade.tone 非法：${sr.grade.tone}`);

    isObj(sr.breakdown, `${key}.breakdown`);
    for (const b of ['tier', 'structure', 'synergy', 'matchup']) isNum(sr.breakdown[b], `${key}.breakdown.${b}`);
    const sum = sr.breakdown.tier + sr.breakdown.structure + sr.breakdown.synergy + sr.breakdown.matchup;
    ok(Math.abs(sum - sr.score) <= 0.2,
      `${key}: breakdown 之和 ${r1(sum)} 应 ≈ score ${sr.score}（逐项保留 1 位小数的舍入容差）`);

    isArr(sr.dimensions, `${key}.dimensions`);
    eq(sr.dimensions.length, 5, `${key}.dimensions 应 5 项`);
    const dimKeys = sr.dimensions.map((d) => d.key);
    for (const k of DIM_KEYS) ok(dimKeys.includes(k), `${key}.dimensions 缺 ${k}`);
    for (const d of sr.dimensions) {
      isStr(d.label, `${key}.dimensions[${d.key}].label`);
      ok(typeof d.value === 'number' || typeof d.value === 'string', `${key}.dimensions[${d.key}].value 类型`);
      ok(d.need !== undefined, `${key}.dimensions[${d.key}].need 缺失`);
      ok(['ok', 'warn', 'bad'].includes(d.level), `${key}.dimensions[${d.key}].level 非法：${d.level}`);
      isStr(d.detail, `${key}.dimensions[${d.key}].detail`);
    }

    isObj(sr.playstyle, `${key}.playstyle`);
    isStr(sr.playstyle.key, `${key}.playstyle.key`);
    isStr(sr.playstyle.label, `${key}.playstyle.label`);
    isStr(sr.playstyle.desc, `${key}.playstyle.desc`);

    isObj(sr.core, `${key}.core`);
    isStr(sr.core.hero, `${key}.core.hero`);
    isStr(sr.core.tier, `${key}.core.tier`);
    isStr(sr.core.reason, `${key}.core.reason`);

    isArr(sr.synergies, `${key}.synergies`);
    ok(sr.synergies.length <= 3, `${key}.synergies 最多 3 对`);
    for (const s of sr.synergies) {
      isStr(s.a, `${key}.synergies.a`);
      isStr(s.b, `${key}.synergies.b`);
      isNum(s.w, `${key}.synergies.w`);
      ok(s.w >= 0.5, `${key}.synergies.w 应 ≥0.5，实测 ${s.w}`);
      isStr(s.note, `${key}.synergies.note`);
    }

    isArr(sr.strengths, `${key}.strengths`);
    ok(sr.strengths.length >= 2, `${key}.strengths 至少 2 条，实测 ${sr.strengths.length}`);
    for (const s of sr.strengths) isStr(s, `${key}.strengths 条目`);
    isArr(sr.risks, `${key}.risks`);
    ok(sr.risks.length >= 2, `${key}.risks 至少 2 条，实测 ${sr.risks.length}`);
    for (const s of sr.risks) isStr(s, `${key}.risks 条目`);

    isObj(sr.bans, `${key}.bans`);
    isArr(sr.bans.ours, `${key}.bans.ours`);
    isArr(sr.bans.theirs, `${key}.bans.theirs`);
    isObj(sr.lanePlan, `${key}.lanePlan`);
    isArr(sr.lanePlan.assignments, `${key}.lanePlan.assignments`);
    isArr(sr.lanePlan.uncovered, `${key}.lanePlan.uncovered`);
  }

  // assignment：我方有（一人一英雄），敌方没有熟练度数据 → []
  isArr(res.ours.assignment, 'ours.assignment');
  eq(res.ours.assignment.length, 5, 'ours.assignment 应覆盖 5 手');
  eq(uniq(res.ours.assignment.map((a) => a.playerName)), true, 'ours.assignment 一人一英雄');
  for (const a of res.ours.assignment) {
    isStr(a.hero, 'assignment.hero');
    isStr(a.playerName, 'assignment.playerName');
    isStr(a.mastery, 'assignment.mastery');
    isStr(a.masteryLabel, 'assignment.masteryLabel');
  }
  isArr(res.theirs.assignment, 'theirs.assignment');
  eq(res.theirs.assignment.length, 0, '敌方无熟练度数据 → assignment=[]');

  // matchup（契约 §3.2）
  isObj(res.matchup, 'matchup');
  isObj(res.matchup.verdict, 'matchup.verdict');
  ok(['even', 'ours', 'theirs'].includes(res.matchup.verdict.key),
    `matchup.verdict.key 非法：${res.matchup.verdict.key}`);
  isStr(res.matchup.verdict.label, 'verdict.label');
  isStr(res.matchup.verdict.note, 'verdict.note');
  isArr(res.matchup.edges, 'matchup.edges');
  ok(res.matchup.edges.length > 0, 'matchup.edges 应非空');
  for (const e of res.matchup.edges) {
    isStr(e.key, 'edge.key');
    isStr(e.label, 'edge.label');
    isNum(e.ours, `edge[${e.key}].ours`);
    isNum(e.theirs, `edge[${e.key}].theirs`);
    ok(['ours', 'theirs', 'even'].includes(e.lead), `edge[${e.key}].lead 非法：${e.lead}`);
    isStr(e.note, `edge[${e.key}].note`);
  }
  isArr(res.matchup.threats, 'matchup.threats');
  ok(res.matchup.threats.length <= 3, 'matchup.threats 最多 3 条');
  for (const th of res.matchup.threats) {
    isStr(th.hero, 'matchup.threats.hero');
    isStr(th.tier, 'matchup.threats.tier');
    isStr(th.reason, 'matchup.threats.reason');
  }
  isArr(res.matchup.winConditions, 'matchup.winConditions');
  ok(res.matchup.winConditions.length >= 2 && res.matchup.winConditions.length <= 4,
    `winConditions 应为 2-4 条，实测 ${res.matchup.winConditions.length}`);
  isArr(res.matchup.tips, 'matchup.tips');
  ok(res.matchup.tips.length >= 2, `tips 至少 2 条，实测 ${res.matchup.tips.length}`);

  // preset 段（契约 §3.2）
  isObj(res.preset, 'review.preset');
  eq(res.preset.active, true, 'review.preset.active');
  eq(res.preset.id, 'jiangwang-boshi', 'review.preset.id');
  isStr(res.preset.name, 'review.preset.name');
  eq(res.preset.coreHit, 2, 'coreHit');
  eq(res.preset.coreTotal, 2, 'coreTotal');
  eq(res.preset.mustBansDone, 3, 'mustBansDone（只统计我方 ban 位）');
  eq(res.preset.mustBansTotal, 3, 'mustBansTotal');
  eq(res.preset.partnerHit, 1, 'partnerHit（鲁班大师拿到）');
  eq(res.preset.partnerTotal, 1, 'partnerTotal（flex 搭配位 1 个）');
  isNum(res.preset.matchScore, 'matchScore');
  isArr(res.preset.coreStatus, 'review.preset.coreStatus');
  eq(res.preset.coreStatus.length, 2, 'coreStatus 覆盖两个核心');
  const c7 = res.preset.coreStatus.find((x) => x.hero === '鲁班七号');
  eq(c7.status, 'picked', '鲁班七号 coreStatus');
  isStr(c7.playerName, 'coreStatus.playerName');
  isArr(res.preset.offPlan, 'review.preset.offPlan');
  eq(res.preset.offPlan.slice().sort().join(','), '小乔,露娜',
    `offPlan = 我方 picks 里不属于 core/partners 的英雄，实测 ${snip(res.preset.offPlan)}`);
  isArr(res.preset.notes, 'review.preset.notes');
  ok(res.preset.notes.length > 0, 'notes 应非空');
  const noteText = res.preset.notes.join(' ');
  ok(/核心/.test(noteText), `notes 应说明核心完成度：${snip(noteText)}`);
  ok(/ban/i.test(noteText), `notes 应说明必 ban 执行情况：${snip(noteText)}`);

  // done:false 时也返回已有信息（契约 §3.2）
  const partial = API.teamReview(mkPresetCtx({ picks: { blue: ['鲁班七号'], red: ['后羿'] } }));
  eq(partial.done, false, '未满 10 手 → done=false');
  isNum(partial.ours.score, 'done:false 时 ours.score 仍应返回');
  isNum(partial.theirs.score, 'done:false 时 theirs.score 仍应返回');

  return `ours=${res.ours.score}/${res.ours.grade.key} theirs=${res.theirs.score}/${res.theirs.grade.key} verdict=${res.matchup.verdict.key} matchScore=${res.preset.matchScore}`;
});

/* ===================== ar) 预选匹配分 + 核心被 ban 降级 ===================== */

t('[ar] 预选匹配：核心 2/2 + must ban 3/3 → matchScore≥90；核心被 ban → 降级并提示', () => {
  const goodCtx = mkPresetCtx({
    bans: { ours: ['墨子', '王昭君', '钟馗'], theirs: ['澜', '镜'] },
    picks: {
      blue: ['鲁班七号', '盾山', '鲁班大师', '露娜', '小乔'],
      red: ['后羿', '妲己', '白起', '兰陵王', '空1'],
    },
  });
  const good = API.teamReview(goodCtx);
  eq(good.preset.coreHit, 2, '核心 2/2');
  eq(good.preset.coreTotal, 2, 'coreTotal');
  eq(good.preset.mustBansDone, 3, 'must ban 3/3');
  eq(good.preset.mustBansTotal, 3, 'mustBansTotal');
  ok(good.preset.matchScore >= 90, `核心 2/2 + must ban 3/3 → matchScore 应 ≥90，实测 ${good.preset.matchScore}`);
  // 公式：round(60*coreHit/coreTotal + 30*mustBansDone/mustBansTotal + 10*partnerHit/partnerTotal)
  const expected = Math.round(
    60 * good.preset.coreHit / good.preset.coreTotal +
    30 * good.preset.mustBansDone / good.preset.mustBansTotal +
    10 * good.preset.partnerHit / good.preset.partnerTotal
  );
  eq(good.preset.matchScore, expected, 'matchScore 按契约公式计算');

  // 核心被对面 ban → 降级 + 提示
  const bad = API.teamReview(mkPresetCtx({
    bans: { ours: ['墨子', '王昭君', '钟馗'], theirs: ['鲁班七号'] },
    picks: {
      blue: ['盾山', '鲁班大师', '后羿', '露娜', '小乔'],
      red: ['妲己', '白起', '兰陵王', '镜', '空1'],
    },
  }));
  eq(bad.done, true, '降级场景仍是 10 手');
  eq(bad.preset.coreHit, 1, '核心只拿到 1 个');
  ok(bad.preset.matchScore < good.preset.matchScore,
    `核心被 ban 后 matchScore 应下降（${bad.preset.matchScore} < ${good.preset.matchScore}）`);
  eq(bad.preset.coreStatus.find((x) => x.hero === '鲁班七号').status, 'banned',
    '被 ban 的核心 coreStatus.status=banned');
  const downgradeText = (bad.preset.notes || []).join(' ');
  ok(/降级/.test(downgradeText), `核心被 ban 应有降级提示：${snip(downgradeText)}`);
  ok(/1\/2/.test(downgradeText), `notes 应写明核心 1/2：${snip(downgradeText)}`);
  // 我方 5 手仍能完成一人一英雄匹配
  eq(bad.ours.assignment.length, 5, '降级场景仍能完成一人一英雄分配');

  return `matchScore: 全拿到=${good.preset.matchScore} / 核心被 ban=${bad.preset.matchScore}；notes=${snip(bad.preset.notes)}`;
});

/* ===================== as) 空数据安全 ===================== */

t('[as] 空数据：无 presets / 无 preset / 空 ctx → presetPlan/teamReview active:false 且不抛异常', () => {
  const cases = [
    ['空 ctx {}', {}],
    ['null', null],
    ['undefined', undefined],
    ['无 presets 无 preset', mkCtx({ presets: [], preset: null })],
    ['有 presets 但 preset=null', mkCtx()],
    ['preset.id 未命中且无 core', mkCtx({ preset: { id: 'no-such-combo' } })],
    ['presets 为空 + 未命中 id', mkCtx({ presets: [], preset: { id: 'jiangwang-boshi' } })],
  ];
  for (const [label, ctx] of cases) {
    const plan = API.presetPlan(ctx);
    isObj(plan, `${label}: presetPlan 应返回对象`);
    eq(plan.active, false, `${label}: presetPlan.active`);
    isArr(plan.core, `${label}: plan.core`);
    eq(plan.core.length, 0, `${label}: plan.core 应为空`);
    isArr(plan.threats, `${label}: plan.threats`);
    eq(plan.threats.length, 0, `${label}: plan.threats 应为空`);
    isArr(plan.partners, `${label}: plan.partners`);
    eq(plan.partners.length, 0, `${label}: plan.partners 应为空`);
    isObj(plan.progress, `${label}: plan.progress`);
    eq(plan.progress.core.picked, 0, `${label}: progress.core.picked`);
    eq(plan.progress.core.total, 0, `${label}: progress.core.total`);
    eq(plan.progress.partners.picked, 0, `${label}: progress.partners.picked`);
    eq(plan.progress.partners.total, 0, `${label}: progress.partners.total`);
    eq(plan.progress.bans.banned, 0, `${label}: progress.bans.banned`);
    eq(plan.progress.bans.total, 0, `${label}: progress.bans.total`);
    isArr(plan.warnings, `${label}: plan.warnings`);

    const review = API.teamReview(ctx);
    isObj(review, `${label}: teamReview 应返回对象`);
    eq(review.done, false, `${label}: teamReview.done`);
    isObj(review.preset, `${label}: review.preset`);
    eq(review.preset.active, false, `${label}: review.preset.active`);
    eq(review.preset.matchScore, null, `${label}: 无预选时 matchScore=null`);
    isArr(review.preset.notes, `${label}: review.preset.notes`);
    eq(review.preset.notes.length, 0, `${label}: 无预选时 notes=[]`);

    // 原有函数不受影响
    const ban = API.banRecommend(ctx);
    isArr(ban.commands, `${label}: ban.commands`);
    isArr(ban.warnings, `${label}: ban.warnings`);
    isObj(ban.preset, `${label}: ban.preset`);
    eq(ban.preset.active, false, `${label}: ban.preset.active`);
    const pick = API.pickRecommend(ctx);
    isArr(pick.candidates, `${label}: pick.candidates`);
    isObj(pick.preset, `${label}: pick.preset`);
    eq(pick.preset.active, false, `${label}: pick.preset.active`);
  }

  // preset 存在但英雄表为空：不抛异常、active 可为 false（核心解析不到）
  const noHeroes = API.presetPlan(mkPresetCtx({ heroes: [] }));
  isObj(noHeroes, '空英雄表 presetPlan 应返回对象');
  isArr(noHeroes.core, '空英雄表 plan.core');
  isArr(noHeroes.warnings, '空英雄表 plan.warnings');

  return `覆盖 ${cases.length} 种空数据组合，均 active:false 且未抛异常`;
});

/* ────────────────────────── 汇总 ────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log('\n=== 汇总 ===');
console.log(`共 ${results.length} 项：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
if (failed.length) {
  console.log('失败明细：');
  for (const f of failed) {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.err}`);
  }
  process.exitCode = 1;
} else {
  console.log('全部通过（契约 v2.3 §1/§2/§4 + v2.4 预选阵容/队伍总体评价 对应断言）。');
}
