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

  /* ---------- 3) desk agents + pipeline chips ---------- */
  var PIPE_STAGES = ["scanner", "auditor", "analyst", "risk", "executor"];
  var PIPE_SET = { scanner: 1, auditor: 1, analyst: 1, risk: 1, executor: 1 };
  var KIND_STAGE = { scan: "scanner", audit: "auditor", analyst: "analyst", buy: "executor", sell: "risk" };
  var chipStore = {}; /* mint -> {stage,ok,reason,symbol,ts,el,fading} */
  var reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { reduceMotion = false; }

  function agentTone(a) {
    if (!a || a.paused) return "bad";
    var age = num(a.age_s);
    if (age == null || age > 120) return "bad";
    return "ok";
  }

  function shortReason(reason) {
    var r = String(reason || "").trim();
    var low = r.toLowerCase();
    if (!low) return "";
    var rules = [
      [/liq|liquidity/, "low liq"], [/top\s*10/, "top10"], [/no holders/, "no hold"],
      [/never qual/, "unqual"], [/score/, "score"], [/m5_buys|no buys/, "no buys"],
      [/no price/, "no px"], [/pulled/, "liq pull"], [/mint/, "mint"], [/freeze/, "freeze"],
      [/rug|dev sold/, "rug"], [/volume/, "vol"], [/h1|pumped/, "pumped"], [/age|young/, "young"],
      [/bundl|sniper/, "sniper"]
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(low)) return rules[i][1];
    var base = r.replace(/\(.*$/, "").trim();
    return base.length > 10 ? base.slice(0, 9) + "…" : base;
  }

  function letterMark(sym) {
    var s = cleanSym(sym) || "?";
    return s.charAt(0);
  }

  /* Build stage events from live pipeline, dashboard.log, and activity. Real data only. */
  function collectPipeEvents(s) {
    var events = [];
    var have = {};
    function push(ev) {
      if (!ev || !ev.mint || !PIPE_SET[ev.stage]) return;
      var key = ev.stage + "|" + ev.mint + "|" + Math.round((num(ev.ts) || 0) * 10);
      if (have[key]) return;
      have[key] = 1;
      events.push({
        mint: String(ev.mint),
        symbol: cleanSym(ev.symbol) || String(ev.mint).slice(0, 4).toUpperCase(),
        stage: ev.stage,
        ok: !!ev.ok,
        reason: ev.ok ? "" : shortReason(ev.reason),
        ts: num(ev.ts) || 0
      });
    }

    var livePipe = Array.isArray(s.pipeline) ? s.pipeline
      : (s.dashboard && Array.isArray(s.dashboard.pipeline) ? s.dashboard.pipeline : null);
    if (livePipe) livePipe.forEach(function (e) {
      push({ mint: e.mint, symbol: e.symbol, stage: e.stage, ok: e.ok !== false && e.ok !== 0, reason: e.reason, ts: e.ts });
    });

    var d = s.dashboard || {};
    (Array.isArray(d.log) ? d.log : []).forEach(function (r) {
      if (!PIPE_SET[r.agent]) return;
      var ok = r.tone === "pass" || r.tone === "buy";
      push({ mint: r.mint, symbol: r.symbol, stage: r.agent, ok: ok, reason: r.reason || r.text, ts: r.ts });
    });

    var coins = s.coins || {};
    (Array.isArray(s.activity) ? s.activity : []).forEach(function (a) {
      var stage = KIND_STAGE[a.kind];
      if (!stage) return;
      var title = String(a.title || "");
      var detail = String(a.detail || "");
      var fail = /^killed|^rejected/i.test(title);
      var ok = !fail;
      if (a.kind === "buy" || a.kind === "sell") ok = true;
      if (/→/.test(title) || /FOMO-style graduate|queued/i.test(title + " " + detail)) ok = !fail;
      var sym = (coins[a.mint] && (coins[a.mint].symbol || coins[a.mint].name)) || "";
      var reason = fail ? (detail || title.replace(/^Killed\s+|^Rejected\s+/i, "")) : "";
      push({ mint: a.mint, symbol: sym, stage: stage, ok: ok, reason: reason, ts: a.ts });
    });

    /* Current agent mint as a soft live pin (pass if tone is pass/buy). */
    var dash = d.agents || {};
    PIPE_STAGES.forEach(function (stage) {
      var info = dash[stage];
      if (!info || !info.mint) return;
      var ok = info.tone === "pass" || info.tone === "buy";
      var fail = info.tone === "kill";
      if (!ok && !fail) return;
      push({ mint: info.mint, symbol: info.symbol, stage: stage, ok: ok, reason: fail ? info.text : "", ts: info.ts || (Date.now() / 1000) });
    });

    events.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return events;
  }

  /* Pick up to 3 chips per stage: newest first; keep brief fail fades. */
  function pickChips(events) {
    var by = {};
    PIPE_STAGES.forEach(function (st) { by[st] = []; });
    var latest = {}; /* mint -> newest event (any stage) */
    events.forEach(function (e) {
      if (!latest[e.mint] || e.ts >= latest[e.mint].ts) latest[e.mint] = e;
    });
    /* Place each mint only at its latest stage. */
    Object.keys(latest).forEach(function (m) {
      var e = latest[m];
      if (by[e.stage]) by[e.stage].push(e);
    });
    PIPE_STAGES.forEach(function (st) {
      by[st].sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      by[st] = by[st].slice(0, 3);
    });
    return by;
  }

  function ensureChipEl(mint, meta) {
    var cur = chipStore[mint];
    if (cur && cur.el) {
      cur.symbol = meta.symbol || cur.symbol;
      cur.ok = meta.ok;
      cur.reason = meta.reason || "";
      cur.ts = meta.ts;
      return cur;
    }
    var el = document.createElement("button");
    el.type = "button";
    el.className = "dk-chip";
    el.setAttribute("data-mint", mint);
    el.innerHTML = '<span class="dk-chip-logo" aria-hidden="true">' + esc(letterMark(meta.symbol)) + "</span>" +
      '<span class="dk-chip-sym">' + esc(cleanSym(meta.symbol) || "?") + "</span>" +
      '<span class="dk-chip-tag" hidden></span>';
    chipStore[mint] = { stage: null, ok: meta.ok, reason: meta.reason || "", symbol: meta.symbol, ts: meta.ts, el: el, fading: false };
    return chipStore[mint];
  }

  function paintChip(cur) {
    var el = cur.el;
    el.classList.toggle("fail", !cur.ok);
    el.classList.toggle("ok", !!cur.ok);
    var sym = el.querySelector(".dk-chip-sym");
    if (sym) sym.textContent = cleanSym(cur.symbol) || "?";
    var logo = el.querySelector(".dk-chip-logo");
    if (logo) logo.textContent = letterMark(cur.symbol);
    var tag = el.querySelector(".dk-chip-tag");
    if (tag) {
      if (!cur.ok && cur.reason) {
        tag.hidden = false;
        tag.textContent = cur.reason;
      } else {
        tag.hidden = true;
        tag.textContent = "";
      }
    }
  }

  function flipMove(el, fromRect, toRail) {
    if (reduceMotion || !fromRect) {
      toRail.appendChild(el);
      return;
    }
    toRail.appendChild(el);
    var to = el.getBoundingClientRect();
    var dx = fromRect.left - to.left;
    var dy = fromRect.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.style.transition = "none";
    el.style.transform = "translate(" + dx + "px," + dy + "px)";
    el.style.opacity = "0.85";
    void el.offsetWidth;
    el.style.transition = "transform 420ms cubic-bezier(.2,.7,.2,1), opacity 360ms ease";
    el.style.transform = "translate(0,0)";
    el.style.opacity = "1";
  }

  function syncPipeChips(host, byStage) {
    if (!host) return;
    var want = {};
    PIPE_STAGES.forEach(function (st) {
      (byStage[st] || []).forEach(function (e) { want[e.mint] = e; });
    });

    /* Fade out chips no longer wanted. */
    Object.keys(chipStore).forEach(function (mint) {
      if (want[mint]) return;
      var cur = chipStore[mint];
      if (!cur || !cur.el || cur.fading) return;
      cur.fading = true;
      cur.el.classList.add("out");
      var el = cur.el;
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (chipStore[mint] && chipStore[mint].el === el) delete chipStore[mint];
      }, reduceMotion ? 0 : 480);
    });

    PIPE_STAGES.forEach(function (st) {
      var rail = host.querySelector('.dk-chips[data-stage="' + st + '"]');
      if (!rail) return;
      (byStage[st] || []).forEach(function (e) {
        var cur = ensureChipEl(e.mint, e);
        cur.fading = false;
        cur.el.classList.remove("out");
        paintChip(cur);
        var prevStage = cur.stage;
        var fromRect = null;
        if (cur.el.isConnected) fromRect = cur.el.getBoundingClientRect();
        if (prevStage !== st || cur.el.parentNode !== rail) {
          if (prevStage == null && !reduceMotion) {
            rail.appendChild(cur.el);
            cur.el.classList.add("in");
            window.setTimeout(function () { cur.el.classList.remove("in"); }, 500);
          } else {
            flipMove(cur.el, fromRect, rail);
          }
        } else if (cur.el.parentNode !== rail) {
          rail.appendChild(cur.el);
        }
        cur.stage = st;
      });
      /* Newest first without disturbing other rails. */
      (byStage[st] || []).forEach(function (e, i) {
        var el = chipStore[e.mint] && chipStore[e.mint].el;
        if (!el || el.parentNode !== rail) return;
        var at = rail.children[i];
        if (at !== el) rail.insertBefore(el, at || null);
      });
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

    var skeleton = list.map(function (a) {
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
      var pipe = PIPE_SET[a.key];
      var row = '<div class="dk-row' + (stale ? " stale" : "") + '" data-agent="' + esc(a.key) + '">' +
        '<span class="dk-icon" style="--c:' + a.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + a.icon + "</svg>" +
        '<i class="dk-dot ' + tone + '"></i></span>' +
        '<span class="dk-name"><b>' + esc(a.name) + '</b><small>' + esc(status) + "</small></span>" +
        '<span class="dk-act tone-' + esc(info.tone || "idle") + (fresh ? " flash" : "") + '"' +
        (info.mint ? ' data-mint="' + esc(info.mint) + '"' : "") + ">" + esc(txt) + "</span>" +
        (stale
          ? '<button type="button" class="restart-btn need dk-pill" data-restart="' + esc(a.key) + '">Restart</button>'
          : '<span class="dk-pill" style="--c:' + a.color + '">' + esc(info.pill || "") + "</span>") +
        "</div>";
      if (!pipe) return '<div class="dk-block">' + row + "</div>";
      return '<div class="dk-block" data-stage="' + esc(a.key) + '">' + row +
        '<div class="dk-chips" data-stage="' + esc(a.key) + '" aria-label="' + esc(a.name) + ' coins"></div></div>';
    }).join("");

    /* Preserve chip nodes across re-renders: only rebuild skeleton when agent set changes. */
    var sig = list.map(function (a) { return a.key; }).join(",");
    if (host.getAttribute("data-agent-sig") !== sig || !host.querySelector(".dk-block")) {
      /* Detach live chips before wiping. */
      Object.keys(chipStore).forEach(function (m) {
        var el = chipStore[m] && chipStore[m].el;
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      host.innerHTML = skeleton || '<p class="quiet">No agent data yet.</p>';
      host.setAttribute("data-agent-sig", sig);
    } else {
      /* Update row text / pills / restart in place. */
      list.forEach(function (a) {
        var block = host.querySelector('.dk-block[data-stage="' + a.key + '"], .dk-row[data-agent="' + a.key + '"]');
        var row = host.querySelector('.dk-row[data-agent="' + a.key + '"]');
        if (!row) return;
        var info = dash[a.key] || {};
        var tone = agentTone(hb[a.key]);
        var stale = tone === "bad";
        var age = hb[a.key] ? num(hb[a.key].age_s) : null;
        var status = stale ? (hb[a.key] && hb[a.key].paused ? "paused" : (age == null ? "no heartbeat" : "stale")) : a.sub;
        var sym = cleanSym(info.symbol);
        var txt = (sym ? "$" + sym + " " : "") + (info.text || "");
        row.classList.toggle("stale", stale);
        var dot = row.querySelector(".dk-dot");
        if (dot) dot.className = "dk-dot " + tone;
        var small = row.querySelector(".dk-name small");
        if (small) small.textContent = status;
        var act = row.querySelector(".dk-act");
        if (act) {
          act.className = "dk-act tone-" + (info.tone || "idle");
          act.textContent = txt;
          if (info.mint) act.setAttribute("data-mint", info.mint); else act.removeAttribute("data-mint");
        }
        var pillSlot = row.querySelector(".dk-pill, .restart-btn.dk-pill");
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
            sp.textContent = info.pill || "";
            if (pillSlot) row.replaceChild(sp, pillSlot); else row.appendChild(sp);
          } else {
            pillSlot.style.setProperty("--c", a.color);
            pillSlot.textContent = info.pill || "";
          }
        }
      });
    }

    var by = pickChips(collectPipeEvents(s));
    syncPipeChips(host, by);
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
