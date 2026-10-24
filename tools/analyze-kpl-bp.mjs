#!/usr/bin/env node
/**
 * analyze-kpl-bp —— 用真实 KPL BP 数据校准组合强度
 *
 * 输入：data/kpl-bp-2026-final.json（tools/collect-kpl-bp.mjs 产出）
 * 输出：data/kpl-bp-stats.json + 控制台报告
 *
 * 统计口径：
 *   1. 英雄层：ban 次数 / pick 次数 / 出场率 / 被禁率 / 胜率（按 pick 方阵营判定胜负）
 *   2. 组合层：同一方（camp）在同一局里同时出现的核心件数 ≥2 视为「组合命中」，
 *      统计该组合在 KPL 的出场局数与胜率；与 combos.json 的 priority 对照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SRC = path.resolve(ROOT, opt('--src', 'data/kpl-bp-2026-all.json'));
const COMBOS = path.join(ROOT, 'data/combos.json');
const META = path.join(ROOT, 'data/meta.json');
const OUT = path.join(ROOT, 'data/kpl-bp-stats.json');

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const combos = JSON.parse(fs.readFileSync(COMBOS, 'utf8'));
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const battles = data.battles || [];
const leagueLabel = data.league_name || (data.leagues || []).map((l) => l.league_name).filter(Boolean).join(' / ') || 'KPL';
const tierOf = (h) => (meta.tiers[h] || {}).tier || '?';

/* ---------- 1. 英雄层 ---------- */
const hero = new Map(); // name -> {ban,pick,win}
const bump = (m, k) => { if (!m.has(k)) m.set(k, { ban: 0, pick: 0, win: 0 }); return m.get(k); };

const perCamp = (b) => {
  // 返回 [{camp, bans:[], picks:[], win:bool}]
  const out = [1, 2].map((camp) => {
    const list = b.bp.filter((x) => x.camp === camp);
    return { camp, bans: list.filter((x) => x.ban).map((x) => x.hero), picks: list.filter((x) => !x.ban).map((x) => x.hero), win: b.win_camp === camp };
  });
  return out;
};

for (const b of battles) {
  for (const c of perCamp(b)) {
    for (const h of c.bans) bump(hero, h).ban++;
    for (const h of c.picks) { const o = bump(hero, h); o.pick++; if (c.win) o.win++; }
  }
}

const nBattles = battles.length;
const heroRows = [...hero.entries()].map(([h, o]) => ({
  hero: h, tier: tierOf(h), ban: o.ban, pick: o.pick, win: o.win,
  pickRate: +(o.pick / nBattles * 100).toFixed(1),
  banRate: +(o.ban / nBattles * 100).toFixed(1),
  winRate: o.pick ? +(o.win / o.pick * 100).toFixed(1) : null,
}));

/* ---------- 2. 组合层 ---------- */
// 严格口径：只认 core（核心件），命中 ≥2 件才算「这套组合真的在打」；
// 宽松口径：core + flex（可替代件）命中 ≥2，仅作参考（会把高出场英雄凑成假命中）。
const compRows = combos.comps.map((c) => {
  let strict = 0, strictWin = 0, full = 0, loose = 0, looseWin = 0;
  for (const b of battles) {
    for (const side of perCamp(b)) {
      const coreHit = side.picks.filter((h) => c.core.includes(h)).length;
      const covered = new Set();
      for (const heroName of side.picks) {
        if (c.core.includes(heroName)) covered.add(heroName);
        else for (const [slot, subs] of Object.entries(c.flex || {})) if (subs.includes(heroName)) covered.add(slot);
      }
      if (covered.size >= 2) { loose++; if (side.win) looseWin++; }
      if (coreHit >= 2) {
        strict++; if (side.win) strictWin++;
        if (coreHit === c.core.length) full++;
      }
    }
  }
  return {
    id: c.id, name: c.name, priority: c.priority, size: c.core.length,
    appearances: strict, completed: full,
    winRate: strict ? +(strictWin / strict * 100).toFixed(1) : null,
    loose: { appearances: loose, winRate: loose ? +(looseWin / loose * 100).toFixed(1) : null },
    confidence: c.confidence,
    note: strict < 5 ? '样本不足，勿下结论' : '',
  };
}).filter((r) => r.appearances > 0);

