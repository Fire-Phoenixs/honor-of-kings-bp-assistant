#!/usr/bin/env node
/**
 * integrate-data —— 三方数据整合（天元 + KPL + 组合知识）
 *
 * 口径（用户 2026-10-24 最终确认，v2.0）：
 *   【单卡与组合分离】
 *   1. 单卡价值 solo 只由单卡信号决定（天元 tier/score），**不掺组合**；
 *      —— 钟馗单拿就是 T2，不会因为「能凑小乔钟馗」而抬高。
 *   2. 组合能力只输出到 comboPotential，**仅作提示，不参与任何排序**；
 *      组合真正的大成（≈两个 T0）由引擎在「成型那一刻」结算（见 web/engine.js presetFitOf）。
 *   3. ban 决策用 ban 分：天元 ban 率 55% + KPL ban 率 45% + 单卡强度 20%（两套 ban 率都参考）。
 *
 * 输入：data/meta.json / data/kpl-bp-stats.json / data/combos.json
 * 输出：data/integration-v1.json
 * 用法：node tools/integrate-data.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/meta.json'), 'utf8'));
const kpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/kpl-bp-stats.json'), 'utf8'));
const combos = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/combos.json'), 'utf8'));

/* ============ 可调参数 ============ */
const CONFIG = {
  // ban 分：两套 ban 率并列（五排以排位环境为主，天元略重）
  banWeightTianYuan: 0.55,
  banWeightKpl: 0.45,
  banWeightTier: 0.2,
  // 组合「潜力」提示用：档位权重与替补折损（不参与排序）
  comboPriority: { S: 1.0, A: 0.7, B: 0.4 },
  comboFlexFactor: 0.5,
};
/* ================================== */

const n = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const kplHero = new Map((kpl.heroes || []).map((h) => [h.hero, h]));

// 组合归属（仅用于「潜力提示」）
const coreOf = new Map();
const flexOf = new Map();
for (const c of combos.comps) {
  for (const h of c.core) {
    if (!coreOf.has(h)) coreOf.set(h, []);
    coreOf.get(h).push({ id: c.id, name: c.name, priority: c.priority, size: c.core.length, role: 'core' });
  }
  for (const [slot, subs] of Object.entries(c.flex || {})) {
    for (const h of subs) {
      if (!flexOf.has(h)) flexOf.set(h, []);
      flexOf.get(h).push({ id: c.id, name: c.name, priority: c.priority, role: 'flex', slot });
    }
  }
}

const heroes = [];
for (const [hero, t] of Object.entries(meta.tiers)) {
  const k = kplHero.get(hero) || null;

  // ---- 单卡价值：只由单卡信号决定（天元强度分），不含组合 ----
  const solo = clamp01(n(t.score) / 100);

  // ---- ban 价值：两套 ban 率 + 单卡强度 ----
  const banTY = clamp01(n(t.banRate) / 100);
  const banKPL = clamp01(n(k && k.banRate) / 100);
  const banValue = clamp01(
    CONFIG.banWeightTianYuan * banTY +
    CONFIG.banWeightKpl * banKPL +
    CONFIG.banWeightTier * solo
  );

  // ---- 组合潜力（仅提示，不排序）----
  const members = [
    ...(coreOf.get(hero) || []),
    ...(flexOf.get(hero) || []).map((m) => ({
      ...m,
      weight: (CONFIG.comboPriority[m.priority] ?? 0.4) * CONFIG.comboFlexFactor,
    })),
  ];
  members.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const comboPotential = members.length
    ? clamp01(members.reduce((s, m) => s + (m.weight != null ? m.weight : CONFIG.comboPriority[m.priority] ?? 0.4), 0))
    : 0;

  // ---- 环境归属 ----
  const tb = n(t.banRate), kb = n(k && k.banRate);
  let regime = 'low';
  if (tb >= 25 && kb >= 25) regime = 'both';
  else if (tb < 25 && kb >= 40) regime = 'kpl-only';
  else if (tb >= 40 && kb < 15) regime = 'ranked-only';
  else if (tb >= 15 || kb >= 15) regime = 'mixed';

  heroes.push({
    hero,
    tier: t.tier,
    tianYuan: { score: n(t.score), banRate: n(t.banRate), pickRate: n(t.pickRate), winRate: n(t.winRate), role: t.role },
    kpl: k ? { banRate: n(k.banRate), pickRate: n(k.pickRate), winRate: k.winRate, sample: kpl.battles } : null,
    score: { solo: +solo.toFixed(3), ban: +banValue.toFixed(3) },
    // 提示：KPL 胜率相对天元胜率的偏离（正=职业里更能赢）
    kplDelta: k && k.winRate != null ? +(k.winRate - n(t.winRate)).toFixed(1) : null,
    comboPotential: { value: +comboPotential.toFixed(3), memberships: members, hint: '仅提示：组合大成由引擎在成型时结算，不进单卡排序' },
    regime,
  });
}

