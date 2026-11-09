(() => {
  const $ = (s) => document.querySelector(s);
  const state = {
  modeHoldUntil: 0,
  modeHoldValue: null, data: null, fixture: false, coinKey: null, chartRange: "day", lastModeToastTs: "",
    quotes: Object.create(null),
    sessionSamples: Object.create(null),
    quoteNote: ""
  };
  const restartUi = Object.create(null);

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function safeUrl(u) {
    if (!u) return "";
    try {
      const url = new URL(u, location.origin);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch (e) { /* ignore bad links */ }
    return "";
  }

  function num(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function toUnix(ts) {
    if (ts == null || ts === "") return null;
    if (typeof ts === "number" && Number.isFinite(ts)) return ts > 1e12 ? ts / 1000 : ts;
    const raw = String(ts).trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      return n > 1e12 ? n / 1000 : n;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }

  const MODE_HOLD_KEY = "buddy_mode_hold";
  const MODE_HOLD_GRACE_S = 15;

  function normalizeDeskMode(raw, label) {
    const m = String(raw || "").toUpperCase();
    const l = String(label || "").toUpperCase();
    if (m === "LIVE" || m === "REAL" || m === "L" || m === "R" || l === "REAL" || l === "LIVE") return "LIVE";
    return "PAPER";
  }

  function readModeHold() {
    try {
      const rec = JSON.parse(localStorage.getItem(MODE_HOLD_KEY) || "null");
      if (!rec || rec.mode == null) return null;
      const mode = normalizeDeskMode(rec.mode, null);
      let ts = Number(rec.ts);
      if (!Number.isFinite(ts)) return null;
      if (ts > 1e12) ts = ts / 1000;
      return { mode, ts };
    } catch (e) {
      return null;
    }
  }

  function writeModeHold(mode) {
    const rec = { mode: normalizeDeskMode(mode, null), ts: Date.now() / 1000 };
    try { localStorage.setItem(MODE_HOLD_KEY, JSON.stringify(rec)); } catch (e) {}
    state.modeHoldValue = rec.mode;
    state.modeHoldUntil = Date.now() + 90000;
    return rec;
  }

  function clearModeHold() {
    try { localStorage.removeItem(MODE_HOLD_KEY); } catch (e) {}
    state.modeHoldUntil = 0;
    state.modeHoldValue = null;
  }

  function effectiveMode(s) {
    const serverMode = normalizeDeskMode(s && s.mode, s && s.mode_label);
    const serverTs = s ? toUnix(s.ts) : null;
    let held = readModeHold();
    if (!held && state.modeHoldValue) {
      const fallbackTs = state.modeHoldUntil ? (state.modeHoldUntil - 90000) / 1000 : 0;
      held = { mode: normalizeDeskMode(state.modeHoldValue, null), ts: fallbackTs };
    }
    if (!held) {
      return {
        mode: serverMode,
        label: serverMode === "LIVE" ? "REAL" : "PAPER",
        live: serverMode === "LIVE",
        held: false
      };
    }
    if (serverMode === held.mode) {
      if (serverTs != null && serverTs >= held.ts - 0.5) clearModeHold();
      return {
        mode: serverMode,
        label: serverMode === "LIVE" ? "REAL" : "PAPER",
        live: serverMode === "LIVE",
        held: false
      };
    }
    // Only trust a mismatched snapshot if it was generated after the toggle
    // (plus a short grace for in-flight writes). Older Pages state is ignored.
    if (serverTs != null && serverTs >= held.ts + MODE_HOLD_GRACE_S) {
      clearModeHold();
      return {
        mode: serverMode,
        label: serverMode === "LIVE" ? "REAL" : "PAPER",
        live: serverMode === "LIVE",
        held: false
      };
    }
    return {
      mode: held.mode,
      label: held.mode === "LIVE" ? "REAL" : "PAPER",
      live: held.mode === "LIVE",
      held: true
    };
  }

  function isFomoRow(p) {
    const src = String((p && (p.source || p.mode)) || "").toUpperCase();
    return src === "FOMO" || src === "WALLET" || src === "REAL";
  }

  function opensForMode(s, trades, live) {
    if (live) {
      const raw = Array.isArray(s.fomo_holdings) && s.fomo_holdings.length
        ? s.fomo_holdings
        : (Array.isArray(s.positions) ? s.positions.filter(isFomoRow) : []);
      return raw.map((p) => {
        const t = normalizeTrade(p, s, true);
        t.source = p.source || t.source || "fomo";
        t.mode = "FOMO";
        if (!t.open && !t.closed_at) t.open = true;
        return t;
      });
    }
    if (Array.isArray(s.positions) && s.positions.length) {
      return s.positions
        .filter((p) => !isFomoRow(p))
        .map((p) => normalizeTrade(p, s, true))
        .filter((t) => t.open || !t.closed_at);
    }
    return trades.filter((t) => t.open && !isFomoRow(t));
  }

  function rel(ts) {
    const t = toUnix(ts);
    if (t == null) return "";
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 15) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }

  function clock(ts) {
    const t = toUnix(ts);
    if (t == null) return "";
    return new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function money(n, digits) {
    if (n == null || !Number.isFinite(n)) return "—";
    const d = digits == null ? 2 : digits;
    const body = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
    return (n < 0 ? "−$" : "$") + body;
  }

  function signedMoney(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const body = money(Math.abs(n));
    if (n > 0.004) return "+" + body;
    if (n < -0.004) return "−" + body;
    return body;
  }

  function signedPct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const body = Math.abs(n).toFixed(2) + "%";
    if (n > 0.004) return "+" + body;
    if (n < -0.004) return "−" + body;
    return body;
  }

  function price(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "−" : "";
    if (abs === 0) return "$0";
    if (abs >= 1000) return sign + "$" + abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (abs >= 1) return sign + "$" + abs.toFixed(2);
    if (abs >= 0.01) return sign + "$" + abs.toFixed(4);
    const digits = Math.min(12, Math.max(6, Math.ceil(-Math.log10(abs)) + 2));
    const body = abs.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
    return sign + "$" + body;
  }

  function toneOf(n) {
    if (n == null || !Number.isFinite(n) || Math.abs(n) < 0.005) return "flat";
    return n > 0 ? "up" : "down";
  }

  function labelize(v) {
    const s = String(v || "").replace(/[_-]+/g, " ").trim();
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function sideLabel(t) {
    const s = String(t.side_or_status || "").toLowerCase();
    if (s === "open" || s === "opening" || s === "live") return "Open";
    if (s === "exiting") return "Exiting";
    if (s === "buy" || s === "bought") return t.closed_at ? "Bought" : "Open";
    if (s === "sell" || s === "sold" || s === "closed" || s === "exited" || s === "exit") return "Sold";
    if (t.closed_at) return "Sold";
    if (s) return labelize(s);
    return t.open ? "Open" : "Trade";
  }

  function isOpenTrade(t) {
    const s = String(t.side_or_status || "").toLowerCase();
    if (["closed", "sold", "sell", "exited", "exit"].includes(s)) return false;
    if (["open", "opening", "exiting", "live"].includes(s)) return true;
    if (t.closed_at) return false;
    return true;
  }

  function startInfo(s) {
    const top = num(s.paper_start_stack);
    if (top != null) return { start: top, known: true };
    const settings = s.settings || {};
    const fromSettings = num(settings.paper_start_stack);
    if (fromSettings != null) return { start: fromSettings, known: true };
    return { start: num(s.balance) || 0, known: false };
  }

  function performance(s) {
    const info = startInfo(s);
    const bal = num(s.balance) || 0;
    let usd = num(s.pnl_usd);
    let pct = num(s.pnl_pct);
    if (usd == null) usd = bal - info.start;
    if (pct == null) pct = info.start ? (usd / info.start) * 100 : 0;
    return { start: info.start, known: info.known, bal, usd, pct };
  }

  function coinOf(s, mint) {
    const coins = s && s.coins;
    if (!coins || !mint || !coins[mint]) return {};
    return coins[mint];
  }

  function normalizeTrade(raw, s, fromPosition) {
    const p = raw || {};
    const coin = coinOf(s, p.mint);
    const entry = num(p.entry != null ? p.entry : p.entry_price);
    const exit = num(p.exit != null ? p.exit : (p.exit_price != null ? p.exit_price : p.avg_exit));
    const size = num(p.size_usd != null ? p.size_usd : p.size);
    let pnlUsd = num(p.pnl_usd != null ? p.pnl_usd : (p.realized_pnl != null ? p.realized_pnl : p.pnl));
    let pnlPct = num(p.pnl_pct);
    const fees = num(p.fees_usd != null ? p.fees_usd : p.fees);
    const side = p.side_or_status || p.status || p.side || "";
    const closedAt = p.closed_at || p.closed || null;
    const open = isOpenTrade({ side_or_status: side, closed_at: closedAt });
    if (fromPosition && open && pnlUsd == null) pnlPct = null;
    if (pnlPct == null && entry && exit) pnlPct = (exit / entry - 1) * 100;
    if (pnlUsd == null && pnlPct != null && size != null) {
      pnlUsd = size * pnlPct / 100 - (fees || 0);
      if (size) pnlPct = pnlUsd / size * 100;
    }
    return {
      mint: p.mint || "",
      name: p.name || coin.name || "",
      symbol: p.symbol || coin.symbol || "",
      side_or_status: side,
      entry,
      exit,
      size_usd: size,
      pnl_usd: pnlUsd,
      pnl_pct: pnlPct,
      fees_usd: fees,
      opened_at: p.opened_at || p.opened || p.opened_ts || null,
      closed_at: closedAt,
      exit_reason: p.exit_reason || "",
      link: p.link || "",
      stop_pct: num(p.stop_pct),
      mode: p.mode || "",
      source: p.source || "",
      open,
      pool: p.pool || p.pair || p.pairAddress || coin.pool || coin.pair || "",
      qty: num(p.qty),
      avg_entry: num(p.avg_entry),
      invested_usd: num(p.invested_usd),
      mark_price: num(p.mark_price != null ? p.mark_price : p.mark),
      mark_fetched_at: toUnix(p.mark_fetched_at),
      mark_source: p.mark_source || "",
      mark_pair: p.mark_pair || "",
      quote_as_of: toUnix(p.quote_as_of),
      quote_clock: p.quote_clock || "",
      mark_samples: Array.isArray(p.mark_samples) ? p.mark_samples : [],
      demo: !!(p.demo || (s && s.demo)),
      trading_mode: p.trading_mode || p.paper_mode || p.trade_mode || p.style || p.mode_name || p.strategy_mode || "",
      entry_context: p.entry_context || null,
      strategy: p.strategy || ""
    };
  }

  function liveMark(t) {
    const raw = {
      mint: t.mint,
      source: t.source,
      mode: t.mode,
      entry: t.entry,
      avg_entry: t.avg_entry,
      opened_at: t.opened_at,
      qty: t.qty,
      size_usd: t.size_usd,
      invested_usd: t.invested_usd,
      mark_price: t.mark_price,
      mark_fetched_at: t.mark_fetched_at,
      mark_source: t.mark_source,
      mark_pair: t.mark_pair,
      quote_as_of: t.quote_as_of,
      quote_clock: t.quote_clock,
      mark_samples: t.mark_samples,
      demo: t.demo || state.fixture
    };
    const Marks = window.BuddyMarks;
    if (!Marks) {
      return { price: null, value: null, unrealized: null, pct: null, samples: [], stale: true, entry: t.entry, entryKind: "unknown" };
    }
    return Marks.positionMark(raw, state.quotes[t.mint] || null, Date.now() / 1000, state.sessionSamples[t.mint]);
  }

  function ageText(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "time unknown";
    const s = Math.max(0, Math.round(seconds));
    if (s < 90) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function freshLabel(m) {
    if (!m || m.price == null) return { text: "No quote", stale: true };
    if (m.demo) return { text: "Sample", stale: false };
    if (m.receivedAt == null) return { text: "Time unknown", stale: true };
    if (m.stale) return { text: "Stale · " + ageText(m.ageS), stale: true };
    return { text: "Updated " + ageText(m.ageS), stale: false };
  }

  function openSummaryText(valueSum, valueN, pnlSum, pnlN, unknown) {
    if (!valueN && !pnlN) return unknown ? "Unpriced" : "";
    const valueBit = valueN ? money(valueSum) : "Unpriced";
    const pnlBit = pnlN ? signedMoney(pnlSum) : "";
    const miss = unknown ? " · " + unknown + " unpriced" : "";
    return valueBit + (pnlBit ? " · " + pnlBit : "") + miss;
  }

  function tradesOf(s) {
    const rows = Array.isArray(s.trades)
      ? s.trades.map((t) => normalizeTrade(t, s, false))
      : (Array.isArray(s.positions) ? s.positions.map((p) => normalizeTrade(p, s, true)) : []);
    return rows.sort((a, b) => {
      if (a.open !== b.open) return a.open ? 1 : -1;
      const ta = toUnix(a.closed_at || a.opened_at) || 0;
      const tb = toUnix(b.closed_at || b.opened_at) || 0;
      return tb - ta;
    });
  }

  function opensOf(s, trades) {
    if (Array.isArray(s.positions) && s.positions.length) {
      return s.positions
        .map((p) => normalizeTrade(p, s, true))
        .filter((t) => t.open || !t.closed_at);
    }
    return trades.filter((t) => t.open);
  }

  function equityOf(s, perf) {
    const raw = Array.isArray(s.equity) ? s.equity : [];
    const points = raw
      .map((p) => ({
        ts: toUnix(p && (p.ts != null ? p.ts : p.t)),
        balance: num(p && (p.balance != null ? p.balance : (p.equity != null ? p.equity : p.v)))
      }))
      .filter((p) => p.balance != null)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (!points.length) {
      const now = toUnix(s.ts) || Date.now() / 1000;
      return {
        synthetic: true,
        points: [
          { ts: now - 3600, balance: perf.bal },
          { ts: now, balance: perf.bal }
        ]
      };
    }
    if (points.length === 1) {
      const p = points[0];
      points.unshift({ ts: (p.ts || 0) - 1, balance: p.balance });
    }
    return { synthetic: false, points };
  }

  const RANGE_SEC = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  const RANGE_LABEL = { day: "Day", week: "Week", month: "Month", year: "Year" };

  function spanLabel(points) {
    const a = points[0] && points[0].ts;
    const b = points[points.length - 1] && points[points.length - 1].ts;
    if (a == null || b == null) return "";
    const s = Math.abs(b - a);
    if (s < 90) return "now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
    if (s < 86400) {
      const h = s / 3600;
      return (h < 10 ? h.toFixed(1).replace(/\.0$/, "") : String(Math.round(h))) + "h";
    }
    return Math.round(s / 86400) + "d";
  }

  function filterEquity(points, rangeKey, now) {
    const win = RANGE_SEC[rangeKey] || RANGE_SEC.day;
    const cutoff = now - win;
    if (!points.length) return points.slice();
    const inWin = points.filter((p) => p.ts == null || p.ts >= cutoff);
    if (!inWin.length) return points.slice(-Math.min(points.length, 2));
    const out = inWin.slice();
    const before = points.filter((p) => p.ts != null && p.ts < cutoff);
    if (before.length && (out[0].ts == null || out[0].ts > cutoff + 1)) {
      out.unshift({ ts: cutoff, balance: before[before.length - 1].balance });
    }
    if (out.length === 1) {
      const p = out[0];
      out.unshift({ ts: (p.ts || now) - 1, balance: p.balance });
    }
    return out;
  }

  function rangeTitle(rangeKey, points, synthetic) {
    const name = RANGE_LABEL[rangeKey] || "Day";
    if (synthetic) return "Flat";
    const actual = spanLabel(points);
    const a = points[0] && points[0].ts;
    const b = points[points.length - 1] && points[points.length - 1].ts;
    const covered = (a != null && b != null) ? Math.abs(b - a) : 0;
    const win = RANGE_SEC[rangeKey] || RANGE_SEC.day;
    if (actual && covered < win * 0.85) return name + " · " + actual;
    return name;
  }

  function chartMetrics(points, start) {
    const W = 360;
    const H = 112;
    const padX = 6;
    const padT = 16;
    const padB = 12;
    const vals = points.map((p) => p.balance);
    let lo = Math.min.apply(null, vals);
    let hi = Math.max.apply(null, vals);
    const showStart = start != null && Number.isFinite(start);
    if (showStart) {
      lo = Math.min(lo, start);
      hi = Math.max(hi, start);
    }
    if (hi - lo < 1e-9) {
      const pad = Math.max(Math.abs(lo) * 0.012, 1);
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.2;
      lo -= pad;
      hi += pad;
    }
    const n = points.length;
    const X = (i) => padX + (n === 1 ? (W - padX * 2) / 2 : (i / (n - 1)) * (W - padX * 2));
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    return { W, H, padX, padT, padB, lo, hi, n, X, Y, showStart };
  }

  function chartSvg(points, start, tone) {
    const m = chartMetrics(points, start);
    const cmds = points.map((p, i) => (i ? "L" : "M") + m.X(i).toFixed(2) + " " + m.Y(p.balance).toFixed(2));
    const line = cmds.join(" ");
    const baseY = (m.H - m.padB).toFixed(2);
    const area = line + " L " + m.X(m.n - 1).toFixed(2) + " " + baseY + " L " + m.X(0).toFixed(2) + " " + baseY + " Z";
    const color = tone === "up" ? "#30d158" : tone === "down" ? "#ff453a" : "#8B5CF6";
    const vals = points.map((p) => p.balance);
    const flat = Math.max.apply(null, vals) - Math.min.apply(null, vals) < Math.max(0.02, Math.abs(start || 0) * 0.002);
    let guide = "";
    if (m.showStart && !flat && start >= m.lo && start <= m.hi) {
      const y = m.Y(start).toFixed(2);
      guide = '<line class="start-line" x1="' + m.padX + '" x2="' + (m.W - m.padX) + '" y1="' + y + '" y2="' + y + '"/>';
    }
    const lx = m.X(m.n - 1).toFixed(2);
    const ly = m.Y(points[m.n - 1].balance).toFixed(2);
    const gid = "eqFill";
    return (
      '<svg viewBox="0 0 ' + m.W + " " + m.H + '" role="img" aria-label="' + esc(chartLabel(points, tone)) + '">' +
      "<defs><linearGradient id=\"" + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.38"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
      "</linearGradient></defs>" +
      guide +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + lx + '" cy="' + ly + '" r="7" fill="' + color + '" fill-opacity="0.22"/>' +
      '<circle cx="' + lx + '" cy="' + ly + '" r="3.4" fill="' + color + '"/>' +
      "</svg>"
    );
  }

  function chartClock(ts) {
    const t = toUnix(ts);
    if (t == null) return "";
    const d = new Date(t * 1000);
    const sameDay = d.toDateString() === new Date().toDateString();
    if ((state.chartRange || "day") === "day" && sameDay) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function tipHtml(point, start) {
    const pnl = start != null && Number.isFinite(start) ? point.balance - start : null;
    const pct = pnl != null && start ? (pnl / start) * 100 : null;
    let html = '<span class="tip-time">' + esc(chartClock(point.ts)) + "</span>";
    html += '<span class="tip-bal">' + esc(money(point.balance)) + "</span>";
    if (pnl != null) {
      html += '<span class="tip-pnl ' + toneOf(pnl) + '">' + esc(signedMoney(pnl));
      if (pct != null) html += " · " + esc(signedPct(pct));
      html += "</span>";
    }
    return html;
  }

  function hideScrub() {
    const overlay = $("#chartOverlay");
    if (overlay) overlay.hidden = true;
    const wrap = $("#chartWrap");
    if (wrap) wrap.classList.remove("scrubbing");
  }

  function updateScrub(clientX) {
    const meta = state.chart;
    const overlay = $("#chartOverlay");
    const wrap = $("#chartWrap");
    const svg = $("#chart svg");
    if (!meta || !meta.points || !meta.points.length || !overlay || !wrap || !svg) return;
    const sRect = svg.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    if (!sRect.width || !sRect.height) return;
    const clamped = Math.max(sRect.left, Math.min(sRect.right, clientX));
    const rel = (clamped - sRect.left) / sRect.width;
    const n = meta.points.length;
    const i = Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1))));
    const point = meta.points[i];
    const left = (sRect.left - wRect.left) + (meta.X(i) / meta.W) * sRect.width;
    const top = (sRect.top - wRect.top) + (meta.Y(point.balance) / meta.H) * sRect.height;
    overlay.hidden = false;
    const vline = $("#chartVline");
    const dot = $("#chartDot");
    const tip = $("#chartTip");
    if (vline) {
      vline.style.left = left + "px";
      vline.style.top = (sRect.top - wRect.top) + "px";
      vline.style.height = sRect.height + "px";
    }
    if (dot) {
      dot.style.left = left + "px";
      dot.style.top = top + "px";
      dot.style.background = meta.color;
    }
    if (tip) {
      tip.innerHTML = tipHtml(point, meta.start);
      const tipW = tip.offsetWidth || 120;
      const tipH = tip.offsetHeight || 56;
      let tipLeft = left;
      const minL = 8 + tipW / 2;
      const maxL = wRect.width - 8 - tipW / 2;
      if (maxL >= minL) tipLeft = Math.max(minL, Math.min(maxL, tipLeft));
      let tipTop = top - 12 - tipH;
      if (tipTop < 4) tipTop = top + 14;
      tip.style.left = tipLeft + "px";
      tip.style.top = tipTop + "px";
      tip.style.transform = "translate(-50%, 0)";
    }
  }

  function bindChart() {
    const wrap = $("#chartWrap");
    if (!wrap || wrap.dataset.bound) return;
    if (window.BuddyChart && BuddyChart.ok()) return;
    wrap.dataset.bound = "1";
    let active = false;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      active = true;
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      wrap.classList.add("scrubbing");
      updateScrub(e.clientX);
      e.preventDefault();
    });
    wrap.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" || active) {
        if (active) e.preventDefault();
        updateScrub(e.clientX);
      }
    });
    const end = () => {
      active = false;
      hideScrub();
    };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    wrap.addEventListener("lostpointercapture", () => { active = false; });
    wrap.addEventListener("pointerleave", () => {
      if (!active) hideScrub();
    });
  }

  function chartLabel(points, tone) {
    const first = points[0].balance;
    const last = points[points.length - 1].balance;
    const word = tone === "up" ? "up" : tone === "down" ? "down" : "flat";
    return "Equity chart, " + word + ", from " + money(first) + " to " + money(last);
  }

  function trimNum(n) {
    const v = Math.abs(Number(n));
    if (!Number.isFinite(v)) return "";
    return String(Math.round(v * 100) / 100);
  }

  function displayName(t) {
    return t.name || t.symbol || (t.mint ? String(t.mint).slice(0, 4) + "…" + String(t.mint).slice(-4) : "Coin");
  }

  function displayTicker(t) {
    if (t.symbol) return t.symbol;
    if (t.name) return t.name.slice(0, 8);
    if (t.mint) return String(t.mint).slice(0, 4);
    return "—";
  }

  function fomoCoinUrl(mint, href) {
    const m = mint ? String(mint) : "";
    if (m) {
      return safeUrl(
        "https://fomo.family/coin?address=" + encodeURIComponent(m) +
        "&chainId=1399811149&r=savipww&source=share_link"
      );
    }
    // Upgrade legacy /coins/solana/{mint} links to the app universal-link form.
    const legacy = safeUrl(href);
    if (legacy) {
      try {
        const u = new URL(legacy);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts[0] === "coins" && parts[1] === "solana" && parts[2]) {
          return safeUrl(
            "https://fomo.family/coin?address=" + encodeURIComponent(parts[2]) +
            "&chainId=1399811149&r=savipww&source=share_link"
          );
        }
      } catch (e) {}
    }
    return legacy;
  }

  function fomoHandle() {
    const s = state.data || {};
    const settings = s.settings && typeof s.settings === "object" ? s.settings : {};
    const raw = s.fomo_handle || settings.fomo_handle || "tornell";
    return String(raw).replace(/^@/, "") || "tornell";
  }

  function fomoProfileUrl() {
    const s = state.data || {};
    const fromState = safeUrl(s.profile_url);
    if (fromState) return fromState;
    return safeUrl(
      "https://fomo.family/profile/" +
      encodeURIComponent(fomoHandle()) +
      "?source=share_link&r=savipww"
    );
  }

  function applyFomoAccount() {
    const handle = fomoHandle();
    const profile = fomoProfileUrl();
    const account = $("#fomoAccount");
    if (account) {
      const label = account.querySelector(".fomo-label");
      const text = "FOMO · @" + handle;
      if (label) label.textContent = text;
      else account.textContent = text;
      if (profile) {
        account.href = profile;
        account.removeAttribute("target");
      }
    }
    const handleEl = $("#handle");
    const brandEl = $("#fomoProfile");
    if (handleEl) {
      handleEl.textContent = "@" + handle;
      if (profile) {
        handleEl.href = profile;
        handleEl.removeAttribute("target");
      }
    }
    if (brandEl && profile) {
      brandEl.href = profile;
      brandEl.removeAttribute("target");
    }
    const coinProfile = $("#coinProfile");
    if (coinProfile) {
      coinProfile.textContent = "My FOMO · @" + handle;
      if (profile) {
        coinProfile.href = profile;
        coinProfile.removeAttribute("target");
      }
    }
  }

  const logoCache = new Map(); // mint -> imageUrl ("" = failed)
  const logoInflight = new Map();

  function logoLetter(symbol, name) {
    const raw = String(symbol || name || "?").trim();
    const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
    const ch = (cleaned || raw || "?").charAt(0);
    return ch ? ch.toUpperCase() : "?";
  }

  function pickImageUrl(obj) {
    if (!obj || typeof obj !== "object") return "";
    const raw = obj.imageUrl || obj.image || obj.logo || "";
    return raw ? String(raw) : "";
  }

  function coinLogoHtml(mint, symbol, name, extraClass, imageUrl) {
    const letter = logoLetter(symbol, name);
    const cls = "coin-logo" + (extraClass ? " " + extraClass : "");
    const mark = '<span class="logo-mark" aria-hidden="true">' + esc(letter) + "</span>";
    const m = mint ? String(mint) : "";
    let src = imageUrl ? String(imageUrl) : "";
    if (!src && m && logoCache.has(m)) {
      const cached = logoCache.get(m);
      if (cached) src = cached;
    }
    if (src && m) logoCache.set(m, src);
    if (src) {
      return (
        '<span class="' + cls + '"' + (m ? ' data-mint="' + esc(m) + '"' : "") + ">" +
        '<img alt="" decoding="async" src="' + esc(src) + '" onerror="this.remove()">' +
        mark +
        "</span>"
      );
    }
    if (!m) return '<span class="' + cls + '">' + mark + "</span>";
    // Letter placeholder; resolvePendingLogos fills CMS imageUrl via DexScreener API.
    return (
      '<span class="' + cls + '" data-mint="' + esc(m) + '" data-logo-pending="1">' +
      mark +
      "</span>"
    );
  }

  function applyLogoImg(el, url) {
    if (!el || !url) return;
    let img = el.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("error", () => { if (img && img.parentNode) img.remove(); });
      el.insertBefore(img, el.firstChild);
    }
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    el.removeAttribute("data-logo-pending");
  }

  function fetchDexImageUrl(mint) {
    if (!mint) return Promise.resolve("");
    if (logoCache.has(mint)) return Promise.resolve(logoCache.get(mint) || "");
    if (logoInflight.has(mint)) return logoInflight.get(mint);
    const p = fetch("https://api.dexscreener.com/tokens/v1/solana/" + encodeURIComponent(mint))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        let url = "";
        const pairs = Array.isArray(data) ? data : (data && Array.isArray(data.pairs) ? data.pairs : []);
        for (let i = 0; i < pairs.length; i++) {
          const info = pairs[i] && pairs[i].info;
          if (info && info.imageUrl) { url = String(info.imageUrl); break; }
        }
        if (!url && data && data.info && data.info.imageUrl) url = String(data.info.imageUrl);
        logoCache.set(mint, url || "");
        return url || "";
      })
      .catch(() => {
        logoCache.set(mint, "");
        return "";
      })
      .finally(() => { logoInflight.delete(mint); });
    logoInflight.set(mint, p);
    return p;
  }

  function resolvePendingLogos(root) {
    const host = root || document;
    const nodes = host.querySelectorAll(".coin-logo[data-mint]");
    const mints = [];
    nodes.forEach((el) => {
      const mint = el.getAttribute("data-mint");
      if (!mint) return;
      if (el.querySelector("img") && !el.getAttribute("data-logo-pending")) return;
      if (logoCache.has(mint)) {
        const cached = logoCache.get(mint);
        if (cached) applyLogoImg(el, cached);
        return;
      }
      if (mints.indexOf(mint) < 0) mints.push(mint);
    });
    mints.forEach((mint) => {
      fetchDexImageUrl(mint).then((url) => {
        if (!url) return;
        document.querySelectorAll(".coin-logo[data-mint]").forEach((node) => {
          if (node.getAttribute("data-mint") === mint) applyLogoImg(node, url);
        });
      });
    });
  }

  function coinChain(mint) {
    const c = coinOf(state.data, mint) || {};
    return String(c.chain || c.chain_id || "solana").toLowerCase() === "1399811149" ? "solana" : String(c.chain || "solana").toLowerCase();
  }

  function coinPool(mint, t) {
    const c = coinOf(state.data, mint) || {};
    return (t && (t.pool || t.mark_pair)) || c.pool || c.pair || "";
  }

  function dexHref(mint, t) {
    if (!mint || !window.BuddyChart) return "";
    return BuddyChart.dexUrl(coinChain(mint), coinPool(mint, t) || mint, false);
  }

  function dexLink(mint, t) {
    const url = dexHref(mint, t);
    if (!url) return "";
    return '<a class="dex" href="' + esc(url) + '" target="_blank" rel="noopener" aria-label="Open on DexScreener">DEX</a>';
  }

  function rowLinks(inner) {
    return inner ? '<span class="row-links">' + inner + "</span>" : "";
  }

  function fomoLink(href, label, mint) {
    // Blue FOMO chip → that coin inside the FOMO app (universal /coin link).
    const url = fomoCoinUrl(mint, href);
    if (!url) return "";
    return '<a class="fomo" href="' + esc(url) + '">' + esc(label || "FOMO") + "</a>";
  }

  function tradeBits(t, mode) {
    const bits = [sideLabel(t)];
    if (mode === "open") return bits;
    if (t.exit_reason && !t.open) bits.push(labelize(t.exit_reason));
    if (t.size_usd != null) bits.push(money(t.size_usd));
    if (t.fees_usd) bits.push("fees " + money(t.fees_usd));
    const when = rel(t.closed_at || t.opened_at);
    if (when) bits.push(when);
    return bits;
  }

  function gainMarkup(m) {
    if (m && m.unrealized != null) {
      return '<span class="pnl-col ' + toneOf(m.unrealized) + '">' + esc(signedMoney(m.unrealized)) +
        '<span class="pct">' + esc(signedPct(m.pct)) + "</span></span>";
    }
    if (!m || m.price == null) {
      return '<span class="pnl-col flat">—<span class="pct">No quote</span></span>';
    }
    return '<span class="pnl-col flat">—<span class="pct">No cost</span></span>';
  }

  function openCard(t, index) {
    const m = liveMark(t);
    const fresh = freshLabel(m);
    const fomo = String(t.mode || t.source || "").toUpperCase();
    const realRow = /FOMO|REAL|LIVE|WALLET/.test(fomo) || t.source === "fomo" || t.source === "wallet";
    const pill = fomo.indexOf("FOMO") >= 0 || t.source === "fomo" || t.source === "wallet"
      ? '<span class="src-pill fomo">FOMO</span>' : "";
    const entry = m.entry == null ? "unknown" : price(m.entry);
    const nowPx = m.price == null ? "unknown" : price(m.price);
    const value = m.value != null ? money(m.value) : (m.walletUsd != null ? money(m.walletUsd) : "unknown");
    return (
      '<div class="trade-row open-card">' +
      '<button type="button" class="trade" data-trade="' + index + '">' +
      coinLogoHtml(t.mint, t.symbol, t.name, null, pickImageUrl(t)) +
      '<span class="who">' +
      '<span class="ticker">' + esc(displayTicker(t)) + pill + (window.BuddyStyles ? BuddyStyles.tagHtml(t, state.data) : "") + "</span>" +
      '<dl class="open-px"><dt>Entry</dt><dd>' + esc(entry) + "</dd><dt>Now</dt><dd>" + esc(nowPx) +
      "</dd><dt>Value</dt><dd>" + esc(value) + "</dd></dl>" +
      '<span class="open-fresh' + (fresh.stale ? " stale" : "") + '">' + esc(fresh.text) + "</span>" +
      "</span>" + gainMarkup(m) +
      "</button>" +
      rowLinks((realRow || !t.mint ? "" : '<button type="button" class="paper-sell" data-sell="' + esc(t.mint) + '" data-sell-name="' + esc(displayTicker(t)) + '">Sell</button>') +
      dexLink(t.mint, t) + fomoLink(t.link, "FOMO", t.mint)) +
      "</div>"
    );
  }

  function pnlMarkup(t) {
    if (t.open) return gainMarkup(liveMark(t));
    if (t.pnl_usd == null) return "";
    return '<span class="pnl-col ' + toneOf(t.pnl_usd) + '">' + esc(signedMoney(t.pnl_usd)) +
      '<span class="pct">' + esc(signedPct(t.pnl_pct)) + "</span></span>";
  }

  function tradeButton(t, index, mode) {
    if (mode === "open") return openCard(t, index);
    const bits = tradeBits(t, mode).filter((bit) => bit.indexOf("fees ") !== 0);
    const name = displayName(t);
    if (name && name !== displayTicker(t)) bits.unshift(name);
    return (
      '<div class="trade-row">' +
      '<button type="button" class="trade" data-trade="' + index + '">' +
      coinLogoHtml(t.mint, t.symbol, t.name, null, pickImageUrl(t)) +
      "<span class=\"who\">" +
      '<span class="ticker">' + esc(displayTicker(t)) +
      (String(t.mode || t.source || "").toUpperCase().indexOf("FOMO") >= 0 || t.source === "fomo" || t.source === "wallet"
        ? '<span class="src-pill fomo">FOMO</span>'
        : '<span class="src-pill paper">PAPER</span>') +
      (window.BuddyStyles ? BuddyStyles.tagHtml(t, state.data) : "") +
      "</span>" +
      '<span class="meta-line">' + esc(bits.join(" · ")) + "</span>" +
      "</span>" + pnlMarkup(t) +
      "</button>" + rowLinks(dexLink(t.mint, t) + fomoLink(t.link, "FOMO", t.mint)) +
      "</div>"
    );
  }


  function waitingRow(w) {
    const ticker = displayTicker(w);
    const coin = coinOf(state.data, w.mint);
    const age = w.age_min != null ? Number(w.age_min) : null;
    const holders = num(w.holders != null ? w.holders : coin.holders);
    const name = displayName(w.name ? w : coin);
    const bits = [];
    if (name && name.toUpperCase() !== String(ticker).toUpperCase()) bits.push(name);
    if (holders != null) bits.push(holders < 1000 ? holders + " holders" : (holders / 1000).toFixed(holders >= 10000 ? 0 : 1) + "k holders");
    const ageTxt = age != null && Number.isFinite(age) ? (age < 1 ? "<1m" : Math.round(age) + "m") : "";
    const status = String(w.status || "watching").toLowerCase();
    const pill = ageTxt ? ageTxt : status;
    const q = window.BuddyDash && BuddyDash.quote ? BuddyDash.quote(w.mint) : null;
    const px = q && q.price != null && window.BuddyChart ? "$" + BuddyChart.fmtPrice(q.price) : "";
    const ch = q && q.change != null ? q.change : null;
    const chTxt = ch == null ? "" : (ch > 0 ? "+" : ch < 0 ? "−" : "") + Math.abs(ch).toFixed(Math.abs(ch) >= 100 ? 0 : 1) + "%";
    const mint = w.mint ? esc(w.mint) : "";
    const img = pickImageUrl(w) || pickImageUrl(coin);
    return (
      '<div class="wait-row">' +
      '<button type="button" class="wait-main" data-mint="' + mint + '">' +
      coinLogoHtml(w.mint, w.symbol || coin.symbol, w.name || coin.name, null, img) +
      '<span class="who"><span class="ticker">$' + esc(String(ticker).replace(/^\$/, "")) + "</span>" +
      (bits.length ? '<span class="meta-line">' + esc(bits.join(" · ")) + "</span>" : "") + "</span>" +
      '<span class="wait-px">' + (px ? "<b>" + esc(px) + "</b>" : '<b class="flat">—</b>') +
      (chTxt ? '<span class="' + (ch >= 0 ? "up" : "down") + '">' + esc(chTxt) + "</span>" : "") + "</span>" +
      '<span class="wait-pill" title="' + esc(status) + '">' + esc(pill) + "</span>" +
      "</button>" + dexLink(w.mint, w) +
      "</div>"
    );
  }

  function activityRow(a) {
    const title = a.title || a.kind || "Activity";
    const detailBits = [];
    if (a.detail) detailBits.push(a.detail);
    const when = rel(a.ts);
    if (when) detailBits.push(when);
    const mint = a.mint ? esc(a.mint) : "";
    return (
      '<div class="feed-row">' +
      '<button type="button" class="feed-main" data-mint="' + mint + '">' +
      coinLogoHtml(a.mint, a.symbol, a.name || title, null, pickImageUrl(a)) +
      "<span class=\"who\">" +
      "<span class=\"ticker\">" + esc(title) + "</span>" +
      '<span class="meta-line">' + esc(detailBits.join(" · ")) + "</span>" +
      "</span>" +
      "</button>" + rowLinks(dexLink(a.mint, null) + fomoLink(a.link, "FOMO", a.mint)) +
      "</div>"
    );
  }

  function emptyTrades(copy) {
    return '<div class="empty-card"><div class="empty-glyph" aria-hidden="true"></div><p class="empty-title">' + esc(copy.title) + "</p><p>" + esc(copy.body) + "</p></div>";
  }

  function agentTone(a) {
    if (!a || a.paused) return "bad";
    const age = num(a.age_s);
    if (age == null || age > 120) return "bad";
    return "ok";
  }

  function agentLine(name, a) {
    const tone = agentTone(a);
    const age = a && num(a.age_s);
    let status = "Live";
    let detail = "Heartbeat just now";
    if (a && a.paused) {
      status = "Paused";
      detail = "Paused from Telegram";
    } else if (age == null) {
      status = "Quiet";
      detail = "No heartbeat yet";
    } else if (age > 120) {
      status = "Stale";
      detail = "Last heartbeat " + rel(Date.now() / 1000 - age);
    } else if (age >= 15) {
      detail = "Heartbeat " + Math.round(age) + "s ago";
    }
    const pending = restartUi[name] && restartUi[name].until > Date.now();
    const btnLabel = pending ? restartUi[name].label : "Restart";
    return (
      '<article class="agent">' +
      '<span class="dot ' + tone + '" aria-hidden="true"></span>' +
      '<div class="grow"><h3>' + esc(name) + "</h3><p>" + esc(detail) + "</p></div>" +
      '<div class="agent-actions">' +
      '<span class="badge ' + (tone === "ok" ? "up" : "down") + '">' + esc(status) + "</span>" +
      '<button type="button" class="restart-btn' + (tone === "bad" ? " need" : "") + '" data-restart="' + esc(name) + '"' +
      (pending ? " disabled" : "") + ">" + esc(btnLabel) + "</button>" +
      "</div></article>"
    );
  }


  let pendingMode = null;
  let pendingDesk = null;
  let modeUiBusy = false;

  function showToast(text, isReal) {
    const el = $("#toast");
    if (!el || !text) return;
    el.textContent = text;
    el.classList.toggle("real", !!isReal);
    el.hidden = false;
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => { el.hidden = true; }, 4200);
  }

  function syncModeSwitch(which) {
    const paper = $("#modePaper");
    const real = $("#modeReal");
    if (!paper || !real) return;
    const isReal = which === "real";
    paper.classList.toggle("on", !isReal);
    real.classList.toggle("on", isReal);
    const demo = isDemoPreview() || state.fixture;
    paper.disabled = !!demo || modeUiBusy;
    real.disabled = !!demo || modeUiBusy;
  }

  function openModeConfirm(next) {
    pendingMode = next;
    const box = $("#modeConfirm");
    const title = $("#modeConfirmTitle");
    const body = $("#modeConfirmBody");
    const ok = $("#modeConfirmOk");
    if (!box || !title || !body || !ok) return;
    if (next === "real") {
      title.textContent = "Switch to REAL?";
      body.textContent = "Alerts-only. Telegram will say REAL. Buys/sells need your Bought/Sold tap. Buddy never places FOMO orders.";
      ok.classList.add("danger");
      ok.textContent = "Switch to REAL";
    } else {
      title.textContent = "Switch to PAPER?";
      body.textContent = "Paper auto-fills every signal. Telegram will say PAPER. Stack and stops stay simulated.";
      ok.classList.remove("danger");
      ok.textContent = "Switch to PAPER";
    }
    box.hidden = false;
  }

  function closeModeConfirm() {
    pendingMode = null;
    pendingDesk = null;
    const box = $("#modeConfirm");
    if (box) box.hidden = true;
  }

  function openDeskConfirm(action) {
    pendingDesk = action;
    pendingMode = null;
    const box = $("#modeConfirm");
    const title = $("#modeConfirmTitle");
    const body = $("#modeConfirmBody");
    const ok = $("#modeConfirmOk");
    if (!box || !title || !body || !ok) return;
    if (action.type === "style") {
      title.textContent = "Switch to " + (action.label || action.name) + "?";
      body.textContent = "Applies to new trades only. Open trades keep the rules they were opened with. PAPER fills only; REAL stays alerts-only.";
      ok.textContent = "Switch";
      ok.classList.remove("danger");
      box.hidden = false;
      return;
    }
    if (action.type === "sell") {
      title.textContent = "Sell " + (action.name || "this coin") + "?";
      body.textContent = "Paper close at the latest price.";
      ok.textContent = "Sell";
    } else {
      title.textContent = "Reset paper to $200?";
      body.textContent = "Closes paper trades, saves a private backup, and clears paper history.";
      ok.textContent = "Reset";
    }
    ok.classList.add("danger");
    box.hidden = false;
  }

  async function postDesk(body) {
    const target = dataPath();
    if (isDemoPreview() || state.fixture || (state.data && state.data.demo)) {
      showToast("Demo preview", false);
      return false;
    }
    if (!target || target.kind !== "live" || !target.id) {
      showErr("Needs a live desk link.");
      return false;
    }
    const r = await fetch("https://ntfy.sh/" + encodeURIComponent("b-" + target.id), {
      method: "POST",
      body: body,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
    if (!r.ok) throw new Error("bad status");
    return true;
  }

  async function runDesk(action) {
    try {
      if (action.type === "style") {
        const name = String(action.name || "").toLowerCase();
        if (!name || !window.BuddyStyles || BuddyStyles.RESERVED[name] || !/^[a-z0-9_]+$/.test(name)) return;
        const sent = await postDesk("mode:" + name);
        if (sent) {
          BuddyStyles.markPending(name);
          showToast((action.label || name) + " sent · new trades only", false);
          if (state.data) render();
          window.setTimeout(load, 1500);
        }
        return;
      }
      const body = action.type === "sell" ? "close:" + action.mint : "reset:" + action.amount;
      const ok = await postDesk(body);
      if (ok) {
        showToast(action.type === "sell" ? "Sell sent" : "Reset sent", false);
        window.setTimeout(load, 1500);
      }
    } catch (err) {
      showErr("Desk command failed");
    }
  }

  async function requestMode(next) {
    if (isDemoPreview() || state.fixture) {
      showToast("Demo preview — mode switch disabled", false);
      closeModeConfirm();
      return;
    }
    const target = dataPath();
    if (!target || target.kind !== "live" || !target.id) {
      showErr("Mode switch needs a live desk link.");
      return;
    }
    modeUiBusy = true;
    ["modePaper", "modeReal"].forEach((id) => {
      const el = $("#" + id);
      if (el) el.disabled = true;
    });
    try {
      const r = await fetch("https://ntfy.sh/" + encodeURIComponent("b-" + target.id), {
        method: "POST",
        body: "mode:" + next,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
      if (!r.ok) throw new Error("bad status");
      const heldMode = next === "real" ? "LIVE" : "PAPER";
      writeModeHold(heldMode);
      syncModeSwitch(next);
      showToast(
        next === "real"
          ? "🔴 REAL mode ON: alerts only, you place trades on FOMO"
          : "🟢 PAPER mode ON: auto buy/sell, no real money",
        next === "real"
      );
      if (state.data) {
        state.data.mode = heldMode;
        state.data.mode_label = heldMode === "LIVE" ? "REAL" : "PAPER";
        render();
      }
      window.setTimeout(load, 800);
    } catch (err) {
      showErr("Could not switch mode");
    } finally {
      modeUiBusy = false;
      ["modePaper", "modeReal"].forEach((id) => {
        const el = $("#" + id);
        if (el) el.disabled = false;
      });
      closeModeConfirm();
    }
  }

  async function requestRestart(btn) {
    if (isDemoPreview() || state.fixture) {
      showToast("Demo preview — restart disabled", false);
      return;
    }
    const name = (btn.getAttribute("data-restart") || "").trim();
    if (!name) return;
    const fallback = name === "all" ? "Restart all" : "Restart";
    const target = dataPath();
    const finish = (label) => {
      restartUi[name] = { label: label, until: Date.now() + 3000 };
      btn.textContent = label;
      window.setTimeout(() => {
        const rec = restartUi[name];
        if (rec && rec.label === label) delete restartUi[name];
        const live = document.querySelector('[data-restart="' + name + '"]');
        if (live) {
          live.disabled = false;
          live.textContent = fallback;
        }
      }, 3000);
    };
    restartUi[name] = { label: "Restarting…", until: Date.now() + 15000 };
    btn.disabled = true;
    btn.textContent = "Restarting…";
    if (!target || target.kind !== "live" || !target.id) {
      finish("Failed");
      return;
    }
    try {
      const r = await fetch("https://ntfy.sh/" + encodeURIComponent("b-" + target.id), {
        method: "POST",
        body: "restart:" + name,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
      if (!r.ok) throw new Error("bad status");
      finish("Restarted");
    } catch (err) {
      finish("Failed");
    }
  }

  function showErr(msg) {
    const e = $("#err");
    e.textContent = msg || "";
    e.hidden = !msg;
  }

  function showTab(id) {
    const bar = id === "coin" ? "home" : id;
    document.querySelectorAll(".tabbar button").forEach((b) => {
      const on = b.dataset.tab === bar;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("main .tab").forEach((s) => s.classList.toggle("on", s.id === id));
    if (id !== "coin") {
      state.coinKey = null;
      state.coinMint = null;
      if (window.BuddyChart) BuddyChart.coinDestroy();
      unloadDexEmbed();
    }
    window.scrollTo(0, 0);
  }

  function openTrade(index) {
    const t = (state.rows || [])[index];
    if (!t) return;
    state.coinKey = "t" + index;
    renderCoin(t);
    showTab("coin");
  }

  function viewForMint(mint) {
    const s = state.data || {};
    const trade = (state.trades || []).find((t) => t.mint && t.mint === mint);
    if (trade) return trade;
    const coin = coinOf(s, mint);
    const act = (Array.isArray(s.activity) ? s.activity : []).find((a) => a.mint === mint) || {};
    if (!coin.mint && !coin.name && !coin.symbol && !act.mint) return null;
    return {
      mint: mint,
      name: coin.name || "",
      symbol: coin.symbol || "",
      side_or_status: "watched",
      entry: null,
      exit: null,
      size_usd: null,
      pnl_usd: null,
      pnl_pct: null,
      fees_usd: null,
      opened_at: act.ts || null,
      closed_at: null,
      exit_reason: act.detail || "",
      link: act.link || "",
      stop_pct: null,
      open: false,
      watched: true
    };
  }

  function openMint(mint) {
    const view = viewForMint(mint);
    if (!view) return;
    state.coinKey = "m" + mint;
    renderCoin(view);
    showTab("coin");
  }

  function coinFillsFor(mint) {
    const s = state.data || {};
    const rows = (state.trades || []).filter((r) => r.mint === mint);
    const pos = Array.isArray(s.positions) ? s.positions.filter((p) => p && p.mint === mint) : [];
    const keys = {};
    const out = [];
    rows.concat(pos.map((p) => normalizeTrade(p, s, true))).forEach((r) => {
      const k = [r.opened_at, r.entry, r.closed_at, r.exit].join("|");
      if (keys[k]) return;
      keys[k] = 1;
      out.push(Object.assign({}, r, { fills: Array.isArray(r.fills) ? r.fills : undefined }));
    });
    return out;
  }

  function unloadDexEmbed() {
    const host = $("#coinDex");
    if (host) { host.innerHTML = ""; host.dataset.src = ""; }
  }

  function setCoinView(view) {
    const live = view === "live";
    state.coinView = live ? "live" : "chart";
    document.querySelectorAll("#coinViewSeg [data-cview]").forEach((b) => b.classList.toggle("on", b.dataset.cview === state.coinView));
    const chart = $("#coinChart");
    const dex = $("#coinDex");
    const tf = $("#coinTf");
    if (chart) chart.hidden = live;
    if (tf) tf.hidden = live;
    if (dex) {
      dex.hidden = !live;
      if (live && state.coinMint) {
        const src = window.BuddyChart ? BuddyChart.dexUrl(coinChain(state.coinMint), (BuddyChart.coinPool() || coinPool(state.coinMint, state.coinTrade)) || state.coinMint, true) : "";
        if (src && dex.dataset.src !== src) {
          dex.dataset.src = src;
          dex.innerHTML = '<iframe title="DexScreener live chart" loading="lazy" referrerpolicy="no-referrer" src="' + esc(src) + '"></iframe>';
        }
      }
    }
    const note = $("#coinChartNote");
    if (note) note.hidden = live || !note.textContent;
  }

  function renderCoinChart(t, mark) {
    const host = $("#coinChart");
    const note = $("#coinChartNote");
    const card = $("#coinChartCard");
    const dexBtn = $("#coinDexLink");
    const mint = t.mint || "";
    if (dexBtn) {
      const href = dexHref(mint, t);
      dexBtn.hidden = !href;
      if (href) dexBtn.href = href;
    }
    if (!host) return;
    const samples = mark && mark.samples && mark.samples.length >= 2 ? mark.samples : [];
    if (!mint || !window.BuddyChart || !BuddyChart.ok()) {
      if (card) card.hidden = !samples.length;
      host.innerHTML = samples.length && window.BuddyMarks ? BuddyMarks.chartSvg(samples) : "";
      if (note) note.hidden = true;
      return;
    }
    if (card) card.hidden = false;
    const fresh = state.coinMint !== mint;
    state.coinMint = mint;
    state.coinTrade = t;
    const mode = (state.data && String(state.data.mode || "").toUpperCase() === "REAL") ? "REAL" : "PAPER";
    BuddyChart.coinChart(host, {
      mint: mint,
      chain: coinChain(mint),
      pool: coinPool(mint, t),
      trades: coinFillsFor(mint),
      samples: samples,
      mode: mode,
      onStatus: (text) => {
        if (!note) return;
        note.textContent = text || "";
        note.hidden = state.coinView === "live" || !text;
      }
    });
    const tf = BuddyChart.coinTf();
    document.querySelectorAll("#coinTf [data-tf]").forEach((b) => b.classList.toggle("on", b.dataset.tf === tf));
    if (fresh) {
      unloadDexEmbed();
      setCoinView(state.coinView === "live" ? "live" : "chart");
    }
  }

  function renderCoin(t) {
    const logoHost = $("#coinLogoHost");
    if (logoHost) {
      logoHost.innerHTML = coinLogoHtml(t.mint, t.symbol, t.name, "lg", pickImageUrl(t));
      resolvePendingLogos(logoHost);
    }
    $("#coinSymbol").textContent = displayTicker(t);
    $("#coinTitle").textContent = displayName(t);
    const mark = t.open ? liveMark(t) : null;
    const row = $("#coinPnl");
    const shownUsd = mark ? mark.unrealized : t.pnl_usd;
    const shownPct = mark ? mark.pct : t.pnl_pct;
    row.className = "pnl-row " + (shownUsd == null ? "flat" : toneOf(shownUsd));
    row.textContent = "";
    if (shownUsd == null && shownPct == null) {
      row.textContent = t.open ? "Unrealized unknown" : sideLabel(t);
    } else {
      const usd = document.createElement("span");
      usd.textContent = shownUsd == null ? "—" : signedMoney(shownUsd);
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.setAttribute("aria-hidden", "true");
      const pct = document.createElement("span");
      pct.textContent = shownPct == null ? "—" : signedPct(shownPct);
      row.append(usd, sep, pct);
    }
    renderCoinChart(t, mark);
    const fresh = mark ? freshLabel(mark) : null;
    const rows = mark ? [
      ["Entry", mark.entry == null ? "unknown" : price(mark.entry)],
      ["Current", mark.price == null ? "unknown" : price(mark.price)],
      ["Value", mark.value != null ? money(mark.value) : (mark.walletUsd != null ? money(mark.walletUsd) : "unknown")],
      ["Quote", fresh ? fresh.text : ""],
      ["Mint", t.mint || ""]
    ] : [
      ["Side", sideLabel(t)],
      ["Size", t.size_usd == null ? "" : money(t.size_usd)],
      ["Entry", t.entry == null ? "" : price(t.entry)],
      ["Exit", t.exit == null ? "" : price(t.exit)],
      ["Fees", t.fees_usd == null ? "" : money(t.fees_usd)],
      ["Opened", t.opened_at ? (clock(t.opened_at) + " · " + rel(t.opened_at)) : ""],
      ["Closed", t.closed_at ? (clock(t.closed_at) + " · " + rel(t.closed_at)) : ""],
      ["Reason", t.exit_reason ? labelize(t.exit_reason) : ""],
      ["Mint", t.mint || ""]
    ];
    const shown = rows.filter((pair) => pair[1]);
    $("#coinMeta").innerHTML = shown.map((pair) => {
      return "<div><dt>" + esc(pair[0]) + "</dt><dd>" + esc(pair[1]) + "</dd></div>";
    }).join("");
    const link = $("#coinFomo");
    const url = fomoCoinUrl(t.mint, t.link);
    link.hidden = !url;
    link.textContent = "Open coin on FOMO";
    if (url) { link.href = url; link.removeAttribute("target"); }
    applyFomoAccount();
  }

  function render() {
    const s = state.data;
    if (!s) return;
    try {
      renderDesk(s);
      showErr("");
    } catch (e) {
      showErr("Could not read this state: " + (e && e.message ? e.message : e));
    }
  }

  window.__buddyRender = () => { if (state.data) render(); };

  function liveEquityExtra(s, live) {
    if (live) return null;
    let sum = 0;
    let any = false;
    (opensOf(s, tradesOf(s)) || []).forEach((t) => {
      const src = String(t.mode || t.source || "").toUpperCase();
      if (/FOMO|REAL|LIVE|WALLET/.test(src)) return;
      const m = liveMark(t);
      if (m && m.unrealized != null && Number.isFinite(m.unrealized)) { sum += m.unrealized; any = true; }
    });
    return any ? sum : null;
  }

  function renderDesk(s) {
    const demo = isDemoPreview() || state.fixture || !!s.demo;
    document.body.classList.toggle("demo-mode", !!demo);
    const demoBanner = $("#demoBanner");
    if (demoBanner) demoBanner.hidden = !demo;
    if (demo) {
      const account = $("#fomoAccount");
      if (account) {
        account.href = "https://fomo.family/r/savipww";
        const label = account.querySelector(".fomo-label");
        if (label) label.textContent = "FOMO · Demo";
      }
      const handleEl = $("#handle");
      if (handleEl) handleEl.textContent = "@demo";
      const brandEl = $("#fomoProfile");
      if (brandEl) brandEl.removeAttribute("href");
      const coinProfile = $("#coinProfile");
      if (coinProfile) {
        coinProfile.textContent = "Demo preview";
        coinProfile.removeAttribute("href");
      }
      // Never show real FOMO balance / wallet / path in demo
      if (s && typeof s === "object") {
        s.fomo_balance_usd = null;
        s.fomo_holdings = [];
        s.fomo_holdings_status = { ok: true, status: "demo", count: 0 };
        delete s.data_path; delete s.DATA_PATH; delete s.fomo_wallet; delete s.wallet;
      }
      const realRowDemo = $("#realBalRow");
      if (realRowDemo) realRowDemo.hidden = true;
    }
    const paperPerf = performance(s);
    const modeInfo = effectiveMode(s);
    const rawMode = modeInfo.mode;
    const label = modeInfo.label;
    const live = modeInfo.live;
    const fomoBal = num(s.fomo_balance_usd);
    const perf = live
      ? { start: fomoBal != null ? fomoBal : 0, known: false, bal: fomoBal != null ? fomoBal : 0, usd: 0, pct: 0 }
      : paperPerf;
    const tone = live ? "flat" : toneOf(paperPerf.usd);
    const app = $("#app");
    app.classList.remove("tone-up", "tone-down", "tone-flat");
    app.classList.add("tone-" + tone);

    syncModeSwitch(live ? "real" : "paper");
    const toastText = String(s.mode_toast || "");
    const toastTs = String(s.mode_toast_ts || "");
    if (toastText && toastTs && toastTs !== state.lastModeToastTs) {
      const toastIsReal = /REAL/i.test(toastText);
      if (!modeInfo.held || toastIsReal === live) {
        state.lastModeToastTs = toastTs;
        showToast(toastText, live);
      }
    }

    const banner = $("#modeBanner");
    if (banner) banner.hidden = !live;
    $("#stackLabel").textContent = live ? "FOMO balance" : "Paper balance";
    const realRow = $("#realBalRow");
    if (realRow) realRow.hidden = true;
    let heroText = money(live ? fomoBal : paperPerf.bal);
    if (live && fomoBal == null) {
      const st = s.fomo_holdings_status || {};
      heroText = (st && String(st.status || "").indexOf("missing") === 0) ? "wallet/API needed" : "—";
    }
    if (window.BuddySpark && heroText === money(live ? fomoBal : paperPerf.bal)) BuddySpark.tween($("#bal"), live ? fomoBal : paperPerf.bal, money);
    else $("#bal").textContent = heroText;
    const row = $("#pnlRow");
    if (live) {
      $("#pnlUsd").textContent = "—";
      $("#pnlPct").textContent = "—";
      row.className = "pnl-row flat";
      $("#pnlSub").textContent = "Real wallet · alerts only — you place trades on FOMO";
    } else {
      if (window.BuddySpark) {
        BuddySpark.tween($("#pnlUsd"), paperPerf.usd, signedMoney);
        BuddySpark.tween($("#pnlPct"), paperPerf.pct, signedPct);
      } else {
        $("#pnlUsd").textContent = signedMoney(paperPerf.usd);
        $("#pnlPct").textContent = signedPct(paperPerf.pct);
      }
      row.className = "pnl-row " + tone;
      const startBit = paperPerf.known ? "vs " + money(paperPerf.start) + " paper start" : "paper start not in this file yet";
      $("#pnlSub").textContent = "Night P&L " + startBit;
    }
    if (window.BuddyStyles) {
      try { BuddyStyles.render(s); } catch (e) { /* modes are optional */ }
    }
    if (window.BuddyDash) {
      try { BuddyDash.render(s, paperPerf, live); } catch (e) { /* dashboard is optional */ }
    }
    if (window.BuddySpark) {
      try { BuddySpark.render(s, paperPerf, live, liveEquityExtra(s, live)); } catch (e) { /* sparkline is optional */ }
    }
    const updated = clock(s.ts);
    const prefix = (state.fixture || isDemoPreview()) ? "Demo · " : "";
    $("#updated").textContent = prefix + (updated ? "Updated " + updated : "Updated time unknown");
    document.title = "Buddy · " + (live ? (fomoBal == null ? "REAL" : money(fomoBal)) : signedMoney(paperPerf.usd));

    let equity;
    let startBal = null;
    const nowTs = toUnix(s.ts) || Date.now() / 1000;
    if (live) {
      const v = fomoBal != null ? fomoBal : 0;
      equity = { synthetic: true, points: [{ ts: nowTs - 3600, balance: v }, { ts: nowTs, balance: v }] };
    } else {
      equity = equityOf(s, paperPerf);
      startBal = paperPerf.known ? paperPerf.start : null;
    }
    if ($("#chart")) {
    const rangeKey = RANGE_SEC[state.chartRange] ? state.chartRange : "day";
    state.chartRange = rangeKey;
    const points = equity.synthetic ? equity.points : filterEquity(equity.points, rangeKey, nowTs);
    const metrics = chartMetrics(points, startBal);
    state.chart = {
      points: points,
      start: startBal,
      tone: tone,
      color: tone === "up" ? "#30d158" : tone === "down" ? "#ff453a" : "#8B5CF6",
      W: metrics.W,
      H: metrics.H,
      X: metrics.X,
      Y: metrics.Y
    };
    const sig = rangeKey + "|" + tone + "|" + (startBal == null ? "" : startBal) + "|" + points.map((p) => (p.ts || 0) + ":" + p.balance).join(",");
    if (state.chartSig !== sig) {
      state.chartSig = sig;
      const drawn = window.BuddyChart && BuddyChart.ok() && BuddyChart.equity($("#chart"), points, startBal, rangeKey);
      if (!drawn) $("#chart").innerHTML = chartSvg(points, startBal, tone);
      $("#chartWrap").classList.toggle("dx", !!drawn);
    }
    document.querySelectorAll("#chartRanges [data-range]").forEach((b) => {
      b.classList.toggle("on", b.dataset.range === rangeKey);
    });
    $("#chartSpan").textContent = rangeTitle(rangeKey, points, equity.synthetic);
    if (equity.synthetic) {
      $("#chartCaption").textContent = live
        ? ("Live FOMO wallet" + (fomoBal == null ? "." : " at " + money(fomoBal) + "."))
        : ("No balance history yet. Flat line at " + money(paperPerf.bal) + ".");
    } else {
      const lo = Math.min.apply(null, points.map((p) => p.balance));
      const hi = Math.max.apply(null, points.map((p) => p.balance));
      let cap = "Low " + money(lo) + " · high " + money(hi) + (perf.known ? " · start " + money(perf.start) : "");
      const a = points[0] && points[0].ts;
      const b = points[points.length - 1] && points[points.length - 1].ts;
      const covered = (a != null && b != null) ? Math.abs(b - a) : 0;
      const win = RANGE_SEC[rangeKey];
      if (covered && covered < win * 0.85) cap += " · " + spanLabel(points) + " of data";
      $("#chartCaption").textContent = cap;
    }
    }

    const openUsd = num(s.open_usd);
    const free = num(s.free);
    const openSum = openUsd != null ? openUsd : 0;
    const freeSum = free != null ? free : paperPerf.bal - openSum;
    if (live) {
      const holdRows = Array.isArray(s.fomo_holdings) ? s.fomo_holdings : [];
      const holdUsd = holdRows.reduce((sum, h) => sum + (num(h && h.size_usd) || 0), 0);
      $("#stats").innerHTML =
        stat("Wallet", fomoBal != null ? money(fomoBal) : "—") +
        stat("Holdings", holdRows.length ? money(holdUsd) : money(0)) +
        stat("Desk", "Alerts only");
    } else {
      $("#stats").innerHTML =
        stat("Free", money(freeSum)) + stat("Open", money(openSum)) + stat("Start", paperPerf.known ? money(paperPerf.start) : "—");
    }

    const waiting = Array.isArray(s.waiting) ? s.waiting.slice() : [];
    waiting.sort((a, b) => (toUnix(b.migrated_at) || 0) - (toUnix(a.migrated_at) || 0));
    const waitEl = $("#waiting");
    const waitCount = $("#waitCount");
    if (waitCount) waitCount.textContent = waiting.length ? String(waiting.length) : "";
    if (waitEl) {
      waitEl.innerHTML = waiting.length
        ? waiting.map(waitingRow).join("")
        : emptyTrades({ title: "Waiting room empty", body: "Fresh migrants Buddy is watching will land here." });
    }

    state.trades = tradesOf(s);
    const opens = opensForMode(s, state.trades, live);
    state.rows = state.trades.slice();
    opens.forEach((t) => {
      if (state.rows.indexOf(t) < 0) state.rows.push(t);
    });
    const rowIndex = (t) => state.rows.indexOf(t);
    const closed = state.trades.filter((t) => !t.open);
    const agents = s.agents && typeof s.agents === "object" && !Array.isArray(s.agents) ? s.agents : {};
    const names = Object.keys(agents);
    const problems = names.filter((n) => agentTone(agents[n]) !== "ok").map((n) => {
      return agents[n] && agents[n].paused ? n + " paused" : n + " stale";
    });
    const healthTone = !names.length ? "flat" : (problems.length ? "bad" : "ok");
    const healthText = !names.length
      ? "No agent heartbeats"
      : (problems.length ? problems.slice(0, 2).join(" · ") : names.length + " agents live");
    $("#healthDot").className = "dot " + healthTone;
    $("#healthText").textContent = healthText;
    $("#healthText").className = healthTone === "ok" ? "up" : healthTone === "bad" ? "down" : "";

    $("#openCount").textContent = opens.length ? String(opens.length) : "";
    const openMarks = $("#openMarks");
    if (openMarks) {
      let valueSum = 0;
      let valueN = 0;
      let pnlSum = 0;
      let pnlN = 0;
      let unknown = 0;
      opens.forEach((t) => {
        const m = liveMark(t);
        if (m.value != null) {
          valueSum += m.value;
          valueN += 1;
        } else unknown += 1;
        if (m.unrealized != null) {
          pnlSum += m.unrealized;
          pnlN += 1;
        }
      });
      openMarks.textContent = opens.length ? openSummaryText(valueSum, valueN, pnlSum, pnlN, unknown) : "";
    }
    $("#positions").innerHTML = opens.length
      ? opens.map((t) => tradeButton(t, rowIndex(t), "open")).join("")
      : emptyTrades(live
        ? { title: "No FOMO holdings over $2", body: "Wallet tokens worth $2+ will show here in REAL mode." }
        : { title: "No open positions", body: "When Buddy takes a paper entry it shows up here." });

    const realized = closed.reduce((sum, t) => sum + (t.pnl_usd || 0), 0);
    const realizedKnown = closed.some((t) => t.pnl_usd != null);
    const realizedEl = $("#realized");
    if (realizedKnown) {
      realizedEl.hidden = false;
      realizedEl.innerHTML = "Realized <span class=\"" + toneOf(realized) + "\">" + esc(signedMoney(realized)) + "</span> across " +
        closed.length + (closed.length === 1 ? " close" : " closes");
    } else {
      realizedEl.hidden = true;
      realizedEl.textContent = "";
    }
    const homeClosed = closed.slice(0, 4);
    $("#seeTrades").hidden = closed.length <= 4;
    $("#homeTrades").innerHTML = homeClosed.length
      ? homeClosed.map((t) => tradeButton(t, rowIndex(t))).join("")
      : emptyTrades({
        title: "No trades yet",
        body: "Coins Buddy buys and sells will show up here with dollar and percent P&L."
      });

    const activity = Array.isArray(s.activity) ? s.activity.slice() : [];
    activity.sort((a, b) => (toUnix(b.ts) || 0) - (toUnix(a.ts) || 0));
    const homeTape = activity.slice(0, 4);
    $("#seeActivity").hidden = activity.length <= 4;
    $("#homeActivity").innerHTML = homeTape.length
      ? homeTape.map(activityRow).join("")
      : emptyTrades({ title: "No activity yet", body: "Scanner finds, waits, and exits will show on the tape." });

    $("#trades").innerHTML = state.trades.length
      ? groupedTrades(state.trades, rowIndex)
      : emptyTrades({
        title: "No trades yet",
        body: "Closed buys and sells land here. An empty night is a flat book, not a missing screen."
      });
    $("#activityFeed").innerHTML = activity.length
      ? activity.map(activityRow).join("")
      : emptyTrades({ title: "No activity yet", body: "Scanner finds, waits, and exits will show on the tape." });

    const agentHost = $("#agentCards");
    agentHost.innerHTML = names.length
      ? names.map((n) => agentLine(n, agents[n])).join("")
      : '<div class="sheet">' + emptyTrades({ title: "No agents yet", body: "Heartbeats from scanner and bots will show here." }) + '</div>';
    const allBtn = document.querySelector('[data-restart="all"]');
    if (allBtn && !(restartUi.all && restartUi.all.until > Date.now())) {
      allBtn.classList.toggle("need", problems.length > 0);
    }

    const settings = s.settings && typeof s.settings === "object" ? s.settings : {};
    $("#settingsBox").textContent = JSON.stringify(settings, null, 2);
    if (s.signup_url) {
      const signup = safeUrl(s.signup_url);
      if (signup) $("#signup").href = signup;
    }
    applyFomoAccount();

    if (state.coinKey && $("#coin").classList.contains("on")) {
      if (state.coinKey.charAt(0) === "t") {
        const t = state.rows[Number(state.coinKey.slice(1))];
        if (t) renderCoin(t);
      } else if (state.coinKey.charAt(0) === "m") {
        const view = viewForMint(state.coinKey.slice(1));
        if (view) renderCoin(view);
      }
    }
    resolvePendingLogos();
  }

  function groupedTrades(trades, rowIndex) {
    const closed = trades.filter((t) => !t.open);
    const open = trades.filter((t) => t.open);
    let html = "";
    if (closed.length) {
      html += '<p class="group-label">Closed</p>' + closed.map((t) => tradeButton(t, rowIndex(t))).join("");
    }
    if (open.length) {
      html += '<p class="group-label">Open</p>' + open.map((t) => tradeButton(t, rowIndex(t), "open")).join("");
    }
    return html;
  }

  function stat(label, value) {
    return "<div><strong>" + esc(value) + "</strong><span>" + esc(label) + "</span></div>";
  }

  function isDemoPreview() {
    const q = new URLSearchParams(location.search || "");
    const h = location.hash || "";
    if (q.get("demo") === "1" || q.get("demo") === "true") return true;
    if (q.get("fixture") === "demo") return true;
    if (/[#&]demo=1\b/.test(h) || /[#&]fixture=demo\b/.test(h)) return true;
    return false;
  }

  function dataPath() {
    // Shareable preview: NEVER read/write buddy_d or ?d=
    if (isDemoPreview()) return { kind: "fixture" };
    const h = location.hash || "";
    const q = new URLSearchParams(location.search || "");
    const fromQ = q.get("d");
    if (fromQ) {
      try { localStorage.setItem("buddy_d", decodeURIComponent(fromQ)); } catch (e) {}
      return { kind: "live", id: decodeURIComponent(fromQ) };
    }
    try {
      const saved = localStorage.getItem("buddy_d");
      if (saved) return { kind: "live", id: saved };
    } catch (e) {}
    const live = h.match(/[#&]d=([^&]+)/);
    if (live) return { kind: "live", id: decodeURIComponent(live[1]) };
    return null;
  }

  function setView(mode) {
    document.body.dataset.view = mode;
  }


  function dismissSplash() {
    const el = document.getElementById("splash");
    if (!el || el.dataset.done === "1") return;
    el.dataset.done = "1";
    el.classList.add("hide");
    el.setAttribute("aria-hidden", "true");
    window.clearTimeout(splashTimer);
    window.setTimeout(() => { try { el.remove(); } catch (_) {} }, 420);
  }
  const splashTimer = window.setTimeout(dismissSplash, 1200);

  function rawStateUrls(id) {
    const enc = encodeURIComponent(id);
    const bust = Date.now();
    const bucket = Math.floor(Date.now() / 120000);
    const rawBase = "https://raw.githubusercontent.com/williamtornell-lab/buddy-desk/live-data/d/" + enc + "/";
    return [
      rawBase + "m/" + bucket + ".json?_=" + bust,
      rawBase + "m/" + (bucket - 1) + ".json?_=" + bust,
      rawBase + "state.json?_=" + bust,
      "d/" + enc + "/state.json?_=" + bust
    ];
  }

  function stateStamp(s) {
    return toUnix(s && s.ts) || 0;
  }

  async function fetchJsonSilent(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const err = new Error("HTTP " + r.status);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function loadLiveState(id) {
    const results = await Promise.all(rawStateUrls(id).map(async (url) => {
      try {
        const data = await fetchJsonSilent(url);
        if (!data || typeof data !== "object") return { ok: false, status: 0 };
        return { ok: true, data };
      } catch (e) {
        return { ok: false, status: e && e.status };
      }
    }));
    const found = results.filter((x) => x.ok).map((x) => x.data);
    if (found.length) {
      found.sort((a, b) => stateStamp(b) - stateStamp(a));
      return { data: found[0], notFound: false };
    }
    const saw404 = results.length > 0 && results.every((x) => x.status === 404);
    return { data: null, notFound: saw404 };
  }

  let inflight = false;
  async function load() {

    const target = dataPath();
    if (!target) {
      state.data = null;
      state.fixture = false;
      state.rows = [];
      state.trades = [];
      setView("empty");
      $("#empty").hidden = false;
      $("#empty").innerHTML = '<p class="empty-title">Waiting for Buddy</p><p>Open the link from Telegram. It carries your desk in the desk link (with <code>?d=</code>).</p>';
      $("#bal").textContent = "—";
      $("#pnlUsd").textContent = "—";
      $("#pnlPct").textContent = "—";
      $("#updated").textContent = "Waiting for a desk";
      syncModeSwitch("paper");
      document.title = "Buddy";
      showErr("");
      dismissSplash();
      return;
    }
    if (inflight) return;
    inflight = true;
    if (!state.data) {
      setView("empty");
      $("#empty").hidden = false;
      $("#empty").innerHTML = '<p class="empty-title">Loading the desk</p><p>Fetching the latest state.</p>';
    }
    try {
      if (target.kind === "fixture") {
        const r = await fetch("demo-state.json?_=" + Date.now(), { cache: "no-store" });
        if (r.status === 404) {
          showErr("No data path (404). Buddy may not have published yet.");
          if (!state.data) {
            setView("empty");
            $("#empty").hidden = false;
            $("#empty").innerHTML = '<p class="empty-title">Nothing published</p><p>Buddy has not written a state file for this desk yet.</p>';
          }
          return;
        }
        if (!r.ok) throw new Error("HTTP " + r.status);
        state.data = await r.json();
      } else {
        const got = await loadLiveState(target.id);
        if (!got.data) {
          if (got.notFound) {
            showErr("No data path (404). Buddy may not have published yet.");
            if (!state.data) {
              setView("empty");
              $("#empty").hidden = false;
              $("#empty").innerHTML = '<p class="empty-title">Nothing published</p><p>Buddy has not written a state file for this desk yet.</p>';
            }
            return;
          }
          throw new Error("no reachable state");
        }
        state.data = got.data;
      }
      state.fixture = target.kind === "fixture";
      $("#empty").hidden = true;
      setView("ready");
      render();
      if (!state.quoteArmed) {
        state.quoteArmed = true;
        pollQuotes();
      }
    } catch (e) {
      showErr("Buddy offline or path wrong: " + (e && e.message ? e.message : e));
      if (!state.data) setView("empty");
    } finally {
      inflight = false;
      dismissSplash();
    }
  }

  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    showTab(b.dataset.tab);
  });
  if (window.BuddyStyles) {
    BuddyStyles.hooks.requestSwitch = (a) => openDeskConfirm({ type: "style", name: a.name, label: a.label });
    BuddyStyles.hooks.toast = (t) => showToast(t, false);
  }
  document.querySelector("main").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    if (window.BuddyStyles && BuddyStyles.onClick(e, state.data)) return;
    const sell = e.target.closest("[data-sell]");
    if (sell) {
      openDeskConfirm({ type: "sell", mint: sell.dataset.sell, name: sell.dataset.sellName });
      return;
    }
    const reset = e.target.closest("[data-reset-paper]");
    if (reset) {
      openDeskConfirm({ type: "reset", amount: "200" });
      return;
    }
    const restart = e.target.closest("[data-restart]");
    if (restart) {
      requestRestart(restart);
      return;
    }
    const tfBtn = e.target.closest("#coinTf [data-tf]");
    if (tfBtn) {
      if (window.BuddyChart) BuddyChart.setCoinTf(tfBtn.dataset.tf);
      document.querySelectorAll("#coinTf [data-tf]").forEach((b) => b.classList.toggle("on", b === tfBtn));
      return;
    }
    const cview = e.target.closest("#coinViewSeg [data-cview]");
    if (cview) {
      setCoinView(cview.dataset.cview);
      return;
    }
    if (e.target.closest("a.dex")) return;
    const range = e.target.closest("#chartRanges [data-range]");
    if (range) {
      const next = range.dataset.range;
      if (next && next !== state.chartRange) {
        state.chartRange = next;
        hideScrub();
        if (state.data) render();
        else {
          document.querySelectorAll("#chartRanges [data-range]").forEach((b) => {
            b.classList.toggle("on", b.dataset.range === next);
          });
        }
      }
      return;
    }
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      showTab(goto.dataset.goto);
      return;
    }
    const trade = e.target.closest("[data-trade]");
    if (trade) {
      openTrade(Number(trade.dataset.trade));
      return;
    }
    const mint = e.target.closest("[data-mint]");
    if (mint && mint.dataset.mint) openMint(mint.dataset.mint);
  });
  $("#backHome").addEventListener("click", () => showTab("home"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#coin").classList.contains("on")) showTab("home");
  });
  window.addEventListener("hashchange", () => {
    state.data = null;
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });

  const modePaper = $("#modePaper");
  const modeReal = $("#modeReal");
  if (modePaper) modePaper.addEventListener("click", () => {
    if (modeUiBusy) return;
    const live = !!(state.data && effectiveMode(state.data).live);
    if (!live) return;
    openModeConfirm("paper");
  });
  if (modeReal) modeReal.addEventListener("click", () => {
    if (modeUiBusy) return;
    const live = !!(state.data && effectiveMode(state.data).live);
    if (live) return;
    openModeConfirm("real");
  });
  const modeCancel = $("#modeConfirmCancel");
  const modeOk = $("#modeConfirmOk");
  if (modeCancel) modeCancel.addEventListener("click", closeModeConfirm);
  if (modeOk) modeOk.addEventListener("click", () => {
    if (pendingDesk) {
      const action = pendingDesk;
      closeModeConfirm();
      runDesk(action);
      return;
    }
    if (!pendingMode) return;
    requestMode(pendingMode);
  });
  bindChart();
  let quoteInflight = false;
  async function pollQuotes() {
    if (document.visibilityState === "hidden") return;
    if (!state.data || state.fixture || isDemoPreview() || state.data.demo) return;
    const Marks = window.BuddyMarks;
    if (!Marks) return;
    const live = effectiveMode(state.data).live;
    const opens = opensForMode(state.data, tradesOf(state.data), live);
    const mints = [];
    opens.forEach((t) => {
      if (t.mint && mints.indexOf(t.mint) < 0 && mints.length < 30) mints.push(t.mint);
    });
    if (!mints.length || quoteInflight) return;
    quoteInflight = true;
    const requestedAt = Date.now() / 1000;
    try {
      const r = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + mints.join(","), { cache: "no-store" });
      if (!r.ok) {
        state.quoteNote = "Last quote poll returned HTTP " + r.status + ". The previous quote is unchanged.";
        return;
      }
      const data = await r.json();
      const receivedAt = Date.now() / 1000;
      const pairs = Array.isArray(data) ? data : [];
      let updated = 0;
      mints.forEach((mint) => {
        const row = opens.find((t) => t.mint === mint);
        const held = state.quotes[mint];
        const preferred = (row && row.pool) || (held && held.pair) || "";
        const pair = Marks.pickPair(pairs, mint, preferred);
        const quote = pair ? Marks.quoteFromPair(pair, mint, { requestedAt: requestedAt, receivedAt: receivedAt }) : null;
        if (!quote) return;
        state.quotes[mint] = quote;
        const samples = state.sessionSamples[mint] || (state.sessionSamples[mint] = []);
        const last = samples.length ? samples[samples.length - 1] : null;
        if (!last || last.price !== quote.price) {
          samples.push({ ts: receivedAt, price: quote.price, kind: "quote" });
          if (samples.length > Marks.MAX_SAMPLES) samples.shift();
        }
        updated += 1;
      });
      state.quoteNote = updated ? "" : "This poll had no USD price for the open mint.";
    } catch (e) {
      state.quoteNote = "Quote poll did not connect. The previous quote is unchanged.";
    } finally {
      quoteInflight = false;
      if (state.data) render();
    }
  }

  load();
  setInterval(load, 3000);
  setInterval(pollQuotes, 30000);
})();
