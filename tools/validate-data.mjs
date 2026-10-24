#!/usr/bin/env node
/**
 * validate-data.mjs —— 数据层校验（契约 §2，data-kit 交付）
 *
 * 用法: node hok-bp/tools/validate-data.mjs
 * 退出码: 0 = 全部通过；1 = 有错误（打印前 20 条）
 *
 * 校验项:
 *  1. heroes.js 可解析（133 条，id/name/roles/type 齐备）
 *  2. meta.json: version/source/tiers/tags/overrides/weights 结构
 *     - tiers 的 key 必须命中 heroes.js 的 name；tier ∈ T0|T0.5|T1|T2|T3|T4；score 数值
 *     - tags 的 key 必须命中 heroes.js；非空；只含契约 §2.2 的标签；2-4 个
 *     - overrides 的 key 必须命中 heroes.js
 *     - weights 字段齐全且为数字
 *  3. relations.json: counters/synergies 每条 a/b 存在 heroes.js、a!==b、w∈[0.3,1.0]、
 *     src∈stats|manual|inferred、matches/idx 数值；counters 无重复对；synergies 无序去重
 *  4. store.json: 5 条 players、lane 唯一且为 5 条标准分路、floor 1-5 唯一、名字非空、
 *     pool 里的英雄名都存在、side∈blue|red、allowCrossLane 布尔、history 数组
 *  5. combos.json（AI 调研组合，v2.4 预选数据源）: comps 非空、id 唯一且 kebab-case、core 2-5 且英雄存在、
 *     size===core.length、priority∈S|A|B、counteredBy/banTargets/flex/lanes 里的英雄都存在、
 *     stats{idx:number|null,matches:number}、sources 非空
 *  6. combo-bans.json（用户实战必 ban）: overrides 的 combo id 必须存在于 combos、mustBans 非空、
 *     banned hero 存在、reason 非空
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOK = path.resolve(HERE, '..');
const DATA = path.join(HOK, 'data');

const TIERS = new Set(['T0', 'T0.5', 'T1', 'T2', 'T3', 'T4']);
// 契约 §2.2 标签全集（正文说 17 个，列举是 18 个，以列举为准）
const TAG_SET = new Set([
  '前排', '开团', '保护', '控制', '硬控', '免控', '回复', '护盾', '真伤',
  '爆发', '持续输出', '收割', '位移', '远程', '近战', '法伤', '物伤', '体系',
]);
const SRC_SET = new Set(['stats', 'manual', 'inferred']);
const LANES = ['top', 'jungle', 'mid', 'adc', 'support'];
const WEIGHT_KEYS = ['tier', 'threat', 'fragility', 'answerable', 'counter', 'countered', 'synergy', 'compNeed', 'laneNeed'];

const errors = [];
const warnings = [];
const stats = {};
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

function readText(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}
function readJson(p, label) {
  const txt = readText(p);
  if (txt === null) {
    err(`缺少文件: ${path.relative(process.cwd(), p)}（${label}）`);
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    err(`${label} 不是合法 JSON: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- 1. heroes
let heroes = [];
{
  const candidates = [path.join(HOK, 'bp', 'data', 'heroes.js'), path.join(DATA, 'heroes.js')];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    err('找不到 heroes.js（bp/data/heroes.js 或 data/heroes.js）');
  } else {
    try {
      const src = fs.readFileSync(file, 'utf8');
      heroes = JSON.parse(src.replace(/^\s*window\.HEROES\s*=\s*/, '').replace(/;\s*$/, ''));
      if (!Array.isArray(heroes) || heroes.length === 0) err('heroes.js 不是非空数组');
    } catch (e) {
      err(`heroes.js 解析失败: ${e.message}`);
    }
  }
}
const heroNames = new Set(heroes.map((h) => h.name));
const heroById = new Map(heroes.map((h) => [h.id, h]));
stats.heroes = heroes.length;
if (heroes.length && heroes.length !== 133) warn(`heroes.js 条数为 ${heroes.length}（契约写 133）`);
{
  const ids = new Set();
  for (const h of heroes) {
    if (!isNum(h.id)) err(`heroes.js 条目缺 id: ${JSON.stringify(h).slice(0, 60)}`);
    if (!isStr(h.name)) err(`heroes.js 条目缺 name (id=${h.id})`);
    if (!Array.isArray(h.roles) || !h.roles.length) err(`英雄 ${h.name} 缺 roles`);
    else {
      for (const r of h.roles) if (!LANES.includes(r)) err(`英雄 ${h.name} 的 roles 含非法分路: ${r}`);
    }
    if (!Array.isArray(h.type) || !h.type.length) err(`英雄 ${h.name} 缺 type`);
    if (ids.has(h.id)) err(`heroes.js 重复 id: ${h.id}`);
    ids.add(h.id);
    if (heroNames.has(h.name) && heroes.filter((x) => x.name === h.name).length > 1) {
      err(`heroes.js 重复 name: ${h.name}`);
    }
  }
}

