#!/usr/bin/env node
/**
 * tools/import-pools.mjs — 把一份「玩家 → 英雄池」清单导入 data/store.json
 *
 * 用法：
 *   node tools/import-pools.mjs                       # 默认 data/pools-2026-10-24.json
 *   node tools/import-pools.mjs path/to/pools.json    # 指定清单
 *   node tools/import-pools.mjs --dry-run            # 只打印不写盘
 *
 * 清单格式：{ "players": { "包": ["夏洛特", ...], "刘": [...], ... } }
 * 语义：按玩家名匹配（找不到按顺序兜底）；**整池替换**为清单内容；
 *       已在原池里的英雄保留原熟练度，新加入的默认 normal；清单外英雄移出（会报告）。
 * 写盘前备份到 .trash/store-before-import-<时间>.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const listArg = args.find((a) => !a.startsWith('--'));
const listPath = path.resolve(ROOT, listArg || 'data/pools-2026-10-24.json');
const storePath = path.join(ROOT, 'data', 'store.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const heroes = (() => {
  const raw = fs.readFileSync(path.join(ROOT, 'bp', 'data', 'heroes.js'), 'utf8');
  return JSON.parse(raw.replace(/^window\.HEROES\s*=\s*/, '').replace(/;\s*$/, ''));
})();
const heroNames = new Set(heroes.map((h) => h.name));

const list = readJson(listPath);
const map = list.players || list;
const store = readJson(storePath);
if (!Array.isArray(store.players) || store.players.length !== 5) {
  console.error('store.players 必须恰好 5 人');
  process.exit(1);
}

const unknown = [];
const report = [];
let changed = false;

store.players.forEach((p, i) => {
  const key = Object.keys(map).find((k) => k === p.name) || Object.keys(map)[i];
  const next = Array.isArray(map[key]) ? map[key] : [];
  if (!next.length) {
    report.push(`${p.name}：清单里没有对应玩家，跳过`);
    return;
  }
  const oldMastery = new Map((p.pool || []).map((e) => [e.hero, e.mastery || 'normal']));
  const keep = [];
  const added = [];
  const seen = new Set();
  next.forEach((hero) => {
    if (!heroNames.has(hero)) { unknown.push(hero); return; }
    if (seen.has(hero)) return;
    seen.add(hero);
    if (oldMastery.has(hero)) {
      keep.push({ hero, mastery: oldMastery.get(hero) });
    } else {
      keep.push({ hero, mastery: 'normal' });
      added.push(hero);
    }
  });
  const removed = (p.pool || []).map((e) => e.hero).filter((h) => !seen.has(h));
  p.pool = keep;
  changed = true;
  report.push(`${p.name}：${keep.length} 个（新增 ${added.length}${added.length ? '：' + added.join('/') : ''}${removed.length ? '；移出 ' + removed.length + '：' + removed.join('/') : ''}）`);
});

console.log(`清单：${path.relative(ROOT, listPath)}`);
report.forEach((r) => console.log('  ' + r));
if (unknown.length) console.log(`  ⚠ 未知英雄（已跳过）：${[...new Set(unknown)].join('、')}`);
console.log(`合计 ${store.players.reduce((s, p) => s + p.pool.length, 0)} 个池位`);

if (dryRun) { console.log('--dry-run：未写盘'); process.exit(unknown.length ? 1 : 0); }
if (!changed) { console.log('没有改动'); process.exit(0); }

fs.mkdirSync(path.join(ROOT, '.trash'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(ROOT, '.trash', `store-before-import-${stamp}.json`);
fs.copyFileSync(storePath, backup);
fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
console.log(`已写入 ${path.relative(ROOT, storePath)}（备份：${path.relative(ROOT, backup)}）`);
process.exit(unknown.length ? 1 : 0);
