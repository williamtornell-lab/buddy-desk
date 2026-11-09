/* Buddy dashboard blocks: ticker, equity pill, desk agents, logger, kill reasons.
   Reads state.json only (state.dashboard is exported read-only by the desk). */
(function (root) {
  "use strict";
  var AGENTS = [
    { key: "scanner", name: "Scanner", sub: "new pairs", color: "#67e8f9", icon: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>' },
    { key: "auditor", name: "Auditor", sub: "safety layers", color: "#ffd60a", icon: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/>' },
    { key: "analyst", name: "Analyst", sub: "momentum score", color: "#A78BFA", icon: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>' },
    { key: "executor", name: "Executor", sub: "PAPER buys", color: "#30d158", icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
    { key: "risk", name: "Risk", sub: "stops & exits", color: "#ff453a", icon: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>' },
    { key: "early_momentum", name: "Momentum", sub: "$25k–$200k caps", color: "#ff6ec7", icon: '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>' },
    { key: "fomo_holdings", name: "Wallet", sub: "FOMO · read only", color: "#5ac8fa", icon: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/>' }
  ];
  var COLORS = {};
  AGENTS.forEach(function (a) { COLORS[a.key] = a.color; });

  var seen = {};
  var logSeen = {};
  var firstPaint = true;
  var tickerQuotes = {};
  var tickerMints = [];
  var tickerSig = "";

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function hm(ts) {
    var t = num(ts); if (t == null) return "";
    return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function money(v) {
    var n = num(v); if (n == null) return "—";
    return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function cleanSym(s) { return String(s || "").replace(/^\$/, "").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim().toUpperCase().slice(0, 12); }
  function fmtPx(v) {
    var n = num(v); if (n == null) return "";
    return "$" + (root.BuddyChart ? root.BuddyChart.fmtPrice(n) : String(n));
  }
  function pct(v) {
    var n = num(v); if (n == null) return "";
    return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1) + "%";
  }

  /* ---------- 2) equity pill ---------- */
  function renderEquity(s, perf, live) {
    var d = s.dashboard || {};
    var pill = $("#multPill");
    var sub = $("#pnlSub");
    if (!pill) return;
    if (live || !perf || !perf.known || !perf.start) {
      pill.hidden = true;
      return;
    }
    var x = perf.bal / perf.start;
    pill.hidden = false;
    pill.className = "mult-pill " + (x > 1.0001 ? "up" : x < 0.9999 ? "down" : "flat");
    var w = num(d.wins) || 0, l = num(d.losses) || 0;
    var tw = root.BuddySpark ? root.BuddySpark.tween : function (el, v, f) { if (el) el.textContent = f(v); };
    tw($("#multX"), x, function (v) { return Number(v).toFixed(2) + "x"; });
    tw($("#multW"), w, function (v) { return String(Math.round(v)); });
    tw($("#multL"), l, function (v) { return String(Math.round(v)); });
    if (sub) {
      var set = s.settings || {};
      var bits = ["Equity", money(perf.start) + (d.since_reset ? " at reset" : " start")];
      var styleSize = "";
      if (root.BuddyStyles) {
        var ml = root.BuddyStyles.modesOf(s);
        styleSize = root.BuddyStyles.sizeText(root.BuddyStyles.activeOf(s, ml));
      }
      var tk = num(set.min_ticket_usd);
      if (styleSize) bits.push(styleSize);
      else if (tk != null) bits.push(money(tk).replace(".00", "") + " size");
      sub.textContent = bits.join(" · ");
    }
  }

  /* ---------- 3) desk agents ---------- */
  function agentTone(a) {
    if (!a || a.paused) return "bad";
    var age = num(a.age_s);
    if (age == null || age > 120) return "bad";
    return "ok";
  }

  function renderAgents(s) {
    var host = $("#deskAgents");
    if (!host) return;
    var d = s.dashboard || {};
    var hb = s.agents || {};
    var dash = d.agents || {};
    var list = AGENTS.filter(function (a) { return hb[a.key] || dash[a.key]; });
    $("#deskTitle").textContent = "Desk · " + list.length + " agents";
    $("#deskCounts").textContent = (num(d.scanned) || 0) + " scanned · " + (num(d.traded) || 0) + " traded";
    var html = list.map(function (a) {
      var info = dash[a.key] || {};
      var tone = agentTone(hb[a.key]);
      var sym = cleanSym(info.symbol);
      var txt = (sym ? "$" + sym + " " : "") + (info.text || "");
      var key = a.key + "|" + (info.ts || "") + "|" + txt;
      var fresh = !firstPaint && seen[a.key] !== undefined && seen[a.key] !== key;
      seen[a.key] = key;
      var stale = tone === "bad";
      var age = hb[a.key] ? num(hb[a.key].age_s) : null;
      var status = stale ? (hb[a.key] && hb[a.key].paused ? "paused" : (age == null ? "no heartbeat" : "stale")) : a.sub;
      return '<div class="dk-row' + (stale ? " stale" : "") + '">' +
        '<span class="dk-icon" style="--c:' + a.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + a.icon + "</svg>" +
        '<i class="dk-dot ' + tone + '"></i></span>' +
        '<span class="dk-name"><b>' + esc(a.name) + '</b><small>' + esc(status) + "</small></span>" +
        '<span class="dk-act tone-' + esc(info.tone || "idle") + (fresh ? " flash" : "") + '"' +
        (info.mint ? ' data-mint="' + esc(info.mint) + '"' : "") + ">" + esc(txt) + "</span>" +
        (stale
          ? '<button type="button" class="restart-btn need dk-pill" data-restart="' + esc(a.key) + '">Restart</button>'
          : '<span class="dk-pill" style="--c:' + a.color + '">' + esc(info.pill || "") + "</span>") +
        "</div>";
    }).join("");
    host.innerHTML = html || '<p class="quiet">No agent data yet.</p>';
  }

  /* ---------- 4) logger ---------- */
  function renderLogger(s) {
    var host = $("#loggerFeed");
    if (!host) return;
    var d = s.dashboard || {};
    var rows = Array.isArray(d.log) ? d.log.slice(0, 25) : [];
    $("#loggerKilled").textContent = (num(d.killed) || 0) + " killed";
    if (!rows.length) { host.innerHTML = '<p class="quiet">Nothing logged since reset.</p>'; return; }
    host.innerHTML = rows.map(function (r) {
      var key = r.agent + "|" + r.ts + "|" + r.mint;
      var fresh = !firstPaint && !logSeen[key];
      logSeen[key] = 1;
      var meta = null;
      for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].key === r.agent) meta = AGENTS[i];
      var sym = cleanSym(r.symbol);
      return '<div class="lg-row' + (fresh ? " flash" : "") + '"' + (r.mint ? ' data-mint="' + esc(r.mint) + '"' : "") + ">" +
        '<span class="lg-time">' + esc(hm(r.ts)) + "</span>" +
        '<span class="lg-body"><b style="color:' + (meta ? meta.color : "#8e8e93") + '">' + esc((meta ? meta.name : r.agent).toUpperCase()) + ":</b> " +
        (sym ? '<span class="lg-sym">$' + esc(sym) + "</span> " : "") +
        '<span class="lg-' + esc(r.tone || "idle") + '">' + esc(r.text || "") + "</span>" +
        (r.reason ? ' <span class="lg-reason">' + esc(r.reason) + "</span>" : "") +
        "</span></div>";
    }).join("");
  }

  /* ---------- 5) why they died ---------- */
  function renderReasons(s) {
    var host = $("#killReasons");
    if (!host) return;
    var d = s.dashboard || {};
    var rows = Array.isArray(d.kill_reasons) ? d.kill_reasons : [];
    if (!rows.length) { host.innerHTML = '<p class="quiet">No kills since reset.</p>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return num(r.count) || 0; })) || 1;
    var total = num(d.killed) || rows.reduce(function (a, r) { return a + (num(r.count) || 0); }, 0);
    host.innerHTML = rows.map(function (r) {
      var c = num(r.count) || 0;
      return '<div class="kr-row"><span class="kr-name">' + esc(r.reason) + '</span><span class="kr-count">' + c +
        '<small>' + (total ? Math.round(100 * c / total) + "%" : "") + "</small></span>" +
        '<span class="kr-bar"><i style="width:' + Math.max(3, Math.round(100 * c / max)) + '%"></i></span></div>';
    }).join("");
  }

  /* ---------- 1) ticker ---------- */
  function tickerCoins(s) {
    var out = [], have = {};
    function add(mint, sym) {
      if (!mint || have[mint] || out.length >= 30) return;
      have[mint] = 1;
      out.push({ mint: mint, symbol: sym });
    }
    (Array.isArray(s.positions) ? s.positions : []).forEach(function (p) { add(p.mint, p.symbol || p.name); });
    var coins = s.coins || {};
    (Array.isArray(s.waiting) ? s.waiting : []).forEach(function (w) {
      var c = coins[w.mint] || {};
      add(w.mint, w.symbol || c.symbol || w.name);
    });
    return out;
  }

  function paintTicker() {
    var host = $("#ticker");
    if (!host) return;
    var items = tickerMints.map(function (c) {
      var q = tickerQuotes[c.mint];
      if (!q || q.price == null) return "";
      var ch = q.change;
      var tone = ch == null ? "flat" : ch >= 0 ? "up" : "down";
      return '<button type="button" class="tk-item" data-mint="' + esc(c.mint) + '"><b>$' + esc(cleanSym(q.symbol || c.symbol)) + "</b> " +
        '<span class="tk-px">' + esc(fmtPx(q.price)) + "</span> " +
        (ch == null ? "" : '<span class="' + tone + '">' + esc(pct(ch)) + "</span>") + "</button>";
    }).filter(Boolean);
    if (!items.length) { host.hidden = true; return; }
    host.hidden = false;
    var sig = items.join("");
    if (sig === tickerSig) return;
    tickerSig = sig;
    var track = host.querySelector(".tk-track");
    track.innerHTML = '<div class="tk-run">' + sig + '</div><div class="tk-run" aria-hidden="true">' + sig + "</div>";
    var secs = Math.max(20, items.length * 4);
    track.style.animationDuration = secs + "s";
  }

  var tickerBusy = false;
  function pollTicker() {
    if (tickerBusy || !tickerMints.length || document.hidden) return;
    tickerBusy = true;
    var mints = tickerMints.map(function (c) { return c.mint; }).slice(0, 30);
    fetch("https://api.dexscreener.com/tokens/v1/solana/" + mints.map(encodeURIComponent).join(","), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (pairs) {
        var best = {};
        (Array.isArray(pairs) ? pairs : []).forEach(function (p) {
          var m = p && p.baseToken && p.baseToken.address;
          if (!m || num(p.priceUsd) == null) return;
          var liq = (p.liquidity && num(p.liquidity.usd)) || 0;
          if (!best[m] || liq > best[m].liq) best[m] = { liq: liq, p: p };
        });
        Object.keys(best).forEach(function (m) {
          var p = best[m].p, pc = p.priceChange || {};
          tickerQuotes[m] = { price: num(p.priceUsd), change: num(pc.h24) != null ? num(pc.h24) : num(pc.h1), symbol: p.baseToken.symbol, at: Date.now() };
        });
        paintTicker();
        if (root.__buddyRender) root.__buddyRender();
      })
      .catch(function () { /* keep last quotes */ })
      .then(function () { tickerBusy = false; });
  }

  function render(s, perf, live) {
    if (!s) return;
    try { renderEquity(s, perf, live); } catch (e) { /* ignore */ }
    var hasDash = !!(s.dashboard && typeof s.dashboard === "object");
    ["#deskCard", "#loggerCard", "#reasonsCard"].forEach(function (id) { var el = $(id); if (el) el.hidden = !hasDash; });
    if (hasDash) {
      renderAgents(s);
      renderLogger(s);
      renderReasons(s);
      firstPaint = false;
    }
    var next = tickerCoins(s);
    var sig = next.map(function (c) { return c.mint; }).join(",");
    var prev = tickerMints.map(function (c) { return c.mint; }).join(",");
    tickerMints = next;
    if (sig !== prev) pollTicker();
    paintTicker();
  }

  setInterval(pollTicker, 30000);
  function quote(mint) { return tickerQuotes[mint] || null; }
  root.BuddyDash = { render: render, quote: quote, AGENTS: AGENTS, _tickerCoins: tickerCoins };
})(typeof window !== "undefined" ? window : globalThis);