// ---------------------------------------------------------------- 2. meta
const meta = readJson(path.join(DATA, 'meta.json'), 'meta.json');
if (meta) {
  stats.metaVersion = meta.version;
  if (!isStr(meta.version)) err('meta.version 缺失');
  if (!isStr(meta.source)) err('meta.source 缺失');

  const tiers = meta.tiers && typeof meta.tiers === 'object' ? meta.tiers : null;
  if (!tiers) err('meta.tiers 缺失或不是对象');
  else {
    const keys = Object.keys(tiers);
    stats.tiers = keys.length;
    for (const name of keys) {
      const t = tiers[name];
      if (!heroNames.has(name)) err(`meta.tiers 的 key 不在 heroes.js: ${name}`);
      if (!t || typeof t !== 'object') {
        err(`meta.tiers['${name}'] 不是对象`);
        continue;
      }
      if (!TIERS.has(t.tier)) err(`meta.tiers['${name}'].tier 非法: ${t.tier}`);
      if (t.score !== null && !isNum(t.score)) err(`meta.tiers['${name}'].score 不是数字: ${t.score}`);
      for (const f of ['winRate', 'pickRate', 'banRate', 'winRateDelta']) {
        if (t[f] !== null && t[f] !== undefined && !isNum(t[f])) {
          err(`meta.tiers['${name}'].${f} 不是数字: ${t[f]}`);
        }
      }
      if (typeof t.role !== 'string') err(`meta.tiers['${name}'].role 不是字符串`);
    }
    const missing = [...heroNames].filter((n) => !(n in tiers));
    if (missing.length) err(`meta.tiers 缺 ${missing.length} 个英雄: ${missing.slice(0, 8).join(',')}${missing.length > 8 ? '…' : ''}`);
  }

  const tags = meta.tags && typeof meta.tags === 'object' ? meta.tags : null;
  if (!tags) err('meta.tags 缺失或不是对象');
  else {
    const keys = Object.keys(tags);
    stats.tags = keys.length;
    let tagTotal = 0;
    for (const name of keys) {
      const list = tags[name];
      if (!heroNames.has(name)) err(`meta.tags 的 key 不在 heroes.js: ${name}`);
      if (!Array.isArray(list) || list.length === 0) {
        err(`meta.tags['${name}'] 不是非空数组`);
        continue;
      }
      tagTotal += list.length;
      if (list.length < 2 || list.length > 4) err(`meta.tags['${name}'] 标签数 ${list.length}（契约要求 2-4 个）`);
      const seen = new Set();
      for (const tg of list) {
        if (!TAG_SET.has(tg)) err(`meta.tags['${name}'] 含非法标签: ${tg}`);
        if (seen.has(tg)) err(`meta.tags['${name}'] 重复标签: ${tg}`);
        seen.add(tg);
      }
    }
    stats.tagTotal = tagTotal;
    const missing = [...heroNames].filter((n) => !(n in tags));
    if (missing.length) err(`meta.tags 缺 ${missing.length} 个英雄: ${missing.slice(0, 8).join(',')}${missing.length > 8 ? '…' : ''}`);
  }

  const ov = meta.overrides;
  if (ov !== undefined) {
    if (!ov || typeof ov !== 'object' || Array.isArray(ov)) err('meta.overrides 不是对象');
    else {
      stats.overrides = Object.keys(ov).length;
      for (const [name, patch] of Object.entries(ov)) {
        if (!heroNames.has(name)) err(`meta.overrides 的 key 不在 heroes.js: ${name}`);
        if (!patch || typeof patch !== 'object') err(`meta.overrides['${name}'] 不是对象`);
      }
    }
  }

  const w = meta.weights;
  if (!w || typeof w !== 'object') err('meta.weights 缺失');
  else {
    for (const k of WEIGHT_KEYS) {
      if (!(k in w)) err(`meta.weights 缺字段: ${k}`);
      else if (!isNum(w[k])) err(`meta.weights.${k} 不是数字: ${w[k]}`);
    }
  }
}

