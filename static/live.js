/* Buddy live channel: 5s desk snapshots over MQTT/WebSocket (port 443, free public broker).
   The desk encrypts each snapshot (AES-256-GCM); topic + key are derived from the private
   desk id in the link, so the broker only relays opaque bytes.
   Commands: the app also publishes encrypted commands on a separate cmd topic (same key). */
(function (root) {
  "use strict";
  var BROKER = "wss://public.cloud.shiftr.io";
  var ENC = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var DEC = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  var st = {
    ws: null, snap: null, lastAt: 0, connected: false, retry: 2000, timer: null, ping: null,
    id: "", hooks: {}, topic: "", cmdTopic: "", key: null, pendingAcks: {}
  };

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function sha(text) { return root.crypto.subtle.digest("SHA-256", ENC.encode(text)); }

  function mqttLen(n) { var out = []; do { var b = n % 128; n = Math.floor(n / 128); out.push(n ? b | 128 : b); } while (n); return out; }
  function mqttStr(s) { var b = ENC.encode(s); return [b.length >> 8, b.length & 255].concat(Array.prototype.slice.call(b)); }
  function pkt(type, body) { return new Uint8Array([type].concat(mqttLen(body.length), body)); }
  function connectPkt() {
    var cid = "buddy-app-" + Math.random().toString(16).slice(2, 10);
    var body = mqttStr("MQTT").concat([4, 0x02 | 0x80 | 0x40, 0, 30], mqttStr(cid), mqttStr("public"), mqttStr("public"));
    return pkt(0x10, body);
  }
  function subscribePkt(topic) { return pkt(0x82, [0, 1].concat(mqttStr(topic), [0])); }
  function publishPkt(topic, payloadU8) {
    var t = mqttStr(topic);
    var body = t.concat(Array.prototype.slice.call(payloadU8));
    return pkt(0x30, body);
  }

  function parse(u8, cb) {
    var i = 0;
    while (i < u8.length) {
      var t = u8[i], mult = 1, n = 0, j = i + 1, b;
      do { b = u8[j++]; n += (b & 127) * mult; mult *= 128; } while (b & 128);
      cb(t >> 4, t & 15, u8.subarray(j, j + n));
      i = j + n;
    }
  }

  function status() {
    var fresh = st.snap && (Date.now() / 1000 - st.lastAt) < 15;
    return fresh ? "live" : (st.id ? "fallback" : "off");
  }
  function emitStatus() { if (st.hooks.onStatus) st.hooks.onStatus(status()); }

  function noteAck(snap) {
    var ack = snap && snap.cmd_ack;
    if (!ack || !ack.cid) return;
    var pend = st.pendingAcks[ack.cid];
    if (!pend) return;
    delete st.pendingAcks[ack.cid];
    if (st.hooks.onAck) st.hooks.onAck(ack, pend);
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
    var ws;
    try { ws = new WebSocket(BROKER, ["mqtt"]); } catch (e) { return later(id); }
    ws.binaryType = "arraybuffer";
    st.ws = ws;
    ws.onopen = function () { ws.send(connectPkt()); };
    ws.onmessage = function (ev) {
      parse(new Uint8Array(ev.data), function (type, flags, body) {
        if (type === 2) { // CONNACK
          if (body[1] !== 0) { ws.close(); return; }
          st.connected = true;
          st.retry = 2000;
          ws.send(subscribePkt(topic));
          clearInterval(st.ping);
          st.ping = setInterval(function () { try { ws.send(new Uint8Array([0xc0, 0])); } catch (e) { /* ignore */ } }, 20000);
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
    ws.onclose = function () { st.connected = false; clearInterval(st.ping); emitStatus(); later(id); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
  }
  function later(id) {
    clearTimeout(st.timer);
    st.timer = setTimeout(function () { if (st.id === id) open(id); }, st.retry);
    st.retry = Math.min(30000, st.retry * 2);
  }

  function start(id, hooks) {
    if (!id || st.id === id) return;
    stop();
    st.id = id;
    st.hooks = hooks || {};
    open(id);
    setInterval(emitStatus, 5000);
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

  async function publishRaw(payloadU8) {
    if (!st.cmdTopic) return false;
    if (st.ws && st.connected && st.ws.readyState === 1) {
      st.ws.send(publishPkt(st.cmdTopic, payloadU8));
      return true;
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
        parse(new Uint8Array(ev.data), function (type, _f, body) {
          if (type !== 2) return;
          if (body[1] !== 0) { if (!done) { done = true; clearTimeout(t); resolve(false); } return; }
          try { ws.send(publishPkt(st.cmdTopic, payloadU8)); } catch (e) { if (!done) { done = true; clearTimeout(t); resolve(false); } return; }
          setTimeout(function () { try { ws.close(); } catch (e) {} }, 200);
          if (!done) { done = true; clearTimeout(t); resolve(true); }
        });
      };
      ws.onerror = function () { if (!done) { done = true; clearTimeout(t); resolve(false); } };
    });
  }

  /** Publish an encrypted command. Returns {ok, cid}. Registers pending ack. */
  async function sendCmd(cmd, meta) {
    if (!st.id) return { ok: false, cid: null };
    var cid = newCid();
    try {
      var sealed = await sealCmd(cmd, cid);
      var ok = await publishRaw(sealed);
      if (ok) st.pendingAcks[cid] = Object.assign({ at: Date.now(), cmd: cmd }, meta || {});
      return { ok: ok, cid: cid };
    } catch (e) {
      return { ok: false, cid: cid };
    }
  }

  /* Overlay a live snapshot on the full state.json (pure; returns a new object). */
  function merge(s, snap) {
    if (!s || !snap || !snap.ts || (Number(s.ts) || 0) > snap.ts + 1) return s;
    var out = Object.assign({}, s);
    ["balance", "free", "open_usd"].forEach(function (k) { if (snap[k] != null) out[k] = snap[k]; });
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
    var livePos = (snap.positions || []).map(function (sp) {
      var spId = sp.pos_key || sp.mint;
      var old = oldPos.find(function (p) { return (p.pos_key || p.mint) === spId && Number(p.opened_at) === Number(sp.opened_at); }) || {};
      var row = Object.assign({}, old, {
        mint: sp.mint, name: sp.name || old.name, symbol: sp.symbol || old.symbol, status: sp.status || "open",
        entry: sp.entry, size_usd: sp.size_usd, opened_at: sp.opened_at, stop_pct: sp.stop_pct,
        mode: sp.mode || old.mode || "PAPER", strategy: sp.strategy || old.strategy || "",
        pos_key: sp.pos_key || old.pos_key || undefined, sub_bot: sp.sub_bot || old.sub_bot || undefined
      });
      if (sp.price) {
        row.mark_price = sp.price; row.mark_fetched_at = sp.price_ts; row.mark_source = sp.price_src || "desk_live";
        if (sp.pair) row.mark_pair = sp.pair;
      }
      return row;
    });
    out.positions = livePos.concat(oldPos.filter(function (p) { return !isPaper(p); }));
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
      (snap.positions || []).forEach(function (sp) {
        if (trades.some(function (t) { return same(t, sp); })) return;
        trades.unshift({
          mint: sp.mint, name: sp.name, symbol: sp.symbol, side_or_status: "open", entry: sp.entry, exit: null,
          size_usd: sp.size_usd, pnl_usd: null, pnl_pct: null, fees_usd: null, opened_at: sp.opened_at, closed_at: null,
          exit_reason: null, strategy: sp.strategy, pos_key: sp.pos_key || undefined, sub_bot: sp.sub_bot || undefined, mode: sp.mode || "PAPER",
          paper_mode: String(sp.strategy || "").replace(/^paper_mode:/, "") || undefined
        });
      });
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
    return out;
  }

  root.BuddyLive = {
    start: start, stop: stop, merge: merge, status: status, sendCmd: sendCmd, newCid: newCid,
    snap: function () { return st.snap; },
    connected: function () { return st.connected; }
  };
})(typeof window !== "undefined" ? window : globalThis);
