/* Buddy Adaptive card. Reads state.adaptive only. Conviction buttons post adaptive:<level>
   through app.js (hooks.post). PAPER only; REAL never orders. */
(function (root) {
  "use strict";
  var hooks = { post: null };
  var view = { pending: null, pendingAt: 0 };
  var LEVELS = [["cautious", "Cautious", "EV ≥ +8% · win ≥ 55%"], ["normal", "Normal", "EV ≥ +4% · win ≥ 45%"], ["bold", "Bold", "EV ≥ +1% · win ≥ 35%"]];
  var EXIT_TXT = { quick: "Quick +15% / −8% / 10 min", swing: "Swing +35% / −15% / 30 min", runner: "Runner +80% / −25% / 90 min" };
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; }
  function pct(v) { var n = num(v); if (n == null) return "—"; return (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "%"; }
  function money(v) { var n = num(v); if (n == null) return "—"; return (n < 0 ? "−$" : "+$") + Math.abs(n).toFixed(2); }
  function cls(v) { var n = num(v); return n == null || n === 0 ? "flat" : (n > 0 ? "up" : "down"); }
  function kn(v) { var n = num(v); if (n == null) return "0"; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(Math.round(n)); }
  function ago(ts) {
    var t = num(ts); if (t == null) return "not yet";
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function render(s) {
    var card = $("#adaptiveCard");
    if (!card) return;
    var a = s && s.adaptive;
    if (!a || typeof a !== "object") { card.hidden = true; return; }
    card.hidden = false;
    var status = String(a.status || "no edge yet");
    var pill = $("#adaptiveStatus");
    pill.textContent = status === "trading" ? "Trading" : (status === "watching" ? "Watching" : "No edge yet");
    pill.className = "ad-pill " + (status === "trading" ? "on" : (status === "watching" ? "watch" : "off"));
    var d = a.dataset || {};
    $("#adaptiveLine").textContent = kn(d.resolved) + " finished setups · " + kn(d.coins) + " coins · trained " + ago(a.last_train);
    var ex = a.chosen_exit;
    var sub;
    if (status === "trading") sub = "Exit: Auto → " + (EXIT_TXT[ex] || ex) + ". Buys only setups that clear your level.";
    else if (status === "watching") sub = "Edge found with " + (EXIT_TXT[ex] || ex) + ". Pick Adaptive in Trading mode to let it buy.";
    else sub = "Only watching: " + (a.reason || "its test hasn't made money on unseen coins yet") + ".";
    $("#adaptiveSub").textContent = sub;
    var per = (a.test && a.test.per_exit) || {};
    var rows = ["quick", "swing", "runner"].map(function (k) {
      var p = per[k] || {};
      var n = num(p.trades) || 0;
      return '<div class="ad-row' + (k === ex ? " pick" : "") + '"><span class="ad-ex">' + esc((EXIT_TXT[k] || k).split(" ")[0]) +
        (k === ex ? ' <i>auto</i>' : "") + '</span><span class="ad-n">' + n + (n === 1 ? " test" : " tests") + "</span>" +
        '<span class="ad-avg ' + cls(p.avg_pct) + '">' + (n ? pct(p.avg_pct) + " avg" : "—") + "</span>" +
        '<span class="ad-tot ' + cls(p.total_usd) + '">' + (n ? money(p.total_usd) : "—") + "</span></div>";
    }).join("");
    var t = a.test || {};
    $("#adaptiveTest").innerHTML = rows + '<p class="ad-note">Fair test: learns from the older ' + (num(t.train_coins) || 0) +
      " coins, trades the newest " + (num(t.test_coins) || 0) + " it never saw ($5, one per coin, fees in). Trades only if ≥5 tests, positive avg and total.</p>";
    var conv = a.conviction || "normal";
    if (view.pending && (view.pending === conv || Date.now() - view.pendingAt > 90000)) view.pending = null;
    var shown = view.pending || conv;
    $("#adaptiveConv").innerHTML = LEVELS.map(function (l) {
      return '<button type="button" class="ad-conv' + (l[0] === shown ? " on" : "") + '" data-adaptive-conv="' + l[0] + '"' +
        (view.pending ? " disabled" : "") + ' aria-pressed="' + (l[0] === conv) + '" title="' + esc(l[2]) + '">' + l[1] + "</button>";
    }).join("");
    var lv = LEVELS.filter(function (l) { return l[0] === shown; })[0] || LEVELS[1];
    var cands = Array.isArray(a.candidates) ? a.candidates : [];
    var ch = '<p class="ad-note">' + esc(lv[1]) + ": buys when similar setups had " + esc(lv[2]) + " · $" + ((a.cfg && a.cfg.buy_usd) || 20) + " a trade · max " + ((a.cfg && a.cfg.max_open) || 5) + " open</p>";
    if (cands.length) {
      ch += cands.slice(0, 3).map(function (c) {
        return '<div class="ad-cand"><a href="' + esc(c.link || "#") + '" target="_blank" rel="noopener">' + esc(c.symbol || String(c.mint || "").slice(0, 6)) + "</a>" +
          '<span class="' + cls(c.ev) + '">EV ' + pct(c.ev) + "</span><span>win " + (num(c.win) != null ? Math.round(c.win * 100) + "%" : "—") + "</span>" +
          (c.qualifies ? '<span class="ad-q">qualifies</span>' : '<span class="ad-q no">below level</span>') + "</div>";
      }).join("");
    } else {
      ch += '<p class="ad-note">' + (num(a.live_candidates) || 0) + " coins fit right now (under 6 h, $8k+ liquidity)" + (d.resolved >= 40 ? "." : " · needs 40+ finished setups to score.") + "</p>";
    }
    $("#adaptiveCands").innerHTML = ch;
  }

  function onClick(e) {
    var b = e.target.closest("[data-adaptive-conv]");
    if (!b) return false;
    var lv = b.getAttribute("data-adaptive-conv");
    if (hooks.post && /^(cautious|normal|bold)$/.test(lv)) {
      view.pending = lv; view.pendingAt = Date.now();
      hooks.post(lv);
    }
    return true;
  }
  function clearPending() { view.pending = null; }

  root.BuddyAdaptive = { render: render, onClick: onClick, hooks: hooks, clearPending: clearPending };
})(typeof window !== "undefined" ? window : globalThis);
