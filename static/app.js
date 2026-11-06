(() => {
  const $ = (s) => document.querySelector(s);
  const state = { data: null, fixture: false, coinKey: null };

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
      opened_at: p.opened_at || p.opened || null,
      closed_at: closedAt,
      exit_reason: p.exit_reason || "",
      link: p.link || "",
      stop_pct: num(p.stop_pct),
      open
    };
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

  function chartSvg(points, start, tone) {
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
    const cmds = points.map((p, i) => (i ? "L" : "M") + X(i).toFixed(2) + " " + Y(p.balance).toFixed(2));
    const line = cmds.join(" ");
    const baseY = (H - padB).toFixed(2);
    const area = line + " L " + X(n - 1).toFixed(2) + " " + baseY + " L " + X(0).toFixed(2) + " " + baseY + " Z";
    const color = tone === "up" ? "#4ade80" : tone === "down" ? "#fb7185" : "#8b9aab";
    const flat = Math.max.apply(null, vals) - Math.min.apply(null, vals) < Math.max(0.02, Math.abs(start || 0) * 0.002);
    let guide = "";
    if (showStart && !flat && start >= lo && start <= hi) {
      const y = Y(start).toFixed(2);
      guide = '<line class="start-line" x1="' + padX + '" x2="' + (W - padX) + '" y1="' + y + '" y2="' + y + '"/>';
    }
    const lx = X(n - 1).toFixed(2);
    const ly = Y(points[n - 1].balance).toFixed(2);
    const gid = "eqFill";
    return (
      '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(chartLabel(points, tone)) + '">' +
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

  function fomoLink(href, label) {
    const url = safeUrl(href);
    if (!url) return "";
    return '<a class="fomo" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label || "FOMO") + "</a>";
  }

  function tradeBits(t, mode) {
    const bits = [sideLabel(t)];
    if (mode === "open") {
      if (t.size_usd != null) bits.push(money(t.size_usd));
      if (t.entry != null) bits.push("entry\u00a0" + price(t.entry));
      if (t.stop_pct != null) bits.push("stop\u00a0−" + trimNum(t.stop_pct) + "%");
      return bits;
    }
    if (t.exit_reason && !t.open) bits.push(labelize(t.exit_reason));
    if (t.size_usd != null) bits.push(money(t.size_usd));
    if (t.fees_usd) bits.push("fees " + money(t.fees_usd));
    const when = rel(t.closed_at || t.opened_at);
    if (when) bits.push(when);
    return bits;
  }

  function pnlMarkup(t) {
    if (t.open && t.pnl_usd == null) return "";
    return '<span class="pnl-col ' + toneOf(t.pnl_usd) + '">' + esc(signedMoney(t.pnl_usd)) +
      '<span class="pct">' + esc(signedPct(t.pnl_pct)) + "</span></span>";
  }

  function tradeButton(t, index, mode) {
    const bits = tradeBits(t, mode).filter((bit) => bit.indexOf("fees ") !== 0);
    const name = displayName(t);
    if (name && name !== displayTicker(t)) bits.unshift(name);
    return (
      '<div class="trade-row">' +
      '<button type="button" class="trade" data-trade="' + index + '">' +
      "<span class=\"who\">" +
      '<span class="ticker">' + esc(displayTicker(t)) + "</span>" +
      '<span class="meta-line">' + esc(bits.join(" · ")) + "</span>" +
      "</span>" + pnlMarkup(t) +
      "</button>" + fomoLink(t.link, "FOMO") +
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
      "<div>" + esc(title) + "</div>" +
      '<div class="meta-line">' + esc(detailBits.join(" · ")) + "</div>" +
      "</button>" + fomoLink(a.link, "FOMO") +
      "</div>"
    );
  }

  function emptyTrades(copy) {
    return '<div class="empty-card"><p class="empty-title">' + esc(copy.title) + "</p><p>" + esc(copy.body) + "</p></div>";
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
    return (
      '<article class="agent">' +
      '<span class="dot ' + tone + '" aria-hidden="true"></span>' +
      '<div class="grow"><h3>' + esc(name) + "</h3><p>" + esc(detail) + "</p></div>" +
      '<span class="badge ' + (tone === "ok" ? "up" : "down") + '">' + esc(status) + "</span>" +
      "</article>"
    );
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
    if (id !== "coin") state.coinKey = null;
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

  function renderCoin(t) {
    $("#coinSymbol").textContent = displayTicker(t);
    $("#coinTitle").textContent = displayName(t);
    const row = $("#coinPnl");
    row.className = "pnl-row " + (t.open && t.pnl_usd == null ? "flat" : toneOf(t.pnl_usd));
    row.textContent = "";
    if (t.pnl_usd == null && t.pnl_pct == null) {
      row.textContent = sideLabel(t);
    } else {
      const usd = document.createElement("span");
      usd.textContent = signedMoney(t.pnl_usd);
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.setAttribute("aria-hidden", "true");
      const pct = document.createElement("span");
      pct.textContent = signedPct(t.pnl_pct);
      row.append(usd, sep, pct);
    }
    const rows = [
      ["Side", sideLabel(t)],
      ["Size", t.size_usd == null ? "" : money(t.size_usd)],
      ["Entry", t.entry == null ? "" : price(t.entry)],
      ["Exit", t.exit == null ? "" : price(t.exit)],
      ["Fees", t.fees_usd == null ? "" : money(t.fees_usd)],
      ["Opened", t.opened_at ? (clock(t.opened_at) + " · " + rel(t.opened_at)) : ""],
      ["Closed", t.closed_at ? (clock(t.closed_at) + " · " + rel(t.closed_at)) : ""],
      ["Reason", t.exit_reason ? labelize(t.exit_reason) : ""],
      ["Mint", t.mint || ""]
    ].filter((pair) => pair[1]);
    $("#coinMeta").innerHTML = rows.map((pair) => {
      return "<div><dt>" + esc(pair[0]) + "</dt><dd>" + esc(pair[1]) + "</dd></div>";
    }).join("");
    const link = $("#coinFomo");
    const url = safeUrl(t.link);
    link.hidden = !url;
    if (url) link.href = url;
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

  function renderDesk(s) {
    const perf = performance(s);
    const tone = toneOf(perf.usd);
    const app = $("#app");
    app.classList.remove("tone-up", "tone-down", "tone-flat");
    app.classList.add("tone-" + tone);

    const mode = String(s.mode || "PAPER").toUpperCase();
    const pill = $("#modePill");
    pill.textContent = mode;
    pill.className = "pill" + (mode === "LIVE" ? " live" : "");
    const live = String(s.mode || "").toUpperCase() === "LIVE";
    $("#stackLabel").textContent = live ? "Live stack" : "Paper stack";
    $("#bal").textContent = money(perf.bal);
    $("#pnlUsd").textContent = signedMoney(perf.usd);
    $("#pnlPct").textContent = signedPct(perf.pct);
    const row = $("#pnlRow");
    row.className = "pnl-row " + tone;
    const startBit = perf.known ? "vs " + money(perf.start) + " paper start" : "paper start not in this file yet";
    $("#pnlSub").textContent = "Night P&L " + startBit;
    const updated = clock(s.ts);
    const prefix = state.fixture ? "Fixture · " : "";
    $("#updated").textContent = prefix + (updated ? "Updated " + updated : "Updated");
    document.title = "Buddy · " + signedMoney(perf.usd);

    const equity = equityOf(s, perf);
    const points = equity.points;
    $("#chart").innerHTML = chartSvg(points, perf.known ? perf.start : null, tone);
    $("#chartSpan").textContent = equity.synthetic ? "Flat" : spanLabel(points);
    if (equity.synthetic) {
      $("#chartCaption").textContent = "No balance history yet. Flat line at " + money(perf.bal) + ".";
    } else {
      const lo = Math.min.apply(null, points.map((p) => p.balance));
      const hi = Math.max.apply(null, points.map((p) => p.balance));
      $("#chartCaption").textContent = "Low " + money(lo) + " · high " + money(hi) + (perf.known ? " · start " + money(perf.start) : "");
    }

    const openUsd = num(s.open_usd);
    const free = num(s.free);
    const openSum = openUsd != null ? openUsd : 0;
    const freeSum = free != null ? free : perf.bal - openSum;
    $("#stats").innerHTML =
      stat("Free", money(freeSum)) + stat("Open", money(openSum)) + stat("Start", perf.known ? money(perf.start) : "—");

    state.trades = tradesOf(s);
    const opens = opensOf(s, state.trades);
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
    $("#positions").innerHTML = opens.length
      ? opens.map((t) => tradeButton(t, rowIndex(t), "open")).join("")
      : '<div class="quiet">No open positions</div>';

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
      : '<div class="quiet">No activity yet</div>';

    $("#trades").innerHTML = state.trades.length
      ? groupedTrades(state.trades, rowIndex)
      : emptyTrades({
        title: "No trades yet",
        body: "Closed buys and sells land here. An empty night is a flat book, not a missing screen."
      });
    $("#activityFeed").innerHTML = activity.length
      ? activity.map(activityRow).join("")
      : '<div class="quiet">No activity yet</div>';

    const agentHost = $("#agentCards");
    agentHost.innerHTML = names.length
      ? names.map((n) => agentLine(n, agents[n])).join("")
      : '<div class="sheet"><div class="quiet">No agent heartbeats in this file.</div></div>';

    const settings = s.settings && typeof s.settings === "object" ? s.settings : {};
    $("#settingsBox").textContent = JSON.stringify(settings, null, 2);
    if (s.signup_url) {
      const signup = safeUrl(s.signup_url);
      if (signup) $("#signup").href = signup;
    }
    const handle = s.fomo_handle || settings.fomo_handle || "";
    $("#handle").textContent = handle ? handle + " · " : "";

    if (state.coinKey && $("#coin").classList.contains("on")) {
      if (state.coinKey.charAt(0) === "t") {
        const t = state.rows[Number(state.coinKey.slice(1))];
        if (t) renderCoin(t);
      } else if (state.coinKey.charAt(0) === "m") {
        const view = viewForMint(state.coinKey.slice(1));
        if (view) renderCoin(view);
      }
    }
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

  function dataPath() {
    const h = location.hash || "";
    const live = h.match(/[#&]d=([^&]+)/);
    if (live) return { kind: "live", id: decodeURIComponent(live[1]) };
    const fixture = h.match(/[#&]fixture=([^&]+)/);
    if (fixture && fixture[1] === "demo") return { kind: "fixture" };
    return null;
  }

  function setView(mode) {
    document.body.dataset.view = mode;
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
      $("#empty").innerHTML = '<p class="empty-title">Waiting for Buddy</p><p>Open the link from Telegram. It carries your desk in the <code>#d=</code> hash.</p>';
      $("#bal").textContent = "—";
      $("#pnlUsd").textContent = "—";
      $("#pnlPct").textContent = "—";
      $("#updated").textContent = "Waiting for a desk";
      $("#modePill").textContent = "PAPER";
      $("#modePill").className = "pill";
      document.title = "Buddy";
      showErr("");
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
      const url = target.kind === "fixture"
        ? "demo-state.json?_=" + Date.now()
        : "d/" + encodeURIComponent(target.id) + "/state.json?_=" + Date.now();
      const r = await fetch(url, { cache: "no-store" });
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
      state.fixture = target.kind === "fixture";
      $("#empty").hidden = true;
      setView("ready");
      render();
    } catch (e) {
      showErr("Buddy offline or path wrong: " + (e && e.message ? e.message : e));
      if (!state.data) setView("empty");
    } finally {
      inflight = false;
    }
  }

  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    showTab(b.dataset.tab);
  });
  document.querySelector("main").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
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
  load();
  setInterval(load, 15000);
})();
