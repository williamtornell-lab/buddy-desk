/* Buddy desk power button + Desk sessions.
   The one Desk ON/OFF button (Settings tab) sends the existing desk:on / desk:off command
   (off = no new PAPER buys, open trades still managed). Turning off archives the
   session counters; Insights lists past sessions. Power + session line only in Settings.
   Display only: balance, trades, equity chart and learning are not touched. */
(function (root) {
  "use strict";
  var hooks = { confirm: null };
  var pend = null; // {on, at}

  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function hm(ts) {
    var t = num(ts); if (t == null) return "";
    return new Date(t * 1000).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function usd(v) {
    var n = num(v); if (n == null) return "—";
    return (n > 0 ? "+" : n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2);
  }
  function isReal(s) {
    return String(s.mode_label || s.mode || "").toUpperCase() === "REAL" || String(s.mode || "").toUpperCase() === "LIVE";
  }
  function deskOn(s) {
    var ds = s.desk_settings || {};
    var on = !ds.paused;
    if (pend) {
      if (pend.on === on || Date.now() - pend.at > 90000) pend = null;
      else return { on: pend.on, busy: true };
    }
    return { on: on, busy: false };
  }

  function renderPower(s) {
    var host = $("#deskPower");
    if (!host) return;
    if (!s.desk_settings || isReal(s)) { host.hidden = true; return; }
    host.hidden = false;
    var st = deskOn(s);
    var sess = (s.dashboard && s.dashboard.session) || null;
    var line = st.on ? "PAPER buys on · tap to turn off" : "Paused · open trades still managed · tap to turn on";
    if (st.busy) line = "Sending…";
    host.className = "desk-power " + (st.on ? "on" : "off") + (st.busy ? " busy" : "");
    host.innerHTML =
      '<button type="button" class="dp-btn" data-desk-power="' + (st.on ? "off" : "on") + '"' + (st.busy ? " disabled" : "") +
      ' role="switch" aria-checked="' + st.on + '" aria-label="Desk ' + (st.on ? "on" : "off") + '">' +
      '<span class="dp-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg></span>' +
      '<span class="dp-txt"><b>Desk ' + (st.on ? "ON" : "OFF") + "</b><small>" + esc(line) + "</small></span>" +
      '<span class="dp-knob" aria-hidden="true"><i></i></span></button>' +
      (sess && sess.start ? '<p class="dp-sess">Session since ' + esc(hm(sess.start)) + " · " + (num(sess.buys) || 0) + " buys · " +
        (num(sess.sells) || 0) + " sells · " + esc(usd(sess.pnl_usd)) + "</p>" : "");
  }

  // Session line lives only under the Settings power button (dp-sess in renderPower).
  // Home no longer shows #deskSession.
  function renderDeskSession(s) { /* removed from Home; kept as no-op */ }

  function dur(sec) {
    var n = Math.max(0, Math.floor(num(sec) || 0) / 60 | 0);
    var h = Math.floor(n / 60), m = n % 60;
    return h ? h + "h " + m + "m" : m + "m";
  }
  function dayTime(ts) {
    var t = num(ts); if (t == null) return "";
    var d = new Date(t * 1000);
    var day = d.toLocaleDateString("en-GB", { timeZone: "Europe/Stockholm", weekday: "short", day: "numeric", month: "short" });
    var tm = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hour12: false });
    return day + " · " + tm;
  }
  function pct(v) {
    var n = num(v); if (n == null) return "";
    return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + "%";
  }

  // Sessions page: one box per desk ON period, newest first, running one marked.
  function renderBoxes(s, card, host) {
    var d = s.dashboard || {};
    var rows = d.sessions;
    var now = Date.now() / 1000;
    $("#sessionsTitle").textContent = "Sessions";
    $("#sessionsMeta").textContent = rows.length ? rows.length + (rows.length === 1 ? " session" : " sessions") : "";
    if (!rows.length) {
      host.innerHTML = '<p class="quiet">No sessions yet. Each time the desk is on it shows up here.</p>';
      return;
    }
    host.className = "ss-grid";
    host.innerHTML = rows.map(function (r) {
      var p = num(r.pnl_usd) || 0;
      var tone = p > 0.004 ? "up" : p < -0.004 ? "down" : "flat";
      var secs = r.running ? Math.max(num(r.duration_s) || 0, now - (num(r.start) || now)) : num(r.duration_s);
      var n = num(r.trades) || 0;
      var basis = r.pct_base === "at_risk" ? ' title="% of capital at risk"' : "";
      return '<div class="ss-box ' + tone + (r.running ? " run" : "") + '">' +
        '<div class="ss-top"><span class="ss-when">' + esc(dayTime(r.start)) + "</span>" +
        (r.running ? '<span class="ss-run">Running</span>' : "") + "</div>" +
        '<div class="ss-pnl"><b>' + esc(usd(p)) + "</b><span" + basis + ">" + esc(pct(r.pnl_pct)) + "</span></div>" +
        '<div class="ss-sub">' + esc(dur(secs)) + " on · " + n + (n === 1 ? " trade" : " trades") + "</div></div>";
    }).join("");
  }

  function renderPast(s) {
    var card = $("#sessionsCard"), host = $("#pastSessions");
    if (!card || !host) return;
    var live = !!(s && (s.real_only || String(s.mode || "").toUpperCase() === "LIVE" || String(s.mode_label || "").toUpperCase() === "REAL"));
    if (live) { card.hidden = true; return; }
    var d = s.dashboard || {};
    if (Array.isArray(d.sessions)) { card.hidden = false; renderBoxes(s, card, host); return; }
    var rows = Array.isArray(d.past_sessions) ? d.past_sessions : null;
    if (!rows) { card.hidden = true; return; }
    card.hidden = false;
    $("#sessionsMeta").textContent = rows.length ? rows.length + " saved" : "";
    if (!rows.length) {
      host.innerHTML = '<p class="quiet">No past sessions yet. Turning the desk off saves the current session here and restarts the Desk counters.</p>';
      return;
    }
    host.innerHTML = rows.map(function (r) {
      var p = num(r.pnl_usd);
      var tone = p == null ? "flat" : p > 0 ? "up" : p < 0 ? "down" : "flat";
      var when = (r.started_local || hm(r.started_at)) + " → " + (r.ended_local || hm(r.ended_at));
      return '<div class="ps-row"><div class="ps-when">' + esc(when) + "</div>" +
        '<div class="ps-stats">' + (num(r.scanned) || 0) + " scanned · " + (num(r.buys) || 0) + " buys · " + (num(r.sells) || 0) + " sells · " +
        (num(r.wins) || 0) + "W/" + (num(r.losses) || 0) + "L · " + (num(r.killed) || 0) + " killed</div>" +
        '<div class="ps-pnl ' + tone + '">' + esc(usd(p)) + "</div></div>";
    }).join("");
  }

  function render(s) {
    if (!s) return;
    try { renderPower(s); } catch (e) { /* optional */ }
    try { renderDeskSession(s); } catch (e) { /* optional */ }
    try { renderPast(s); } catch (e) { /* optional */ }
  }

  function onClick(e, s) {
    var t = e.target.closest && e.target.closest("[data-desk-power]");
    if (!t) return false;
    var on = t.getAttribute("data-desk-power") === "on";
    if (!hooks.confirm) return true;
    hooks.confirm({
      title: on ? "Turn the desk on?" : "Turn the desk off?",
      body: on ? "New PAPER buys start again in the active mode, copy and sub-bots."
        : "Stops NEW PAPER buys. Open trades keep being managed and exited. The current Desk session is saved to Insights → Sessions and the Desk counters start from zero. Balance, trades, chart and learning stay.",
      ok: on ? "Turn on" : "Turn off",
      cmds: ["desk:" + (on ? "on" : "off")],
      toast: "Sent",
      after: function () { pend = { on: on, at: Date.now() }; if (s) render(s); }
    });
    return true;
  }

  root.BuddySession = { hooks: hooks, render: render, onClick: onClick };
})(window);