/* ---------- 3. 对照组：T0 在 KPL 的真实待遇 ---------- */
/* ---------- 3. 按梯度看真实表现（验证「梯度 ≠ 胜率」） ---------- */
const TIER_ORDER = { T0: 0, 'T0.5': 1, T1: 2, T2: 3, T3: 4, T4: 5 };
const byTier = new Map(); // tier -> {pick, win, heroes:Set}
for (const b of battles) {
  for (const c of perCamp(b)) {
    for (const h of c.picks) {
      const t = tierOf(h);
      if (!byTier.has(t)) byTier.set(t, { pick: 0, win: 0, heroes: new Set() });
      const o = byTier.get(t);
      o.pick++; if (c.win) o.win++; o.heroes.add(h);
    }
  }
}
const tierRows = [...byTier.entries()].map(([tier, o]) => ({
  tier, pick: o.pick, win: o.win, heroes: o.heroes.size,
  winRate: o.pick ? +(o.win / o.pick * 100).toFixed(1) : null,
  pickShare: nBattles ? +(o.pick / (nBattles * 2) * 100).toFixed(1) : null,
})).sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9));

/* ---------- 4. 被克制强度 vs 胜率（验证「高梯度也不能无脑 pick」） ---------- */
const rel = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/relations.json'), 'utf8'));
const cMap = new Map();
for (const c of rel.counters || []) cMap.set(`${c.a}||${c.b}`, c.w || 0);
const counterAt = (attacker, victim) => cMap.get(`${attacker}||${victim}`) || 0;

const BUCKETS = [
  { key: 'none', label: '几乎不被克', min: 0, max: 0.001 },
  { key: 'low', label: '轻度被克', min: 0.001, max: 0.3 },
  { key: 'mid', label: '中度被克', min: 0.3, max: 0.8 },
  { key: 'high', label: '重度被克', min: 0.8, max: 99 },
];
const pressureStats = BUCKETS.map((b) => ({ ...b, n: 0, win: 0, t0n: 0, t0win: 0 }));

for (const b of battles) {
  const sides = perCamp(b);
  for (const side of sides) {
    const other = sides.find((s) => s.camp !== side.camp);
    if (!other) continue;
    let pressure = 0;
    for (const mine of side.picks) {
      for (const theirs of other.picks) pressure += counterAt(theirs, mine);
    }
    const bucket = pressureStats.find((x) => pressure >= x.min && pressure < x.max);
    if (!bucket) continue;
    bucket.n++; if (side.win) bucket.win++;
    // 只统计「我方有 T0」的子集：高梯度英雄被针对时胜率掉多少
    const hasT0 = side.picks.some((h) => tierOf(h) === 'T0');
    if (hasT0) { bucket.t0n++; if (side.win) bucket.t0win++; }
  }
}

const tierTop = heroRows.filter((r) => r.tier === 'T0').sort((a, b) => b.ban - a.ban);

/* ---------- 输出 ---------- */
const stats = {
  source: 'data/kpl-bp-2026-final.json',
  league: data.league_name,
  battles: nBattles,
  fetched_at: data.fetched_at,
  // 口径（用户 2026-10-24 二次修正）：KPL 与天元并列参与整合，不再是「仅参考」。
  positioning: 'integrated-reference',
  priority_note:
    '与天元并列参与三方整合（见 data/integration-v1.json，由 tools/integrate-data.mjs 生成）：' +
    '天元 ban 率与 KPL ban 率都作参考，融合权重 55/45；组合知识（combos.json）权重最高。' +
    'KPL 与排位环境不同（教练 BP、针对性 ban、执行度），故按用途分工而非互相覆盖。',
  heroes: heroRows.sort((a, b) => (b.ban + b.pick) - (a.ban + a.pick)),
  tiers: tierRows,
  comps: compRows.sort((a, b) => b.appearances - a.appearances),
};
fs.writeFileSync(OUT, JSON.stringify(stats, null, 1), 'utf8');

