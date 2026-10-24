// 把「BP 版」的 5×5 英雄池表导入 data/store.json
// 用法: node hok-bp/tools/import-roster.mjs [--dry]
// 说明：表格列 = 分路，行 = 玩家；每格是该玩家在该分路会玩的英雄。
//      本工具为每个玩家指定一个主分路（MAIN_LANE），池子 = 主分路列的英雄 ∪ 其它列里在主分路合法的英雄。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const HEROES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'bp', 'data', 'heroes.js'), 'utf8')
    .replace(/^window\.HEROES\s*=\s*/, '').replace(/;\s*$/, '')
);
const BY_NAME = new Map(HEROES.map((h) => [h.name, h]));

// 表格里出现的简称 / 错别字 → 官方名
const ALIAS = {
  凯: '铠',
  元坦: '元流之子(坦克)',
  元射: '元流之子(射手)',
  元法: '元流之子(法师)',
  元刺: '元流之子(刺客)',
  元辅: '元流之子(辅助)',
  干将: '干将莫邪',
  鸟人: '云中君',
  大小姐: '孙尚香',
};

// 行 = 玩家；cells = 该玩家在这五列的英雄（按图）
const ROSTER = [
  {
    name: '包', floor: 1, mainLane: 'top',
    cells: {
      top: ['夏洛特', '曹操', '亚连', '司空震', '马超', '蚩奼', '貂蝉'],
      jungle: ['阿古朵', '哪吒', '马超', '云缨', '杨戬'],
      mid: ['武则天', '杨玉环'],
      adc: ['敖隐', '公孙离', '蚩奼', '王维', '艾琳'],
      support: [],
    },
  },
  {
    name: '刘', floor: 2, mainLane: 'adc',
    cells: {
      top: ['赵云', '蚩奼', '元坦'],
      jungle: [],
      mid: ['女娲', '安琪拉'],
      adc: ['戈娅', '元射', '敖隐', '狄仁杰', '百里守约', '鲁班七号', '艾琳', '虞姬', '卢雅那', '孙尚香'],
      support: [],
    },
  },
  {
    name: '杜', floor: 3, mainLane: 'mid',
    cells: {
      top: ['花木兰'],
      jungle: ['娜可露露', '韩信'],
      mid: ['周瑜', '干将', '高渐离', '扁鹊', '不知火舞'],
      adc: [],
      support: ['鬼谷子', '钟馗'],
    },
  },
  {
    name: '李', floor: 4, mainLane: 'jungle',
    cells: {
      top: ['狂铁', '凯', '廉颇', '李信'],
      jungle: ['凯', '赵云', '钟无艳', '夏侯惇'],
      mid: [],
      adc: [],
      support: ['刘邦'],
    },
  },
  {
    name: '张', floor: 5, mainLane: 'support',
    cells: {
      top: ['白起', '廉颇'],
      jungle: [],
      mid: [],
      adc: ['后羿'],
      support: ['盾山', '廉颇', '赵怀真', '少司缘', '鲁班大师', '朵莉亚', '张飞', '庄周', '张良', '金蝉'],
    },
  },
];

const LANES = ['top', 'jungle', 'mid', 'adc', 'support'];
const unknown = [];

function norm(raw) {
  const name = ALIAS[raw] || raw;
  if (!BY_NAME.has(name)) {
    unknown.push(raw);
    return null;
  }
  return name;
}

function canPlay(hero, lane) {
  return (hero.roles || []).includes(lane) || (hero.alt || []).includes(lane);
}

const players = [];
const report = [];
for (const row of ROSTER) {
  const main = row.mainLane;
  const pool = new Set();
  const fromMain = [];
  for (const raw of row.cells[main] || []) {
    const n = norm(raw);
    if (n) { pool.add(n); fromMain.push(n); }
  }
  const crossAdded = [];
  for (const lane of LANES) {
    if (lane === main) continue;
    for (const raw of row.cells[lane] || []) {
      const n = norm(raw);
      if (!n || pool.has(n)) continue;
      const hero = BY_NAME.get(n);
      if (canPlay(hero, main)) { pool.add(n); crossAdded.push(`${n}(${lane})`); }
    }
  }
  players.push({ lane: main, name: row.name, floor: row.floor, pool: [...pool] });
  report.push({ name: row.name, lane: main, total: pool.size, fromMain: fromMain.length, crossAdded });
}

if (unknown.length) {
  console.error('未知英雄名（请修正）：', [...new Set(unknown)].join(', '));
  process.exit(1);
}

const store = {
  side: 'blue',
  players,
  allowCrossLane: true,
  weights: {},
  history: [],
};

console.log('=== 导入结果 ===');
for (const r of report) {
  console.log(`${r.name} / ${r.lane}: 池 ${r.total} 个（主列 ${r.fromMain}${r.crossAdded.length ? ' + 跨列合法 ' + r.crossAdded.join('、') : ''}）`);
}

if (process.argv.includes('--dry')) {
  console.log('\n[dry] 未写入 store.json');
} else {
  const file = path.join(ROOT, 'data', 'store.json');
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
  console.log(`\n已写入 ${file}`);
}

// 引擎试算（用真实 meta/relations）
const E = require(path.join(ROOT, 'web', 'engine.js'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
const relations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'relations.json'), 'utf8'));
const ctx = { heroes: HEROES, meta, relations, store, bans: { ours: [], theirs: [] }, picks: { blue: [], red: [] } };
const ban = E.banRecommend(ctx);
console.log('\n=== Ban 试算（5 条指令）===');
ban.commands.forEach((c) => console.log(`${c.playerName}/${c.laneLabel} → ${c.hero}(${c.tier}) ${c.score}\n   ${c.reason}\n   备选: ${c.alternatives.map((a) => a.hero + '(' + a.score + ')').join(' / ')}`));
const lu = E.lineupCheck(ctx);
console.log('\n池存活率（ban 前）:', lu.survival.map((s) => `${s.laneLabel} ${s.total}`).join(' | '));
const ap = E.analyzePool(ctx);
console.log('\n池分析 notes:', ap.notes.length ? ap.notes.join(' ／ ') : '无');
