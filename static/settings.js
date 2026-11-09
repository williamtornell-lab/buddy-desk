/* Buddy Settings tab. Every change goes through app.js's confirm dialog and the
   existing ntfy control path (hooks.confirm). PAPER only; REAL stays alerts-only. */
(function (root) {
  "use strict";
  var hooks = { confirm: null, scalp: null, openKeys: null, liveText: null, version: "" };
  var pend = {};      // optimistic switch states: key -> {on, at}
  var edits = {};     // "mode:key" / "copy:key" -> value
  var resetAmt = null;

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function money(v) { var n = num(v); return n == null ? "—" : "$" + n.toFixed(2); }
  var LABEL = { buy_usd: "Size", tp_pct: "Take profit", stop_pct: "Stop", max_hold_min: "Max hold", max_open: "Max open" };
  var STEP = { buy_usd: 1, tp_pct: 0.5, stop_pct: 0.5, max_hold_min: 1, max_open: 1 };
  function fmt(k, v) {
    if (v == null) return "—";
    var t = Math.round(v * 100) / 100;
    if (k === "buy_usd") return "$" + t;
    if (k === "tp_pct") return "+" + t + "%";
    if (k === "stop_pct") return "−" + t + "%";
    if (k === "max_hold_min") return t >= 120 ? (Math.round(t / 6) / 10) + " h" : t + " min";
    return String(t);
  }
  function stepFor(k, base) {
    if (k === "max_hold_min" && base >= 60) return Math.max(5, Math.round(base * 0.05));
    if (k === "tp_pct" && base >= 20) return 1;
    return STEP[k] || 1;
  }

  function sw(key, on, label, sub, extra) {
    var p = pend[key];
    if (p && (p.on === on || Date.now() - p.at > 90000)) { delete pend[key]; p = null; }
    var shown = p ? p.on : on;
    return '<div class="set-row"><div class="set-txt"><span class="set-name">' + esc(label) + "</span>" +
      (sub ? '<span class="set-sub">' + esc(sub) + "</span>" : "") + "</div>" + (extra || "") +
      '<button type="button" class="cr-switch' + (shown ? " on" : "") + (p ? " busy" : "") + '" role="switch" aria-checked="' + on + '" aria-label="' + esc(label) + '"' +
      ' data-set-sw="' + esc(key) + '" data-on="' + (on ? "1" : "0") + '"' + (p ? " disabled" : "") + '><span class="cr-knob"></span></button></div>';
  }

  function stepper(scope, k, spec) {
    var id = scope + ":" + k;
    var v = edits[id] != null ? edits[id] : num(spec.value);
    var changed = edits[id] != null && Math.abs(edits[id] - num(spec.value)) > 1e-9;
    var lo = num(spec.lo), hi = num(spec.hi);
    return '<div class="set-row"><div class="set-txt"><span class="set-name">' + esc(LABEL[k] || k) + "</span></div>" +
      '<div class="stp"><button type="button" data-stp="' + esc(id) + '" data-d="-1"' + (v <= lo + 1e-9 ? " disabled" : "") + ' aria-label="Lower">−</button>' +
      '<span class="stp-v' + (changed ? " changed" : "") + '">' + esc(fmt(k, v)) + "</span>" +
      '<button type="button" data-stp="' + esc(id) + '" data-d="1"' + (v >= hi - 1e-9 ? " disabled" : "") + ' aria-label="Higher">+</button></div></div>';
  }

  function card(title, body, aside) {
    return '<section class="dash-card set-card"><div class="dash-head"><h2>' + esc(title) + "</h2>" + (aside || "") + "</div>" + body + "</section>";
  }

  function render(s) {
    var host = $("#prefsBody");
    if (!host || !s) return;
    var ae = document.activeElement;
    if (ae && ae.tagName === "INPUT" && host.contains(ae)) return;
    var ds = s.desk_settings || {};
    var real = String(s.mode_label || s.mode || "").toUpperCase() === "REAL" || String(s.mode || "").toUpperCase() === "LIVE";
    var html = "";
    $("#prefsMode").textContent = real ? "REAL · alerts only" : "PAPER";
    $("#prefsMode").className = "set-pill" + (real ? " real" : "");

    // Desk master switch
    var paused = !!ds.paused;
    html += card("Desk", sw("desk", !paused, "PAPER trading", paused ? "Paused · open trades still managed" : "New buys on"));

    // Paper balance
    var chips = [100, 200, 500, 1000].map(function (a) {
      return '<button type="button" class="chip' + (resetAmt === a ? " on" : "") + '" data-reset-amt="' + a + '">$' + a + "</button>";
    }).join("");
    html += card("Paper balance",
      '<div class="set-row"><div class="set-txt"><span class="set-name">' + esc(money(s.balance)) + '</span><span class="set-sub">Reset closes all paper trades</span></div></div>' +
      '<div class="chips">' + chips + '<input id="resetCustom" class="chip-in" type="number" inputmode="decimal" min="10" max="100000" placeholder="Custom"' +
      (resetAmt != null && [100, 200, 500, 1000].indexOf(resetAmt) < 0 ? ' value="' + resetAmt + '"' : "") + "></div>" +
      '<button type="button" class="set-btn" data-reset-go' + (resetAmt ? "" : " disabled") + ">Reset to " + (resetAmt ? "$" + resetAmt : "…") + "</button>");

    // Bot settings
    var m = ds.mode || null;
    if (m && m.values) {
      var keys = ["buy_usd", "tp_pct", "stop_pct", "max_hold_min", "max_open"].filter(function (k) { return m.values[k]; });
      var label = String(m.name || "").replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
      var cp = ds.copy || {};
      var body = '<p class="set-group">' + esc(label) + "</p>" + keys.map(function (k) { return stepper(m.name, k, m.values[k]); }).join("");
      if (cp.buy_usd || cp.max_open) {
        body += '<p class="set-group">Copy top traders</p>' + ["buy_usd", "max_open"].filter(function (k) { return cp[k]; }).map(function (k) { return stepper("copy", k, cp[k]); }).join("");
      }
      var subs = s.scalp_subs || {};
      if (m.name === "scalping" && (subs.quick || subs.runner)) {
        body += '<p class="set-group">Scalp sub-bots</p>' +
          ["quick", "runner"].filter(function (k) { return subs[k]; }).map(function (k) {
            return sw("sub:" + k, !!subs[k].enabled, subs[k].label, subs[k].line);
          }).join("");
      }
      var dirty = Object.keys(edits).some(function (id) { return isDirty(ds, id); });
      body += '<button type="button" class="set-btn" data-save-edits' + (dirty ? "" : " disabled") + ">Save changes</button>";
      html += card("Bot settings", body, '<span class="muted">±20% of approved</span>');
    }

    // Notifications + learning
    var nt = ds.notify || {};
    html += card("Notifications", sw("notify:buys", nt.buys !== false, "Buy alerts") + sw("notify:sells", nt.sells !== false, "Sell alerts"));
    html += card("Learning", sw("learn", ds.learn_enabled !== false, "Learning loop", "Small paper tweaks within ±20%") +
      '<button type="button" class="set-btn ghost" data-learn-undo>Undo last learning change</button>');

    // Close all
    var openKeys = hooks.openKeys ? hooks.openKeys() : [];
    html += card("Paper trades", '<button type="button" class="set-btn danger" data-close-all' + (openKeys.length ? "" : " disabled") + ">Close all " + (openKeys.length || "") + " paper trades</button>");

    // App info
    var lm = ds.last_msg;
    html += card("App",
      '<div class="set-row"><div class="set-txt"><span class="set-name">Live feed</span></div><span class="set-val">' + esc(hooks.liveText ? hooks.liveText() : "—") + "</span></div>" +
      (lm && lm.msg ? '<div class="set-row"><div class="set-txt"><span class="set-name">Last change</span><span class="set-sub' + (lm.ok ? "" : " bad") + '">' + esc(lm.msg) + "</span></div></div>" : "") +
      '<div class="set-row"><div class="set-txt"><span class="set-name">Version</span></div><span class="set-val">' + esc(hooks.version) + "</span></div>");
    host.innerHTML = html;
  }

  function specOf(ds, id) {
    var parts = id.split(":");
    if (parts[0] === "copy") return (ds.copy || {})[parts[1]];
    return ds.mode && ds.mode.name === parts[0] ? (ds.mode.values || {})[parts[1]] : null;
  }
  function isDirty(ds, id) {
    var sp = specOf(ds, id);
    return sp && edits[id] != null && Math.abs(edits[id] - num(sp.value)) > 1e-9;
  }

  function ask(a) { if (hooks.confirm) hooks.confirm(a); }

  function onClick(e, s) {
    var host = $("#prefsBody");
    if (!host || !host.contains(e.target)) return false;
    var ds = (s && s.desk_settings) || {};
    var t;
    if ((t = e.target.closest("[data-set-sw]"))) {
      var key = t.getAttribute("data-set-sw"), on = t.getAttribute("data-on") !== "1";
      if (key.indexOf("sub:") === 0) { if (hooks.scalp) hooks.scalp({ sub: key.slice(4), on: on }); return true; }
      var cmd = key === "desk" ? "desk:" + (on ? "on" : "off")
        : key === "learn" ? "learn:" + (on ? "on" : "off")
        : key.replace(":", ":") + ":" + (on ? "on" : "off");
      var titles = {
        desk: on ? "Resume PAPER buys?" : "Pause PAPER trading?",
        learn: on ? "Turn learning on?" : "Turn learning off?"
      };
      var bodies = {
        desk: on ? "New PAPER buys start again in the active mode, copy and sub-bots." : "Stops NEW buys only. Open trades keep being managed and exited.",
        learn: on ? "The learner reviews closed paper trades every 10 min and makes small changes within ±20%." : "No more automatic paper tweaks. Lessons stay visible."
      };
      ask({ title: titles[key] || ((on ? "Turn on " : "Turn off ") + key.split(":")[1] + " alerts?"),
        body: bodies[key] || "Telegram " + key.split(":")[1] + " alerts " + (on ? "on." : "off."), ok: on ? "Turn on" : "Turn off",
        cmds: [cmd], toast: "Sent", after: function () { pend[key] = { on: on, at: Date.now() }; } });
      return true;
    }
    if ((t = e.target.closest("[data-reset-amt]"))) { resetAmt = Number(t.getAttribute("data-reset-amt")); render(s); return true; }
    if (e.target.closest("[data-reset-go]")) {
      if (!resetAmt) return true;
      ask({ title: "Reset paper balance to $" + resetAmt + "?", body: "Closes every open paper trade and starts the paper stack at $" + resetAmt + ". A backup is kept. REAL is not touched.",
        ok: "Reset", danger: true, cmds: ["reset:" + resetAmt], toast: "Reset sent" });
      return true;
    }
    if ((t = e.target.closest("[data-stp]"))) {
      var id = t.getAttribute("data-stp"), d = Number(t.getAttribute("data-d"));
      var sp = specOf(ds, id);
      if (!sp) return true;
      var k = id.split(":")[1];
      var cur = edits[id] != null ? edits[id] : num(sp.value);
      var nv = Math.round((cur + d * stepFor(k, num(sp.base))) * 100) / 100;
      nv = Math.min(num(sp.hi), Math.max(num(sp.lo), nv));
      edits[id] = nv;
      render(s);
      return true;
    }
    if (e.target.closest("[data-save-edits]")) {
      var ids = Object.keys(edits).filter(function (i) { return isDirty(ds, i); });
      if (!ids.length) return true;
      var lines = ids.map(function (i) { var k = i.split(":")[1]; return (i.indexOf("copy:") === 0 ? "Copy " : "") + (LABEL[k] || k) + " → " + fmt(k, edits[i]); });
      ask({ title: "Save " + ids.length + " change" + (ids.length > 1 ? "s" : "") + "?", body: lines.join(" · ") + ". New trades only; the desk rejects anything outside ±20% of the approved values.",
        ok: "Save", cmds: ids.map(function (i) { var p = i.split(":"); return "set:" + p[0] + ":" + p[1] + "=" + edits[i]; }), toast: "Settings sent",
        after: function () { window.setTimeout(function () { edits = {}; }, 4000); } });
      return true;
    }
    if (e.target.closest("[data-learn-undo]")) {
      ask({ title: "Undo the last learning change?", body: "Restores the values from before the learner's last batch.", ok: "Undo", cmds: ["learn:rollback"], toast: "Undo sent" });
      return true;
    }
    if (e.target.closest("[data-close-all]")) {
      var keys = hooks.openKeys ? hooks.openKeys() : [];
      if (!keys.length) return true;
      ask({ title: "Close all " + keys.length + " paper trades?", body: "Sells every open PAPER position at the latest price. REAL is not touched.", ok: "Close all", danger: true,
        cmds: keys.map(function (k) { return "close:" + k; }), toast: "Close sent" });
      return true;
    }
    return false;
  }

  function onInput(e, s) {
    if (e.target && e.target.id === "resetCustom") {
      var v = Number(e.target.value);
      resetAmt = Number.isFinite(v) && v >= 10 && v <= 100000 ? Math.round(v * 100) / 100 : null;
      var b = document.querySelector("[data-reset-go]");
      if (b) { b.disabled = !resetAmt; b.textContent = "Reset to " + (resetAmt ? "$" + resetAmt : "…"); }
      document.querySelectorAll("[data-reset-amt]").forEach(function (c) { c.classList.remove("on"); });
      return true;
    }
    return false;
  }

  root.BuddySettings = { render: render, onClick: onClick, onInput: onInput, hooks: hooks };
})(typeof window !== "undefined" ? window : globalThis);
