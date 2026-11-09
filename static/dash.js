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
    { key: "copy", name: "Copy", sub: "top FOMO traders", color: "#c084fc", icon: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>' },
    { key: "learner", name: "Learner", sub: "lessons from trades", color: "#facc15", icon: '<path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3z"/><path d="M9 21h6"/>' },
    { key: "adaptive", name: "Adaptive", sub: "learns similar setups", color: "#34d399", icon: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="9" cy="18" r="2"/><path d="M8 7l8 1M7.5 16.5 6.5 8M10.5 17 17 9.5"/>' },
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
    if (sub) sub.textContent = d.since_reset ? "since reset" : "";
  }

  /* ---------- 3) desk agents (v42 layout + overlay motion) ---------- */
  var PIPE_ORDER = ["scanner", "auditor", "analyst", "executor"]; /* buys end at executor, not risk */
  var PIPE_IDX = { scanner: 0, auditor: 1, analyst: 2, executor: 3, risk: 3 };
  var KIND_STAGE = { scan: "scanner", audit: "auditor", analyst: "analyst", buy: "executor", sell: "risk" };
  var mintStage = {}; /* mint -> {stage, ok, symbol, ts} */
  var pillSeen = {};
  var reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e0) {}

  function agentTone(a) {
    if (!a || a.paused) return "bad";
    var age = num(a.age_s);
    if (age == null || age > 120) return "bad";
    return "ok";
  }

  function letterMark(sym) {
    var s = cleanSym(sym) || "?";
    return s.charAt(0);
  }

  function collectPipeEvents(s) {
    var events = [], have = {};
    function push(ev) {
      if (!ev || !ev.mint) return;
      var stage = ev.stage;
      if (stage === "risk") stage = "executor"; /* bought/sold ghosts land on executor for travel end */
      if (PIPE_IDX[stage] == null && stage !== "executor") return;
      if (stage === "risk") return;
      var key = stage + "|" + ev.mint + "|" + Math.round((num(ev.ts) || 0) * 5);
      if (have[key]) return;
      have[key] = 1;
      events.push({
        mint: String(ev.mint),
        symbol: cleanSym(ev.symbol) || String(ev.mint).slice(0, 4).toUpperCase(),
        stage: stage === "risk" ? "executor" : stage,
        ok: !!ev.ok,
        ts: num(ev.ts) || 0
      });
    }
    var livePipe = Array.isArray(s.pipeline) ? s.pipeline
      : (s.dashboard && Array.isArray(s.dashboard.pipeline) ? s.dashboard.pipeline : null);
    if (livePipe) livePipe.forEach(function (e) {
      var st = e.stage;
      /* Buy path ends at executor; ignore risk as a travel destination. */
      if (st === "risk") return;
      push({ mint: e.mint, symbol: e.symbol, stage: st, ok: e.ok !== false && e.ok !== 0, ts: e.ts });
    });
    var d = s.dashboard || {};
    (Array.isArray(d.log) ? d.log : []).forEach(function (r) {
      if (r.agent === "risk") return;
      if (PIPE_IDX[r.agent] == null) return;
      push({ mint: r.mint, symbol: r.symbol, stage: r.agent, ok: r.tone === "pass" || r.tone === "buy", ts: r.ts });
    });
    (Array.isArray(s.activity) ? s.activity : []).forEach(function (a) {
      var stage = KIND_STAGE[a.kind];
      if (!stage || stage === "risk") return;
      var title = String(a.title || "");
      var fail = /^killed|^rejected/i.test(title);
      push({ mint: a.mint, symbol: "", stage: stage, ok: !fail, ts: a.ts });
    });
    events.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    return events;
  }

  function rowEl(host, key) {
    return host.querySelector('.dk-row[data-agent="' + key + '"]');
  }

  function pulseRow(row, ok) {
    if (!row || reduceMotion) return;
    row.classList.remove("dk-pulse-pass", "dk-pulse-fail");
    void row.offsetWidth;
    row.classList.add(ok ? "dk-pulse-pass" : "dk-pulse-fail");
    window.setTimeout(function () { row.classList.remove("dk-pulse-pass", "dk-pulse-fail"); }, 520);
  }

  function flyGhost(host, fromKey, toKey, symbol, ok) {
    if (reduceMotion || !host) return;
    var from = rowEl(host, fromKey);
    var to = rowEl(host, toKey);
    if (!from || !to) return;
    var fr = from.getBoundingClientRect();
    var tr = to.getBoundingClientRect();
    var hr = host.getBoundingClientRect();
    var ghost = document.createElement("div");
    ghost.className = "dk-ghost " + (ok ? "ok" : "fail");
    ghost.innerHTML = '<span class="dk-ghost-logo">' + esc(letterMark(symbol)) + "</span><span>$" + esc(cleanSym(symbol) || "?") + "</span>";
    var x0 = fr.left - hr.left + 70;
    var y0 = fr.top - hr.top + fr.height / 2 - 12;
    var x1 = tr.left - hr.left + 70;
    var y1 = tr.top - hr.top + tr.height / 2 - 12;
    ghost.style.left = x0 + "px";
    ghost.style.top = y0 + "px";
    host.appendChild(ghost);
    void ghost.offsetWidth;
    ghost.style.transition = "transform 440ms cubic-bezier(.2,.7,.2,1), opacity 440ms ease";
    ghost.style.transform = "translate(" + (x1 - x0) + "px," + (y1 - y0) + "px)";
    ghost.style.opacity = "0";
    window.setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 480);
  }

  function animatePipe(host, s) {
    if (!host || firstPaint) {
      collectPipeEvents(s).forEach(function (e) {
        if (!mintStage[e.mint] || e.ts >= mintStage[e.mint].ts) mintStage[e.mint] = e;
      });
      return;
    }
    var events = collectPipeEvents(s);
    events.forEach(function (e) {
      var prev = mintStage[e.mint];
      mintStage[e.mint] = e;
      if (!prev) {
        if (e.stage === "scanner") pulseRow(rowEl(host, "scanner"), e.ok);
        return;
      }
      if (prev.stage === e.stage) return;
      var fromI = PIPE_IDX[prev.stage];
      var toI = PIPE_IDX[e.stage];
      if (fromI == null || toI == null || toI <= fromI) {
        pulseRow(rowEl(host, e.stage), e.ok);
        return;
      }
      /* Travel one hop at a time visually: from previous stage to this stage. */
      flyGhost(host, prev.stage, e.stage, e.symbol || prev.symbol, e.ok);
      pulseRow(rowEl(host, e.stage), e.ok);
    });
  }

  function renderAgents(s) {
    var host = $("#deskAgents");
    if (!host) return;
    var d = s.dashboard || {};
    var hb = s.agents || {};
    var dash = d.agents || {};
    /* Display-only: these keep running under the supervisor, just not listed on the Desk card. */
    var HIDE = { copy: 1, learner: 1, adaptive: 1, fomo_holdings: 1 };
    var list = AGENTS.filter(function (a) { return !HIDE[a.key] && (hb[a.key] || dash[a.key]); });
    $("#deskTitle").textContent = "Desk · " + list.length + " agents";
    $("#deskCounts").textContent = (num(d.scanned) || 0) + " scanned · " + (num(d.traded) || 0) + " traded";

    var sig = list.map(function (a) { return a.key; }).join(",");
    var needRebuild = host.getAttribute("data-agent-sig") !== sig || !host.querySelector(".dk-row");

    function rowHtml(a) {
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
      return '<div class="dk-row' + (stale ? " stale" : "") + '" data-agent="' + esc(a.key) + '">' +
        '<span class="dk-icon" style="--c:' + a.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + a.icon + "</svg>" +
        '<i class="dk-dot ' + tone + '"></i></span>' +
        '<span class="dk-name"><b>' + esc(a.name) + '</b><small>' + esc(status) + "</small></span>" +
        '<span class="dk-act tone-' + esc(info.tone || "idle") + (fresh ? " flash" : "") + '"' +
        (info.mint ? ' data-mint="' + esc(info.mint) + '"' : "") + ' data-actkey="' + esc(key) + '">' + esc(txt) + "</span>" +
        (stale
          ? '<button type="button" class="restart-btn need dk-pill" data-restart="' + esc(a.key) + '">Restart</button>'
          : '<span class="dk-pill" style="--c:' + a.color + '">' + esc(info.pill || "") + "</span>") +
        "</div>";
    }

    if (needRebuild) {
      host.innerHTML = list.map(rowHtml).join("") || '<p class="quiet">No agent data yet.</p>';
      host.setAttribute("data-agent-sig", sig);
      list.forEach(function (a) {
        var info = dash[a.key] || {};
        pillSeen[a.key] = info.pill || "";
      });
    } else {
      list.forEach(function (a) {
        var row = rowEl(host, a.key);
        if (!row) return;
        var info = dash[a.key] || {};
        var tone = agentTone(hb[a.key]);
        var stale = tone === "bad";
        var age = hb[a.key] ? num(hb[a.key].age_s) : null;
        var status = stale ? (hb[a.key] && hb[a.key].paused ? "paused" : (age == null ? "no heartbeat" : "stale")) : a.sub;
        var sym = cleanSym(info.symbol);
        var txt = (sym ? "$" + sym + " " : "") + (info.text || "");
        var key = a.key + "|" + (info.ts || "") + "|" + txt;
        row.classList.toggle("stale", stale);
        var dot = row.querySelector(".dk-dot");
        if (dot) dot.className = "dk-dot " + tone;
        var small = row.querySelector(".dk-name small");
        if (small) small.textContent = status;

        var act = row.querySelector(".dk-act");
        if (act) {
          var prevKey = act.getAttribute("data-actkey") || "";
          if (prevKey !== key) {
            var apply = function () {
              act.className = "dk-act tone-" + (info.tone || "idle") + (reduceMotion ? "" : " dk-swap-in");
              act.textContent = txt;
              act.setAttribute("data-actkey", key);
              if (info.mint) act.setAttribute("data-mint", info.mint); else act.removeAttribute("data-mint");
              if (!reduceMotion) window.setTimeout(function () { act.classList.remove("dk-swap-in"); }, 400);
            };
            if (!reduceMotion && prevKey) {
              act.classList.add("dk-swap-out");
              window.setTimeout(apply, 160);
            } else apply();
          } else {
            act.className = "dk-act tone-" + (info.tone || "idle");
          }
        }

        var pillSlot = row.querySelector(".dk-pill, .restart-btn.dk-pill");
        var pillText = info.pill || "";
        if (stale) {
          if (!pillSlot || !pillSlot.classList.contains("restart-btn")) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "restart-btn need dk-pill";
            btn.setAttribute("data-restart", a.key);
            btn.textContent = "Restart";
            if (pillSlot) row.replaceChild(btn, pillSlot); else row.appendChild(btn);
          }
        } else {
          if (!pillSlot || pillSlot.classList.contains("restart-btn")) {
            var sp = document.createElement("span");
            sp.className = "dk-pill";
            sp.style.setProperty("--c", a.color);
            sp.textContent = pillText;
            if (pillSlot) row.replaceChild(sp, pillSlot); else row.appendChild(sp);
            pillSlot = sp;
          } else {
            if (pillSeen[a.key] !== pillText) {
              pillSlot.textContent = pillText;
              if (!reduceMotion) {
                pillSlot.classList.remove("dk-tick");
                void pillSlot.offsetWidth;
                pillSlot.classList.add("dk-tick");
              }
            } else {
              pillSlot.textContent = pillText;
            }
            pillSlot.style.setProperty("--c", a.color);
          }
          pillSeen[a.key] = pillText;
        }
        seen[a.key] = key;
      });
    }

    animatePipe(host, s);
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
