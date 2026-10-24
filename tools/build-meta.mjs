#!/usr/bin/env node
/**
 * build-meta.mjs —— 从天元之弈快照构建 data/meta.json 与 data/relations.json
 *
 * 用法:
 *   node hok-bp/tools/build-meta.mjs                # 用 data/snapshot 下最新日期
 *   node hok-bp/tools/build-meta.mjs --date 2026-10-23
 *   node hok-bp/tools/build-meta.mjs --dry          # 只打印计数，不写文件
 *
 * 输入（只读）: hok-bp/data/snapshot/<date>/{tier.json,herostats-1.json,analysis.json}
 *              hok-bp/bp/data/heroes.js（133 条英雄主表）
 * 输出: hok-bp/data/meta.json, hok-bp/data/relations.json
 *       （data/store.json 缺失时补一份空模板，已存在则绝不覆盖）
 *
 * 幂等：同一份快照重复跑，输出字节级一致（所有数组都做稳定排序）。
 *
 * ---- 关于「李信(光)/李信(暗)」聚合（契约 §2.1 只有一条「李信」）----
 * 天元 herostats-1 给的是 3 条：heroId 50701(光)/50702(暗)，baseHeroId=507，
 * **外加一条 heroId=507 的聚合行**（实测 2026-10-23：光 pick 8.6 + 暗 pick 11.4 ≈ 聚合 19.9）。
 * 所以我们的处理是：
 *   1) 优先取天元自己算好的聚合行（heroId === baseHeroId），它的 winRate 是真实加权结果；
 *   2) 只有聚合行缺失时才退回「pickRate 较大的那条变体」；
 *   3) 任何情况下都不做 (光+暗)/2 这种自造平均，也不编造分样本量。
 * 理由：变体没有各自 totalMatches，无法按样本量加权，自造平均会引入假数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOK = path.resolve(HERE, '..');            // hok-bp/
const SNAP_ROOT = path.join(HOK, 'data', 'snapshot');
const DATA_DIR = path.join(HOK, 'data');

const TIERS = new Set(['T0', 'T0.5', 'T1', 'T2', 'T3', 'T4']);

// 契约 §2.2 标签全集（契约正文写「17 个」，实际列举 18 个，以列举为准）
const TAG_SET = [
  '前排', '开团', '保护', '控制', '硬控', '免控', '回复', '护盾', '真伤',
  '爆发', '持续输出', '收割', '位移', '远程', '近战', '法伤', '物伤', '体系',
];

// ---------------------------------------------------------------- 标签初稿
// 天元没有标签数据，这是 data-kit 依据「英雄 type + 分路 + 公认定位」给的初稿，
// 每人 2-4 个，宁可保守不硬凑。人工可在此表直接改。
const TAGS = {
  廉颇: ['前排', '开团', '控制', '免控'],
  小乔: ['法伤', '爆发', '远程'],
  赵云: ['位移', '爆发', '近战', '控制'],
  墨子: ['控制', '法伤', '开团', '远程'],
  妲己: ['法伤', '爆发', '硬控'],
  嬴政: ['法伤', '持续输出', '远程'],
  孙尚香: ['持续输出', '远程', '物伤', '位移'],
  鲁班七号: ['持续输出', '远程', '物伤'],
  庄周: ['免控', '保护', '前排'],
  刘禅: ['前排', '硬控', '开团'],
  高渐离: ['法伤', '爆发', '近战'],
  阿轲: ['位移', '爆发', '收割', '近战'],
  钟无艳: ['前排', '硬控', '近战'],
  孙膑: ['保护', '控制'],
  扁鹊: ['法伤', '回复', '持续输出', '远程'],
  白起: ['前排', '硬控', '开团'],
  芈月: ['法伤', '免控', '持续输出'],
  吕布: ['前排', '近战', '物伤', '真伤'],
  周瑜: ['法伤', '持续输出', '控制', '远程'],
  元歌: ['位移', '爆发', '收割'],
  夏侯惇: ['前排', '控制', '近战'],
  甄姬: ['法伤', '控制', '硬控', '远程'],
  曹操: ['近战', '物伤', '前排', '持续输出'],
  典韦: ['近战', '物伤', '爆发', '收割'],
  宫本武藏: ['位移', '爆发', '近战', '收割'],
  李白: ['位移', '爆发', '收割', '近战'],
  马可波罗: ['持续输出', '远程', '物伤', '位移'],
  狄仁杰: ['持续输出', '远程', '物伤', '免控'],
  达摩: ['前排', '硬控', '开团', '近战'],
  项羽: ['前排', '开团', '控制', '近战'],
  武则天: ['法伤', '硬控', '远程', '体系'],
  司马懿: ['位移', '爆发', '收割', '法伤'],
  王维: ['法伤', '爆发'],
  老夫子: ['前排', '近战', '硬控'],
  关羽: ['前排', '开团', '位移', '控制'],
  貂蝉: ['法伤', '持续输出', '真伤'],
  安琪拉: ['法伤', '爆发', '控制', '远程'],
  程咬金: ['前排', '回复', '近战', '物伤'],
  露娜: ['位移', '法伤', '持续输出', '收割'],
  姜子牙: ['法伤', '控制', '远程'],
  刘邦: ['前排', '保护', '体系'],
  韩信: ['位移', '爆发', '收割', '近战'],
  孙权: ['持续输出', '远程', '物伤'],
  王昭君: ['法伤', '控制', '硬控', '远程'],
  兰陵王: ['位移', '爆发', '收割', '近战'],
  花木兰: ['位移', '近战', '物伤', '控制'],
  艾琳: ['持续输出', '远程', '物伤'],
  张良: ['硬控', '控制', '法伤', '远程'],
  不知火舞: ['位移', '爆发', '硬控', '近战'],
  朵莉亚: ['保护', '回复', '控制'],
  娜可露露: ['位移', '爆发', '收割', '近战'],
  橘右京: ['位移', '爆发', '近战', '收割'],
  亚瑟: ['前排', '近战', '物伤', '控制'],
  孙悟空: ['位移', '爆发', '收割', '近战'],
  牛魔: ['前排', '开团', '硬控', '控制'],
  后羿: ['持续输出', '远程', '物伤'],
  刘备: ['近战', '物伤', '前排', '持续输出'],
  张飞: ['前排', '开团', '保护', '硬控'],
  蚩奼: ['前排', '近战', '物伤'],
  李元芳: ['持续输出', '远程', '物伤', '位移'],
  虞姬: ['持续输出', '远程', '物伤'],
  钟馗: ['硬控', '开团', '法伤', '控制'],
  杨玉环: ['法伤', '回复', '持续输出'],
  苍: ['持续输出', '远程', '物伤'],
  杨戬: ['前排', '近战', '物伤', '回复'],
  女娲: ['法伤', '控制', '远程'],
  哪吒: ['前排', '开团', '位移'],
  干将莫邪: ['法伤', '爆发', '远程'],
  雅典娜: ['位移', '近战', '物伤', '爆发'],
  蔡文姬: ['回复', '保护', '硬控'],
  太乙真人: ['保护', '控制', '前排'],
  东皇太一: ['硬控', '前排', '法伤', '控制'],
  大禹: ['前排', '保护', '控制'],
  鬼谷子: ['开团', '位移', '控制'],
  诸葛亮: ['法伤', '爆发', '收割', '位移'],
  大乔: ['体系', '保护', '控制', '远程'],
  黄忠: ['持续输出', '远程', '物伤'],
  铠: ['前排', '近战', '物伤', '爆发'],
  苏烈: ['前排', '开团', '硬控', '控制'],
  百里玄策: ['位移', '爆发', '收割'],
  百里守约: ['远程', '爆发', '物伤', '收割'],
  弈星: ['法伤', '控制', '硬控', '远程'],
  梦奇: ['前排', '法伤', '近战'],
  公孙离: ['持续输出', '远程', '物伤', '位移'],
  沈梦溪: ['法伤', '远程', '持续输出', '位移'],
  明世隐: ['保护', '回复', '体系'],
  裴擒虎: ['位移', '爆发', '近战', '收割'],
  狂铁: ['前排', '近战', '物伤', '护盾'],
  米莱狄: ['法伤', '持续输出', '远程'],
  瑶: ['保护', '护盾'],
  云中君: ['位移', '爆发', '收割', '近战'],
  李信: ['前排', '近战', '物伤'],
  伽罗: ['持续输出', '远程', '物伤'],
  盾山: ['前排', '保护', '控制'],
  孙策: ['前排', '开团', '控制', '物伤'],
  猪八戒: ['前排', '回复', '控制', '近战'],
  上官婉儿: ['位移', '法伤', '爆发', '收割'],
  亚连: ['前排', '近战', '物伤'],
  嫦娥: ['法伤', '护盾', '控制', '近战'],
  大司命: ['前排', '近战', '物伤'],
  马超: ['位移', '近战', '物伤', '持续输出'],
  敖隐: ['持续输出', '远程', '物伤'],
  海月: ['法伤', '爆发', '控制', '远程'],
  曜: ['位移', '爆发', '近战'],
  西施: ['控制', '法伤', '硬控', '远程'],
  蒙犽: ['持续输出', '远程', '物伤'],
  鲁班大师: ['保护', '控制', '前排'],
  蒙恬: ['前排', '近战', '物伤'],
  澜: ['位移', '爆发', '收割', '近战'],
  盘古: ['前排', '近战', '物伤'],
  镜: ['位移', '爆发', '收割', '近战'],
  阿古朵: ['持续输出', '远程', '物伤'],
  桑启: ['回复', '保护', '控制'],
  夏洛特: ['位移', '近战', '物伤', '爆发'],
  司空震: ['法伤', '近战', '持续输出'],
  云缨: ['位移', '近战', '物伤'],
  金蝉: ['控制', '法伤', '保护'],
  暃: ['位移', '爆发', '收割', '近战'],
  赵怀真: ['前排', '近战', '物伤', '控制'],
  莱西奥: ['持续输出', '远程', '物伤', '位移'],
  卢雅那: ['持续输出', '远程', '物伤'],
  戈娅: ['持续输出', '远程', '物伤', '位移'],
  心魔六耳: ['位移', '爆发', '收割', '近战'],
  空空儿: ['保护', '控制'],
  影: ['前排', '近战', '物伤'],
  海诺: ['法伤', '控制', '近战'],
  姬小满: ['近战', '物伤', '爆发', '位移'],
  少司缘: ['保护', '回复', '控制'],
  '元流之子(坦克)': ['前排', '开团', '控制'],
  '元流之子(法师)': ['法伤', '爆发', '远程', '控制'],
  '元流之子(刺客)': ['位移', '爆发', '收割', '近战'],
  '元流之子(射手)': ['持续输出', '远程', '物伤'],
  '元流之子(辅助)': ['保护', '回复', '控制'],
};

// heroes.js 官方 type 错项修正（天元/allheroes 也没有 type，只能人工核）
const OVERRIDES = {
  // 官方数据把「元流之子(刺客)」的 type 标成 ['辅助']，实际是刺客形态
  '元流之子(刺客)': { type: ['刺客'] },
};

// 契约 v2.1 默认权重：Ban 以强度（T0）为主，克制只做同档内排序
const WEIGHTS = {
  tier: 10.0,
  threat: 1.5,
  fragility: 0.8,
  answerable: 1.0,
  counter: 1.1,
  countered: 0.9,
  synergy: 1.0,
  compNeed: 1.4,
  laneNeed: 1.4,
};

// 克制/配合阈值（契约 §2.3 + task-1 要求）
const COUNTER_MIN_MATCHES = 150;
const COUNTER_MIN_IDX = 2;
const SYNERGY_MIN_MATCHES = 150;
const SYNERGY_MIN_IDX = 1.5;

// ---------------------------------------------------------------- helpers
const clamp = (lo, hi, v) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (v) => Math.round(v * 100) / 100;

function parseArgs(argv) {
  const out = { date: null, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node hok-bp/tools/build-meta.mjs [--date YYYY-MM-DD] [--dry]');
      process.exit(0);
    } else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadHeroes() {
  // 契约 §2.1 写的是 data/heroes.js，仓库实际在 bp/data/heroes.js，两处都试
  const candidates = [
    path.join(HOK, 'bp', 'data', 'heroes.js'),
    path.join(HOK, 'data', 'heroes.js'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error(`找不到 heroes.js，尝试过: ${candidates.join(', ')}`);
  const src = fs.readFileSync(file, 'utf8');
  const json = src.replace(/^\s*window\.HEROES\s*=\s*/, '').replace(/;\s*$/, '');
  const heroes = JSON.parse(json);
  if (!Array.isArray(heroes) || heroes.length === 0) throw new Error('heroes.js 解析失败');
  return { heroes, file };
}

