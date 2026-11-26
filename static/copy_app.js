/* Buddy Copy trading view (v85). Desk | Copy switch is still view-only and
   never posts desk:on/off, copy:on/off (FOMO), or REAL arm commands.
   Copy-mode controls post copytrade:on|off and set:copytrade:... through the
   same authenticated confirm path as desk settings. Renders state.wallet_copy
   only for fills — never invents P&L. Desk mode is unchanged. */
(function (root) {
  "use strict";
  var KEY = "buddy.viewSource";
  var RANGE_KEY = "buddy.copySparkRange";
  var UP = "#30d158", DOWN = "#ff453a", FLAT = "#30d158";
  var W = 360, H = 96, PAD_T = 12, PAD_B = 12, X0 = 4, X_END = W * 0.82;
  var RANGES = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  var BOUNDS = { buy_usd: [1, 100], sl_pct: [1, 50], tp_pct: [1, 500] };
  var DEFAULTS = { buy_usd: 25, sl_pct: 8, tp_pct: 20 };
  var view = "desk";
  var tab = "copyHome";
  var last = null;
  var spark = { range: "week", drawn: null };
  var hooks = { confirm: null };
  var ctlPend = null;
  var ctlEdits = { buy_usd: null, sl_pct: null, tp_pct: null };

  try { view = localStorage.getItem(KEY) || "desk"; } catch (e) { view = "desk"; }
  if (view !== "copy") view = "desk";
  try { spark.range = localStorage.getItem(RANGE_KEY) || "week"; } catch (e) {}
  if (!(spark.range in RANGES) && spark.range !== "all") spark.range = "week";

  function $(s, el) { return (el || document).querySelector(s); }
  function $all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function money(v, signed) {
    var n = num(v); if (n == null) return "—";
    var a = Math.abs(n).toFixed(2);
    if (!signed) return (n < 0 ? "−$" : "$") + a;
    return (n > 0 ? "+$" : n < 0 ? "−$" : "$") + a;
  }
  function pct(v) {
    var n = num(v); if (n == null) return "—";
    if (Math.abs(n) <= 1.5) n = n * 100;
    var s = (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(Math.abs(n) >= 10 ? 1 : 2) + "%";
    return s;
  }
  function ago(ts) {
    var t = num(ts); if (t == null) return "";
    if (t > 1e12) t = t / 1000;
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 172800) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function hold(s) {
    var n = num(s); if (n == null) return "—";
    if (n < 60) return Math.round(n) + "s";
    if (n < 3600) return (n / 60).toFixed(n < 600 ? 1 : 0) + "m";
    return (n / 3600).toFixed(1) + "h";
  }
  function delay(s) {
    var n = num(s); if (n == null) return "—";
    return n < 10 ? n.toFixed(1) + "s" : Math.round(n) + "s";
  }
  function wr(v) {
    var n = num(v); if (n == null) return "—";
    if (n <= 1.5) n = n * 100;
    return n.toFixed(0) + "%";
  }
  function toneClass(v) {
    var n = num(v); if (n == null) return "";
    return n > 0.004 ? "up" : n < -0.004 ? "down" : "";
  }

  function wc(s) {
    s = s || last || {};
    return (s && s.wallet_copy && typeof s.wallet_copy === "object") ? s.wallet_copy : null;
  }

  function setView(next, fromUser) {
    next = next === "copy" ? "copy" : "desk";
    view = next;
    try { localStorage.setItem(KEY, view); } catch (e) {}
    var app = $("#app");
    if (app) {
      app.classList.toggle("app-copy", view === "copy");
      app.classList.toggle("app-desk", view !== "copy");
    }
    var deskBtn = $("#viewDesk"), copyBtn = $("#viewCopy");
    if (deskBtn) { deskBtn.classList.toggle("on", view === "desk"); deskBtn.setAttribute("aria-pressed", String(view === "desk")); }
    if (copyBtn) { copyBtn.classList.toggle("on", view === "copy"); copyBtn.setAttribute("aria-pressed", String(view === "copy")); }
    var root = $("#copyRoot"), bar = $("#copyTabbar");
    if (root) root.hidden = view !== "copy";
    if (bar) bar.hidden = view !== "copy";
    if (view === "copy") {
      document.title = "Buddy · Copy";
      showCopyTab(tab);
      render(last);
    } else {
      document.title = "Buddy";
    }
  }

  function showCopyTab(id) {
    tab = id || "copyHome";
    $all("#copyRoot .copy-tab").forEach(function (el) { el.classList.toggle("on", el.id === tab); });
    $all("#copyTabbar [data-copy-tab]").forEach(function (b) {
      var on = b.getAttribute("data-copy-tab") === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
  }

  /* ---------- spark (same geometry/colors as BuddySpark, unique IDs) ---------- */
  function pathFor(xy) {
    if (!xy.length) return "";
    var d = "M" + xy[0][0].toFixed(2) + " " + xy[0][1].toFixed(2);
    if (xy.length === 1) return d;
    var i, n = xy.length, dx = [], s = [], m = [];
    for (i = 0; i < n - 1; i++) {
      dx[i] = Math.max(1e-6, xy[i + 1][0] - xy[i][0]);
      s[i] = (xy[i + 1][1] - xy[i][1]) / dx[i];
    }
    m[0] = s[0]; m[n - 1] = s[n - 2];
    for (i = 1; i < n - 1; i++) {
      if (s[i - 1] * s[i] <= 0) m[i] = 0;
      else m[i] = 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
    }
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      d += " C" + (xy[i][0] + h).toFixed(2) + " " + (xy[i][1] + m[i] * h).toFixed(2) + " " +
        (xy[i + 1][0] - h).toFixed(2) + " " + (xy[i + 1][1] - m[i + 1] * h).toFixed(2) + " " +
        xy[i + 1][0].toFixed(2) + " " + xy[i + 1][1].toFixed(2);
    }
    return d;
  }
  function scale(pts, start) {
    var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts, span = Math.max(1, t1 - t0);
    var lo = start != null ? start : pts[0].v, hi = lo;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (hi - lo < 0.05) { var mid = (hi + lo) / 2; lo = mid - 0.05; hi = mid + 0.05; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    return {
      x: function (t) { return X0 + Math.min(1, Math.max(0, (t - t0) / span)) * (X_END - X0); },
      y: function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B); }
    };
  }
  function seriesOf(c) {
    var src = Array.isArray(c && c.equity) ? c.equity : [];
    var pts = src.map(function (p) {
      return { ts: num(p && (p.ts != null ? p.ts : p.t)), v: num(p && (p.balance != null ? p.balance : p.equity != null ? p.equity : p.v)) };
    }).filter(function (p) { return p.ts != null && p.v != null; });
    pts.sort(function (a, b) { return a.ts - b.ts; });
    if (pts.length && spark.range !== "all" && RANGES[spark.range]) {
      var cut = (Date.now() / 1000) - RANGES[spark.range], head = null;
      pts = pts.filter(function (p) { if (p.ts < cut) { head = p; return false; } return true; });
      if (head && (!pts.length || pts[0].ts > cut)) pts.unshift({ ts: cut, v: head.v });
    }
    var start = num(c && c.start_stack);
    if (start == null && pts.length) start = pts[0].v;
    return { pts: pts, start: start };
  }
  function drawSpark(c) {
    var wrap = $("#copySparkWrap"), host = $("#copySpark");
    if (!wrap || !host) return;
    var ser = seriesOf(c);
    $all("#copySparkRanges [data-copy-spark]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-copy-spark") === spark.range);
    });
    if (ser.pts.length < 2) {
      wrap.hidden = false;
      host.hidden = true;
      var empty = $("#copySparkEmpty");
      if (empty) empty.hidden = false;
      return;
    }
    host.hidden = false;
    var emptyEl = $("#copySparkEmpty");
    if (emptyEl) emptyEl.hidden = true;
    wrap.hidden = false;
    var sc = scale(ser.pts, ser.start);
    var xy = ser.pts.map(function (p) { return [sc.x(p.ts), sc.y(p.v)]; });
    var lastP = ser.pts[ser.pts.length - 1];
    var ref = ser.start != null ? ser.start : ser.pts[0].v;
    var tone = lastP.v > ref + 0.004 ? "up" : lastP.v < ref - 0.004 ? "down" : "flat";
    var color = tone === "down" ? DOWN : tone === "up" ? UP : FLAT;
    var line = pathFor(xy);
    var area = line + " L" + xy[xy.length - 1][0].toFixed(2) + " " + H + " L" + xy[0][0].toFixed(2) + " " + H + " Z";
    var by = sc.y(ref);
    var svg = host.querySelector("svg");
    if (!svg) {
      host.innerHTML =
        '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="cpFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-s0"/><stop offset="1" class="sp-s1"/></linearGradient>' +
        '<filter id="cpGlow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="' + (W + 40) + '" height="' + (H + 40) + '"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
        '<line class="sp-base" x1="0" x2="' + W + '"/><path class="sp-area" fill="url(#cpFill)"/><path class="sp-line" fill="none" filter="url(#cpGlow)"/></svg>' +
        '<span class="sp-dot"><i></i></span><span class="sp-cross" hidden></span><span class="sp-tip" hidden></span>';
      svg = host.querySelector("svg");
    }
    host.style.setProperty("--sp", color);
    host.className = "spark " + tone;
    var bl = svg.querySelector(".sp-base");
    if (bl) { bl.setAttribute("y1", by.toFixed(2)); bl.setAttribute("y2", by.toFixed(2)); }
    svg.querySelector(".sp-area").setAttribute("d", area);
    svg.querySelector(".sp-line").setAttribute("d", line);
    var dot = host.querySelector(".sp-dot");
    dot.style.left = (xy[xy.length - 1][0] / W * 100) + "%";
    dot.style.top = (xy[xy.length - 1][1] / H * 100) + "%";
    spark.drawn = { pts: ser.pts, sc: sc, start: ser.start };
  }
  function bindSpark() {
    var host = $("#copySpark");
    if (!host || host.dataset.bound) return;
    host.dataset.bound = "1";
    function show(clientX) {
      var d = spark.drawn; if (!d) return;
      var r = host.getBoundingClientRect(); if (!r.width) return;
      var x = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * W;
      var best = d.pts[0], bd = Infinity;
      d.pts.forEach(function (p) { var dd = Math.abs(d.sc.x(p.ts) - x); if (dd < bd) { bd = dd; best = p; } });
      var cx = d.sc.x(best.ts) / W * 100, cy = d.sc.y(best.v) / W * 0 + d.sc.y(best.v) / H * 100;
      var cross = host.querySelector(".sp-cross"), tip = host.querySelector(".sp-tip");
      if (!cross || !tip) return;
      cross.hidden = false; tip.hidden = false;
      cross.style.left = cx + "%"; cross.style.setProperty("--y", cy + "%");
      var chg = d.start != null ? best.v - d.start : null;
      var t = new Date(best.ts * 1000);
      tip.innerHTML = "<b>$" + best.v.toFixed(2) + "</b>" +
        (chg != null ? ' <span class="' + (chg > 0.004 ? "up" : chg < -0.004 ? "down" : "") + '">' + (chg >= 0 ? "+" : "−") + "$" + Math.abs(chg).toFixed(2) + "</span>" : "") +
        "<small>" + t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) +
        (t.toDateString() === new Date().toDateString() ? "" : " · " + t.toLocaleDateString([], { month: "short", day: "numeric" })) + "</small>";
      var tw = tip.offsetWidth || 120, hw = r.width, px = cx / 100 * hw;
      tip.style.left = Math.max(tw / 2 + 4, Math.min(hw - tw / 2 - 4, px)) + "px";
      host.classList.add("scrub");
    }
    function hide() {
      host.classList.remove("scrub");
      var c = host.querySelector(".sp-cross"), t = host.querySelector(".sp-tip");
      if (c) c.hidden = true; if (t) t.hidden = true;
    }
    host.addEventListener("pointerdown", function (e) { show(e.clientX); });
    host.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse" || e.buttons) show(e.clientX); });
    host.addEventListener("pointerleave", hide);
    host.addEventListener("pointerup", function (e) { if (e.pointerType !== "mouse") setTimeout(hide, 1200); });
    host.addEventListener("pointercancel", hide);
    var ranges = $("#copySparkRanges");
    if (ranges) ranges.addEventListener("click", function (e) {
      var b = e.target.closest("[data-copy-spark]"); if (!b) return;
      spark.range = b.getAttribute("data-copy-spark") || "week";
      try { localStorage.setItem(RANGE_KEY, spark.range); } catch (err) {}
      if (last) render(last);
    });
  }

  /* ---------- panels ---------- */

  function ctlOf(s, c) {
    var ds = (s && s.desk_settings && s.desk_settings.copy_trade) || {};
    var st = (c && c.settings && typeof c.settings === "object") ? c.settings : ds;
    function val(k, alias) {
      var n = num(st[k]);
      if (n == null && st.values && st.values[alias]) n = num(st.values[alias].value);
      if (n == null && ds[k] != null) n = num(ds[k]);
      return n;
    }
    var enabled = !!(st.copy_enabled || st.enabled || (c && c.copy_enabled) || ds.copy_enabled || ds.enabled);
    return {
      enabled: enabled,
      buy_usd: val("copy_buy_usd", "buy_usd"),
      sl_pct: val("copy_sl_pct", "sl_pct"),
      tp_pct: val("copy_tp_pct", "tp_pct")
    };
  }
  function fieldVal(id) {
    var el = $(id);
    return el ? num(el.value) : null;
  }
  function inBounds(key, n) {
    if (n == null) return false;
    var b = BOUNDS[key];
    return n >= b[0] - 1e-12 && n <= b[1] + 1e-12;
  }
  function dirtyFields(srv) {
    var out = {};
    var ids = { buy_usd: "#copyBuyUsd", sl_pct: "#copySlPct", tp_pct: "#copyTpPct" };
    Object.keys(ids).forEach(function (k) {
      var cur = ctlEdits[k] != null ? ctlEdits[k] : fieldVal(ids[k]);
      var base = srv[k] != null ? srv[k] : DEFAULTS[k];
      if (cur != null && Math.abs(cur - base) > 1e-9) out[k] = cur;
    });
    return out;
  }
  function ask(a) {
    if (hooks.confirm) hooks.confirm(a);
  }
  function setField(id, key, value, dirty, invalid) {
    var el = $(id);
    if (!el) return;
    var focused = document.activeElement === el;
    if (!focused) {
      var shown = value != null ? value : DEFAULTS[key];
      if (String(el.value) !== String(shown)) el.value = shown;
    }
    var wrap = el.closest(".copy-ctl-input");
    if (wrap) {
      wrap.classList.toggle("changed", !!dirty);
      wrap.classList.toggle("bad", !!invalid);
    }
  }
  function renderControls(s, c) {
    var srv = ctlOf(s, c);
    var sw = $("#copyEnabledSw"), hint = $("#copyCtlHint"), save = $("#copyCtlSave"), st = $("#copyCtlStatus");
    if (ctlPend && Date.now() - ctlPend.at > 90000) ctlPend = null;
    if (ctlPend && ctlPend.kind === "toggle" && ctlPend.on === srv.enabled) ctlPend = null;
    if (ctlPend && ctlPend.kind === "save") {
      var left = dirtyFields(srv);
      if (!Object.keys(left).length) { ctlPend = null; ctlEdits = { buy_usd: null, sl_pct: null, tp_pct: null }; }
    }
    var shownOn = ctlPend && ctlPend.kind === "toggle" ? ctlPend.on : srv.enabled;
    if (sw) {
      sw.classList.toggle("on", !!shownOn);
      sw.classList.toggle("busy", !!(ctlPend && ctlPend.kind === "toggle"));
      sw.setAttribute("aria-checked", shownOn ? "true" : "false");
      sw.disabled = !!(ctlPend && ctlPend.kind === "toggle");
    }
    if (hint) {
      hint.textContent = shownOn
        ? "On · copies book as PAPER trades on a separate copy balance. REAL cannot be triggered from copy mode."
        : "Off · shadow only. Turn on to book PAPER fills on a separate copy balance. REAL cannot be triggered from copy mode.";
    }
    var dirty = dirtyFields(srv);
    var bad = [];
    [["#copyBuyUsd", "buy_usd"], ["#copySlPct", "sl_pct"], ["#copyTpPct", "tp_pct"]].forEach(function (pair) {
      var k = pair[1];
      var cur = ctlEdits[k] != null ? ctlEdits[k] : (dirty[k] != null ? dirty[k] : srv[k]);
      var invalid = cur != null && !inBounds(k, cur);
      if (invalid) bad.push(k);
      var use = ctlEdits[k] != null ? ctlEdits[k] : (srv[k] != null ? srv[k] : DEFAULTS[k]);
      setField(pair[0], k, use, dirty[k] != null, invalid);
    });
    if (save) {
      save.disabled = !Object.keys(dirty).length || bad.length > 0 || !!(ctlPend && ctlPend.kind === "save");
      save.textContent = (ctlPend && ctlPend.kind === "save") ? "Saving…" : "Save";
    }
    if (st) {
      if (bad.length) st.textContent = "Buy $1–$100, stop 1–50%, take-profit 1–500%.";
      else if (ctlPend && ctlPend.kind === "toggle") st.textContent = "Sending…";
      else if (ctlPend && ctlPend.kind === "save") st.textContent = "Saving…";
      else if (Object.keys(dirty).length) st.textContent = "Unsaved changes.";
      else st.textContent = shownOn ? "PAPER copy ledger · live values from the desk." : "Saved. Copy trading is off.";
    }
  }
  function toggleCopyTrade() {
    var sw = $("#copyEnabledSw");
    var on = sw ? !sw.classList.contains("on") : true;
    ask({
      title: on ? "Turn copy trading on?" : "Turn copy trading off?",
      body: on
        ? "PAPER only. New copies will be booked on a separate copy paper balance, using your buy amount, stop-loss and take-profit. This never arms REAL and never changes REAL limits. Existing desk paper trades are untouched."
        : "Copy trading goes back to shadow only. Already-open paper copy trades will still close on the copy ledger. REAL is unchanged.",
      ok: on ? "Turn on" : "Turn off",
      cmds: [on ? "copytrade:on" : "copytrade:off"],
      toast: on ? "Copy trading on · PAPER" : "Copy trading off · shadow only",
      after: function () { ctlPend = { kind: "toggle", on: on, at: Date.now() }; }
    });
  }
  function saveCopyTrade() {
    var srv = ctlOf(last, wc(last));
    var dirty = dirtyFields(srv);
    var cmds = [];
    var bad = [];
    Object.keys(dirty).forEach(function (k) {
      if (!inBounds(k, dirty[k])) bad.push(k);
      else cmds.push("set:copytrade:" + k + "=" + dirty[k]);
    });
    var stEl = $("#copyCtlStatus");
    if (bad.length) {
      if (stEl) stEl.textContent = "Buy $1–$100, stop 1–50%, take-profit 1–500%.";
      return;
    }
    if (!cmds.length) return;
    ask({
      title: "Save copy size and exits?",
      body: "Applies to new PAPER copy trades only. Buy $1–$100, stop 1–50%, take-profit 1–500%. REAL limits stay $3 / 5 open / $50 daily loss and are never read from these fields.",
      ok: "Save",
      cmds: cmds,
      toast: "Copy settings sent",
      after: function () { ctlPend = { kind: "save", at: Date.now() }; }
    });
  }
  function onCtlInput(e) {
    var id = e.target && e.target.id;
    var map = { copyBuyUsd: "buy_usd", copySlPct: "sl_pct", copyTpPct: "tp_pct" };
    if (!map[id]) return;
    ctlEdits[map[id]] = num(e.target.value);
    renderControls(last, wc(last));
  }

  function statusLabel(c) {
    if (!c || c.engine_status === "not_running") return { text: "Engine not running yet", live: false, pulse: false };
    if (c.live || (c.scan && c.scan.pulse)) return { text: "Live scanning wallets", live: true, pulse: true };
    if (c.engine_status === "idle") return { text: "Idle · waiting for the next wallet event", live: false, pulse: false };
    if (c.engine_status === "offline") return { text: "Offline · last update " + (ago(c.updated_ts) || "unknown"), live: false, pulse: false };
    return { text: c.engine_status || "Unknown", live: !!c.live, pulse: !!(c.scan && c.scan.pulse) };
  }

  function renderHero(c) {
    var kicker = $("#copyKicker"), bal = $("#copyBal"), sub = $("#copyPnlSub");
    var usd = $("#copyPnlUsd"), pp = $("#copyPnlPct"), pill = $("#copyMultPill");
    var st = statusLabel(c);
    if (!c || c.engine_status === "not_running") {
      if (kicker) kicker.textContent = "Copy trading";
      if (bal) bal.textContent = "—";
      if (usd) usd.textContent = "—";
      if (pp) pp.textContent = "—";
      if (sub) sub.textContent = "No copy P&L yet · this view only shows real copy fills";
      if (pill) pill.hidden = true;
      return;
    }
    var hasStart = num(c.start_stack) != null && num(c.start_stack) !== 0;
    var shown = hasStart ? num(c.balance) : num(c.pnl_usd);
    if (kicker) kicker.textContent = hasStart ? "Copy equity" : "Copy P&L";
    if (bal) bal.textContent = shown == null ? "—" : money(shown, !hasStart);
    if (usd) { usd.textContent = c.pnl_usd == null ? "—" : money(c.pnl_usd, true); usd.className = toneClass(c.pnl_usd); }
    if (pp) { pp.textContent = c.pnl_pct == null ? "—" : ((c.pnl_pct > 0 ? "+" : c.pnl_pct < 0 ? "−" : "") + Math.abs(c.pnl_pct).toFixed(2) + "%"); pp.className = toneClass(c.pnl_pct); }
    if (sub) {
      sub.textContent = (c.closed && c.closed.length ? (c.wins + "W / " + c.losses + "L") : "No closed copy trades yet") +
        (st.live ? " · live" : "");
    }
    if (pill) {
      var w = num(c.wins) || 0, l = num(c.losses) || 0;
      if (w + l > 0) {
        pill.hidden = false;
        $("#copyMultW").textContent = String(w);
        $("#copyMultL").textContent = String(l);
      } else pill.hidden = true;
    }
  }

  function renderScan(c) {
    var pulse = $("#copyScanPulse"), title = $("#copyScanTitle"), meta = $("#copyScanMeta");
    var body = $("#copyScanBody");
    var st = statusLabel(c);
    if (pulse) pulse.classList.toggle("on", !!(st.pulse));
    if (title) title.textContent = st.text;
    var n = c && c.scan ? (num(c.scan.watching) || 0) : 0;
    var tracked = c && c.scan ? num(c.scan.tracked) : null;
    var lastA = c && c.scan ? c.scan.last_activity_ts : null;
    var lag = c && c.scan ? num(c.scan.detect_lag_s) : null;
    var bits = [];
    if (n) bits.push(n + " copyable");
    else if (st.live) bits.push("Scanning · no wallets currently copyable");
    else bits.push("No copyable wallets yet");
    if (tracked != null) bits.push(tracked + " scored");
    if (lag != null) bits.push("detect lag " + delay(lag));
    if (lastA) bits.push("last activity " + ago(lastA));
    if (meta) meta.textContent = bits.join(" · ");
    if (!body) return;
    if (!c || (!n && !(c.scan && (c.scan.added || []).length) && !(c.scan && (c.scan.dropped || []).length))) {
      body.innerHTML = '<p class="copy-empty">Nothing to show yet. New winners will appear here when the engine qualifies them, and wallets that stop winning will be listed as dropped.</p>';
      return;
    }
    function evList(items, cls, label) {
      items = items || [];
      if (!items.length) return "";
      return '<p class="copy-subhead">' + label + "</p>" + items.slice().reverse().slice(0, 8).map(function (e) {
        return '<div class="cpw-ev ' + cls + '"><span class="cpw-h">' + esc(e.short || e.wallet) + "</span>" +
          (e.why ? '<span class="cpw-why">' + esc(e.why) + "</span>" : "") +
          '<span class="cpw-ago">' + esc(ago(e.ts) || "") + "</span></div>";
      }).join("");
    }
    body.innerHTML = evList((c.scan && c.scan.added) || [], "add", "Newly added winners") +
      evList((c.scan && c.scan.dropped) || [], "drop", "Dropped wallets") ||
      '<p class="copy-empty">Watching ' + n + " wallet" + (n === 1 ? "" : "s") + ". No adds or drops recorded yet.</p>";
  }

  function walletRow(w) {
    return '<div class="cpw-row">' +
      '<span class="cpw-h" title="' + esc(w.wallet) + '">' + esc(w.short || w.wallet) + "</span>" +
      '<span class="cpw-st">' + esc(w.status || "watched") + "</span>" +
      '<span class="cpw-wr">' + wr(w.win_rate) + "</span>" +
      '<span class="cpw-n">' + (w.trades != null ? esc(String(w.trades)) : "—") + " tr</span>" +
      '<span class="cpw-p ' + toneClass(w.pnl_usd) + '">' + (w.pnl_usd == null ? "—" : money(w.pnl_usd, true)) + "</span>" +
      '<span class="cpw-hold">' + hold(w.avg_hold_s) + "</span>" +
      "</div>";
  }

  function renderWallets(c) {
    var list = $("#copyWalletList"), count = $("#copyWalletCount");
    var rows = (c && Array.isArray(c.wallets)) ? c.wallets : [];
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<p class="copy-empty">No tracked wallets yet. The list stays empty until the engine qualifies a wallet from live trades.</p>';
      return;
    }
    list.innerHTML = '<div class="cpw-head"><span>Wallet</span><span>Status</span><span>Win</span><span>Trades</span><span>PnL</span><span>Avg hold</span></div>' +
      rows.map(walletRow).join("");
  }

  function tradeRow(t, closed) {
    var pnl = closed ? t.pnl_usd : t.pnl_usd;
    var chg = closed ? t.pnl_pct : t.pnl_pct;
    return '<div class="cpt-row">' +
      '<div class="cpt-main"><span class="cpt-sym">' + esc(t.symbol || t.name || (t.mint || "").slice(0, 6) || "Coin") + "</span>" +
      '<span class="cpt-wallet">@' + esc(t.wallet_short || t.wallet || "?") + "</span></div>" +
      '<div class="cpt-meta">delay ' + delay(t.delay_s) +
      (closed && t.exit_reason ? " · " + esc(t.exit_reason) : "") +
      (closed && t.t_exit ? " · " + ago(t.t_exit) : (t.t_entry ? " · " + ago(t.t_entry) : "")) + "</div>" +
      '<div class="cpt-pnl ' + toneClass(pnl) + '">' + (pnl == null ? "—" : money(pnl, true)) +
      (chg == null ? "" : '<small>' + esc(pct(chg)) + "</small>") + "</div></div>";
  }

  function renderOpens(c) {
    var el = $("#copyOpens"), count = $("#copyOpenCount");
    var rows = (c && Array.isArray(c.open)) ? c.open : [];
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p class="copy-empty">No open copied trades.</p>';
      return;
    }
    el.innerHTML = rows.map(function (t) { return tradeRow(t, false); }).join("");
  }

  function renderClosed(c) {
    var el = $("#copyClosed"), count = $("#copyClosedCount");
    var rows = (c && Array.isArray(c.closed)) ? c.closed : [];
    if (count) count.textContent = rows.length ? String(rows.length) : "";
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p class="copy-empty">No closed copy trades yet. Each row will show the wallet that triggered the copy and the delay between their fill and ours.</p>';
      return;
    }
    el.innerHTML = rows.map(function (t) { return tradeRow(t, true); }).join("");
  }

  function stat(label, value, cls) {
    return '<div><strong class="' + (cls || "") + '">' + esc(value) + "</strong><span>" + esc(label) + "</span></div>";
  }
  function renderAnalytics(c) {
    var el = $("#copyStats");
    if (!el) return;
    var a = (c && c.analytics) || {};
    if (!c || !(a.trades || c.wins || c.losses)) {
      el.innerHTML = stat("Win rate", "—") + stat("Avg delay", "—") + stat("Avg hold", "—") +
        stat("Wins", "—") + stat("Losses", "—") + stat("Profit factor", "—");
      return;
    }
    el.innerHTML =
      stat("Win rate", wr(a.win_rate), toneClass((a.win_rate || 0) - 0.5)) +
      stat("Avg delay", delay(a.avg_delay_s)) +
      stat("Avg hold", hold(a.avg_hold_s)) +
      stat("Wins", a.wins != null ? String(a.wins) : "—", "up") +
      stat("Losses", a.losses != null ? String(a.losses) : "—", "down") +
      stat("Profit factor", a.profit_factor != null ? String(a.profit_factor) : "—");
  }

  function renderNote(c) {
    var el = $("#copyNote");
    if (!el) return;
    if (c && c.note) { el.hidden = false; el.textContent = c.note; }
    else { el.hidden = true; el.textContent = ""; }
  }

  function render(s) {
    last = s || last;
    var c = wc(last);
    if (view !== "copy") return;
    renderHero(c);
    drawSpark(c || {});
    renderScan(c);
    renderWallets(c);
    renderOpens(c);
    renderClosed(c);
    renderAnalytics(c);
    renderNote(c);
    renderControls(last, c);
  }

  function bind() {
    if (bind.ok) return;
    bind.ok = true;
    bindSpark();
    var deskBtn = $("#viewDesk"), copyBtn = $("#viewCopy");
    if (deskBtn) deskBtn.addEventListener("click", function () { setView("desk", true); });
    if (copyBtn) copyBtn.addEventListener("click", function () { setView("copy", true); });
    var sw = $("#copyEnabledSw"), save = $("#copyCtlSave");
    if (sw) sw.addEventListener("click", function (e) { e.preventDefault(); toggleCopyTrade(); });
    if (save) save.addEventListener("click", function (e) { e.preventDefault(); saveCopyTrade(); });
    ["copyBuyUsd", "copySlPct", "copyTpPct"].forEach(function (id) {
      var el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", onCtlInput);
      el.addEventListener("change", onCtlInput);
    });
    var bar = $("#copyTabbar");
    if (bar) bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-copy-tab]"); if (!b) return;
      showCopyTab(b.getAttribute("data-copy-tab"));
    });
    setView(view, false);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
    else bind();
  }

  root.BuddyCopyApp = { render: render, setView: setView, view: function () { return view; }, hooks: hooks };
})(typeof window !== "undefined" ? window : globalThis);
