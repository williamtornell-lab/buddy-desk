/* Buddy DEX-style charts on TradingView Lightweight Charts (Apache-2.0, self-hosted).
   Read-only: draws equity and coin prices. No trading calls. */
(function (root) {
  "use strict";
  var UP = "#30d158";
  var DOWN = "#ff453a";
  var PURPLE = "#8B5CF6";
  var GT = "https://api.geckoterminal.com/api/v2/networks/";
  var EQ_BUCKET = { day: 300, week: 3600, month: 4 * 3600, year: 86400 };
  var COIN_TF = {
    "1m": { path: "minute", agg: 1, sec: 60 },
    "5m": { path: "minute", agg: 5, sec: 300 },
    "15m": { path: "minute", agg: 15, sec: 900 },
    "1h": { path: "hour", agg: 1, sec: 3600 },
    "4h": { path: "hour", agg: 4, sec: 14400 },
    "1d": { path: "day", agg: 1, sec: 86400 }
  };

  function finite(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function unix(ts) {
    if (ts == null || ts === "") return null;
    if (typeof ts === "number") return ts > 1e12 ? ts / 1000 : ts;
    var s = String(ts).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) { var n = Number(s); return n > 1e12 ? n / 1000 : n; }
    var p = Date.parse(s);
    return Number.isFinite(p) ? p / 1000 : null;
  }

  function fmtPrice(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "";
    var a = Math.abs(n);
    if (a === 0) return "0";
    if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    if (a >= 1) return n.toFixed(a >= 100 ? 2 : 4).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".00");
    if (a >= 0.0001) return n.toPrecision(4).replace(/0+$/, "");
    // DexScreener-style subscript zeros: 0.0₅1234
    var str = a.toExponential(3);
    var parts = str.split("e-");
    var zeros = Number(parts[1]) - 1;
    var digits = parts[0].replace(".", "").replace(/0+$/, "");
    var sub = String(zeros).split("").map(function (d) { return "₀₁₂₃₄₅₆₇₈₉"[Number(d)]; }).join("");
    return (n < 0 ? "-" : "") + "0.0" + sub + digits;
  }
  function fmtMoney(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2) + "%";
  }
  function fmtVol(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
    return "$" + n.toFixed(0);
  }

  /* Equity points [{ts, balance}] -> continuous OHLC buckets. Empty buckets carry the last close. */
  function equityCandles(points, bucketSec) {
    var rows = (points || []).filter(function (p) {
      return p && finite(p.balance) != null && unix(p.ts) != null;
    }).map(function (p) { return { ts: unix(p.ts), v: Number(p.balance) }; })
      .sort(function (a, b) { return a.ts - b.ts; });
    if (!rows.length || !(bucketSec > 0)) return [];
    var first = Math.floor(rows[0].ts / bucketSec) * bucketSec;
    var last = Math.floor(rows[rows.length - 1].ts / bucketSec) * bucketSec;
    var maxBars = 2000;
    if ((last - first) / bucketSec > maxBars) first = last - maxBars * bucketSec;
    var out = [];
    var i = 0;
    var prevClose = null;
    while (i < rows.length && Math.floor(rows[i].ts / bucketSec) * bucketSec < first) { prevClose = rows[i].v; i++; }
    for (var t = first; t <= last; t += bucketSec) {
      var o = prevClose, h = null, l = null, c = prevClose;
      while (i < rows.length && Math.floor(rows[i].ts / bucketSec) * bucketSec === t) {
        var v = rows[i].v;
        if (o == null) o = v;
        h = h == null ? Math.max(o, v) : Math.max(h, v);
        l = l == null ? Math.min(o, v) : Math.min(l, v);
        c = v;
        i++;
      }
      if (o == null) continue;
      if (h == null) { h = Math.max(o, c); l = Math.min(o, c); }
      out.push({ time: t, open: o, high: h, low: l, close: c });
      prevClose = c;
    }
    return out;
  }

  function moved(candles) {
    if (!candles.length) return false;
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (c) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); });
    return hi - lo > Math.max(0.01, Math.abs(hi) * 0.0005);
  }

  /* Real recorded fills for one coin -> chart markers. Only rows with a time and price. */
  function fillMarkers(trades, mint, bucketSec, mode) {
    var want = String(mode || "PAPER").toUpperCase();
    var out = [];
    (trades || []).forEach(function (t) {
      if (!t || t.mint !== mint) return;
      var m = String(t.mode || t.source || "PAPER").toUpperCase();
      var isReal = /FOMO|REAL|WALLET|LIVE/.test(m);
      if (want === "PAPER" && isReal) return;
      if (want !== "PAPER" && !isReal) return;
      var fills = Array.isArray(t.fills) ? t.fills : null;
      if (fills && fills.length) {
        fills.forEach(function (f) {
          var ft = unix(f.ts || f.time), fp = finite(f.price);
          if (ft == null || fp == null) return;
          var side = String(f.side || "").toLowerCase().indexOf("s") === 0 ? "sell" : "buy";
          out.push({ ts: ft, price: fp, side: side, usd: finite(f.usd || f.size_usd), pnl: finite(f.pnl_usd), reason: f.reason || f.label || "", key: String(unix(t.opened_at)) + "|" + String(finite(t.entry)) });
        });
        return;
      }
      var ot = unix(t.opened_at), op = finite(t.entry != null ? t.entry : t.entry_price);
      var key = String(ot) + "|" + String(op);
      if (ot != null && op != null && op > 0) out.push({ ts: ot, price: op, side: "buy", usd: finite(t.size_usd), key: key, open: !!t.open });
      var ct = unix(t.closed_at), cp = finite(t.exit != null ? t.exit : t.exit_price);
      if (!t.open && ct != null && cp != null && cp > 0) {
        out.push({ ts: ct, price: cp, side: "sell", usd: null, pnl: finite(t.pnl_usd), pnlPct: finite(t.pnl_pct), reason: t.exit_reason || "", key: key, size: finite(t.size_usd) });
      }
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out.map(function (f) {
      var bar = bucketSec ? Math.floor(f.ts / bucketSec) * bucketSec : Math.floor(f.ts);
      return {
        time: bar,
        position: f.side === "buy" ? "belowBar" : "aboveBar",
        color: f.side === "buy" ? UP : DOWN,
        shape: f.side === "buy" ? "arrowUp" : "arrowDown",
        text: f.side === "buy" ? "B" : "S",
        fill: f
      };
    });
  }

  var REASONS = { tp: "Take profit", stop: "Stop", stop_loss: "Stop", timeout: "Timeout", trail: "Trail", trailing: "Trail",
    pulled: "Pulled", liq_drop: "Liquidity drop", recover: "Recover cost", partial_tp: "Partial TP", manual: "Manual", close: "Manual", fade: "Fade" };
  function reasonLabel(r) {
    var k = String(r || "").toLowerCase();
    if (!k) return "";
    return REASONS[k] || k.replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); });
  }
  function fmtSigned(v) {
    if (v == null || !Number.isFinite(v)) return "";
    return (v > 0 ? "+" : v < 0 ? "\u2212" : "") + "$" + Math.abs(v).toFixed(2);
  }
  function fmtSignedPct(v) {
    if (v == null || !Number.isFinite(v)) return "";
    return (v > 0 ? "+" : v < 0 ? "\u2212" : "") + Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1) + "%";
  }
  function clockSec(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  /* One line per fill, for the legend and the trade list under the chart. */
  function fillText(f) {
    if (f.side === "buy") return "Bought " + clockSec(f.ts) + " · $" + fmtPrice(f.price) + (f.usd != null ? " · $" + f.usd.toFixed(2) : "");
    var bits = ["Sold " + clockSec(f.ts), "$" + fmtPrice(f.price)];
    if (f.pnl != null) bits.push(fmtSigned(f.pnl) + (f.pnlPct != null ? " (" + fmtSignedPct(f.pnlPct) + ")" : ""));
    if (f.reason) bits.push(reasonLabel(f.reason));
    return bits.join(" · ");
  }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  /* Trades on this coin, newest first: [{key, buy, sell, open}] from real recorded fills only. */
  function coinTrades(trades, mint, mode) {
    var by = {}, order = [];
    fillMarkers(trades, mint, 0, mode).forEach(function (m) {
      var f = m.fill, k = f.key || String(f.ts);
      if (!by[k]) { by[k] = { key: k, buys: [], sells: [], open: false }; order.push(k); }
      if (f.side === "buy") { by[k].buys.push(f); if (f.open) by[k].open = true; } else by[k].sells.push(f);
    });
    return order.map(function (k) { return by[k]; }).sort(function (a, b) {
      return ((b.buys[0] || b.sells[0]).ts) - ((a.buys[0] || a.sells[0]).ts);
    });
  }
  function tradeListHtml(trades, mint, mode, live, focusKey) {
    var list = coinTrades(trades, mint, mode);
    if (!list.length) return "";
    return list.slice(0, 6).map(function (t) {
      var b = t.buys[0], s = t.sells[t.sells.length - 1];
      var pnl = s && s.pnl != null ? s.pnl : (t.open && live ? live.pnl : null);
      var pct = s && s.pnlPct != null ? s.pnlPct : (t.open && live ? live.pct : null);
      var tone = pnl == null ? "flat" : pnl > 0 ? "up" : pnl < 0 ? "down" : "flat";
      var from = (b || s).ts, to = s ? s.ts : null;
      var rows = t.buys.map(function (f) { return '<span class="dt-fill buy"><b>B</b>' + esc(fillText(f)) + "</span>"; })
        .concat(t.sells.map(function (f) { return '<span class="dt-fill sell"><b>S</b>' + esc(fillText(f)) + "</span>"; }));
      if (t.open) rows.push('<span class="dt-fill live"><b>•</b>Open' + (pnl != null ? " · " + esc(fmtSigned(pnl)) + (pct != null ? " (" + esc(fmtSignedPct(pct)) + ")" : "") + " now" : "") + "</span>");
      return '<button type="button" class="dt-row' + (t.key === focusKey ? " on" : "") + '" data-chart-focus="' + esc(from) + "," + esc(to || "") + '" data-chart-key="' + esc(t.key) + '">' +
        '<span class="dt-fills">' + rows.join("") + "</span>" +
        '<span class="dt-pnl ' + tone + '">' + esc(pnl == null ? "—" : fmtSigned(pnl)) + "</span></button>";
    }).join("");
  }

  function parseOhlcv(json) {
    var list = json && json.data && json.data.attributes && json.data.attributes.ohlcv_list;
    if (!Array.isArray(list)) return [];
    var seen = {};
    return list.map(function (r) {
      return { time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) };
    }).filter(function (c) {
      if (!Number.isFinite(c.time) || !(c.open > 0) || !(c.close > 0) || seen[c.time]) return false;
      seen[c.time] = 1;
      return true;
    }).sort(function (a, b) { return a.time - b.time; });
  }

  function dexUrl(chain, pairOrMint, embed) {
    if (!pairOrMint) return "";
    var u = "https://dexscreener.com/" + encodeURIComponent(chain || "solana") + "/" + encodeURIComponent(pairOrMint);
    return embed ? u + "?embed=1&theme=dark&info=0&trades=0&chartTheme=dark&chartStyle=1&chartType=usd&interval=5" : u;
  }

  function lib() { return root.LightweightCharts || null; }
  function ok() { return !!(lib() && lib().createChart); }

  function localTime(t, withDate) {
    var d = new Date(t * 1000);
    var hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    if (!withDate) return hm;
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
  }

  function baseChart(host, priceFormatter) {
    var L = lib();
    var chart = L.createChart(host, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#8e8e93",
        fontSize: 11,
        fontFamily: "-apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif",
        attributionLogo: false
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.05)" }
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 1.5,
        tickMarkFormatter: function (t, type) {
          var d = new Date(t * 1000);
          if (type <= 1) return d.toLocaleDateString([], { year: "numeric" });
          if (type === 2) return d.toLocaleDateString([], { month: "short", day: "numeric" });
          return localTime(t, false);
        }
      },
      crosshair: {
        mode: L.CrosshairMode ? L.CrosshairMode.Normal : 0,
        vertLine: { color: "rgba(245,245,247,0.35)", width: 1, style: 3, labelBackgroundColor: "#2c2c31" },
        horzLine: { color: "rgba(245,245,247,0.35)", width: 1, style: 3, labelBackgroundColor: "#2c2c31" }
      },
      localization: {
        priceFormatter: priceFormatter,
        timeFormatter: function (t) { return localTime(t, true); }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }
    });
    return chart;
  }

  function legendEl(host) {
    var el = document.createElement("div");
    el.className = "dx-legend";
    host.appendChild(el);
    return el;
  }

  function ohlcLegend(c, ref, fmt, extra) {
    var tone = c.close >= c.open ? "up" : "down";
    var chg = ref ? (c.close / ref - 1) * 100 : null;
    var html = '<span class="dx-time">' + localTime(c.time, true) + "</span>" +
      '<span><i>O</i>' + fmt(c.open) + "</span><span><i>H</i>" + fmt(c.high) + "</span>" +
      '<span><i>L</i>' + fmt(c.low) + '</span><span class="' + tone + '"><i>C</i>' + fmt(c.close) + "</span>";
    if (chg != null) html += '<span class="' + (chg >= 0 ? "up" : "down") + '">' + fmtPct(chg) + "</span>";
    if (extra) html += extra;
    return html;
  }

  /* ---------- Equity ---------- */
  var eq = null;

  function equity(host, points, start, range) {
    if (!ok() || !host) return false;
    var bucket = EQ_BUCKET[range] || EQ_BUCKET.day;
    var candles = equityCandles(points, bucket);
    if (!candles.length) return false;
    var useCandles = candles.length >= 6 && moved(candles);
    if (!eq || eq.host !== host || !host.contains(eq.box)) {
      host.innerHTML = "";
      var box = document.createElement("div");
      box.className = "dx-box";
      host.appendChild(box);
      var chart = baseChart(box, fmtMoney);
      eq = { host: host, box: box, chart: chart, legend: legendEl(box), series: null, kind: "", startLine: null };
      chart.subscribeCrosshairMove(function (param) {
        if (!eq || !eq.series) return;
        var d = param && param.time != null && param.seriesData ? param.seriesData.get(eq.series) : null;
        eq.legend.innerHTML = legendFor(d || eq.lastBar);
      });
    }
    var kind = useCandles ? "candle" : "area";
    var last = candles[candles.length - 1];
    var lastTone = start != null && last.close < start ? "down" : (start != null && last.close > start ? "up" : "flat");
    var color = lastTone === "up" ? UP : lastTone === "down" ? DOWN : PURPLE;
    if (eq.series && eq.kind !== kind) { eq.chart.removeSeries(eq.series); eq.series = null; eq.startLine = null; }
    if (!eq.series) {
      eq.series = kind === "candle"
        ? eq.chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineVisible: true, priceLineStyle: 2 })
        : eq.chart.addAreaSeries({ lineWidth: 2, priceLineVisible: true, priceLineStyle: 2, crosshairMarkerRadius: 4 });
      eq.kind = kind;
    }
    if (kind === "area") {
      eq.series.applyOptions({ lineColor: color, topColor: color + "55", bottomColor: color + "00", priceLineColor: color });
      eq.series.setData(candles.map(function (c) { return { time: c.time, value: c.close }; }));
    } else {
      eq.series.setData(candles);
    }
    if (eq.startLine) { eq.series.removePriceLine(eq.startLine); eq.startLine = null; }
    if (start != null && Number.isFinite(start) && moved(candles)) {
      eq.startLine = eq.series.createPriceLine({ price: start, color: "rgba(142,142,147,0.55)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "start" });
    }
    eq.start = start;
    eq.lastBar = kind === "area" ? { time: last.time, value: last.close } : last;
    var sig = range + "|" + candles.length;
    if (eq.sig !== sig) { eq.chart.timeScale().fitContent(); eq.sig = sig; }
    eq.legend.innerHTML = legendFor(eq.lastBar);
    return true;

    function legendFor(d) {
      if (!d) return "";
      var ref = eq.start;
      if (d.open != null) return ohlcLegend(d, ref, fmtMoney);
      var chg = ref ? (d.value / ref - 1) * 100 : null;
      var pnl = ref != null ? d.value - ref : null;
      return '<span class="dx-time">' + localTime(d.time, true) + "</span><span>" + fmtMoney(d.value) + "</span>" +
        (pnl != null ? '<span class="' + (pnl > 0 ? "up" : pnl < 0 ? "down" : "") + '">' + (pnl >= 0 ? "+" : "−") + fmtMoney(Math.abs(pnl)) + " · " + fmtPct(chg) + "</span>" : "");
    }
  }

  /* ---------- Coin ---------- */
  var coin = null;
  var poolCache = {};

  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }

  function resolvePool(chain, mint, pool) {
    if (pool) return Promise.resolve(pool);
    var key = chain + ":" + mint;
    if (poolCache[key]) return poolCache[key];
    poolCache[key] = fetchJson(GT + encodeURIComponent(chain) + "/tokens/" + encodeURIComponent(mint) + "/pools?page=1")
      .then(function (j) {
        var rows = (j && j.data) || [];
        var best = null, bestLiq = -1;
        rows.forEach(function (r) {
          var a = r && r.attributes; if (!a) return;
          var liq = Number(a.reserve_in_usd) || 0;
          if (liq > bestLiq) { bestLiq = liq; best = a.address; }
        });
        return best;
      }).catch(function () { delete poolCache[key]; return null; });
    return poolCache[key];
  }

  function coinStop() {
    if (coin && coin.timer) clearInterval(coin.timer);
    if (coin) coin.timer = null;
  }

  function coinDestroy() {
    coinStop();
    if (coin && coin.chart) { try { coin.chart.remove(); } catch (e) { /* ignore */ } }
    coin = null;
  }

  /* opts: { mint, chain, pool, trades, samples, mode, onStatus(text) } */
  function coinChart(host, opts) {
    if (!ok() || !host || !opts || !opts.mint) return false;
    if (coin && coin.mint === opts.mint && coin.host === host && host.contains(coin.box)) {
      var refocus = opts.focusKey && opts.focusKey !== coin.opts.focusKey;
      coin.opts = opts;
      if (!coin.timer) startTimer();
      applyMarkers();
      if (refocus) focusRange(coin);
      return true;
    }
    coinDestroy();
    host.innerHTML = "";
    var box = document.createElement("div");
    box.className = "dx-box";
    host.appendChild(box);
    var chart = baseChart(box, fmtPrice);
    coin = { mint: opts.mint, host: host, box: box, chart: chart, legend: legendEl(box), opts: opts, tf: coin && coin.tf || "5m", bars: [], source: "" };
    coin.tf = root.localStorage && localStorage.getItem("buddy.coinTf") || "5m";
    if (!COIN_TF[coin.tf]) coin.tf = "5m";
    coin.candle = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineStyle: 2 });
    coin.vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    coin.candle.applyOptions({ priceFormat: { type: "custom", formatter: fmtPrice, minMove: 1e-12 } });
    chart.subscribeCrosshairMove(function (param) {
      if (!coin) return;
      var d = param && param.time != null && param.seriesData ? param.seriesData.get(coin.candle) : null;
      coin.legend.innerHTML = legendFor(d || coin.bars[coin.bars.length - 1]);
    });
    load(true);
    startTimer();
    return true;

    function startTimer() {
      coinStop();
      coin.timer = setInterval(function () {
        if (document.hidden) return;
        load(false);
      }, 30000);
    }
  }

  function legendFor(d) {
    if (!coin || !d) return "";
    var first = coin.bars.length ? coin.bars[0].open : null;
    var bar = null;
    for (var i = 0; i < coin.bars.length; i++) if (coin.bars[i].time === d.time) { bar = coin.bars[i]; break; }
    var extra = bar && bar.volume != null && coin.source === "gt" ? '<span><i>V</i>' + fmtVol(bar.volume) + "</span>" : "";
    var fills = (coin.markers || []).filter(function (m) { return m.time === d.time; });
    fills.forEach(function (m) {
      extra += '<span class="dx-fill ' + (m.fill.side === "buy" ? "up" : "down") + '">' + esc(fillText(m.fill)) + "</span>";
    });
    if (d.open == null) return '<span class="dx-time">' + localTime(d.time, true) + "</span><span>" + fmtPrice(d.value) + "</span>" + extra;
    return ohlcLegend(d, first, fmtPrice, extra);
  }

  function applyMarkers() {
    if (!coin || !coin.candle) return;
    var tf = COIN_TF[coin.tf];
    var gt = coin.source === "gt";
    var sec = gt ? tf.sec : 0;
    var marks = fillMarkers(coin.opts.trades, coin.mint, sec, coin.opts.mode);
    var bars = coin.bars;
    var first = bars.length ? bars[0].time : null;
    var last = bars.length ? bars[bars.length - 1].time : null;
    var outside = 0;
    marks = marks.filter(function (m) {
      // Snap each fill to the candle that contains it (GeckoTerminal skips minutes with no trades).
      if (first == null || m.fill.ts < first) { outside += 1; return false; }
      if (gt && m.fill.ts >= last + sec * 2 && m.fill.ts > last + 120) { outside += 1; return false; }
      var near = first;
      for (var i = 0; i < bars.length; i++) { if (bars[i].time <= m.fill.ts) near = bars[i].time; else break; }
      m.time = near;
      return true;
    });
    coin.markers = marks;
    coin.outside = outside;
    var series = gt ? coin.candle : coin.line || coin.candle;
    try {
      series.setMarkers(marks.map(function (m) { return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text, size: 1.4 }; }));
    } catch (e) { /* ignore */ }
    // Entry / exit price lines for the trade in focus (or the newest one on this coin).
    (coin.plines || []).forEach(function (pl) { try { pl.s.removePriceLine(pl.l); } catch (e) { /* ignore */ } });
    coin.plines = [];
    var list = coinTrades(coin.opts.trades, coin.mint, coin.opts.mode);
    var focus = null;
    for (var k = 0; k < list.length; k++) if (list[k].key === coin.opts.focusKey) focus = list[k];
    focus = focus || list[0];
    if (focus && series.createPriceLine) {
      var live = coin.opts.live || null;
      focus.buys.forEach(function (b, n) {
        var title = "Buy $" + fmtPrice(b.price);
        if (focus.open && n === 0 && live && live.pnl != null) title += " · " + fmtSigned(live.pnl) + " now";
        coin.plines.push({ s: series, l: series.createPriceLine({ price: b.price, color: UP, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: title }) });
      });
      focus.sells.forEach(function (f) {
        var t2 = "Sell " + (f.pnl != null ? fmtSigned(f.pnl) : "$" + fmtPrice(f.price));
        coin.plines.push({ s: series, l: series.createPriceLine({ price: f.price, color: DOWN, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t2 }) });
      });
    }
  }

  /* Zoom the time axis to the trade window (buy → sell, or buy → now), padded, on any timeframe. */
  function focusRange(me) {
    var f = me.opts.focus;
    var bars = me.bars;
    if (!f || !f.from || !bars.length) return false;
    var to = f.to || Date.now() / 1000;
    var iFrom = -1, iTo = -1;
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].time <= f.from) iFrom = i;
      if (bars[i].time <= to) iTo = i;
    }
    if (iTo < 0) return false;
    if (iFrom < 0) iFrom = 0;
    var w = (me.box && me.box.clientWidth) || 360;
    var maxShow = Math.max(24, Math.min(160, Math.floor((w - 70) / 7)));
    var span = iTo - iFrom + 1;
    var pad = Math.max(6, Math.round(span * 0.6));
    var from = iFrom - pad, toI = iTo + pad;
    if (toI - from < 30) { var extra = Math.ceil((30 - (toI - from)) / 2); from -= extra; toI += extra; }
    if (toI - from > maxShow && span < maxShow) { var mid = (iFrom + iTo) / 2; from = mid - maxShow / 2; toI = mid + maxShow / 2; }
    me.chart.timeScale().setVisibleLogicalRange({ from: from, to: Math.min(toI, bars.length + 3) });
    return true;
  }

  function status(t) { if (coin && coin.opts.onStatus) coin.opts.onStatus(t, coin.source); }

  function useSamples() {
    // Known real prices only: desk quote samples + the recorded fill prices. No made-up candles.
    var s = (coin.opts.samples || []).filter(function (r) { return r && r.ts && r.price; });
    fillMarkers(coin.opts.trades, coin.mint, 0, coin.opts.mode).forEach(function (m) { s.push({ ts: m.fill.ts, price: m.fill.price }); });
    if (coin.opts.quote && coin.opts.quote.price) s.push({ ts: coin.opts.quote.ts || Date.now() / 1000, price: coin.opts.quote.price });
    if (s.length < 2) { coin.bars = []; coin.candle.setData([]); coin.vol.setData([]); status("No chart data for this coin yet."); return; }
    var seen = {};
    var pts = s.map(function (r) { return { time: Math.floor(r.ts), value: r.price }; }).filter(function (p) {
      if (seen[p.time]) return false; seen[p.time] = 1; return true;
    }).sort(function (a, b) { return a.time - b.time; });
    coin.candle.setData([]);
    coin.vol.setData([]);
    if (!coin.line) {
      coin.line = coin.chart.addAreaSeries({ lineColor: PURPLE, topColor: PURPLE + "55", bottomColor: PURPLE + "00", lineWidth: 2, priceLineStyle: 2 });
      coin.line.applyOptions({ priceFormat: { type: "custom", formatter: fmtPrice, minMove: 1e-12 } });
    }
    coin.line.setData(pts);
    coin.bars = pts.map(function (p) { return { time: p.time, value: p.value }; });
    coin.source = "samples";
    applyMarkers();
    coin.chart.timeScale().fitContent();
    status("Known prices only (desk quotes + fills) · no market candles for this coin yet");
    coin.legend.innerHTML = legendFor(coin.bars[coin.bars.length - 1]);

  }

  var ohlcCache = {};
  function getOhlcv(chain, pool, tf, maxAgeMs) {
    var key = chain + "|" + pool + "|" + tf.path + tf.agg;
    var hit = ohlcCache[key];
    if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.json);
    var url = GT + encodeURIComponent(chain) + "/pools/" + encodeURIComponent(pool) + "/ohlcv/" + tf.path +
      "?aggregate=" + tf.agg + "&limit=300&currency=usd&token=base";
    var once = function () { return fetchJson(url); };
    // GeckoTerminal's free API is rate limited; retry once before giving up.
    return once().catch(function () { return new Promise(function (r) { setTimeout(r, 2500); }).then(once); })
      .then(function (json) { ohlcCache[key] = { at: Date.now(), json: json }; return json; });
  }

  function load(fit) {
    if (!coin) return;
    var me = coin;
    var tfKey = me.tf;
    var tf = COIN_TF[me.tf];
    var chain = me.opts.chain || "solana";
    if (fit) status("Loading " + tfKey + " candles…");
    resolvePool(chain, me.mint, me.opts.pool).then(function (pool) {
      if (coin !== me) return null;
      if (!pool) throw new Error("no pool");
      me.pool = pool;
      return getOhlcv(chain, pool, tf, fit ? 25000 : 0);
    }).then(function (j) {
      if (coin !== me || j == null || me.tf !== tfKey) return; // a newer timeframe was picked meanwhile
      var bars = parseOhlcv(j);
      if (!bars.length) throw new Error("empty");
      if (me.line) { me.chart.removeSeries(me.line); me.line = null; }
      me.source = "gt";
      me.barsTf = tfKey;
      me.bars = bars;
      me.candle.setData(bars.map(function (b) { return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }; }));
      me.vol.setData(bars.map(function (b) {
        return { time: b.time, value: b.volume || 0, color: b.close >= b.open ? "rgba(48,209,88,0.35)" : "rgba(255,69,58,0.35)" };
      }));
      applyMarkers();
      if (fit && !focusRange(me)) {
        var n = bars.length;
        var w = (me.box && me.box.clientWidth) || 360;
        var show = Math.max(24, Math.min(160, Math.floor((w - 70) / 7)));
        me.chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 3 });
      }
      me.legend.innerHTML = legendFor(bars[bars.length - 1]);
      status("Market candles · GeckoTerminal · " + me.tf + " · refresh 30s" +
        (me.outside ? " · " + me.outside + " fill" + (me.outside > 1 ? "s" : "") + " outside these candles" : ""));
    }).catch(function () {
      if (coin !== me || me.tf !== tfKey) return;
      if (me.source === "gt" && me.barsTf && me.barsTf !== tfKey) {
        // Keep showing the candles we have, and say so — never label old candles with the new timeframe.
        me.tf = me.barsTf;
        status("GeckoTerminal is busy — " + tfKey + " candles didn't load, still showing " + me.barsTf + ". Try again in a moment.");
        return;
      }
      if (me.source !== "gt") useSamples();
    });
  }

  function setCoinTf(tf) {
    if (!COIN_TF[tf] || !coin) return;
    coin.tf = tf;
    try { localStorage.setItem("buddy.coinTf", tf); } catch (e) { /* ignore */ }
    coin.source = coin.source === "gt" ? "gt" : coin.source;
    load(true);
  }
  function coinTf() { return coin ? coin.tf : ((root.localStorage && localStorage.getItem("buddy.coinTf")) || "5m"); }
  function coinPool() { return coin ? coin.pool || null : null; }

  root.BuddyChart = {
    ok: ok,
    EQ_BUCKET: EQ_BUCKET,
    COIN_TF: COIN_TF,
    equityCandles: equityCandles,
    fillMarkers: fillMarkers,
    parseOhlcv: parseOhlcv,
    fmtPrice: fmtPrice,
    dexUrl: dexUrl,
    equity: equity,
    coinChart: coinChart,
    coinStop: coinStop,
    coinDestroy: coinDestroy,
    setCoinTf: setCoinTf,
    coinTf: coinTf,
    coinPool: coinPool,
    coinTrades: coinTrades,
    coinDebug: function () {
      if (!coin) return null;
      var vr = null;
      try { vr = coin.chart.timeScale().getVisibleRange(); } catch (e) { /* ignore */ }
      return { source: coin.source, tf: coin.tf, bars: coin.bars.length, outside: coin.outside || 0, visible: vr,
        markers: (coin.markers || []).map(function (m) { return { side: m.fill.side, ts: Math.round(m.fill.ts), bar: m.time, price: m.fill.price }; }),
        lines: (coin.plines || []).length };
    },
    tradeListHtml: tradeListHtml,
    fillText: fillText,
    reasonLabel: reasonLabel,
    focusTrade: function (from, to, key) {
      if (!coin) return;
      coin.opts = Object.assign({}, coin.opts, { focus: { from: from, to: to }, focusKey: key });
      applyMarkers();
      focusRange(coin);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
