/* ============================================================
 * ai.js — 王者荣耀 BP 平台 v2 · 导出文本 / JSON 层（原生 JS，非 module）
 *
 * v2 变更：
 *   - 删掉 v1 的 analyzePoolLocal 与远端 pool-advice 调用：
 *     补池建议只由 HOKEngine.analyzePool 单源产出（v1 双份实现是「建议重复」的根因）。
 *   - 导出文本带上：楼层 + 玩家 + 熟练度 + 五路覆盖 + 归属人。
 *
 * 对外：HOKAI.buildBpText(state) / buildBpJson(state) / parseTierImport(text)
 * 所有方法不抛异常。
 * ============================================================ */
(function (root) {
  'use strict';

  var HOKAI = {};

  var LANES = { top: '对抗路', jungle: '打野', mid: '中路', adc: '发育路', support: '游走' };
  var LANE_KEYS = ['top', 'jungle', 'mid', 'adc', 'support'];
  var MASTERY_LABEL = { best: '绝活', normal: '正常', basic: '仅会玩' };
  var MASTERY_ORDER = ['best', 'normal', 'basic'];
  var DEFAULT_PICK_SEQUENCE = ['B', 'R', 'R', 'B', 'B', 'R', 'R', 'B', 'B', 'R'];

  function laneLabel(l) { return LANES[l] || l || '—'; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function pickSequence() {
    var e = root.HOKEngine;
    return (e && Array.isArray(e.PICK_SEQUENCE) && e.PICK_SEQUENCE.length === 10) ? e.PICK_SEQUENCE : DEFAULT_PICK_SEQUENCE;
  }
  function heroes() { return Array.isArray(root.HEROES) ? root.HEROES : []; }
  function heroByName(name) {
    var hs = heroes();
    for (var i = 0; i < hs.length; i++) if (hs[i] && hs[i].name === name) return hs[i];
    return null;
  }
  function fmt(n, d) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toFixed(d === undefined ? 1 : d);
  }
  function playerAtFloor(store, floor) {
    var ps = (store && store.players) || [];
    for (var i = 0; i < ps.length; i++) if (num(ps[i].floor) === num(floor)) return ps[i];
    return null;
  }
  function poolOf(p) {
    var out = [];
    ((p && p.pool) || []).forEach(function (e) {
      if (typeof e === 'string') out.push({ hero: e, mastery: 'normal' });
      else if (e && e.hero) out.push({ hero: e.hero, mastery: MASTERY_LABEL[e.mastery] ? e.mastery : 'normal' });
    });
    return out;
  }
  function poolText(p) {
    var pool = poolOf(p);
    if (!pool.length) return '未填';
    var groups = {};
    pool.forEach(function (e) { (groups[e.mastery] = groups[e.mastery] || []).push(e.hero); });
    return MASTERY_ORDER.filter(function (k) { return groups[k]; }).map(function (k) {
      return MASTERY_LABEL[k] + '：' + groups[k].join('、');
    }).join(' ｜ ');
  }

  /* 全队里谁能打这个英雄（v2.1：楼层不参与，按玩家池 + 熟练度） */
  function ownersOfStore(store, hero) {
    var out = [];
    var ps = (store && store.players) || [];
    ps.forEach(function (p) {
      var entry = poolOf(p).filter(function (e) { return e.hero === hero; })[0];
      if (entry) out.push({ name: p.name || '玩家', mastery: entry.mastery });
    });
    out.sort(function (a, b) { return MASTERY_ORDER.indexOf(a.mastery) - MASTERY_ORDER.indexOf(b.mastery); });
    return out;
  }
  function ownersText(store, hero) {
    var os = ownersOfStore(store, hero);
    if (!os.length) return '池外';
    return os.map(function (o) { return o.name + '（' + MASTERY_LABEL[o.mastery] + '）'; }).join('/');
  }

  /* v2.4：预选方案 / 总体评价（依赖 app.js 的 state.presetPlan / state.review） */
  function presetPlanOf(s) {
    var p = s && s.presetPlan;
    return (p && p.active) ? p : null;
  }
  function presetRawName(preset) {
    if (!preset || typeof preset !== 'object') return '';
    if (preset.id === 'custom' && Array.isArray(preset.core) && preset.core.length) return '自定义核心：' + preset.core.join(' + ');
    return str(preset.id);
  }
  function planProgressText(p) {
    var pr = (p && p.progress) || {};
    var c = pr.core || {}, b = pr.bans || {}, pt = pr.partners || {};
    return '核心 ' + num(c.picked) + '/' + num(c.total) + ' · 必 ban ' + num(b.banned) + '/' + num(b.total) +
      ' · 搭配 ' + num(pt.picked) + '/' + num(pt.total);
  }
  function planThreatDone(t) {
    return !!(t && (t.banned || t.status === 'banned'));
  }

  /* ---------------- 梯度粘贴导入解析 ---------------- */

  HOKAI.parseTierImport = function (text) {
    var tiers = {};
    var errors = [];
    var unknown = [];
    var count = 0;
    var names = {};
    heroes().forEach(function (h) { if (h && h.name) names[h.name] = true; });

    var lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
    var cur = null;

    lines.forEach(function (raw, idx) {
      var line = raw.trim();
      if (!line || /^[#;]/.test(line)) return;
      var m = line.match(/^(T0\.5|T0|T1|T2|T3|T4)\s*[:：\-–—]?\s*(.*)$/i);
      var body;
      if (m) { cur = m[1].toUpperCase(); body = m[2] || ''; }
      else if (cur) body = line;
      else { errors.push('第 ' + (idx + 1) + ' 行无法识别（需以 T0/T0.5/T1… 开头）'); return; }
      if (!body) return;
      body.split(/[\s,，、\/|]+/).forEach(function (word) {
        var name = word.trim();
        if (!name) return;
        if (!names[name]) { if (unknown.indexOf(name) < 0) unknown.push(name); return; }
        if (tiers[name] !== cur) { tiers[name] = cur; count++; }
      });
    });

    return { tiers: tiers, errors: errors, unknown: unknown, count: count };
  };

  /* ---------------- 导出文本 ---------------- */

  HOKAI.buildBpText = function (s) {
    s = s || {};
    var store = s.store || {};
    var side = store.side === 'red' ? 'red' : 'blue';
    var date = str(s.health && s.health.date) || str(s.meta && s.meta.version) || '—';
    var seq = pickSequence();
    var bans = s.bans || { ours: [], theirs: [] };
    var picks = s.picks || { blue: [], red: [] };
    var recs = Array.isArray(s.recs) ? s.recs : [];
    var out = [];

    out.push('王者荣耀 BP 记录 · ' + date);
    out.push('我方阵营：' + (side === 'blue' ? '蓝方' : '红方'));
    if (s.health && s.health.heroCount) {
      out.push('数据：英雄 ' + s.health.heroCount + ' · 梯度 ' + (s.health.tierCount || '—') + ' · 关系 ' + (s.health.relCount || '—'));
    }
    out.push('');

    out.push('【我方英雄池（倾向分路 / 熟练度；五排可换位，不记楼层）】');
    var players = Array.isArray(store.players) ? store.players : [];
    if (!players.length) out.push('  （空模板）');
    players.forEach(function (p) {
      var lanes = (p.preferLanes || []).map(laneLabel).join('/') || '未设';
      out.push('  ' + (p.name || '玩家') + '（倾向 ' + lanes + '）');
      out.push('    ' + poolText(p));
    });
    out.push('');

    out.push('【禁用】');
    var oursBans = (bans.ours || []).filter(Boolean);
    var theirsBans = (bans.theirs || []).filter(Boolean);
    out.push('  我方：' + (oursBans.length ? oursBans.join('、') : '（未录入）'));
    out.push('  敌方：' + (theirsBans.length ? theirsBans.join('、') : '空 ban / 未知'));
    out.push('');

    /* v2.4：【赛前预选】 */
    var plan = presetPlanOf(s);
    if (plan) {
      out.push('【赛前预选】');
      out.push('  方案：' + str(plan.name) + (plan.subtitle ? '（' + plan.subtitle + '）' : '') +
        (plan.custom ? ' · 自定义核心' : ''));
      out.push('  完成度：' + planProgressText(plan));
      var planCore = Array.isArray(plan.core) ? plan.core : [];
      if (planCore.length) {
        out.push('  核心：');
        planCore.forEach(function (c) {
          if (!c || !c.hero) return;
          var own = (Array.isArray(c.owners) && c.owners.length) ? c.owners.map(function (o) {
            var ml = o.masteryLabel || MASTERY_LABEL[o.mastery] || '';
            return str(o.name) + (ml ? '·' + ml : '');
          }).join('/') : '池里没人会';
          out.push('    ' + c.hero + (c.tier ? ' ' + c.tier : '') + (c.laneLabel ? '（' + c.laneLabel + '）' : '') +
            ' — ' + str(c.statusLabel || c.status) + ' · 谁打：' + own);
        });
      }
      var planThreats = Array.isArray(plan.threats) ? plan.threats : [];
      var mustBans = planThreats.filter(function (t) { return t && t.level !== 'watch'; });
      var watchBans = planThreats.filter(function (t) { return t && t.level === 'watch'; });
      if (mustBans.length) {
        var mustDone = mustBans.filter(planThreatDone).length;
        out.push('  必 ban（我方已执行 ' + mustDone + '/' + mustBans.length + '）：');
        mustBans.forEach(function (t) {
          if (!t || !t.hero) return;
          var stText = planThreatDone(t) ? '已 ban' : (t.status === 'picked' ? '被敌方选走' : '未处理');
          out.push('    ' + t.hero + ' — ' + stText + (t.reason ? ' · ' + t.reason : ''));
        });
      }
      if (watchBans.length) out.push('  另外关注：' + watchBans.map(function (t) { return t.hero; }).join('、'));
      var planPartners = Array.isArray(plan.partners) ? plan.partners : [];
      if (planPartners.length) {
        out.push('  推荐搭配：' + planPartners.slice(0, 6).map(function (x) {
          return x.hero + (x.inPool ? '（池内）' : '（池外）') + (x.note ? '：' + x.note : '');
        }).join('；'));
      }
      if (plan.playstyle) {
        out.push('  打法：' + str(plan.playstyle.label) + (plan.playstyle.desc ? ' —— ' + plan.playstyle.desc : ''));
      }
      if (plan.winCondition) out.push('  胜负条件：' + plan.winCondition);
      var planTeam = Array.isArray(plan.teamPlan) ? plan.teamPlan : [];
      if (planTeam.length) {
        out.push('  队友分工：');
        planTeam.forEach(function (t) {
          if (!t) return;
          out.push('    ' + str(t.role || laneLabel(t.lane)) + '：' + str(t.instruction));
        });
      }
      var planTips = Array.isArray(plan.tips) ? plan.tips : [];
      if (planTips.length) {
        out.push('  要点：');
        planTips.forEach(function (t) { out.push('    · ' + t); });
      }
      var planWarns = Array.isArray(plan.warnings) ? plan.warnings : [];
      if (planWarns.length) out.push('  提示：' + planWarns.join('；'));
      out.push('');
    } else if (s.preset && typeof s.preset === 'object') {
      out.push('【赛前预选】');
      out.push('  方案：' + presetRawName(s.preset) + '（引擎未返回方案细节）');
      out.push('');
    }

    var cmds = (s.banResult && Array.isArray(s.banResult.commands)) ? s.banResult.commands : [];
    out.push('【Ban 建议（引擎）】');
    if (!cmds.length) out.push('  （引擎未返回，或数据未就绪）');
    else cmds.forEach(function (c, i) {
      var bd = c.breakdown || {};
      out.push('  ' + (i + 1) + '. ' + c.hero + '  ' + (c.tier || 'T2') + '  ' + fmt(c.score) + ' 分');
      out.push('     拆解：强度 ' + fmt(bd.tier) + ' / 威胁 ' + fmt(bd.threat) + ' / 池脆弱 ' + fmt(bd.fragility) +
        ' / 可反制 ' + (bd.answerable ? '是' : '否'));
      if (c.reason) out.push('     理由：' + c.reason);
      if (Array.isArray(c.alternatives) && c.alternatives.length) {
        out.push('     备选：' + c.alternatives.map(function (a) { return a.hero + '(' + fmt(a.score) + ')'; }).join('、'));
      }
    });
    var warnings = (s.banResult && Array.isArray(s.banResult.warnings)) ? s.banResult.warnings : [];
    if (warnings.length) out.push('  提示：' + warnings.join('；'));
    out.push('');

    out.push('【选人记录（我方第 N 手 + 可打玩家；五排可换位/帮抢，不记楼层）】');
    var totalPicks = (picks.blue ? picks.blue.length : 0) + (picks.red ? picks.red.length : 0);
    if (!totalPicks) {
      out.push('  （尚未选人）');
    } else {
      var bi = 0, ri = 0;
      for (var i = 0; i < seq.length; i++) {
        var sd = seq[i] === 'B' ? 'blue' : 'red';
        var name = sd === 'blue' ? (picks.blue || [])[bi] : (picks.red || [])[ri];
        var pickNo = sd === 'blue' ? bi + 1 : ri + 1;
        if (sd === 'blue') bi++; else ri++;
        if (!name) continue;
        var line = '  ' + (sd === side ? '我方第' + pickNo + '手' : '敌方第' + pickNo + '手') + ' → ' + name;
        if (sd === side) {
          var am = s.pickResult && Array.isArray(s.pickResult.assignment) ? s.pickResult.assignment : [];
          var at = null;
          am.forEach(function (a) { if (a && a.hero === name) at = a; });
          line += at ? '（由 ' + at.playerName + '·' + (MASTERY_LABEL[at.mastery] || '正常') + ' 打）' : '（可打：' + ownersText(store, name) + '）';
        }
        var rec = recs.filter(function (r) { return r && r.index === i; })[0];
        if (rec && Array.isArray(rec.heroes) && rec.heroes.length) {
          line += '    推荐：' + rec.heroes.slice(0, 3).map(function (h) { return h.hero + '(' + fmt(h.score) + ')'; }).join('、');
        }
        out.push(line);
      }
    }
    out.push('');

    out.push('【阵容体检】');
    var lineup = s.lineup;
    if (!lineup) {
      out.push('  （引擎未就绪，无体检结果）');
    } else {
      var plan = lineup.lanePlan || {};
      var assign = Array.isArray(plan.assignments) ? plan.assignments : [];
      out.push('  五路覆盖：' + (assign.length ? assign.map(function (a) {
        return (a.laneLabel || laneLabel(a.lane)) + '=' + a.hero + (a.playerName ? '(' + a.playerName + ')' : '');
      }).join('、') : '（未分配）'));
      var uncovered = Array.isArray(plan.uncovered) ? plan.uncovered : [];
      if (uncovered.length) out.push('  未覆盖分路：' + uncovered.join('、'));
      (lineup.checks || []).forEach(function (c) {
        out.push('  ' + (c.ok ? '✓' : '✗') + ' ' + (c.label || c.key) + '：' + str(c.value) + ' / ' + str(c.need) + (c.note ? '（' + c.note + '）' : ''));
      });
      var surv = lineup.survival || [];
      if (surv.length) {
        out.push('  每人池子存活：');
        surv.forEach(function (x) {
          var mc = x.masteryAlive || {};
          out.push('    ' + (x.name || '玩家') + ' ' + num(x.alive) + '/' + num(x.total) +
            '（绝' + num(mc.best) + '/常' + num(mc.normal) + '/会' + num(mc.basic) + '）' +
            (Array.isArray(x.aliveHeroes) && x.aliveHeroes.length ? ' 存活：' + x.aliveHeroes.join('、') : ''));
        });
      }
      var gaps = lineup.gaps || [];
      out.push('  缺口：' + (gaps.length ? gaps.join('、') : '无'));
    }
    out.push('');

    /* v2.4：【队伍总体评价】（只在 state.review 有值时输出） */
    var review = (s.review && s.review.done) ? s.review : null;
    if (review) {
      var mk = review.matchup || {};
      var vd = mk.verdict || null;
      out.push('【队伍总体评价】（只基于强度 / 克制 / 配合 / 结构，不预测胜率）');
      if (vd) out.push('  对位结论：' + str(vd.label || '均势') + (vd.note ? ' —— ' + vd.note : ''));
      [['我方', review.ours], ['敌方', review.theirs]].forEach(function (pair) {
        var r = pair[1];
        if (!r) return;
        var g = r.grade || {};
        out.push('  ' + pair[0] + '：' + num(r.score) + ' 分 · ' + str(g.key) + (g.label ? ' ' + g.label : '') +
          (r.playstyle ? ' · 打法 ' + str(r.playstyle.label) : ''));
        if (r.core && r.core.hero) {
          out.push('    核心：' + r.core.hero + (r.core.tier ? ' ' + r.core.tier : '') +
            (r.core.playerName ? '（' + r.core.playerName +
              (r.core.mastery ? '·' + (MASTERY_LABEL[r.core.mastery] || r.core.mastery) : '') + '）' : ''));
        }
        var dims = Array.isArray(r.dimensions) ? r.dimensions : [];
        if (dims.length) {
          out.push('    结构：' + dims.map(function (d) {
            return (d.level === 'ok' ? '✓' : (d.level === 'bad' ? '✗' : '!')) + str(d.label || d.key) +
              ' ' + num(d.value) + '/' + num(d.need);
          }).join(' '));
        }
        var st = Array.isArray(r.strengths) ? r.strengths : [];
        if (st.length) out.push('    优势：' + st.join('；'));
        var rk = Array.isArray(r.risks) ? r.risks : [];
        if (rk.length) out.push('    风险：' + rk.join('；'));
        var sy = Array.isArray(r.synergies) ? r.synergies : [];
        if (sy.length) {
          out.push('    关键配合：' + sy.map(function (x) { return x.a + '+' + x.b + '(' + fmt(x.w) + ')'; }).join('、'));
        }
        var lanes = (r.lanePlan && Array.isArray(r.lanePlan.assignments)) ? r.lanePlan.assignments : [];
        if (lanes.length) {
          out.push('    五路：' + lanes.map(function (a) {
            return (a.laneLabel || laneLabel(a.lane)) + '=' + a.hero + (a.playerName ? '(' + a.playerName + ')' : '');
          }).join('、'));
        }
        var combos = Array.isArray(r.combos) ? r.combos : [];
        if (combos.length) {
          out.push('    命中体系：' + combos.map(function (c) {
            var flex = c.flexHit;
            var flexText = '';
            if (Array.isArray(flex) && flex.length) {
              flexText = flex.map(function (f) {
                if (f && typeof f === 'object') return f.hero || f.name || '';
                return String(f || '');
              }).filter(Boolean).join('、');
            } else if (typeof flex === 'string') flexText = flex;
            return str(c.name || c.id) + ' ' + num(c.hit) + '/' + num(c.total) +
              (c.complete ? '（已成型）' : '（进行中）') + (flexText ? ' 替代：' + flexText : '');
          }).join('；'));
        } else {
          out.push('    命中体系：未命中已知体系');
        }
      });
      var edges = Array.isArray(mk.edges) ? mk.edges : [];
      if (edges.length) {
        out.push('  对位边：' + edges.map(function (e) {
          return str(e.label || e.key) + ' ' + num(e.ours) + ' vs ' + num(e.theirs) +
            (e.lead === 'ours' ? '（我方）' : (e.lead === 'theirs' ? '（敌方）' : '（持平）'));
        }).join('；'));
      }
      var mkThreats = Array.isArray(mk.threats) ? mk.threats : [];
      if (mkThreats.length) {
        out.push('  敌方关键威胁：' + mkThreats.map(function (t) {
          return t.hero + (t.tier ? '(' + t.tier + ')' : '') + (t.reason ? '：' + t.reason : '');
        }).join('；'));
      }
      var wins = Array.isArray(mk.winConditions) ? mk.winConditions : [];
      if (wins.length) out.push('  胜负手：' + wins.join('；'));
      var mkTips = Array.isArray(mk.tips) ? mk.tips : [];
      if (mkTips.length) out.push('  打法要点：' + mkTips.join('；'));
      var pm = review.preset;
      if (pm && pm.active) {
        out.push('  预选完成度：' + ((pm.matchScore === null || pm.matchScore === undefined) ? '—' : num(pm.matchScore)) + ' 分' +
          ' · 核心 ' + num(pm.coreHit) + '/' + num(pm.coreTotal) +
          ' · 必 ban ' + num(pm.mustBansDone) + '/' + num(pm.mustBansTotal) +
          ' · 搭配 ' + num(pm.partnerHit) + '/' + num(pm.partnerTotal));
        var offPlan = Array.isArray(pm.offPlan) ? pm.offPlan : [];
        if (offPlan.length) out.push('    偏出方案：' + offPlan.join('、'));
        var pmNotes = Array.isArray(pm.notes) ? pm.notes : [];
        pmNotes.forEach(function (n) { out.push('    · ' + n); });
      }
      var reviewWarns = Array.isArray(review.warnings) ? review.warnings : [];
      if (reviewWarns.length) out.push('  提示：' + reviewWarns.join('；'));
      out.push('');
    }
    out.push('（由王者荣耀 BP 平台 v2 生成）');
    return out.join('\n');
  };

  /* ---------------- 导出 JSON ---------------- */

  HOKAI.buildBpJson = function (s) {
    s = s || {};
    var store = s.store || {};
    var bans = s.bans || { ours: [], theirs: [] };
    var picks = s.picks || { blue: [], red: [] };
    var side = store.side === 'red' ? 'red' : 'blue';
    var seq = pickSequence();
    var order = [];
    var bi = 0, ri = 0;
    for (var i = 0; i < seq.length; i++) {
      var sd = seq[i] === 'B' ? 'blue' : 'red';
      var name = sd === 'blue' ? (picks.blue || [])[bi] : (picks.red || [])[ri];
      var pickNo = sd === 'blue' ? bi + 1 : ri + 1;
      if (sd === 'blue') bi++; else ri++;
      if (!name) continue;
      var owner = null;
      if (sd === side) {
        var am = (s.pickResult && Array.isArray(s.pickResult.assignment)) ? s.pickResult.assignment : [];
        am.forEach(function (a) { if (a && a.hero === name) owner = a; });
      }
      order.push({
        index: i + 1,
        side: sd,
        pickNo: pickNo,
        hero: name,
        ours: sd === side,
        assignedTo: owner ? { playerIndex: owner.playerIndex, name: owner.playerName, mastery: owner.mastery, manual: !!owner.manual } : null,
        owners: sd === side ? ownersOfStore(store, name) : []
      });
    }

    return {
      at: new Date().toISOString(),
      version: 'hok-bp-v2.1',
      dataDate: str(s.health && s.health.date) || str(s.meta && s.meta.version),
      side: side,
      players: (Array.isArray(store.players) ? store.players : []).map(function (p) {
        return {
          id: p.id || null,
          name: p.name,
          preferLanes: (p.preferLanes || []).slice(),
          pool: poolOf(p)
        };
      }),
      bans: { ours: (bans.ours || []).filter(Boolean), theirs: (bans.theirs || []).filter(Boolean) },
      picks: { blue: (picks.blue || []).slice(), red: (picks.red || []).slice() },
      order: order,
      banRecommend: (s.banResult && s.banResult.commands) ? s.banResult.commands : [],
      banWarnings: (s.banResult && s.banResult.warnings) ? s.banResult.warnings : [],
      pickRecommendations: Array.isArray(s.recs) ? s.recs : [],
      lineup: s.lineup || null,
      preset: presetPlanOf(s) || null,
      review: (s.review && s.review.done) ? s.review : null,
      exported: true
    };
  };

  root.HOKAI = HOKAI;
})(typeof self !== 'undefined' ? self : this);
