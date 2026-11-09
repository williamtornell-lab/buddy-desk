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

  /* ---------- 3) desk agents (v42 look + pass name slide) ---------- */
  var PIPE = ["scanner", "auditor", "analyst", "executor"];
  var PIPE_NEXT = { scanner: "auditor", auditor: "analyst", analyst: "executor" };
  var KIND_STAGE = { scan: "scanner", audit: "auditor", analyst: "analyst", buy: "executor" };
  var mintLatest = {}; /* mint -> {stage, ok, symbol, ts} */
  var animQueue = [];
  var animBusy = false;
  var holdUntil = {}; /* stage -> ts ms; freeze row text while name is sliding away */
  var reduceMotion = false;
  try { reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e0) {}
  var scanCycle = { items: [], i: 0, timer: 0, lastSig: "" };
  var SCAN_MS = 1000;

  function agentTone(a) {
    if (!a || a.paused) return "bad";
    var age = num(a.age_s);
    if (age == null || age > 120) return "bad";
    return "ok";
  }

  function actHtml(sym, text) {
    var s = cleanSym(sym);
    var rest = String(text || "");
    if (s) {
      return '<span class="dk-nm">$' + esc(s) + "</span> " + esc(rest);
    }
    return esc(rest);
  }

  function collectPasses(s) {
    var out = [], have = {};
    function push(stage, mint, symbol, ok, ts) {
      if (!mint || !stage || PIPE.indexOf(stage) < 0) return;
      if (!ok) return; /* rejects: no animation */
      var key = stage + "|" + mint + "|" + Math.round((num(ts) || 0));
      if (have[key]) return;
      have[key] = 1;
      out.push({ stage: stage, mint: String(mint), symbol: cleanSym(symbol) || String(mint).slice(0, 4).toUpperCase(), ok: true, ts: num(ts) || 0 });
    }
    var livePipe = Array.isArray(s.pipeline) ? s.pipeline
      : (s.dashboard && Array.isArray(s.dashboard.pipeline) ? s.dashboard.pipeline : null);
    if (livePipe) livePipe.forEach(function (e) {
      if (e.stage === "risk") return;
      push(e.stage, e.mint, e.symbol, e.ok !== false && e.ok !== 0, e.ts);
    });
    var d = s.dashboard || {};
    (Array.isArray(d.log) ? d.log : []).forEach(function (r) {
      if (r.agent === "risk") return;
      if (r.tone !== "pass" && r.tone !== "buy") return;
      push(r.agent, r.mint, r.symbol, true, r.ts);
    });
    (Array.isArray(s.activity) ? s.activity : []).forEach(function (a) {
      var stage = KIND_STAGE[a.kind];
      if (!stage) return;
      var title = String(a.title || "");
      if (/^killed|^rejected/i.test(title)) return;
      push(stage, a.mint, "", true, a.ts);
    });
    out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    return out;
  }

  function rowEl(host, key) {
    return host.querySelector('.dk-row[data-agent="' + key + '"]');
  }

  function runQueue() {
    if (animBusy || !animQueue.length) return;
    animBusy = true;
    var job = animQueue.shift();
    var host = $("#deskAgents");
    if (!host || reduceMotion) {
      animBusy = false;
      runQueue();
      return;
    }
    var from = rowEl(host, job.from);
    var to = rowEl(host, job.to);
    if (!from || !to) {
      animBusy = false;
      runQueue();
      return;
    }
    var act = from.querySelector(".dk-act");
    var nm = act && act.querySelector(".dk-nm");
    var label = "$" + (cleanSym(job.symbol) || "?");

    function finish() {
      holdUntil[job.from] = 0;
      animBusy = false;
      runQueue();
    }

    /* 1) Name turns green */
    if (nm && cleanSym(nm.textContent.replace(/^\$/, "")) === cleanSym(job.symbol)) {
      nm.classList.add("pass");
    } else if (act) {
      /* ensure name span exists for this symbol briefly */
      act.innerHTML = actHtml(job.symbol, job.rest || "");
      nm = act.querySelector(".dk-nm");
      if (nm) nm.classList.add("pass");
    }
    holdUntil[job.from] = Date.now() + 2000;

    window.setTimeout(function () {
      host = $("#deskAgents");
      from = host && rowEl(host, job.from);
      to = host && rowEl(host, job.to);
      if (!host || !from || !to) { finish(); return; }
      act = from.querySelector(".dk-act");
      nm = act && act.querySelector(".dk-nm");
      var fr = (nm || act || from).getBoundingClientRect();
      var toAct = to.querySelector(".dk-act");
      var tr = (toAct || to).getBoundingClientRect();
      var hr = host.getBoundingClientRect();

      var slide = document.createElement("span");
      slide.className = "dk-slide";
      slide.textContent = label;
      slide.style.left = (fr.left - hr.left) + "px";
      slide.style.top = (fr.top - hr.top) + "px";
      host.appendChild(slide);

      /* Name leaves this row; live text resumes on next state tick (Scanner cycles scans). */
      holdUntil[job.from] = 0;
      if (act) {
        if (job.from === "scanner") {
          act.innerHTML = esc("scanning…");
          act.className = "dk-act tone-idle";
        } else {
          /* hide name while the green slide travels; rest of line stays */
          var rest = "";
          if (nm && nm.nextSibling) rest = String(nm.nextSibling.textContent || "").trim();
          act.innerHTML = esc(rest);
          act.className = "dk-act tone-idle";
        }
      }

      void slide.offsetWidth;
      var dx = (tr.left - hr.left) - (fr.left - hr.left);
      var dy = (tr.top - hr.top) - (fr.top - hr.top);
      slide.style.transition = "transform 750ms ease-in-out, opacity 750ms ease-in-out";
      slide.style.transform = "translate(" + dx + "px," + dy + "px)";

      window.setTimeout(function () {
        /* Land name on destination row */
        host = $("#deskAgents");
        to = host && rowEl(host, job.to);
        if (to) {
          var dest = to.querySelector(".dk-act");
          if (dest) {
            var infoRest = job.toRest || "";
            dest.innerHTML = actHtml(job.symbol, infoRest);
            dest.className = "dk-act tone-pass";
            var landed = dest.querySelector(".dk-nm");
            if (landed) landed.classList.add("pass");
            window.setTimeout(function () {
              if (landed) landed.classList.remove("pass");
            }, 500);
          }
        }
        if (slide.parentNode) slide.parentNode.removeChild(slide);
        finish();
      }, 780);
    }, 700);
  }

  function enqueuePass(fromStage, toStage, symbol, rest, toRest) {
    if (!fromStage || !toStage || !symbol) return;
    /* drop duplicates at tail */
    var last = animQueue[animQueue.length - 1];
    if (last && last.from === fromStage && last.to === toStage && last.symbol === symbol) return;
    if (animBusy && animQueue.length > 6) animQueue.shift();
    animQueue.push({ from: fromStage, to: toStage, symbol: symbol, rest: rest || "", toRest: toRest || "" });
    runQueue();
  }

  function notePasses(s) {
    var events = collectPasses(s);
    events.forEach(function (e) {
      var prev = mintLatest[e.mint];
      mintLatest[e.mint] = e;
      if (firstPaint || reduceMotion) return;
      if (!prev) return;
      if (prev.stage === e.stage) return;
      var fromI = PIPE.indexOf(prev.stage);
      var toI = PIPE.indexOf(e.stage);
      if (fromI < 0 || toI < 0 || toI !== fromI + 1) {
        /* only animate adjacent hops; multi-hop: enqueue stepwise */
        if (fromI >= 0 && toI > fromI) {
          for (var i = fromI; i < toI; i++) {
            enqueuePass(PIPE[i], PIPE[i + 1], e.symbol || prev.symbol, "", "");
          }
        }
        return;
      }
      enqueuePass(prev.stage, e.stage, e.symbol || prev.symbol, "", "");
    });
  }


  function gatherScanItems(s) {
    var items = [], have = {};
    function add(mint, symbol, ok, ts, reason) {
      if (!mint) return;
      var m = String(mint);
      if (have[m]) return;
      have[m] = 1;
      items.push({
        mint: m,
        symbol: cleanSym(symbol) || m.slice(0, 4).toUpperCase(),
        ok: !!ok,
        ts: num(ts) || 0,
        reason: reason || ""
      });
    }
    var livePipe = Array.isArray(s.pipeline) ? s.pipeline
      : (s.dashboard && Array.isArray(s.dashboard.pipeline) ? s.dashboard.pipeline : null);
    if (livePipe) livePipe.forEach(function (e) {
      if (e.stage !== "scanner") return;
      add(e.mint, e.symbol, e.ok !== false && e.ok !== 0, e.ts, e.reason);
    });
    var d = s.dashboard || {};
    (Array.isArray(d.log) ? d.log : []).forEach(function (r) {
      if (r.agent !== "scanner") return;
      add(r.mint, r.symbol, r.tone === "pass" || r.tone === "buy", r.ts, r.reason || r.text);
    });
    (Array.isArray(s.activity) ? s.activity : []).forEach(function (a) {
      if (a.kind !== "scan") return;
      var title = String(a.title || "");
      var fail = /^killed/i.test(title);
      add(a.mint, "", !fail, a.ts, a.detail || title);
    });
    items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return items.slice(0, 40);
  }

  function paintScannerAct(act, item) {
    if (!act || !item) return;
    var reason = item.ok ? "new pair" : shortScanReason(item.reason);
    var tone = item.ok ? "pass" : "kill";
    act.className = "dk-act tone-" + tone;
    act.setAttribute("data-mint", item.mint);
    act.innerHTML = '<span class="dk-nm ' + (item.ok ? "pass" : "kill") + '">$' + esc(item.symbol) + "</span> " +
      esc(item.ok ? "✓ " + reason : ("× " + reason));
  }

  function shortScanReason(reason) {
    var r = String(reason || "").trim();
    var low = r.toLowerCase();
    if (!low) return "scanned";
    if (/liq|liquidity/.test(low)) return "low liq";
    if (/top\s*10/.test(low)) return "top 10";
    if (/never qual/.test(low)) return "unqual";
    if (/holder/.test(low)) return "no hold";
    var base = r.replace(/\(.*$/, "").trim();
    return base.length > 18 ? base.slice(0, 17) + "…" : base;
  }

  function tickScanner(host) {
    if (!host || reduceMotion) return;
    if ((holdUntil.scanner || 0) > Date.now()) return; /* pass-slide owns the row */
    if (!scanCycle.items.length) return;
    scanCycle.i = (scanCycle.i + 1) % scanCycle.items.length;
    var act = host.querySelector('.dk-row[data-agent="scanner"] .dk-act');
    paintScannerAct(act, scanCycle.items[scanCycle.i]);
  }

  function ensureScanTimer(host) {
    if (scanCycle.timer || reduceMotion) return;
    scanCycle.timer = window.setInterval(function () {
      var h = $("#deskAgents");
      if (h) tickScanner(h);
    }, SCAN_MS);
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

    notePasses(s);

    var scans = gatherScanItems(s);
    var sig = scans.map(function (x) { return x.mint + (x.ok ? "1" : "0"); }).join(",");
    if (sig !== scanCycle.lastSig) {
      scanCycle.items = scans;
      scanCycle.lastSig = sig;
      if (scanCycle.i >= scans.length) scanCycle.i = 0;
    }
    ensureScanTimer(host);

    var now = Date.now();
    var html = list.map(function (a) {
      var info = dash[a.key] || {};
      var tone = agentTone(hb[a.key]);
      var sym = cleanSym(info.symbol);
      var txt = info.text || "";
      var key = a.key + "|" + (info.ts || "") + "|" + sym + "|" + txt;
      var fresh = !firstPaint && seen[a.key] !== undefined && seen[a.key] !== key;
      seen[a.key] = key;
      var stale = tone === "bad";
      var age = hb[a.key] ? num(hb[a.key].age_s) : null;
      var status = stale ? (hb[a.key] && hb[a.key].paused ? "paused" : (age == null ? "no heartbeat" : "stale")) : a.sub;
      /* While a pass-slide is in flight from this row, keep scanner free to show live scans;
         for other rows, skip overwriting destination mid-slide only briefly. */
      var holding = (holdUntil[a.key] || 0) > now;
      var body;
      if (holding && a.key !== "scanner") {
        body = null; /* preserve via rebuild avoidance — fall through to full html still, but mark */
      }
      var actInner = actHtml(sym, txt);
      var actTone = info.tone || "idle";
      if (a.key === "scanner" && scanCycle.items.length && (holdUntil.scanner || 0) <= now) {
        var it = scanCycle.items[scanCycle.i % scanCycle.items.length];
        sym = it.symbol;
        actTone = it.ok ? "pass" : "kill";
        actInner = '<span class="dk-nm ' + (it.ok ? "pass" : "kill") + '">$' + esc(it.symbol) + "</span> " +
          esc(it.ok ? "✓ new pair" : ("× " + shortScanReason(it.reason)));
        if (it.mint) info = Object.assign({}, info, { mint: it.mint });
      }
      return '<div class="dk-row' + (stale ? " stale" : "") + '" data-agent="' + esc(a.key) + '">' +
        '<span class="dk-icon" style="--c:' + a.color + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + a.icon + "</svg>" +
        '<i class="dk-dot ' + tone + '"></i></span>' +
        '<span class="dk-name"><b>' + esc(a.name) + '</b><small>' + esc(status) + "</small></span>" +
        '<span class="dk-act tone-' + esc(actTone) + (fresh ? " flash" : "") + '"' +
        (info.mint ? ' data-mint="' + esc(info.mint) + '"' : "") +
        (holding ? ' data-hold="1"' : "") + ">" + actInner + "</span>" +
        (stale
          ? '<button type="button" class="restart-btn need dk-pill" data-restart="' + esc(a.key) + '">Restart</button>'
          : '<span class="dk-pill" style="--c:' + a.color + '">' + esc(info.pill || "") + "</span>") +
        "</div>";
    }).join("");

    /* Preserve in-flight slide overlay and held destination text across re-renders */
    var slides = Array.prototype.slice.call(host.querySelectorAll(".dk-slide"));
    var held = {};
    list.forEach(function (a) {
      if ((holdUntil[a.key] || 0) > now) {
        var row = rowEl(host, a.key);
        var act = row && row.querySelector(".dk-act");
        if (act) held[a.key] = act.innerHTML;
      }
    });
    host.innerHTML = html || '<p class="quiet">No agent data yet.</p>';
    Object.keys(held).forEach(function (k) {
      var act = host.querySelector('.dk-row[data-agent="' + k + '"] .dk-act');
      if (act) act.innerHTML = held[k];
    });
    slides.forEach(function (el) { host.appendChild(el); });
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
      var tone = r.tone || "idle";
      var symCls = "lg-sym" + (tone === "pass" || tone === "buy" ? " pass" : tone === "kill" ? " kill" : "");
      return '<div class="lg-row' + (fresh ? " lg-in" : "") + '"' + (r.mint ? ' data-mint="' + esc(r.mint) + '"' : "") + ">" +
        '<span class="lg-time">' + esc(hm(r.ts)) + "</span>" +
        '<span class="lg-body"><b style="color:' + (meta ? meta.color : "#8e8e93") + '">' + esc((meta ? meta.name : r.agent).toUpperCase()) + ":</b> " +
        (sym ? '<span class="' + symCls + '">$' + esc(sym) + "</span> " : "") +
        '<span class="lg-' + esc(tone) + '">' + esc(r.text || "") + "</span>" +
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
