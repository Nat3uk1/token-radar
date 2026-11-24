// Token Launch Radar's dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked pre-token board, a live-token comparison view, filters, sortable columns and
// a per-protocol detail view with the model's own arithmetic and the protocol's farm plan.
// No network: every byte it shows arrives in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watch: false, tab: 'board', sort: 'rank', dir: 1, selected: null };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(2) + 'x';
  }
  function chainLine(r) {
    return r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'an unnamed chain';
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('watch') === '1') state.watch = true;
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watch) params.set('watch', '1');
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, 'Model ', el('b', { text: DATA.model_version })),
        el('span', null, 'Market multiple ', el('b', { text: fmtMult(DATA.global_multiple) }))
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, DATA.board_size + ' pre-token protocols, ', el('em', { text: 'priced before they launch' })),
        el('p', { text: 'Every protocol here records no token. The model prices each one from the protocols that already trade: a category multiple learned from ' + DATA.comparables + ' tokenised protocols, adjusted for 7-day growth, for how long the protocol has run with no token, and for its chain reach. The watchlist is the floor, not the ceiling: ' + DATA.early_size + ' further rows are priced from beyond it. An implied value is a model, never a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Rows on the board' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Beyond the watchlist' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live tokens compared' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function select(id, label, values, current, onChange) {
      var sel = el('select', { id: id, 'aria-label': label },
        el('option', { value: 'all', text: label === 'Category' ? 'All categories' : 'All chains' }),
        values.map(function (v) { return el('option', { value: v, text: v, selected: v === current ? 'selected' : null }); })
      );
      sel.addEventListener('change', function () { onChange(sel.value); writeHash(); render(); });
      return sel;
    }
    var watchBox = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null });
    watchBox.addEventListener('change', function () { state.watch = watchBox.checked; writeHash(); render(); });
    var boardTab = el('button', { type: 'button', 'aria-pressed': state.tab === 'board' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'board'; writeHash(); render(); } });
    var liveTab = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live tokens', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select('category', 'Category', categories, state.category, function (v) { state.category = v; })),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), select('chain', 'Chain', chains, state.chain, function (v) { state.chain = v; })),
      el('div', { class: 'field check' }, watchBox, el('label', { for: 'watch', text: 'Watchlist only' })),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }), el('div', { class: 'tabs' }, boardTab, liveTab)),
      el('span', { class: 'count', text: state.tab === 'board' ? visibleRows().length + ' of ' + DATA.board_size + ' rows' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    var arrow = state.sort === key ? (state.dir > 0 ? ' ^' : ' v') : '';
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; }
        render();
      } }, label + arrow)
    );
  }

  function boardTable() {
    var list = sorted(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'Nothing on the scope matches' }),
        el('p', { text: 'Clear the search, or widen the category and chain filters.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    var tbody = el('tbody');
    if (list.length === 0) {
      var empty = el('tr');
      empty.appendChild(el('td', { colspan: '9', class: 'empty', text: 'No protocol on the board matches this filter. Clear the search or pick another category or chain.' }));
      tbody.appendChild(empty);
    }
    list.forEach(function (r) {
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          r.on_watchlist ? el('span', { class: 'badge', text: 'Watchlist' }) : null,
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + chainLine(r) })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.category_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / (max || 1)) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token on record' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Pre-token protocols ranked by implied value. Select any row for its model breakdown and farm plan.' }),
        el('thead', null, el('tr', null,
          sortHeader('rank', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
          sortHeader('growth', '7d'), sortHeader('age', 'Age'), el('th', { scope: 'col', text: 'Cat x' }),
          sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Token' })
        )),
        tbody
      )
    ));
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', { onclick: null },
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + chainLine(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtMult(r.multiple) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'These protocols already have a token: their market cap is a fact from the snapshot, not a model output. They are the comparables the board\u2019s multiples are learned from, and they are never ranked as launches.' }),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }),
          el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }),
          el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' })
        )),
        tbody
      )
    ));
  }

  function modelPanel() {
    var m = DATA.model;
    var cells = DATA.categories.slice(0, 12).map(function (c) {
      return el('div', { class: 'cat-cell' }, c.category, el('b', { text: fmtMult(c.multiple) }), el('span', { text: 'from ' + c.comparables + ' tokenised protocols' }));
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How the radar prices a launch' }),
      el('p', { text: 'One function prices every row, from the snapshot\u2019s figures alone. No protocol name is special-cased. A category\u2019s multiple is the median market-cap-to-TVL ratio of its tokenised protocols, shrunk toward the market-wide ' + fmtMult(DATA.global_multiple) + ' by sample size (shrink constant ' + m.shrink_k + '), then clipped to ' + m.mult_floor + 'x\u2013' + m.mult_cap + 'x so a thin category cannot produce a fantasy price. Growth, age and chain reach adjust it within narrow bands.' }),
      el('div', { class: 'formula', text: 'implied = tvl x category_multiple x (1 + clamp(change_7d, ' + m.growth_floor_pct + ', ' + m.growth_cap_pct + ') x ' + m.growth_weight + ' / 100) x age_factor x (1 + ' + m.reach_per_chain + ' x extra_chains)' }),
      el('div', { class: 'cat-grid' }, cells),
      el('p', { class: 'sub', text: 'Age factor: ' + m.age_floor + ' on day one, rising to ' + (m.age_floor + m.age_range).toFixed(2) + ' over ' + m.age_days_cap + ' days; a protocol with no listing date gets ' + m.unknown_age_factor + '. Products of assets that already trade (bridges, liquid staking, wrapped or staked names, exchange books, versioned pools) are left off the board: they are not launches.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });

  function stepParts(s) {
    var at = s.indexOf(' Cost: ');
    if (at < 0) return { action: s, tail: '' };
    return { action: s.slice(0, at), tail: s.slice(at + 1) };
  }

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.on_watchlist ? ' · on the watchlist' : ' · below the watchlist floor') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' · ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · listed ' + (row.age_days === null ? 'on an unknown date' : fmtAge(row.age_days) + ' ago') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value, step by step' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category x (' + row.category_comparables + ' comps)' }), el('b', { class: 'num', text: fmtMult(row.category_multiple) })),
        el('div', null, el('span', { text: 'Growth ' + fmtPct(row.change_7d) }), el('b', { class: 'num', text: fmtMult(row.growth_factor) })),
        el('div', null, el('span', { text: 'Age factor' }), el('b', { class: 'num', text: fmtMult(row.age_factor) })),
        el('div', null, el('span', { text: 'Reach factor' }), el('b', { class: 'num', text: fmtMult(row.reach_factor) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ' prices this protocol exactly as it prices every other: TVL times the four factors. Factors are displayed rounded; the board\u2019s figure is computed before rounding. It is an estimate of what a token could be worth on this record, not a price and not a prediction that a token will exist.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var parts = stepParts(s);
        return el('li', null, el('b', { text: parts.action }), parts.tail ? el('span', { class: 'cost', text: parts.tail }) : null);
      }))
    ));
    if (!dialog.isConnected) app.appendChild(dialog);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'board' ? boardTable() : liveTable());
    if (state.tab === 'board') shell.appendChild(modelPanel());
    shell.appendChild(el('p', { class: 'foot', text: 'Built from one sealed DefiLlama snapshot (' + DATA.as_of + '). Records say a protocol has no token on record; a record is not proof none exists. Nothing here is financial advice.' }));
    app.appendChild(shell);
    app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
  if (state.selected) openDetail(state.selected);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
