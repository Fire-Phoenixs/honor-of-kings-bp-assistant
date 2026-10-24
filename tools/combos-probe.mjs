#!/usr/bin/env node
/**
 * combos-probe —— 组合识别探针（只读，不改引擎）
 *
 * 用法：
 *   node tools/combos-probe.mjs 钟馗                 # 我方已选 1 人
 *   node tools/combos-probe.mjs 钟馗 小乔            # 我方已选 2 人
 *   node tools/combos-probe.mjs 后羿 庄周 --enemy 吕布 沈梦溪
 *
 * 输出：
 *   1) 已成型 / 进行中的组合（按完成度与优先级排序）
 *   2) 建议补齐的下一件（按梯度排序，给出可替代件）
 *   3) 对面已选英雄对我方组合的拆解提示
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const combos = JSON.parse(fs.readFileSync(path.join(root, 'data/combos.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'data/meta.json'), 'utf8'));
let kpl = null;
try { kpl = JSON.parse(fs.readFileSync(path.join(root, 'data/kpl-bp-stats.json'), 'utf8')); } catch { /* 无赛事数据时跳过 */ }
const kplOf = (id) => (kpl && (kpl.comps || []).find((c) => c.id === id)) || null;

const TIER_ORDER = { T0: 0, 'T0.5': 1, T1: 2, T2: 3, T3: 4, T4: 5 };
const PRI = { S: 3, A: 2, B: 1 };

const argv = process.argv.slice(2);
const enemyIdx = argv.indexOf('--enemy');
const ours = (enemyIdx >= 0 ? argv.slice(0, enemyIdx) : argv).filter(Boolean);
const enemies = enemyIdx >= 0 ? argv.slice(enemyIdx + 1) : [];

if (!ours.length) {
  console.log('用法: node tools/combos-probe.mjs <我方已选英雄...> [--enemy <对面已选英雄...>]');
  process.exit(0);
}

const known = new Set(Object.keys(meta.tiers));
const bad = [...ours, ...enemies].filter((h) => !known.has(h));
if (bad.length) {
  console.log('⚠️ 不认识的英雄名（请用国服标准名）:', bad.join('、'));
  console.log('  提示：可从 data/meta.json 的 tiers 键里查。');
  process.exit(1);
}

const tierOf = (h) => (meta.tiers[h] || {}).tier || 'T4';
const rank = (h) => TIER_ORDER[tierOf(h)] ?? 9;

// 我方已选里「计入」某组合的英雄：核心件，或核心件的可替代件
function hitsOf(combo, picked) {
  const hits = [];
  for (const hero of picked) {
    if (combo.core.includes(hero)) hits.push({ hero, role: 'core' });
    else {
      for (const [slot, subs] of Object.entries(combo.flex || {})) {
        if (subs.includes(hero)) hits.push({ hero, role: 'flex', for: slot });
      }
    }
  }
  return hits;
}

const rows = [];
for (const combo of combos.comps) {
  const hits = hitsOf(combo, ours);
  if (!hits.length) continue;
  const coreHit = new Set(hits.filter((h) => h.role === 'core').map((h) => h.core || h.hero));
  // 完成度：核心件命中 / size（flex 替代按 1 件计）
  const covered = new Set();
  for (const h of hits) {
    if (h.role === 'core') covered.add(h.hero);
    else covered.add(h.for);
  }
  const done = covered.size;
  const missing = combo.core.filter((c) => !covered.has(c));
  rows.push({ combo, hits, done, missing });
}

rows.sort((a, b) => b.done / b.combo.size - a.done / a.combo.size || PRI[b.combo.priority] - PRI[a.combo.priority]);

if (!rows.length) {
  console.log('没有命中任何已知组合。可以试试这些强组合的起点：');
  console.log('  养猪流：庄周 / 明世隐 / 后羿     刀枪炮：墨子 / 百里守约');
  console.log('  小乔钟馗：钟馗 / 小乔           僵王博士：盾山 / 鲁班七号');
  process.exit(0);
}

console.log(`\n【我方已选】${ours.join('、')}`);
console.log('='.repeat(64));

for (const { combo, hits, done, missing } of rows) {
  const pct = Math.round((done / combo.size) * 100);
  const state = missing.length === 0 ? '✅ 已成型' : `进行中 ${done}/${combo.size}（${pct}%）`;
  console.log(`\n${combo.name}  [${combo.priority}档 · ${combo.type}]`);
  console.log(`  状态：${state}　证据：${combo.confidence}`);
  const k = kplOf(combo.id);
  if (k) {
    const flag = k.appearances < 5 ? '（样本不足，勿当依据）' : (k.winRate >= 60 ? '（KPL 偏强）' : k.winRate < 50 ? '（KPL 偏弱）' : '');
    console.log(`  KPL 实测（159 局年总）：${k.appearances} 局 / 满编 ${k.completed} / 胜率 ${k.winRate == null ? '-' : k.winRate + '%'}${flag}`);
  }
  console.log(`  命中：${hits.map((h) => (h.role === 'core' ? h.hero : `${h.hero}（替代${h.for}）`)).join('、')}`);
  if (missing.length) {
    console.log(`  还差：${missing.join('、')}　（梯度：${missing.map((m) => `${m} ${tierOf(m)}`).join('、')}）`);
  }
  // 可替代件提示
  for (const [slot, subs] of Object.entries(combo.flex || {})) {
    if (missing.includes(slot)) console.log(`  ${slot} 也可用：${subs.join(' / ')}（梯度 ${subs.map((s) => tierOf(s)).join('/')}）`);
  }
  console.log(`  拆解点：${(combo.counteredBy || []).join('、') || '—'}`);
  if (combo.banTargets && combo.banTargets.length) {
    const exposed = combo.banTargets.filter((h) => ours.includes(h));
    const tail = exposed.length ? `（${exposed.join('、')}已在我方，对面大概率 ban 或针对）` : '';
    console.log(`  对面会 ban：${combo.banTargets.join('、')}${tail}`);
  }
  if (enemies.length) {
    const threat = (combo.counteredBy || []).filter((h) => enemies.includes(h));
    if (threat.length) console.log(`  ⚠️ 对面已选 ${threat.join('、')}，会拆这套组合`);
  }
}

// 差一件就成型的组合：给出「最该补的那件」
const near = rows.filter((r) => r.missing.length === 1 && r.done >= 1);
if (near.length) {
  console.log('\n【差一件成型：优先补谁】');
  const scored = near
    .map((r) => ({ ...r, hero: r.missing[0] }))
    .map((r) => ({ ...r, weight: (PRI[r.combo.priority] || 1) * (r.combo.size <= 2 ? 1.5 : 1) }))
    .sort((a, b) => b.weight - a.weight || rank(a.hero) - rank(b.hero));
  for (const r of scored) {
    const sub = (r.combo.flex || {})[r.hero];
    console.log(
      `  ${r.hero}（${tierOf(r.hero)}）→ 补全「${r.combo.name}」${sub ? `　可替代：${sub.join(' / ')}` : ''}`
    );
  }
}

console.log('\n说明：本工具只做组合识别与补齐建议，不参与引擎打分；引擎接入方案见 docs/强势组合与克制关系-调研.md §6。\n');