// ---------------------------------------------------------------- 3. relations
const rel = readJson(path.join(DATA, 'relations.json'), 'relations.json');
if (rel) {
  stats.relDate = rel.date;
  if (!isStr(rel.date)) err('relations.date 缺失');
  for (const kind of ['counters', 'synergies']) {
    const list = rel[kind];
    if (!Array.isArray(list)) {
      err(`relations.${kind} 不是数组`);
      continue;
    }
    stats[kind] = list.length;
    const seen = new Set();
    let wSum = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const at = `relations.${kind}[${i}]`;
      if (!r || typeof r !== 'object') {
        err(`${at} 不是对象`);
        continue;
      }
      if (!heroNames.has(r.a)) err(`${at}.a 不在 heroes.js: ${r.a}`);
      if (!heroNames.has(r.b)) err(`${at}.b 不在 heroes.js: ${r.b}`);
      if (r.a === r.b) err(`${at} 自反: ${r.a} → ${r.b}`);
      if (!isNum(r.w) || r.w < 0.3 || r.w > 1.0) err(`${at}.w 不在 [0.3,1.0]: ${r.w}`);
      else wSum += r.w;
      if (!SRC_SET.has(r.src)) err(`${at}.src 非法: ${r.src}`);
      if (!isNum(r.matches) || r.matches < 0) err(`${at}.matches 非法: ${r.matches}`);
      if (!isNum(r.idx)) err(`${at}.idx 不是数字: ${r.idx}`);
      if (kind === 'counters') {
        const key = `${r.a}||${r.b}`;
        if (seen.has(key)) err(`${at} 重复克制对: ${key}`);
        seen.add(key);
        // 阈值是 build-meta 的统计约定；src=stats 的条目必须满足，manual 可豁免
        if (r.src === 'stats') {
          if (isNum(r.matches) && r.matches < 150) warn(`${at} 样本量 ${r.matches} < 150（counters 约定）`);
          if (isNum(r.idx) && r.idx < 2) warn(`${at} idx ${r.idx} < 2（counters 约定）`);
        }
      } else {
        const key = [r.a, r.b].sort().join('||');
        if (seen.has(key)) err(`${at} 重复配合对（a/b 无序）: ${r.a}+${r.b}`);
        seen.add(key);
        if (r.src === 'stats') {
          if (isNum(r.matches) && r.matches < 150) warn(`${at} 样本量 ${r.matches} < 150（synergies 约定）`);
          if (isNum(r.idx) && r.idx < 1.5) warn(`${at} idx ${r.idx} < 1.5（synergies 约定）`);
        }
      }
    }
    if (list.length) stats[kind + 'AvgW'] = Math.round((wSum / list.length) * 1000) / 1000;
  }
  if (Array.isArray(rel.counters) && rel.counters.length === 0) warn('relations.counters 为空（analysis.json 未抓完？）');
  if (Array.isArray(rel.synergies) && rel.synergies.length === 0) warn('relations.synergies 为空（analysis.json 未抓完？）');
}