function latestSnapshotDate() {
  if (!fs.existsSync(SNAP_ROOT)) throw new Error(`快照目录不存在: ${SNAP_ROOT}`);
  const dates = fs
    .readdirSync(SNAP_ROOT)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .filter((n) => fs.statSync(path.join(SNAP_ROOT, n)).isDirectory())
    .sort();
  if (!dates.length) throw new Error(`快照目录为空: ${SNAP_ROOT}`);
  return dates[dates.length - 1];
}

/** 变体英雄名 → 基础英雄名。只有「李信(光)/李信(暗)」需要折叠成「李信」；
 *  注意不能按括号一刀切：「元流之子(坦克/法师/刺客/射手/辅助)」是 5 个**独立英雄**，
 *  在 heroes.js 里有各自独立的条目，必须保留全名。 */
function variantName(name) {
  if (!name) return null;
  return /^李信[（(]光[)）]$/.test(name) || /^李信[（(]暗[)）]$/.test(name) ? '李信' : name;
}

// ---------------------------------------------------------------- 主体
function main() {
  const args = parseArgs(process.argv);
  const { heroes, file: heroesFile } = loadHeroes();
  const heroNames = new Set(heroes.map((h) => h.name));
  const idToName = new Map(heroes.map((h) => [h.id, h.name]));

  const date = args.date || latestSnapshotDate();
  const snapDir = path.join(SNAP_ROOT, date);
  if (!fs.existsSync(snapDir)) throw new Error(`快照目录不存在: ${snapDir}`);

  const tierFile = path.join(snapDir, 'tier.json');
  const statsFile = path.join(snapDir, 'herostats-1.json');
  const analysisFile = path.join(snapDir, 'analysis.json');

  if (!fs.existsSync(tierFile)) throw new Error(`缺少 tier.json: ${tierFile}`);
  const tierRows = readJson(tierFile).tiers || [];
  if (!tierRows.length) throw new Error('tier.json 里没有 tiers[]');

  // ---- 胜率/出场/禁率（全分段 gameMode=1）
  // 变体聚合优先级（针对 李信(光)/李信(暗) → 李信）：herostats-1 里除了 50701/50702
  // 两条变体，还自带一条 heroId=507 的**聚合行**（pick 8.6 + 11.4 ≈ 19.9），
  // 因此优先用「天元自己算好的聚合行」，其次才退回「pickRate 较大的变体」，
  // 绝不用 (光+暗)/2 这种自造加权。
  const statsByName = new Map();
  let statsRows = [];
  if (fs.existsSync(statsFile)) {
    statsRows = readJson(statsFile);
    const isPlain = (row) => row.heroId === row.baseHeroId;
    for (const row of statsRows) {
      const key = row.baseHeroId === 507 ? '李信' : row.heroName;
      if (!key) continue;
      const prev = statsByName.get(key);
      if (!prev) {
        statsByName.set(key, row);
        continue;
      }
      if (isPlain(row) && !isPlain(prev)) statsByName.set(key, row);
      else if (isPlain(row) === isPlain(prev) && (row.pickRate ?? 0) > (prev.pickRate ?? 0)) {
        statsByName.set(key, row);
      }
    }
  } else {
    console.warn(`[warn] 缺少 ${statsFile}，tiers 里不会有 winRate/pickRate/banRate`);
  }

  // ---- tiers（按英雄名，只保留 heroes.js 里存在的；tier 非法降级 T2）
  const tiers = {};
  const tierWarnings = [];
  const seenTierHeroes = new Set();
  for (const row of tierRows) {
    const name = row.heroName;
    if (!name || !heroNames.has(name)) {
      tierWarnings.push(`tier.json 里的英雄不在 heroes.js: ${name}(${row.heroId})`);
      continue;
    }
    if (seenTierHeroes.has(name)) {
      tierWarnings.push(`tier.json 重复英雄: ${name}`);
      continue;
    }
    seenTierHeroes.add(name);
    let tier = row.tierInRole;
    if (!TIERS.has(tier)) {
      tierWarnings.push(`${name} 的 tierInRole 非法(${tier})，按 T2 处理`);
      tier = 'T2';
    }
    const st = statsByName.get(name) || null;
    tiers[name] = {
      tier,
      score: typeof row.finalNormalizedTierScore === 'number' ? r2(row.finalNormalizedTierScore) : null,
      role: row.role || '',
      winRate: st && typeof st.winRate === 'number' ? r2(st.winRate) : null,
      pickRate: st && typeof st.pickRate === 'number' ? r2(st.pickRate) : null,
      banRate: st && typeof st.banRate === 'number' ? r2(st.banRate) : null,
      winRateDelta: st && typeof st.winRateDelta === 'number' ? r2(st.winRateDelta) : null,
    };
  }

  // ---- tags（133 条全覆盖）
  const tags = {};
  const tagWarnings = [];
  for (const h of heroes) {
    const t = TAGS[h.name];
    if (!Array.isArray(t) || !t.length) {
      tagWarnings.push(`缺少标签: ${h.name}`);
      continue;
    }
    const bad = t.filter((x) => !TAG_SET.includes(x));
    if (bad.length) tagWarnings.push(`${h.name} 含非法标签: ${bad.join('/')}`);
    if (t.length > 4) tagWarnings.push(`${h.name} 标签超过 4 个: ${t.length}`);
    tags[h.name] = t.filter((x) => TAG_SET.includes(x));
  }
  for (const name of Object.keys(TAGS)) {
    if (!heroNames.has(name)) tagWarnings.push(`标签表里有 heroes.js 不存在的英雄: ${name}`);
  }

  // ---- relations（analysis.json: { [heroId]: {counters,counteredBy,goodSynergies,badSynergies} }）
  const counters = [];
  const synergies = [];
  const seenCounter = new Set();
  const synergyBest = new Map(); // "a||b" -> entry（a/b 无序）
  const relWarnings = [];
  let analysisHeroCount = 0;
  let analysisMissing = 0;

  if (fs.existsSync(analysisFile)) {
    const analysis = readJson(analysisFile);
    const keys = Object.keys(analysis);
    analysisHeroCount = keys.length;
    for (const key of keys) {
      const aName = idToName.get(Number(key)) || null;
      if (!aName) {
        relWarnings.push(`analysis.json key=${key} 不对应 heroes.js 里的 id`);
        continue;
      }
      const payload = analysis[key] || {};
      // counters: advantageIndex > 0
      for (const e of payload.counters || []) {
        const bName = variantName(e.heroName);
        const matches = Number(e.totalMatches);
        const idx = Number(e.advantageIndex);
        if (!bName || !heroNames.has(bName)) {
          relWarnings.push(`${aName} counters 里的对手不认识: ${e.heroName}`);
          continue;
        }
        if (bName === aName) continue;
        if (!(matches >= COUNTER_MIN_MATCHES)) continue;
        if (!(idx >= COUNTER_MIN_IDX)) continue;
        const pair = `${aName}||${bName}`;
        if (seenCounter.has(pair)) continue;
        seenCounter.add(pair);
        counters.push({
          a: aName,
          b: bName,
          w: r2(clamp(0.3, 1.0, 0.3 + idx / 10)),
          matches: Math.round(matches),
          idx: r2(idx),
          src: 'stats',
        });
      }
      // synergies: synergyIndex > 0
      for (const e of payload.goodSynergies || []) {
        const bName = variantName(e.heroName);
        const matches = Number(e.totalMatches);
        const idx = Number(e.synergyIndex);
        if (!bName || !heroNames.has(bName)) {
          relWarnings.push(`${aName} goodSynergies 里的队友不认识: ${e.heroName}`);
          continue;
        }
        if (bName === aName) continue;
        if (!(matches >= SYNERGY_MIN_MATCHES)) continue;
        if (!(idx >= SYNERGY_MIN_IDX)) continue;
        const entry = {
          a: aName,
          b: bName,
          w: r2(clamp(0.3, 1.0, 0.3 + idx / 8)),
          matches: Math.round(matches),
          idx: r2(idx),
          src: 'stats',
        };
        // a/b 无序去重：保留 w 较大的那条（w 相同则保留 idx 大的 = 效果等同）
        const k1 = `${aName}||${bName}`;
        const k2 = `${bName}||${aName}`;
        const prevKey = synergyBest.has(k1) ? k1 : synergyBest.has(k2) ? k2 : null;
        if (prevKey) {
          const prev = synergyBest.get(prevKey);
          if (entry.w > prev.w || (entry.w === prev.w && entry.matches > prev.matches)) {
            synergyBest.set(prevKey, entry);
          }
        } else {
          synergyBest.set(k1, entry);
        }
      }
    }
    for (const e of synergyBest.values()) synergies.push(e);
  } else {
    analysisMissing = 1;
    relWarnings.push(`缺少 ${analysisFile}：relations 只能为空数组（等 Lead 抓完重跑）`);
  }

  // 稳定排序（幂等）
  counters.sort((x, y) => (x.a === y.a ? (x.b === y.b ? 0 : x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
  synergies.sort((x, y) => {
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    if (x.b !== y.b) return x.b < y.b ? -1 : 1;
    return 0;
  });

  // ---- 组装
  const meta = {
    version: date,
    source: '天元之弈 https://tianyuanzhiyi.com',
    tagSource: 'draft', // 标签为人工初稿（天元无标签数据），UI 可点选校正
    tiers,
    tags,
    overrides: OVERRIDES,
    weights: WEIGHTS,
  };

  const relations = { date, counters, synergies };

  // ---- 写盘
  if (!args.dry) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 1) + '\n', 'utf8');
    fs.writeFileSync(path.join(DATA_DIR, 'relations.json'), JSON.stringify(relations, null, 1) + '\n', 'utf8');
    // store.json：只在缺失时补空模板，绝不覆盖用户数据
    const storeFile = path.join(DATA_DIR, 'store.json');
    if (!fs.existsSync(storeFile)) {
      fs.writeFileSync(storeFile, JSON.stringify(emptyStore(), null, 1) + '\n', 'utf8');
      console.log('store.json 不存在，已写入空模板');
    }
  }

  // ---- 报告
  const tierDist = {};
  for (const t of Object.values(tiers)) tierDist[t.tier] = (tierDist[t.tier] || 0) + 1;
  const srcDist = { stats: 0, manual: 0, inferred: 0 };
  for (const r of [...counters, ...synergies]) srcDist[r.src] = (srcDist[r.src] || 0) + 1;

  console.log(`[build-meta] snapshot = ${date}${analysisMissing ? '（analysis.json 缺失）' : ''}`);
  console.log(`[build-meta] heroes.js = ${path.relative(process.cwd(), heroesFile)} (${heroes.length} 条)`);
  console.log(`[build-meta] tiers       = ${Object.keys(tiers).length} / ${heroes.length}  分布 ${JSON.stringify(tierDist)}`);
  console.log(`[build-meta]   statsRows = ${statsRows.length}（含李信光/暗变体），李信取样 = ${statsByName.get('李信') ? statsByName.get('李信').heroName : '无'}`);
  console.log(`[build-meta] tags        = ${Object.keys(tags).length} / ${heroes.length}`);
  console.log(`[build-meta] counters    = ${counters.length}   (matches>=${COUNTER_MIN_MATCHES}, idx>=${COUNTER_MIN_IDX})`);
  console.log(`[build-meta] synergies   = ${synergies.length}   (matches>=${SYNERGY_MIN_MATCHES}, idx>=${SYNERGY_MIN_IDX}, a/b 无序去重)`);
  console.log(`[build-meta] analysis    = ${analysisHeroCount} 个英雄`);
  console.log(`[build-meta] src 分布    = ${JSON.stringify(srcDist)}`);
  if (args.dry) console.log('[build-meta] --dry：未写文件');

  const allWarn = [...tierWarnings, ...tagWarnings, ...relWarnings];
  if (allWarn.length) {
    console.log(`[build-meta] 警告 ${allWarn.length} 条:`);
    for (const w of allWarn.slice(0, 20)) console.log('  - ' + w);
    if (allWarn.length > 20) console.log(`  ... 其余 ${allWarn.length - 20} 条略`);
  }

  // 硬性抽查：缺标签/缺 tiers 视为构建失败（避免静默少数据）
  const missingTags = heroes.filter((h) => !tags[h.name]).map((h) => h.name);
  const missingTiers = heroes.filter((h) => !tiers[h.name]).map((h) => h.name);
  if (missingTags.length || missingTiers.length) {
    console.error(`[build-meta] FAIL 缺标签 ${missingTags.length} 个、缺 tiers ${missingTiers.length} 个`);
    if (missingTags.length) console.error('  缺标签: ' + missingTags.join(','));
    if (missingTiers.length) console.error('  缺 tiers: ' + missingTiers.join(','));
    process.exit(1);
  }
  console.log('[build-meta] OK');
}

function emptyStore() {
  const lanes = ['top', 'jungle', 'mid', 'adc', 'support'];
  return {
    side: 'blue',
    players: lanes.map((lane, i) => ({ lane, name: `玩家${i + 1}`, floor: i + 1, pool: [] })),
    allowCrossLane: false,
    weights: {},
    history: [],
  };
}

main();
