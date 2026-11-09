/* Buddy hero sparkline: minimal glowing PAPER equity line under the balance.
   Series = published equity since the last PAPER reset, plus values this browser
   saw (balance + live unrealized from open PAPER marks). No axes, no grid. */
(function (root) {
  "use strict";
  var UP = "#30d158", DOWN = "#ff453a", FLAT = "#30d158";
  var W = 360, H = 96, PAD_T = 10, PAD_B = 8;
  var RANGES = { reset: 0, day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  var st = { range: "reset", seen: [], seenKey: "", drawn: null, anim: 0, series: [], start: null, since: null };
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

  /* ---- series ---- */
  function buildSeries(s, perf, extra, nowTs) {
    var d = s.dashboard || {};
    var since = num(d.since) || unix(s.paper_reset_at) || null;
    var start = perf && perf.known ? perf.start : null;
    var pts = (Array.isArray(s.equity) ? s.equity : []).map(function (p) {
      return { ts: unix(p && (p.ts != null ? p.ts : p.t)), v: num(p && (p.balance != null ? p.balance : p.equity)) };
    }).filter(function (p) { return p.ts != null && p.v != null; });
    if (since) {
      var before = null;
      pts = pts.filter(function (p) { if (p.ts < since) { before = p; return false; } return true; });
      var anchor = start != null ? start : (before ? before.v : (pts[0] && pts[0].v));
      if (anchor != null) pts.unshift({ ts: since, v: anchor });
    }
    var key = String(since || "") + "|" + String(start || "");
    if (st.seenKey !== key) {
      st.seenKey = key;
      st.seen = [];
      try {
        var saved = JSON.parse(localStorage.getItem("buddy.sparkSeen") || "null");
        if (saved && saved.key === key && Array.isArray(saved.pts)) st.seen = saved.pts.slice(-600);
      } catch (e) { /* ignore */ }
    }
    var liveV = perf ? perf.bal + (extra || 0) : null;
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
    return { pts: out, start: start, since: since };
  }

  function scale(pts, start) {
    var lo = Infinity, hi = -Infinity, t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    pts.forEach(function (p) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); });
    if (start != null) { lo = Math.min(lo, start); hi = Math.max(hi, start); }
    if (hi - lo < 0.02) { var mid = (hi + lo) / 2; lo = mid - 1; hi = mid + 1; }
    var pad = (hi - lo) * 0.14; lo -= pad; hi += pad;
    var span = Math.max(1, t1 - t0);
    return {
      x: function (t) { return 2 + ((t - t0) / span) * (W - 10); },
      y: function (v) { return PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B); },
      t0: t0, t1: t1
    };
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
    for (i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      d += " C" + (xy[i][0] + h).toFixed(2) + " " + (xy[i][1] + m[i] * h).toFixed(2) + " " +
        (xy[i + 1][0] - h).toFixed(2) + " " + (xy[i + 1][1] - m[i + 1] * h).toFixed(2) + " " +
        xy[i + 1][0].toFixed(2) + " " + xy[i + 1][1].toFixed(2);
    }
    return d;
  }

  function draw(series, lerpLast) {
    var host = $("#spark");
    if (!host) return;
    var pts = series.pts.slice();
    if (pts.length < 2) { host.hidden = true; return; }
    host.hidden = false;
    if (lerpLast) pts[pts.length - 1] = lerpLast;
    var sc = scale(series.pts, series.start);
    var xy = pts.map(function (p) { return [sc.x(p.ts), sc.y(p.v)]; });
    var last = pts[pts.length - 1];
    var ref = series.start != null ? series.start : pts[0].v;
    var tone = last.v > ref + 0.004 ? "up" : last.v < ref - 0.004 ? "down" : "flat";
    var color = tone === "down" ? DOWN : tone === "up" ? UP : FLAT;
    var line = pathFor(xy);
    var area = line + " L" + xy[xy.length - 1][0].toFixed(2) + " " + H + " L" + xy[0][0].toFixed(2) + " " + H + " Z";
    var svg = host.querySelector("svg");
    if (!svg) {
      host.innerHTML =
        '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="spFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-s0"/><stop offset="1" class="sp-s1"/></linearGradient>' +
        '<filter id="spGlow" filterUnits="userSpaceOnUse" x="-20" y="-20" width="' + (W + 40) + '" height="' + (H + 40) + '"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
        '<path class="sp-area" fill="url(#spFill)"/><path class="sp-line" fill="none" filter="url(#spGlow)"/></svg>' +
        '<span class="sp-dot"><i></i></span><span class="sp-cross" hidden></span><span class="sp-tip" hidden></span>';
      svg = host.querySelector("svg");
    }
    host.style.setProperty("--sp", color);
    host.className = "spark " + tone;
    svg.querySelector(".sp-area").setAttribute("d", area);
    svg.querySelector(".sp-line").setAttribute("d", line);
    var dot = host.querySelector(".sp-dot");
    dot.style.left = (xy[xy.length - 1][0] / W * 100) + "%";
    dot.style.top = (xy[xy.length - 1][1] / H * 100) + "%";
    st.drawn = { pts: series.pts, sc: sc, start: series.start };
  }

  function render(s, perf, live, extra) {
    var wrap = $("#sparkWrap");
    if (!wrap) return;
    if (live || !perf) { wrap.hidden = true; return; }
    wrap.hidden = false;
    var nowTs = Date.now() / 1000;
    var series = buildSeries(s, perf, extra, nowTs);
    document.querySelectorAll("#sparkRanges [data-spark]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-spark") === st.range);
    });
    var prev = st.series;
    st.series = series;
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
      st.range = b.getAttribute("data-spark");
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