// ---------------------------------------------------------------- 4. store
const MASTERIES = ['best', 'normal', 'basic'];
// store.json 是运行期存档（不进仓库）：缺失时校验 data/store.sample.json，两者都缺才算错
const storePath = path.join(DATA, 'store.json');
const storeSamplePath = path.join(DATA, 'store.sample.json');
let store = null;
if (fs.existsSync(storePath)) {
  store = readJson(storePath, 'store.json');
} else if (fs.existsSync(storeSamplePath)) {
  store = readJson(storeSamplePath, 'store.sample.json');
  if (store) warn('store.json 不存在（运行期存档），已改为校验 data/store.sample.json');
} else {
  err('缺少文件: data/store.json 与 data/store.sample.json');
}
if (store) {
  if (!['blue', 'red'].includes(store.side)) err(`store.side 非法: ${store.side}`);
  if (store.allowCrossLane !== undefined && typeof store.allowCrossLane !== 'boolean') err(`store.allowCrossLane 不是布尔: ${store.allowCrossLane}`);
  if (!Array.isArray(store.history)) err('store.history 不是数组');
  if (store.weights !== undefined && (typeof store.weights !== 'object' || Array.isArray(store.weights))) {
    err('store.weights 不是对象');
  }
  if (store.version !== 2) warn(`store.version = ${store.version}（v2 契约要求 2，旧版会自动迁移）`);
  const players = store.players;
  if (!Array.isArray(players)) err('store.players 不是数组');
  else {
    stats.storePlayers = players.length;
    if (players.length !== 5) err(`store.players 应为 5 条，实际 ${players.length}`);
    const floors = new Set();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const at = `store.players[${i}]`;
      if (!p || typeof p !== 'object') {
        err(`${at} 不是对象`);
        continue;
      }
      if (p.lane !== undefined) err(`${at}.lane 已废弃（v2 取消分路绑定，改用 preferLanes）: ${p.lane}`);
      if (!Array.isArray(p.preferLanes) || p.preferLanes.length === 0) err(`${at}.preferLanes 应为 1-2 个分路的数组`);
      else {
        if (p.preferLanes.length > 2) err(`${at}.preferLanes 最多 2 个，实际 ${p.preferLanes.length}`);
        for (const l of p.preferLanes) if (!LANES.includes(l)) err(`${at}.preferLanes 含非法分路: ${l}`);
      }
      if (!isStr(p.name)) err(`${at}.name 为空`);
      if (!isNum(p.floor) || p.floor < 1 || p.floor > 5) err(`${at}.floor 非法: ${p.floor}`);
      else if (floors.has(p.floor)) err(`${at}.floor 重复: ${p.floor}`);
      else floors.add(p.floor);
      if (!Array.isArray(p.pool)) err(`${at}.pool 不是数组`);
      else {
        const seen = new Set();
        for (const item of p.pool) {
          const hero = typeof item === 'string' ? item : (item && item.hero);
          const mastery = typeof item === 'string' ? 'normal' : (item && item.mastery);
          if (!hero) { err(`${at}.pool 条目缺少 hero: ${JSON.stringify(item)}`); continue; }
          if (!heroNames.has(hero)) err(`${at}.pool 含不存在的英雄: ${hero}`);
          if (seen.has(hero)) err(`${at}.pool 重复英雄: ${hero}`);
          seen.add(hero);
          if (!MASTERIES.includes(mastery)) err(`${at}.pool「${hero}」熟练度非法: ${mastery}（应为 best/normal/basic）`);
        }
      }
    }
    const missingFloor = [1, 2, 3, 4, 5].filter((f) => !floors.has(f));
    if (missingFloor.length) err(`store.players 缺楼层: ${missingFloor.join(',')}`);
    stats.storePoolTotal = players.reduce((s, p) => s + (Array.isArray(p.pool) ? p.pool.length : 0), 0);
  }
}

