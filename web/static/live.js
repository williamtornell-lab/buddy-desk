/* Buddy live channel: 1s desk snapshots when a trade is open (else 5s) over MQTT/WebSocket (port 443, free public broker).
   The desk encrypts each snapshot (AES-256-GCM); topic + key are derived from the private
   desk id in the link, so the broker only relays opaque bytes.
   Commands: the app also publishes encrypted commands on a separate cmd topic (same key). */
(function (root) {
  "use strict";
  var BROKER = "wss://public.cloud.shiftr.io";
  var ENC = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var DEC = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  var st = {
    ws: null, snap: null, lastAt: 0, connected: false, retry: 1500, timer: null, ping: null,
    id: "", hooks: {}, topic: "", cmdTopic: "", key: null, pendingAcks: {}, buf: new Uint8Array(0), useProto: true, gotConnack: false
  };
  /* iOS Safari often rejects the MQTT WebSocket subprotocol and/or delivers
     binary frames as Blob even when binaryType=arraybuffer. Prefer no
     subprotocol on WebKit and always ingest Blob/ArrayBuffer safely. */
  try {
    var ua = String(root.navigator && navigator.userAgent || "");
    var isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var isWebKit = /WebKit/.test(ua) && !/Chrome|CriOS|Chromium|Edg|OPR|FxiOS|Android/.test(ua);
    if (isIOS || isWebKit) st.useProto = false;
  } catch (eUa) {}


  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function sha(text) { return root.crypto.subtle.digest("SHA-256", ENC.encode(text)); }

  function mqttLen(n) { var out = []; do { var b = n % 128; n = Math.floor(n / 128); out.push(n ? b | 128 : b); } while (n); return out; }
  function mqttStr(s) { var b = ENC.encode(s); return [b.length >> 8, b.length & 255].concat(Array.prototype.slice.call(b)); }
  function pkt(type, body) { return new Uint8Array([type].concat(mqttLen(body.length), body)); }
  function connectPkt() {
    var cid = "buddy-app-" + Math.random().toString(16).slice(2, 10);
    // keepalive 60s; browser also pings every 20s via st.ping interval
    var body = mqttStr("MQTT").concat([4, 0x02 | 0x80 | 0x40, 0, 60], mqttStr(cid), mqttStr("public"), mqttStr("public"));
    return pkt(0x10, body);
  }
  function subscribePkt(topic) { return pkt(0x82, [0, 1].concat(mqttStr(topic), [0])); }
  function publishPkt(topic, payloadU8, qos, pid) {
    var t = mqttStr(topic);
    var body = t.slice();
    if (qos) body = body.concat([(pid >> 8) & 255, pid & 255]);
    body = body.concat(Array.prototype.slice.call(payloadU8));
    return pkt(0x30 | (qos ? 0x02 : 0), body);
  }

  /* Buffer bytes across WebSocket frames. A 35KB retained PUBLISH is often split
     on iOS Safari / mobile networks; parsing each frame alone silently fails decrypt
     and leaves the app on the cached GitHub state.json fallback. */
  function parseBuf(cb) {
    var buf = st.buf;
    if (!buf || !buf.length) return;
    var i = 0;
    while (i < buf.length) {
      if (i + 2 > buf.length) break;
      var j = i + 1, mult = 1, n = 0, b, lenBytes = 0, ok = false;
      while (j < buf.length && lenBytes < 4) {
        b = buf[j++];
        n += (b & 127) * mult;
        mult *= 128;
        lenBytes++;
        if ((b & 128) === 0) { ok = true; break; }
      }
      if (!ok) break;
      if (j + n > buf.length) break;
      var body = buf.subarray(j, j + n);
      var copy = new Uint8Array(body.length);
      copy.set(body);
      cb(buf[i] >> 4, buf[i] & 15, copy);
      i = j + n;
    }
    st.buf = i > 0 ? buf.subarray(i) : buf;
    if (st.buf.length > 2 * 1024 * 1024) st.buf = new Uint8Array(0);
  }

  function pushBytes(u8, cb) {
    if (!u8 || !u8.length) return;
    var buf = st.buf || new Uint8Array(0);
    var n = new Uint8Array(buf.length + u8.length);
    n.set(buf, 0);
    n.set(u8, buf.length);
    st.buf = n;
    parseBuf(cb);
  }

  function status() {
    var fresh = st.snap && (Date.now() / 1000 - st.lastAt) < 25;
    return fresh ? "live" : (st.id ? "fallback" : "off");
  }
  function emitStatus() { if (st.hooks.onStatus) st.hooks.onStatus(status()); }

  function noteAck(snap) {
    var ack = snap && snap.cmd_ack;
    if (!ack || !ack.cid) return;
    var pend = st.pendingAcks[ack.cid];
    if (!pend) return;
    delete st.pendingAcks[ack.cid];
    if (typeof pend._resolveWait === "function") {
      try { pend._resolveWait(ack); } catch (e) { /* ignore */ }
    }
    if (st.hooks.onAck) st.hooks.onAck(ack, pend);
  }


  function ingestWsData(data, cb) {
    if (data == null) return;
    if (data instanceof ArrayBuffer) { pushBytes(new Uint8Array(data), cb); return; }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.arrayBuffer) {
        data.arrayBuffer().then(function (ab) { pushBytes(new Uint8Array(ab), cb); }).catch(function () {
          var fr = new FileReader();
          fr.onload = function () { if (fr.result) pushBytes(new Uint8Array(fr.result), cb); };
          try { fr.readAsArrayBuffer(data); } catch (eR) {}
        });
      } else {
        var fr2 = new FileReader();
        fr2.onload = function () { if (fr2.result) pushBytes(new Uint8Array(fr2.result), cb); };
        try { fr2.readAsArrayBuffer(data); } catch (eR2) {}
      }
      return;
    }
    if (data && data.buffer && typeof data.byteLength === "number") {
      pushBytes(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength), cb);
      return;
    }
    if (typeof data === "string") pushBytes(ENC.encode(data), cb);
  }

  async function open(id) {
    if (!root.crypto || !root.crypto.subtle || !ENC || !root.WebSocket) { emitStatus(); return; }
    var topic = "bdy/" + hex(await sha("buddy-live-topic|" + id)).slice(0, 32);
    var cmdTopic = "bdy/" + hex(await sha("buddy-cmd-topic|" + id)).slice(0, 32);
    var rawKey = await sha("buddy-live-key|" + id);
    var key = await root.crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    st.topic = topic;
    st.cmdTopic = cmdTopic;
    st.key = key;
    st.buf = new Uint8Array(0);
    st.gotConnack = false;
    var ws;
    try {
      ws = st.useProto ? new WebSocket(BROKER, ["mqtt"]) : new WebSocket(BROKER);
    } catch (e) {
      if (st.useProto) {
        try { ws = new WebSocket(BROKER); st.useProto = false; } catch (e2) { return later(id); }
      } else {
        return later(id);
      }
    }
    ws.binaryType = "arraybuffer";
    st.ws = ws;
    ws.onopen = function () { ws.send(connectPkt()); };
    ws.onmessage = function (ev) {
      ingestWsData(ev.data, function (type, flags, body) {
        if (type === 2) { // CONNACK
          if (body[1] !== 0) { ws.close(); return; }
          st.gotConnack = true;
          st.connected = true;
          st.retry = 1500;
          ws.send(subscribePkt(topic));
          clearInterval(st.ping);
          st.ping = setInterval(function () { try { ws.send(new Uint8Array([0xc0, 0])); } catch (e) { /* ignore */ } }, 20000);
          return;
        }
        if (type === 4) { // PUBACK
          if (body.length >= 2) {
            var paid = (body[0] << 8) | body[1];
            var pr = st._pubacks && st._pubacks[paid];
            if (pr) { delete st._pubacks[paid]; try { pr(true); } catch (e) {} }
          }
          return;
        }
        if (type !== 3) return;
        var tl = (body[0] << 8) | body[1];
        var off = 2 + tl + (((flags >> 1) & 3) ? 2 : 0);
        var payload = body.subarray(off);
        if (payload.length < 30 || payload[0] !== 66 || payload[1] !== 49) return; // "B1"
        root.crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(2, 14) }, key, payload.slice(14)).then(function (plain) {
          var snap = JSON.parse(DEC.decode(plain));
          if (!snap || !snap.ts) return;
          if (st.snap && snap.ts <= st.snap.ts) {
            // Still surface newer acks even if ts didn't advance somehow.
            noteAck(snap);
            return;
          }
          st.snap = snap;
          // A retained message can be old (desk down): only count it as live when recent.
          st.lastAt = Math.min(Date.now() / 1000, snap.ts);
          noteAck(snap);
          if (st.hooks.onSnap) st.hooks.onSnap(snap);
          emitStatus();
        }).catch(function () { /* wrong key / corrupt: ignore */ });
      });
    };
    ws.onclose = function () {
      st.connected = false;
      clearInterval(st.ping);
      // iOS Safari sometimes rejects the "mqtt" subprotocol; retry once without it.
      if (!st.gotConnack && st.useProto) {
        st.useProto = false;
        st.retry = 400;
      }
      emitStatus();
      later(id);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  function later(id) {
    clearTimeout(st.timer);
    st.timer = setTimeout(function () { if (st.id === id) open(id); }, st.retry);
    st.retry = Math.min(15000, st.retry * 2);
  }

  function start(id, hooks) {
    if (!id || st.id === id) return;
    stop();
    st.id = id;
    st.hooks = hooks || {};
    open(id);
    setInterval(emitStatus, 5000);
    if (!st._visHook) {
      st._visHook = true;
      try {
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState !== "visible" || !st.id) return;
          var stale = !st.connected || status() !== "live";
          if (!stale) return;
          try { if (st.ws) st.ws.close(); } catch (eV) {}
        });
      } catch (eH) {}
    }
  }
  function stop() {
    clearTimeout(st.timer);
    clearInterval(st.ping);
    if (st.ws) { st.ws.onclose = null; try { st.ws.close(); } catch (e) { /* ignore */ } }
    st.ws = null; st.snap = null; st.id = ""; st.connected = false; st.key = null;
  }

  function newCid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID().replace(/-/g, "");
    return "c" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  }

  async function sealCmd(cmd, cid) {
    if (!st.key || !ENC) throw new Error("no key");
    var body = ENC.encode(JSON.stringify({ v: 1, cid: cid, ts: Date.now() / 1000, cmd: String(cmd || "") }));
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await root.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, st.key, body));
    var out = new Uint8Array(2 + 12 + ct.length);
    out[0] = 66; out[1] = 49;
    out.set(iv, 2);
    out.set(ct, 14);
    return out;
  }


  function parseOne(u8, cb) {
    var i = 0;
    while (i + 2 <= u8.length) {
      var j = i + 1, mult = 1, n = 0, b, lenBytes = 0, ok = false;
      while (j < u8.length && lenBytes < 4) {
        b = u8[j++];
        n += (b & 127) * mult;
        mult *= 128;
        lenBytes++;
        if ((b & 128) === 0) { ok = true; break; }
      }
      if (!ok || j + n > u8.length) break;
      cb(u8[i] >> 4, u8[i] & 15, u8.subarray(j, j + n));
      i = j + n;
    }
  }

  st._pubPid = 1;
  st._pubacks = {};
  function nextPubPid() {
    var p = st._pubPid;
    st._pubPid = st._pubPid >= 65535 ? 1 : st._pubPid + 1;
    return p;
  }

  async function publishRaw(payloadU8, qos) {
    if (!st.cmdTopic) return false;
    qos = qos ? 1 : 0;
    function sendOn(ws, resolve) {
      try {
        if (!qos) { ws.send(publishPkt(st.cmdTopic, payloadU8, 0, 0)); resolve(true); return; }
        var pid = nextPubPid();
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          delete st._pubacks[pid];
          resolve(true); // broker may still deliver; don't fail the cmd on missing PUBACK
        }, 2500);
        st._pubacks[pid] = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          delete st._pubacks[pid];
          resolve(true);
        };
        ws.send(publishPkt(st.cmdTopic, payloadU8, 1, pid));
      } catch (e) { resolve(false); }
    }
    if (st.ws && st.connected && st.ws.readyState === 1) {
      return await new Promise(function (resolve) { sendOn(st.ws, resolve); });
    }
    // Short-lived publish connection if the live socket is down.
    return await new Promise(function (resolve) {
      var done = false;
      var ws;
      try { ws = new WebSocket(BROKER, ["mqtt"]); } catch (e) { resolve(false); return; }
      ws.binaryType = "arraybuffer";
      var t = setTimeout(function () { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(false); } }, 8000);
      ws.onopen = function () { ws.send(connectPkt()); };
      ws.onmessage = function (ev) {
        var chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data || []);
        parseOne(chunk, function (type, _f, body) {
          if (type === 4 && body.length >= 2) {
            var paid = (body[0] << 8) | body[1];
            var pr = st._pubacks[paid];
            if (pr) pr();
            return;
          }
          if (type !== 2) return;
          if (body[1] !== 0) { if (!done) { done = true; clearTimeout(t); resolve(false); } return; }
          sendOn(ws, function (ok) {
            setTimeout(function () { try { ws.close(); } catch (e) {} }, 400);
            if (!done) { done = true; clearTimeout(t); resolve(!!ok); }
          });
        });
      };
      ws.onerror = function () { if (!done) { done = true; clearTimeout(t); resolve(false); } };
    });
  }

  function waitAck(cid, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var pend = st.pendingAcks[cid] || (st.pendingAcks[cid] = { at: Date.now() });
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve({ ok: false, timedOut: true, cid: cid });
      }, timeoutMs || 5000);
      pend._resolveWait = function (ack) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: true, ack: ack, cid: cid });
      };
    });
  }

  /** Publish an encrypted command. Returns {ok, cid}. Registers pending ack.
   *  Pass opts.cid to reuse an id (retries / ntfy dedupe). */
  async function sendCmd(cmd, meta, opts) {
    if (!st.id) return { ok: false, cid: null };
    opts = opts || {};
    var cid = opts.cid || newCid();
    try {
      var sealed = await sealCmd(cmd, cid);
      var ok = await publishRaw(sealed, 1);
      if (ok) {
        var prev = st.pendingAcks[cid] || {};
        st.pendingAcks[cid] = Object.assign({}, prev, { at: Date.now(), cmd: cmd }, meta || {});
      }
      return { ok: ok, cid: cid };
    } catch (e) {
      return { ok: false, cid: cid };
    }
  }

  /** Publish and wait for cmd_ack; republish the same cid until ack or attempts exhausted. */
  async function sendCmdReliable(cmd, meta, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 5000;
    var attempts = opts.attempts || 4;
    var cid = newCid();
    var last = { ok: false, cid: cid };
    for (var i = 0; i < attempts; i++) {
      last = await sendCmd(cmd, meta, { cid: cid });
      if (!last.cid) last.cid = cid;
      if (last.ok) {
        var waited = await waitAck(cid, timeoutMs);
        if (waited.ok) return { ok: true, cid: cid, ack: waited.ack, attempts: i + 1 };
      } else {
        await new Promise(function (r) { setTimeout(r, 400); });
      }
    }
    return { ok: false, cid: cid, attempts: attempts };
  }

  /* Overlay a live snapshot on the full state.json (pure; returns a new object). */
  function isLiveDesk(s, snap) {
    var m = String((snap && snap.desk_mode) || (s && (s.mode || s.mode_label)) || "").toUpperCase();
    return m === "LIVE" || m === "REAL";
  }

  function applyPipeCounts(out, snap) {
    var pc = snap && snap.pipe_counts;
    if (!pc || typeof pc !== "object") return;
    var dash = (out.dashboard && typeof out.dashboard === "object") ? Object.assign({}, out.dashboard) : {};
    dash.pipe_counts = Object.assign({}, dash.pipe_counts || {}, pc);
    if (pc.pairs != null) dash.scanned = pc.pairs;
    if (pc.killed != null) dash.killed = pc.killed;
    if (pc.buys != null) dash.traded = pc.buys;
    if (pc.kill_pct != null) dash.kill_pct = pc.kill_pct;
    out.dashboard = dash;
  }

  function applyLog(out, snap) {
    if (!Array.isArray(snap && snap.log)) return;
    var dash = (out.dashboard && typeof out.dashboard === "object") ? Object.assign({}, out.dashboard) : {};
    dash.log = snap.log;
    out.dashboard = dash;
  }

  function merge(s, snap) {
    if (!s || !snap || !snap.ts) return s;
    var isDiff = snap.kind === "diff";
    var prevTs = Number(s.live_ts || s.ts) || 0;
    if (!isDiff && prevTs > snap.ts + 1) return s;
    if (isDiff && prevTs > snap.ts) return s;
    var out = Object.assign({}, s);
    var liveMode = isLiveDesk(s, snap);
    if (!liveMode) {
      ["balance", "free", "open_usd"].forEach(function (k) { if (snap[k] != null) out[k] = snap[k]; });
    }
    if (snap.real && typeof snap.real === "object") {
      var prev = (s && s.real && typeof s.real === "object") ? s.real : {};
      out.real = Object.assign({}, prev, snap.real);
      if (!snap.real.equity && prev.equity) out.real.equity = prev.equity;
    }
    ["equity", "real_equity", "paper_equity"].forEach(function (k) {
      var incoming = snap[k];
      var prevEq = s[k];
      if (!Array.isArray(incoming) || !incoming.length) {
        if (Array.isArray(prevEq) && prevEq.length) out[k] = prevEq;
      }
    });
    if (snap.active_mode) out.active_mode = snap.active_mode;
    if (out.modes && snap.active_mode && out.modes[snap.active_mode]) out.active_mode_profile = out.modes[snap.active_mode];
    out.ts = snap.ts;
    out.live_ts = snap.ts;
    if (snap.cmd_ack) out.cmd_ack = snap.cmd_ack;
    if (snap.agents && out.agents && typeof out.agents === "object") {
      var ag = {};
      Object.keys(out.agents).forEach(function (k) { ag[k] = out.agents[k]; });
      Object.keys(snap.agents).forEach(function (k) {
        var hb = Number(snap.agents[k]);
        if (!Number.isFinite(hb)) return;
        ag[k] = Object.assign({}, ag[k] || {}, { heartbeat: hb, age_s: Math.max(0, snap.ts - hb) });
      });
      out.agents = ag;
    }
    var oldPos = Array.isArray(s.positions) ? s.positions : [];
    var isPaper = function (p) { return !/FOMO|REAL|WALLET|LIVE/i.test(String(p.mode || p.source || "PAPER")); };
    if (liveMode) {
      // Paper positions/trades stay off the REAL book. Real rows come from snap.real.
      var realActs = (out.real && Array.isArray(out.real.activity)) ? out.real.activity
        : (snap.real && Array.isArray(snap.real.activity) ? snap.real.activity : null);
      if (realActs) out.activity = realActs;
      if (Array.isArray(snap.pipeline)) {
        out.pipeline = snap.pipeline;
        if (out.dashboard && typeof out.dashboard === "object") {
          out.dashboard = Object.assign({}, out.dashboard, { pipeline: snap.pipeline });
        }
      }
      applyPipeCounts(out, snap);
      applyLog(out, snap);
      if (Array.isArray(snap.waiting)) out.waiting = snap.waiting;
      return out;
    }
    var livePos = (snap.positions || []).map(function (sp) {
      var spId = sp.pos_key || sp.mint;
      var old = oldPos.find(function (p) { return (p.pos_key || p.mint) === spId && Number(p.opened_at) === Number(sp.opened_at); }) || {};
      var row = Object.assign({}, old, {
        mint: sp.mint, name: sp.name || old.name, symbol: sp.symbol || old.symbol, status: sp.status || "open",
        entry: sp.entry, size_usd: sp.size_usd, opened_at: sp.opened_at, stop_pct: sp.stop_pct,
        mode: sp.mode || old.mode || "PAPER", strategy: sp.strategy || old.strategy || "",
        pos_key: sp.pos_key || old.pos_key || undefined, sub_bot: sp.sub_bot || old.sub_bot || undefined
      });
      var mk = root.__buddyMarkCache || (root.__buddyMarkCache = {});
      if (sp.price) {
        row.mark_price = sp.price; row.mark_fetched_at = sp.price_ts; row.mark_source = sp.price_src || "desk_live";
        if (sp.pair) row.mark_pair = sp.pair;
        mk[spId] = { p: sp.price, t: sp.price_ts, src: row.mark_source, pair: row.mark_pair, at: Date.now() };
      } else if (mk[spId] && Date.now() - mk[spId].at < 120000 &&
                 (row.mark_price == null || Number(row.mark_fetched_at || 0) < Number(mk[spId].t || 0))) {
        /* v83: a tick without a price keeps the last live mark (no "—" / balance flicker) */
        row.mark_price = mk[spId].p; row.mark_fetched_at = mk[spId].t; row.mark_source = mk[spId].src;
        if (mk[spId].pair) row.mark_pair = mk[spId].pair;
      }
      return row;
    });
    /* Only replace paper opens when the desk sent the full open list.
       A tick without `positions` used to wipe them; a missed `closed` row
       used to leave a stale Sell now card after the desk had already exited. */
    if (Array.isArray(snap.positions)) {
      out.positions = livePos.concat(oldPos.filter(function (p) { return !isPaper(p); }));
    }
    if (Array.isArray(s.trades)) {
      var trades = s.trades.map(function (t) { return t; });
      var same = function (t, r) { return (t.pos_key || t.mint) === (r.pos_key || r.mint) && Math.abs((Number(t.opened_at) || 0) - (Number(r.opened_at) || 0)) < 1; };
      (snap.closed || []).forEach(function (c) {
        var i = trades.findIndex(function (t) { return same(t, c); });
        var row = {
          mint: c.mint, name: c.name, symbol: c.symbol, side_or_status: "closed", entry: c.entry, exit: c.exit,
          size_usd: c.size_usd, pnl_usd: c.pnl_usd, pnl_pct: c.pnl_usd != null && c.size_usd ? c.pnl_usd / c.size_usd * 100 : null,
          fees_usd: c.fees_usd, opened_at: c.opened_at, closed_at: c.closed_at, exit_reason: c.exit_reason,
          strategy: c.strategy, pos_key: c.pos_key || undefined, sub_bot: c.sub_bot || undefined, mode: c.mode || "PAPER", paper_mode: String(c.strategy || "").replace(/^paper_mode:/, "") || undefined
        };
        if (i >= 0) {
          if (String(trades[i].side_or_status || "").toLowerCase() === "open") trades[i] = Object.assign({}, trades[i], row);
        } else trades.push(row);
      });
      if (Array.isArray(snap.positions)) {
        var liveIds = {};
        snap.positions.forEach(function (sp) {
          liveIds[(sp.pos_key || sp.mint) + "#" + Number(sp.opened_at || 0)] = 1;
        });
        var snapTs = Number(snap.ts) || (Date.now() / 1000);
        trades = trades.map(function (t) {
          if (!isPaper(t)) return t;
          var st = String(t.side_or_status || t.status || "").toLowerCase();
          if (st && st !== "open" && st !== "opening" && st !== "selling" && st !== "exiting") return t;
          if (t.closed_at) return t;
          var k = (t.pos_key || t.mint) + "#" + Number(t.opened_at || 0);
          if (liveIds[k]) return t;
          if ((Number(t.opened_at) || 0) > snapTs - 3) return t;
          return Object.assign({}, t, { side_or_status: "closed", status: "closed", closed_at: t.closed_at || snapTs });
        });
        snap.positions.forEach(function (sp) {
          if (trades.some(function (t) { return same(t, sp); })) return;
          trades.unshift({
            mint: sp.mint, name: sp.name, symbol: sp.symbol, side_or_status: "open", entry: sp.entry, exit: null,
            size_usd: sp.size_usd, pnl_usd: null, pnl_pct: null, fees_usd: null, opened_at: sp.opened_at, closed_at: null,
            exit_reason: null, strategy: sp.strategy, pos_key: sp.pos_key || undefined, sub_bot: sp.sub_bot || undefined, mode: sp.mode || "PAPER",
            paper_mode: String(sp.strategy || "").replace(/^paper_mode:/, "") || undefined
          });
        });
      }
      out.trades = trades;
    }
    if (Array.isArray(s.activity) && Array.isArray(snap.activity)) {
      var ids = {};
      s.activity.forEach(function (a) { ids[a.id] = 1; });
      var fresh = snap.activity.filter(function (a) { return a.id != null && !ids[a.id]; });
      if (fresh.length) out.activity = fresh.concat(s.activity).slice(0, 120);
    }
    if (Array.isArray(snap.pipeline)) {
      out.pipeline = snap.pipeline;
      if (out.dashboard && typeof out.dashboard === "object") {
        out.dashboard = Object.assign({}, out.dashboard, { pipeline: snap.pipeline });
      }
    }
    applyPipeCounts(out, snap);
    applyLog(out, snap);
    if (Array.isArray(snap.waiting)) out.waiting = snap.waiting;
    return out;
  }

  root.BuddyLive = {
    start: start, stop: stop, merge: merge, status: status, sendCmd: sendCmd, sendCmdReliable: sendCmdReliable, waitAck: waitAck, newCid: newCid,
    snap: function () { return st.snap; },
    connected: function () { return st.connected; }
  };
})(typeof window !== "undefined" ? window : globalThis);
