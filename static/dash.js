/* Buddy dashboard v83 (u4b.mov copy) — Desk card + live Logger (MQTT log, no SCANNER kills, dedupe).
   Driven by real state.pipeline / pipe_counts. Mid-column fade, pill pulse, row flash.
   Live via MQTT snap; GitHub is fallback only. */
(function (root) {
  "use strict";

  var STAGES = [
    { key: "scout",    name: "Scout",    sub: "new pairs",          color: "#0A84FF",
      sources: { scanned: 1, watching: 1, scanner: 1 } },
    { key: "filter",   name: "Filter",   sub: "kills 98%",          color: "#FF9F0A",
      sources: { passed_rug: 1, auditor: 1 } },
    { key: "analyst",  name: "Analyst",  sub: "scores survivors",   color: "#BF5AF2",
      sources: { passed_gates: 1, analyst: 1, picked: 1 } },
    { key: "executor", name: "Executor", sub: "buy fills",          color: "#32D74B",
      sources: { bought: 1, executor: 1 } },
    { key: "risk",     name: "Risk",     sub: "stop · trail",       color: "#FF375F",
      sources: { risk: 1 } },
    { key: "logger",   name: "Logger",   sub: "reason for all",     color: "#64D2FF",
      sources: { skipped: 1, logger: 1, sold: 1 } }
  ];
  var STAGE_OF = {};
  STAGES.forEach(function (s) {
    Object.keys(s.sources).forEach(function (k) { STAGE_OF[k] = s.key; });
  });

  var reduceMotion = false;
  /* v83: William's iPhone must show the live motion even with iOS "Reduce Motion" on — do not honour it here. */

  var logSeen = {};
  var tickerSig = "";
  var quotes = {};
  var rowSig = {};

  var ICONS = {
    scout: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
    filter: '<polygon points="3,4 21,4 14,13 14,19 10,21 10,13"/>',
    analyst: '<path d="M12 3 4 7v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V7z"/><path d="m9 12 2 2 4-4"/>',
    executor: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    risk: '<path d="M5 17a7 7 0 1 1 14 0"/><path d="M12 17l4.2-6"/>',
    logger: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>'
  };

  function $(s) { return document.querySelector(s); }
  function $all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
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
    var t = String(s || "").replace(/[\u202a-\u202e\u2066-\u2069\ufe0f\u200d]/g, "");
    try { t = t.replace(/\p{Extended_Pictographic}/gu, ""); } catch (eP) {}
    t = t.replace(/^\$/, "").trim().toUpperCase();
    return Array.from(t).slice(0, 12).join("");
  }
  function fmtPx(v) {
    var n = num(v); if (n == null) return "";
    return "$" + (root.BuddyChart ? root.BuddyChart.fmtPrice(n) : String(n));
  }
  function pct(v) {
    var n = num(v); if (n == null) return "";
    var abs = Math.abs(n);
    if (abs < 0.5) return "+0%";
    return (n > 0 ? "+" : "−") + abs.toFixed(0) + "%";
  }
  function money(v) {
    var n = num(v); if (n == null) return "—";
    var sign = n < 0 ? "−" : n > 0 ? "+" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function mcap(v) {
    var n = num(v); if (n == null) return "";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M";
    if (n >= 1000) return "$" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return "$" + Math.round(n);
  }
  function logoTag(item, cls) {
    var letter = Array.from(cleanSym((item && (item.symbol || item.name)) || "?") || "?")[0] || "?";
    var src = (item && item.logo) || "";
    var extra = cls ? " " + cls : "";
    if (src) {
      return '<span class="pipe-logo' + extra + '"><img src="' + esc(src) + '" alt="" onerror="this.parentNode.classList.add(\'no-img\');this.remove()"/><i>' + esc(letter) + "</i></span>";
    }
    return '<span class="pipe-logo no-img' + extra + '"><i>' + esc(letter) + "</i></span>";
  }

  function pipelineOf(s) {
    if (Array.isArray(s.pipeline) && s.pipeline.length) return s.pipeline;
    if (s.dashboard && Array.isArray(s.dashboard.pipeline)) return s.dashboard.pipeline;
    return [];
  }

  function stageKeyOf(item) {
    var st = String(item && item.stage || "");
    if (st === "sold") return "executor";
    if (st === "skipped") return killRowOf(item);
    if (STAGE_OF[st]) return STAGE_OF[st];
    return "scout";
  }

  function killRowOf(item) {
    var why = String((item && item.reason) || "");
    var stages = (item && item.stages) || {};
    if (stages.bought || stages.sold) return "executor";
    if (stages.passed_gates || stages.picked || stages.analyst) return "analyst";
    if (stages.passed_rug || stages.auditor) {
      return /score|share|too weak|quality|already up|pool age/i.test(why) ? "analyst" : "filter";
    }
    if (/liq|lp\b|rug|mint|freeze|unlock|holder|top\s*10|market cap|mcap|bundled|snipe|liquidity/i.test(why)) return "filter";
    if (/score|share|too weak|quality|gate|already up|pool age|entry/i.test(why)) return "analyst";
    return "filter";
  }

  function isKill(item) {
    var why = String((item && item.reason) || "");
    if (/liq|lp\b|rug|mint|freeze|unlock|holder|top\s*10|market cap|mcap|bundled|snipe|liquidity|score|too weak|quality/i.test(why)) return true;
    if (/already up|pool age|cooldown|repeat|banned/i.test(why)) return false;
    return !!(item && item.ok === false);
  }

  /* v83: short human kill/skip reasons that fit one line (no "x p…" truncation). */
  function kfmt(v) {
    var n = Number(String(v).replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) return String(v);
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
    return "$" + Math.round(n);
  }
  function shortReason(why) {
    var w = String(why || "").replace(/\s+/g, " ").trim();
    if (!w) return "";
    var m;
    if ((m = w.match(/^pool age\s*([\d.]+)m/i))) return "too old " + Math.round(Number(m[1])) + "m";
    if (/pool age/i.test(w)) return "pool age ?";
    if ((m = w.match(/(?:market cap|mcap)\s*\$?([\d,.]+)\s*<\s*\$?([\d,.]+)/i))) return "mcap " + kfmt(m[1]) + " < " + kfmt(m[2]);
    if ((m = w.match(/liq(?:uidity)?\s*\$?([\d,.]+k?)\s*<\s*\$?([\d,.]+k?)/i))) return "liq < " + (/k$/i.test(m[2]) ? "$" + m[2] : kfmt(m[2]));
    if ((m = w.match(/liq\w*\s*(?:dropp?ing|drop|fell|down)\s*-?([\d.]+)%/i))) return "liq −" + Math.round(Number(m[1])) + "%";
    if (/liq\w*\s*gone|no liq|pool emptied|rug/i.test(w)) return "liq gone";
    if ((m = w.match(/top\s*-?\s*10[^\d]*([\d.]+)%/i))) return "top 10 holders " + Math.round(Number(m[1])) + "%";
    if (/mint/i.test(w) && /revok|authority|not/i.test(w)) return "mint not revoked";
    if (/freeze/i.test(w)) return "freeze not revoked";
    if (/dev\s*(sell|dump)/i.test(w)) return "dev selling";
    if (/copy\s*cat|copycat|clone/i.test(w)) return "copycat";
    if (/bundl/i.test(w)) return "bundled";
    if (/snip/i.test(w)) return "snipers";
    if ((m = w.match(/already up\s*([\d.]+)%/i))) return "already +" + Math.round(Number(m[1])) + "%";
    if ((m = w.match(/already down\s*-?([\d.]+)%/i))) return "dumping −" + Math.round(Number(m[1])) + "%";
    if ((m = w.match(/m5\s*(-?[\d.]+)%\s*<\s*([\d.]+)%/i))) return "5m " + Math.round(Number(m[1])) + "% < " + m[2] + "%";
    if (/no\s*\d*m?\s*uptick/i.test(w)) return "no uptick";
    if ((m = w.match(/max open\s*(\d+)/i))) return "max open " + m[1];
    if (/pool cap/i.test(w)) return "pool full";
    if (/0 buys|no buys/i.test(w)) return "no buyers";
    if ((m = w.match(/buy share\s*([\d.]+)/i))) return "buys " + Math.round(Number(m[1]) * (Number(m[1]) <= 1 ? 100 : 1)) + "%";
    if (/cooldown|repeat|seen/i.test(w)) return "cooldown";
    if (/banned|blacklist/i.test(w)) return "banned";
    w = w.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (w.length > 22) {
      var cut = w.slice(0, 22); var sp = cut.lastIndexOf(" ");
      w = sp > 8 ? cut.slice(0, sp) : cut;
    }
    return w;
  }

  function fmtScore(v) {
    var n = num(v);
    if (n == null) return "";
    if (Math.abs(n) <= 1.5) return n.toFixed(2);
    return String(Math.round(n));
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

  /* ---------- ticker removed in v78; keep the hook ---------- */
  function renderTicker(s, live) {
    var host = $("#ticker");
    if (host) { host.hidden = true; host.innerHTML = ""; }
    return;
  }

  function fmtCount(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? (n >= 100000 ? 0 : 1) : 1) + "k";
    return n.toLocaleString("en-US");
  }

  function deriveCounts(s, items) {
    var d = s.dashboard || {};
    var c = d.pipe_counts || {};
    var scanned = num(c.pairs);
    if (scanned == null) scanned = num(d.scanned);
    if (scanned == null) scanned = items.length || 0;
    var killed = num(c.killed);
    if (killed == null) killed = num(d.killed);
    if (killed == null) {
      killed = items.filter(function (it) { return it.stage === "skipped" || it.ok === false; }).length;
    }
    var scored = num(c.scored);
    if (scored == null) scored = num(((d.agents || {}).analyst || {}).count);
    if (scored == null) {
      scored = items.filter(function (it) {
        var st = it.stage;
        return st === "passed_gates" || st === "picked" || st === "bought" || st === "sold" || it.score != null;
      }).length;
    }
    var buys = num(c.buys);
    if (buys == null) buys = num(d.traded);
    if (buys == null) {
      buys = items.filter(function (it) { return it.stage === "bought" || it.stage === "sold"; }).length;
    }
    var reasons = num(c.reasons);
    if (reasons == null) reasons = (d.kill_reasons || []).length;
    if (!reasons) {
      reasons = items.filter(function (it) { return it.reason; }).length;
    }
    var killPct = num(c.kill_pct);
    if (killPct == null && scanned) killPct = 100 * killed / scanned;
    return { pairs: scanned || 0, killed: killed || 0, kill_pct: killPct, scored: scored || 0, buys: buys || 0, reasons: reasons || 0 };
  }

  function buySizeLabel(s) {
    var isReal = String(s.mode_label || s.mode || "").toUpperCase() === "REAL";
    if (isReal) return "$3";
    var sz = null;
    try {
      var ds = s.desk_settings || s.settings || {};
      var buy = (ds.mode && ds.mode.values && ds.mode.values.buy_usd) || {};
      sz = num(buy.value);
    } catch (e1) {}
    if (sz == null) return "";
    return "$" + (sz % 1 ? sz.toFixed(2) : String(Math.round(sz)));
  }

  function stopTrail(s) {
    try {
      var ds2 = s.desk_settings || s.settings || {};
      var vals = (ds2.mode && ds2.mode.values) || {};
      var stop = num(vals.stop_pct && vals.stop_pct.value);
      var trail = num(vals.trail_start_pct && vals.trail_start_pct.value);
      if (stop != null || trail != null) {
        return {
          stop: stop,
          trail: trail,
          pill: (stop != null ? "−" + String(stop) + "%" : "") + (stop != null && trail != null ? " · trail " : "") + (trail != null ? "+" + String(trail) + "%" : ""),
          sub: (stop != null ? "−" + String(stop) + "% stop" : "stop") + " · trail"
        };
      }
    } catch (e2) {}
    var pill = ((s.dashboard || {}).agents || {}).risk || {};
    return { stop: null, trail: null, pill: pill.pill || "stop · trail", sub: "stop · trail" };
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
      var sz = buySizeLabel(s);
      return sz ? ("size " + sz) : "size";
    }
    if (row.key === "risk") {
      var stp = stopTrail(s);
      var narrow = false; try { narrow = (root.innerWidth || 999) < 430; } catch (eW) {}
      if (narrow && stp.stop != null && stp.trail != null) return "−" + stp.stop + "% · +" + stp.trail + "%";
      return stp.pill;
    }
    if (row.key === "logger") return fmtCount(counts.reasons || 0) + " reasons";
    return "";
  }

  function rowSub(row, counts, s) {
    if (row.key === "filter") {
      var pctK = counts && counts.kill_pct;
      return pctK != null ? ("kills " + Number(pctK).toFixed(0) + "%") : "kills";
    }
    if (row.key === "risk") return stopTrail(s).sub;
    if (row.key === "executor") {
      var sz = buySizeLabel(s);
      return sz ? ("size " + sz) : "buy fills";
    }
    return row.sub;
  }

  function latestOn(items, row) {
    var best = null, bestTs = -1;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var st = String(it.stage || "");
      var hit = false;
      if (row.key === "logger") {
        hit = !!(st === "skipped" || st === "sold" || it.reason);
      } else if (row.key === "risk") {
        hit = false;
      } else if (row.key === "executor") {
        hit = (st === "bought" || st === "sold");
      } else if (st === "skipped" || (it.ok === false && st !== "sold" && st !== "bought")) {
        hit = killRowOf(it) === row.key;
      } else {
        hit = stageKeyOf(it) === row.key && st !== "sold";
      }
      if (!hit) continue;
      var ts = num(it.ts) || 0;
      if (ts >= bestTs) { best = it; bestTs = ts; }
    }
    return best;
  }

  function lastTrade(s, items) {
    var best = null, bestTs = -1;
    items.forEach(function (it) {
      if (it.stage !== "sold" && it.stage !== "bought") return;
      var ts = num(it.ts) || 0;
      if (ts >= bestTs) { best = it; bestTs = ts; }
    });
    (s.trades || []).forEach(function (t) {
      if (!t || t.open === true) return;
      if (t.closed_at || t.exit != null || t.pnl_usd != null) {
        var ts = num(t.closed_at) || num(t.ts) || 0;
        if (ts >= bestTs) {
          best = {
            symbol: t.symbol, name: t.name, logo: t.logo, mint: t.mint,
            stage: "sold", pnl_usd: t.pnl_usd, reason: t.exit_reason, ts: ts,
            size_usd: t.size_usd
          };
          bestTs = ts;
        }
      }
    });
    return best;
  }

  function openPositions(s) {
    var lists = [];
    if (Array.isArray(s.trades)) lists.push(s.trades);
    if (Array.isArray(s.positions)) lists.push(s.positions);
    if (s.dashboard && Array.isArray(s.dashboard.positions)) lists.push(s.dashboard.positions);
    var out = [], seen = {};
    var pipe = pipelineOf(s);
    var qmap = {};
    try { qmap = (root.state && root.state.quotes) || {}; } catch (e0) { qmap = {}; }
    lists.forEach(function (list) {
      list.forEach(function (p) {
        var mode = String(p.mode || "").toUpperCase();
        var source = String(p.source || "").toLowerCase();
        if (mode === "FOMO" || source === "wallet") return;
        var st = String(p.status || p.side_or_status || "").toLowerCase();
        var isOpen = p.open === true || st === "open" || st === "active" ||
          (!p.closed_at && p.entry != null && p.exit == null);
        if (!isOpen) return;
        var mint = String(p.mint || "");
        var id = mint || String(p.symbol || "");
        if (!id || seen[id]) return;
        seen[id] = 1;
        var q = mint ? qmap[mint] : null;
        var mark = num(p.mark_price) || num(p.mark) || (q && (num(q.price) || num(q.px)));
        var entry = num(p.entry) || num(p.avg) || num(p.entry_price);
        var pnlPct = num(p.pnl_pct);
        if (pnlPct == null && typeof root.__buddyLiveMark === "function") {
          try { var lm = root.__buddyLiveMark(p); if (lm && lm.pct != null && Number.isFinite(lm.pct)) pnlPct = lm.pct; } catch (eM) {}
        }
        if ((pnlPct == null || (pnlPct === 0 && p.pnl_usd == null)) && mark != null && entry) {
          pnlPct = 100 * (mark - entry) / entry;
        }
        var logo = p.logo || p.image;
        if (!logo && mint) {
          var hit = null;
          for (var i = 0; i < pipe.length; i++) { if (pipe[i].mint === mint) { hit = pipe[i]; break; } }
          logo = (hit && hit.logo) || ("https://dd.dexscreener.com/ds-data/tokens/solana/" + mint + ".png");
        }
        out.push({
          symbol: p.symbol || p.name, logo: logo, mint: mint,
          pnl_pct: pnlPct, pnl_usd: num(p.pnl_usd), size_usd: num(p.size_usd)
        });
      });
    });
    return out;
  }

  function coinHtml(item, row, s) {
    if (!item) {
      var idle = row.key === "scout" ? "Pump.fun + Raydium…"
        : row.key === "executor" ? "nothing passed yet"
        : "";
      if (!idle) return { html: "", sig: "empty" };
      return { html: '<span class="pipe-coin tone-idle"><span class="pipe-msg">' + esc(idle) + "</span></span>", sig: "idle:" + idle };
    }
    var sym = "$" + cleanSym(item.symbol || item.name || "");
    var why = String(item.reason || "").replace(/\s+/g, " ").trim();
    var tone = "idle";
    var msg = "";
    var showLogo = true;
    var st = String(item.stage || "");

    if (row.key === "scout") {
      tone = "idle";
      msg = "new pair";
    } else if (row.key === "filter") {
      if (st === "skipped" || item.ok === false) {
        tone = isKill(item) ? "kill" : "idle";
        msg = (tone === "kill" ? "× " : "") + (shortReason(why) || (tone === "kill" ? "killed" : "skipped"));
      } else {
        tone = "pass";
        msg = "passed rug";
      }
    } else if (row.key === "analyst") {
      var sc = num(item.score);
      if (st === "skipped" || item.ok === false) {
        tone = isKill(item) ? "kill" : "idle";
        if (tone === "kill") {
          if (/score/i.test(why) && sc != null) msg = "× " + fmtScore(sc);
          else if (/[<>]/.test(why) && why.length <= 16) msg = "× " + why;
          else if (sc != null && !why) msg = "× " + fmtScore(sc);
          else msg = "× " + (shortReason(why) || "score failed");
        } else {
          msg = shortReason(why) || "skipped";
        }
      } else {
        tone = "pass";
        msg = "score " + (sc != null ? fmtScore(sc) + " ✓" : "passed ✓");
      }
    } else if (row.key === "executor") {
      if (st === "bought") {
        tone = "pass";
        var sz = num(item.size_usd) || num(item.size);
        if (sz == null) { var bl = buySizeLabel(s); if (bl) sz = num(bl.replace(/[$,]/g, "")); }
        var szLab = sz != null ? "$" + (Math.abs(sz - Math.round(sz)) < 0.005 ? String(Math.round(sz)) : sz.toFixed(2)) : (buySizeLabel(s) || "");
        var bal = num(s.balance);
        msg = "buy " + szLab + (sz != null && bal && bal > 0 ? " · " + Math.max(1, Math.round(100 * sz / bal)) + "%" : "");
      } else {
        showLogo = false;
        var pnl = num(item.pnl_usd);
        tone = pnl == null ? "idle" : pnl >= 0 ? "pass" : "kill";
        var amt = pnl != null ? (Math.abs(pnl) >= 10 ? money(Math.round(pnl)) : money(Math.round(pnl * 100) / 100)) : "sold";
        var lastHtml = '<span class="pipe-coin pipe-last tone-' + tone + '"><span class="pipe-msg">' +
          '<span class="pipe-last-k">last </span><b class="pipe-last-v">' + esc(amt + " · " + sym) + "</b></span></span>";
        return { html: lastHtml, sig: [row.key, item.mint || sym, st, tone, amt].join("|") };
      }
    } else if (row.key === "logger") {
      showLogo = false;
      tone = "idle";
      var died = killRowOf(item);
      if (st === "sold") {
        msg = "risk sold " + sym + (why ? " · " + shortReason(why) : "");
      } else if (st === "skipped" || item.ok === false) {
        msg = (died === "analyst" ? "analyst " : "filter ") + (isKill(item) ? "killed " : "skipped ") + sym;
      } else if (died === "analyst" || st === "passed_gates" || st === "picked") {
        msg = "analyst passed " + sym;
      } else {
        msg = (why || (st || "update")) + " " + sym;
      }
    } else if (st === "skipped" || item.ok === false) {
      tone = isKill(item) ? "kill" : "idle";
      msg = "× " + (why || "killed");
    } else {
      tone = "pass";
      msg = why || "moved on";
    }

    var html = '<span class="pipe-coin tone-' + tone + '">' +
      (showLogo ? logoTag(item) : "") + '<span class="pipe-txt">' +
      (row.key === "logger" || (row.key === "executor" && st !== "bought") ? "" : '<b class="pipe-sym' + (row.key === "filter" && tone === "kill" ? " struck" : "") + '">' + esc(sym) + "</b>") +
      '<span class="pipe-msg">' + esc(msg) + "</span></span></span>";
    var sig = [row.key, item.mint || sym, st, tone, msg, item.logo || ""].join("|");
    return { html: html, sig: sig };
  }

  function holdingsHtml(holds) {
    if (!holds || !holds.length) return { html: '<span class="pipe-coin tone-idle"><span class="pipe-msg">no open risk</span></span>', sig: "empty" };
    var html = '<span class="pipe-holds">' + holds.slice(0, 4).map(function (h) {
      var p = num(h.pnl_pct);
      var tone = p == null || Math.abs(p) < 0.05 ? "idle" : p > 0 ? "pass" : "kill";
      var label = p == null ? "…" : pct(p);
      return '<span class="pipe-hold tone-' + tone + '">' + logoTag(h) + "<em>" + esc(label) + "</em></span>";
    }).join("") + (holds.length > 4 ? '<span class="pipe-hold-more">+' + (holds.length - 4) + "</span>" : "") + "</span>";
    var sig = holds.map(function (h) { return (h.symbol || "") + (h.pnl_pct == null ? "" : Number(h.pnl_pct).toFixed(2)); }).join("|");
    return { html: html, sig: sig };
  }

  function renderAgents(s) {
    var cards = $all(".pipe-card");
    if (!cards.length) return;
    var items = pipelineOf(s);
    var counts = deriveCounts(s, items);
    var titleText = "Desk · " + STAGES.length + " agents";
    var traded = counts.buys || 0;
    var countsHtml = '<span class="pipe-scanned">' + (counts.pairs || 0).toLocaleString("en-US") +
      ' scanned</span><span class="pipe-sep" aria-hidden="true">·</span><span class="pipe-traded' + (traded > 0 ? " has" : "") + '">' +
      traded.toLocaleString("en-US") + " traded</span>";
    var holds = openPositions(s);
    var last = lastTrade(s, items);

    var built = {};
    STAGES.forEach(function (row) {
      var ev;
      if (row.key === "risk") ev = holdingsHtml(holds);
      else if (row.key === "executor") {
        var buying = latestOn(items, row);
        if (buying && buying.stage === "bought" && (!last || (num(buying.ts) || 0) >= (num(last.ts) || 0))) ev = coinHtml(buying, row, s);
        else ev = last ? coinHtml(last, row, s) : coinHtml(null, row, s);
      } else {
        ev = coinHtml(latestOn(items, row), row, s);
      }
      built[row.key] = {
        ev: ev,
        badge: rowBadge(row, counts, s),
        sub: rowSub(row, counts, s)
      };
    });

    cards.forEach(function (card) {
      card.hidden = false;
      var title = card.querySelector(".pipe-title");
      if (title) title.textContent = titleText;
      var cnt = card.querySelector(".pipe-counts");
      if (cnt) cnt.innerHTML = countsHtml;
      var host = card.querySelector(".pipe");
      if (!host) return;
      if (!host.querySelector(".pipe-row")) {
        host.className = "pipe";
        host.innerHTML = STAGES.map(function (row) {
          return '<div class="pipe-row" data-stage="' + row.key + '">' +
            '<div class="pipe-left">' +
              '<span class="pipe-icon" style="--pipe-c:' + row.color + '">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                ICONS[row.key] + "</svg></span>" +
              '<span class="pipe-id"><b class="pipe-name">' + esc(row.name) + '</b><small class="pipe-sub">' + esc(row.sub) + "</small></span>" +
            "</div>" +
            '<div class="pipe-events" aria-live="polite"></div>' +
            '<span class="pipe-count c-' + row.key + '"></span>' +
          "</div>";
        }).join("");
      }
      var tradedEl = card.querySelector(".pipe-traded");
      var tradedKey = (card.id || "card") + ":traded";
      if (tradedEl && rowSig[tradedKey] != null && rowSig[tradedKey] !== traded && !reduceMotion) {
        tradedEl.classList.remove("pipe-pulse");
        void tradedEl.offsetWidth;
        tradedEl.classList.add("pipe-pulse");
      }
      rowSig[tradedKey] = traded;

      STAGES.forEach(function (row) {
        var el = host.querySelector('.pipe-row[data-stage="' + row.key + '"]');
        if (!el) return;
        var pack = built[row.key];
        var sub = el.querySelector(".pipe-sub");
        if (sub && sub.textContent !== pack.sub) sub.textContent = pack.sub;
        var c = el.querySelector(".pipe-count");
        var badgeKey = (card.id || "card") + ":badge:" + row.key;
        if (c && c.textContent !== pack.badge) {
          if (rowSig[badgeKey] != null && !reduceMotion) {
            c.classList.remove("pipe-pulse");
            void c.offsetWidth;
            c.classList.add("pipe-pulse");
          }
          c.textContent = pack.badge;
        }
        rowSig[badgeKey] = pack.badge;
        var slot = el.querySelector(".pipe-events");
        var sigKey = (card.id || "card") + ":" + row.key;
        if (slot && rowSig[sigKey] !== pack.ev.sig) {
          var prevSig = rowSig[sigKey];
          rowSig[sigKey] = pack.ev.sig;
          var html = pack.ev.html || "";
          var first = prevSig == null;
          if (reduceMotion || first) {
            if (slot._fadeTimer) { clearTimeout(slot._fadeTimer); slot._fadeTimer = null; }
            slot.classList.remove("pipe-swap-out", "pipe-swap-in");
            slot.innerHTML = html;
          } else {
            if (slot._fadeTimer) clearTimeout(slot._fadeTimer);
            slot.classList.remove("pipe-swap-in");
            slot.classList.add("pipe-swap-out");
            slot._fadeTimer = setTimeout(function () {
              slot.innerHTML = html;
              slot.classList.remove("pipe-swap-out");
              slot.classList.add("pipe-swap-in");
              slot._fadeTimer = null;
            }, 70);
            var bits = String(pack.ev.sig || "").split("|");
            var stg = bits[2] || "";
            var tone = bits[3] || "";
            /* v83: every real change lights the row: red killed, green passed/bought, grey skipped/new */
            var action = true;
            el.setAttribute("data-tone", tone === "kill" ? "kill" : tone === "pass" ? "pass" : "idle");
            if (action) {
              el.classList.remove("pipe-flash");
              void el.offsetWidth;
              el.classList.add("pipe-flash");
            }
          }
        }
      });
    });
  }

  /* ---------- logger: MQTT-driven, slide in at top, no SCANNER kills ---------- */
  function mapLogAgent(agent, text, reason, tone) {
    var a = String(agent || "").toLowerCase();
    var blob = (text || "") + " " + (reason || "");
    if (a === "scanner" || a === "scout") {
      if (tone === "kill" || /kill/i.test(blob)) return "filter";
      return "scout";
    }
    if (a === "auditor" || a === "skipped") return "filter";
    if (a === "sold" || a === "bought" || a === "risk") return "executor";
    if (a === "passed_rug" || a === "passed_gates" || a === "picked") {
      return a === "passed_rug" ? "filter" : "analyst";
    }
    if (a === "filter" || a === "analyst" || a === "executor" || a === "logger") return a;
    if (tone === "kill") return "filter";
    return a || "filter";
  }

  function logRunningText(r) {
    var agent = mapLogAgent(r.agent, r.text, r.reason, r.tone);
    var sym = r.symbol ? "$" + r.symbol : "";
    var text = String(r.text || "").replace(/\s+/g, " ").trim();
    var reason = String(r.reason || "").replace(/\s+/g, " ").trim();
    if (/^(filter|analyst|executor|scout)\s/i.test(text)) {
      return text + (sym && text.indexOf(sym) < 0 ? " " + sym : "");
    }
    if (agent === "filter") {
      if (r.tone === "pass" || /passed/i.test(text)) return ("filter " + (text || "passed rug") + (sym ? " " + sym : "")).trim();
      return ("filter killed" + (sym ? " " + sym : "")).trim();
    }
    if (agent === "analyst") {
      if (r.tone === "pass" || /passed/i.test(reason)) {
        if (/score/i.test(text)) return ("analyst " + text + (sym ? " " + sym : "")).trim();
        return ("analyst passed" + (sym ? " " + sym : "")).trim();
      }
      if (/score/i.test(text)) return ("analyst " + text + (sym ? " " + sym : "")).trim();
      return ("analyst killed" + (sym ? " " + sym : "")).trim();
    }
    if (agent === "executor") {
      var ev = text || reason || "update";
      ev = ev.replace(/^executor\s+/i, "");
      return ("executor " + ev + (sym && ev.indexOf(sym) < 0 ? " " + sym : "")).trim();
    }
    if (agent === "scout" || /new pair/i.test(text)) return "";
    var body = text || reason || "";
    return (agent ? agent + " " : "") + body + (sym && body.indexOf(sym) < 0 ? " " + sym : "");
  }

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
        mint: mint || ""
      });
    }
    var log = (s.dashboard && s.dashboard.log) || [];
    log.forEach(function (line) {
      if (!line) return;
      if (typeof line === "string") add(0, "logger", "", line, line, "idle", "");
      else add(line.ts, line.agent || line.stage || "logger", line.symbol, line.text || line.msg || line.reason, line.reason, line.tone, line.mint);
    });
    pipelineOf(s).forEach(function (it) {
      if (!it.reason && it.stage !== "sold" && it.stage !== "skipped" && it.stage !== "bought") return;
      var row = stageKeyOf(it);
      var ev = it.reason || it.stage || "";
      var tone = (it.stage === "bought") ? "buy" : (it.stage === "sold" ? ((num(it.pnl_usd) || 0) >= 0 ? "pass" : "kill") : (it.ok === false || it.stage === "skipped" ? (isKill(it) ? "kill" : "idle") : "idle"));
      add(it.ts, row, it.symbol, ev, it.reason, tone, it.mint);
    });
    var prepared = [];
    var seen = {};
    rows.sort(function (a, b) { return b.ts - a.ts; });
    rows.forEach(function (r) {
      r.agent = mapLogAgent(r.agent, r.text, r.reason, r.tone);
      r.body = logRunningText(r);
      if (!r.body) return;
      var key = [Math.round(r.ts), r.agent, r.symbol, r.body.toLowerCase()].join("|");
      if (seen[key]) return;
      seen[key] = 1;
      r.id = key;
      prepared.push(r);
    });
    prepared = prepared.slice(0, 12);
    if (card) card.hidden = prepared.length === 0;
    var liveEl = $("#loggerLive");
    if (liveEl) {
      var st = "fallback";
      try { if (root.BuddyLive && BuddyLive.status) st = BuddyLive.status() || "fallback"; } catch (eL) {}
      liveEl.hidden = false;
      liveEl.textContent = st === "live" ? "live" : "fallback";
      liveEl.className = "lg-live " + (st === "live" ? "on" : "fb");
    }
    if (!prepared.length) { host.innerHTML = ""; return; }
    var killed = $("#loggerKilled");
    if (killed) {
      var n = ((s.dashboard || {}).killed);
      if (n == null) n = ((s.dashboard || {}).pipe_counts || {}).killed;
      if (n == null) n = prepared.filter(function (r) { return r.tone === "kill"; }).length;
      killed.textContent = n ? (Number(n).toLocaleString("en-US") + " killed") : "";
    }
    var have = {};
    Array.prototype.forEach.call(host.children, function (el) { have[el.getAttribute("data-id") || ""] = el; });
    /* v83: reconcile in place. Old code emptied the list and re-appended every row each 1s tick,
       which restarted the slide-in on rows that kept "lg-in" (flicker) and never slid the list down.
       Now: new lines insert at the top and slide in, older lines glide down (FLIP), nothing else re-mounts. */
    var hadRows = host.children.length > 0;
    var keep = {};
    prepared.forEach(function (r) { keep[r.id] = 1; });
    Array.prototype.slice.call(host.children).forEach(function (el) {
      if (!keep[el.getAttribute("data-id") || ""]) el.remove();
    });
    var tops = [];
    Array.prototype.forEach.call(host.children, function (el) { tops.push([el, el.offsetTop]); });
    prepared.forEach(function (r, i) {
      var el = have[r.id];
      if (!el || !el.parentNode) {
        el = document.createElement("div");
        el.className = "lg-row tone-" + r.tone;
        el.setAttribute("data-id", r.id);
        if (r.mint) el.setAttribute("data-mint", r.mint);
        el.innerHTML = '<span class="lg-time">' + esc(hm(r.ts)) + '</span><span class="lg-body">' + esc(r.body) + "</span>";
        if (hadRows && !logSeen[r.id] && !reduceMotion) {
          el.classList.add("lg-in");
          (function (node) { setTimeout(function () { node.classList.remove("lg-in"); }, 450); })(el);
        }
        logSeen[r.id] = 1;
      }
      var at = host.children[i];
      if (at !== el) host.insertBefore(el, at || null);
    });
    tops.forEach(function (pair) {
      var el = pair[0];
      if (!el.parentNode) return;
      var d = pair[1] - el.offsetTop;
      if (!d) return;
      el.style.transition = "none";
      el.style.transform = "translateY(" + d + "px)";
      void el.offsetWidth;
      el.style.transition = "transform 260ms ease-out";
      el.style.transform = "";
    });
  }

  function renderReasons(s) {
    var card = $("#reasonsCard");
    var list = (s.dashboard && s.dashboard.kill_reasons) || [];
    if (!card) return;
    if (!list.length) {
      /* derive from pipeline if the dashboard list is missing */
      var tallies = {};
      pipelineOf(s).forEach(function (it) {
        if (!it.reason || (it.ok !== false && it.stage !== "skipped")) return;
        var key = String(it.reason).replace(/\s+/g, " ").trim();
        /* bucket "already up 36% in 5m" style reasons */
        key = key.replace(/already up \d+(\.\d+)?%/i, "Already up").replace(/buy share \d+% too weak/i, "Buy share too weak");
        if (!key) return;
        if (!tallies[key]) tallies[key] = { reason: key, count: 0 };
        tallies[key].count += 1;
      });
      list = Object.keys(tallies).map(function (k) { return tallies[k]; });
    }
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
  }
  function quote(mint) { return quotes[mint] || null; }
  root.BuddyDash = { render: render, quote: quote, setActive: setActive, STAGES: STAGES };
})(window);
