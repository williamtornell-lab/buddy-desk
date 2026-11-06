(() => {
  const $ = (s) => document.querySelector(s);
  const state = { data: null };
  function dataPath() {
    const h = location.hash || '';
    const m = h.match(/[#&]d=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function showErr(msg) {
    const e = $('#err'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg);
  }
  async function load() {
    const d = dataPath();
    if (!d) { $('#empty').classList.remove('hidden'); showErr(''); return; }
    $('#empty').classList.add('hidden');
    try {
      const r = await fetch('d/' + encodeURIComponent(d) + '/state.json?_=' + Date.now(), { cache: 'no-store' });
      if (r.status === 404) { showErr('No data path (404). Buddy may not have published yet.'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.data = await r.json();
      showErr('');
      render();
    } catch (e) {
      showErr('Buddy offline or path wrong: ' + e.message);
    }
  }
  function render() {
    const s = state.data; if (!s) return;
    $('#modePill').textContent = s.mode || 'PAPER';
    $('#modePill').classList.toggle('live', s.mode === 'LIVE');
    $('#bal').textContent = '$' + (s.balance || 0).toFixed(2);
    const pos = $('#positions');
    if (!s.positions || !s.positions.length) {
      pos.innerHTML = '<div class="card muted">No open positions</div>';
    } else {
      pos.innerHTML = s.positions.map(p => {
        return '<div class="card"><h3>' + (p.name||p.symbol||String(p.mint).slice(0,8)) +
          ' <span class="muted">' + p.status + '</span></h3><div>$' + Number(p.size_usd).toFixed(2) +
          ' · entry ' + Number(p.entry).toPrecision(4) + '</div><div class="muted">stop -' + p.stop_pct +
          '% · <a href="' + p.link + '" target="_blank" rel="noopener">Sell on FOMO</a></div></div>';
      }).join('');
    }
    const act = $('#activity');
    act.innerHTML = (s.activity||[]).map(a => {
      return '<div class="row"><div><div>' + (a.title||a.kind) + '</div><div class="muted">' +
        (a.detail||'') + '</div></div><div>' + (a.link ? '<a href="'+a.link+'" target="_blank" rel="noopener">FOMO</a>' : '') +
        '</div></div>';
    }).join('') || '<div class="muted">No activity yet</div>';
    const ac = $('#agentCards');
    const ag = s.agents || {};
    ac.innerHTML = Object.keys(ag).map(name => {
      const a = ag[name];
      const age = a.age_s != null ? Math.round(a.age_s) + 's' : '—';
      return '<div class="card"><h3>' + name + '</h3><div class="' + (a.paused?'bad':'ok') + '">' +
        (a.paused?'paused':'running') + ' · hb ' + age + '</div></div>';
    }).join('');
    $('#settingsBox').textContent = JSON.stringify(s.settings||{}, null, 2);
    if (s.signup_url) $('#signup').href = s.signup_url;
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('main .tab').forEach(x => x.classList.remove('on'));
    const tab = document.getElementById(b.dataset.tab);
    if (tab) tab.classList.add('on');
  });
  const back = $('#backHome');
  if (back) back.onclick = () => {
    document.querySelectorAll('main .tab').forEach(x => x.classList.remove('on'));
    $('#home').classList.add('on');
  };
  window.addEventListener('hashchange', load);
  load();
  setInterval(load, 15000);
})();
