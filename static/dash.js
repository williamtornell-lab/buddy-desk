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
    if (eventTimer || reduceMotion) return;
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
      /* PAPER size from settings; REAL is always $3 and never reads the paper value. */
      var sz = null;
      try {
        var set = s.settings || {};
        var mode = (set.mode && set.mode.values && set.mode.values.buy_usd) || {};
        sz = num(mode.value);
      } catch (e1) {}
      if (String(s.mode_label || s.mode || "").toUpperCase() === "REAL") sz = 3;
      return sz != null ? ("size $" + (sz % 1 ? sz.toFixed(2) : String(sz))) : "size";
    }
    if (row.key === "risk") {
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

  function coinsOnStage(items, row) {
    return items.filter(function (it) {
      var k = stageKeyOf(it);
      if (row.key === "logger") return it.stage === "skipped" || it.stage === "sold";
      return k === row.key;
    }).slice(0, 4);
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
    var liveN = STAGES.length;
    var title = $("#deskTitle");
    if (title) title.textContent = "Desk · " + liveN + " agents";
    var cnt = $("#deskCounts");
    if (cnt) cnt.textContent = (counts.pairs || 0) + " scanned · " + (counts.buys || 0) + " traded";

    /* Enqueue new events when a coin first appears on a stage (follow it down). */
    items.forEach(function (it) {
      var mint = String(it.mint || "");
      if (!mint) return;
      var rowKey = stageKeyOf(it);
      var prev = follow[mint];
      if (prev !== rowKey) {
        follow[mint] = rowKey;
        var row = STAGES.filter(function (r) { return r.key === rowKey; })[0];
        if (row) enqueueEvent(rowKey, eventText(it, row));
        /* Skip / death also flash on the row they died at. */
        if (it.stage === "skipped" && prev && prev !== rowKey) {
          var diedOn = STAGES.filter(function (r) { return r.key === prev; })[0] || row;
          enqueueEvent((diedOn || row).key, eventText(it, diedOn || row));
        }
      }
    });
    ensureEventTimer();
    tickEvents();

    host.className = "pipe";
    host.innerHTML = STAGES.map(function (row) {
      var coins = coinsOnStage(items, row);
      var badge = rowBadge(row, counts, s);
      var bw = barWidth(row, counts);
      var coinHtml = coins.map(function (it) {
        var arrived = follow[it.mint] === row.key && !reduceMotion;
        var metric = "";
        if (it.marketCap) metric = "mcap " + mcap(it.marketCap);
        if (row.key === "analyst" && it.score != null) metric = "score " + Math.round(Number(it.score));
        if (row.key === "executor" && it.bot) metric = it.bot;
        if (row.key === "risk" && it.pnl_usd != null) metric = money(it.pnl_usd);
        if (it.stage === "skipped") metric = String(it.reason || "killed");
        var dead = it.stage === "skipped" || it.ok === false;
        return '<span class="pipe-coin' + (arrived ? " slide-in" : "") + (dead ? " is-kill" : "") +
          '" data-mint="' + esc(it.mint) + '">' + logoTag(it) +
          "<b>$" + esc(cleanSym(it.symbol)) + "</b>" +
          (metric ? '<em>' + esc(metric) + "</em>" : "") + "</span>";
      }).join("");
      var tone = row.key === "filter" ? "filter" : row.key;
      return '<div class="pipe-row" data-stage="' + row.key + '">' +
        '<span class="pipe-bar bar-' + tone + '" style="width:' + bw + '%" aria-hidden="true"></span>' +
        '<span class="pipe-icon" style="--pipe-c:' + row.color + '">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          (row.key === "scout" ? '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>' :
           row.key === "filter" ? '<polygon points="3,4 21,4 14,13 14,19 10,21 10,13"/>' :
           row.key === "analyst" ? '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>' :
           row.key === "executor" ? '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' :
           row.key === "risk" ? '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>' :
           '<path d="M5 5h14v14H5z"/><path d="M8 9h8M8 13h5"/>') +
          "</svg></span>" +
        '<div class="pipe-meta"><strong>' + esc(row.name) + "</strong><span>" + esc(row.sub) + "</span></div>" +
        '<div class="pipe-events" aria-live="polite"></div>' +
        '<div class="pipe-coins">' + coinHtml + "</div>" +
        '<span class="pipe-count c-' + row.key + '">' + esc(badge) + "</span>" +
      "</div>";
    }).join("");
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
  }

  /* ---------- why they died: bars snap to width ---------- */
  function renderReasons(s) {
    var host = $("#killReasons") || $("#reasonsBars");
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
      target.className = "died-bars";
      card.appendChild(target);
    }
    target.className = "died-bars kr-list";
    target.innerHTML = list.map(function (r) {
      var w = Math.max(8, Math.round(100 * (r.count || 0) / max));
      return '<div class="died-row"><span class="died-fill" style="width:' + w + '%"></span>' +
        '<span class="died-label">' + esc(r.reason || "Unknown") + " · " + esc(r.count) + "</span></div>";
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

  function quote(mint) { return quotes[mint] || null; }
  root.BuddyDash = { render: render, quote: quote, STAGES: STAGES };
})(window);
