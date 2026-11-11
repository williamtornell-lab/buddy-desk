/* Buddy hero sparkline: same look, ranges and zoom in PAPER and REAL.
   PAPER: equity since the last paper reset, plus live paper marks.
   REAL: hot-wallet USDC+SOL series only — never paper numbers.
   Desk off/on archives Insights sessions only — it must not cut this series.
   A short incoming payload is merged with the longer cached history. */
(function (root) {
  "use strict";
  var UP = "#30d158", DOWN = "#ff453a", FLAT = "#30d158";
  var W = 360, H = 96, PAD_T = 12, PAD_B = 12;
  var X0 = 4, X_END = W * 0.82;   // line + dot end ~18% in from the right (room ahead)
  var GAP_S = 180;                // idle gaps longer than 3 min are compressed to 3 min
  var MAX_PTS = 90;
  var RANGES = { reset: 0, day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  var st = { range: "reset", seen: [], seenKey: "", drawn: null, anim: 0, series: [], start: null, since: null, zoomFrom: null };
  var ZOOM_MS = 450;              // range change: x/y domain zoom, ease-out
  var tweens = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function unix(t) {
    if (t == null || t === "") return null;
    if (typeof t === "number") return t > 1e12 ? t / 1000 : t;
    var n = Number(t); if (Number.isFinite(n)) return n > 1e12 ? n / 1000 : n;
    var p = Date.parse(t); return Number.isFinite(p) ? p / 1000 : null;
  }
  function $(s) { return document.querySelector(s); }
  try { st.range = (root.localStorage && localStorage.getItem("buddy.sparkRange")) || "reset"; } catch (e) { /* ignore */ }
  if (!(st.range in RANGES)) st.range = "reset";

  /* ---- count tween for hero numbers ---- */
  function tween(el, value, fmt) {
    if (!el) return;
    var v = num(value);
    if (v == null) { el.textContent = fmt(value); return; }
    var rec = tweens ? tweens.get(el) : el.__tw;
    if (!rec) {
      rec = { cur: v, to: v, raf: 0 };
      if (tweens) tweens.set(el, rec); else el.__tw = rec;
      el.textContent = fmt(v);
      return;
    }
    if (Math.abs(rec.to - v) < 1e-9) { if (!rec.raf) el.textContent = fmt(v); return; }
    var from = rec.cur, t0 = performance.now(), dur = 700;
    rec.to = v;
    el.classList.remove("tick-up", "tick-down");
    void el.offsetWidth;
    el.classList.add(v > from ? "tick-up" : "tick-down");
    if (rec.raf) cancelAnimationFrame(rec.raf);
    var reduce = root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { rec.cur = v; rec.raf = 0; el.textContent = fmt(v); return; }
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      rec.cur = from + (v - from) * e;
      el.textContent = fmt(k >= 1 ? v : rec.cur);
      rec.raf = k < 1 ? requestAnimationFrame(step) : 0;
    })(t0);
  }

  /* Keep the longer of (incoming, last cached) so a short snapshot or desk
     toggle cannot wipe the line. Keyed separately for REAL and PAPER. */
  function histKey(live) { return live ? "buddy.equityHist.real" : "buddy.equityHist.paper"; }
  function loadHist(live) {
    try {
      var raw = JSON.parse(localStorage.getItem(histKey(live)) || "null");
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function saveHist(live, pts) {
    try { localStorage.setItem(histKey(live), JSON.stringify(pts.slice(-4000))); } catch (e) { /* ignore */ }
  }
  function mergeHist(live, pts) {
    var hist = loadHist(live);
    if (!hist.length && !pts.length) return pts;
    var by = {};
    function put(p) {
      var ts = unix(p && (p.ts != null ? p.ts : p.t));
      var v = num(p && (p.v != null ? p.v : (p.balance != null ? p.balance : p.equity)));
      if (ts == null || v == null) return;
      by[Math.round(ts)] = { ts: ts, v: v };
    }
    hist.forEach(put);
    pts.forEach(put); /* incoming wins on the same second */
    var out = Object.keys(by).map(function (k) { return by[k]; });
    out.sort(function (a, b) { return a.ts - b.ts; });
    saveHist(live, out);
    return out;
  }

  /* ---- series ---- */
  function buildSeries(s, perf, extra, nowTs, live) {
    var d = s.dashboard || {};
    var src = live
      ? (Array.isArray(s.real_equity) && s.real_equity.length ? s.real_equity
        : (s.real && Array.isArray(s.real.equity) && s.real.equity.length ? s.real.equity : []))
      : (Array.isArray(s.paper_equity) && s.paper_equity.length ? s.paper_equity
        : (Array.isArray(s.equity) ? s.equity : []));
    /* "Reset" is paper_reset_at only. Never desk_session_start / dashboard.session. */
    var sessStart = num(d.session && d.session.start);
    var resetAt = unix(s.paper_reset_at) || null;
    var dashSince = num(d.since);
    if (dashSince && sessStart && Math.abs(dashSince - sessStart) < 1) dashSince = null;
    var since = live ? null : (resetAt || dashSince || null);
    var start = live ? null : (perf && perf.known ? perf.start : null);
    var pts = src.map(function (p) {
      return { ts: unix(p && (p.ts != null ? p.ts : p.t)), v: num(p && (p.balance != null ? p.balance : p.equity)) };
    }).filter(function (p) { return p.ts != null && p.v != null; });
    if (live) {
      /* Drop leading failed/zero wallet reads once a real balance exists. Never use paper points. */
      var hasPos = pts.some(function (p) { return p.v > 0.005; }) || (perf && perf.bal != null && perf.bal > 0.005);
      if (hasPos) pts = pts.filter(function (p) { return p.v > 0.005; });
      start = pts.length ? pts[0].v : (perf && perf.bal != null ? perf.bal : null);
    }
    pts = mergeHist(live, pts);
    if (live) {
      var hasPos2 = pts.some(function (p) { return p.v > 0.005; }) || (perf && perf.bal != null && perf.bal > 0.005);
      if (hasPos2) pts = pts.filter(function (p) { return p.v > 0.005; });
      start = pts.length ? pts[0].v : (perf && perf.bal != null ? perf.bal : null);
    }
    if (since) {
      var before = null;
      pts = pts.filter(function (p) { if (p.ts < since) { before = p; return false; } return true; });
      var anchor = start != null ? start : (before ? before.v : (pts[0] && pts[0].v));
      if (anchor != null) pts.unshift({ ts: since, v: anchor });
    }
    var key = (live ? "real|" : "paper|") + String(since || "") + "|" + String(start || "");
    if (st.seenKey !== key) {
      st.seenKey = key;
      st.seen = [];
      try {
        var saved = JSON.parse(localStorage.getItem("buddy.sparkSeen") || "null");
        if (saved && saved.key === key && Array.isArray(saved.pts)) st.seen = saved.pts.slice(-600);
      } catch (e) { /* ignore */ }
    }
    var liveV = perf && perf.bal != null ? (perf.bal + (live ? 0 : (extra || 0))) : null;
    if (liveV != null && Number.isFinite(liveV)) {
      var last = st.seen[st.seen.length - 1];
      if (!last || nowTs - last.ts >= 5 || Math.abs(last.v - liveV) > 0.004) {
        st.seen.push({ ts: nowTs, v: liveV });
        if (st.seen.length > 600) st.seen = st.seen.slice(-600);
        try { localStorage.setItem("buddy.sparkSeen", JSON.stringify({ key: key, pts: st.seen })); } catch (e) { /* ignore */ }
      }
    }
    var all = pts.concat(st.seen.filter(function (p) { return !since || p.ts >= since; }));
    all.sort(function (a, b) { return a.ts - b.ts; });
    var out = [];
    all.forEach(function (p) {
      var prev = out[out.length - 1];
      if (prev && Math.abs(prev.ts - p.ts) < 1) { prev.v = p.v; return; }
      out.push({ ts: p.ts, v: p.v });
    });
    var win = RANGES[st.range];
    if (win) {
      var cut = nowTs - win;
      var head = null;
      out = out.filter(function (p) { if (p.ts < cut) { head = p; return false; } return true; });
      if (head) out.unshift({ ts: cut, v: head.v });
    }
    if (out.length === 1) out.unshift({ ts: out[0].ts - 60, v: out[0].v });
    out = tidy(out);
    return { pts: out, start: start, since: since };
  }

  /* Drop runs of identical values, bucket to <= MAX_PTS on compressed time and
     lightly smooth interior points (first/last stay exact). */
  function tidy(pts) {
    if (pts.length <= 3) return pts;
    var keep = [pts[0]];
    for (var i = 1; i < pts.length - 1; i++) {
      var a = keep[keep.length - 1], b = pts[i], c = pts[i + 1];
      if (Math.abs(a.v - b.v) < 0.005 && Math.abs(b.v - c.v) < 0.005) continue;
      keep.push(b);
    }
    keep.push(pts[pts.length - 1]);
    if (keep.length > MAX_PTS) {
      var cm = compress(keep), total = cm.c[cm.c.length - 1] || 1, step = total / (MAX_PTS - 1), out = [keep[0]], nextAt = step;
      for (var j = 1; j < keep.length - 1; j++) {
        if (cm.c[j] >= nextAt) { out.push(keep[j]); nextAt = cm.c[j] + step; }
      }
      out.push(keep[keep.length - 1]);
      keep = out;
    }
    if (keep.length > 4) {
      var sm = keep.map(function (p) { return { ts: p.ts, v: p.v }; });
      // median-of-3 drops one-tick spikes (a single bad quote), then a light blend
      for (var k = 1; k < keep.length - 1; k++) {
        var tri = [keep[k - 1].v, keep[k].v, keep[k + 1].v].sort(function (x, y) { return x - y; });
        sm[k].v = tri[1];
      }
      var sm2 = sm.map(function (p) { return { ts: p.ts, v: p.v }; });
      for (var q = 1; q < sm.length - 1; q++) sm2[q].v = sm[q - 1].v * 0.2 + sm[q].v * 0.6 + sm[q + 1].v * 0.2;
      keep = sm2;
    }
    return keep;
  }

  /* Compressed time: each gap counts at most GAP_S, so idle stretches don't eat the width. */
  function compress(pts) {
    var c = [0];
    for (var i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.min(GAP_S, Math.max(0, pts[i].ts - pts[i - 1].ts)));
    return { ts: pts.map(function (p) { return p.ts; }), c: c };
  }

  function yRange(pts, start) {
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (start != null) { lo = Math.min(lo, start); hi = Math.max(hi, start); }
    var ref = start != null ? start : pts[0].v;
    var minSpan = Math.max(2, Math.abs(ref) * 0.03);  // small moves stay small
    if (hi - lo < minSpan) { var mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    var pad = (hi - lo) * 0.18;
    return { lo: lo - pad, hi: hi + pad };
  }

  function scale(pts, start) {
    var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    var yr = yRange(pts, start), lo = yr.lo, hi = yr.hi;
    var cm = compress(pts), total = Math.max(1, cm.c[cm.c.length - 1]);
    function cOf(t) {
      var ts = cm.ts, c = cm.c, n = ts.length;
      if (t <= ts[0]) return 0;
      if (t >= ts[n - 1]) return c[n - 1] + Math.min(GAP_S, t - ts[n - 1]);
      var a = 0, b = n - 1;
      while (b - a > 1) { var m = (a + b) >> 1; if (ts[m] <= t) a = m; else b = m; }
      var g = ts[b] - ts[a];
      return c[a] + (g > 0 ? (t - ts[a]) / g : 0) * (c[b] - c[a]);
    }
    return {
      x: function (t) { return X0 + Math.min(1, cOf(t) / total) * (X_END - X0); },
      base: start != null ? start : null,
      y: function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B); },
      t0: t0, t1: t1, lo: lo, hi: hi
    };
  }

  /* Range-change zoom: a scale over the union of old+new points whose visible x-domain
     [d0, d1] and y-domain [lo, hi] are interpolated. Same compressed time, same X0..X_END
     inset; points outside the domain fall off the edges (SVG clips them). */
  function zoomScale(pts, d0, d1, lo, hi, start) {
    var cm = compress(pts);
    function cOf(t) {
      var ts = cm.ts, c = cm.c, n = ts.length;
      if (t <= ts[0]) return c[0] - Math.min(GAP_S, ts[0] - t);
      if (t >= ts[n - 1]) return c[n - 1] + Math.min(GAP_S, t - ts[n - 1]);
      var a = 0, b = n - 1;
      while (b - a > 1) { var m = (a + b) >> 1; if (ts[m] <= t) a = m; else b = m; }
      var g = ts[b] - ts[a];
      return c[a] + (g > 0 ? (t - ts[a]) / g : 0) * (c[b] - c[a]);
    }
    var ca = cOf(d0), cb = cOf(d1), span = Math.max(1e-6, cb - ca);
    return {
      x: function (t) { return X0 + (cOf(t) - ca) / span * (X_END - X0); },
      base: start != null ? start : null,
      y: function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B); },
      t0: d0, t1: d1, lo: lo, hi: hi
    };
  }

  function zoom(from, series) {
    var a = from.pts, b = series.pts;
    if (!a || a.length < 2 || b.length < 2) { draw(series); return; }
    // Draw the wider series (it covers both windows); the final frame is the normal draw.
    var wide = (a[0].ts <= b[0].ts ? a : b);
    var ta0 = a[0].ts, ta1 = a[a.length - 1].ts, tb0 = b[0].ts, tb1 = b[b.length - 1].ts;
    var ya = from.sc && from.sc.lo != null ? from.sc : yRange(a, from.start);
    var yb = yRange(b, series.start);
    var t0 = performance.now();
    (function step(now) {
      var k = Math.min(1, (now - t0) / ZOOM_MS), e = 1 - Math.pow(1 - k, 3);
      if (k >= 1) { st.anim = 0; draw(series); return; }
      var sc = zoomScale(wide, ta0 + (tb0 - ta0) * e, ta1 + (tb1 - ta1) * e,
        ya.lo + (yb.lo - ya.lo) * e, ya.hi + (yb.hi - ya.hi) * e, series.start);
      draw({ pts: wide, start: series.start, since: series.since }, null, sc);
      st.anim = requestAnimationFrame(step);
    })(t0);
  }

  /* Monotone cubic path (no overshoot), the smooth "video" line. */
  function pathFor(xy) {
    var n = xy.length;
    if (n < 2) return "";
    var d = "M" + xy[0][0].toFixed(2) + " " + xy[0][1].toFixed(2);
    if (n === 2) return d + " L" + xy[1][0].toFixed(2) + " " + xy[1][1].toFixed(2);
    var m = [], dx = [], dy = [], s = [], i;
    for (i = 0; i < n - 1; i++) { dx[i] = xy[i + 1][0] - xy[i][0]; dy[i] = xy[i + 1][1] - xy[i][1]; s[i] = dx[i] ? dy[i] / dx[i] : 0; }
    m[0] = s[0]; m[n - 1] = s[n - 2];
    // Fritsch-Butland tangents: bounded, so uneven x spacing can't overshoot.
    for (i = 1; i < n - 1; i++) {
      if (s[i - 1] * s[i] <= 0) { m[i] = 0; continue; }
      m[i] = 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / s[i - 1] + (dx[i] + 2 * dx[i - 1]) / s[i]);
    }
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      d += " C" + (xy[i][0] + h).toFixed(2) + " " + (xy[i][1] + m[i] * h).toFixed(2) + " " +
        (xy[i + 1][0] - h).toFixed(2) + " " + (xy[i + 1][1] - m[i + 1] * h).toFixed(2) + " " +
        xy[i + 1][0].toFixed(2) + " " + xy[i + 1][1].toFixed(2);
    }
    return d;
  }

  function draw(series, lerpLast, scOverride) {
    var host = $("#spark");
    if (!host) return;
    var pts = series.pts.slice();
    if (pts.length < 2) { host.hidden = true; return; }
    host.hidden = false;
    if (lerpLast) pts[pts.length - 1] = lerpLast;
    var sc = scOverride || scale(series.pts, series.start);
    var xy = pts.map(function (p) { return [sc.x(p.ts), sc.y(p.v)]; });
    var last = pts[pts.length - 1];
    var ref = series.start != null ? series.start : pts[0].v;
    var tone = last.v > ref + 0.004 ? "up" : last.v < ref - 0.004 ? "down" : "flat";
    var color = tone === "down" ? DOWN : tone === "up" ? UP : FLAT;
    var line = pathFor(xy);
    var area = line + " L" + xy[xy.length - 1][0].toFixed(2) + " " + H + " L" + xy[0][0].toFixed(2) + " " + H + " Z";
    var by = sc.y(ref);
    var svg = host.querySelector("svg");
    if (!svg) {
      host.innerHTML =
        '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="spFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-s0"/><stop offset="1" class="sp-s1"/></linearGradient>' +
        '<filter id="spGlow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="' + (W + 40) + '" height="' + (H + 40) + '"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
        '<line class="sp-base" x1="0" x2="' + W + '"/><path class="sp-area" fill="url(#spFill)"/><path class="sp-line" fill="none" filter="url(#spGlow)"/></svg>' +
        '<span class="sp-dot"><i></i></span><span class="sp-cross" hidden></span><span class="sp-tip" hidden></span>';
      svg = host.querySelector("svg");
    }
    host.style.setProperty("--sp", color);
    host.className = "spark " + tone;
    var bl = svg.querySelector(".sp-base");
    if (bl) { bl.setAttribute("y1", by.toFixed(2)); bl.setAttribute("y2", by.toFixed(2)); }
    svg.querySelector(".sp-area").setAttribute("d", area);
    svg.querySelector(".sp-line").setAttribute("d", line);
    // While zooming, points outside the visible domain are clipped at the chart's left/right edges.
    if (scOverride && !svg.querySelector("#spZoomClip")) {
      var defs = svg.querySelector("defs");
      if (defs) defs.insertAdjacentHTML("beforeend", '<clipPath id="spZoomClip" clipPathUnits="userSpaceOnUse"><rect x="0" y="-40" width="' + W + '" height="' + (H + 80) + '"/></clipPath>');
    }
    ["sp-area", "sp-line"].forEach(function (c) {
      var el = svg.querySelector("." + c);
      if (scOverride) el.setAttribute("clip-path", "url(#spZoomClip)"); else el.removeAttribute("clip-path");
    });
    var dot = host.querySelector(".sp-dot");
    dot.style.left = (xy[xy.length - 1][0] / W * 100) + "%";
    dot.style.top = (xy[xy.length - 1][1] / H * 100) + "%";
    st.drawn = { pts: series.pts, sc: sc, start: series.start };
  }

  function render(s, perf, live, extra) {
    var wrap = $("#sparkWrap");
    if (!wrap) return;
    if (!perf) { wrap.hidden = true; return; }
    var sparkEl = $("#spark");
    if (sparkEl) sparkEl.setAttribute("aria-label", live ? "Wallet equity" : "Paper equity since reset");
    wrap.hidden = false;
    var nowTs = Date.now() / 1000;
    var series = buildSeries(s, perf, extra, nowTs, live);
    document.querySelectorAll("#sparkRanges [data-spark]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-spark") === st.range);
    });
    var prev = st.series;
    st.series = series;
    var zf = st.zoomFrom;
    st.zoomFrom = null;
    if (zf && !(root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      if (st.anim) cancelAnimationFrame(st.anim);
      zoom(zf, series);
      return;
    }
    var pl = prev && prev.pts && prev.pts[prev.pts.length - 1];
    var nl = series.pts[series.pts.length - 1];
    var grow = pl && nl && prev.pts.length && series.pts.length >= 2 && nl.ts > pl.ts && prev.since === series.since;
    if (st.anim) cancelAnimationFrame(st.anim);
    if (!grow || (root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) { draw(series); return; }
    var from = series.pts[series.pts.length - 2] || pl;
    var t0 = performance.now(), dur = 800;
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      draw(series, k >= 1 ? null : { ts: from.ts + (nl.ts - from.ts) * e, v: from.v + (nl.v - from.v) * e });
      st.anim = k < 1 ? requestAnimationFrame(step) : 0;
    })(t0);
  }

  /* ---- light interaction: hover / touch shows value + time ---- */
  function bind() {
    var host = $("#spark");
    if (!host || host.dataset.bound) return;
    host.dataset.bound = "1";
    function show(clientX) {
      var d = st.drawn; if (!d) return;
      var r = host.getBoundingClientRect(); if (!r.width) return;
      var x = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * W;
      var best = d.pts[0], bd = Infinity;
      d.pts.forEach(function (p) { var dd = Math.abs(d.sc.x(p.ts) - x); if (dd < bd) { bd = dd; best = p; } });
      var cx = d.sc.x(best.ts) / W * 100, cy = d.sc.y(best.v) / H * 100;
      var cross = host.querySelector(".sp-cross"), tip = host.querySelector(".sp-tip");
      cross.hidden = false; tip.hidden = false;
      cross.style.left = cx + "%"; cross.style.setProperty("--y", cy + "%");
      var chg = d.start ? best.v - d.start : null;
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
    var ranges = $("#sparkRanges");
    if (ranges) ranges.addEventListener("click", function (e) {
      var b = e.target.closest("[data-spark]"); if (!b) return;
      var next = b.getAttribute("data-spark");
      if (next !== st.range && st.drawn) st.zoomFrom = { pts: st.drawn.pts, sc: st.drawn.sc, start: st.drawn.start };
      st.range = next;
      try { localStorage.setItem("buddy.sparkRange", st.range); } catch (err) { /* ignore */ }
      st.series = null;
      if (root.__buddyRender) root.__buddyRender();
    });
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  }

  root.BuddySpark = { render: render, tween: tween, pathFor: pathFor, _build: buildSeries, RANGES: RANGES };
})(typeof window !== "undefined" ? window : globalThis);
