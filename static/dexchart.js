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
          out.push({ ts: ft, price: fp, side: side, usd: finite(f.usd || f.size_usd) });
        });
        return;
      }
      var ot = unix(t.opened_at), op = finite(t.entry != null ? t.entry : t.entry_price);
      if (ot != null && op != null && op > 0) out.push({ ts: ot, price: op, side: "buy", usd: finite(t.size_usd) });
      var ct = unix(t.closed_at), cp = finite(t.exit != null ? t.exit : t.exit_price);
      if (!t.open && ct != null && cp != null && cp > 0) out.push({ ts: ct, price: cp, side: "sell", usd: null });
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out.map(function (f) {
      var bar = bucketSec ? Math.floor(f.ts / bucketSec) * bucketSec : Math.floor(f.ts);
      return {
        time: bar,
        position: f.side === "buy" ? "belowBar" : "aboveBar",
        color: f.side === "buy" ? UP : DOWN,
        shape: f.side === "buy" ? "arrowUp" : "arrowDown",
        text: (f.side === "buy" ? "B " : "S ") + fmtPrice(f.price),
        fill: f
      };
    });
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
      coin.opts = opts;
      if (!coin.timer) startTimer();
      applyMarkers();
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
      extra += '<span class="' + (m.fill.side === "buy" ? "up" : "down") + '">' + (m.fill.side === "buy" ? "Bought " : "Sold ") +
        fmtPrice(m.fill.price) + " · " + localTime(m.fill.ts, false) + "</span>";
    });
    if (d.open == null) return '<span class="dx-time">' + localTime(d.time, true) + "</span><span>" + fmtPrice(d.value) + "</span>" + extra;
    return ohlcLegend(d, first, fmtPrice, extra);
  }

  function applyMarkers() {
    if (!coin || !coin.candle) return;
    var tf = COIN_TF[coin.tf];
    var marks = fillMarkers(coin.opts.trades, coin.mint, coin.source === "gt" ? tf.sec : 0, coin.opts.mode);
    var times = {};
    coin.bars.forEach(function (b) { times[b.time] = 1; });
    var first = coin.bars.length ? coin.bars[0].time : null;
    marks = marks.filter(function (m) { return first != null && m.time >= first; }).map(function (m) {
      if (times[m.time]) return m;
      var near = null;
      for (var i = 0; i < coin.bars.length; i++) { if (coin.bars[i].time <= m.time) near = coin.bars[i].time; else break; }
      if (near != null) m.time = near;
      return m;
    });
    coin.markers = marks;
    var series = coin.source === "gt" ? coin.candle : coin.line || coin.candle;
    try { series.setMarkers(marks.map(function (m) { return { time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text }; })); } catch (e) { /* ignore */ }
  }

  function status(t) { if (coin && coin.opts.onStatus) coin.opts.onStatus(t, coin.source); }

  function useSamples() {
    var s = (coin.opts.samples || []).filter(function (r) { return r && r.ts && r.price; });
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
    coin.legend.innerHTML = legendFor(coin.bars[coin.bars.length - 1]);
    status("Desk quotes · market candles unavailable right now");
  }

  function load(fit) {
    if (!coin) return;
    var me = coin;
    var tf = COIN_TF[me.tf];
    var chain = me.opts.chain || "solana";
    resolvePool(chain, me.mint, me.opts.pool).then(function (pool) {
      if (coin !== me) return null;
      if (!pool) throw new Error("no pool");
      me.pool = pool;
      return fetchJson(GT + encodeURIComponent(chain) + "/pools/" + encodeURIComponent(pool) + "/ohlcv/" + tf.path +
        "?aggregate=" + tf.agg + "&limit=300&currency=usd&token=base");
    }).then(function (j) {
      if (coin !== me || j == null) return;
      var bars = parseOhlcv(j);
      if (!bars.length) throw new Error("empty");
      if (me.line) { me.chart.removeSeries(me.line); me.line = null; }
      me.source = "gt";
      me.bars = bars;
      me.candle.setData(bars.map(function (b) { return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }; }));
      me.vol.setData(bars.map(function (b) {
        return { time: b.time, value: b.volume || 0, color: b.close >= b.open ? "rgba(48,209,88,0.35)" : "rgba(255,69,58,0.35)" };
      }));
      applyMarkers();
      if (fit) {
        var n = bars.length;
        var w = (me.box && me.box.clientWidth) || 360;
        var show = Math.max(24, Math.min(160, Math.floor((w - 70) / 7)));
        me.chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 3 });
      }
      me.legend.innerHTML = legendFor(bars[bars.length - 1]);
      status("Market candles · GeckoTerminal · " + me.tf + " · refresh 30s");
    }).catch(function () {
      if (coin !== me) return;
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
    coinPool: coinPool
  };
})(typeof window !== "undefined" ? window : globalThis);
