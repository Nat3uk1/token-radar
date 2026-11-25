// Token Launch Radar (radar-3) dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the model's own held-out evidence, the protocol
// accounting, a traded-comparables view, and a detail view per protocol with the value
// waterfall, the nearest priced peers, the farm verdict and the costed farm plan.
// The verdicts are re-run live from each row's plan steps when the reader moves the scenario
// (drop share, horizon); the model itself never moves. No network: every byte arrives in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var S = DATA.scenario;
  var state = { q: '', category: 'all', chain: 'all', tier: 'all', scope: 'all', tab: 'board', sort: 'rank', dir: 1, selected: null, share: Math.round(S.drop_share * 1000) / 10, weeks: S.weeks };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function fmtMoney(n) { // signed, cents where small
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '-' : '';
    var a = Math.abs(n);
    return sign + '$' + (a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(2));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' yr';
    return Math.max(0, Math.round(days)) + ' d';
  }
  function fmtX(n) { return n === null || n === undefined ? 'n/a' : 'x' + Number(n).toFixed(2); }
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

  // The verdict arithmetic, the same the model ran: drop less the plan's fees and the
  // capital charge, against the $25-an-hour bar.
  function verdictFor(r, deposit, sharePct, weeks) {
    var fees = 0, minutes = 0;
    r.plan_steps.forEach(function (s) { fees += s.cost_fixed + s.cost_weekly * weeks; minutes += s.minutes_fixed + s.minutes_weekly * weeks; });
    var hours = Math.max(minutes / 60, 0.05);
    var drop = (r.implied_value_usd * (sharePct / 100) * deposit) / (r.tvl_usd + deposit);
    var charge = S.capital_charge * deposit * (weeks / 52);
    var tbill = S.tbill_rate * deposit * (weeks / 52);
    var net = drop - fees - charge;
    var perHour = net / hours;
    return { verdict: net > 0 && perHour >= S.hour_bar ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP', deposit: deposit, drop: drop, fees: fees, charge: charge, tbill: tbill, net: net, hours: hours, perHour: perHour };
  }
  function rowVerdict(r) { return verdictFor(r, r.deposit, state.share, state.weeks); }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tier')) state.tier = params.get('tier');
    if (params.get('scope')) state.scope = params.get('scope');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('sort')) { state.sort = params.get('sort'); state.dir = state.sort === 'rank' || state.sort === 'name' ? 1 : -1; }
    if (params.get('share')) state.share = parseFloat(params.get('share'));
    if (params.get('weeks')) state.weeks = parseInt(params.get('weeks'), 10);
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.scope !== 'all') params.set('scope', state.scope);
    if (state.tab !== 'board') params.set('tab', state.tab);
    if (state.sort !== 'rank') params.set('sort', state.sort);
    if (state.share !== Math.round(S.drop_share * 1000) / 10) params.set('share', String(state.share));
    if (state.weeks !== S.weeks) params.set('weeks', String(state.weeks));
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.scope === 'watch' && !r.on_watchlist) return false;
      if (state.scope === 'early' && r.on_watchlist) return false;
      if (state.tier !== 'all' && rowVerdict(r).verdict !== state.tier) return false;
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
      else if (key === 'odds') { av = a.model.token_odds; bv = b.model.token_odds; }
      else if (key === 'launch') { av = a.model.launch_value_usd; bv = b.model.launch_value_usd; }
      else if (key === 'implied') { av = a.implied_value_usd; bv = b.implied_value_usd; }
      else if (key === 'net') { av = rowVerdict(a).net; bv = rowVerdict(b).net; }
      else if (key === 'hour') { av = rowVerdict(a).perHour; bv = rowVerdict(b).perHour; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', null, 'Launch Radar', el('small', { text: 'pre-token protocols, valued from their own record' }))),
      el('div', { class: 'top-meta' }, 'DefiLlama snapshot ', el('b', { text: DATA.as_of }), ' · model ', el('b', { text: DATA.model_version }), ' · fitted on this snapshot, no network')
    );
  }

  function kpis() {
    var farm = DATA.rows.filter(function (r) { return rowVerdict(r).verdict === 'FARM'; }).length;
    function card(label, big, note) {
      return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', null, big), el('p', { text: note }));
    }
    return el('section', { class: 'kpis' },
      card('Walk-forward miss', 'x' + DATA.launch.wf.toFixed(2), 'tokens listed earlier price those listed later; a flat multiple misses by x' + DATA.launch_ladder[0].second.toFixed(2) + ', leave-one-out x' + DATA.launch.loo.toFixed(2)),
      card('Is the printed range honest?', Math.round(DATA.bands.cover50 * 100) + '% · ' + Math.round(DATA.bands.cover80 * 100) + '%', 'of held-out caps fall inside P25-P75 (stated 50%) · P10-P90 (stated 80%)'),
      card('Token odds vs base rate, Brier', DATA.odds.wf.toFixed(3), 'walk-forward; the base rate alone scores ' + DATA.odds.base_wf.toFixed(3) + ', ten-fold ' + DATA.odds.tenfold.toFixed(3) + ' vs ' + DATA.odds.base_tenfold.toFixed(3)),
      card('Terms that survived both tests', DATA.launch_ladder.filter(function (x) { return x.verdict === 'kept'; }).length + ' of ' + (DATA.launch_ladder.length - 1) + ' · ' + DATA.odds_ladder.filter(function (x) { return x.verdict === 'kept'; }).length + ' of ' + (DATA.odds_ladder.length - 1), 'value model · odds model; the rest are shown below, not used'),
      card('Worth farming, this scenario', farm + ' of ' + DATA.board_size, 'net of fees and a capital charge beats $' + S.hour_bar + ' an hour at a ' + state.share + '% drop share over ' + state.weeks + ' weeks'),
      card('Watchlist ranked', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'plus ' + DATA.early_size + ' pre-token protocols the house list leaves out')
    );
  }

  var ACCT_COLORS = { 'ranked-watchlist': '#e8a33d', 'ranked-early': '#b97f26', comp: '#3fbfae', 'token-unpriced': '#54707a', 'out-bridge': '#5b6b82', 'out-staking': '#71628c', 'out-exchange': '#8c6262', 'out-versioned': '#4c565f' };
  function boardChecksum() {
    var h = 2166136261;
    var text = DATA.rows.map(function (r) { return r.rank + ':' + r.slug + ':' + r.implied_value_usd; }).join('|');
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function accounting() {
    var total = DATA.accounting.reduce(function (a, g) { return a + g.count; }, 0);
    var bar = el('div', { class: 'acct-bar' }, DATA.accounting.map(function (g) {
      return el('i', { style: 'width:' + (g.count / total * 100) + '%;background:' + ACCT_COLORS[g.key] });
    }));
    var legend = el('div', { class: 'acct-legend' }, DATA.accounting.map(function (g) {
      return el('span', null, el('i', { style: 'background:' + ACCT_COLORS[g.key] }), g.label + ' ', el('b', { text: String(g.count) }));
    }));
    var inOrder = true, nonRising = true;
    DATA.rows.forEach(function (r, i) {
      if (r.rank !== i + 1) inOrder = false;
      if (i > 0 && r.implied_value_usd > DATA.rows[i - 1].implied_value_usd) nonRising = false;
    });
    var sum = DATA.rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var ticks = [
      'this table = board.json: ' + DATA.board_size + ' of ' + DATA.board_size + ' rows recomputed here',
      inOrder && nonRising ? 'ranks 1-' + DATA.board_size + ' in order, values never rise' : 'rank order broken',
      'totals equal: ' + fmtUsd(sum) + (sum === DATA.totals.implied_usd ? '' : ' (differs)'),
      'checksum ' + boardChecksum() + (boardChecksum() === DATA.totals.checksum ? ' = main.ts' : ' != main.ts'),
      'watchlist ' + DATA.watchlist_size + ' of ' + DATA.watchlist_size + ' ranked',
      'ledger ' + total + ' of ' + total + ' protocols'
    ];
    return el('section', { class: 'panel' },
      el('h2', null, 'Protocol accounting', el('span', { class: 'sub', text: 'all ' + total + ' snapshot protocols in exactly one group' })),
      bar, legend,
      el('div', { class: 'checks' }, ticks.map(function (t) { return el('span', { text: '✓ ' + t }); }))
    );
  }

  function ladderTable(title, rows, firstHead, secondHead) {
    return el('div', null,
      el('h3', { text: title }),
      el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Term, added in order' }), el('th', { text: firstHead }), el('th', { text: secondHead }), el('th', { text: 'Verdict' }))),
        el('tbody', null, rows.map(function (r) {
          return el('tr', null,
            el('td', { text: r.label }),
            el('td', { text: String(r.first) }),
            el('td', { text: String(r.second) }),
            el('td', { class: r.verdict === 'kept' ? 'kept' : r.verdict === 'baseline' ? 'base' : 'dropped', text: r.verdict === 'baseline' ? 'baseline' : r.verdict })
          );
        }))
      )
    );
  }
  function evidence() {
    return el('section', { class: 'panel' },
      el('h2', null, 'Out-of-sample evidence', el('span', { class: 'sub', text: 'a term is kept only if it lowers the held-out miss in both tests' })),
      el('div', { class: 'evidence' },
        ladderTable('Value if a token launches · typical miss, ' + DATA.comps + ' traded tokens', DATA.launch_ladder, 'Leave-one-out', 'Walk-forward'),
        ladderTable('Token odds · Brier score, ' + DATA.odds_population + ' peers', DATA.odds_ladder, 'Ten-fold', 'Walk-forward'),
        el('div', null,
          el('h3', { text: 'Is the printed range honest?' }),
          el('table', null,
            el('thead', null, el('tr', null, el('th', { text: 'Share of real caps' }), el('th', { text: 'Held out' }))),
            el('tbody', null,
              el('tr', null, el('td', { text: 'within x3 of the model' }), el('td', { text: Math.round(DATA.bands.within3 * 100) + '%' })),
              el('tr', null, el('td', { text: 'inside P25-P75, stated 50%' }), el('td', { text: Math.round(DATA.bands.cover50 * 100) + '%' })),
              el('tr', null, el('td', { text: 'inside P10-P90, stated 80%' }), el('td', { text: Math.round(DATA.bands.cover80 * 100) + '%' }))
            )
          ),
          el('p', { class: 'sub', text: 'Fitted: ln cap = ' + DATA.curve.intercept.toFixed(2) + ' + ' + DATA.curve.slope.toFixed(2) + ' (±' + DATA.curve.slope_se.toFixed(2) + ' bootstrap) x ln(TVL / $100M), so the cap at $100M of TVL is ' + fmtUsd(DATA.curve.at_100m_usd) + ' before its category effect; category effects are shrunk by ' + DATA.curve.shrink + ' pseudo-observations. Bands are the leave-one-out residuals of that fit, read as multipliers: P25 x' + DATA.bands.q25.toFixed(2) + ' · P75 x' + DATA.bands.q75.toFixed(2) + '.' })
        ),
        el('p', { class: 'note', text: 'Reading it: 7-day growth and age fail to price a token better in both tests, so the value model leaves them out; age still tells which peers record a token, so it enters through the odds. The odds are the peers\u2019 record (' + DATA.odds_population + ' dated protocols), not a forecast: the page never says a token will launch.' })
      )
    );
  }

  function chip(label, count, active, onclick) {
    return el('button', { class: 'chip', 'aria-pressed': String(!!active), onclick: onclick },
      label + (count !== null ? ' ' : ''), count !== null ? el('span', { class: 'n', text: String(count) }) : null);
  }
  function controls(count) {
    var counts = { all: 0, FARM: 0, MARGINAL: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { counts.all++; counts[rowVerdict(r).verdict]++; });
    var cats = ['all'].concat(DATA.categories.map(function (c) { return c.category; }));
    var chains = ['all'];
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); }); });
    chains = chains.slice(0, 1).concat(chains.slice(1).sort());
    function select(id, value, options, onchange) {
      var node = el('select', { id: id, onchange: function (e) { onchange(e.target.value); } },
        options.map(function (o) { return el('option', { value: o.value, text: o.label, selected: o.value === value ? 'selected' : null }); }));
      node.value = value;
      return node;
    }
    var shareVal = el('b', { class: 'num', text: state.share.toFixed(1) + '%' });
    var weeksVal = el('b', { class: 'num', text: state.weeks + ' wk' });
    return el('section', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }),
        el('div', { class: 'chips' },
          chip('The board', null, state.tab === 'board', function () { state.tab = 'board'; render(); }),
          chip('Traded tokens', null, state.tab === 'traded', function () { state.tab = 'traded'; render(); })
        )),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Verdict at this scenario' }),
        el('div', { class: 'chips' },
          chip('All', counts.all, state.tier === 'all', function () { state.tier = 'all'; render(); }),
          chip('Farm', counts.FARM, state.tier === 'FARM', function () { state.tier = 'FARM'; render(); }),
          chip('Marginal', counts.MARGINAL, state.tier === 'MARGINAL', function () { state.tier = 'MARGINAL'; render(); }),
          chip('Skip', counts.SKIP, state.tier === 'SKIP', function () { state.tier = 'SKIP'; render(); })
        )),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'List' }),
        el('div', { class: 'chips' },
          chip('All', DATA.board_size, state.scope === 'all', function () { state.scope = 'all'; render(); }),
          chip('Watchlist', DATA.watchlist_size, state.scope === 'watch', function () { state.scope = 'watch'; render(); }),
          chip('Early', DATA.early_size, state.scope === 'early', function () { state.scope = 'early'; render(); })
        )),
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }),
        el('input', { type: 'search', id: 'q', placeholder: 'name, category, chain', value: state.q, oninput: function (e) { state.q = e.target.value; render(false); } })),
      el('div', { class: 'field' }, el('label', { for: 'cat', text: 'Category' }),
        select('cat', state.category, cats.map(function (c) { return { value: c, label: c === 'all' ? 'All categories' : c }; }), function (v) { state.category = v; render(); })),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }),
        select('chain', state.chain, chains.map(function (c) { return { value: c, label: c === 'all' ? 'All chains' : c }; }), function (v) { state.chain = v; render(); })),
      el('div', { class: 'field' }, el('span', { class: 'lab' }, 'Drop share ', shareVal),
        el('input', { type: 'range', id: 'share-range', min: '1', max: '20', step: '0.5', value: String(state.share), oninput: function (e) { state.share = parseFloat(e.target.value); shareVal.textContent = state.share.toFixed(1) + '%'; render(false); } })),
      el('div', { class: 'field' }, el('span', { class: 'lab' }, 'Horizon ', weeksVal),
        el('input', { type: 'range', id: 'weeks-range', min: '4', max: '26', step: '1', value: String(state.weeks), oninput: function (e) { state.weeks = parseInt(e.target.value, 10); weeksVal.textContent = state.weeks + ' wk'; render(false); } })),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Board' }),
        el('div', { class: 'chips' },
          el('button', { class: 'btn', onclick: function () { exportBoard('json'); }, text: 'board.json' }),
          el('button', { class: 'btn', onclick: function () { exportBoard('csv'); }, text: 'CSV' }),
          el('button', { class: 'btn', onclick: function () { state = { q: '', category: 'all', chain: 'all', tier: 'all', scope: 'all', tab: 'board', sort: 'rank', dir: 1, selected: null, share: Math.round(S.drop_share * 1000) / 10, weeks: S.weeks }; render(); }, text: 'Reset' })
        )),
      el('span', { class: 'count', text: state.tab === 'board' ? count + ' of ' + DATA.board_size + ' rows' : DATA.live_size + ' traded tokens' })
    );
  }

  function sortTh(label, key) {
    var mark = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return el('th', null, el('button', { onclick: function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'rank' || key === 'name' ? 1 : -1; }
      render();
    }, text: label + mark }));
  }
  function barCell(pct, cls) {
    return el('span', null, el('span', { class: 'bar ' + cls }, el('i', { style: 'width:' + Math.max(2, Math.min(100, pct * 100)) + '%' })), el('span', { class: 'num', text: Math.round(pct * 100) + '%' }));
  }
  function boardTable(rows) {
    var caption = el('caption', { text: 'Implied value = value if it launches x token odds. Verdicts re-run live at the scenario above; deposits are sized per plan (the smallest, up to $25,000, that clears the bar) and the capital charge is 2% a year. Open a row for the waterfall, the priced peers and the plan.' });
    var head = el('thead', null, el('tr', null,
      sortTh('Rank', 'rank'), sortTh('Protocol', 'name'), sortTh('TVL', 'tvl'), sortTh('7d', 'growth'), sortTh('No-token age', 'age'), sortTh('Token odds', 'odds'), sortTh('If it launches', 'launch'), sortTh('Implied', 'implied'), sortTh('Verdict · net', 'net'), sortTh('Net / hour', 'hour'), el('th', { text: 'Farm plan' })
    ));
    var body = el('tbody', null, rows.map(function (r) {
      var v = rowVerdict(r);
      var rowAttrs = { onclick: function () { state.selected = r.slug; render(); window.scrollTo(0, 0); } };
      if (r.rank <= 3) rowAttrs.class = 'toprow';
      return el('tr', rowAttrs,
        el('td', { class: 'rank' }, String(r.rank), el('span', { class: 'rng', text: r.model.rank_lo === r.model.rank_hi ? '' : r.model.rank_lo + '-' + r.model.rank_hi })),
        el('td', { class: 'name' }, el('b', { text: r.name }),
          r.on_watchlist ? el('span', { class: 'badge watch', text: 'Watchlist' }) : el('span', { class: 'badge early', text: 'Off-list' }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + chainLine(r) })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: r.change_7d === null ? '' : r.change_7d >= 0 ? 'num pos' : 'num neg', text: r.change_7d === null ? 'n/a' : fmtPct(r.change_7d) }),
        el('td', null, el('span', { class: 'bar age' }, el('i', { style: 'width:' + (r.age_days === null ? 0 : Math.min(100, r.age_days / 1460 * 100)) + '%' })), el('span', { class: 'num', text: fmtAge(r.age_days) })),
        el('td', null, barCell(r.model.token_odds, 'odds')),
        el('td', { class: 'num', text: fmtUsd(r.model.launch_value_usd) }),
        el('td', { class: 'implied' }, el('b', { text: fmtUsd(r.implied_value_usd) }), el('span', { class: 'rng', text: fmtUsd(r.model.p25_usd) + '-' + fmtUsd(r.model.p75_usd) })),
        el('td', null, el('span', { class: 'verdict ' + v.verdict, text: v.verdict }), el('span', { class: 'vsub', text: fmtMoney(v.net) })),
        el('td', { class: 'vnet ' + (v.perHour >= 0 ? 'pos' : 'neg'), text: fmtMoney(v.perHour) }),
        el('td', { class: 'plan-kind', text: r.plan_kind })
      );
    }));
    if (!rows.length) return el('div', { class: 'empty', text: 'No protocol matches these filters. Widen the search, or reset the board.' });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'board' }, caption, head, body));
  }

  function tradedTable() {
    var head = el('thead', null, el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { text: 'TVL' }), el('th', { text: 'Real cap' }), el('th', { text: 'Model, fitted' }), el('th', { text: 'Model, blind' }), el('th', { text: 'Blind miss' })
    ));
    var body = el('tbody', null, DATA.live.map(function (r) {
      return el('tr', null,
        el('td', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + chainLine(r) })),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.fitted_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.blind_usd) }),
        el('td', { class: 'num', text: 'x' + r.miss.toFixed(2) })
      );
    }));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'board' },
      el('caption', { text: 'The comparables the value model was fitted on: the largest ' + DATA.live_size + ' traded tokens of the ' + DATA.comps + ' the model uses. "Blind" prices each token from a fit that never saw it - the honest test behind every number on the board.' }),
      head, body));
  }

  function exportBoard(kind) {
    var rows = sorted(visibleRows());
    var text;
    if (kind === 'json') {
      text = JSON.stringify({ rows: rows.map(function (r) { return { rank: r.rank, slug: r.slug, name: r.name, implied_value_usd: r.implied_value_usd, farm_steps: r.farm_steps }; }) }, null, 2);
    } else {
      var lines = ['rank,name,category,tvl_usd,change_7d,age_days,token_odds,launch_value_usd,implied_value_usd,p25_usd,p75_usd,verdict,net_usd,net_per_hour'];
      rows.forEach(function (r) {
        var v = rowVerdict(r);
        lines.push([r.rank, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.model.token_odds.toFixed(3), r.model.launch_value_usd, r.implied_value_usd, r.model.p25_usd, r.model.p75_usd, v.verdict, v.net.toFixed(2), v.perHour.toFixed(2)].join(','));
      });
      text = lines.join('\n');
    }
    var blob = new Blob([text], { type: 'text/plain' });
    var a = el('a', { href: URL.createObjectURL(blob), download: kind === 'json' ? 'board.json' : 'board.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function waterfall(r) {
    var m = r.model;
    var droppedTerms = DATA.launch_ladder.filter(function (x) { return x.verdict === 'tested, not kept'; }).map(function (x) { return x.label.replace(/^\+\s*/, '').replace(', years listed', '').replace(', ln', ''); }).join(', ');
    function row(label, why, value) {
      return el('tr', null, el('td', null, label, el('span', { class: 'why', text: why })), el('td', { text: value }));
    }
    return el('table', { class: 'waterfall' },
      row('Total value locked', 'the protocol\u2019s own figure in the snapshot', fmtUsd(r.tvl_usd)),
      row('Curve value at this TVL', 'ln cap = ' + DATA.curve.intercept.toFixed(2) + ' + ' + DATA.curve.slope.toFixed(2) + ' (±' + DATA.curve.slope_se.toFixed(2) + ') x ln(TVL / $100M); a size curve, not a multiple: value per dollar of TVL falls as TVL grows', fmtUsd(r.curve_base_usd)),
      row('x category effect, ' + (r.category || 'Uncategorised'), r.category_comps + ' traded peers in the category, their effect shrunk by ' + DATA.curve.shrink + ' pseudo-observations toward the curve', 'x' + r.category_factor.toFixed(2)),
      row('= value if a token launches', 'the curve and its category, nothing else: ' + droppedTerms + ' were tested on held-out tokens and left out', fmtUsd(m.launch_value_usd)),
      row('x token odds, next ' + DATA.odds.horizon_years + ' years', r.age_known
        ? 'peers that record a token: ' + Math.round(r.share_now * 100) + '% by this protocol\u2019s age, ' + Math.round(r.share_later * 100) + '% by age + ' + DATA.odds.horizon_years + ' years, so (' + Math.round(r.share_later * 100) + ' - ' + Math.round(r.share_now * 100) + ') / (100 - ' + Math.round(r.share_now * 100) + ') of the remainder'
        : 'the protocol records no listing date, so the odds use the board\u2019s median age; the age itself is unknown', Math.round(m.token_odds * 100) + '%'),
      el('tr', { class: 'total' }, el('td', null, '= implied value', el('span', { class: 'why', text: 'P25-P75 ' + fmtUsd(m.p25_usd) + ' to ' + fmtUsd(m.p75_usd) + ' · P10-P90 ' + fmtUsd(m.p10_usd) + ' to ' + fmtUsd(m.p90_usd) + ', the leave-one-out spread of the fit' })), el('td', { text: fmtUsd(r.implied_value_usd) }))
    );
  }

  function peersTable(r) {
    if (!r.peers.length) return el('p', { class: 'sub', text: 'No traded peer in this category was fitted; the value rests on the curve alone.' });
    return el('table', { class: 'mini' },
      el('thead', null, el('tr', null, el('th', { text: 'Peer' }), el('th', { text: 'TVL' }), el('th', { text: 'Real cap' }), el('th', { text: 'Blind price' }), el('th', { text: 'Miss' }))),
      el('tbody', null, r.peers.map(function (p) {
        return el('tr', null, el('td', { text: p.name }), el('td', { text: fmtUsd(p.tvl_usd) }), el('td', { text: fmtUsd(p.mcap_usd) }), el('td', { text: fmtUsd(p.blind_usd) }), el('td', { text: 'x' + p.miss.toFixed(2) }));
      }))
    );
  }

  function verdictPanel(r) {
    var v = rowVerdict(r);
    var share = state.share / 100;
    var breakShare = v.drop > 0 ? ((v.fees + v.charge) / v.drop) * state.share : null;
    var breakOdds = v.drop > 0 ? r.model.token_odds * ((v.fees + v.charge) / v.drop) : null;
    var narrative = v.verdict === 'FARM'
      ? 'At the reader\u2019s scenario the plan pays its costs and the $' + S.hour_bar + '-an-hour bar: the modelled drop covers the plan\u2019s fees and the capital charge with ' + fmtMoney(v.net) + ' to spare. It rests on the odds above, which are the peers\u2019 record, not a promise.'
      : v.verdict === 'MARGINAL'
        ? 'The modelled drop covers the plan\u2019s costs but not the $' + S.hour_bar + '-an-hour bar for the hands-on time. Worth it only if the position is wanted anyway, or the drop share comes in above ' + state.share.toFixed(1) + '%.'
        : 'At the reader\u2019s scenario the modelled drop does not cover the plan\u2019s own fees and capital charge. The honest move is to skip it unless the position itself is wanted.';
    var shares = [state.share / 2, state.share, state.share * 2];
    var deps = [1000, 3000, r.deposit, 30000].filter(function (d, i, a) { return a.indexOf(d) === i; }).sort(function (a, b) { return a - b; });
    var grid = el('table', { class: 'grid-net' },
      el('thead', null, el('tr', null, el('th', { text: 'Net at share \\ deposit' }), deps.map(function (d) { return el('th', { text: fmtUsd(d) }); }))),
      el('tbody', null, shares.map(function (s) {
        return el('tr', null, el('th', { text: s.toFixed(1) + '%' }), deps.map(function (d) {
          var cell = verdictFor(r, d, s, state.weeks);
          var isPlan = Math.abs(s - state.share) < 0.01 && d === r.deposit;
          return el('td', { class: (isPlan ? 'plan ' : '') + (cell.net >= 0 ? 'good' : 'bad'), text: fmtMoney(cell.net) });
        }));
      }))
    );
    return el('div', null,
      el('p', null, el('span', { class: 'verdict ' + v.verdict, text: v.verdict }), ' ', el('span', { text: narrative })),
      el('table', { class: 'mini' },
        el('tbody', null,
          el('tr', null, el('td', { text: 'Deposit, sized for this plan' }), el('td', { text: fmtMoney(v.deposit) })),
          el('tr', null, el('td', { text: 'Modelled drop at ' + state.share.toFixed(1) + '% of implied value' }), el('td', { text: fmtMoney(v.drop) })),
          el('tr', null, el('td', { text: 'Plan fees over ' + state.weeks + ' weeks' }), el('td', { text: '-' + fmtMoney(v.fees) })),
          el('tr', null, el('td', { text: 'Capital charge, 2% a year on the deposit' }), el('td', { text: '-' + fmtMoney(v.charge) })),
          el('tr', null, el('td', { text: 'Net, and per hands-on hour (' + v.hours.toFixed(1) + ' h)' }), el('td', { text: fmtMoney(v.net) + ' · ' + fmtMoney(v.perHour) + '/h' })),
          el('tr', null, el('td', { text: 'The same deposit in a T-bill at 4% would make' }), el('td', { text: fmtMoney(v.tbill) })),
          el('tr', null, el('td', { text: 'Break-even drop share / token odds' }), el('td', { text: (breakShare === null ? 'n/a' : breakShare.toFixed(1) + '%') + ' / ' + (breakOdds === null ? 'n/a' : Math.round(breakOdds * 100) + '%') })),
          el('tr', null, el('td', { text: 'Exit trigger' }), el('td', { text: 'stop if TVL falls 30% or week ' + Math.max(2, Math.round(state.weeks / 2)) + ' passes with no points programme' }))
        )
      ),
      grid,
      el('p', { class: 'sub', text: 'Drop = implied value x drop share x deposit / (TVL + deposit). The outlined cell is the plan as written; the grid re-runs it at other shares and deposits, same horizon.' })
    );
  }

  function movesTable(r) {
    function row(label, value) {
      var delta = value / r.implied_value_usd - 1;
      return el('tr', null, el('td', { text: label }), el('td', { text: fmtUsd(value) }), el('td', { class: delta >= 0 ? 'pos' : 'neg', text: fmtPct(delta * 100) }));
    }
    return el('table', { class: 'mini' },
      el('thead', null, el('tr', null, el('th', { text: 'If this changes' }), el('th', { text: 'Implied becomes' }), el('th', { text: 'Move' }))),
      el('tbody', null,
        row('TVL falls 30%', r.moves.tvl_down),
        row('TVL rises 30%', r.moves.tvl_up),
        row('Six more months pass with no token', r.moves.six_months),
        row('The category effect is ignored', r.moves.no_category)
      )
    );
  }

  function planList(r) {
    var items = r.plan_steps.map(function (s) {
      var cost = s.cost_fixed + s.cost_weekly * state.weeks;
      var mins = s.minutes_fixed + s.minutes_weekly * state.weeks;
      return el('li', null,
        el('span', { class: 'no' }),
        el('div', { class: 'body' }, el('p', null, el('span', { class: 'tag', text: s.tag }), s.text)),
        el('div', { class: 'costs' }, el('b', { text: 'COST ' + fmtMoney(cost) }), 'TIME ' + (mins >= 60 ? (mins / 60).toFixed(1) + ' h' : Math.round(mins) + ' min') + (s.cost_weekly > 0 || s.minutes_weekly > 0 ? ' over ' + state.weeks + ' wk' : ''))
      );
    });
    var v = rowVerdict(r);
    return el('div', null,
      el('ol', { class: 'steps' }, items),
      el('div', { class: 'budget', text: '' },
        'All in: ' + r.plan_steps.length + ' steps over ' + state.weeks + ' weeks · fees ' + fmtMoney(v.fees) + ' and a ' + fmtMoney(v.charge) + ' capital charge against a modelled ' + fmtMoney(v.drop) + ' drop · net ' + fmtMoney(v.net) + ', ' + fmtMoney(v.perHour) + ' an hour. ',
        el('span', { class: 'sub', text: 'Step costs are priced at the scenario horizon; the plan in board.json is written at ' + S.weeks + ' weeks.' })
      )
    );
  }

  function detail(r) {
    var m = r.model;
    var head = el('div', { class: 'detail-head' },
      el('div', null,
        el('div', { class: 'sub', text: '#' + r.rank + ' of ' + DATA.board_size + ' by implied value · ranks ' + m.rank_lo + '-' + m.rank_hi + ' across 200 bootstrap refits of the model' }),
        el('h1', null, r.name, r.on_watchlist ? el('span', { class: 'badge watch', text: 'Watchlist' }) : el('span', { class: 'badge early', text: 'Off-list' })),
        el('div', { class: 'sub', text: (r.category || 'Uncategorised') + ' · ' + chainLine(r) + ' · ' + r.slug }),
        el('div', { class: 'stat-chips' },
          el('span', { class: 'sc' }, 'TVL', el('b', { text: fmtUsd(r.tvl_usd) })),
          el('span', { class: 'sc' }, '7-day change', el('b', { text: r.change_7d === null ? 'n/a' : fmtPct(r.change_7d) })),
          el('span', { class: 'sc' }, 'Listed', el('b', { text: r.listed_at || 'not recorded' })),
          el('span', { class: 'sc' }, 'No-token age', el('b', { text: fmtAge(r.age_days) })),
          el('span', { class: 'sc' }, 'Verdict at this scenario', el('b', { text: rowVerdict(r).verdict }))
        )
      ),
      el('div', { class: 'implied-box' },
        el('span', { text: 'Implied value' }),
        el('div', { class: 'big', text: fmtUsd(r.implied_value_usd) }),
        el('p', null, 'If a token launches ', el('b', { text: fmtUsd(m.launch_value_usd) }), ' · token odds ', el('b', { text: Math.round(m.token_odds * 100) + '%' })),
        el('p', null, 'P25-P75 ', el('b', { text: fmtUsd(m.p25_usd) + ' - ' + fmtUsd(m.p75_usd) }), ' · P10-P90 ', el('b', { text: fmtUsd(m.p10_usd) + ' - ' + fmtUsd(m.p90_usd) })),
        el('p', { text: 'Recomputed from the printed coefficients; equals board.json. The protocol records no token, which is not proof it has none.' })
      )
    );
    return el('div', null,
      el('button', { class: 'back', onclick: function () { state.selected = null; render(); }, text: '← Back to the board' }),
      head,
      el('div', { class: 'cols' },
        el('section', { class: 'panel' }, el('h2', { text: 'How the figure is made' }), waterfall(r)),
        el('section', { class: 'panel' }, el('h2', { text: 'Nearest priced peers' }), peersTable(r),
          el('p', { class: 'sub', text: 'Each peer is priced blind: the model refit without it. The miss is what the model\u2019s error looks like on protocols like this one.' }))
      ),
      el('div', { class: 'cols' },
        el('section', { class: 'panel' }, el('h2', { text: 'Farm verdict' }), verdictPanel(r)),
        el('section', { class: 'panel' }, el('h2', { text: 'What moves the value' }), movesTable(r),
          el('p', { class: 'sub', text: 'The same fitted model, re-read on a changed record. Nothing here is a forecast; it shows which input the figure leans on.' }))
      ),
      el('section', { class: 'panel' }, el('h2', null, 'The farm plan', el('span', { class: 'sub', text: r.plan_kind + ' · deposit ' + fmtMoney(r.deposit) + ' · priced at the scenario horizon' })), planList(r))
    );
  }

  function render() {
    writeHash();
    var activeId = document.activeElement && document.activeElement.id ? document.activeElement.id : null;
    var caret = activeId === 'q' && document.activeElement ? document.activeElement.selectionStart : null;
    app.textContent = '';
    var selected = state.selected ? DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    var rows = visibleRows();
    var shell = el('div', { class: 'shell' },
      header(),
      el('p', { class: 'equation', text: '' }, 'Implied value = ', el('b', { text: 'value if a token launches' }), ' x ', el('b', { text: 'token odds' }), ' — the launch value is a fitted size curve with a shrunk category effect; the odds are the peers\u2019 record over the next ' + DATA.odds.horizon_years + ' years. Every term was kept or dropped on held-out tokens, below.'),
      kpis(),
      accounting(),
      evidence(),
      selected ? detail(selected) : el('div', null, controls(rows.length), state.tab === 'traded' ? tradedTable() : boardTable(sorted(rows))),
      el('p', { class: 'foot', text: 'Model radar-3, fitted on this snapshot\u2019s ' + DATA.comps + ' traded tokens (a recorded cap of zero is no usable price, so those are left out) and ' + DATA.odds_population + ' dated protocols for the odds. The board holds ' + DATA.board_size + ' pre-token protocols; a further ' + DATA.accounting.filter(function (g) { return g.key === 'token-unpriced'; })[0].count + ' record a token with no usable cap and are accounted for above, not ranked. Nothing here is investment advice; the odds are a record, not a forecast.' })
    );
    app.appendChild(shell);
    if (activeId) {
      var again = document.getElementById(activeId);
      if (again) {
        again.focus();
        if (caret !== null && again.setSelectionRange) { try { again.setSelectionRange(caret, caret); } catch (e) { /* range inputs have no caret */ } }
      }
    }
  }

  readHash();
  render();
})();
