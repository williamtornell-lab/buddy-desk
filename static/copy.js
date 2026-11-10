/* Buddy copy trading card + Lessons card. Reads state.copy and state.lessons only.
   The toggle asks app.js (hooks.request) which confirms and posts copy:on|off. */
(function (root) {
  "use strict";
  var hooks = { request: null };
  var view = { pending: null, pendingAt: 0, open: false };
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function k(v) {
    var n = num(v); if (n == null) return "—";
    var a = Math.abs(n), s = n < 0 ? "−" : "+";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "K";
    return s + "$" + a.toFixed(0);
  }
  function kn(v) { var n = num(v); if (n == null) return "—"; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(Math.round(n)); }
  function money(v) { var n = num(v); if (n == null) return "—"; return (n < 0 ? "−$" : "+$") + Math.abs(n).toFixed(2); }
  function ago(ts) {
    var t = num(ts); if (t == null) return "";
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 172800) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function traderOf(t) {
    if (!t) return "";
    if (typeof t.strategy === "string" && t.strategy.indexOf("copy:") === 0) return t.strategy.slice(5);
    var ctx = t.entry_context;
    if (typeof ctx === "string") { try { ctx = JSON.parse(ctx); } catch (e) { ctx = null; } }
    return ctx && ctx.copy_trader ? String(ctx.copy_trader) : "";
  }
  function latencyOf(t) {
    var ctx = t && t.entry_context;
    if (typeof ctx === "string") { try { ctx = JSON.parse(ctx); } catch (e) { ctx = null; } }
    return ctx ? num(ctx.copy_latency_s) : null;
  }
  function tagHtml(t) {
    var h = traderOf(t);
    return h ? '<span class="style-tag st-copy">Copy @' + esc(h) + "</span>" : "";
  }

  function openCopies(s) {
    var n = 0;
    (Array.isArray(s && s.positions) ? s.positions : []).forEach(function (p) {
      if (p && String(p.status || "open") === "open" && traderOf(p)) n++;
    });
    return n;
  }

  function renderCopy(s) {
    var row = $("#copyCard");
    if (!row) return;
    var c = s && s.copy;
    var live = !!(s && (s.real_only || String(s.mode || "").toUpperCase() === "LIVE" || String(s.mode_label || "").toUpperCase() === "REAL"));
    if (!c || typeof c !== "object" || c.hidden || live) { row.hidden = true; return; }
    row.hidden = false;
    var on = !!c.enabled;
    if (view.pending != null && (view.pending === on || Date.now() - view.pendingAt > 90000)) view.pending = null;
    var shownOn = view.pending != null ? view.pending : on;
    var btn = $("#copyToggle");
    btn.className = "cr-switch" + (shownOn ? " on" : "") + (view.pending != null ? " busy" : "");
    btn.setAttribute("aria-checked", String(on));
    btn.disabled = view.pending != null;
    var tracked = num(c.tracked) || 0;
    var bits = [tracked + " traders"];
    if (on) bits.push(openCopies(s) + " open");
    else bits.push("off");
    $("#copyLine").textContent = bits.join(" · ");
    var more = $("#copyMore");
    var exp = $("#copyExpand");
    more.hidden = !view.open;
    exp.setAttribute("aria-expanded", String(!!view.open));
    exp.classList.toggle("open", !!view.open);
    if (!view.open) return;
    var last = c.last_copy;
    $("#copySub").textContent = last && last.trader
      ? "Last copy · " + (last.name || "") + " · @" + last.trader + " · " + ago(last.ts)
      : "No copies yet";
    var list = Array.isArray(c.traders) ? c.traders : [];
    $("#copyList").innerHTML = list.map(function (t, i) {
      var p = t.pnl || {};
      var best = num(p["24h"]) != null ? k(p["24h"]) : (num(p["7d"]) != null ? k(p["7d"]) : k(p["30d"]));
      return '<div class="cp-row"><span class="cp-rank">' + (i + 1) + '</span><span class="cp-h">@' + esc(t.handle) +
        '</span><span class="cp-f">' + kn(t.followers) + '</span><span class="cp-p up">' + esc(best) + "</span></div>";
    }).join("");
  }

  function renderLessons(s) {
    var card = $("#lessonsCard");
    if (!card) return;
    var live = !!(s && (s.real_only || String(s.mode || "").toUpperCase() === "LIVE" || String(s.mode_label || "").toUpperCase() === "REAL"));
    var L = s && s.lessons;
    if (!L || typeof L !== "object") { card.hidden = true; return; }
    card.hidden = false;
    var realSrc = live || L.source === "real";
    $("#lessonsMeta").textContent = (num(L.journal_n) || 0) + (realSrc ? " real trades reviewed" : " trades reviewed");
    var html = "";
    var groups = Array.isArray(L.groups) ? L.groups : [];
    if (!groups.length) html += realSrc
      ? '<p class="ls-empty">No closed real trades yet. Wins, losses and P&amp;L by exit will show up here.</p>'
      : '<p class="ls-empty">No closed paper trades yet.</p>';
    groups.slice(0, 3).forEach(function (g) {
      var head = '<p class="ls-g"><b>' + esc(g.label || g.group) + "</b> " + g.wins + "W/" + g.losses + "L · " +
        '<span class="' + ((g.pnl_usd || 0) >= 0 ? "up" : "down") + '">' + money(g.pnl_usd) + "</span>" +
        (g.ready ? "" : ' <span class="ls-tag">' + g.n + "/" + (L.min_sample || 8) + " · early signs</span>") + "</p>";
      var ul = "";
      (g.went_well || []).slice(0, 3).forEach(function (t) { ul += '<li class="ok">' + esc(t) + "</li>"; });
      (g.went_wrong || []).slice(0, 2).forEach(function (t) { ul += '<li class="bad">' + esc(t) + "</li>"; });
      html += head + (ul ? '<ul class="ls-list">' + ul + "</ul>" : "");
    });
    var adj = (Array.isArray(L.adjustments) ? L.adjustments : []).filter(function (a) { return a.kind !== "rollback"; });
    html += '<p class="ls-sub">Changes made</p>';
    if (adj.length) {
      html += '<ul class="ls-list">' + adj.slice(0, 4).map(function (a) {
        var what = a.kind === "blacklist" ? "Dropped @" + a.key : (a.kind === "trader_weight" ? "@" + a.key + " weight " + a.before + " → " + a.after : a.group + " " + a.key + " " + a.before + " → " + a.after);
        return '<li class="chg">' + esc(what) + ' <span class="ls-when">' + ago(a.ts) + "</span></li>";
      }).join("") + "</ul>";
    } else {
      html += realSrc
        ? '<p class="ls-empty">No automatic changes from real trades.</p>'
        : '<p class="ls-empty">None yet. Needs ' + (L.min_sample || 8) + "+ closed trades in a mode.</p>";
    }
    var sug = Array.isArray(L.suggested) ? L.suggested : [];
    if (sug.length) {
      html += '<p class="ls-sub">Suggested for you</p><ul class="ls-list">' + sug.slice(0, 3).map(function (t) { return '<li class="sug">' + esc(t) + "</li>"; }).join("") + "</ul>";
    }
    $("#lessonsBody").innerHTML = html;
  }

  function render(s) {
    try { renderCopy(s); } catch (e) { /* optional */ }
    try { renderLessons(s); } catch (e) { /* optional */ }
  }
  function onClick(e, s) {
    var x = e.target.closest("#copyExpand");
    if (x) { view.open = !view.open; renderCopy(s); return true; }
    var b = e.target.closest("#copyToggle");
    if (!b) return false;
    var on = !!(s && s.copy && s.copy.enabled);
    if (hooks.request) hooks.request(!on);
    return true;
  }
  function markPending(on) { view.pending = !!on; view.pendingAt = Date.now(); }

  root.BuddyCopy = { render: render, onClick: onClick, tagHtml: tagHtml, traderOf: traderOf, latencyOf: latencyOf,
    markPending: markPending, hooks: hooks };
})(typeof window !== "undefined" ? window : globalThis);
