/* Buddy trading-mode selector (Scalping / Aggressive / Long term / Passive).
   Reads state.active_mode + state.modes. Switching only asks the desk via a hook
   that app.js wires to its confirm dialog; this file never posts anything itself. */
(function (root) {
  "use strict";
  var ORDER = ["scalping", "aggressive_short", "aggressive", "aggressive_short_term", "short_term", "long_term", "longterm", "passive", "adaptive"];
  var RESERVED = { paper: 1, p: 1, live: 1, real: 1, l: 1, r: 1 };
  var RULE_LABEL = {
    entries: "Entries", entry: "Entry", size: "Size", size_usd: "Size", ticket: "Size", ticket_usd: "Size",
    adds: "Adds", add: "Adds", tps: "Take profits", tp: "Take profits", take_profits: "Take profits", take_profit: "Take profits",
    stop: "Stop", stop_pct: "Stop", stop_loss: "Stop", trail: "Trail", trail_pct: "Trail", trailing: "Trail",
    max_hold: "Max hold", max_hold_h: "Max hold", max_hold_min: "Max hold", hold: "Max hold",
    max_open: "Max open", max_positions: "Max open", exits: "Exits", filters: "Filters"
  };
  var RULE_ORDER = ["entries", "entry", "filters", "size", "size_usd", "ticket", "ticket_usd", "adds", "add", "tps", "tp",
    "take_profits", "take_profit", "stop", "stop_pct", "stop_loss", "trail", "trail_pct", "trailing", "exits",
    "max_hold", "max_hold_h", "max_hold_min", "hold", "max_open", "max_positions"];

  var view = { preview: null, pending: null, pendingAt: 0, lastActive: null };
  var hooks = { requestSwitch: null, toast: null, requestSub: null, confirm: null };
  var subPending = {};
  var edits = {}; // "bot:key" -> number
  var EXIT_ORDER = ["tp1_pct", "tp1_frac", "tp2_pct", "tp2_frac", "tp3_pct", "tp3_frac", "trail_start_pct", "trail_pct", "stop_pct"];
  var EXIT_LABEL = {
    tp1_pct: "TP1", tp1_frac: "TP1 sell", tp2_pct: "TP2", tp2_frac: "TP2 sell",
    tp3_pct: "TP3", tp3_frac: "TP3 sell", trail_start_pct: "Trail start", trail_pct: "Trail", stop_pct: "Stop"
  };
  var EXIT_STEP = { tp1_pct: 1, tp2_pct: 1, tp3_pct: 1, tp1_frac: 0.05, tp2_frac: 0.05, tp3_frac: 0.05,
    trail_start_pct: 1, trail_pct: 0.5, stop_pct: 0.5 };

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function keyOf(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/[\s-]+/g, "_"); }

  /* Normalise state.modes (object map or array) into an ordered list. */
  function modesOf(s) {
    var raw = s && s.modes;
    if (!raw || typeof raw !== "object") return [];
    var list = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (m) { if (m && typeof m === "object") list.push(m); });
    } else {
      Object.keys(raw).forEach(function (k) {
        var m = raw[k];
        if (m && typeof m === "object") list.push(Object.assign({ name: k }, m));
      });
    }
    list = list.map(function (m) {
      var name = keyOf(m.name || m.key || m.id || m.mode || "");
      return {
        name: name,
        label: String(m.label || m.title || m.display || name.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); })),
        short: String(m.short || m.short_label || ""),
        description: String(m.description || m.desc || m.summary || ""),
        rules: m.rules != null ? m.rules : (m.algorithm != null ? m.algorithm : deskRules(m)),
        raw: m
      };
    }).filter(function (m) { return m.name && !RESERVED[m.name]; });
    list.sort(function (a, b) {
      var ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  function activeOf(s, list) {
    var a = s && s.active_mode;
    if (a && typeof a === "object") a = a.name || a.key || a.mode;
    a = keyOf(a);
    for (var i = 0; i < list.length; i++) if (list[i].name === a) return list[i];
    return null;
  }

  function shortLabel(m) {
    if (m.short) return m.short;
    var l = m.label;
    if (/aggressive/i.test(l)) return "Aggressive";
    if (/long/i.test(l)) return "Long";
    if (/scalp/i.test(l)) return "Scalp";
    if (/passive/i.test(l)) return "Passive";
    if (/adaptive/i.test(l)) return "Adaptive";
    return l.length > 12 ? l.slice(0, 11) + "…" : l;
  }

  /* One short line of key numbers: "$20 · TP +10% · Stop −3% · 8 min". */
  function keyLine(m) {
    var r = (m && m.raw) || {}, bits = [];
    var sz = r.size && typeof r.size === "object" ? r.size : null;
    if (sz && sz.buy_usd != null) {
      var adds = Array.isArray(sz.adds) ? sz.adds : [];
      bits.push(usd(sz.buy_usd) + adds.map(function (a) { return "+" + usd(a.usd); }).join(""));
    }
    if (Array.isArray(r.tps) && r.tps.length && r.tps[0].pct != null) bits.push("TP +" + pctTxt(r.tps[0].pct));
    if (r.stop_pct != null) bits.push("Stop \u2212" + pctTxt(r.stop_pct));
    if (r.max_hold) bits.push(String(r.max_hold));
    else if (r.max_hold_s != null) bits.push(Math.round(r.max_hold_s / 60) + " min");
    return bits.join(" · ");
  }

  function usd(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (n >= 1000) return "$" + (n / 1000).toFixed(n % 1000 ? 1 : 0) + "K";
    return "$" + (n % 1 ? n.toFixed(2) : String(n));
  }
  function pctTxt(v) { var n = Number(v); return Number.isFinite(n) ? (n % 1 ? n.toFixed(1) : String(n)) + "%" : ""; }
  function words(k) { return String(k || "").replace(/_/g, " "); }

  /* The desk's paper_modes export keeps rules as top-level fields. */
  function deskRules(m) {
    if (!m || (m.size == null && m.tps == null && m.stop_pct == null && m.entries == null)) return null;
    var rows = [];
    var e = m.entries || {};
    if (e && typeof e === "object") {
      var bits = [];
      if (e.style) bits.push(words(e.style).replace(/^\w/, function (c) { return c.toUpperCase(); }));
      if (e.min_liquidity_usd != null) bits.push("liquidity ≥ " + usd(e.min_liquidity_usd));
      if (e.min_pool_age_min != null) bits.push("pool age ≥ " + e.min_pool_age_min + "m");
      if (e.min_m5_buys != null) bits.push("≥ " + e.min_m5_buys + " buys / 5m");
      if (e.min_m5_buy_share != null) bits.push("buy share ≥ " + Math.round(Number(e.min_m5_buy_share) * 100) + "%");
      if (e.min_score != null) bits.push("score ≥ " + e.min_score);
      if (e.max_h1_change_pct_entry != null) bits.push("1h rise ≤ " + pctTxt(e.max_h1_change_pct_entry));
      if (e.prefer_graduated) bits.push("graduated coins");
      if (e.allow_early_momentum) bits.push("early momentum allowed");
      rows.push(["Entries", bits.join(" · ")]);
    } else if (e) rows.push(["Entries", String(e)]);
    var sz = m.size || {};
    if (typeof sz === "object" && sz.buy_usd != null) {
      rows.push(["Size", usd(sz.buy_usd) + " buy" + (sz.max_size_usd != null && Number(sz.max_size_usd) > Number(sz.buy_usd) ? " · max " + usd(sz.max_size_usd) : "")]);
    } else if (sz != null && typeof sz !== "object") rows.push(["Size", String(sz)]);
    var adds = Array.isArray(m.adds) ? m.adds : (sz && Array.isArray(sz.adds) ? sz.adds : []);
    rows.push(["Adds", adds.length ? adds.map(function (a) { return "+" + usd(a.usd) + " at +" + pctTxt(a.at_pct); }).join(" · ") : "None"]);
    if (Array.isArray(m.tps) && m.tps.length) {
      rows.push(["Take profits", m.tps.map(function (t) { return t.label || ("+" + pctTxt(t.pct) + " " + words(t.action)); }).join(" · ")]);
    }
    if (m.stop_pct != null) rows.push(["Stop", "−" + pctTxt(m.stop_pct)]);
    var tr = m.trail || {};
    rows.push(["Trail", tr.pct != null ? pctTxt(tr.pct) + (tr.start_pct != null ? " after +" + pctTxt(tr.start_pct) : "") : "None"]);
    if (m.max_hold || m.max_hold_s != null) rows.push(["Max hold", m.max_hold || (Math.round(m.max_hold_s / 60) + "m")]);
    if (m.max_open != null) rows.push(["Max open", String(m.max_open) + " trades"]);
    var ss = m.shared_safety || {};
    var sb = [];
    if (ss.max_top10_pct != null) sb.push("top-10 ≤ " + pctTxt(ss.max_top10_pct));
    if (ss.max_h1_change_pct != null) sb.push("1h rise ≤ " + pctTxt(ss.max_h1_change_pct));
    if (ss.rug_mint_lp_checks) sb.push("rug / mint / LP checks");
    if (sb.length) rows.push(["Safety", sb.join(" · ") + " (all modes)"]);
    return rows.map(function (r) { return { label: r[0], value: r[1] }; });
  }

  function fmtVal(v) {
    if (v == null || v === "") return "";
    if (Array.isArray(v)) return v.map(fmtVal).filter(Boolean).join(" · ");
    if (typeof v === "object") {
      if (v.text || v.label || v.summary) return String(v.text || v.label || v.summary);
      return Object.keys(v).map(function (k) {
        var x = fmtVal(v[k]);
        return x === "" ? "" : k.replace(/_/g, " ") + " " + x;
      }).filter(Boolean).join(" · ");
    }
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  }

  function ruleRows(rules) {
    if (rules == null) return [];
    if (typeof rules === "string") return [["", rules]];
    if (Array.isArray(rules)) {
      return rules.map(function (r) {
        if (r && typeof r === "object" && !Array.isArray(r) && (r.label || r.name || r.key) && (r.value != null || r.text != null)) {
          return [String(r.label || r.name || r.key), fmtVal(r.value != null ? r.value : r.text)];
        }
        return ["", fmtVal(r)];
      }).filter(function (r) { return r[1]; });
    }
    var keys = Object.keys(rules);
    keys.sort(function (a, b) {
      var ia = RULE_ORDER.indexOf(a), ib = RULE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map(function (k) {
      var label = RULE_LABEL[k] || k.replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
      return [label, fmtVal(rules[k])];
    }).filter(function (r) { return r[1]; });
  }

  /* Size for the equity subline: number -> "$20 size", string -> as given. */
  function sizeText(m) {
    if (!m) return "";
    var raw = m.raw || {};
    if (raw.size && typeof raw.size === "object" && raw.size.buy_usd != null) {
      var b = Number(raw.size.buy_usd), mx = Number(raw.size.max_size_usd);
      if (Number.isFinite(b)) return usd(b) + " size";
    }
    var r = m.rules && typeof m.rules === "object" && !Array.isArray(m.rules) ? m.rules : {};
    var v = r.size != null ? r.size : (r.size_usd != null ? r.size_usd : (r.ticket_usd != null ? r.ticket_usd : (m.raw && (m.raw.size_usd != null ? m.raw.size_usd : m.raw.size))));
    if (v == null || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return "$" + (v % 1 ? v.toFixed(2) : String(v)) + " size";
    if (typeof v === "object") v = fmtVal(v);
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return "$" + s + " size";
    return s.length > 28 ? s.slice(0, 27) + "…" : s;
  }

  /* Mode tag for a trade/position row, whatever the backend calls it. */
  function tradeModeName(t) {
    if (!t) return "";
    var v = t.trading_mode || t.paper_mode || t.trade_mode || t.style || t.mode_name || t.strategy_mode || "";
    if (!v && t.entry_context) {
      var ctx = t.entry_context;
      if (typeof ctx === "string") { try { ctx = JSON.parse(ctx); } catch (e) { ctx = null; } }
      if (ctx && ctx.paper_mode) v = ctx.paper_mode;
    }
    if (!v && typeof t.strategy === "string" && t.strategy.indexOf("paper_mode:") === 0) v = t.strategy.slice(11);
    if (v && typeof v === "object") v = v.name || v.label || "";
    return keyOf(v);
  }
  function flagTags(t) {
    var bits = [];
    var ctx = t && t.entry_context;
    if (typeof ctx === "string") { try { ctx = JSON.parse(ctx); } catch (e) { ctx = null; } }
    ctx = ctx || {};
    if ((t && t.proven) || ctx.proven) bits.push('<span class="style-tag st-proven">proven</span>');
    if ((t && t.surge) || ctx.surge) bits.push('<span class="style-tag st-surge">surge</span>');
    if ((t && t.trending) || ctx.trending) bits.push('<span class="style-tag st-trending">trending</span>');
    return bits.join("");
  }
  function tagHtml(t, s) {
    var extra = flagTags(t);
    if (root.BuddyCopy) { var ch = root.BuddyCopy.tagHtml(t); if (ch) return ch + extra; }
    var sbt = subTag(t); if (sbt) return sbt + extra;
    var n = tradeModeName(t);
    var modeTag = "";
    if (n && !RESERVED[n]) {
      var list = modesOf(s);
      var m = null;
      for (var i = 0; i < list.length; i++) if (list[i].name === n) m = list[i];
      var label = m ? shortLabel(m) : n.replace(/_/g, " ");
      modeTag = '<span class="style-tag st-' + esc(n) + '">' + esc(label) + "</span>";
    }
    return modeTag + extra;
  }

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function fmtExit(k, v) {
    var n = num(v);
    if (n == null) return "—";
    if (k.indexOf("_frac") >= 0) return Math.round(n * 100) + "%";
    if (k === "stop_pct" || k === "trail_pct") return "−" + (n % 1 ? n.toFixed(1) : String(n)) + "%";
    if (k === "trail_start_pct" || k.indexOf("_pct") >= 0) return "+" + (n % 1 ? n.toFixed(1) : String(n)) + "%";
    return String(n);
  }
  function botsOf(s) { return (s && s.desk_settings && s.desk_settings.bots) || {}; }
  function exitSpec(s, bot, k) {
    var b = botsOf(s)[bot];
    return b && b.values ? b.values[k] : null;
  }
  function dirtyIds(s) {
    return Object.keys(edits).filter(function (id) {
      var p = id.split(":"), sp = exitSpec(s, p[0], p[1]);
      return sp && Math.abs(edits[id] - num(sp.value)) > 1e-9;
    });
  }
  function stepper(bot, k, spec) {
    var id = bot + ":" + k;
    var v = edits[id] != null ? edits[id] : num(spec.value);
    var changed = edits[id] != null && Math.abs(edits[id] - num(spec.value)) > 1e-9;
    var lo = num(spec.lo), hi = num(spec.hi);
    return '<div class="set-row bot-exit-row"><div class="set-txt"><span class="set-name">' + esc(EXIT_LABEL[k] || k) + "</span></div>" +
      '<div class="stp"><button type="button" data-bot-stp="' + esc(id) + '" data-d="-1"' + (v <= lo + 1e-9 ? " disabled" : "") + ' aria-label="Lower">−</button>' +
      '<span class="stp-v' + (changed ? " changed" : "") + '">' + esc(fmtExit(k, v)) + "</span>" +
      '<button type="button" data-bot-stp="' + esc(id) + '" data-d="1"' + (v >= hi - 1e-9 ? " disabled" : "") + ' aria-label="Higher">+</button></div></div>';
  }
  function editorBlock(s, bot) {
    var info = botsOf(s)[bot];
    if (!info || !info.values) return "";
    var keys = EXIT_ORDER.filter(function (k) { return info.values[k]; });
    if (!keys.length) return "";
    var rows = keys.map(function (k) { return stepper(bot, k, info.values[k]); }).join("");
    return '<div class="bot-exits" data-bot-exits="' + esc(bot) + '"><p class="set-group">' + esc(info.label || bot) +
      ' <span class="muted">New trades only · −8% hard stop stays</span></p>' + rows + "</div>";
  }
  function editorsHtml(s, shown) {
    if (!shown) return "";
    var html = editorBlock(s, shown.name);
    if (shown.name === "scalping") {
      ["quick", "runner", "moonshot"].forEach(function (b) { html += editorBlock(s, b); });
    }
    var dirty = dirtyIds(s);
    if (html) {
      html += '<button type="button" class="set-btn" data-bot-save' + (dirty.length ? "" : " disabled") + ">Save exit settings</button>";
    }
    return html ? '<div class="bot-exits-wrap">' + html + "</div>" : "";
  }

  function render(s) {
    var card = $("#styleCard");
    if (!card) return;
    var list = modesOf(s);
    if (!list.length) { card.hidden = true; return; }
    card.hidden = false;
    var active = activeOf(s, list);
    var activeName = active ? active.name : "";
    if (view.pending && (view.pending === activeName || Date.now() - view.pendingAt > 90000)) {
      if (view.pending === activeName && hooks.toast) hooks.toast(active.label + " mode active · new trades only");
      view.pending = null;
    }
    if (view.lastActive !== activeName) { view.preview = null; view.lastActive = activeName; }
    var shown = null;
    for (var i = 0; i < list.length; i++) if (list[i].name === view.preview) shown = list[i];
    if (!shown) shown = active || list[0];

    $("#styleActive").textContent = view.pending ? "Switching…" : "";
    $("#styleActive").className = "style-active" + (view.pending ? " pending" : "");
    var seg = $("#styleSeg");
    seg.innerHTML = list.map(function (m) {
      var cls = (m.name === shown.name ? " on" : "") + (m.name === activeName ? " live" : "");
      return '<button type="button" class="' + cls.trim() + '" data-style="' + esc(m.name) + '" aria-pressed="' + (m.name === shown.name) + '"' +
        ' title="' + esc(m.label) + '">' + esc(shortLabel(m)) + "</button>";
    }).join("");
    var rows = ruleRows(shown.rules);
    var isActive = shown.name === activeName;
    var line = keyLine(shown) || shown.label;
    var html = '<div class="style-line-row"><button type="button" class="style-line' + (view.open ? " open" : "") + '" data-style-more aria-expanded="' + !!view.open + '">' +
      '<span class="style-key">' + esc(line) + "</span></button>";
    if (!isActive) {
      html += '<button type="button" class="style-use" data-style-use="' + esc(shown.name) + '"' + (view.pending ? " disabled" : "") + ">Use</button>";
    }
    html += "</div>";
    if (view.open) {
      html += '<div class="style-more">' + (shown.description ? '<p class="style-text">' + esc(shown.description) + "</p>" : "") +
        (rows.length ? "<dl>" + rows.map(function (r) {
          return "<div><dt>" + esc(r[0] || "") + "</dt><dd>" + esc(r[1]) + "</dd></div>";
        }).join("") + "</dl>" : "") + editorsHtml(s, shown) + "</div>";
    }
    var subs = s && s.scalp_subs;
    if (isActive && shown.name === "scalping" && subs && typeof subs === "object") {
      html += '<div class="sub-rows">' + ["quick", "runner", "moonshot"].filter(function (k) { return subs[k]; }).map(function (k) {
        var b = subs[k];
        var on = !!b.enabled;
        var p = subPending[k];
        if (p && (p.on === on || Date.now() - p.at > 90000)) { delete subPending[k]; p = null; }
        var shownOn = p ? p.on : on;
        var openN = Number(b.open) || 0;
        return '<div class="sub-row"><span class="sub-name">' + esc(b.label || k) + '<span class="sub-line"> · ' + esc(b.line || "") + "</span></span>" +
          (shownOn && openN ? '<span class="sub-open">' + openN + " open</span>" : "") +
          '<button type="button" class="cr-switch mini' + (shownOn ? " on" : "") + (p ? " busy" : "") + '" role="switch" aria-checked="' + on + '"' +
          ' aria-label="' + esc(b.label || k) + '" data-sub="' + esc(k) + '" data-sub-on="' + (on ? "1" : "0") + '"' + (p ? " disabled" : "") +
          '><span class="cr-knob"></span></button></div>';
      }).join("") + "</div>";
    }
    $("#styleBody").innerHTML = html;
  }

  function subTag(t) {
    var sb = t && t.sub_bot;
    if (!sb) {
      var m = String((t && t.strategy) || "").match(/^paper_mode:scalping:(quick|runner|moonshot)$/);
      if (m) sb = m[1];
    }
    if (!sb && t && typeof t.pos_key === "string" && t.pos_key.indexOf("~") > 0) sb = t.pos_key.split("~")[1];
    return sb ? '<span class="style-tag st-scalping">Scalp · ' + esc(sb.charAt(0).toUpperCase() + sb.slice(1)) + "</span>" : "";
  }

  function onClick(e, s) {
    var sw = e.target.closest("[data-sub]");
    if (sw) {
      if (!sw.disabled && hooks.requestSub) hooks.requestSub({ sub: sw.getAttribute("data-sub"), on: sw.getAttribute("data-sub-on") !== "1" });
      return true;
    }
    var b = e.target.closest("[data-style]");
    if (b) { view.preview = b.getAttribute("data-style"); render(s); return true; }
    var u = e.target.closest("[data-style-use]");
    if (u) {
      var name = u.getAttribute("data-style-use");
      var list = modesOf(s), m = null;
      for (var i = 0; i < list.length; i++) if (list[i].name === name) m = list[i];
      if (!m || RESERVED[m.name] || !hooks.requestSwitch) return true;
      hooks.requestSwitch({ name: m.name, label: m.label });
      return true;
    }
    var d = e.target.closest("[data-style-more]");
    if (d) { view.open = !view.open; render(s); return true; }
    var st = e.target.closest("[data-bot-stp]");
    if (st) {
      var id = st.getAttribute("data-bot-stp"), dlt = Number(st.getAttribute("data-d"));
      var parts = id.split(":"), sp = exitSpec(s, parts[0], parts[1]);
      if (!sp) return true;
      var cur = edits[id] != null ? edits[id] : num(sp.value);
      var step = EXIT_STEP[parts[1]] || 0.5;
      var nv = Math.round((cur + dlt * step) * 100) / 100;
      nv = Math.min(num(sp.hi), Math.max(num(sp.lo), nv));
      edits[id] = nv;
      render(s);
      return true;
    }
    if (e.target.closest("[data-bot-save]")) {
      var ids = dirtyIds(s);
      if (!ids.length || !hooks.confirm) return true;
      var lines = ids.map(function (i) { var p = i.split(":"); return (EXIT_LABEL[p[1]] || p[1]) + " (" + (botsOf(s)[p[0]] || {}).label + ") → " + fmtExit(p[1], edits[i]); });
      hooks.confirm({
        title: "Save " + ids.length + " exit setting" + (ids.length > 1 ? "s" : "") + "?",
        body: lines.join(" · ") + ". Applies to new PAPER and REAL trades. The −8% hard stop and rug checks stay as they are.",
        ok: "Save",
        cmds: ids.map(function (i) { var p = i.split(":"); return "set:" + p[0] + ":" + p[1] + "=" + edits[i]; }),
        toast: "Settings sent",
        after: function () { window.setTimeout(function () { edits = {}; }, 4000); }
      });
      return true;
    }
    return false;
  }

  function markPending(name) { view.pending = name; view.pendingAt = Date.now(); }
  function markSubPending(sub, on) { subPending[sub] = { on: !!on, at: Date.now() }; }

  root.BuddyStyles = {
    modesOf: modesOf, activeOf: activeOf, ruleRows: ruleRows, sizeText: sizeText,
    tradeModeName: tradeModeName, tagHtml: tagHtml, render: render, onClick: onClick,
    markPending: markPending, markSubPending: markSubPending, hooks: hooks, RESERVED: RESERVED
  };
})(typeof window !== "undefined" ? window : globalThis);