const out = {
  version: '2.0',
  date: new Date().toISOString().slice(0, 10),
  principle:
    '单卡与组合分离：score.solo 只由天元单卡强度决定（不掺组合）；comboPotential 仅供提示、不参与任何排序；' +
    '组合的成型加成由引擎（web/engine.js presetFitOf）在拿到核心件时结算。',
  sources: {
    tianYuan: 'data/meta.json（tiers: tier/score/banRate/pickRate/winRate）',
    kpl: 'data/kpl-bp-stats.json（159 局 2026 KPL 年总）',
    combos: 'data/combos.json（34 条组合，仅用于 comboPotential 提示）',
  },
  config: CONFIG,
  heroes: heroes.sort((a, b) => b.score.solo - a.score.solo),
};

const p = path.join(ROOT, 'data/integration-v1.json');
fs.writeFileSync(p, JSON.stringify(out, null, 1), 'utf8');

/* ---------- 报告 ---------- */
const w = (s, len) => String(s == null ? '' : s).padEnd(len);
const pad = (s, len) => String(s == null ? '' : s).padStart(len);

console.log('\n=== 三方整合报告 v2.0（单卡与组合分离）===');
console.log('单卡 solo = 天元强度分（不含组合）｜ban = 天元 55% + KPL 45% + 强度 20%｜comboPotential 仅提示\n');

console.log('【单卡强度 TOP 12】（= 天元 tier，钟馗/墨子不会再被抬上来）');
console.log(w('英雄', 10) + w('T度', 5) + pad('solo', 7) + pad('ban', 7) + '  组合潜力(仅提示)');
[...heroes].sort((a, b) => b.score.solo - a.score.solo).slice(0, 12).forEach((h) => {
  const cs = (h.comboPotential.memberships || []).map((m) => m.name + (m.role === 'core' ? '' : '(替)')).slice(0, 2).join('、');
  console.log(w(h.hero, 10) + w(h.tier, 5) + pad(h.score.solo.toFixed(3), 7) + pad(h.score.ban.toFixed(3), 7) + '  ' + cs);
});

console.log('\n【T2 英雄检查：钟馗/墨子应当仍在 T2 位次，不会被组合抬到 T0 之上】');
['钟馗', '墨子', '小乔', '盾山', '马超', '鲁班大师'].forEach((name) => {
  const h = heroes.find((x) => x.hero === name);
  if (h) console.log(`  ${w(name, 8)} ${w(h.tier, 5)} solo ${pad(h.score.solo.toFixed(3), 6)} ban ${pad(h.score.ban.toFixed(3), 6)} 组合潜力 ${pad(h.comboPotential.value.toFixed(2), 5)}`);
});

console.log('\n【ban 价值 TOP 12】（两套 ban 率并列参考）');
console.log(w('英雄', 9) + w('T度', 5) + pad('天元ban', 9) + pad('KPLban', 8) + pad('ban', 7) + '  环境');
[...heroes].sort((a, b) => b.score.ban - a.score.ban).slice(0, 12).forEach((h) => {
  const tag = { both: '双环境必ban', 'kpl-only': '职业体系件', 'ranked-only': '路人恶心件', mixed: '单一环境偏高', low: '' }[h.regime] || '';
  console.log(w(h.hero, 9) + w(h.tier, 5) + pad(h.tianYuan.banRate + '%', 9) + pad((h.kpl ? h.kpl.banRate : '-') + '%', 8) + pad(h.score.ban.toFixed(3), 7) + '  ' + tag);
});

console.log('\n已写入：' + p);