// ---------------------------------------------------------------- 5. combos（AI 调研组合）
const LANE_LABELS = ['对抗路', '打野', '中路', '发育路', '游走'];
const PRIORITIES = new Set(['S', 'A', 'B']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const comboIds = new Set();

const combosDoc = readJson(path.join(DATA, 'combos.json'), 'combos.json');
if (combosDoc) {
  stats.combosSource = combosDoc.source;
  if (combosDoc.version !== undefined && !isNum(combosDoc.version) && !isStr(combosDoc.version)) {
    err(`combos.version 应为数字或非空字符串: ${JSON.stringify(combosDoc.version)}`);
  }
  if (combosDoc.date !== undefined && !isStr(combosDoc.date)) err('combos.date 不是非空字符串');
  const comps = combosDoc.comps;
  if (!Array.isArray(comps) || comps.length === 0) {
    err('combos.comps 应为非空数组');
  } else {
    stats.combos = comps.length;
    if (comps.length < 20) err(`combos.comps 只有 ${comps.length} 套（预选模板库要求 ≥20）`);
    else if (comps.length !== 34) warn(`combos.comps 为 ${comps.length} 套（交付口径是 34 套）`);
    const ids = new Set();
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      const at = `combos[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        err(`${at} 不是对象`);
        continue;
      }
      if (!isStr(c.id)) err(`${at}.id 缺失`);
      else {
        if (!KEBAB.test(c.id)) err(`${at}.id 不是 kebab-case: ${c.id}`);
        if (ids.has(c.id)) err(`${at}.id 重复: ${c.id}`);
        ids.add(c.id);
        comboIds.add(c.id);
      }
      for (const f of ['name', 'type', 'phase', 'why']) {
        if (!isStr(c[f])) err(`${at}.${f} 缺失或为空`);
      }
      if (!PRIORITIES.has(c.priority)) err(`${at}.priority 非法: ${c.priority}（应为 S|A|B）`);
      if (c.confidence !== undefined && !CONFIDENCES.has(c.confidence)) {
        err(`${at}.confidence 非法: ${c.confidence}（应为 high|medium|low）`);
      }

      const core = c.core;
      const coreSet = new Set();
      if (!Array.isArray(core) || core.length === 0) {
        err(`${at}.core 应为非空数组`);
      } else {
        if (core.length < 2 || core.length > 5) err(`${at}.core 应为 2-5 个英雄，实际 ${core.length}`);
        for (const h of core) {
          if (!isStr(h)) { err(`${at}.core 含非字符串: ${JSON.stringify(h)}`); continue; }
          if (!heroNames.has(h)) err(`${at}.core 英雄不存在: ${h}`);
          if (coreSet.has(h)) err(`${at}.core 重复英雄: ${h}`);
          coreSet.add(h);
        }
        if (isNum(c.size) && c.size !== core.length) {
          err(`${at}.size=${c.size} 与 core.length=${core.length} 不一致`);
        }
      }
      if (!isNum(c.size)) err(`${at}.size 不是数字: ${c.size}`);

      // counteredBy：被谁克制（英雄必须存在，且不能是自家 core）
      if (!Array.isArray(c.counteredBy) || c.counteredBy.length === 0) {
        err(`${at}.counteredBy 应为非空数组（AI 调研的拆解点）`);
      } else {
        const seen = new Set();
        for (const h of c.counteredBy) {
          if (!isStr(h)) { err(`${at}.counteredBy 含非字符串: ${JSON.stringify(h)}`); continue; }
          if (!heroNames.has(h)) err(`${at}.counteredBy 英雄不存在: ${h}`);
          if (coreSet.has(h)) err(`${at}.counteredBy 不能是 core 英雄: ${h}`);
          if (seen.has(h)) err(`${at}.counteredBy 重复英雄: ${h}`);
          seen.add(h);
        }
      }

      // banTargets：对面可能 ban 的核心件
      if (c.banTargets !== undefined) {
        if (!Array.isArray(c.banTargets)) err(`${at}.banTargets 不是数组`);
        else {
          for (const h of c.banTargets) {
            if (!isStr(h)) { err(`${at}.banTargets 含非字符串: ${JSON.stringify(h)}`); continue; }
            if (!heroNames.has(h)) err(`${at}.banTargets 英雄不存在: ${h}`);
            else if (!coreSet.has(h)) warn(`${at}.banTargets「${h}」不在 core 里（语义上应是核心件）`);
          }
        }
      }

      // flex：{ core英雄: [可替代英雄...] }
      if (c.flex !== undefined) {
        if (!c.flex || typeof c.flex !== 'object' || Array.isArray(c.flex)) err(`${at}.flex 不是对象`);
        else {
          for (const [slot, alts] of Object.entries(c.flex)) {
            if (!heroNames.has(slot)) err(`${at}.flex 的 key 不是英雄: ${slot}`);
            else if (!coreSet.has(slot)) warn(`${at}.flex 的 key「${slot}」不在 core 里`);
            if (!Array.isArray(alts)) { err(`${at}.flex['${slot}'] 不是数组`); continue; }
            for (const h of alts) {
              if (!isStr(h)) err(`${at}.flex['${slot}'] 含非字符串: ${JSON.stringify(h)}`);
              else if (!heroNames.has(h)) err(`${at}.flex['${slot}'] 英雄不存在: ${h}`);
            }
          }
        }
      }

      // lanes：{ 中文分路: [英雄...] }
      if (c.lanes !== undefined) {
        if (!c.lanes || typeof c.lanes !== 'object' || Array.isArray(c.lanes)) err(`${at}.lanes 不是对象`);
        else {
          for (const [lane, list] of Object.entries(c.lanes)) {
            if (!LANE_LABELS.includes(lane)) err(`${at}.lanes 的分路非法: ${lane}（应为 对抗路/打野/中路/发育路/游走）`);
            if (!Array.isArray(list)) { err(`${at}.lanes['${lane}'] 不是数组`); continue; }
            for (const h of list) {
              if (!isStr(h)) err(`${at}.lanes['${lane}'] 含非字符串: ${JSON.stringify(h)}`);
              else if (!heroNames.has(h)) err(`${at}.lanes['${lane}'] 英雄不存在: ${h}`);
            }
          }
        }
      }

      // stats：{ idx: number|null, matches: number }
      const st = c.stats;
      if (!st || typeof st !== 'object' || Array.isArray(st)) err(`${at}.stats 不是对象`);
      else {
        if (!('idx' in st)) err(`${at}.stats 缺 idx`);
        else if (st.idx !== null && !isNum(st.idx)) err(`${at}.stats.idx 不是数字/null: ${st.idx}`);
        if (!('matches' in st)) err(`${at}.stats 缺 matches`);
        else if (!isNum(st.matches) || st.matches < 0) err(`${at}.stats.matches 非法: ${st.matches}`);
      }

      // sources：非空 URL 字符串数组
      if (!Array.isArray(c.sources) || c.sources.length === 0) {
        warn(`${at}.sources 为空（AI 调研结论应有出处）`);
      } else {
        for (const s of c.sources) if (!isStr(s)) err(`${at}.sources 含非字符串: ${JSON.stringify(s)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 6. combo-bans（用户实战必 ban）
const bansDoc = readJson(path.join(DATA, 'combo-bans.json'), 'combo-bans.json');
if (bansDoc) {
  if (bansDoc.version !== undefined && !isNum(bansDoc.version) && !isStr(bansDoc.version)) {
    err(`combo-bans.version 应为数字或非空字符串: ${JSON.stringify(bansDoc.version)}`);
  }
  if (bansDoc.date !== undefined && !isStr(bansDoc.date)) err('combo-bans.date 不是非空字符串');
  const ov = bansDoc.overrides;
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
    err('combo-bans.overrides 缺失或不是对象');
  } else {
    const ids = Object.keys(ov);
    stats.comboBans = ids.length;
    if (!ids.length) warn('combo-bans.overrides 为空（用户还没补充必 ban）');
    for (const id of ids) {
      const at = `combo-bans.overrides['${id}']`;
      if (!comboIds.has(id)) err(`${at} 的 combo id 不在 combos.json: ${id}`);
      const entry = ov[id];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        err(`${at} 不是对象`);
        continue;
      }
      if (entry.combo !== undefined && !isStr(entry.combo)) err(`${at}.combo 不是非空字符串`);
      const musts = entry.mustBans;
      if (!Array.isArray(musts) || musts.length === 0) {
        err(`${at}.mustBans 应为非空数组`);
        continue;
      }
      const seen = new Set();
      for (let i = 0; i < musts.length; i++) {
        const m = musts[i];
        const mat = `${at}.mustBans[${i}]`;
        if (!m || typeof m !== 'object') { err(`${mat} 不是对象`); continue; }
        if (!isStr(m.hero)) err(`${mat}.hero 缺失`);
        else {
          if (!heroNames.has(m.hero)) err(`${mat}.hero 不在英雄表: ${m.hero}`);
          if (seen.has(m.hero)) err(`${mat}.hero 重复: ${m.hero}`);
          seen.add(m.hero);
          const combo = (combosDoc && Array.isArray(combosDoc.comps))
            ? combosDoc.comps.find((c) => c && c.id === id) : null;
          if (combo && Array.isArray(combo.core) && combo.core.includes(m.hero)) {
            warn(`${mat}.hero「${m.hero}」是这套组合的 core（必 ban 会与核心冲突）`);
          }
        }
        if (!isStr(m.reason)) err(`${mat}.reason 缺失或为空`);
      }
    }
  }
}

// ---------------------------------------------------------------- 报告
console.log('=== hok-bp 数据校验 ===');
console.log(`heroes.js        : ${stats.heroes} 条`);
console.log(`meta.version     : ${stats.metaVersion}`);
console.log(`meta.tiers       : ${stats.tiers}`);
console.log(`meta.tags        : ${stats.tags}（共 ${stats.tagTotal} 个标签）`);
console.log(`meta.overrides   : ${stats.overrides ?? 0}`);
console.log(`relations.date   : ${stats.relDate}`);
console.log(`relations.counters : ${stats.counters}`);
console.log(`relations.synergies: ${stats.synergies}`);
if (stats.countersAvgW) console.log(`  counters 平均 w ${stats.countersAvgW} / synergies 平均 w ${stats.synergiesAvgW}`);
console.log(`store.players    : ${stats.storePlayers}（池内英雄合计 ${stats.storePoolTotal}）`);
console.log(`combos.comps     : ${stats.combos ?? 0} 套（AI 调研组合；source=${stats.combosSource ?? '—'}）`);
console.log(`combo-bans       : ${stats.comboBans ?? 0} 套组合带用户实战必 ban`);
if (warnings.length) {
  console.log(`\n--- 警告 ${warnings.length} 条 ---`);
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.log(`\n--- 错误 ${errors.length} 条（显示前 20）---`);
  for (const e of errors.slice(0, 20)) console.log('  ✗ ' + e);
  if (errors.length > 20) console.log(`  ... 其余 ${errors.length - 20} 条略`);
  process.exit(1);
}
console.log('\n全部校验通过 ✓');
