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
  var hooks = { requestSwitch: null, toast: null };

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
    if (/long/i.test(l)) return "Long term";
    if (/scalp/i.test(l)) return "Scalping";
    if (/passive/i.test(l)) return "Passive";
    if (/adaptive/i.test(l)) return "Adaptive";
    return l.length > 12 ? l.slice(0, 11) + "…" : l;
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
  function tagHtml(t, s) {
    if (root.BuddyCopy) { var ch = root.BuddyCopy.tagHtml(t); if (ch) return ch; }
    var n = tradeModeName(t);
    if (!n || RESERVED[n]) return "";
    var list = modesOf(s);
    var m = null;
    for (var i = 0; i < list.length; i++) if (list[i].name === n) m = list[i];
    var label = m ? shortLabel(m) : n.replace(/_/g, " ");
    return '<span class="style-tag st-' + esc(n) + '">' + esc(label) + "</span>";
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

    $("#styleActive").textContent = view.pending ? "Switching…" : (active ? active.label : "Not set");
    $("#styleActive").className = "style-active" + (view.pending ? " pending" : "");
    var seg = $("#styleSeg");
    seg.innerHTML = list.map(function (m) {
      var cls = (m.name === shown.name ? " on" : "") + (m.name === activeName ? " live" : "");
      return '<button type="button" class="' + cls.trim() + '" data-style="' + esc(m.name) + '" aria-pressed="' + (m.name === shown.name) + '">' +
        esc(shortLabel(m)) + "</button>";
    }).join("");
    var rows = ruleRows(shown.rules);
    var isActive = shown.name === activeName;
    var html = '<div class="style-desc">' +
      '<p class="style-name">' + esc(shown.label) + (isActive ? ' <span class="style-on">active</span>' : "") + "</p>" +
      (shown.description ? '<p class="style-text">' + esc(shown.description) + "</p>" : "") + "</div>";
    if (rows.length) {
      html += '<details class="style-rules"' + (view.open ? " open" : "") + "><summary>How it trades</summary><dl>" +
        rows.map(function (r) {
          return "<div>" + (r[0] ? "<dt>" + esc(r[0]) + "</dt>" : "<dt></dt>") + "<dd>" + esc(r[1]) + "</dd></div>";
        }).join("") + "</dl></details>";
    }
    if (!isActive) {
      html += '<button type="button" class="style-use" data-style-use="' + esc(shown.name) + '"' + (view.pending ? " disabled" : "") + ">" +
        "Use " + esc(shown.label) + "</button>" +
        '<p class="style-note">Applies to new trades only. Open trades keep their rules.</p>';
    }
    $("#styleBody").innerHTML = html;
  }

  function onClick(e, s) {
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
    var d = e.target.closest(".style-rules summary");
    if (d) { view.open = !d.parentNode.open; return false; }
    return false;
  }

  function markPending(name) { view.pending = name; view.pendingAt = Date.now(); }

  root.BuddyStyles = {
    modesOf: modesOf, activeOf: activeOf, ruleRows: ruleRows, sizeText: sizeText,
    tradeModeName: tradeModeName, tagHtml: tagHtml, render: render, onClick: onClick,
    markPending: markPending, hooks: hooks, RESERVED: RESERVED
  };
})(typeof window !== "undefined" ? window : globalThis);
