/* ============================================================
 * app.js — 王者荣耀 BP 平台 v2 · 单页 UI（原生 JS，非 module）
 *
 * v2 相对 v1 的变化（对应 2026-10-24 用户反馈）：
 *   1. 取消「每人绑定分路」：玩家 = 姓名 / 楼层 / 倾向分路(1-2) / 完整英雄池；
 *      BP 计算时只要求阵容能覆盖五条分路，Pick 候选写明「谁（楼层+名字）拿什么」。
 *   2. 英雄池三档熟练度：绝活 best / 正常 normal / 仅会玩 basic。
 *   3. 补池建议单源（引擎 analyzePool）+ UI 二次去重，不会重复出现同一英雄。
 *   4. BP 页先 Ban 后 Pick：进入只渲染 Ban；Ban 完顶部缩略展示，再展开 Pick；支持对面空 ban。
 *   5. 英雄名旁带本地头像 + 分类标签，全程可用鼠标完成。
 *
 * 依赖（顺序加载，缺失时降级）：
 *   window.HEROES    /data/heroes.js
 *   window.HERO_ICON /heroicons.js
 *   window.HOKEngine /engine.js   （契约 docs/engine-contract-v2.md）
 *   window.HOKAI     /ai.js
 * ============================================================ */
(function () {
  'use strict';

  /* ================= 常量 ================= */

  var LANES = { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' };
  var LANE_KEYS = ['top', 'jungle', 'mid', 'adc', 'support'];
  var TYPES = ['坦克', '战士', '刺客', '法师', '射手', '辅助'];
  var PICK_SEQUENCE = ['B', 'R', 'R', 'B', 'B', 'R', 'R', 'B', 'B', 'R'];
  var TIERS = ['T0', 'T0.5', 'T1', 'T2', 'T3', 'T4'];
  var MASTERY = {
    best: { key: 'best', label: '绝活', short: '绝', cls: 'mb-best', desc: '被 counter 也能反打（可盲抢）' },
    normal: { key: 'normal', label: '正常', short: '常', cls: 'mb-normal', desc: '正常发挥' },
    basic: { key: 'basic', label: '仅会玩', short: '会', cls: 'mb-basic', desc: '只有 counter 对面时才能打出正常表现' }
  };
  var MASTERY_ORDER = ['best', 'normal', 'basic'];
  var TABS = [
    { id: 'bp', label: 'BP' },
    { id: 'settings', label: '英雄池' },
    { id: 'tiers', label: '梯度' },
    { id: 'data', label: '数据' },
    { id: 'export', label: '导出' }
  ];
  var SS_KEY = 'hokbp.v2.bp';
  var NOT_READY = '数据未就绪，稍后刷新';

  /* ================= 状态 ================= */

  var state = {
    tab: 'bp',
    loading: true,
    health: null, healthErr: null,
    meta: null, metaErr: null,
    relations: null, relationsErr: null,
    store: null, storeErr: null,
    storeDirty: false, saveState: '', saveTimer: null,

    phase: 'ban',                                 // ban | pick
    bans: { ours: ['', '', '', '', ''], theirs: ['', '', '', '', ''] },
    picks: { blue: [], red: [] },
    recs: [],
    assignments: {},                               // v2.3：手动指定 英雄→playerIndex

    banResult: null, banErr: null,
    pickResult: null, pickErr: null,
    lineup: null, lineupErr: null,

    advice: null, adviceErr: null, adviceBusy: false,

    /* v2.4 赛前预选 + 赛后总体评价（契约 docs/feature-preset-review.md §4） */
    presets: [], presetsErr: null,                 // GET /api/presets（服务端由 combos.json + combo-bans.json 适配）
    combos: [], combosErr: null,                   // GET /api/combos（v2.5 通用组合加成用）
    preset: null,                                  // {id} | {id:'custom',core:[...]} | null
    presetPlan: null, presetErr: null,             // HOKEngine.presetPlan(ctx)
    review: null, reviewErr: null,                 // HOKEngine.teamReview(ctx)
    presetPlanOpen: false,                         // Pick 阶段「查看方案」展开态
    presetSize: 'all',                             // 模板筛选：人数 all|2|3|4|5
    presetPriority: 'all',                         // 模板筛选：优先级 all|S|A|B

    tierFilter: 'all',
    tierQuery: '',
    importText: '', importHint: '',

    picker: null,
    poolEditor: null,
    enemyQuery: '',
    enemyLane: 'all',
    enemyType: 'all',

    exportText: ''
  };

  /* ================= 工具 ================= */

  function $(sel) { return document.querySelector(sel); }
  function $id(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  function fx(v, digits) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toFixed(digits === undefined ? 1 : digits);
  }

  function msgOf(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return String(e.message);
    if (e.error) return String(e.error);
    return '未知错误';
  }

  var toastTimer = null;
  function toast(text, kind) {
    var el = $id('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ================= HTTP（失败降级） ================= */

  function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var timer = null;
    if (typeof AbortController === 'function') {
      var ctl = new AbortController();
      opt.signal = ctl.signal;
      timer = setTimeout(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, 15000);
    }
    return fetch(path, opt).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var m = (data && (data.error || data.message)) || ('HTTP ' + res.status);
          var err = new Error(m);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        if (data === null) {
          var err2 = new Error('响应不是合法 JSON');
          err2.status = res.status;
          throw err2;
        }
        return data;
      });
    }).then(function (d) {
      if (timer) clearTimeout(timer);
      return d;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* ================= 英雄数据 / 头像 / 标签 ================= */

  function heroes() { return Array.isArray(window.HEROES) ? window.HEROES : []; }

  var _hmap = null, _hmapLen = -1;
  function heroByName(name) {
    var hs = heroes();
    if (!_hmap || _hmapLen !== hs.length) {
      _hmap = {};
      for (var i = 0; i < hs.length; i++) { if (hs[i] && hs[i].name) _hmap[hs[i].name] = hs[i]; }
      _hmapLen = hs.length;
    }
    return _hmap[name] || null;
  }

  function laneLabel(lane) { return LANES[lane] || lane || '—'; }

  function heroLanes(h) {
    if (!h) return [];
    var out = [];
    (h.roles || []).forEach(function (l) { if (out.indexOf(l) < 0) out.push(l); });
    (h.alt || []).forEach(function (l) { if (out.indexOf(l) < 0) out.push(l); });
    return out;
  }

  function heroLaneText(h) {
    var ls = heroLanes(h);
    return ls.length ? ls.map(laneLabel).join('/') : '—';
  }

  function heroTypes(h) { return (h && h.type) || []; }

  function tierOf(name) {
    var t = state.meta && state.meta.tiers && state.meta.tiers[name];
    if (!t) return 'T2';
    return typeof t === 'string' ? t : (t.tier || 'T2');
  }

  function tierScore(name) {
    var t = state.meta && state.meta.tiers && state.meta.tiers[name];
    return (t && typeof t === 'object') ? num(t.score, 0) : 0;
  }

  function tierClass(tier) {
    return 'tier t-' + String(tier || 'T2').replace('.', '_');
  }

  function iconUrl(name) {
    var m = window.HERO_ICON;
    if (m && typeof m === 'object' && m[name]) return m[name];
    var h = heroByName(name);
    return (h && h.id) ? ('/icons/' + h.id + '.png') : '';
  }

  /* 头像：img 失败自动消失，露出底下的首字兜底（纯 CSS 显示，不需要 JS 兜底状态） */
  function avatar(name, size) {
    var init = String(name || '?').slice(0, 1);
    var cls = 'av' + (size ? ' av-' + size : '');
    var url = iconUrl(name);
    if (!url) return '<span class="' + cls + '" title="' + esc(name) + '"><i>' + esc(init) + '</i></span>';
    return '<span class="' + cls + '" title="' + esc(name) + '"><i>' + esc(init) +
      '</i><img src="' + esc(url) + '" alt="" loading="lazy" onerror="this.remove()"></span>';
  }

  function tagsHtml(name, opts) {
    opts = opts || {};
    var h = heroByName(name);
    var out = [];
    if (opts.types) heroTypes(h).forEach(function (t) { out.push('<span class="tag tag-type">' + esc(t) + '</span>'); });
    if (opts.lanes) {
      heroLanes(h).forEach(function (l) { out.push('<span class="tag tag-lane">' + esc(laneLabel(l)) + '</span>'); });
    }
    if (opts.tier) out.push('<span class="' + tierClass(tierOf(name)) + '">' + esc(tierOf(name)) + '</span>');
    if (opts.mastery) out.push(masteryBadge(opts.mastery));
    return out.join('');
  }

  function masteryBadge(m) {
    var info = MASTERY[normalizeMastery(m)];
    return '<span class="mb ' + info.cls + '" title="' + esc(info.label + '：' + info.desc) + '">' + esc(info.label) + '</span>';
  }

  function normalizeMastery(m) { return MASTERY[m] ? m : 'normal'; }

  function heroesForFilter(lane, type) {
    var list = heroes();
    if (lane && lane !== 'all') list = list.filter(function (h) { return heroLanes(h).indexOf(lane) >= 0; });
    if (type && type !== 'all') list = list.filter(function (h) { return heroTypes(h).indexOf(type) >= 0; });
    return list;
  }

  function matchesQuery(h, q) {
    if (!q) return true;
    if (h.name.indexOf(q) >= 0) return true;
    if (heroTypes(h).join('').indexOf(q) >= 0) return true;
    var ls = heroLanes(h).map(laneLabel).join('');
    return ls.indexOf(q) >= 0;
  }

  /* ================= store v2（含 v1 迁移） ================= */

  function defaultStore() {
    return {
      version: 2,
      side: 'blue',
      players: LANE_KEYS.map(function (lane, i) {
        return { id: 'p' + (i + 1), name: '玩家' + (i + 1), floor: i + 1, preferLanes: [lane], pool: [] };
      }),
      allowCrossLane: true,
      weights: {},
      history: []
    };
  }

  function normalizeStore(raw) {
    var base = defaultStore();
    if (!raw || typeof raw !== 'object') return base;
    var inPlayers = (Array.isArray(raw.players) ? raw.players : []).filter(function (p) { return p && typeof p === 'object'; });
    var floors = inPlayers.map(function (p, i) {
      var f = Number(p.floor);
      return (f >= 1 && f <= 5 && Math.floor(f) === f) ? f : i + 1;
    });
    var seen = {};
    var players = base.players.map(function (slot, i) {
      var p = inPlayers[i] || {};
      var floor = floors[i];
      while (seen[floor]) floor = floor >= 5 ? 1 : floor + 1;
      seen[floor] = true;

      var prefer = Array.isArray(p.preferLanes) ? p.preferLanes.slice() : (p.lane ? [p.lane] : []);
      prefer = prefer.filter(function (l, k) { return LANE_KEYS.indexOf(l) >= 0 && prefer.indexOf(l) === k; }).slice(0, 2);
      if (!prefer.length && p.lane && LANE_KEYS.indexOf(p.lane) >= 0) prefer = [p.lane];

      var pool = [];
      var seenHero = {};
      (Array.isArray(p.pool) ? p.pool : []).forEach(function (item) {
        var hero = '', mastery = 'normal';
        if (typeof item === 'string') hero = item;
        else if (item && typeof item === 'object') { hero = item.hero || item.name || ''; mastery = normalizeMastery(item.mastery); }
        hero = String(hero || '').trim();
        if (!hero || seenHero[hero]) return;
        seenHero[hero] = true;
        pool.push({ hero: hero, mastery: mastery });
      });

      return {
        id: typeof p.id === 'string' && p.id ? p.id : slot.id,
        name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim().slice(0, 12) : slot.name,
        floor: floor,
        preferLanes: prefer,
        pool: pool
      };
    });

    return {
      version: 2,
      side: raw.side === 'red' ? 'red' : 'blue',
      players: players,
      allowCrossLane: true,
      weights: (raw.weights && typeof raw.weights === 'object' && !Array.isArray(raw.weights)) ? raw.weights : {},
      history: Array.isArray(raw.history) ? raw.history : []
    };
  }

  function storeSide() { return (state.store && state.store.side === 'red') ? 'red' : 'blue'; }
  function players() { return (state.store && state.store.players) || []; }

  function playerAtFloor(floor) {
    var ps = players();
    for (var i = 0; i < ps.length; i++) { if (num(ps[i].floor) === num(floor)) return ps[i]; }
    return null;
  }

  function playerIndexOf(p) { return players().indexOf(p); }

  function poolEntries(p) { return (p && Array.isArray(p.pool)) ? p.pool : []; }
  function poolHeroes(p) { return poolEntries(p).map(function (e) { return e.hero; }); }

  function masteryOf(p, hero) {
    var arr = poolEntries(p);
    for (var i = 0; i < arr.length; i++) if (arr[i].hero === hero) return normalizeMastery(arr[i].mastery);
    return '';
  }

  function poolSummary(p) {
    var s = { total: 0, best: 0, normal: 0, basic: 0 };
    poolEntries(p).forEach(function (e) {
      s.total++;
      s[normalizeMastery(e.mastery)]++;
    });
    return s;
  }

  function setMastery(p, hero, m) {
    var arr = poolEntries(p);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].hero === hero) { arr[i].mastery = normalizeMastery(m); return true; }
    }
    return false;
  }

  function addToPool(p, hero, mastery) {
    if (!p || !hero) return false;
    if (poolHeroes(p).indexOf(hero) >= 0) return false;
    p.pool.push({ hero: hero, mastery: normalizeMastery(mastery) });
    return true;
  }

  function removeFromPool(p, hero) {
    if (!p) return false;
    var i = poolHeroes(p).indexOf(hero);
    if (i < 0) return false;
    p.pool.splice(i, 1);
    return true;
  }

  function allPoolHeroSet() {
    var s = {};
    players().forEach(function (p) { poolHeroes(p).forEach(function (n) { s[n] = true; }); });
    return s;
  }

  function allBanned() {
    var out = [];
    ['ours', 'theirs'].forEach(function (k) {
      ((state.bans && state.bans[k]) || []).forEach(function (n) { if (n) out.push(n); });
    });
    return out;
  }

  function allPicked() { return (state.picks.blue || []).concat(state.picks.red || []); }

  function isTaken(name) {
    return allBanned().indexOf(name) >= 0 || allPicked().indexOf(name) >= 0;
  }

  /* ================= 引擎 ================= */

  function buildCtx() {
    return {
      heroes: heroes(),
      meta: state.meta || { tiers: {}, tags: {}, weights: {} },
      relations: state.relations || { counters: [], synergies: [] },
      store: state.store || defaultStore(),
      bans: {
        ours: (state.bans.ours || []).filter(Boolean),
        theirs: (state.bans.theirs || []).filter(Boolean)
      },
      picks: {
        blue: (state.picks.blue || []).slice(),
        red: (state.picks.red || []).slice()
      },
      assignments: state.assignments || {},
      presets: Array.isArray(state.presets) ? state.presets : [],
      preset: state.preset || null,
      combos: Array.isArray(state.combos) ? state.combos : []
    };
  }

  /* 引擎函数是否已实现（Lead 侧 v2.4 并行开发，未就绪时降级隐藏新面板） */
  function engineHas(fnName) {
    var e = window.HOKEngine;
    return !!(e && typeof e[fnName] === 'function');
  }

  function callEngine(fnName, ctx) {
    var e = window.HOKEngine;
    if (!e || typeof e[fnName] !== 'function') {
      return { ok: false, error: '引擎未就绪（HOKEngine.' + fnName + ' 不可用）', data: null };
    }
    try {
      var r = e[fnName](ctx);
      if (!r || typeof r !== 'object') return { ok: false, error: '引擎返回空结果', data: null };
      return { ok: true, data: r, error: null };
    } catch (err) {
      return { ok: false, error: '引擎异常：' + msgOf(err), data: null };
    }
  }

  function recompute() {
    if (!heroes().length) {
      state.banResult = null; state.banErr = '英雄数据未就绪（/data/heroes.js）';
      state.pickResult = null; state.pickErr = '英雄数据未就绪（/data/heroes.js）';
      state.lineup = null; state.lineupErr = '英雄数据未就绪（/data/heroes.js）';
      state.presetPlan = null; state.presetErr = null;
      state.review = null; state.reviewErr = null;
      return;
    }
    var ctx = buildCtx();
    var ban = callEngine('banRecommend', ctx);
    state.banResult = ban.data;
    state.banErr = ban.error;

    var pick = callEngine('pickRecommend', ctx);
    state.pickResult = pick.data;
    state.pickErr = pick.error;

    var lineup = callEngine('lineupCheck', ctx);
    state.lineup = lineup.data;
    state.lineupErr = lineup.error;

    /* v2.4：预选方案 + 队伍总体评价（引擎未实现时静默降级，不报错） */
    if (engineHas('presetPlan')) {
      var pl = callEngine('presetPlan', ctx);
      state.presetPlan = pl.data;
      state.presetErr = pl.error;
    } else {
      state.presetPlan = null;
      state.presetErr = null;
    }
    if (engineHas('teamReview')) {
      var rv = callEngine('teamReview', ctx);
      state.review = rv.data;
      state.reviewErr = rv.error;
    } else {
      state.review = null;
      state.reviewErr = null;
    }
  }

  function localStep() {
    var nb = (state.picks.blue || []).length;
    var nr = (state.picks.red || []).length;
    var total = nb + nr;
    if (total >= 10) return null;
    var side = PICK_SEQUENCE[total] === 'B' ? 'blue' : 'red';
    var floor = side === 'blue' ? nb + 1 : nr + 1;
    return {
      index: total, side: side, isOurs: side === storeSide(), floor: floor,
      label: (side === 'blue' ? '蓝方' : '红方') + floor + '楼', slotType: ''
    };
  }

  function currentStepInfo() {
    var pr = state.pickResult;
    if (pr && pr.step && typeof pr.step === 'object') {
      var s = pr.step;
      return {
        index: num(s.index, 0),
        side: s.side === 'red' ? 'red' : 'blue',
        isOurs: !!s.isOurs,
        floor: num(s.floor, 1),
        label: s.label || ((s.side === 'red' ? '红方' : '蓝方') + num(s.floor, 1) + '楼'),
        slotType: s.slotType || '',
        playerIndex: typeof s.playerIndex === 'number' ? s.playerIndex : -1
      };
    }
    return localStep();
  }

  /* 我方第 1-2 手先抢、第 3 手补强、第 4-5 手克制（v2.1） */
  var PHASE_UI = [
    { key: 'grab', label: '先抢', hint: '优先 T0 / 强势，几乎不看克制' },
    { key: 'grab', label: '先抢', hint: '优先 T0 / 强势，几乎不看克制' },
    { key: 'mid', label: '补强', hint: '兼顾强度与阵容/分路' },
    { key: 'counter', label: '克制', hint: '专门 counter 对面核心' },
    { key: 'counter', label: '克制', hint: '专门 counter 对面核心' }
  ];

  function phaseInfo(step) {
    if (!step) return null;
    var pr = state.pickResult;
    if (step.isOurs && pr && pr.phase && pr.phase.key) return pr.phase;
    if (!step.isOurs) return { key: 'enemy', label: '敌方', hint: '记下对面拿了什么' };
    var ourNo = ((state.picks[storeSide()]) || []).length + 1;
    var p = PHASE_UI[Math.max(0, Math.min(4, ourNo - 1))];
    return { key: p.key, label: p.label, hint: p.hint, pickNo: ourNo };
  }

  function phaseBadge(phase) {
    if (!phase || !phase.key || phase.key === 'enemy') return '';
    return '<span class="phase-tag ph-' + phase.key + '">' + esc(phase.label) + '</span>';
  }

  /* ================= 赛前预选（v2.4 · 契约 §4.2） ================= */

  var PRESET_ROLE_LABEL = { core: '预选核心', partner: '预选搭配', fit: '契合方案' };
  var PRESET_STATUS_CLS = { available: 'ok', picked: 'ok', banned: 'bad', unavailable: 'warn' };

  function presetTemplates() { return Array.isArray(state.presets) ? state.presets : []; }

  function findPresetTemplate(id) {
    var list = presetTemplates();
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === id) return list[i]; }
    return null;
  }

  /* 兼容旧档：只接受 {id} / {id:'custom',core:[...]} / null（自定义核心最多 5 个） */
  function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = (typeof raw.id === 'string') ? raw.id.trim() : '';
    var core = [];
    if (Array.isArray(raw.core)) {
      raw.core.forEach(function (h) {
        var name = (typeof h === 'string') ? h.trim() : '';
        if (name && core.indexOf(name) < 0 && core.length < 5) core.push(name);
      });
    }
    if (id && id !== 'custom') {
      var obj = { id: id };
      if (core.length) obj.core = core;
      return obj;
    }
    if (core.length) return { id: 'custom', core: core };
    return null;
  }

  function hasPreset() {
    var p = state.preset;
    if (!p || typeof p !== 'object') return false;
    if (p.id && p.id !== 'custom' && findPresetTemplate(p.id)) return true;
    return Array.isArray(p.core) && p.core.length > 0;
  }

  function presetCoreNames() {
    var p = state.preset;
    if (!p || typeof p !== 'object') return [];
    if (Array.isArray(p.core) && p.core.length) return p.core.slice(0, 5);
    var tpl = findPresetTemplate(p.id);
    return (tpl && Array.isArray(tpl.core)) ? tpl.core.slice(0, 5) : [];
  }

  /* 预选数据里新增字段（AI 调研组合）的取值：plan 优先，退回原始模板 */
  function planField(plan, key) {
    if (plan && plan[key] !== undefined && plan[key] !== null) return plan[key];
    var tpl = plan ? findPresetTemplate(plan.id) : null;
    if (tpl && tpl[key] !== undefined && tpl[key] !== null) return tpl[key];
    return null;
  }

  var PRESET_PRIORITY_RANK = { S: 0, A: 1, B: 2, C: 3 };
  var PRESET_CONFIDENCE = { high: '高', medium: '中', low: '低' };

  function presetPriorityOf(tpl) {
    var p = tpl && tpl.priority ? String(tpl.priority).toUpperCase() : '';
    return PRESET_PRIORITY_RANK[p] !== undefined ? p : '';
  }

  function presetSizeOf(tpl) {
    if (!tpl) return 0;
    var n = Number(tpl.size);
    if (isFinite(n) && n > 0) return Math.floor(n);
    return Array.isArray(tpl.core) ? tpl.core.length : 0;
  }

  function confidenceLabel(v) {
    if (v === null || v === undefined || v === '') return '';
    var k = String(v).toLowerCase();
    return PRESET_CONFIDENCE[k] || String(v);
  }

  function statText(stats) {
    if (!stats || typeof stats !== 'object') return '';
    var parts = [];
    if (stats.idx !== null && stats.idx !== undefined) parts.push('idx ' + num(stats.idx));
    if (stats.matches !== null && stats.matches !== undefined) parts.push('样本 ' + num(stats.matches) + ' 场');
    return parts.join(' · ');
  }

  /* 用户实战补充的必 ban（服务端会标记来源；兼容几种常见字段名） */
  function isUserThreat(t) {
    if (!t || typeof t !== 'object') return false;
    if (t.user === true) return true;
    var keys = ['source', 'origin', 'from', 'by', 'tag', 'addedBy'];
    for (var i = 0; i < keys.length; i++) {
      var v = t[keys[i]];
      if (typeof v === 'string' && /user|实战|补充|combo-bans/i.test(v)) return true;
    }
    return false;
  }

  /* 模板筛选 + 排序（priority S→A→B，其次人数从多到少） */
  function filteredPresets() {
    var sz = state.presetSize;
    var pr = state.presetPriority;
    var list = presetTemplates().filter(function (t) {
      if (!t || !t.id) return false;
      if (sz !== 'all' && presetSizeOf(t) !== num(sz)) return false;
      if (pr !== 'all' && presetPriorityOf(t) !== pr) return false;
      return true;
    });
    list.sort(function (a, b) {
      var ra = PRESET_PRIORITY_RANK[presetPriorityOf(a)];
      var rb = PRESET_PRIORITY_RANK[presetPriorityOf(b)];
      if (ra === undefined) ra = 9;
      if (rb === undefined) rb = 9;
      if (ra !== rb) return ra - rb;
      var sa = presetSizeOf(a), sb = presetSizeOf(b);
      if (sa !== sb) return sb - sa;
      return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh');
    });
    return list;
  }

  function knownHero(name) { return !!heroByName(name); }

  function ourPickedHeroes() {
    return (state.picks[storeSide()] || []).filter(function (n) { return knownHero(n); });
  }

  function ourBanList() { return (state.bans.ours || []).filter(Boolean); }

  /* 引擎未就绪时的兜底：用 /api/presets 原始模板 + 本地池子状态，保证面板可用 */
  function fallbackPresetPlan() {
    if (!hasPreset()) return null;
    var p = state.preset || {};
    var tpl = findPresetTemplate(p.id);
    var cores = presetCoreNames();
    if (!cores.length) return null;

    var picked = ourPickedHeroes();
    var bannedAny = allBanned();
    var pickedAny = allPicked();
    var warningList = ['引擎预设分析（HOKEngine.presetPlan）未就绪，以下为模板原始数据 + 本地池子状态'];
    if (!tpl) warningList.push('自定义核心暂无法推导推荐搭配与必 ban（需要引擎）');

    function statusOf(hero) {
      if (bannedAny.indexOf(hero) >= 0) return 'banned';
      if (pickedAny.indexOf(hero) >= 0) return 'picked';
      return '';
    }

    var core = cores.map(function (hero) {
      var h = heroByName(hero);
      var owners = ownersOf(hero);
      var st = statusOf(hero);
      var label;
      if (st === 'banned') label = '已被 ban';
      else if (st === 'picked') label = '已被选';
      else if (owners.length) { st = 'available'; label = '可拿'; }
      else { st = 'unavailable'; label = '池里没人会'; }
      return {
        hero: hero, tier: tierOf(hero),
        lane: (h && h.roles && h.roles[0]) || '', laneLabel: h ? heroLaneText(h) : '—',
        inPool: owners.length > 0, owners: owners, status: st, statusLabel: label
      };
    });

    var threats = ((tpl && Array.isArray(tpl.threats)) ? tpl.threats : []).map(function (t) {
      var hero = t && t.hero;
      if (!hero) return null;
      var st = statusOf(hero) || 'available';
      return {
        hero: hero, tier: tierOf(hero), level: t.level === 'watch' ? 'watch' : 'must',
        reason: t.reason || '', inOurPool: ownersOf(hero).length > 0, owners: ownersOf(hero),
        status: st, banned: st === 'banned',
        source: t.source || t.origin || '', user: isUserThreat(t)
      };
    }).filter(Boolean);

    var partners = ((tpl && Array.isArray(tpl.partners)) ? tpl.partners : []).map(function (x) {
      var hero = x && x.hero;
      if (!hero) return null;
      var owners = ownersOf(hero);
      return {
        hero: hero, tier: tierOf(hero), note: x.note || '',
        inPool: owners.length > 0, owners: owners,
        status: statusOf(hero) || 'available'
      };
    }).filter(Boolean);

    var mustBans = threats.filter(function (t) { return t.level === 'must'; });
    return {
      active: true, fallback: true, custom: !tpl, id: p.id || 'custom',
      name: tpl ? (tpl.name || p.id) : ('自定义：' + cores.join(' + ')),
      subtitle: tpl ? (tpl.subtitle || '') : '自定义核心',
      tags: (tpl && Array.isArray(tpl.tags)) ? tpl.tags : [],
      core: core, threats: threats, partners: partners,
      playstyle: (tpl && tpl.playstyle) ? tpl.playstyle : null,
      winCondition: tpl ? (tpl.winCondition || '') : '',
      teamPlan: (tpl && Array.isArray(tpl.teamPlan)) ? tpl.teamPlan : [],
      tips: (tpl && Array.isArray(tpl.tips)) ? tpl.tips : [],
      /* AI 调研组合字段原样透传（有就展示） */
      size: tpl ? presetSizeOf(tpl) : cores.length,
      priority: tpl ? (tpl.priority || '') : '',
      type: tpl ? (tpl.type || '') : '',
      phase: tpl ? (tpl.phase || '') : '',
      why: tpl ? (tpl.why || '') : '',
      lanes: (tpl && tpl.lanes) ? tpl.lanes : null,
      banTargets: (tpl && Array.isArray(tpl.banTargets)) ? tpl.banTargets : [],
      counteredBy: (tpl && Array.isArray(tpl.counteredBy)) ? tpl.counteredBy : [],
      confidence: tpl ? (tpl.confidence || '') : '',
      stats: (tpl && tpl.stats) ? tpl.stats : null,
      sources: (tpl && Array.isArray(tpl.sources)) ? tpl.sources : [],
      flex: (tpl && tpl.flex) ? tpl.flex : null,
      progress: {
        core: { picked: cores.filter(function (h) { return picked.indexOf(h) >= 0; }).length, total: cores.length },
        partners: { picked: partners.filter(function (x) { return picked.indexOf(x.hero) >= 0; }).length, total: partners.length },
        bans: { banned: mustBans.filter(function (t) { return ourBanList().indexOf(t.hero) >= 0; }).length, total: mustBans.length }
      },
      warnings: warningList
    };
  }

  function presetPlanForUi() {
    if (!hasPreset()) return null;
    if (state.presetPlan && state.presetPlan.active) return state.presetPlan;
    return fallbackPresetPlan();
  }

  function presetProgressHtml(plan) {
    var pr = (plan && plan.progress) || {};
    var c = pr.core || {}, b = pr.bans || {}, p = pr.partners || {};
    return '<span class="pp-item">核心 ' + num(c.picked) + '/' + num(c.total) + '</span>' +
      '<span class="pp-item">必 ban ' + num(b.banned) + '/' + num(b.total) + '</span>' +
      '<span class="pp-item">搭配 ' + num(p.picked) + '/' + num(p.total) + '</span>';
  }

  function presetOwnersHtml(owners) {
    if (!Array.isArray(owners) || !owners.length) return '<span class="pool-out">池里没人会</span>';
    return owners.slice(0, 3).map(function (o) {
      return '<span class="owner-chip"><b>' + esc(o.name || '') + '</b>' + masteryBadge(o.mastery) + '</span>';
    }).join('');
  }

  function presetCoreWarnHtml(plan) {
    if (!plan) return '';
    var banned = [], unavailable = [];
    (Array.isArray(plan.core) ? plan.core : []).forEach(function (c) {
      if (!c || !c.hero) return;
      if (c.status === 'banned') banned.push(c.hero);
      else if (c.status === 'unavailable') unavailable.push(c.hero);
    });
    var out = [];
    if (banned.length) {
      out.push('<div class="notice bad">预选核心「' + esc(banned.join('」「')) + '」已被 ban，方案自动降级：改拿推荐搭配，或按强度/克制推荐。</div>');
    }
    if (unavailable.length) {
      out.push('<div class="notice warn">预选核心「' + esc(unavailable.join('」「')) +
        '」不在任何队友的英雄池里：去「英雄池」补池，或「换一套」。</div>');
    }
    return out.join('');
  }

  /* ================= sessionStorage ================= */

  function persist() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        phase: state.phase, bans: state.bans, picks: state.picks, recs: state.recs,
        assignments: state.assignments, preset: state.preset, at: Date.now()
      }));
    } catch (e) { /* 隐私模式等：忽略 */ }
  }

  function restoreSession() {
    try {
      var raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && (d.phase === 'ban' || d.phase === 'pick')) state.phase = d.phase;
      if (d && d.bans) {
        ['ours', 'theirs'].forEach(function (k) {
          if (Array.isArray(d.bans[k])) {
            var out = ['', '', '', '', ''];
            for (var i = 0; i < 5; i++) out[i] = typeof d.bans[k][i] === 'string' ? d.bans[k][i] : '';
            state.bans[k] = out;
          }
        });
      }
      if (d && d.picks) {
        ['blue', 'red'].forEach(function (k) {
          if (Array.isArray(d.picks[k])) state.picks[k] = d.picks[k].filter(function (x) { return typeof x === 'string' && x; });
        });
      }
      if (d && Array.isArray(d.recs)) state.recs = d.recs;
      if (d && d.assignments && typeof d.assignments === 'object') {
        state.assignments = {};
        Object.keys(d.assignments).forEach(function (h) {
          var v = Number(d.assignments[h]);
          if (isFinite(v) && v >= 0 && v < 5) state.assignments[h] = v;
        });
      }
      /* v2.4：预选方案（旧档没有这个字段 → null，行为不变） */
      state.preset = (d && d.preset) ? normalizePreset(d.preset) : null;
    } catch (e) { /* 忽略损坏缓存 */ }
  }

  /* ================= 顶栏 / Tab ================= */

  function renderHeader() {
    var v = $id('dataVersion');
    var c = $id('connState');
    if (!v || !c) return;
    var date = (state.health && state.health.date) || (state.meta && state.meta.version) || '';
    v.textContent = '数据 ' + (date || '—');
    v.className = 'pill' + (date ? '' : ' pill-dim');

    var connected = !!state.health;
    c.textContent = connected ? '已连接' : (state.loading ? '连接中…' : '未连接');
    c.className = 'pill ' + (connected ? 'pill-ok' : 'pill-bad');

    var tip = [];
    if (state.health) {
      tip.push('英雄 ' + num(state.health.heroCount, 0) + ' · 头像 ' + num(state.health.iconCount, 0) +
        ' · 梯度 ' + num(state.health.tierCount, 0) + ' · 关系 ' + num(state.health.relCount, 0));
    }
    if (state.healthErr) tip.push('health：' + state.healthErr);
    if (state.metaErr) tip.push('meta：' + state.metaErr);
    if (state.relationsErr) tip.push('relations：' + state.relationsErr);
    if (state.storeErr) tip.push('store：' + state.storeErr);
    c.title = tip.join('\n');
  }

  function renderTabs() {
    var el = $id('tabs');
    if (!el) return;
    el.innerHTML = TABS.map(function (t) {
      var badge = '';
      if (t.id === 'bp') {
        var total = allPicked().length;
        badge = '<span class="tab-badge">' + (state.phase === 'ban' ? 'Ban' : (total >= 10 ? '完' : (total + 1) + '/10')) + '</span>';
      }
      return '<button class="tab' + (state.tab === t.id ? ' active' : '') + '" data-act="tab" data-tab="' + t.id + '">' +
        esc(t.label) + badge + '</button>';
    }).join('');
  }

  function setTab(id) {
    if (!TABS.some(function (t) { return t.id === id; })) return;
    state.tab = id;
    state.picker = null;
    state.poolEditor = null;
    renderTabs();
    renderView();
    renderModal();
  }

  /* ================= 数据加载 ================= */

  function loadAll() {
    state.loading = true;
    renderHeader();
    renderView();

    var jobs = [
      api('GET', '/api/health').then(function (d) { state.health = d; state.healthErr = null; })
        .catch(function (e) { state.health = null; state.healthErr = msgOf(e); }),
      api('GET', '/api/meta').then(function (d) {
        if (!d || typeof d !== 'object' || !d.tiers) throw new Error('meta.json 结构不完整');
        state.meta = d; state.metaErr = null;
      }).catch(function (e) { state.meta = null; state.metaErr = msgOf(e); }),
      api('GET', '/api/relations').then(function (d) {
        if (!d || typeof d !== 'object') throw new Error('relations.json 结构不完整');
        state.relations = {
          date: d.date || '',
          counters: Array.isArray(d.counters) ? d.counters : [],
          synergies: Array.isArray(d.synergies) ? d.synergies : []
        };
        state.relationsErr = null;
      }).catch(function (e) { state.relations = null; state.relationsErr = msgOf(e); }),
      api('GET', '/api/store').then(function (d) {
        state.store = normalizeStore(d); state.storeErr = null; state.storeDirty = false;
      }).catch(function (e) {
        state.store = normalizeStore(null); state.storeErr = msgOf(e);
      }),
      /* v2.4：预选阵容模板（只读数据；失败只影响预选面板，不影响 BP） */
      api('GET', '/api/presets').then(function (d) {
        var list = (d && Array.isArray(d.presets)) ? d.presets : [];
        if (!list.length) throw new Error('/api/presets 没有可用模板');
        state.presets = list.filter(function (t) { return t && typeof t === 'object' && t.id; });
        state.presetsErr = null;
      }).catch(function (e) { state.presets = []; state.presetsErr = msgOf(e); }),
      /* v2.5：组合原始数据（通用组合加成；失败只少这一项，不影响 BP） */
      api('GET', '/api/combos').then(function (d) {
        var list = (d && Array.isArray(d.comps)) ? d.comps : [];
        state.combos = list;
        state.combosErr = null;
      }).catch(function (e) { state.combos = []; state.combosErr = msgOf(e); })
    ];

    return Promise.all(jobs).then(finishLoad, finishLoad);
  }

  function finishLoad() {
    state.loading = false;
    recompute();
    renderAll();
  }

  /* ================= 渲染入口 ================= */

  function renderAll() {
    renderHeader();
    renderTabs();
    renderView();
    renderModal();
  }

  function renderView() {
    var view = $id('view');
    if (!view) return;
    var html;
    switch (state.tab) {
      case 'bp': html = renderBp(); break;
      case 'tiers': html = renderTiers(); break;
      case 'data': html = renderData(); break;
      case 'export': html = renderExport(); break;
      case 'settings':
      default: html = renderSettings();
    }
    view.innerHTML = html;
  }

  function notices(extra) {
    var out = [];
    if (!heroes().length) {
      out.push('<div class="notice bad">英雄数据未就绪：/data/heroes.js 未加载成功。' + NOT_READY + '</div>');
    }
    if (state.metaErr) out.push('<div class="notice warn">梯度数据不可用：' + esc(state.metaErr) + ' · ' + NOT_READY + '</div>');
    if (state.relationsErr) out.push('<div class="notice warn">关系数据不可用：' + esc(state.relationsErr) + ' · ' + NOT_READY + '</div>');
    if (state.storeErr) out.push('<div class="notice warn">存档读取失败：' + esc(state.storeErr) + ' · 当前使用空模板，保存时会重建</div>');
    if (extra) out.push(extra);
    return out.join('');
  }

  /* ================= 设置页（英雄池） ================= */

  function renderSettings() {
    var s = state.store || defaultStore();
    var out = [];
    out.push(notices(''));

    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>队伍 &amp; 英雄池</h2><div class="row gap">');
    out.push('<span class="hint" id="saveState">' + esc(saveStateText()) + '</span>');
    out.push('<button class="btn btn-sm" data-act="saveStore">保存到服务端</button>');
    out.push('</div></div>');

    out.push('<div class="field-row"><label>我方阵营</label><div class="seg">');
    [['blue', '蓝方'], ['red', '红方']].forEach(function (pair) {
      out.push('<button class="seg-btn' + (s.side === pair[0] ? ' active' : '') + '" data-act="setSide" data-side="' + pair[0] + '">' + pair[1] + '</button>');
    });
    out.push('</div><span class="hint">五排可换位 / 帮抢，楼层不参与计算；分路只是倾向，不限制选人。</span></div>');

    out.push('<div class="mastery-legend">');
    MASTERY_ORDER.forEach(function (k) {
      var m = MASTERY[k];
      out.push('<span class="ml-item"><span class="mb ' + m.cls + '">' + m.label + '</span>' + esc(m.desc) + '</span>');
    });
    out.push('</div>');

    out.push('<div class="players">');
    s.players.forEach(function (p, i) {
      var sum = poolSummary(p);
      out.push('<div class="player-card">');
      out.push('<div class="pc-name"><input class="input" data-act="playerName" data-idx="' + i + '" value="' + esc(p.name) +
        '" maxlength="12" placeholder="玩家名" aria-label="玩家名"></div>');
      out.push('<div class="pc-pool"><button class="btn pool-btn" data-act="openPool" data-idx="' + i + '">英雄池 ' + sum.total +
        ' <em class="ms">绝 ' + sum.best + '/常 ' + sum.normal + '/会 ' + sum.basic + '</em></button></div>');

      out.push('<div class="pc-lanes"><span class="pc-lane-label">倾向分路</span><div class="lane-toggles">');
      LANE_KEYS.forEach(function (lk) {
        var on = (p.preferLanes || []).indexOf(lk) >= 0;
        out.push('<button class="lt' + (on ? ' on' : '') + '" data-act="togglePrefer" data-idx="' + i + '" data-lane="' + lk + '">' + esc(LANES[lk]) + '</button>');
      });
      out.push('</div></div>');

      if (sum.total) {
        out.push('<div class="pool-chips">');
        p.pool.forEach(function (e) {
          out.push('<button class="chip hero-chip" data-act="openPool" data-idx="' + i + '" title="点击编辑熟练度">' +
            avatar(e.hero) + '<span class="hc-name">' + esc(e.hero) + '</span>' + masteryBadge(e.mastery) + '</button>');
        });
        out.push('</div>');
      } else {
        out.push('<div class="pool-chips"><span class="hint">还没填池 —— 点右侧「英雄池」选人，或看下面的补池建议。</span></div>');
      }
      out.push('</div>');
    });
    out.push('</div>');
    out.push('</section>');

    /* ---- 补池建议（单源 + 去重） ---- */
    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>体检 &amp; 补池建议</h2><div class="row gap">');
    out.push('<button class="btn btn-blue btn-sm" data-act="runAdvice"' + (state.adviceBusy ? ' disabled' : '') + '>' +
      (state.adviceBusy ? '分析中…' : '体检 & 补池建议') + '</button>');
    out.push('</div></div>');

    if (state.adviceErr) out.push('<div class="notice bad">' + esc(state.adviceErr) + '</div>');

    var adv = state.advice;
    if (adv) {
      var notes = Array.isArray(adv.notes) ? adv.notes : [];
      var warns = Array.isArray(adv.warnings) ? adv.warnings : [];
      if (notes.length || warns.length) {
        out.push('<div class="notice">' + notes.concat(warns).map(function (n) { return esc(n); }).join('<br>') + '</div>');
      }

      var ps = Array.isArray(adv.players) ? adv.players : [];
      if (ps.length) {
        out.push('<div class="pool-bars">');
        ps.forEach(function (p) {
          var pct = Math.min(100, Math.round(num(p.depth) / 12 * 100));
          var mc = p.masteryCounts || {};
          out.push('<div class="pb-row"><span class="pb-name">' + num(p.floor) + '楼 ' + esc(p.name) + '</span>' +
            '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
            '<span class="pb-val">' + num(p.depth) + ' 个 · 绝' + num(mc.best) + '/常' + num(mc.normal) + '/会' + num(mc.basic) + '</span></div>');
        });
        out.push('</div>');
      }

      var sug = dedupeSuggestions(Array.isArray(adv.suggestions) ? adv.suggestions : []);
      if (sug.length) {
        out.push('<div class="advice">');
        sug.forEach(function (g, gi) {
          out.push('<div class="advice-item">');
          out.push('<div class="ai-hero">' + avatar(g.hero, 'sm') + '<b>' + esc(g.hero) + '</b> ' +
            '<span class="' + tierClass(g.tier) + '">' + esc(g.tier || 'T2') + '</span></div>');
          out.push('<div class="advice-reasons">' + (g.reasons || []).map(function (r) {
            return '<span class="chip sm">' + esc(r) + '</span>';
          }).join('') + (g.laneFit && g.laneFit.length ? '<span class="chip sm lane">' + g.laneFit.map(esc).join('/') + '</span>' : '') + '</div>');
          out.push('<div class="advice-targets">');
          (g.forPlayers || []).forEach(function (fp) {
            out.push('<button class="btn btn-sm" data-act="adviceAdd" data-sidx="' + gi + '" data-pidx="' + num(fp.playerIndex) + '">加到 ' +
              esc(fp.name) + '（' + num(fp.floor) + '楼）</button>');
          });
          out.push('</div>');
          out.push('</div>');
        });
        out.push('</div>');
        out.push('<div class="hint" style="margin-top:8px">同一英雄只会出现一次；多个玩家都需要时会合并成「加到 谁」多个按钮。</div>');
      } else {
        out.push('<div class="notice ok">池子覆盖良好，暂无补池建议。</div>');
      }
    } else if (!state.adviceBusy && !state.adviceErr) {
      out.push('<div class="notice">点按钮检查：池深、绝活/正常/仅会玩的分布、五路覆盖、阵容能力缺口，并给出可一键入池的英雄。</div>');
    }
    out.push('</section>');

    return out.join('');
  }

  function saveStateText() {
    if (state.saveState) return state.saveState;
    return state.storeDirty ? '有未保存修改' : '已与服务端同步';
  }

  /* UI 兜底去重：即使引擎出问题，也不会把同一英雄渲染两遍 */
  function dedupeSuggestions(list) {
    var map = {};
    var order = [];
    list.forEach(function (g) {
      if (!g || !g.hero) return;
      var name = g.hero;
      if (!map[name]) {
        map[name] = {
          hero: name, heroId: g.heroId, tier: g.tier, laneFit: (g.laneFit || []).slice(),
          forPlayers: [], reasons: []
        };
        order.push(name);
      }
      var t = map[name];
      (g.forPlayers || []).forEach(function (fp) {
        var idx = fp.playerIndex;
        var exists = t.forPlayers.some(function (x) { return x.playerIndex === idx; });
        if (!exists) t.forPlayers.push({ playerIndex: idx, name: fp.name, floor: fp.floor });
      });
      (g.reasons || []).forEach(function (r) { if (t.reasons.indexOf(r) < 0) t.reasons.push(r); });
      (g.laneFit || []).forEach(function (l) { if (t.laneFit.indexOf(l) < 0) t.laneFit.push(l); });
      if (!t.tier && g.tier) t.tier = g.tier;
    });
    return order.map(function (n) { return map[n]; }).filter(function (g) { return g.forPlayers.length > 0; });
  }

  /* ================= 英雄池编辑器（弹窗） ================= */

  function openPoolEditor(idx) {
    var p = players()[idx];
    if (!p) return;
    var sel = {};
    poolEntries(p).forEach(function (e) { sel[e.hero] = normalizeMastery(e.mastery); });
    state.poolEditor = {
      idx: idx, query: '', lane: 'all', type: 'all', onlySel: false, sel: sel
    };
    renderModal();
  }

  function closePoolEditor() { state.poolEditor = null; renderModal(); }

  function poolEditorPlayer() {
    var pe = state.poolEditor;
    return pe ? players()[pe.idx] : null;
  }

  function poolCandidateList() {
    var pe = state.poolEditor;
    if (!pe) return [];
    var q = (pe.query || '').trim();
    var list = heroesForFilter(pe.lane, pe.type);
    if (q) list = list.filter(function (h) { return matchesQuery(h, q); });
    if (pe.onlySel) list = list.filter(function (h) { return !!pe.sel[h.name]; });
    return list.slice().sort(function (a, b) {
      var d = tierScore(b.name) - tierScore(a.name);
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
    });
  }

  function poolListHtml() {
    var pe = state.poolEditor;
    if (!pe) return '';
    var list = poolCandidateList();
    if (!list.length) return '<div class="notice">没有匹配的英雄</div>';
    var html = ['<div class="hero-grid">'];
    list.forEach(function (h) {
      var m = pe.sel[h.name];
      var on = !!m;
      html.push('<div class="pcard' + (on ? ' sel' : '') + '">');
      html.push('<button class="pcard-top" data-act="poolToggle" data-hero="' + esc(h.name) + '">');
      html.push(avatar(h.name, 'md'));
      html.push('<span class="pcard-info"><b>' + esc(h.name) + '</b><span class="pcard-tags">' +
        tagsHtml(h.name, { tier: true, lanes: true }) + '</span></span>');
      html.push('</button>');
      if (on) {
        html.push('<div class="pcard-mastery">');
        MASTERY_ORDER.forEach(function (mk) {
          var info = MASTERY[mk];
          html.push('<button class="mbtn ' + info.cls + (m === mk ? ' active' : '') + '" data-act="poolMastery" data-hero="' +
            esc(h.name) + '" data-m="' + mk + '" title="' + esc(info.desc) + '">' + info.label + '</button>');
        });
        html.push('</div>');
      }
      html.push('</div>');
    });
    html.push('</div>');
    return html.join('');
  }

  function updatePoolList() {
    var box = $id('poolList');
    if (!box || !state.poolEditor) return;
    box.innerHTML = poolListHtml();
    updatePoolCount();
  }

  function updatePoolCount() {
    var pe = state.poolEditor;
    var el = $id('poolCount');
    if (!pe || !el) return;
    var s = { total: 0, best: 0, normal: 0, basic: 0 };
    Object.keys(pe.sel).forEach(function (n) { s.total++; s[normalizeMastery(pe.sel[n])]++; });
    el.textContent = '已选 ' + s.total + ' 个 · 绝活 ' + s.best + ' / 正常 ' + s.normal + ' / 仅会玩 ' + s.basic;
  }

  function renderPoolEditor() {
    var pe = state.poolEditor;
    var p = poolEditorPlayer();
    if (!pe || !p) { $id('modalRoot').innerHTML = ''; return; }
    var out = [];
    out.push('<div class="modal-mask" data-act="poolMask">');
    out.push('<div class="modal modal-lg" role="dialog" aria-modal="true" aria-label="英雄池">');
    out.push('<div class="modal-head"><h2>英雄池 · ' + esc(p.name) + '（' + num(p.floor) + '楼 · 倾向 ' +
      esc((p.preferLanes || []).map(laneLabel).join('/') || '未设') + '）</h2>');
    out.push('<button class="btn btn-sm ghost" data-act="poolClose">关闭</button></div>');
    out.push('<div class="modal-body">');
    out.push('<div class="hint" style="margin-bottom:8px">点英雄加入/移出池子；入池后选熟练度：' +
      '<b class="mb mb-best">绝活</b> 被克也能打，<b class="mb mb-normal">正常</b> 正常发挥，<b class="mb mb-basic">仅会玩</b> 需要 counter 对面。</div>');

    out.push('<div class="filters">');
    out.push('<button class="seg-btn' + (pe.lane === 'all' ? ' active' : '') + '" data-act="poolLane" data-lane="all">全部分路</button>');
    LANE_KEYS.forEach(function (lk) {
      out.push('<button class="seg-btn' + (pe.lane === lk ? ' active' : '') + '" data-act="poolLane" data-lane="' + lk + '">' + esc(LANES[lk]) + '</button>');
    });
    out.push('</div>');
    out.push('<div class="search-row">');
    out.push('<input class="input" id="poolQuery" data-act="poolQuery" value="' + esc(pe.query) + '" placeholder="搜索英雄名 / 类型 / 分路…" autocomplete="off">');
    out.push('<button class="btn btn-sm' + (pe.onlySel ? ' btn-blue' : ' ghost') + '" data-act="poolOnlySel">只看已选</button>');
    out.push('</div>');
    out.push('<div id="poolList">' + poolListHtml() + '</div>');
    out.push('</div>');
    out.push('<div class="modal-foot">');
    out.push('<span class="spacer hint" id="poolCount"></span>');
    out.push('<button class="btn btn-sm ghost" data-act="poolSelectAll">全选当前筛选</button>');
    out.push('<button class="btn btn-sm ghost" data-act="poolClear">清空池子</button>');
    out.push('<button class="btn btn-sm btn-primary" data-act="poolDone">完成</button>');
    out.push('</div></div></div>');
    $id('modalRoot').innerHTML = out.join('');
    updatePoolCount();
  }

  function applyPoolEditorToStore() {
    var pe = state.poolEditor;
    var p = poolEditorPlayer();
    if (!pe || !p) return;
    var arr = [];
    // 保持已有顺序，再追加新选
    poolEntries(p).forEach(function (e) {
      if (pe.sel[e.hero] !== undefined) arr.push({ hero: e.hero, mastery: normalizeMastery(pe.sel[e.hero]) });
    });
    Object.keys(pe.sel).forEach(function (hero) {
      if (!arr.some(function (x) { return x.hero === hero; })) arr.push({ hero: hero, mastery: normalizeMastery(pe.sel[hero]) });
    });
    p.pool = arr;
    markStoreDirty();
  }

  /* ================= 通用单选英雄弹窗（ban / 敌方 pick / 池外指定） ================= */

  var PICKER_TITLES = {
    banOurs: '我方 Ban',
    banTheirs: '敌方 Ban',
    banTheirsBulk: '敌方 Ban · 一次选 5 个',
    pickOurs: '手动指定我方选人（池外）',
    pickEnemy: '录入敌方选人',
    presetCore: '预选核心英雄'
  };

  function openPicker(cfg) {
    state.picker = {
      kind: cfg.kind,
      slot: cfg.slot,
      query: '',
      lane: 'all',
      type: 'all',
      multi: !!cfg.multi,
      max: cfg.max || 1,
      sel: cfg.sel ? cfg.sel.slice(0, cfg.max || 1) : []
    };
    renderModal();
    var input = $id('pickerQuery');
    if (input) { try { input.focus(); } catch (e) { /* ignore */ } }
  }

  function closePicker() { state.picker = null; renderModal(); }

  function pickerTitle(pk) {
    var base = PICKER_TITLES[pk.kind] || '选择英雄';
    if (pk.kind === 'banOurs' || pk.kind === 'banTheirs') return base + ' · 第 ' + (num(pk.slot) + 1) + ' 个';
    if (pk.kind === 'presetCore') return base + ' · 最多 ' + num(pk.max, 5) + ' 个';
    return base;
  }

  function pickerSubtitle(pk) {
    if (pk.kind === 'pickOurs') return '正常流程请用「推荐卡」直接点英雄；这里用于池外临时指定（会提示不在池内）。';
    if (pk.kind === 'pickEnemy') return '按实际对局录入敌方英雄，已 ban / 已选不会重复出现。';
    if (pk.kind === 'banTheirsBulk') return '最多选 5 个（选几个填几个，剩下的留空 = 空 ban）；已 ban / 已选不会重复出现。';
    if (pk.kind === 'presetCore') return '选 1-5 个核心英雄；系统会推导必 ban 名单、推荐搭配与队友分工。';
    return '已被 ban / 已选的英雄不会重复出现。';
  }

  /* 选英雄弹窗候选：只按分路筛（v2.2 不再按职业分类） */
  function pickerList() {
    var pk = state.picker;
    if (!pk) return [];
    var q = (pk.query || '').trim();
    var list = heroesForFilter(pk.lane, 'all');
    if (q) list = list.filter(function (h) { return matchesQuery(h, q); });
    list = list.filter(function (h) { return pk.sel.indexOf(h.name) >= 0 || !isTaken(h.name); });
    return list.slice().sort(function (a, b) {
      var d = tierScore(b.name) - tierScore(a.name);
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
    });
  }

  function pickerListHtml() {
    var pk = state.picker;
    if (!pk) return '';
    var list = pickerList();
    if (!list.length) return '<div class="notice">没有匹配的英雄</div>';
    var html = ['<div class="hero-grid">'];
    list.forEach(function (h) {
      var idx = pk.sel.indexOf(h.name);
      var on = idx >= 0;
      html.push('<button class="hero-opt' + (on ? ' sel' : '') + '" data-act="pickerToggle" data-hero="' + esc(h.name) + '">' +
        avatar(h.name) + '<span class="ho-name">' + esc(h.name) + '</span>' +
        (on && pk.multi ? '<span class="ho-order">' + (idx + 1) + '</span>' : '') +
        '<span class="ho-tier ' + tierClass(tierOf(h.name)).replace('tier ', '') + '">' + esc(tierOf(h.name)) + '</span>' +
        '</button>');
    });
    html.push('</div>');
    return html.join('');
  }

  function updatePickerList() {
    var box = $id('pickerList');
    if (!box || !state.picker) return;
    box.innerHTML = pickerListHtml();
    var cnt = $id('pickerCount');
    if (cnt) cnt.textContent = '候选 ' + pickerList().length + ' 个';
    var sc = $id('pickerSelCount');
    if (sc) sc.textContent = String(state.picker.sel.length);
  }

  function renderPicker() {
    var pk = state.picker;
    if (!pk) { $id('modalRoot').innerHTML = ''; return; }
    var out = [];
    out.push('<div class="modal-mask" data-act="pickerMask">');
    out.push('<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(pickerTitle(pk)) + '">');
    out.push('<div class="modal-head"><h2>' + esc(pickerTitle(pk)) + '</h2>');
    out.push('<button class="btn btn-sm ghost" data-act="pickerClose">关闭</button></div>');
    out.push('<div class="modal-body">');
    out.push('<div class="hint" style="margin-bottom:8px">' + esc(pickerSubtitle(pk)) + '</div>');
    out.push('<div class="filters">');
    out.push('<button class="seg-btn' + (pk.lane === 'all' ? ' active' : '') + '" data-act="pickerLane" data-lane="all">全部分路</button>');
    LANE_KEYS.forEach(function (lk) {
      out.push('<button class="seg-btn' + (pk.lane === lk ? ' active' : '') + '" data-act="pickerLane" data-lane="' + lk + '">' + esc(LANES[lk]) + '</button>');
    });
    out.push('</div>');
    out.push('<div class="search-row"><input class="input" id="pickerQuery" data-act="pickerQuery" value="' + esc(pk.query) +
      '" placeholder="搜索英雄名 / 分路…" autocomplete="off"></div>');
    out.push('<div id="pickerList">' + pickerListHtml() + '</div>');
    out.push('</div>');
    out.push('<div class="modal-foot">');
    out.push('<span class="spacer hint" id="pickerCount"></span>');
    out.push('<button class="btn btn-sm ghost" data-act="pickerNone">清空</button>');
    out.push('<button class="btn btn-sm btn-primary" data-act="pickerConfirm">' +
      (pk.multi ? '确定（已选 <span id="pickerSelCount">' + pk.sel.length + '</span>/' + pk.max + '）' : '确定') + '</button>');
    out.push('</div></div></div>');
    $id('modalRoot').innerHTML = out.join('');
    updatePickerList();
  }

  /* ================= 指定「这个英雄由谁玩」（v2.3） ================= */

  function openAssign(hero) {
    if (!hero) return;
    state.assignPicker = { hero: hero };
    renderModal();
  }

  function closeAssign() { state.assignPicker = null; renderModal(); }

  function heroAssignedTo(pi, exceptHero) {
    var am = assignmentMap();
    var out = '';
    Object.keys(am).forEach(function (h) {
      if (h !== exceptHero && am[h] && am[h].playerIndex === pi) out = h;
    });
    return out;
  }

  function currentPlayerOfHero(hero) {
    var am = assignmentMap();
    return (am[hero] && typeof am[hero].playerIndex === 'number') ? am[hero].playerIndex : -1;
  }

  function renderAssignPicker() {
    var ap = state.assignPicker;
    if (!ap) { $id('modalRoot').innerHTML = ''; return; }
    var hero = ap.hero;
    var current = currentPlayerOfHero(hero);
    var manual = state.assignments[hero] !== undefined;
    var out = [];
    out.push('<div class="modal-mask" data-act="assignMask">');
    out.push('<div class="modal" role="dialog" aria-modal="true" aria-label="指定谁玩">');
    out.push('<div class="modal-head"><h2>指定「' + esc(hero) + '」由谁玩</h2>');
    out.push('<button class="btn btn-sm ghost" data-act="assignClose">关闭</button></div>');
    out.push('<div class="modal-body">');
    out.push('<div class="hint" style="margin-bottom:10px">只能选池里有这个英雄、且当前没在打其他英雄的队友；换人后 BP 推荐会按新分配重算。</div>');
    out.push('<div class="assign-list">');
    players().forEach(function (p, i) {
      var m = masteryOf(p, hero);
      var busy = heroAssignedTo(i, hero);
      var isCur = i === current;
      var dis = !m || (!!busy && !isCur);
      out.push('<button class="assign-opt' + (isCur ? ' cur' : '') + '" data-act="assignChoose" data-hero="' + esc(hero) + '" data-pidx="' + i + '"' +
        (dis ? ' disabled' : '') + '>');
      out.push('<span class="ao-name">' + esc(p.name) + '</span>');
      out.push(m ? masteryBadge(m) : '<span class="pool-out">池里没有</span>');
      out.push('<span class="ao-note">' + (isCur ? '当前分配' : (busy ? '正在打 ' + esc(busy) : '空闲')) + '</span>');
      out.push('</button>');
    });
    out.push('</div>');
    out.push('</div>');
    out.push('<div class="modal-foot">');
    out.push('<span class="spacer hint">' + (manual ? '当前：手动指定' : '当前：自动匹配') + '</span>');
    if (manual) out.push('<button class="btn btn-sm ghost" data-act="assignAuto" data-hero="' + esc(hero) + '">恢复自动</button>');
    out.push('<button class="btn btn-sm btn-primary" data-act="assignClose">完成</button>');
    out.push('</div></div></div>');
    $id('modalRoot').innerHTML = out.join('');
  }

  function chooseAssignment(hero, pidx) {
    var p = players()[pidx];
    if (!p || !masteryOf(p, hero)) { toast('该队友池里没有这个英雄', 'bad'); return; }
    var busy = heroAssignedTo(pidx, hero);
    if (busy) { toast(p.name + ' 正在打 ' + busy + '，先给他换人再指定', 'bad'); return; }
    state.assignments[hero] = pidx;
    closeAssign();
    persist();
    recompute();
    renderAll();
    toast('已指定：' + hero + ' → ' + p.name, 'ok');
  }

  function clearAssignment(hero) {
    delete state.assignments[hero];
    closeAssign();
    persist();
    recompute();
    renderAll();
    toast('已恢复自动分配', 'ok');
  }

  function renderModal() {
    var root = $id('modalRoot');
    if (!root) return;
    if (state.poolEditor) { renderPoolEditor(); return; }
    if (state.assignPicker) { renderAssignPicker(); return; }
    if (state.picker) { renderPicker(); return; }
    root.innerHTML = '';
  }

  /* ================= BP 页 ================= */

  function poolsReady() {
    return players().some(function (p) { return poolEntries(p).length > 0; });
  }

  function renderBp() {
    var out = [];
    out.push(notices(''));
    if (!poolsReady()) {
      out.push('<div class="notice warn">英雄池还是空的：先去「英雄池」页填 5 个人的池子，BP 推荐才有意义。' +
        '<button class="btn btn-sm" data-act="tab" data-tab="settings" style="margin-left:8px">去填池</button></div>');
    } else if (state.phase === 'pick') {
      out.push(renderBanStrip());
    }
    if (state.phase === 'ban') {
      out.push(renderPresetPanel());
      out.push(renderBanPhase());
    } else {
      out.push(renderPresetStrip());
      out.push(renderReviewPanel());
      out.push(renderPickPhase());
    }
    return out.join('');
  }

  /* ---- 赛前预选渲染（v2.4） ---- */

  /* 紧凑模板卡：priority 徽标 / name / type / core 头像 / 必 ban / 可信度+样本 */
  function presetCardHtml(tpl) {
    if (!tpl) return '';
    var cores = Array.isArray(tpl.core) ? tpl.core : [];
    var musts = [];
    (Array.isArray(tpl.threats) ? tpl.threats : []).forEach(function (t) {
      if (t && t.hero && t.level !== 'watch' && musts.indexOf(t.hero) < 0) musts.push(t.hero);
    });
    var prio = presetPriorityOf(tpl);
    var size = presetSizeOf(tpl);
    var conf = confidenceLabel(tpl.confidence);
    var stats = statText(tpl.stats);
    var out = [];
    out.push('<button class="preset-card" data-act="usePreset" data-id="' + esc(tpl.id) + '">');
    out.push('<span class="ps-top">');
    if (prio) out.push('<span class="ps-prio p-' + esc(prio) + '">' + esc(prio) + '</span>');
    out.push('<b class="ps-name">' + esc(tpl.name || tpl.id) + '</b>');
    out.push('<span class="ps-size">' + size + ' 人</span>');
    out.push('</span>');
    if (tpl.type) out.push('<span class="ps-type">' + esc(tpl.type) + '</span>');
    out.push('<span class="ps-core">');
    cores.forEach(function (h) {
      out.push('<span class="ps-hero" title="' + esc(h) + '">' + avatar(h, 'sm') +
        '<span class="ps-hero-main"><b>' + esc(h) + '</b>' +
        '<span class="ps-hero-meta"><span class="' + tierClass(tierOf(h)) + '">' + esc(tierOf(h)) + '</span></span></span></span>');
    });
    out.push('</span>');
    var metaBits = [];
    if (musts.length) {
      metaBits.push('<span class="ps-bans">必 ban ' + musts.slice(0, 4).map(function (h) {
        return '<b>' + esc(h) + '</b>';
      }).join('、') + (musts.length > 4 ? ' 等' : '') + '</span>');
    }
    var ev = [];
    if (conf) ev.push('可信度 ' + esc(conf));
    if (stats) ev.push(esc(stats));
    if (ev.length) metaBits.push('<span class="ps-ev">' + ev.join(' · ') + '</span>');
    if (metaBits.length) out.push('<span class="ps-meta">' + metaBits.join('') + '</span>');
    out.push('</button>');
    return out.join('');
  }

  function presetFiltersHtml() {
    var total = presetTemplates().length;
    var shown = filteredPresets().length;
    var out = ['<div class="preset-filters">'];
    out.push('<span class="pf-label">人数</span>');
    out.push('<span class="pf-group">');
    [['all', '全部'], ['2', '2 人'], ['3', '3 人'], ['4', '4 人'], ['5', '5 人']].forEach(function (p) {
      out.push('<button class="seg-btn' + (state.presetSize === p[0] ? ' active' : '') +
        '" data-act="presetFilterSize" data-size="' + p[0] + '">' + p[1] + '</button>');
    });
    out.push('</span>');
    out.push('<span class="pf-label">优先级</span>');
    out.push('<span class="pf-group">');
    [['all', '全部'], ['S', 'S'], ['A', 'A'], ['B', 'B']].forEach(function (p) {
      out.push('<button class="seg-btn' + (state.presetPriority === p[0] ? ' active' : '') +
        '" data-act="presetFilterPriority" data-priority="' + p[0] + '">' + p[1] + '</button>');
    });
    out.push('</span>');
    out.push('<span class="hint pf-count">共 ' + total + ' 套 · 显示 ' + shown + ' 套</span>');
    out.push('</div>');
    return out.join('');
  }

  function renderPresetPanel() {
    var out = [];
    var plan = presetPlanForUi();
    out.push('<section class="panel preset-panel">');
    out.push('<div class="panel-head"><h2>⓪ 赛前预选阵容 <span class="stage-sub">先定一套想打的，Ban / Pick 跟着方案走 · 单局设置，不改英雄池</span></h2>');
    out.push('<div class="row gap">');
    if (!plan) {
      out.push('<button class="btn btn-sm btn-blue" data-act="openPresetCustom">自定义核心（1-5 个）</button>');
    }
    out.push('</div></div>');

    if (state.presetsErr) {
      out.push('<div class="notice warn">预选模板不可用：' + esc(state.presetsErr) +
        ' · 仍可用「自定义核心」手动指定 1-5 个核心英雄。</div>');
    }

    if (plan) {
      out.push('<div class="preset-summary">' + presetSummaryHtml(plan, false) + '</div>');
      out.push(presetCoreWarnHtml(plan));
    } else {
      var total = presetTemplates().length;
      if (total) {
        var list = filteredPresets();
        out.push(presetFiltersHtml());
        out.push('<div class="hint" style="margin-bottom:8px">选一套想打的阵容（共 ' + total +
          ' 套 AI 调研组合，按优先级 S→A→B 排序）；不选就按原有「强度 + 克制」推荐。</div>');
        if (list.length) {
          out.push('<div class="preset-cards">' + list.map(presetCardHtml).join('') + '</div>');
        } else {
          out.push('<div class="notice">当前筛选没有组合：换一下「人数 / 优先级」，或点「全部」。</div>');
        }
        out.push('<div class="hint" style="margin-top:8px">也可以自定义 1-5 个核心英雄，由系统推导必 ban、搭配与分工。</div>');
      } else if (!state.presetsErr) {
        out.push('<div class="notice">预选模板加载中…（GET /api/presets）</div>');
      }
    }
    out.push('</section>');
    return out.join('');
  }

  /* AI 调研组合的附加字段渲染（有就展示） */
  function planLanesHtml(plan) {
    var lanes = planField(plan, 'lanes');
    if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) return '';
    var keys = Object.keys(lanes);
    if (!keys.length) return '';
    var out = ['<div class="preset-lanes"><h3>分路</h3><div class="pl-list">'];
    keys.forEach(function (k) {
      var heroes = Array.isArray(lanes[k]) ? lanes[k] : [lanes[k]];
      out.push('<span class="pl-item"><em>' + esc(k) + '</em>' + esc(heroes.filter(Boolean).join(' / ')) + '</span>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  function planFlexHtml(plan) {
    var flex = planField(plan, 'flex');
    if (!flex || typeof flex !== 'object' || Array.isArray(flex)) return '';
    var keys = Object.keys(flex);
    if (!keys.length) return '';
    var out = ['<div class="preset-flex"><h3>可替代件</h3><div class="pfx-list">'];
    keys.forEach(function (k) {
      var alts = Array.isArray(flex[k]) ? flex[k] : [flex[k]];
      out.push('<span class="pfx-item"><b>' + esc(k) + '</b><i>→</i>' + esc(alts.filter(Boolean).join(' / ')) + '</span>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  function planBanTargetsHtml(plan) {
    var arr = planField(plan, 'banTargets');
    if (!Array.isArray(arr) || !arr.length) return '';
    return '<div class="preset-ban-targets"><h3>对面会 ban</h3><div class="pbt-list">' +
      arr.map(function (h) {
        return '<span class="pbt-item">' + avatar(h, 'sm') + '<span>' + esc(h) + '</span></span>';
      }).join('') + '</div></div>';
  }

  function planCounteredByHtml(plan) {
    var arr = planField(plan, 'counteredBy');
    if (!Array.isArray(arr) || !arr.length) return '';
    return '<div class="preset-countered"><h3>被谁克制</h3><div class="pcb-list">' +
      arr.map(function (h) { return '<span class="pcb-item">' + esc(h) + '</span>'; }).join('') + '</div></div>';
  }

  function planEvidenceHtml(plan) {
    var conf = confidenceLabel(planField(plan, 'confidence'));
    var stats = statText(planField(plan, 'stats'));
    var srcs = planField(plan, 'sources');
    var srcArr = Array.isArray(srcs) ? srcs : [];
    if (!conf && !stats && !srcArr.length) return '';
    var out = ['<div class="preset-evidence"><h3>证据 / 样本</h3><div class="pe-line">'];
    if (conf) out.push('<span class="pe-item">可信度 <b>' + esc(conf) + '</b></span>');
    if (stats) out.push('<span class="pe-item">' + esc(stats) + '</span>');
    if (srcArr.length) {
      out.push('<span class="pe-item">来源 ' + srcArr.length + ' 条</span>');
      srcArr.slice(0, 3).forEach(function (u) {
        var url = String(u || '');
        var host = url.replace(/^https?:\/\//, '').split('/')[0];
        if (!host) return;
        out.push('<a class="pe-src" href="' + esc(url) + '" target="_blank" rel="noopener" title="' + esc(url) + '">' + esc(host) + '</a>');
      });
    }
    out.push('</div></div>');
    return out.join('');
  }

  /* 预选方案摘要：Ban 阶段可操作（ro=false），Pick 阶段只读（ro=true） */
  function presetSummaryHtml(plan, ro) {
    if (!plan) return '';
    var isBan = (state.phase === 'ban') && !ro;
    var out = [];

    out.push('<div class="preset-title">');
    var planPrio = presetPriorityOf({ priority: planField(plan, 'priority') });
    if (planPrio) out.push('<span class="ps-prio p-' + esc(planPrio) + '">' + esc(planPrio) + '</span>');
    out.push('<span class="pt-name">' + esc(plan.name || '预选方案') + '</span>');
    var planSize = num(planField(plan, 'size'), 0) || (Array.isArray(plan.core) ? plan.core.length : 0);
    if (planSize) out.push('<span class="pt-size">' + planSize + ' 人</span>');
    if (plan.subtitle) out.push('<span class="pt-sub">' + esc(plan.subtitle) + '</span>');
    if (plan.custom) out.push('<span class="preset-tag pt-custom">自定义</span>');
    var planTags = Array.isArray(plan.tags) ? plan.tags : [];
    planTags.forEach(function (t) { out.push('<span class="tag">' + esc(t) + '</span>'); });
    if (!ro) {
      out.push('<span class="pt-actions">');
      out.push('<button class="btn btn-sm ghost" data-act="clearPreset">换一套</button>');
      out.push('<button class="btn btn-sm ghost" data-act="openPresetCustom">自定义</button>');
      out.push('</span>');
    }
    out.push('</div>');

    /* AI 调研组合：定位 / 强势期 / 结论 */
    var planType = planField(plan, 'type');
    var planPhase = planField(plan, 'phase');
    if (planType || planPhase) {
      out.push('<div class="preset-tags-line">');
      if (planType) out.push('<span class="pt-type">定位：' + esc(planType) + '</span>');
      if (planPhase) out.push('<span class="pt-phase">强势期：' + esc(planPhase) + '</span>');
      out.push('</div>');
    }
    var planWhy = planField(plan, 'why');
    if (planWhy) {
      out.push('<div class="preset-why"><h3>AI 调研结论</h3><span>' + esc(planWhy) + '</span></div>');
    }

    /* 核心 */
    var core = Array.isArray(plan.core) ? plan.core : [];
    if (core.length) {
      out.push('<div class="preset-core">');
      core.forEach(function (c) {
        if (!c || !c.hero) return;
        var cls = PRESET_STATUS_CLS[c.status] || '';
        out.push('<div class="preset-core-item ' + cls + '">');
        out.push(avatar(c.hero, 'md'));
        out.push('<span class="pci-main"><b>' + esc(c.hero) + '</b>' +
          '<span class="pci-meta"><span class="' + tierClass(c.tier) + '">' + esc(c.tier || 'T2') + '</span>' +
          '<em class="pci-lane">' + esc(c.laneLabel || laneLabel(c.lane)) + '</em></span></span>');
        out.push('<span class="pci-status">' + esc(c.statusLabel || c.status || '') + '</span>');
        out.push('<span class="pci-owners">' + presetOwnersHtml(c.owners) + '</span>');
        out.push('</div>');
      });
      out.push('</div>');
    }

    /* 必 ban / 关注 */
    var threats = Array.isArray(plan.threats) ? plan.threats : [];
    if (threats.length) {
      var ordered = threats.filter(function (t) { return t && t.level !== 'watch'; })
        .concat(threats.filter(function (t) { return t && t.level === 'watch'; }));
      out.push('<div class="preset-bans"><h3>必 ban 威胁</h3><ul>');
      ordered.forEach(function (t) {
        if (!t || !t.hero) return;
        var banned = !!t.banned || t.status === 'banned';
        var picked = t.status === 'picked';
        var isWatch = t.level === 'watch';
        out.push('<li class="pb-item' + (banned ? ' done' : '') + (isWatch ? ' watch' : ' must') + '">');
        out.push(avatar(t.hero, 'sm'));
        out.push('<span class="pb-hero">' + esc(t.hero) + '</span>');
        out.push('<span class="' + tierClass(t.tier) + '">' + esc(t.tier || 'T2') + '</span>');
        out.push('<span class="pb-lv ' + (isWatch ? 'watch' : 'must') + '">' + (isWatch ? '提防 / 可 ban' : '必 ban') + '</span>');
        if (isUserThreat(t)) out.push('<span class="pb-src">用户实战</span>');
        out.push('<span class="pb-reason">' + esc(t.reason || '') + '</span>');
        out.push('<span class="pb-state">' + (banned ? '已 ban ✓' : (picked ? '被敌方选走' : '未处理')) + '</span>');
        if (!banned && !picked && isBan) {
          out.push('<button class="btn btn-sm btn-blue" data-act="adoptPresetBan" data-hero="' + esc(t.hero) + '">ban 它</button>');
        }
        out.push('</li>');
      });
      out.push('</ul></div>');
    }

    /* 推荐搭配 */
    var partners = Array.isArray(plan.partners) ? plan.partners : [];
    if (partners.length) {
      out.push('<div class="preset-partners"><h3>推荐搭配</h3><div class="pp-list">');
      partners.forEach(function (x) {
        if (!x || !x.hero) return;
        var st = x.status || 'available';
        out.push('<span class="preset-partner ' + (x.inPool ? 'in-pool' : 'out-pool') + ' st-' + esc(st) + '" title="' + esc(x.note || '') + '">' +
          avatar(x.hero, 'sm') + '<span class="pp-hero">' + esc(x.hero) + '</span>' +
          '<span class="' + tierClass(x.tier) + '">' + esc(x.tier || 'T2') + '</span>' +
          (st === 'picked' ? '<em class="pp-st">已选</em>' : (st === 'banned' ? '<em class="pp-st bad">被 ban</em>' : '')) +
          '</span>');
      });
      out.push('</div>');
      var withOwners = partners.filter(function (x) { return x && x.inPool && Array.isArray(x.owners) && x.owners.length; });
      if (withOwners.length) {
        out.push('<div class="pp-owners"><span class="pp-owners-label">谁打</span>');
        withOwners.forEach(function (x) {
          out.push('<span class="ppo-item"><b>' + esc(x.hero) + '</b>' + presetOwnersHtml(x.owners) + '</span>');
        });
        out.push('</div>');
      }
      out.push('</div>');
    }

    /* AI 调研组合：分路 / 可替代件 / 对面会 ban / 被谁克制 */
    out.push(planLanesHtml(plan));
    out.push(planFlexHtml(plan));
    out.push(planBanTargetsHtml(plan));
    out.push(planCounteredByHtml(plan));

    /* 打法 + 胜负条件 */
    if (plan.playstyle || plan.winCondition) {
      out.push('<div class="preset-playstyle">');
      if (plan.playstyle) {
        out.push('<div class="pp-play"><h3>打法</h3><b>' + esc(plan.playstyle.label || plan.playstyle.key || '—') + '</b>' +
          (plan.playstyle.desc ? '<span>' + esc(plan.playstyle.desc) + '</span>' : '') + '</div>');
      }
      if (plan.winCondition) {
        out.push('<div class="pp-win"><h3>胜负条件</h3><span>' + esc(plan.winCondition) + '</span></div>');
      }
      out.push('</div>');
    }

    /* 队友分工 */
    var teamPlan = Array.isArray(plan.teamPlan) ? plan.teamPlan : [];
    if (teamPlan.length) {
      out.push('<div class="preset-plan"><h3>队友分工</h3><ul>');
      teamPlan.forEach(function (t) {
        if (!t) return;
        out.push('<li><span class="pp-lane">' + esc(t.role || laneLabel(t.lane)) + '</span>' +
          '<span class="pp-ins">' + esc(t.instruction || '') + '</span></li>');
      });
      out.push('</ul></div>');
    }

    /* 进度 */
    out.push('<div class="preset-progress">' + presetProgressHtml(plan) + '</div>');

    var tips = Array.isArray(plan.tips) ? plan.tips : [];
    if (tips.length) {
      out.push('<div class="preset-tips"><h3>执行要点</h3><ul>' + tips.map(function (t) {
        return '<li>' + esc(t) + '</li>';
      }).join('') + '</ul></div>');
    }

    /* 证据 / 样本（AI 调研组合） */
    out.push(planEvidenceHtml(plan));

    var warns = Array.isArray(plan.warnings) ? plan.warnings : [];
    if (warns.length) out.push('<div class="notice warn">' + warns.map(esc).join('<br>') + '</div>');

    return out.join('');
  }

  /* Pick 阶段紧凑条 */
  function renderPresetStrip() {
    var out = [];
    var plan = presetPlanForUi();
    out.push('<section class="panel preset-strip">');
    if (!plan) {
      out.push('<div class="strip-row">');
      out.push('<span class="ps-label">赛前预选</span>');
      out.push('<span class="hint">本局未预选，按强度 / 克制推荐。</span>');
      out.push('</div></section>');
      return out.join('');
    }
    out.push('<div class="strip-row">');
    out.push('<span class="ps-label">赛前预选</span>');
    out.push('<span class="ps-name">' + esc(plan.name || '预选方案') + '</span>');
    if (plan.subtitle) out.push('<span class="hint">' + esc(plan.subtitle) + '</span>');
    out.push('<span class="ps-progress">' + presetProgressHtml(plan) + '</span>');
    out.push('<button class="btn btn-sm' + (state.presetPlanOpen ? ' btn-blue' : ' ghost') + '" data-act="togglePresetPlan">' +
      (state.presetPlanOpen ? '收起方案' : '查看方案') + '</button>');
    out.push('</div>');
    out.push(presetCoreWarnHtml(plan));
    if (state.presetPlanOpen) {
      out.push('<div class="preset-summary readonly">' + presetSummaryHtml(plan, true) + '</div>');
    }
    out.push('</section>');
    return out.join('');
  }

  /* ---- 赛后队伍总体评价（v2.4 · 契约 §4.4） ---- */

  function reviewTone(v) {
    return (v === 'good' || v === 'bad') ? v : 'ok';
  }

  function reviewDimsHtml(dims) {
    if (!Array.isArray(dims) || !dims.length) return '';
    var out = ['<div class="review-dims">'];
    dims.forEach(function (d) {
      if (!d) return;
      var lv = (d.level === 'ok') ? 'ok' : (d.level === 'bad' ? 'bad' : 'warn');
      var mark = (d.level === 'ok') ? '✓' : (d.level === 'bad' ? '✗' : '!');
      var valText = (typeof d.value === 'number') ? (num(d.value) + '/' + num(d.need)) : String(d.value === null || d.value === undefined ? '—' : d.value);
      out.push('<span class="rd ' + lv + '" title="' + esc(d.detail || '') + '"><i>' + mark + '</i>' +
        esc(d.label || d.key || '') + ' <b>' + esc(valText) + '</b></span>');
    });
    out.push('</div>');
    return out.join('');
  }

  function reviewLanesHtml(lanePlan) {
    var lp = lanePlan || {};
    var arr = Array.isArray(lp.assignments) ? lp.assignments : [];
    var uncovered = Array.isArray(lp.uncovered) ? lp.uncovered : [];
    if (!arr.length && !uncovered.length) return '';
    var byLane = {};
    arr.forEach(function (a) { if (a && a.lane) byLane[a.lane] = a; });
    var out = ['<div class="review-lanes"><h3>五路覆盖</h3><div class="rl-grid">'];
    LANE_KEYS.forEach(function (lk) {
      var a = byLane[lk];
      out.push('<span class="rl ' + (a ? 'ok' : 'bad') + '"><em>' + esc(LANES[lk]) + '</em>' +
        (a ? esc(a.hero || '') + (a.playerName ? '<i>' + esc(a.playerName) + '</i>' : '') : '未覆盖') + '</span>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  /* 命中体系（v2.4.2）：每侧最多 3 条，标已成型 / 进行中 + 替代件 */
  function reviewCombosHtml(s) {
    var arr = Array.isArray(s && s.combos) ? s.combos : [];
    var out = ['<div class="review-combos"><h3>命中体系</h3>'];
    if (!arr.length) {
      out.push('<span class="hint">未命中已知体系</span></div>');
      return out.join('');
    }
    out.push('<div class="rc-list">');
    arr.forEach(function (c) {
      if (!c) return;
      var prio = presetPriorityOf({ priority: c.priority });
      var flex = c.flexHit;
      var flexText = '';
      if (Array.isArray(flex) && flex.length) {
        flexText = flex.map(function (f) {
          if (f && typeof f === 'object') return f.hero || f.name || '';
          return String(f || '');
        }).filter(Boolean).join('、');
      } else if (typeof flex === 'string' && flex) flexText = flex;
      else if (typeof flex === 'number' && flex > 0) flexText = flex + ' 处';
      out.push('<span class="rc-item' + (c.complete ? ' complete' : '') + '" title="' +
        esc((c.type || '') + (c.score !== undefined && c.score !== null ? ' · 契合 ' + num(c.score) : '')) + '">');
      if (prio) out.push('<span class="ps-prio p-' + esc(prio) + '">' + esc(prio) + '</span>');
      out.push('<b class="rc-name">' + esc(c.name || c.id || '') + '</b>');
      out.push('<span class="rc-hit">' + num(c.hit) + '/' + num(c.total) + '</span>');
      out.push('<em class="rc-state ' + (c.complete ? 'done' : 'wip') + '">' + (c.complete ? '已成型' : '进行中') + '</em>');
      if (flexText) out.push('<span class="rc-flex">替代：' + esc(flexText) + '</span>');
      out.push('</span>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  function reviewSideHtml(s, isOurs) {
    if (!s) return '';
    var out = [];
    var g = s.grade || {};
    out.push('<div class="review-side ' + (isOurs ? 'ours' : 'theirs') + '">');
    out.push('<div class="rs-head"><span class="rs-side">' + esc(s.label || (isOurs ? '我方' : '敌方')) + '</span>' +
      '<span class="rs-score">' + num(s.score) + '</span>' +
      '<span class="review-grade g-' + reviewTone(g.tone) + '">' +
      esc((g.key || '?') + (g.label ? ' · ' + g.label : '')) + '</span></div>');

    out.push('<div class="rs-meta">');
    if (s.playstyle) out.push('<span class="rs-play">打法：<b>' + esc(s.playstyle.label || '—') + '</b></span>');
    if (s.core && s.core.hero) {
      out.push('<span class="rs-core">核心：<b>' + esc(s.core.hero) + '</b>' +
        (isOurs && s.core.playerName ? '（' + esc(s.core.playerName) +
          (s.core.mastery ? '·' + esc(MASTERY[normalizeMastery(s.core.mastery)].label) : '') + '）' : '') +
        (s.core.tier ? ' <span class="' + tierClass(s.core.tier) + '">' + esc(s.core.tier) + '</span>' : '') + '</span>');
    }
    out.push('</div>');

    var bd = s.breakdown || {};
    out.push('<div class="rs-bd"><span>强度 ' + fx(bd.tier) + '</span><span>结构 ' + fx(bd.structure) +
      '</span><span>配合 ' + fx(bd.synergy) + '</span><span>克制 ' + fx(bd.matchup) + '</span></div>');

    out.push(reviewDimsHtml(s.dimensions));
    out.push(reviewLanesHtml(s.lanePlan));
    out.push(reviewCombosHtml(s));

    var strengths = Array.isArray(s.strengths) ? s.strengths : [];
    var risks = Array.isArray(s.risks) ? s.risks : [];
    out.push('<div class="review-cols">');
    out.push('<div class="review-strengths"><h3>优势</h3><ul>' + (strengths.length
      ? strengths.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
      : '<li class="dim">—</li>') + '</ul></div>');
    out.push('<div class="review-risks"><h3>风险</h3><ul>' + (risks.length
      ? risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
      : '<li class="dim">—</li>') + '</ul></div>');
    out.push('</div>');

    var syn = Array.isArray(s.synergies) ? s.synergies : [];
    if (syn.length) {
      out.push('<div class="review-synergies"><h3>关键配合</h3>' + syn.map(function (x) {
        if (!x) return '';
        return '<span class="rsyn"><b>' + esc(x.a) + ' + ' + esc(x.b) + '</b>' + fx(x.w) +
          (x.note ? '<em>' + esc(x.note) + '</em>' : '') + '</span>';
      }).join('') + '</div>');
    }

    var hs = Array.isArray(s.heroes) ? s.heroes : [];
    if (hs.length) {
      out.push('<div class="rs-heroes">' + hs.map(function (h) {
        return '<span class="rsh">' + avatar(h, 'sm') + '<span>' + esc(h) + '</span></span>';
      }).join('') + '</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  function reviewMatchupHtml(m) {
    if (!m) return '';
    var out = ['<div class="review-matchup">'];
    var edges = Array.isArray(m.edges) ? m.edges : [];
    if (edges.length) {
      out.push('<div class="rm-block"><h3>对位边</h3><ul class="rm-edges">');
      edges.forEach(function (e) {
        if (!e) return;
        var lead = (e.lead === 'ours') ? 'ours' : (e.lead === 'theirs' ? 'theirs' : 'even');
        out.push('<li><span class="re-label">' + esc(e.label || e.key || '') + '</span>' +
          '<b class="re-ours">' + num(e.ours) + '</b><span class="re-vs">vs</span>' +
          '<b class="re-theirs">' + num(e.theirs) + '</b>' +
          '<em class="re-lead ' + lead + '">' + (lead === 'ours' ? '我方' : (lead === 'theirs' ? '敌方' : '持平')) + '</em>' +
          (e.note ? '<span class="re-note">' + esc(e.note) + '</span>' : '') + '</li>');
      });
      out.push('</ul></div>');
    }
    var th = Array.isArray(m.threats) ? m.threats : [];
    if (th.length) {
      out.push('<div class="rm-block"><h3>敌方关键威胁</h3><ul class="rm-threats">');
      th.forEach(function (t) {
        if (!t) return;
        out.push('<li>' + avatar(t.hero, 'sm') + '<b>' + esc(t.hero) + '</b>' +
          '<span class="' + tierClass(t.tier) + '">' + esc(t.tier || 'T2') + '</span>' +
          '<span class="rt-reason">' + esc(t.reason || '') + '</span></li>');
      });
      out.push('</ul></div>');
    }
    var wc = Array.isArray(m.winConditions) ? m.winConditions : [];
    var tips = Array.isArray(m.tips) ? m.tips : [];
    if (wc.length || tips.length) {
      out.push('<div class="rm-block"><h3>胜负手 / 打法要点</h3>');
      if (wc.length) out.push('<ul class="rm-win">' + wc.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      if (tips.length) out.push('<ul class="rm-tips">' + tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
      out.push('</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  function presetMatchHtml(pm) {
    if (!pm || !pm.active) {
      return '<div class="preset-match"><h3>预选完成度</h3><span class="hint">本局未预选方案（按强度 / 克制推荐）。</span></div>';
    }
    var out = ['<div class="preset-match">'];
    out.push('<div class="pm-head"><h3>预选完成度</h3>' +
      '<b class="pm-score">' + ((pm.matchScore === null || pm.matchScore === undefined) ? '—' : num(pm.matchScore)) + '</b>' +
      '<span class="hint">' + esc(pm.name || pm.id || '') + '</span></div>');
    out.push('<div class="pm-stats">' +
      '<span>核心 ' + num(pm.coreHit) + '/' + num(pm.coreTotal) + '</span>' +
      '<span>必 ban ' + num(pm.mustBansDone) + '/' + num(pm.mustBansTotal) + '</span>' +
      '<span>搭配 ' + num(pm.partnerHit) + '/' + num(pm.partnerTotal) + '</span></div>');
    var cs = Array.isArray(pm.coreStatus) ? pm.coreStatus : [];
    if (cs.length) {
      out.push('<div class="pm-core">');
      cs.forEach(function (c) {
        if (!c || !c.hero) return;
        var st = (c.status === 'picked') ? 'ok' : (c.status === 'banned' ? 'bad' : 'warn');
        var label = (c.status === 'picked') ? ('已拿到' + (c.playerName ? ' · ' + c.playerName : ''))
          : (c.status === 'banned' ? '被 ban' : '没拿到');
        out.push('<span class="pm-item ' + st + '">' + esc(c.hero) + '<em>' + esc(label) + '</em></span>');
      });
      out.push('</div>');
    }
    var off = Array.isArray(pm.offPlan) ? pm.offPlan : [];
    if (off.length) {
      out.push('<div class="pm-off">偏出方案：' + off.map(function (h) { return '<b>' + esc(h) + '</b>'; }).join('、') + '</div>');
    }
    var notes = Array.isArray(pm.notes) ? pm.notes : [];
    if (notes.length) {
      out.push('<ul class="pm-notes">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>');
    }
    out.push('</div>');
    return out.join('');
  }

  function renderReviewPanel() {
    var total = allPicked().length;
    var rv = state.review;
    var head = '<div class="panel-head"><h2>队伍总体评价 <span class="stage-sub">BP 结束 · 只基于强度 / 克制 / 配合 / 结构，不预测胜率</span></h2>';

    if (!rv || !rv.done) {
      if (total < 10) return '';
      if (state.reviewErr) {
        return '<section class="panel review-panel">' + head + '</div>' +
          '<div class="notice warn">评价生成失败：' + esc(state.reviewErr) + '</div></section>';
      }
      return '<section class="panel review-panel">' + head + '</div>' +
        '<div class="notice">BP 已结束，但引擎（v2.4 teamReview）还没有返回评价；本局记录仍可正常导出。</div></section>';
    }

    var ours = rv.ours || null;
    var theirs = rv.theirs || null;
    var mk = rv.matchup || {};
    var verdict = mk.verdict || null;

    var out = [];
    out.push('<section class="panel review-panel">');
    out.push(head + '<span class="hint">' + esc(rv.date || '') +
      (rv.side ? ' · 我方' + (rv.side === 'red' ? '红方' : '蓝方') : '') + '</span></div>');

    out.push('<div class="review-verdict v-' + esc(verdict ? (verdict.key || 'even') : 'even') + '">');
    out.push('<b>' + esc(verdict ? (verdict.label || '均势') : '对位结论缺失') + '</b>');
    if (verdict && verdict.note) out.push('<span>' + esc(verdict.note) + '</span>');
    out.push('</div>');

    if (!ours && !theirs) {
      out.push('<div class="notice">评价数据为空（引擎未返回双方阵容）。</div></section>');
      return out.join('');
    }

    out.push('<div class="review-grid">');
    if (ours) out.push(reviewSideHtml(ours, true));
    if (theirs) out.push(reviewSideHtml(theirs, false));
    out.push('</div>');

    out.push(reviewMatchupHtml(mk));
    out.push(presetMatchHtml(rv.preset));

    var rw = Array.isArray(rv.warnings) ? rv.warnings : [];
    if (rw.length) out.push('<div class="notice warn">' + rw.map(esc).join('<br>') + '</div>');

    out.push('</section>');
    return out.join('');
  }

  /* ---- ① Ban 阶段 ---- */

  function banCount() {
    var ours = (state.bans.ours || []).filter(Boolean).length;
    var theirs = (state.bans.theirs || []).filter(Boolean).length;
    return { ours: ours, theirs: theirs };
  }

  function renderBanPhase() {
    var out = [];
    var c = banCount();
    var cmds = (state.banResult && Array.isArray(state.banResult.commands)) ? state.banResult.commands : [];
    var warnings = (state.banResult && Array.isArray(state.banResult.warnings)) ? state.banResult.warnings : [];
    var shortlist = (state.banResult && Array.isArray(state.banResult.shortlist)) ? state.banResult.shortlist : [];

    out.push('<section class="panel stage">');
    out.push('<div class="panel-head"><h2>① Ban 英雄 <span class="stage-sub">每人 1 个 · 同时进行 · 看不到对面 · <b>T0 强度优先</b></span></h2>');
    out.push('<div class="row gap"><span class="hint">我方 ' + c.ours + '/5 · 敌方 ' + c.theirs + '/5</span>');
    out.push('<button class="btn btn-sm" data-act="adoptAllBans">全部采用</button>');
    out.push('<button class="btn btn-sm btn-primary" data-act="enterPick">Ban 完 · 进入 Pick →</button></div></div>');

    out.push('<div class="stage-steps"><span class="ss on">1 · Ban</span><span class="ss">2 · Pick</span></div>');
    out.push('<div class="hint" style="margin:-4px 0 10px">排序规则：先 ban 不在我方池里的 <b>T0</b>（强度权重 10×，克制只做同档内排序），池里已有的不 ban。</div>');

    if (state.banErr) out.push('<div class="notice warn">' + esc(state.banErr) + '</div>');

    /* 5 条 ban 指令 */
    if (cmds.length) {
      out.push('<div class="ban-cmds">');
      cmds.forEach(function (cmd, i) {
        var bd = cmd.breakdown || {};
        var adopted = allBanned().indexOf(cmd.hero) >= 0;
        var isPreset = !!cmd.preset;
        out.push('<div class="ban-card' + (adopted ? ' adopted' : '') + (isPreset ? ' preset' : '') + '">');
        out.push('<div class="bc-top">');
        out.push('<span class="bc-idx">' + (i + 1) + '</span>');
        out.push('<span class="bc-av">' + avatar(cmd.hero, 'md') + '</span>');
        out.push('<span class="bc-hero">' + esc(cmd.hero) + '</span>');
        out.push('<span class="' + tierClass(cmd.tier) + '">' + esc(cmd.tier || 'T2') + '</span>');
        if (isPreset) out.push('<span class="preset-badge">预选必 ban</span>');
        out.push('<span class="bc-score">' + fx(cmd.score) + '</span>');
        out.push('</div>');
        out.push('<div class="bc-bd"><span>强度 ' + fx(bd.tier) + '</span><span>威胁 ' + fx(bd.threat) +
          '</span><span>池脆弱 ' + fx(bd.fragility) + '</span><span>可反制 ' + (bd.answerable ? '是' : '否') + '</span></div>');
        if (cmd.reason) out.push('<div class="bc-reason">' + esc(cmd.reason) + '</div>');
        if (Array.isArray(cmd.alternatives) && cmd.alternatives.length) {
          out.push('<div class="bc-alt">备选：' + cmd.alternatives.map(function (a) {
            return '<span class="chip sm">' + esc(a.hero) + ' ' + fx(a.score) + '</span>';
          }).join('') + '</div>');
        }
        out.push('<button class="btn btn-sm' + (adopted ? ' ghost' : ' btn-blue') + '" data-act="adoptBan" data-hero="' + esc(cmd.hero) + '">' +
          (adopted ? '已 ban' : '采用这个 ban') + '</button>');
        out.push('</div>');
      });
      out.push('</div>');
    } else if (!state.banErr) {
      out.push('<div class="notice">引擎暂无 ban 指令（数据未就绪或池子为空）。可以先到「英雄池」填池。</div>');
    }

    if (warnings.length) out.push('<div class="notice warn">' + warnings.map(esc).join('<br>') + '</div>');

    out.push(renderBanSlots('ours', '我方 Ban（5 个）'));
    out.push(renderBanSlots('theirs', '敌方 Ban（看不到就留空；对面空 ban 也留空）'));

    if (shortlist.length) {
      out.push('<div class="bc-alt" style="margin-bottom:0">全局候选：' + shortlist.map(function (s) {
        return '<span class="chip sm">' + esc(s.hero) + ' ' + fx(s.score) + '</span>';
      }).join('') + '</div>');
    }

    out.push('<div class="stage-foot">');
    out.push('<span class="hint">我方 ' + (c.ours < 5 ? '还差 ' + (5 - c.ours) + ' 个 ban' : '5 个 ban 已齐') +
      '；敌方留空按「空 ban」处理。</span>');
    out.push('<button class="btn btn-primary" data-act="enterPick">Ban 完 · 进入 Pick →</button>');
    out.push('</div>');
    out.push('</section>');
    return out.join('');
  }

  function renderBanSlots(side, title) {
    var arr = (state.bans && state.bans[side]) || [];
    var isEnemy = side === 'theirs';
    var out = [];
    out.push('<div class="ban-slots"><div class="bs-head"><h3>' + esc(title) + '</h3>');
    out.push('<div class="row gap">');
    if (isEnemy) out.push('<button class="btn btn-sm btn-blue" data-act="openBanBulk">一次选 5 个</button>');
    out.push('<button class="btn btn-sm ghost" data-act="clearBans" data-side="' + side + '">清空</button>');
    out.push('</div></div><div class="slots">');
    for (var i = 0; i < 5; i++) {
      var hero = arr[i] || '';
      out.push('<button class="slot' + (hero ? ' filled' : '') + (isEnemy ? ' enemy' : '') + '" data-act="openBanSlot" data-side="' + side + '" data-slot="' + i + '">');
      if (hero) {
        out.push(avatar(hero, 'md'));
        out.push('<span class="slot-hero">' + esc(hero) + '</span>');
        out.push('<span class="slot-x" data-act="clearBan" data-side="' + side + '" data-slot="' + i + '" title="清除">×</span>');
      } else {
        out.push('<span class="slot-empty">' + (isEnemy ? '+ 未知 / 空 ban' : '+ 选择') + '</span>');
      }
      out.push('</button>');
    }
    out.push('</div></div>');
    return out.join('');
  }

  /* ---- Ban 完的缩略条（Pick 阶段顶部） ---- */

  function renderBanStrip() {
    var out = [];
    var ours = (state.bans.ours || []).filter(Boolean);
    var theirs = (state.bans.theirs || []).filter(Boolean);
    out.push('<section class="panel ban-strip">');
    out.push('<div class="strip-row"><span class="strip-label ours">我方 Ban</span><div class="strip-list">');
    if (!ours.length) out.push('<span class="hint">无</span>');
    ours.forEach(function (h) { out.push('<span class="strip-chip">' + avatar(h, 'sm') + '<span>' + esc(h) + '</span></span>'); });
    out.push('</div></div>');
    out.push('<div class="strip-row"><span class="strip-label theirs">敌方 Ban</span><div class="strip-list">');
    if (!theirs.length) out.push('<span class="chip sm">空 ban / 未知</span>');
    theirs.forEach(function (h) { out.push('<span class="strip-chip enemy">' + avatar(h, 'sm') + '<span>' + esc(h) + '</span></span>'); });
    out.push('</div>');
    out.push('<button class="btn btn-sm ghost" data-act="backBan">← 返回 Ban 阶段</button>');
    out.push('</div></section>');
    return out.join('');
  }

  /* ---- ② Pick 阶段 ---- */

  function renderPickPhase() {
    var step = currentStepInfo();
    var phase = phaseInfo(step);
    var out = [];
    out.push('<div class="bp-head">');
    if (step) {
      var ourNo = ((state.picks[storeSide()]) || []).length + 1;
      out.push('<div class="step-pill">第 ' + (step.index + 1) + '/10 手 · <b class="' + (step.isOurs ? 'ours' : 'theirs') + '">' +
        (step.isOurs ? '我方第 ' + ourNo + ' 手' : '敌方选人') + '</b>' +
        (phase && phase.key !== 'enemy' ? ' · ' + phaseBadge(phase) + ' ' + esc(phase.hint) : '') + '</div>');
    } else {
      out.push('<div class="step-pill done">10 手已选完 · 去「导出」生成 BP 文本</div>');
    }
    out.push('<div class="row gap">');
    out.push('<button class="btn btn-sm ghost" data-act="undoPick">撤销上一手</button>');
    out.push('<button class="btn btn-sm danger" data-act="resetBp">重置本局</button>');
    out.push('</div></div>');

    out.push('<div class="bp-grid"><div class="bp-main">');
    out.push(renderPickSection(step, phase));
    out.push('</div><aside class="bp-side">');
    out.push(renderLineup());
    out.push('</aside></div>');
    return out.join('');
  }

  function renderPickSection(step, phase) {
    var out = [];
    var oursSide = storeSide();
    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>② Pick 英雄' + (step ? '' : ' · 完成') + '</h2><span class="hint">' +
      (step ? (step.isOurs ? '候选来自全队英雄池，点卡直接选' : '轮到敌方，点英雄录入（或留空跳过）') : '已完成') + '</span></div>');

    if (state.pickErr) out.push('<div class="notice warn">' + esc(state.pickErr) + '</div>');

    out.push('<div class="picked">');
    out.push(renderPickedCol('blue', state.picks.blue, oursSide === 'blue'));
    out.push(renderPickedCol('red', state.picks.red, oursSide === 'red'));
    out.push('</div>');

    if (!step) {
      out.push('<div class="notice ok">10 手已选完，去「导出」生成 BP 文本并下载 JSON。</div>');
      out.push('</section>');
      return out.join('');
    }

    if (step.isOurs) out.push(renderOurCandidates(step, phase));
    else out.push(renderEnemyInput(step));

    out.push('</section>');
    return out.join('');
  }

  /* 全队里谁能打这个英雄（按熟练度从高到低） */
  function ownersOf(hero) {
    var out = [];
    players().forEach(function (p, k) {
      var m = masteryOf(p, hero);
      if (m) out.push({ playerIndex: k, name: p.name, mastery: m });
    });
    out.sort(function (a, b) { return MASTERY_ORDER.indexOf(a.mastery) - MASTERY_ORDER.indexOf(b.mastery); });
    return out;
  }

  function ownersInline(hero) {
    var os = ownersOf(hero);
    if (!os.length) return '<span class="pool-out">池外</span>';
    return os.map(function (o) {
      return '<span class="owner-chip"><b>' + esc(o.name) + '</b>' + masteryBadge(o.mastery) + '</span>';
    }).join('');
  }

  function ownersPlain(hero) {
    var os = ownersOf(hero);
    if (!os.length) return '池外';
    return os.map(function (o) { return o.name + '（' + MASTERY[o.mastery].label + '）'; }).join('/');
  }

  /* v2.3：我方已选英雄 → 由哪个玩家去打（一人一个） */
  function assignmentMap() {
    var pr = state.pickResult;
    var arr = (pr && Array.isArray(pr.assignment)) ? pr.assignment : [];
    var m = {};
    arr.forEach(function (a) { if (a && a.hero) m[a.hero] = a; });
    return m;
  }

  function freePlayersList() {
    var pr = state.pickResult;
    if (pr && Array.isArray(pr.freePlayers)) return pr.freePlayers;
    var used = {};
    assignmentMap();
    var am = assignmentMap();
    Object.keys(am).forEach(function (h) { used[am[h].playerIndex] = true; });
    return players().map(function (p, i) { return { playerIndex: i, name: p.name }; })
      .filter(function (p) { return !used[p.playerIndex]; });
  }

  function renderPickedCol(side, arr, isOurs) {
    arr = arr || [];
    var out = [];
    var am = isOurs ? assignmentMap() : {};
    out.push('<div class="picked-col ' + side + '"><h3>' + (side === 'blue' ? '蓝方' : '红方') + ' 已选' + (isOurs ? '（我方）' : '') + '</h3><div class="picked-list">');
    if (!arr.length) out.push('<span class="empty">暂无</span>');
    else arr.forEach(function (n, i) {
      var sub;
      if (isOurs) {
        var a = am[n];
        sub = '我方第' + (i + 1) + '手' + (a ? ' → ' + a.playerName + '（' + (MASTERY[a.mastery] ? MASTERY[a.mastery].label : '正常') + '）' + (a.manual ? ' ·手动' : '') : '');
      } else {
        sub = '敌方第' + (i + 1) + '手';
      }
      out.push('<span class="pick-card ' + side + '"' +
        (isOurs ? ' data-act="assignHero" data-hero="' + esc(n) + '" title="点击指定由谁玩"' : '') + '>' + avatar(n, 'sm') +
        '<span class="pk-main"><b>' + esc(n) + '</b><em title="' + esc(sub) + '">' + esc(sub) + '</em></span>' +
        '<span class="' + tierClass(tierOf(n)) + '">' + esc(tierOf(n)) + '</span></span>');
    });
    out.push('</div></div>');
    return out.join('');
  }

  /* 全队池并集里还没被 ban/选的英雄（v2.1：不再按楼层过滤） */
  function unionPoolHeroes() {
    var seen = {}, out = [];
    players().forEach(function (p) {
      poolEntries(p).forEach(function (e) {
        if (!e || !e.hero || seen[e.hero] || isTaken(e.hero)) return;
        seen[e.hero] = true;
        out.push(e.hero);
      });
    });
    return out;
  }

  function openLaneLabels() {
    var pr = state.pickResult;
    if (pr && pr.laneState && Array.isArray(pr.laneState.open)) return pr.laneState.open;
    var lc = state.lineup;
    if (lc && lc.lanePlan && Array.isArray(lc.lanePlan.uncovered)) return lc.lanePlan.uncovered;
    return [];
  }

  function renderOurCandidates(step, phase) {
    var out = [];
    var cands = (state.pickResult && Array.isArray(state.pickResult.candidates)) ? state.pickResult.candidates : [];
    var warnings = (state.pickResult && Array.isArray(state.pickResult.warnings)) ? state.pickResult.warnings : [];
    var union = unionPoolHeroes();
    var openLanes = openLaneLabels();
    var free = freePlayersList();

    out.push('<div class="cand-head">');
    out.push('<div class="cand-owner">' + phaseBadge(phase) + ' <b>' + esc(phase ? phase.hint : '按强度优先') + '</b>' +
      '<span class="hint"> · 待补：' + (openLanes.length ? esc(openLanes.join('/')) : '五路已齐') +
      ' · 待上场：' + (free.length ? esc(free.map(function (p) { return p.name; }).join('/')) : '无') +
      ' · 只列「剩余队友能打 + 能补待补分路」的英雄</span></div>');
    out.push('<button class="btn btn-sm ghost" data-act="openPickOurs">池外指定…</button>');
    out.push('</div>');

    if (warnings.length) out.push('<div class="notice warn">' + warnings.map(esc).join('<br>') + '</div>');

    if (cands.length) {
      out.push('<div class="cands">');
      cands.slice(0, 6).forEach(function (c) {
        var bd = c.breakdown || {};
        var m = c.mastery || 'normal';
        var owners = (Array.isArray(c.owners) && c.owners.length) ? c.owners : ownersOf(c.hero);
        var pt = c.preset || null;
        var ptHtml = (pt && pt.role) ? '<span class="preset-tag pt-' + esc(pt.role) + '" title="' + esc(pt.note || '') + '">' +
          esc(pt.label || PRESET_ROLE_LABEL[pt.role] || '预选') + '</span>' : '';
        out.push('<div class="cand" data-act="pickHero" data-hero="' + esc(c.hero) + '" role="button" tabindex="0">');
        out.push('<span class="cand-av">' + avatar(c.hero, 'lg') + '</span>');
        out.push('<span class="cand-body">');
        out.push('<span class="cand-line"><b class="cand-hero">' + esc(c.hero) + '</b>' +
          '<span class="' + tierClass(c.tier) + '">' + esc(c.tier || 'T2') + '</span>' +
          masteryBadge(m) + phaseBadge(phase) + ptHtml + '<span class="cand-tags">' + tagsHtml(c.hero, { lanes: true }) + '</span></span>');
        var at = c.assignedTo || null;
        var otherFielders = Array.isArray(c.fielders)
          ? c.fielders.filter(function (f) { return !at || f.playerIndex !== at.playerIndex; })
          : [];
        out.push('<span class="cand-assign">' + (at
          ? '谁打：<b>' + esc(at.name) + '</b>' + masteryBadge(at.mastery) + (at.manual ? '<span class="manual-tag">手动</span>' : '')
          : '谁打：' + (Array.isArray(c.owners) && c.owners.length ? '由 ' + esc(c.owners[0].name) + ' 打' : '<span class="pool-out">池外</span>')) +
          (otherFielders.length ? '<span class="hint">（可换：' + esc(otherFielders.map(function (f) { return f.name; }).join('/')) + '）</span>' : '') +
          '<button class="btn btn-sm ghost cand-swap" data-act="assignHero" data-hero="' + esc(c.hero) + '">换人</button>' +
          '</span>');
        out.push('<span class="cand-reason">' + esc(c.reason || '') + '</span>');
        out.push('<span class="cand-bd">');
        [['强度', bd.tier], ['克制', bd.counter], ['被克', bd.countered], ['配合', bd.synergy],
          ['补缺口', bd.compNeed], ['补分路', bd.laneNeed], ['熟练', bd.mastery], ['预选', bd.preset], ['组合', bd.combo]].forEach(function (pair) {
          if (pair[1] === undefined || pair[1] === null) return;
          if ((pair[0] === '预选' || pair[0] === '组合') && !num(pair[1], 0)) return;
          out.push('<span>' + pair[0] + ' ' + fx(pair[1]) + '</span>');
        });
        out.push('</span></span>');
        out.push('<span class="cand-score">' + fx(c.score) + '</span>');
        out.push('</div>');
      });
      out.push('</div>');
    } else {
      var avail = union.slice().sort(function (a, b) { return tierScore(b) - tierScore(a); });
      out.push('<div class="notice">引擎未给出候选' + (state.pickErr ? '' : '（池子可能已被 ban 空）') + '。全队池内可用：</div>');
      if (avail.length) {
        out.push('<div class="cands">');
        avail.forEach(function (hero) {
          var os = ownersOf(hero);
          out.push('<button class="cand" data-act="pickHero" data-hero="' + esc(hero) + '">' +
            '<span class="cand-av">' + avatar(hero, 'lg') + '</span>' +
            '<span class="cand-body"><span class="cand-line"><b class="cand-hero">' + esc(hero) + '</b>' +
            '<span class="' + tierClass(tierOf(hero)) + '">' + esc(tierOf(hero)) + '</span>' + phaseBadge(phase) + '</span>' +
            '<span class="cand-assign">谁打：' + (os.length ? '<b>' + esc(os[0].name) + '</b>' + masteryBadge(os[0].mastery) : '<span class="pool-out">池外</span>') + '</span>' +
            '<span class="cand-reason">池内英雄 · 无引擎评分</span></span><span class="cand-score">—</span></button>');
        });
        out.push('</div>');
      } else {
        out.push('<div class="notice warn">全队池没有可用英雄：去「英雄池」补池，或用「池外指定…」从全英雄里选。</div>');
      }
    }
    return out.join('');
  }

  function enemyFilteredHeroes() {
    var list = heroesForFilter(state.enemyLane, 'all');
    var q = (state.enemyQuery || '').trim();
    if (q) list = list.filter(function (h) { return matchesQuery(h, q); });
    list = list.filter(function (h) { return !isTaken(h.name); });
    return list.slice().sort(function (a, b) {
      var d = tierScore(b.name) - tierScore(a.name);
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
    });
  }

  function enemyListHtml() {
    var list = enemyFilteredHeroes().slice(0, 60);
    if (!list.length) return '<span class="hint">没有匹配的英雄</span>';
    return list.map(function (h) {
      return '<button class="eh" data-act="pickHero" data-hero="' + esc(h.name) + '">' + avatar(h.name) +
        '<span class="eh-name">' + esc(h.name) + '</span><span class="' + tierClass(tierOf(h.name)) + '">' + esc(tierOf(h.name)) + '</span></button>';
    }).join('');
  }

  function enemyFilterChips() {
    var out = [];
    out.push('<button class="seg-btn' + (state.enemyLane === 'all' ? ' active' : '') + '" data-act="enemyFilter" data-lane="all">全部分路</button>');
    LANE_KEYS.forEach(function (lk) {
      out.push('<button class="seg-btn' + (state.enemyLane === lk ? ' active' : '') + '" data-act="enemyFilter" data-lane="' + lk + '">' + esc(LANES[lk]) + '</button>');
    });
    return '<div class="filters">' + out.join('') + '</div>';
  }

  function renderEnemyInput(step) {
    var out = [];
    var q = state.enemyQuery || '';
    out.push('<div class="row gap" style="margin-bottom:8px"><span class="hint">敌方第 ' +
      (((state.picks[storeSide() === 'blue' ? 'red' : 'blue']) || []).length + 1) + ' 手 · 点英雄卡片录入（不用键盘）；看不到就点「跳过」。</span>' +
      '<button class="btn btn-sm ghost" data-act="skipEnemy">跳过这一手</button>' +
      '<button class="btn btn-sm ghost" data-act="openPickEnemy">全部英雄…</button></div>');
    out.push('<div class="search-row"><input class="input" id="enemyQuery" data-act="enemyQuery" value="' + esc(q) +
      '" placeholder="搜敌方英雄（也可以完全不用键盘，用下面的分类标签筛）…" autocomplete="off"></div>');
    out.push(enemyFilterChips());
    out.push('<div class="enemy-grid" id="enemyList">' + enemyListHtml() + '</div>');
    return out.join('');
  }

  function updateEnemyList() {
    var box = $id('enemyList');
    if (box) box.innerHTML = enemyListHtml();
  }

  /* ---- 阵容体检 ---- */

  function renderLineup() {
    var out = [];
    out.push('<section class="panel lineup"><div class="panel-head"><h2>阵容体检</h2><span class="hint">实时</span></div>');
    if (state.lineupErr) out.push('<div class="notice warn">' + esc(state.lineupErr) + '</div>');

    var lc = state.lineup;
    if (!lc) {
      out.push('<div class="notice">' + esc(NOT_READY) + '</div></section>');
      return out.join('');
    }

    /* 五路覆盖 */
    var plan = lc.lanePlan || {};
    var assign = Array.isArray(plan.assignments) ? plan.assignments : [];
    var byLane = {};
    assign.forEach(function (a) { byLane[a.lane] = a; });
    var ourPicked = ((state.picks[storeSide()]) || []).length;
    var idle = ourPicked === 0;
    out.push('<h3>五路覆盖</h3><ul class="lane-plan">');
    LANE_KEYS.forEach(function (lk) {
      var a = byLane[lk];
      var cls = a ? 'ok' : (idle ? 'idle' : 'bad');
      out.push('<li class="' + cls + '"><span class="lp-lane">' + esc(LANES[lk]) + '</span>' +
        (a ? '<span class="lp-hero">' + avatar(a.hero, 'sm') + esc(a.hero) + '</span><span class="lp-who">' + esc(a.playerName || '') + '</span>' :
          '<span class="lp-hero empty">' + (idle ? '待选' : '未覆盖') + '</span><span class="lp-who"></span>') + '</li>');
    });
    out.push('</ul>');

    /* 各路池子可用性（我方还能不能选出这条路的英雄） */
    var laneSurv = Array.isArray(lc.laneSurvival) ? lc.laneSurvival : [];
    if (laneSurv.length) {
      out.push('<h3>各路池子可用</h3><ul class="lane-surv">');
      laneSurv.forEach(function (s) {
        out.push('<li class="' + (s.atRisk ? 'bad' : '') + '"><span class="ls-lane">' + esc(s.laneLabel || laneLabel(s.lane)) + '</span>' +
          '<span class="ls-depth">' + num(s.poolDepth) + ' 个' + (s.atRisk ? ' · 偏薄' : '') + '</span>' +
          '<span class="ls-owners">' + ((s.owners || []).length ? esc((s.owners || []).join('/')) : '—') + '</span></li>');
      });
      out.push('</ul>');
    }

    var checks = Array.isArray(lc.checks) ? lc.checks : [];
    if (checks.length) {
      out.push('<h3>阵容结构</h3><ul class="checks">');
      checks.forEach(function (c) {
        out.push('<li class="' + (c.ok ? 'ok' : 'bad') + '">');
        out.push('<span class="ck">' + (c.ok ? '✓' : '✗') + '</span>');
        out.push('<span class="cl">' + esc(c.label || c.key || '') + '</span>');
        out.push('<span class="cv">' + esc(String(c.value)) + ' / ' + esc(String(c.need)) + '</span>');
        out.push('<span class="cn" title="' + esc(c.note || '') + '">' + esc(c.note || '') + '</span>');
        out.push('</li>');
      });
      out.push('</ul>');
    }

    var surv = Array.isArray(lc.survival) ? lc.survival : [];
    if (surv.length) {
      out.push('<h3>每人池子存活</h3><ul class="surv">');
      surv.forEach(function (s) {
        var pct = Math.max(0, Math.min(100, Math.round(num(s.ratio) * 100)));
        var mc = s.masteryAlive || {};
        out.push('<li><span class="sl">' + num(s.floor) + '楼 ' + esc(s.name) + '</span>' +
          '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="sv">' + num(s.alive) + '/' + num(s.total) + '</span></li>');
        out.push('<li class="sub"><span class="sl"></span><span class="sv" style="grid-column:2 / -1">绝 ' +
          num(mc.best) + ' · 常 ' + num(mc.normal) + ' · 会 ' + num(mc.basic) + '</span></li>');
      });
      out.push('</ul>');
    }

    var gaps = Array.isArray(lc.gaps) ? lc.gaps : [];
    // 五路覆盖已在上面单独展示，这里只保留阵容结构类缺口，避免「缺对抗路…」重复刷屏
    var laneGapRe = /^缺(对抗路|打野|中路|发育路|游走)$/;
    var structGaps = gaps.filter(function (g) { return !laneGapRe.test(String(g)); });
    out.push('<div class="gaps">');
    if (structGaps.length) structGaps.forEach(function (g) { out.push('<span class="chip bad">' + esc(g) + '</span>'); });
    else out.push('<span class="chip ok">结构无缺口</span>');
    out.push('</div>');
    out.push('</section>');
    return out.join('');
  }

  /* ================= BP 动作 ================= */

  function markStoreDirty() {
    state.storeDirty = true;
    state.saveState = '有未保存修改';
    var el = $id('saveState');
    if (el) el.textContent = state.saveState;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { saveStore(true); }, 700);
  }

  function saveStore(quiet) {
    if (!state.store) state.store = defaultStore();
    state.store = normalizeStore(state.store);
    return api('PUT', '/api/store', state.store).then(function () {
      state.storeDirty = false;
      state.storeErr = null;
      state.saveState = '已自动保存 ' + timeLabel();
      var el = $id('saveState');
      if (el) el.textContent = state.saveState;
      if (!quiet) toast('已保存到服务端', 'ok');
      renderHeader();
    }).catch(function (e) {
      state.saveState = '保存失败：' + msgOf(e);
      var el = $id('saveState');
      if (el) el.textContent = state.saveState;
      toast('保存失败：' + msgOf(e), 'bad');
    });
  }

  function timeLabel() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function setSide(side) {
    if (!state.store) state.store = defaultStore();
    state.store.side = side === 'red' ? 'red' : 'blue';
    markStoreDirty();
    recompute();
    renderAll();
  }

  function togglePreferLane(idx, lane) {
    var p = players()[idx];
    if (!p) return;
    if (LANE_KEYS.indexOf(lane) < 0) return;
    var arr = p.preferLanes || (p.preferLanes = []);
    var i = arr.indexOf(lane);
    if (i >= 0) arr.splice(i, 1);
    else {
      if (arr.length >= 2) arr.shift();
      arr.push(lane);
    }
    markStoreDirty();
    recompute();
    renderAll();
  }

  function enterPickPhase() {
    var c = banCount();
    if (c.ours < 5) {
      if (!window.confirm('我方还有 ' + (5 - c.ours) + ' 个 ban 没填，确定进入 Pick 阶段？（之后还能返回 Ban 阶段补）')) return;
    }
    state.phase = 'pick';
    persist();
    renderAll();
    toast('已进入 Pick 阶段' + (c.theirs < 5 ? '（敌方 ' + (5 - c.theirs) + ' 个按空 ban 处理）' : ''), 'ok');
  }

  function backToBan() {
    state.phase = 'ban';
    persist();
    renderAll();
  }

  function adoptBan(hero) {
    if (!hero) return;
    if (allBanned().indexOf(hero) >= 0) { toast('「' + hero + '」已经 ban 过了'); return; }
    var arr = state.bans.ours;
    for (var i = 0; i < 5; i++) {
      if (!arr[i]) {
        arr[i] = hero;
        persist(); recompute(); renderAll();
        toast('我方 ban：' + hero, 'ok');
        return;
      }
    }
    toast('我方 5 个 ban 位已满，先清空一个', 'bad');
  }

  /* ---- 赛前预选动作（v2.4） ---- */

  function usePreset(id) {
    if (!id) return;
    var tpl = findPresetTemplate(id);
    if (!tpl) { toast('没有这套预选模板', 'bad'); return; }
    state.preset = { id: id };
    state.presetPlanOpen = false;
    persist(); recompute(); renderAll();
    toast('已选预选方案：' + (tpl.name || id) + ' · Ban 优先 ban 必 ban 名单', 'ok');
  }

  function clearPreset() {
    state.preset = null;
    state.presetPlanOpen = false;
    persist(); recompute(); renderAll();
    toast('已清除预选，按强度 / 克制推荐', 'ok');
  }

  function openPresetCustom() {
    var p = state.preset;
    var sel = (p && Array.isArray(p.core)) ? p.core.slice(0, 5) : [];
    openPicker({ kind: 'presetCore', multi: true, max: 5, sel: sel });
  }

  function adoptPresetBan(hero) {
    if (!hero) return;
    if (allBanned().indexOf(hero) >= 0) { toast('「' + hero + '」已经 ban 过了'); return; }
    var arr = state.bans.ours;
    for (var i = 0; i < 5; i++) {
      if (!arr[i]) {
        arr[i] = hero;
        persist(); recompute(); renderAll();
        toast('预选必 ban：已执行 ban ' + hero, 'ok');
        return;
      }
    }
    toast('我方 5 个 ban 位已满，先清空一个', 'bad');
  }

  function adoptAllBans() {
    var cmds = (state.banResult && Array.isArray(state.banResult.commands)) ? state.banResult.commands : [];
    if (!cmds.length) { toast('没有可采用的 ban 指令', 'bad'); return; }
    var arr = state.bans.ours;
    var added = 0;
    for (var i = 0; i < 5; i++) {
      if (arr[i]) continue;
      for (var j = 0; j < cmds.length; j++) {
        var h = cmds[j].hero;
        if (!h || allBanned().indexOf(h) >= 0) continue;
        arr[i] = h;
        added++;
        break;
      }
    }
    persist(); recompute(); renderAll();
    toast(added ? ('已采用 ' + added + ' 个 ban') : '没有可新增的 ban 位', added ? 'ok' : '');
  }

  function openBanSlot(side, slot) {
    state.picker = {
      kind: side === 'theirs' ? 'banTheirs' : 'banOurs',
      slot: num(slot), query: '', lane: 'all', type: 'all',
      sel: (state.bans[side] && state.bans[side][num(slot)]) ? [state.bans[side][num(slot)]] : []
    };
    renderModal();
  }

  function doPick(side, hero) {
    if (!hero) return;
    if (isTaken(hero)) { toast('「' + hero + '」已被 ban 或已选', 'bad'); return; }
    if (allPicked().length >= 10) { toast('10 手已选完', 'bad'); return; }

    var step = currentStepInfo();
    var idx = step ? step.index : allPicked().length;
    if (step && step.side !== side) side = step.side;   // 以当前手为准

    /* v2.1：不再按楼层归属。池外指定允许，但提示一下，避免选了没人会玩的英雄 */
    if (side === storeSide()) {
      var os = ownersOf(hero);
      if (!os.length) toast('注意：' + hero + ' 不在任何队友的英雄池里（按临时指定处理）', 'bad');
    }

    var cands = (state.pickResult && Array.isArray(state.pickResult.candidates)) ? state.pickResult.candidates : [];
    if (cands.length) {
      state.recs = (state.recs || []).filter(function (r) { return r && r.index !== idx; });
      state.recs.push({
        index: idx, side: side,
        pickNo: (state.picks[side] || []).length + 1,
        phase: (state.pickResult && state.pickResult.phase) ? state.pickResult.phase.key : null,
        heroes: cands.slice(0, 3).map(function (c) { return { hero: c.hero, score: c.score, tier: c.tier }; })
      });
    }

    state.picks[side].push(hero);
    state.enemyQuery = '';
    persist();
    recompute();
    renderAll();

    var ns = currentStepInfo();
    if (ns) {
      var np = phaseInfo(ns);
      var tip = np && np.key !== 'enemy' ? ' · ' + np.label + '（' + np.hint + '）' : '';
      toast('已录入 ' + hero + ' · 下一手：' + (ns.isOurs ? '我方第 ' + (((state.picks[storeSide()]) || []).length + 1) + ' 手' : '敌方') + tip, 'ok');
    } else {
      toast('10 手已选完，可去「导出」生成 BP 文本', 'ok');
    }
  }

  function skipEnemy() {
    var step = currentStepInfo();
    if (!step || step.isOurs) return;
    var placeholder = '空' + (step.index + 1);
    state.picks[step.side].push(placeholder);
    persist();
    recompute();
    renderAll();
    toast('已跳过这一手（记为「' + placeholder + '」）');
  }

  function undoPick() {
    var total = allPicked().length;
    if (!total) { toast('还没有选人记录'); return; }
    var side = PICK_SEQUENCE[total - 1] === 'B' ? 'blue' : 'red';
    var hero = state.picks[side].pop();
    if (hero && state.assignments) delete state.assignments[hero];
    state.recs = (state.recs || []).filter(function (r) { return r && r.index !== total - 1; });
    persist(); recompute(); renderAll();
    toast('已撤销 ' + (hero || '上一手'), 'ok');
  }

  function resetBp() {
    if (!window.confirm('确定重置本局 BP（清空双方 ban 与 pick，回到 Ban 阶段）？')) return;
    state.bans = { ours: ['', '', '', '', ''], theirs: ['', '', '', '', ''] };
    state.picks = { blue: [], red: [] };
    state.recs = [];
    state.assignments = {};
    state.enemyQuery = '';
    state.phase = 'ban';
    persist(); recompute(); renderAll();
    toast('已重置本局', 'ok');
  }

  /* ================= 补池建议动作 ================= */

  function runAdvice() {
    if (state.adviceBusy) return;
    state.adviceBusy = true;
    state.adviceErr = null;
    renderView();
    var ctx = buildCtx();
    var E = window.HOKEngine;
    if (!E || typeof E.analyzePool !== 'function') {
      state.adviceBusy = false;
      state.adviceErr = '引擎未就绪，无法生成补池建议';
      renderView();
      return;
    }
    var res;
    try { res = E.analyzePool(ctx); } catch (e) {
      state.adviceBusy = false;
      state.adviceErr = '补池建议失败：' + msgOf(e);
      renderView();
      return;
    }
    state.advice = res;
    state.adviceBusy = false;
    renderView();
  }

  function adviceAdd(sidx, pidx) {
    var adv = state.advice;
    if (!adv) return;
    var list = dedupeSuggestions(Array.isArray(adv.suggestions) ? adv.suggestions : []);
    var g = list[num(sidx)];
    if (!g) return;
    var p = players()[num(pidx)];
    if (!p) return;
    if (poolHeroes(p).indexOf(g.hero) >= 0) { toast('「' + g.hero + '」已在 ' + p.name + ' 的池里'); return; }
    addToPool(p, g.hero, 'normal');
    markStoreDirty();
    recompute();
    var E = window.HOKEngine;
    if (E && typeof E.analyzePool === 'function') {
      try { state.advice = E.analyzePool(buildCtx()); } catch (e) { state.advice = null; }
    }
    renderView();
    toast('已加入 ' + p.name + ' 的英雄池（默认「正常」，可在池子里改熟练度）', 'ok');
  }

  /* ================= 梯度页 ================= */

  function tierTableHtml() {
    var tiers = (state.meta && state.meta.tiers) || {};
    var hs = heroes();
    if (!hs.length) return '<div class="notice">' + NOT_READY + '</div>';

    var rows = hs.map(function (h) {
      var t = tiers[h.name] || {};
      return {
        hero: h.name, lane: heroLaneText(h), types: heroTypes(h).join('/'),
        tier: t.tier || 'T2', score: num(t.score, 0),
        winRate: t.winRate, pickRate: t.pickRate, banRate: t.banRate, has: !!tiers[h.name]
      };
    });
    rows.sort(function (a, b) {
      var d = b.score - a.score;
      return d !== 0 ? d : a.hero.localeCompare(b.hero, 'zh');
    });

    var q = (state.tierQuery || '').trim();
    var filtered = rows.filter(function (r) {
      if (state.tierFilter !== 'all' && r.tier !== state.tierFilter) return false;
      if (q && r.hero.indexOf(q) < 0) return false;
      return true;
    });

    var html = ['<div class="table-wrap"><table class="grid"><thead><tr><th>英雄</th><th>分路</th><th>类型</th><th>T 度</th>' +
      '<th class="num">分数</th><th class="num">胜率</th><th class="num">出场</th><th class="num">禁用</th></tr></thead><tbody>'];
    filtered.forEach(function (r) {
      html.push('<tr>' +
        '<td class="hero"><span class="cell-hero">' + avatar(r.hero) + esc(r.hero) + '</span>' + (r.has ? '' : ' <span class="chip sm">缺数据</span>') + '</td>' +
        '<td>' + esc(r.lane) + '</td>' +
        '<td>' + esc(r.types) + '</td>' +
        '<td><span class="' + tierClass(r.tier) + '">' + esc(r.tier) + '</span></td>' +
        '<td class="num">' + (r.has ? fx(r.score, 1) : '—') + '</td>' +
        '<td class="num">' + (r.winRate === undefined || r.winRate === null ? '—' : fx(r.winRate, 1) + '%') + '</td>' +
        '<td class="num">' + (r.pickRate === undefined || r.pickRate === null ? '—' : fx(r.pickRate, 1) + '%') + '</td>' +
        '<td class="num">' + (r.banRate === undefined || r.banRate === null ? '—' : fx(r.banRate, 1) + '%') + '</td>' +
        '</tr>');
    });
    html.push('</tbody></table></div>');
    html.push('<div class="hint" style="margin-top:6px">显示 ' + filtered.length + ' / ' + rows.length + ' 条</div>');
    return html.join('');
  }

  function updateTierTable() {
    var w = $id('tierTableWrap');
    if (w) w.innerHTML = tierTableHtml();
  }

  function renderTiers() {
    var out = [];
    out.push(notices(''));
    var tiers = (state.meta && state.meta.tiers) || {};
    var total = heroes().length;
    var covered = 0;
    heroes().forEach(function (h) { if (tiers[h.name]) covered++; });

    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>T 度总览</h2><span class="hint">' +
      (state.meta ? ('数据版本 ' + esc(state.meta.version || '—') + ' · 覆盖 ' + covered + '/' + total + ' 英雄') : esc(NOT_READY)) + '</span></div>');
    out.push('<div class="filters">');
    out.push('<button class="seg-btn' + (state.tierFilter === 'all' ? ' active' : '') + '" data-act="tierFilter" data-tier="all">全部</button>');
    TIERS.forEach(function (t) {
      out.push('<button class="seg-btn' + (state.tierFilter === t ? ' active' : '') + '" data-act="tierFilter" data-tier="' + t + '">' + t + '</button>');
    });
    out.push('<input class="input" style="max-width:210px;min-height:34px" data-act="tierQuery" value="' + esc(state.tierQuery) +
      '" placeholder="搜索英雄…" autocomplete="off">');
    out.push('</div>');
    out.push('<div id="tierTableWrap">' + tierTableHtml() + '</div>');
    out.push('</section>');

    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>粘贴导入 T 度</h2><span class="hint">改 meta.tiers → PUT /api/meta</span></div>');
    out.push('<div class="hint" style="margin-bottom:8px">每行一段：<span class="mono">T0: 澜 镜</span>；不带 T 度的续行归入上一段；未知英雄名会跳过并提示。</div>');
    out.push('<textarea data-act="importText" placeholder="T0: 澜 镜&#10;T0.5: 张良 露娜&#10;T1: 大乔 孙膑 太乙真人">' + esc(state.importText) + '</textarea>');
    out.push('<div class="row gap" style="margin-top:8px">');
    out.push('<button class="btn btn-primary btn-sm" data-act="applyImport">导入并保存</button>');
    out.push('<button class="btn btn-sm ghost" data-act="clearImport">清空</button>');
    out.push('<span class="hint">' + esc(state.importHint || '') + '</span>');
    out.push('</div>');
    out.push('</section>');
    return out.join('');
  }

  function applyTierImport() {
    if (!state.meta) { toast('meta 数据未就绪，无法导入', 'bad'); return; }
    var ai = window.HOKAI;
    if (!ai || typeof ai.parseTierImport !== 'function') { toast('ai.js 未加载，无法解析', 'bad'); return; }
    var r;
    try { r = ai.parseTierImport(state.importText); } catch (e) { toast('解析失败：' + msgOf(e), 'bad'); return; }
    if (!r.count) {
      state.importHint = r.errors.length ? ('解析失败：' + r.errors[0]) : '没有解析到有效英雄';
      renderView();
      toast(state.importHint, 'bad');
      return;
    }
    var meta;
    try { meta = JSON.parse(JSON.stringify(state.meta)); } catch (e) { toast('meta 复制失败', 'bad'); return; }
    meta.tiers = meta.tiers || {};
    Object.keys(r.tiers).forEach(function (name) {
      var t = r.tiers[name];
      var cur = meta.tiers[name];
      if (cur && typeof cur === 'object') cur.tier = t;
      else {
        var h = heroByName(name);
        meta.tiers[name] = { tier: t, score: 0, role: h ? heroLaneText(h) : '', winRate: 0, pickRate: 0, banRate: 0, winRateDelta: 0 };
      }
    });
    state.importHint = '保存中…';
    renderView();
    api('PUT', '/api/meta', meta).then(function () {
      state.meta = meta; state.metaErr = null;
      state.importHint = '已导入 ' + r.count + ' 个 T 度' + (r.unknown.length ? ('，跳过未知英雄 ' + r.unknown.length + ' 个：' + r.unknown.join('、')) : '');
      recompute(); renderAll();
      toast('已导入并保存 ' + r.count + ' 个 T 度', 'ok');
    }).catch(function (e) {
      state.importHint = '保存失败：' + msgOf(e);
      renderView();
      toast('保存 meta 失败：' + msgOf(e), 'bad');
    });
  }

  /* ================= 数据页 ================= */

  function relSummary() {
    var rel = state.relations || { counters: [], synergies: [] };
    var counters = Array.isArray(rel.counters) ? rel.counters : [];
    var synergies = Array.isArray(rel.synergies) ? rel.synergies : [];
    function srcDist(arr) {
      var m = {};
      arr.forEach(function (r) { var k = (r && r.src) || '未知'; m[k] = (m[k] || 0) + 1; });
      return m;
    }
    function matchBuckets(arr) {
      var buckets = [
        { label: '<150', test: function (n) { return n < 150; } },
        { label: '150-299', test: function (n) { return n >= 150 && n < 300; } },
        { label: '300-599', test: function (n) { return n >= 300 && n < 600; } },
        { label: '600-999', test: function (n) { return n >= 600 && n < 1000; } },
        { label: '≥1000', test: function (n) { return n >= 1000; } }
      ];
      buckets.forEach(function (b) { b.n = 0; });
      arr.forEach(function (r) {
        var n = num(r && r.matches, 0);
        for (var i = 0; i < buckets.length; i++) { if (buckets[i].test(n)) { buckets[i].n++; break; } }
      });
      return buckets;
    }
    var names = {};
    heroes().forEach(function (h) { if (h && h.name) names[h.name] = true; });
    function validate(arr) {
      var issues = { total: arr.length, badName: 0, selfRef: 0, badW: 0, badSrc: 0 };
      arr.forEach(function (r) {
        if (!r || !r.a || !r.b) { issues.badName++; return; }
        if (!names[r.a] || !names[r.b]) issues.badName++;
        if (r.a === r.b) issues.selfRef++;
        var wv = num(r.w, NaN);
        if (!isFinite(wv) || wv < 0.3 || wv > 1) issues.badW++;
        if (['stats', 'manual', 'inferred'].indexOf(r.src) < 0) issues.badSrc++;
      });
      return issues;
    }
    return {
      counters: counters, synergies: synergies,
      srcC: srcDist(counters), srcS: srcDist(synergies),
      mbC: matchBuckets(counters), mbS: matchBuckets(synergies),
      vC: validate(counters), vS: validate(synergies)
    };
  }

  function barsHtml(dist) {
    var keys = Object.keys(dist);
    if (!keys.length) return '<div class="hint">无数据</div>';
    keys.sort(function (a, b) { return dist[b] - dist[a]; });
    var max = 1;
    keys.forEach(function (k) { if (dist[k] > max) max = dist[k]; });
    return '<ul class="bars">' + keys.map(function (k) {
      var pct = Math.round(dist[k] / max * 100);
      return '<li><span class="bl">' + esc(k) + '</span><span class="bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="bv">' + dist[k] + '</span></li>';
    }).join('') + '</ul>';
  }

  function bucketsHtml(buckets) {
    var max = 1;
    buckets.forEach(function (b) { if (b.n > max) max = b.n; });
    return '<ul class="bars">' + buckets.map(function (b) {
      var pct = Math.round(b.n / max * 100);
      return '<li><span class="bl">' + esc(b.label) + '</span><span class="bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="bv">' + b.n + '</span></li>';
    }).join('') + '</ul>';
  }

  function topRelTable(arr, kind) {
    var list = arr.slice().sort(function (a, b) { return num(b && b.idx, 0) - num(a && a.idx, 0); }).slice(0, 10);
    if (!list.length) return '<div class="hint">无数据</div>';
    var rows = list.map(function (r, i) {
      return '<tr><td class="num">' + (i + 1) + '</td><td class="hero"><span class="cell-hero">' + avatar(r.a, 'sm') + esc(r.a) + '</span></td>' +
        '<td class="hero"><span class="cell-hero">' + avatar(r.b, 'sm') + esc(r.b) + '</span></td>' +
        '<td class="num">' + fx(r.w, 2) + '</td><td class="num">' + fx(r.idx, 1) + '</td>' +
        '<td class="num">' + num(r.matches, 0) + '</td><td>' + esc(r.src || '—') + '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table class="grid"><thead><tr><th class="num">#</th><th>' +
      (kind === 'counter' ? '克制方' : '英雄 A') + '</th><th>' + (kind === 'counter' ? '被克方' : '英雄 B') +
      '</th><th class="num">w</th><th class="num">idx</th><th class="num">样本</th><th>来源</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function renderData() {
    var out = [];
    out.push(notices(''));
    var s = relSummary();
    var heroCount = heroes().length;
    var tierCount = Object.keys((state.meta && state.meta.tiers) || {}).length;
    var iconCount = window.HERO_ICON ? Object.keys(window.HERO_ICON).length : 0;

    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>数据概况</h2><div class="row gap">');
    out.push('<button class="btn btn-sm ghost" data-act="refresh">重新加载</button>');
    out.push('</div></div>');
    out.push('<div class="stat-grid">');
    out.push('<div class="stat"><div class="k">英雄总数</div><div class="v">' + heroCount + '</div></div>');
    out.push('<div class="stat"><div class="k">本地头像</div><div class="v">' + iconCount + ' <small>/ ' + heroCount + '</small></div></div>');
    out.push('<div class="stat"><div class="k">梯度覆盖</div><div class="v">' + tierCount + ' <small>/ ' + heroCount + '</small></div></div>');
    out.push('<div class="stat"><div class="k">克制关系</div><div class="v">' + s.counters.length + ' <small>条</small></div></div>');
    out.push('<div class="stat"><div class="k">协同关系</div><div class="v">' + s.synergies.length + ' <small>条</small></div></div>');
    out.push('<div class="stat"><div class="k">数据日期</div><div class="v" style="font-size:15px">' +
      esc((state.relations && state.relations.date) || (state.meta && state.meta.version) || (state.health && state.health.date) || '—') + '</div></div>');
    out.push('</div>');
    if (!state.relations) out.push('<div class="notice warn">relations.json 未就绪：' + esc(state.relationsErr || NOT_READY) + '</div>');
    out.push('</section>');

    out.push('<div class="two-col">');
    out.push('<section class="panel"><div class="panel-head"><h2>来源分布</h2></div>');
    out.push('<h3>counters</h3>' + barsHtml(s.srcC));
    out.push('<h3 style="margin-top:10px">synergies</h3>' + barsHtml(s.srcS));
    out.push('</section>');
    out.push('<section class="panel"><div class="panel-head"><h2>样本量分布</h2></div>');
    out.push('<h3>counters（matches）</h3>' + bucketsHtml(s.mbC));
    out.push('<h3 style="margin-top:10px">synergies（matches）</h3>' + bucketsHtml(s.mbS));
    out.push('</section>');
    out.push('</div>');

    var vc = s.vC, vs = s.vS;
    var badTotal = vc.badName + vc.selfRef + vc.badW + vc.badSrc + vs.badName + vs.selfRef + vs.badW + vs.badSrc;
    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>校验结果（只读）</h2><span class="hint">名称命中 / 无自反 / w∈[0.3,1] / src 合法</span></div>');
    if (!state.relations) out.push('<div class="notice">' + NOT_READY + '</div>');
    else if (badTotal === 0) out.push('<div class="notice ok">全部通过。</div>');
    else out.push('<div class="notice bad">发现 ' + badTotal + ' 处可疑数据（仅供参考，不改数据）。</div>');
    out.push('<div class="table-wrap"><table class="grid"><thead><tr><th>集合</th><th class="num">条数</th>' +
      '<th class="num">未知英雄名</th><th class="num">自反(a=b)</th><th class="num">w 越界</th><th class="num">src 非法</th></tr></thead><tbody>');
    out.push('<tr><td>counters</td><td class="num">' + vc.total + '</td><td class="num">' + vc.badName + '</td>' +
      '<td class="num">' + vc.selfRef + '</td><td class="num">' + vc.badW + '</td><td class="num">' + vc.badSrc + '</td></tr>');
    out.push('<tr><td>synergies</td><td class="num">' + vs.total + '</td><td class="num">' + vs.badName + '</td>' +
      '<td class="num">' + vs.selfRef + '</td><td class="num">' + vs.badW + '</td><td class="num">' + vs.badSrc + '</td></tr>');
    out.push('</tbody></table></div>');
    out.push('</section>');

    out.push('<div class="two-col">');
    out.push('<section class="panel"><div class="panel-head"><h2>Top 克制（按 idx）</h2></div>' + topRelTable(s.counters, 'counter') + '</section>');
    out.push('<section class="panel"><div class="panel-head"><h2>Top 协同（按 idx）</h2></div>' + topRelTable(s.synergies, 'synergy') + '</section>');
    out.push('</div>');
    return out.join('');
  }

  /* ================= 导出页 ================= */

  function buildExportText() {
    var ai = window.HOKAI;
    if (ai && typeof ai.buildBpText === 'function') {
      try { return ai.buildBpText(state); } catch (e) { return '生成 BP 文本失败：' + msgOf(e); }
    }
    return 'ai.js 未加载，无法生成 BP 文本。';
  }

  function renderExport() {
    var out = [];
    out.push(notices(''));
    var text = buildExportText();
    state.exportText = text;

    out.push('<section class="panel">');
    out.push('<div class="panel-head"><h2>本局 BP 文本</h2><span class="hint">含引擎推荐与实际录入（带楼层与玩家）</span></div>');
    out.push('<textarea class="export-text" id="exportText" readonly spellcheck="false">' + esc(text) + '</textarea>');
    out.push('<div class="row gap" style="margin-top:10px">');
    out.push('<button class="btn btn-primary" data-act="copyText">复制文本</button>');
    out.push('<button class="btn" data-act="downloadJson">下载 JSON</button>');
    out.push('<button class="btn btn-blue" data-act="appendHistory">追加到 history</button>');
    out.push('<button class="btn ghost" data-act="exportRefresh">刷新文本</button>');
    out.push('</div>');
    out.push('<div class="hint" style="margin-top:8px">「追加到 history」会 PUT /api/store，把本局记录写入 store.history。</div>');
    out.push('</section>');

    var hist = (state.store && Array.isArray(state.store.history)) ? state.store.history : [];
    out.push('<section class="panel"><div class="panel-head"><h2>历史记录</h2><span class="hint">共 ' + hist.length + ' 条</span></div>');
    if (!hist.length) out.push('<div class="notice">还没有导出记录。</div>');
    else {
      out.push('<div class="table-wrap"><table class="grid"><thead><tr><th>时间</th><th>阵营</th><th>我方 ban</th><th>敌方 ban</th><th>选人</th></tr></thead><tbody>');
      hist.slice(-10).reverse().forEach(function (h) {
        if (!h || typeof h !== 'object') return;
        var b = h.bans || {};
        var p = h.picks || {};
        var bansOurs = Array.isArray(b.ours) ? b.ours.join('、') : '—';
        var bansTheirs = Array.isArray(b.theirs) ? b.theirs.join('、') : '—';
        var picks = [];
        if (Array.isArray(p.blue)) picks.push('蓝：' + (p.blue.join('、') || '—'));
        if (Array.isArray(p.red)) picks.push('红：' + (p.red.join('、') || '—'));
        out.push('<tr><td>' + esc(h.at || '—') + '</td><td>' + esc(h.side === 'red' ? '红方' : '蓝方') + '</td>' +
          '<td>' + esc(bansOurs || '—') + '</td><td>' + esc(bansTheirs || '—') + '</td><td>' + esc(picks.join(' / ')) + '</td></tr>');
      });
      out.push('</tbody></table></div>');
    }
    out.push('</section>');
    return out.join('');
  }

  function copyText() {
    var ta = $id('exportText');
    var text = ta ? ta.value : state.exportText;
    if (!text) { toast('没有可复制的内容', 'bad'); return; }
    function fallbackCopy() {
      if (!ta) return false;
      try {
        ta.removeAttribute('readonly');
        ta.select();
        var ok = document.execCommand('copy');
        ta.setAttribute('readonly', 'readonly');
        if (ok) { toast('已复制到剪贴板', 'ok'); return true; }
        return false;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板', 'ok'); })
        .catch(function () { if (!fallbackCopy()) toast('复制失败，请手动选择文本复制', 'bad'); });
    } else if (!fallbackCopy()) toast('复制失败，请手动选择文本复制', 'bad');
  }

  function downloadJson() {
    var ai = window.HOKAI;
    var data;
    try {
      data = (ai && typeof ai.buildBpJson === 'function')
        ? ai.buildBpJson(state)
        : { at: new Date().toISOString(), side: storeSide(), bans: state.bans, picks: state.picks, exported: true };
    } catch (e) { toast('生成 JSON 失败：' + msgOf(e), 'bad'); return; }
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var d = new Date();
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'hok-bp-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 200);
      toast('已下载 ' + name, 'ok');
    } catch (e) { toast('下载失败：' + msgOf(e), 'bad'); }
  }

  function appendHistory() {
    if (!state.store) state.store = defaultStore();
    var entry = {
      at: new Date().toISOString(),
      side: storeSide(),
      bans: { ours: (state.bans.ours || []).filter(Boolean), theirs: (state.bans.theirs || []).filter(Boolean) },
      picks: { blue: (state.picks.blue || []).slice(), red: (state.picks.red || []).slice() },
      exported: true
    };
    state.store.history = Array.isArray(state.store.history) ? state.store.history : [];
    state.store.history.push(entry);
    api('PUT', '/api/store', normalizeStore(state.store)).then(function () {
      state.storeErr = null; state.storeDirty = false;
      toast('已追加到 history（共 ' + state.store.history.length + ' 条）', 'ok');
      renderView();
    }).catch(function (e) { toast('追加失败：' + msgOf(e), 'bad'); });
  }

  /* ================= 动作分发 ================= */

  var DS_KEYS = ['tab', 'side', 'idx', 'slot', 'hero', 'tier', 'lane', 'type', 'm', 'pidx', 'sidx', 'id', 'size', 'priority'];

  function handleAction(act, ds, ev) {
    switch (act) {
      case 'tab': setTab(ds.tab); break;
      case 'setSide': setSide(ds.side); break;
      case 'saveStore': saveStore(false); break;
      case 'togglePrefer': togglePreferLane(num(ds.idx), ds.lane); break;

      /* 英雄池编辑器 */
      case 'openPool': openPoolEditor(num(ds.idx)); break;
      case 'poolClose': closePoolEditor(); break;
      case 'poolMask': if (ev && ev.target && ev.target.classList && ev.target.classList.contains('modal-mask')) closePoolEditor(); break;
      case 'poolToggle': {
        var pe = state.poolEditor;
        if (!pe) break;
        var hero = ds.hero;
        if (pe.sel[hero] !== undefined) delete pe.sel[hero];
        else pe.sel[hero] = 'normal';
        applyPoolEditorToStore();
        updatePoolList();
        break;
      }
      case 'poolMastery': {
        var pe2 = state.poolEditor;
        if (!pe2 || !pe2.sel[ds.hero]) break;
        pe2.sel[ds.hero] = normalizeMastery(ds.m);
        applyPoolEditorToStore();
        updatePoolList();
        break;
      }
      case 'poolLane': if (state.poolEditor) { state.poolEditor.lane = ds.lane || 'all'; renderModal(); } break;
      case 'poolType': if (state.poolEditor) { state.poolEditor.type = ds.type || 'all'; renderModal(); } break;
      case 'poolOnlySel': if (state.poolEditor) { state.poolEditor.onlySel = !state.poolEditor.onlySel; renderModal(); } break;
      case 'poolSelectAll': {
        var pe3 = state.poolEditor;
        if (!pe3) break;
        poolCandidateList().forEach(function (h) { if (pe3.sel[h.name] === undefined) pe3.sel[h.name] = 'normal'; });
        applyPoolEditorToStore();
        updatePoolList();
        break;
      }
      case 'poolClear': if (state.poolEditor) { state.poolEditor.sel = {}; applyPoolEditorToStore(); updatePoolList(); } break;
      case 'poolDone': closePoolEditor(); recompute(); renderAll(); break;

      /* 单选英雄弹窗 */
      case 'pickerMask': if (ev && ev.target && ev.target.classList && ev.target.classList.contains('modal-mask')) closePicker(); break;
      case 'pickerClose': closePicker(); break;
      case 'pickerLane': if (state.picker) { state.picker.lane = ds.lane || 'all'; renderModal(); } break;
      case 'pickerType': if (state.picker) { state.picker.type = ds.type || 'all'; renderModal(); } break;
      case 'pickerToggle': {
        var pk = state.picker;
        if (!pk) break;
        var hero = ds.hero;
        if (pk.multi) {
          var i = pk.sel.indexOf(hero);
          if (i >= 0) pk.sel.splice(i, 1);
          else if (pk.sel.length < pk.max) pk.sel.push(hero);
          updatePickerList();
        } else {
          pk.sel = (pk.sel[0] === hero) ? [] : [hero];
          updatePickerList();
        }
        break;
      }
      case 'pickerNone': if (state.picker) { state.picker.sel = []; updatePickerList(); } break;
      case 'pickerConfirm': pickerConfirm(); break;

      /* 指定谁玩（v2.3） */
      case 'assignHero': openAssign(ds.hero); break;
      case 'assignChoose': chooseAssignment(ds.hero, num(ds.pidx)); break;
      case 'assignAuto': clearAssignment(ds.hero); break;
      case 'assignClose': closeAssign(); break;
      case 'assignMask': if (ev && ev.target && ev.target.classList && ev.target.classList.contains('modal-mask')) closeAssign(); break;

      /* 设置 / 建议 */
      case 'runAdvice': runAdvice(); break;
      case 'adviceAdd': adviceAdd(num(ds.sidx), num(ds.pidx)); break;

      /* Ban */
      case 'adoptBan': adoptBan(ds.hero); break;
      case 'adoptAllBans': adoptAllBans(); break;
      case 'openBanSlot': openBanSlot(ds.side, ds.slot); break;
      case 'openBanBulk': openPicker({ kind: 'banTheirsBulk', multi: true, max: 5 }); break;
      case 'clearBan': if (state.bans[ds.side]) { state.bans[ds.side][num(ds.slot)] = ''; persist(); recompute(); renderAll(); } break;
      case 'clearBans': if (state.bans[ds.side]) { state.bans[ds.side] = ['', '', '', '', '']; persist(); recompute(); renderAll(); } break;
      case 'enterPick': enterPickPhase(); break;
      case 'backBan': backToBan(); break;

      /* 赛前预选（v2.4） */
      case 'usePreset': usePreset(ds.id); break;
      case 'clearPreset': clearPreset(); break;
      case 'openPresetCustom': openPresetCustom(); break;
      case 'adoptPresetBan': adoptPresetBan(ds.hero); break;
      case 'togglePresetPlan': state.presetPlanOpen = !state.presetPlanOpen; renderView(); break;
      case 'presetFilterSize': state.presetSize = ds.size || 'all'; renderView(); break;
      case 'presetFilterPriority': state.presetPriority = ds.priority || 'all'; renderView(); break;

      /* Pick */
      case 'pickHero': {
        var st = currentStepInfo();
        doPick(st ? st.side : storeSide(), ds.hero);
        break;
      }
      case 'openPickOurs': openPicker({ kind: 'pickOurs' }); break;
      case 'openPickEnemy': openPicker({ kind: 'pickEnemy' }); break;
      case 'skipEnemy': skipEnemy(); break;
      case 'enemyFilter': state.enemyLane = ds.lane || 'all'; renderView(); break;
      case 'undoPick': undoPick(); break;
      case 'resetBp': resetBp(); break;

      /* 梯度 */
      case 'tierFilter': state.tierFilter = ds.tier || 'all'; renderView(); break;
      case 'applyImport': applyTierImport(); break;
      case 'clearImport': state.importText = ''; state.importHint = ''; renderView(); break;

      /* 通用 */
      case 'refresh': loadAll(); break;
      case 'copyText': copyText(); break;
      case 'downloadJson': downloadJson(); break;
      case 'appendHistory': appendHistory(); break;
      case 'exportRefresh': renderView(); break;
      default: break;
    }
  }

  function pickerConfirm() {
    var pk = state.picker;
    if (!pk) return;
    var sel = pk.sel.slice();
    closePicker();
    if (pk.kind === 'banOurs' || pk.kind === 'banTheirs') {
      var side = pk.kind === 'banOurs' ? 'ours' : 'theirs';
      state.bans[side][num(pk.slot)] = sel[0] || '';
      persist(); recompute(); renderAll();
      toast(sel[0] ? ('已录入 ban：' + sel[0]) : '已清空该 ban 位');
      return;
    }
    if (pk.kind === 'banTheirsBulk') {
      var arr = ['', '', '', '', ''];
      sel.slice(0, 5).forEach(function (h, i) { arr[i] = h; });
      state.bans.theirs = arr;
      persist(); recompute(); renderAll();
      toast(sel.length ? ('敌方 ban 已录入 ' + Math.min(sel.length, 5) + ' 个' + (sel.length < 5 ? '，其余按空 ban' : '')) : '敌方 ban 已清空（空 ban）');
      return;
    }
    if (pk.kind === 'presetCore') {
      var cores = sel.slice(0, 5);
      if (!cores.length) { toast('至少要选 1 个核心英雄', 'bad'); return; }
      state.preset = { id: 'custom', core: cores };
      state.presetPlanOpen = false;
      persist(); recompute(); renderAll();
      toast('已设为自定义预选：' + cores.join(' + '), 'ok');
      return;
    }
    var hero = sel[0] || '';
    if (!hero) return;
    var st = currentStepInfo();
    if (pk.kind === 'pickOurs') {
      if (st && st.isOurs) doPick(storeSide(), hero);
      else toast('现在不是我方选人回合', 'bad');
      return;
    }
    if (pk.kind === 'pickEnemy') {
      if (st && !st.isOurs) doPick(st.side, hero);
      else toast('现在不是敌方选人回合（可以先「跳过」或直接用英雄卡）', 'bad');
      return;
    }
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    document.addEventListener('click', function (ev) {
      var t = (ev.target && ev.target.closest) ? ev.target.closest('[data-act]') : null;
      if (!t) return;
      // 嵌套的清除按钮优先处理，避免触发外层 slot 的打开
      var inner = (ev.target && ev.target.closest) ? ev.target.closest('[data-act="clearBan"]') : null;
      if (inner && inner !== t && inner.getAttribute('data-act')) t = inner;
      var act = t.getAttribute('data-act');
      if (!act) return;
      var ds = {};
      DS_KEYS.forEach(function (k) { if (t.hasAttribute('data-' + k)) ds[k] = t.getAttribute('data-' + k); });
      try { handleAction(act, ds, ev); }
      catch (e) { toast('操作失败：' + msgOf(e), 'bad'); }
    });

    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute('data-act');
      if (!act) return;
      try {
        if (act === 'playerName') {
          var i = num(t.getAttribute('data-idx'));
          var p = players()[i];
          if (p) { p.name = String(t.value || '').slice(0, 12); markStoreDirty(); }
        } else if (act === 'poolQuery') {
          if (state.poolEditor) { state.poolEditor.query = t.value; updatePoolList(); }
        } else if (act === 'pickerQuery') {
          if (state.picker) { state.picker.query = t.value; updatePickerList(); }
        } else if (act === 'enemyQuery') {
          state.enemyQuery = t.value;
          updateEnemyList();
        } else if (act === 'tierQuery') {
          state.tierQuery = t.value;
          updateTierTable();
        } else if (act === 'importText') {
          state.importText = t.value;
        }
      } catch (e) { toast('输入处理失败：' + msgOf(e), 'bad'); }
    });

    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute('data-act');
      if (!act) return;
      try {
        // 楼层已不参与 BP 计算（v2.1），保留 change 监听仅为兼容旧页面缓存
        if (act === 'playerFloor') { /* no-op */ }
      } catch (e) { toast('修改失败：' + msgOf(e), 'bad'); }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (state.poolEditor) { closePoolEditor(); }
        else if (state.picker) { closePicker(); }
      }
    });

    window.addEventListener('error', function (ev) {
      try { if (ev && ev.message) toast('脚本错误：' + ev.message, 'bad'); } catch (e) { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', function (ev) {
      try { toast('未处理异常：' + msgOf(ev && ev.reason), 'bad'); } catch (e) { /* ignore */ }
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    try {
      restoreSession();
      bindEvents();
      renderAll();
      loadAll();
    } catch (e) {
      try {
        var view = $id('view');
        if (view) view.innerHTML = '<div class="notice bad">界面初始化失败：' + esc(msgOf(e)) +
          '<br>请刷新页面；若持续失败，检查 /data/heroes.js、/heroicons.js 与 /engine.js 是否可访问。</div>';
      } catch (e2) { /* ignore */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
