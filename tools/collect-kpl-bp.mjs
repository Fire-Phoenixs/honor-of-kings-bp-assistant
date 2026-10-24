#!/usr/bin/env node
/**
 * collect-kpl-bp —— 采集 KPL 官方赛事 BP 数据（有限、定向、限速）
 *
 * 数据来源：腾讯官方赛事数据接口（pvp.qq.com 赛事数据中心页面自身调用的同一接口）
 *   https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id=...
 *   https://prod.comp.smoba.qq.com/leaguesite/battle/open?battle_id=...
 * 合规口径：
 *   - 只采指定赛事（--league 逗号分隔），不做全站遍历；
 *   - 严格串行，每局间隔默认 800ms，不并发、不重试风暴；
 *   - 只取公开赛事数据（选/ban 英雄、胜负、时长），不取任何账号相关字段。
 *
 * 用法：
 *   node tools/collect-kpl-bp.mjs --limit 6                       # 先抓 6 局验证
 *   node tools/collect-kpl-bp.mjs --league 20260004               # 单个赛事
 *   node tools/collect-kpl-bp.mjs --league 20260001,20260003 --gap 500 --out data/kpl-bp-2026-all.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://prod.comp.smoba.qq.com/leaguesite';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LEAGUES = opt('--league', '20260004').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(opt('--limit', '0')) || 0;
const OUT = opt('--out', 'data/kpl-bp-2026-final.json');
const GAP = Number(opt('--gap', '800'));

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://pvp.qq.com/' }, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(text);
  if (j.code !== 200) throw new Error(`code=${j.code}`);
  return j;
}

async function main() {
  const leagueMeta = [];
  const jobs = [];

  console.log(`[1/3] 拉取赛事场次：${LEAGUES.join(', ')}`);
  for (const lg of LEAGUES) {
    try {
      const league = await getJson(`${BASE}/matches/open?league_id=${lg}`);
      const all = league.results || [];
      const done = all.filter((m) => String(m.status) === '2');
      const name = (done[0] && (done[0].league_name || done[0].match_stage_desc)) || lg;
      leagueMeta.push({ league_id: lg, league_name: name, matches_total: all.length, matches_finished: done.length });
      for (const m of done) {
        for (const b of m.match_battle_video_list || []) jobs.push({ lg, m, b });
      }
      console.log(`      ${lg} 总 ${all.length} 场 / 已结束 ${done.length} 场`);
    } catch (e) {
      console.log(`      ${lg} 拉取失败：${e.message}（跳过）`);
      leagueMeta.push({ league_id: lg, error: e.message });
    }
    await sleep(600);
  }

  console.log(`[2/3] 待采集对局 ${jobs.length} 局${LIMIT ? `（本次限 ${LIMIT} 局）` : ''}，间隔 ${GAP}ms`);
  const todo = LIMIT ? jobs.slice(0, LIMIT) : jobs;

  const battles = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const { lg, m, b } = todo[i];
    process.stdout.write(`      ${i + 1}/${todo.length} ${m.match_id} 第${b.battle_seq}局 ... `);
    try {
      const j = await getJson(`${BASE}/battle/open?battle_id=${encodeURIComponent(b.battle_id)}`);
      const d = j.data || {};
      const bp = (d.bp_list || []).map((x) => ({
        camp: x.camp, ban: Number(x.is_ban_or_pick) === 0, hero: x.hero_name, heroId: x.hero_id,
      }));
      battles.push({
        league_id: lg,
        match_id: m.match_id,
        stage: m.match_stage_desc || m.match_stage_name || '',
        date: (m.start_time || '').slice(0, 10),
        bo: m.bo,
        team1: { name: m.camp1 && m.camp1.team_name, score: m.camp1 && m.camp1.score },
        team2: { name: m.camp2 && m.camp2.team_name, score: m.camp2 && m.camp2.score },
        battle_id: b.battle_id,
        battle_seq: b.battle_seq,
        win_camp: d.win_camp,
        duration_sec: d.game_duration ? Math.round(d.game_duration / 1000) : null,
        bp,
      });
      ok++;
      console.log(`ok（${bp.length} 条）`);
    } catch (e) {
      fail++;
      console.log('失败：' + e.message);
    }
    if (i < todo.length - 1) await sleep(GAP);
  }

  console.log(`[3/3] 写入 ${OUT}（成功 ${ok} / 失败 ${fail}）`);
  const out = {
    source: `${BASE}`,
    note: '腾讯官方赛事数据（2026 KPL）。ban/pick 来自 bp_list，is_ban_or_pick: 0=禁用 1=选择；camp 1/2 = 蓝/红方。',
    fetched_at: new Date().toISOString(),
    leagues: leagueMeta,
    battles,
  };
  const p = path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 1), 'utf8');
  console.log('完成：' + p + `（${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB）`);
}

main().catch((e) => { console.error('采集失败：' + e.message); process.exitCode = 1; });
