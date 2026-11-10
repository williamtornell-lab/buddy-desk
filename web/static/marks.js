/* Read-only mark math for open holdings.
   Prices are USD. A missing number stays null. It is never treated as zero.
   DexScreener's public token route caches for 30s and sends no trade time. */
(function (root) {
  var POLL_S = 30;
  var CACHE_MAX_AGE_S = 30;
  var STALE_AFTER_S = 90;
  var MAX_SAMPLES = 180;

  function finite(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function positive(v) {
    var n = finite(v);
    return n != null && n > 0 ? n : null;
  }

  function unix(ts) {
    if (ts == null || ts === "") return null;
    if (typeof ts === "number" && Number.isFinite(ts)) return ts > 1e12 ? ts / 1000 : ts;
    var raw = String(ts).trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      var n = Number(raw);
      return n > 1e12 ? n / 1000 : n;
    }
    var parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }

  function isWallet(raw) {
    var src = String((raw && (raw.source || raw.mode)) || "").toUpperCase();
    return src === "FOMO" || src === "WALLET" || src === "REAL";
  }

  function pickPair(pairs, mint, preferredPair) {
    var rows = [];
    var i;
    for (i = 0; i < (pairs || []).length; i++) {
      var pair = pairs[i];
      var addr = pair && pair.baseToken && pair.baseToken.address;
      if (addr !== mint) continue;
      if (positive(pair.priceUsd) == null) continue;
      rows.push(pair);
    }
    if (!rows.length) return null;
    if (preferredPair) {
      var want = String(preferredPair).toLowerCase();
      for (i = 0; i < rows.length; i++) {
        if (String(rows[i].pairAddress || "").toLowerCase() === want) return rows[i];
      }
    }
    rows.sort(function (a, b) {
      var la = Number(a.liquidity && a.liquidity.usd) || 0;
      var lb = Number(b.liquidity && b.liquidity.usd) || 0;
      return lb - la;
    });
    return rows[0];
  }

  function quoteFromPair(pair, mint, times) {
    if (!pair || !pair.baseToken || pair.baseToken.address !== mint) return null;
    var price = positive(pair.priceUsd);
    if (price == null) return null;
    return {
      mint: mint,
      price: price,
      pair: pair.pairAddress || null,
      dex: pair.dexId || null,
      requestedAt: unix(times && times.requestedAt),
      receivedAt: unix(times && times.receivedAt),
      quoteAsOf: null,
      quoteClock: "unverified",
      source: "dexscreener_tokens_v1",
      cacheMaxAgeS: CACHE_MAX_AGE_S,
      pollS: POLL_S,
      realtime: false
    };
  }

  function pushSample(out, ts, price, kind) {
    var t = unix(ts);
    var p = positive(price);
    if (t == null || p == null) return;
    var prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.ts === t && prev.price === p && prev.kind === kind) return;
    out.push({ ts: t, price: p, kind: kind });
  }

  function buildSamples(hostSamples, sessionSamples, anchor) {
    var out = [];
    if (anchor && anchor.price && anchor.ts) {
      pushSample(out, anchor.ts, anchor.price, anchor.kind || "entry");
    }
    var lists = [hostSamples, sessionSamples];
    var n, i, row, ts;
    for (n = 0; n < lists.length; n++) {
      var list = lists[n] || [];
      for (i = 0; i < list.length; i++) {
        row = list[i] || {};
        ts = unix(row.ts);
        if (anchor && anchor.ts && ts != null && ts + 1 < anchor.ts) continue;
        pushSample(out, ts, row.price, row.kind || "quote");
      }
    }
    out.sort(function (a, b) { return a.ts - b.ts; });
    if (out.length > MAX_SAMPLES) {
      var anchorRow = null;
      if (anchor && anchor.ts) {
        for (i = 0; i < out.length; i++) {
          if (out[i].kind !== "quote" && out[i].ts === unix(anchor.ts)) {
            anchorRow = out[i];
            break;
          }
        }
      }
      out = out.slice(out.length - MAX_SAMPLES);
      if (anchorRow && out.indexOf(anchorRow) < 0) {
        out.unshift(anchorRow);
        if (out.length > MAX_SAMPLES) out.pop();
      }
    }
    return out;
  }

  function positionMark(raw, liveQuote, now, sessionSamples) {
    raw = raw || {};
    var nowTs = unix(now);
    if (nowTs == null) nowTs = Date.now() / 1000;
    var wallet = isWallet(raw);
    var average = positive(raw.avg_entry);
    var original = positive(raw.entry != null ? raw.entry : raw.entry_price);
    var entry = average || original;
    var entryKind = "unknown";
    if (average) entryKind = "weighted_average";
    else if (original && !wallet) entryKind = "paper_entry";
    else if (original) entryKind = "entry";
    var openedAt = unix(raw.opened_at || raw.opened || raw.opened_ts);

    var price = null;
    var receivedAt = null;
    var requestedAt = null;
    var pair = null;
    var dex = null;
    var source = null;
    var quoteAsOf = null;
    var quoteClock = "unverified";
    var pollS = POLL_S;
    if (liveQuote && liveQuote.mint === raw.mint && positive(liveQuote.price)) {
      price = liveQuote.price;
      receivedAt = unix(liveQuote.receivedAt);
      requestedAt = unix(liveQuote.requestedAt);
      pair = liveQuote.pair || null;
      dex = liveQuote.dex || null;
      source = liveQuote.source || "dexscreener_tokens_v1";
      quoteAsOf = null;
      quoteClock = "unverified";
    } else {
      var stored = positive(raw.mark_price != null ? raw.mark_price : raw.mark);
      if (stored) {
        price = stored;
        receivedAt = unix(raw.mark_fetched_at);
        source = raw.mark_source || "desk_state";
        pair = raw.mark_pair || null;
        quoteAsOf = unix(raw.quote_as_of);
        quoteClock = raw.quote_clock || "unverified";
        pollS = null;
      }
    }

    var ageS = receivedAt == null ? null : Math.max(0, nowTs - receivedAt);
    var demo = !!(raw.demo);
    var stale = !demo && (price == null || ageS == null || ageS > STALE_AFTER_S);

    var storedQty = positive(raw.qty);
    var size = finite(raw.size_usd != null ? raw.size_usd : raw.size);
    var quantity = null;
    var quantityKind = "unknown";
    if (storedQty) {
      quantity = storedQty;
      quantityKind = "stored";
    } else if (entry && size != null && size > 0) {
      quantity = size / entry;
      quantityKind = "estimated_from_ticket";
    }

    var value = quantity != null && price != null ? quantity * price : null;
    var invested = positive(raw.invested_usd);
    var cost = null;
    var basis = "unknown";
    if (invested) {
      cost = invested;
      basis = "invested_including_fees";
    } else if (size != null && size > 0 && entry) {
      cost = size;
      basis = "gross_ticket";
    }
    var unrealized = null;
    var unrealizedKind = "unknown";
    if (value != null && cost != null) {
      unrealized = value - cost;
      unrealizedKind = basis === "invested_including_fees" ? "net_of_entry_fees" : "gross_entry_fee_unknown";
    }
    var pct = entry && price ? (price / entry - 1) * 100 : null;
    var walletUsd = wallet && !entry && size != null && size > 0 ? size : null;
    var seen = (sessionSamples || []).slice();
    if (price != null && receivedAt != null) seen.push({ ts: receivedAt, price: price, kind: "quote" });
    var samples = buildSamples(raw.mark_samples, seen, entry && openedAt ? {
      ts: openedAt,
      price: original || entry,
      kind: entryKind
    } : null);

    return {
      mint: raw.mint || "",
      entry: entry,
      originalEntry: original,
      entryKind: entryKind,
      openedAt: openedAt,
      price: price,
      pair: pair,
      dex: dex,
      source: source,
      requestedAt: requestedAt,
      receivedAt: receivedAt,
      quoteAsOf: quoteAsOf,
      quoteClock: quoteClock,
      ageS: ageS,
      stale: stale,
      demo: demo,
      pollS: pollS,
      cacheMaxAgeS: CACHE_MAX_AGE_S,
      realtime: false,
      quantity: quantity,
      quantityKind: quantityKind,
      value: value,
      cost: cost,
      basis: basis,
      unrealized: unrealized,
      unrealizedKind: unrealizedKind,
      pct: pct,
      walletUsd: walletUsd,
      samples: samples
    };
  }

  function chartSvg(samples) {
    if (!samples || samples.length < 2) return "";
    var w = 320;
    var h = 112;
    var pad = 8;
    var minX = samples[0].ts;
    var maxX = samples[0].ts;
    var minY = samples[0].price;
    var maxY = samples[0].price;
    var i;
    for (i = 1; i < samples.length; i++) {
      if (samples[i].ts < minX) minX = samples[i].ts;
      if (samples[i].ts > maxX) maxX = samples[i].ts;
      if (samples[i].price < minY) minY = samples[i].price;
      if (samples[i].price > maxY) maxY = samples[i].price;
    }
    var spanX = maxX - minX || 1;
    var spanY = maxY - minY || (maxY * 0.01) || 1;
    var parts = [];
    for (i = 0; i < samples.length; i++) {
      var x = pad + ((samples[i].ts - minX) / spanX) * (w - pad * 2);
      var y = pad + (1 - (samples[i].price - minY) / spanY) * (h - pad * 2);
      parts.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="112" role="img" aria-label="Entry and recorded quotes">' +
      '<polyline points="' + parts.join(" ") + '" fill="none" stroke="#8B5CF6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      "</svg>";
  }

  root.BuddyMarks = {
    POLL_S: POLL_S,
    CACHE_MAX_AGE_S: CACHE_MAX_AGE_S,
    STALE_AFTER_S: STALE_AFTER_S,
    MAX_SAMPLES: MAX_SAMPLES,
    pickPair: pickPair,
    quoteFromPair: quoteFromPair,
    buildSamples: buildSamples,
    positionMark: positionMark,
    chartSvg: chartSvg
  };
})(typeof window !== "undefined" ? window : globalThis);