/* ---------- 控制台报告 ---------- */
const w = (s, n) => String(s).padEnd(n);
const pad = (s, n) => String(s).padStart(n);
console.log(`\n=== KPL BP 样本：${leagueLabel} · ${nBattles} 局 ===`);
console.log('i 三方整合：KPL 与天元 ban 率并列参与 ban 分（55/45）；pick 端用于验证「梯度 ≠ 胜率」。\n');

console.log('【按梯度看真实表现（pick 端的关键证据）】');
console.log(w('梯度', 6) + pad('pick数', 8) + pad('出场占比', 10) + pad('胜率', 8) + '英雄数');
tierRows.forEach((r) => {
  console.log(w(r.tier, 6) + pad(r.pick, 8) + pad((r.pickShare == null ? '-' : r.pickShare + '%'), 10) + pad((r.winRate == null ? '-' : r.winRate + '%'), 8) + r.heroes);
});
console.log('');

console.log('【被克制强度 vs 实际胜率】（pressure = Σ 对面每个 pick 对我方每个 pick 的克制权重）');
console.log(w('被克程度', 12) + pad('对局侧数', 10) + pad('胜率', 8) + pad('含T0侧数', 10) + pad('含T0胜率', 10));
pressureStats.forEach((b) => {
  console.log(
    w(b.label, 12) + pad(b.n, 10) +
    pad((b.n ? (b.win / b.n * 100).toFixed(1) : '-') + '%', 8) +
    pad(b.t0n, 10) +
    pad((b.t0n ? (b.t0win / b.t0n * 100).toFixed(1) : '-') + '%', 10)
  );
});
console.log('');

console.log('【被 ban 最多的 12 个英雄】');
console.log(w('英雄', 10) + w('梯度', 6) + w('ban', 6) + w('被禁率', 9) + w('pick', 6) + '胜率');
heroRows.sort((a, b) => b.ban - a.ban).slice(0, 12).forEach((r) => {
  console.log(w(r.hero, 10) + w(r.tier, 6) + w(r.ban, 6) + w(r.banRate + '%', 9) + w(r.pick, 6) + (r.winRate == null ? '-' : r.winRate + '%'));
});

console.log('\n【出场（pick）最多的 12 个英雄】');
console.log(w('英雄', 10) + w('梯度', 6) + w('pick', 6) + w('出场率', 9) + w('ban', 6) + '胜率');
heroRows.sort((a, b) => b.pick - a.pick).slice(0, 12).forEach((r) => {
  console.log(w(r.hero, 10) + w(r.tier, 6) + w(r.pick, 6) + w(r.pickRate + '%', 9) + w(r.ban, 6) + (r.winRate == null ? '-' : r.winRate + '%'));
});

console.log('\n【组合在 KPL 的出现次数与胜率（严格：核心件命中 ≥2）】');
console.log(w('组合', 30) + w('档', 4) + w('局数', 6) + w('满编', 6) + w('胜率', 8) + '备注');
compRows.sort((a, b) => b.appearances - a.appearances).slice(0, 24).forEach((r) => {
  console.log(w(r.name, 30) + w(r.priority, 4) + w(r.appearances, 6) + w(r.completed, 6) + w(r.winRate == null ? '-' : r.winRate + '%', 8) + (r.note || ('宽松口径 ' + r.loose.appearances + ' 局')));
});

console.log('\n【T0 英雄在 KPL 的实际待遇】');
tierTop.slice(0, 10).forEach((r) => console.log(`  ${w(r.hero, 8)} 被禁 ${w(r.banRate + '%', 8)} 出场 ${w(r.pickRate + '%', 8)} 胜率 ${r.winRate == null ? '-' : r.winRate + '%'}`));

console.log('\n已写入：' + OUT);
