/* Buddy dashboard v76 — video-style desk pipeline, ticker, logger, kill reasons.
   Driven by state.pipeline (and dashboard fallbacks). Poll ~1–2s via app.js + MQTT. */
(function (root) {
  "use strict";

  var STAGES = [
    { key: "scout",    name: "Scout",    sub: "pump.fun + Raydium…", color: "#3B82F6",
      sources: { scanned: 1, watching: 1, scanner: 1 } },
    { key: "filter",   name: "Filter",   sub: "rug / gates",         color: "#F59E0B",
      sources: { passed_rug: 1, auditor: 1 } },
    { key: "analyst",  name: "Analyst",  sub: "scores",              color: "#8B5CF6",
      sources: { passed_gates: 1, analyst: 1, picked: 1 } },
    { key: "executor", name: "Executor", sub: "size",                color: "#10B981",
      sources: { bought: 1, executor: 1 } },
    { key: "risk",     name: "Risk",     sub: "stop / trail",        color: "#EC4899",
      sources: { sold: 1, risk: 1 } },
    { key: "logger",   name: "Logger",   sub: "feed",                color: "#06B6D4",
      sources: { skipped: 1, logger: 1 } }
  ];
  var STAGE_OF = {};
  STAGES.forEach(function (s) {
    Object.keys(s.sources).forEach(function (k) { STAGE_OF[k] = s.key; });
  });
  /* A coin that is still in flight sits on the furthest stage it has reached. */
  var ADVANCE = ["scout", "filter", "analyst", "executor", "risk"];

  var reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e0) {}

  var logSeen = {};
  var follow = {}; /* mint -> last stage key */
  var eventQ = {}; /* stageKey -> [{html, tone, hold}] */
  var eventHoldUntil = {};
  var eventTimer = 0;
  var tickerSig = "";
  var quotes = {};

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function hm(ts) {
    var t = num(ts); if (t == null) return "";
    return new Date((t > 1e12 ? t : t * 1000)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function cleanSym(s) {
    return String(s || "").replace(/^\$/, "").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim().toUpperCase().slice(0, 12);
  }
  function fmtPx(v) {
    var n = num(v); if (n == null) return "";
    return "$" + (root.BuddyChart ? root.BuddyChart.fmtPrice(n) : String(n));
  }
  function pct(v) {
    var n = num(v); if (n == null) return "";
    return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1) + "%";
  }
  function money(v) {
    var n = num(v); if (n == null) return "—";
    var sign = n < 0 ? "−" : n > 0 ? "+" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function mcap(v) {
    var n = num(v); if (n == null) return "";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
    if (n >= 1000) return "$" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return "$" + Math.round(n);
  }
  function logoTag(item) {
    var letter = (cleanSym(item.symbol || item.name) || "?").charAt(0);
    var src = item.logo || "";
    if (src) {
      return '<span class="pipe-logo"><img src="' + esc(src) + '" alt="" onerror="this.parentNode.classList.add(\'no-img\');this.remove()"/><i>' + esc(letter) + "</i></span>";
    }
    return '<span class="pipe-logo no-img"><i>' + esc(letter) + "</i></span>";
  }

  function pipelineOf(s) {
    if (Array.isArray(s.pipeline) && s.pipeline.length) return s.pipeline;
    if (s.dashboard && Array.isArray(s.dashboard.pipeline)) return s.dashboard.pipeline;
    return [];
  }

  function stageKeyOf(item) {
    var st = String(item && item.stage || "");
    if (STAGE_OF[st]) return STAGE_OF[st];
    return "scout";
  }

  /* ---------- equity: snap numbers, no roll ---------- */
  function renderEquity(s, perf, live) {
    var d = s.dashboard || {};
    var pill = $("#multPill");
    var sub = $("#pnlSub");
    if (!pill) return;
    if (!perf || !perf.known || !perf.start) {
      pill.hidden = true;
      return;
    }
    var x = perf.bal / perf.start;
    pill.hidden = false;
    pill.className = "mult-pill " + (x > 1.0001 ? "up" : x < 0.9999 ? "down" : "flat");
    var w = num(d.wins) || 0, l = num(d.losses) || 0;
    var xe = $("#multX"), we = $("#multW"), le = $("#multL");
    if (xe) xe.textContent = Number(x).toFixed(2) + "x";
    if (we) we.textContent = String(Math.round(w));
    if (le) le.textContent = String(Math.round(l));
    if (sub) sub.textContent = d.since_reset ? "since reset" : (sub.textContent || "");
  }

  /* ---------- ticker: linear RTL scroll, ~6.5s to cross ---------- */
  function renderTicker(s, live) {
    var host = $("#ticker");
    if (!host) return;
    var items = [];
    var have = {};
    function add(sym, px, chg, mint) {
      sym = cleanSym(sym);
      if (!sym || have[sym]) return;
      have[sym] = 1;
      items.push({ symbol: sym, px: px, chg: chg, mint: mint || "" });
      if (mint && px != null) quotes[mint] = { price: px, chg: chg };
    }
    pipelineOf(s).forEach(function (e) { add(e.symbol, e.priceUsd || e.price, e.chg || e.changePct, e.mint); });
    (s.positions || []).forEach(function (p) { add(p.symbol, p.price || p.mark || p.now, p.pnl_pct, p.mint); });
    var dash = (s.dashboard && s.dashboard.ticker) || [];
    dash.forEach(function (t) { add(t.symbol, t.price, t.chg || t.change, t.mint); });
    if (live && Array.isArray(live.positions)) {
      live.positions.forEach(function (p) { add(p.symbol, p.price || p.mark, p.chg, p.mint); });
    }
    if (!items.length) { host.hidden = true; return; }
    host.hidden = false;
    host.setAttribute("aria-label", "Coin prices");
    var sig = items.map(function (x) { return x.symbol + (x.px || "") + (x.chg || ""); }).join("|");
    if (sig === tickerSig && host.querySelector(".tk-track")) return;
    tickerSig = sig;
    var html = items.map(function (x) {
      var ch = num(x.chg);
      var cls = ch == null ? "" : ch >= 0 ? "up" : "down";
      return '<span class="tk-item"><i class="tk-dot" aria-hidden="true"></i><b>$' +
        esc(x.symbol) + "</b> <em>" + esc(fmtPx(x.px) || "—") + '</em> <span class="' + cls + '">' +
        (ch == null ? "" : pct(ch)) + "</span></span>";
    }).join("");
    /* Duplicate the strip so a -50% translate loops seamlessly. */
    host.innerHTML = '<div class="tk-track">' + html + html + "</div>";
  }

  /* ---------- event pill text ---------- */
  function eventText(item, row) {
    var sym = "$" + cleanSym(item.symbol || item.name || "");
    var key = row.key;
    if (item.stage === "skipped" || item.ok === false) {
      var why = String(item.reason || "killed");
      if (key === "filter" || /liq|lp |rug|mint|freeze|unlock/i.test(why)) {
        return { text: sym + " · " + why, tone: "kill", skull: true };
      }
      return { text: sym + " · " + why, tone: "kill", skull: false };
    }
    if (key === "scout") return { text: sym + " new pair", tone: "info" };
    if (key === "filter") return { text: sym + " passed rug", tone: "pass" };
    if (key === "analyst") {
      var sc = num(item.score);
      return { text: "scored " + sym + (sc != null ? " " + Math.round(sc) : ""), tone: "info" };
    }
    if (key === "executor") {
      return { text: "bought " + sym + (item.size ? " " + money(item.size).replace("+", "") : ""), tone: "buy" };
    }
    if (key === "risk") {
      var pnl = num(item.pnl_usd);
      if (item.stage === "sold" || pnl != null) {
        var r = String(item.reason || "sold");
        var tone = pnl != null && pnl >= 0 ? "pass" : "kill";
        return { text: "sold " + sym + " " + r + (pnl != null ? " " + money(pnl) : ""), tone: tone };
      }
      return { text: "stop set " + sym, tone: "idle" };
    }
    return { text: sym, tone: "info" };
  }

  function enqueueEvent(rowKey, ev) {
    if (!eventQ[rowKey]) eventQ[rowKey] = [];
    var q = eventQ[rowKey];
    if (q.length && q[q.length - 1].text === ev.text) return;
    q.push(ev);
    if (q.length > 8) q.shift();
  }

  function tickEvents() {
    if (!homeActive) return;
    var now = Date.now();
    STAGES.forEach(function (row) {
      var slot = document.querySelector('.pipe-row[data-stage="' + row.key + '"] .pipe-events');
      if (!slot) return;
      if (eventHoldUntil[row.key] && now < eventHoldUntil[row.key]) return;
      var q = eventQ[row.key] || [];
      if (!q.length) return;
      var ev = q.shift();
      eventQ[row.key] = q;
      var hold = 300 + Math.min(700, 80 * String(ev.text || "").length);
      eventHoldUntil[row.key] = now + hold;
      var cls = "pipe-pill tone-" + (ev.tone || "info") + (reduceMotion ? "" : " snap-in");
      slot.innerHTML = '<span class="' + cls + '">' +
        (ev.skull ? '<span class="pipe-skull" aria-hidden="true">☠</span> ' : "") +
        esc(ev.text) + "</span>";
    });
  }

  function ensureEventTimer() {
    if (eventTimer || reduceMotion || !homeActive) return;
    eventTimer = window.setInterval(tickEvents, 180);
  }

  function fmtCount(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 10000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
    return n.toLocaleString("en-US");
  }

  function rowBadge(row, counts, s) {
    counts = counts || {};
    if (row.key === "scout") return fmtCount(counts.pairs || 0) + " pairs";
    if (row.key === "filter") {
      var k = counts.killed || 0, pctK = counts.kill_pct;
      return fmtCount(k) + (pctK != null ? " · " + Number(pctK).toFixed(0) + "%" : "");
    }
    if (row.key === "analyst") return fmtCount(counts.scored || 0) + " scored";
    if (row.key === "executor") {
      /* PAPER size from desk settings; REAL is always $3 and never reads the paper value. */
      var isReal = String(s.mode_label || s.mode || "").toUpperCase() === "REAL";
      if (isReal) return "size $3";
      var sz = null;
      try {
        var ds = s.desk_settings || s.settings || {};
        var buy = (ds.mode && ds.mode.values && ds.mode.values.buy_usd) || {};
        sz = num(buy.value);
      } catch (e1) {}
      return sz != null ? ("size $" + (sz % 1 ? sz.toFixed(2) : String(Math.round(sz)))) : "size";
    }
    if (row.key === "risk") {
      try {
        var ds2 = s.desk_settings || s.settings || {};
        var vals = (ds2.mode && ds2.mode.values) || {};
        var stop = num(vals.stop_pct && vals.stop_pct.value);
        var trail = num(vals.trail_start_pct && vals.trail_start_pct.value);
        var parts = [];
        if (stop != null) parts.push("−" + String(stop) + "%");
        if (trail != null) parts.push("trail +" + String(trail) + "%");
        if (parts.length) return parts.join(" · ");
      } catch (e2) {}
      var pill = ((s.dashboard || {}).agents || {}).risk || {};
      return pill.pill || "stop · trail";
    }
    if (row.key === "logger") return fmtCount(counts.reasons || 0) + " reasons";
    return "";
  }

  function barWidth(row, counts) {
    var pairs = Math.max(1, Number(counts && counts.pairs) || 1);
    if (row.key === "filter") return Math.max(8, Math.min(100, Number(counts.kill_pct) || 0));
    if (row.key === "analyst") return Math.max(8, Math.min(100, 100 * (Number(counts.scored) || 0) / pairs));
    if (row.key === "executor") return Math.max(8, Math.min(100, 100 * (Number(counts.buys) || 0) / Math.max(1, Number(counts.scored) || pairs)));
    if (row.key === "scout") return 70;
    if (row.key === "risk") return 40;
    if (row.key === "logger") return 30;
    return 20;
  }

  function latestOn(items, row) {
    var best = null, bestTs = -1;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var k = stageKeyOf(it);
      var hit = (row.key === "logger")
        ? (it.stage === "skipped" || it.stage === "sold")
        : (k === row.key);
      if (!hit) continue;
      var ts = num(it.ts) || 0;
      if (ts >= bestTs) { best = it; bestTs = ts; }
    }
    return best;
  }

  function pillHtml(ev, snap) {
    if (!ev) return "";
    var cls = "pipe-pill tone-" + (ev.tone || "info") + (snap && !reduceMotion ? " snap-in" : "");
    return '<span class="' + cls + '">' +
      (ev.skull ? '<span class="pipe-skull" aria-hidden="true">☠</span> ' : "") +
      esc(ev.text) + "</span>";
  }

  function fallbackPill(row) {
    var text = row.key === "scout" ? "Pump.fun + Raydium…"
      : row.key === "executor" ? "nothing passed yet"
      : row.key === "logger" ? "reason for all"
      : "";
    if (!text) return "";
    return '<span class="pipe-pill tone-idle">' + esc(text) + "</span>";
  }

  function renderAgents(s) {
    var host = $("#deskAgents");
    var card = $("#deskCard");
    if (!host) return;
    if (card) card.hidden = false;
    var items = pipelineOf(s);
    var d = s.dashboard || {};
    var counts = d.pipe_counts || {};
    if (!counts.pairs) {
      counts = {
        pairs: num(d.scanned) || items.length,
        killed: num(d.killed) || 0,
        kill_pct: (num(d.scanned) ? (100 * (num(d.killed) || 0) / d.scanned) : 0),
        scored: ((d.agents || {}).analyst || {}).count || 0,
        buys: num(d.traded) || 0,
        reasons: (d.kill_reasons || []).length
      };
    }
    var title = $("#deskTitle");
    if (title) title.textContent = "Desk · " + STAGES.length + " agents";
    var cnt = $("#deskCounts");
    if (cnt) {
      var traded = counts.buys || 0;
      cnt.innerHTML = (counts.pairs || 0).toLocaleString("en-US") + " scanned · <b class='up'>" + traded + " traded</b>";
    }

    /* Build the six single-line rows once; later ticks only patch bar/count/pill. */
    if (!host.querySelector(".pipe-row")) {
      host.className = "pipe";
      host.innerHTML = STAGES.map(function (row) {
        return '<div class="pipe-row" data-stage="' + row.key + '">' +
          '<span class="pipe-bar bar-' + row.key + '" aria-hidden="true"></span>' +
          '<span class="pipe-icon" style="--pipe-c:' + row.color + '">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            (row.key === "scout" ? '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>' :
             row.key === "filter" ? '<polygon points="3,4 21,4 14,13 14,19 10,21 10,13"/>' :
             row.key === "analyst" ? '<path d="M12 3 4 7v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V7z"/><path d="m9 12 2 2 4-4"/>' :
             row.key === "executor" ? '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' :
             row.key === "risk" ? '<path d="M4 14c3-6 5-6 8-2s5 4 8 2"/><path d="M4 18c3-4 5-4 8 0s5 2 8-2"/>' :
             '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>') +
            "</svg></span>" +
          '<span class="pipe-name">' + esc(row.name) + "</span>" +
          '<span class="pipe-events" aria-live="polite"></span>' +
          '<span class="pipe-count c-' + row.key + '"></span>' +
        "</div>";
      }).join("");
      STAGES.forEach(function (row) {
        var it = latestOn(items, row);
        var slot = host.querySelector('.pipe-row[data-stage="' + row.key + '"] .pipe-events');
        if (!slot) return;
        if (it) slot.innerHTML = pillHtml(eventText(it, row), false);
        else slot.innerHTML = fallbackPill(row);
      });
      items.forEach(function (it) {
        if (it.mint) follow[String(it.mint)] = stageKeyOf(it);
      });
      follow._init = 1;
    }

    STAGES.forEach(function (row) {
      var el = host.querySelector('.pipe-row[data-stage="' + row.key + '"]');
      if (!el) return;
      var bar = el.querySelector(".pipe-bar");
      if (bar) bar.style.width = barWidth(row, counts) + "%";
      var c = el.querySelector(".pipe-count");
      if (c) c.textContent = rowBadge(row, counts, s);
    });

    /* Follow a coin down the rows: enqueue a snap-in pill when its stage changes. */
    items.forEach(function (it) {
      var mint = String(it.mint || "");
      if (!mint) return;
      var rowKey = stageKeyOf(it);
      var prev = follow[mint];
      if (prev !== rowKey) {
        follow[mint] = rowKey;
        if (!follow._init) return;
        var row = STAGES.filter(function (r) { return r.key === rowKey; })[0];
        if (row) enqueueEvent(rowKey, eventText(it, row));
        if (it.stage === "skipped" && prev && prev !== "logger") {
          var diedOn = STAGES.filter(function (r) { return r.key === prev; })[0];
          if (diedOn) enqueueEvent(diedOn.key, eventText(it, diedOn));
        }
      }
    });
    follow._init = 1;
    ensureEventTimer();
    tickEvents();
  }

  /* ---------- logger: insert at top, 0.25s slide+fade ---------- */
  function renderLogger(s) {
    var host = $("#loggerFeed");
    var card = $("#loggerCard");
    if (!host) return;
    var rows = [];
    function add(ts, agent, symbol, text, reason, tone, mint) {
      rows.push({
        ts: num(ts) || 0,
        agent: agent,
        symbol: cleanSym(symbol),
        text: text || "",
        reason: reason || "",
        tone: tone || "idle",
        mint: mint || "",
        id: (ts || "") + "|" + (mint || "") + "|" + (text || "") + "|" + (reason || "")
      });
    }
    var log = (s.dashboard && s.dashboard.log) || [];
    log.forEach(function (r) {
      var agent = r.agent === "scanner" ? "SCOUT" : r.agent === "auditor" ? "FILTER" :
        r.agent === "analyst" ? "ANALYST" : r.agent === "executor" ? "EXECUTOR" :
        r.agent === "risk" ? "RISK" : String(r.agent || "LOG").toUpperCase();
      add(r.ts, agent, r.symbol, r.text, r.reason, r.tone, r.mint);
    });
    pipelineOf(s).forEach(function (e) {
      if (e.stage !== "skipped" && e.stage !== "sold" && e.stage !== "bought") return;
      var agent = e.stage === "bought" ? "EXECUTOR" : e.stage === "sold" ? "RISK" : "FILTER";
      var tone = e.stage === "bought" ? "buy" : (e.stage === "sold" ? ((num(e.pnl_usd) || 0) >= 0 ? "pass" : "kill") : "kill");
      var text = e.stage === "bought" ? "bought" : e.stage === "sold" ? ("sold " + (e.reason || "") + (e.pnl_usd != null ? " " + money(e.pnl_usd) : "")) : ("killed");
      add(e.ts, agent, e.symbol, text, e.reason, tone, e.mint);
    });
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    /* unique by id */
    var seen = {}, uniq = [];
    rows.forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; uniq.push(r); } });
    rows = uniq.slice(0, 40);
    if (!rows.length) { if (card) card.hidden = true; return; }
    if (card) card.hidden = false;
    var killed = $("#loggerKilled");
    if (killed) {
      var kn = (s.dashboard && s.dashboard.killed) || rows.filter(function (r) { return r.tone === "kill"; }).length;
      killed.textContent = kn ? (kn + " killed") : "";
    }
    var first = !host.childElementCount;
    var html = rows.map(function (r, i) {
      var fresh = !first && !logSeen[r.id] && !reduceMotion && i < 6;
      logSeen[r.id] = 1;
      var ag = r.agent.toLowerCase();
      return '<div class="lg-row tone-' + esc(r.tone) + (fresh ? " lg-in" : "") + '">' +
        '<span class="lg-time">' + esc(hm(r.ts)) + "</span>" +
        '<span class="lg-ag ag-' + esc(ag) + '">' + esc(r.agent) + "</span>" +
        '<span class="lg-body">' +
          (r.symbol ? ("$" + esc(r.symbol) + " ") : "") +
          esc(r.text) +
          (r.reason && r.tone === "kill" ? " — " + esc(r.reason) : "") +
        "</span></div>";
    }).join("");
    host.innerHTML = html;
    var killed = $("#loggerKilled");
    if (killed) {
      var n = ((s.dashboard || {}).pipe_counts || {}).killed;
      if (n == null) n = (s.dashboard || {}).killed;
      killed.textContent = n ? (Number(n).toLocaleString("en-US") + " killed") : "";
    }
  }

  /* ---------- why they died: bars snap to width ---------- */
  function renderReasons(s) {
    var card = $("#reasonsCard");
    var list = (s.dashboard && s.dashboard.kill_reasons) || [];
    if (!card) return;
    if (!list.length) { card.hidden = true; return; }
    card.hidden = false;
    var max = 1;
    list.forEach(function (r) { if ((r.count || 0) > max) max = r.count; });
    var target = $("#killReasons") || $("#reasonsBars");
    if (!target) {
      target = document.createElement("div");
      target.id = "killReasons";
      card.appendChild(target);
    }
    target.className = "died-bars kr-list";
    target.innerHTML = list.map(function (r) {
      var w = Math.max(6, Math.round(100 * (r.count || 0) / max));
      var n = Number(r.count || 0).toLocaleString("en-US");
      return '<div class="died-row">' +
        '<span class="died-label">' + esc(r.reason || "Unknown") + "</span>" +
        '<span class="died-n">' + esc(n) + "</span>" +
        '<span class="died-fill" style="width:' + w + '%"></span></div>';
    }).join("");
  }

  /* ---------- public hook used by app.js ---------- */
  function render(s, perf, live) {
    if (!s) return;
    try { renderTicker(s, live); } catch (e) { /* keep the rest of the desk up */ }
    try { renderEquity(s, perf, live); } catch (e2) {}
    try { renderAgents(s); } catch (e3) {}
    try { renderLogger(s); } catch (e4) {}
    try { renderReasons(s); } catch (e5) {}
  }

  var homeActive = true;
  function setActive(on) {
    homeActive = !!on;
    var tk = $("#ticker");
    if (tk) tk.classList.toggle("tk-paused", !homeActive);
    if (!homeActive) {
      if (eventTimer) { window.clearInterval(eventTimer); eventTimer = 0; }
    } else {
      ensureEventTimer();
    }
  }
  function quote(mint) { return quotes[mint] || null; }
  root.BuddyDash = { render: render, quote: quote, setActive: setActive, STAGES: STAGES };
})(window);
