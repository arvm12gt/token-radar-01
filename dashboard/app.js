'use strict';
/* Token Launch Radar — renders window.RADAR (from ../data.js) fully offline. */

const R = window.RADAR;
const rows = R.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

/* ---------------- formatting ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function commas(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtUSD(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + commas(n);
}
function fmtFull(n) { return '$' + commas(n); }
function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  const s = (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  return s;
}
function pctClass(v) {
  if (v === null || v === undefined || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}
function fmtAge(days) {
  if (days === null || days === undefined) return '—';
  if (days < 365) return days + 'd';
  return (days / 365.25).toFixed(1) + 'y';
}
function fmtAgeLong(days) {
  if (days === null || days === undefined) return 'not recorded';
  return commas(days) + ' days (' + (days / 365.25).toFixed(1) + ' years)';
}
function fmtMult(x) {
  if (x >= 100) return x.toFixed(0);
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(2);
}

/* ---------------- header / footer ---------------- */
const globalCalib = R.calibration.find((c) => c.category === 'ALL');
document.getElementById('topstats').innerHTML =
  '<div class="stat"><b>' + rows.length + '</b><span>protocols ranked</span></div>' +
  '<div class="stat"><b>' + R.counts.watchlist + '</b><span>on watchlist</span></div>' +
  '<div class="stat"><b>' + R.live.length + '</b><span>traded comparables</span></div>' +
  '<div class="stat"><b>' + esc(R.as_of) + '</b><span>snapshot date</span></div>';
document.getElementById('foot-note').textContent =
  'Source: ' + R.source + '. Board: the ' + R.counts.watchlist + '-protocol watchlist plus every pre-token protocol below the ' +
  fmtUSD(R.floor_usd) + ' floor (' + R.counts.pre_token_total + ' pre-token protocols in the snapshot). Implied values are the model\u2019s claim, not a price.';
document.getElementById('scope-note').textContent =
  'In this snapshot: ' + R.counts.protocols + ' protocols, ' + R.counts.pre_token_total + ' recording no token, ' +
  R.counts.pre_token_above_floor + ' of them above the floor but excluded from the board as wrapped or staked products of traded tokens.';

/* ---------------- filters ---------------- */
const elQ = document.getElementById('f-q');
const elCat = document.getElementById('f-cat');
const elChain = document.getElementById('f-chain');
const elMin = document.getElementById('f-min');
const elWl = document.getElementById('f-wl');
const elCount = document.getElementById('count');
const elBody = document.getElementById('board-body');

const catCounts = new Map();
const chainCounts = new Map();
for (const r of rows) {
  catCounts.set(r.category, (catCounts.get(r.category) || 0) + 1);
  for (const c of r.chains) chainCounts.set(c, (chainCounts.get(c) || 0) + 1);
}
for (const c of [...catCounts.keys()].sort()) {
  elCat.insertAdjacentHTML('beforeend', '<option value="' + esc(c) + '">' + esc(c) + ' (' + catCounts.get(c) + ')</option>');
}
for (const c of [...chainCounts.keys()].sort((a, b) => chainCounts.get(b) - chainCounts.get(a) || a.localeCompare(b))) {
  elChain.insertAdjacentHTML('beforeend', '<option value="' + esc(c) + '">' + esc(c) + ' (' + chainCounts.get(c) + ')</option>');
}

const state = { sortKey: 'rank', sortDir: 1 };

function currentRows() {
  const q = elQ.value.trim().toLowerCase();
  const cat = elCat.value;
  const chain = elChain.value;
  const min = Number(elMin.value) || 0;
  const wlOnly = elWl.checked;
  const out = rows.filter((r) => {
    if (wlOnly && !r.on_watchlist) return false;
    if (cat && r.category !== cat) return false;
    if (chain && !r.chains.includes(chain)) return false;
    if (r.implied_value_usd < min) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    return true;
  });
  const k = state.sortKey;
  const d = state.sortDir;
  out.sort((a, b) => {
    let x = a[k];
    let y = b[k];
    if (x === null || x === undefined) x = -Infinity;
    if (y === null || y === undefined) y = -Infinity;
    if (typeof x === 'string') return d * x.localeCompare(y) || a.rank - b.rank;
    return d * (x - y) || a.rank - b.rank;
  });
  return out;
}

function chainsCell(r) {
  const shown = r.chains.slice(0, 2).map(esc).join(', ');
  const extra = r.chains.length - 2;
  return shown + (extra > 0 ? ' <span style="color:var(--faint)">+' + extra + '</span>' : '');
}

function renderBoard() {
  const list = currentRows();
  elCount.textContent = 'Showing ' + list.length + ' of ' + rows.length + ' protocols';
  if (!list.length) {
    elBody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);padding:22px 10px">No protocols match these filters.</td></tr>';
    return;
  }
  let html = '';
  for (const r of list) {
    html += '<tr data-slug="' + esc(r.slug) + '">' +
      '<td class="num rank">' + r.rank + '</td>' +
      '<td class="name">' + esc(r.name) + (r.on_watchlist ? '<span class="wl">WL</span>' : '') + '</td>' +
      '<td class="cat">' + esc(r.category) + '</td>' +
      '<td class="chains">' + chainsCell(r) + '</td>' +
      '<td class="num">' + fmtUSD(r.tvl_usd) + '</td>' +
      '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
      '<td class="num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="num value">' + fmtUSD(r.implied_value_usd) + '</td>' +
      '</tr>';
  }
  elBody.innerHTML = html;
}

for (const input of [elQ, elCat, elChain, elMin, elWl]) {
  input.addEventListener('input', renderBoard);
  input.addEventListener('change', renderBoard);
}

document.querySelectorAll('#board th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) state.sortDir = -state.sortDir;
    else { state.sortKey = key; state.sortDir = key === 'name' || key === 'category' ? 1 : -1; }
    document.querySelectorAll('#board th .arrow').forEach((a) => a.remove());
    th.insertAdjacentHTML('beforeend', ' <span class="arrow">' + (state.sortDir === 1 ? '▲' : '▼') + '</span>');
    renderBoard();
  });
});

elBody.addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-slug]');
  if (tr) showDetail(tr.dataset.slug);
});

/* ---------------- detail ---------------- */
const viewBoard = document.getElementById('view-board');
const viewDetail = document.getElementById('view-detail');
const viewMethod = document.getElementById('view-method');
const tabBoard = document.getElementById('tab-board');
const tabMethod = document.getElementById('tab-method');

function showView(which) {
  viewBoard.hidden = which !== 'board';
  viewDetail.hidden = which !== 'detail';
  viewMethod.hidden = which !== 'method';
  tabBoard.classList.toggle('active', which !== 'method');
  tabMethod.classList.toggle('active', which === 'method');
  window.scrollTo(0, 0);
}
tabBoard.addEventListener('click', () => showView('board'));
tabMethod.addEventListener('click', () => showView('method'));
document.getElementById('back-board').addEventListener('click', () => showView('board'));

function showDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  const m = r.model;
  const steps = r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('');
  document.getElementById('detail-body').innerHTML =
    '<div class="detail-head"><h2>' + esc(r.name) + (r.on_watchlist ? '<span class="wl">Watchlist</span>' : '') + '</h2>' +
    '<span class="rankline">rank #' + r.rank + ' of ' + rows.length + ' · ' + esc(r.category) + '</span></div>' +
    '<div class="statgrid">' +
    '<div class="cell"><span>TVL</span><b>' + fmtFull(r.tvl_usd) + '</b></div>' +
    '<div class="cell"><span>7d TVL change</span><b class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</b></div>' +
    '<div class="cell"><span>Age, no token</span><b>' + fmtAgeLong(r.age_days) + '</b></div>' +
    '<div class="cell"><span>Implied value</span><b style="color:var(--accent)">' + fmtFull(r.implied_value_usd) + '</b></div>' +
    '<div class="cell"><span>Chains</span><b>' + r.chains.length + '</b></div>' +
    '<div class="cell"><span>Status</span><b>' + (r.on_watchlist ? 'Watchlist (≥ ' + fmtUSD(R.floor_usd) + ')' : 'Below-floor find') + '</b></div>' +
    '</div>' +
    '<p style="color:var(--muted);margin:0 0 18px">Chains: ' + r.chains.map(esc).join(', ') + '</p>' +
    '<div class="detail-cols">' +
    '<div><h3>How this value is derived</h3><div class="calc">' +
    '<div class="row"><span>Total value locked</span><b>' + fmtFull(r.tvl_usd) + '</b></div>' +
    '<div class="row"><span>× Category multiple — ' + esc(r.category) + ', median of ' + m.comps_n + ' traded comp' + (m.comps_n === 1 ? '' : 's') + ', shrunk to the global median ' + globalCalib.used_multiple.toFixed(2) + '</span><b>× ' + m.category_multiple.toFixed(3) + '</b></div>' +
    '<div class="row"><span>× Momentum — 7d TVL change ' + fmtPct(r.change_7d) + '</span><b>× ' + m.momentum_multiplier.toFixed(4) + '</b></div>' +
    '<div class="row"><span>× Maturity — ' + (r.age_days === null ? 'age not recorded, treated as 730 days' : commas(r.age_days) + ' days with no token') + '</span><b>× ' + m.maturity_multiplier.toFixed(4) + '</b></div>' +
    '<div class="row total"><span>Implied value</span><b>' + fmtFull(r.implied_value_usd) + '</b></div>' +
    '<p class="why">The multiple is fitted from this snapshot\u2019s own traded protocols, not an outside list; momentum and maturity adjust it for the protocol\u2019s recent growth and for how long it has operated without a token. See Method &amp; comparables for the full calibration table.</p>' +
    '</div></div>' +
    '<div><h3>Farm plan</h3><ol class="farm">' + steps + '</ol></div>' +
    '</div>';
  showView('detail');
}

/* ---------------- method tables ---------------- */
document.getElementById('calib-body').innerHTML = R.calibration.map((c) =>
  '<tr><td>' + esc(c.category === 'ALL' ? 'All categories (global)' : c.category) + '</td>' +
  '<td class="num">' + c.comps_n + '</td>' +
  '<td class="num">' + c.median_multiple.toFixed(3) + '</td>' +
  '<td class="num">' + c.used_multiple.toFixed(3) + '</td></tr>',
).join('');

document.getElementById('comps-body').innerHTML = [...R.live]
  .sort((a, b) => b.tvl_usd - a.tvl_usd)
  .map((p) =>
    '<tr><td style="font-weight:600">' + esc(p.name) + '</td>' +
    '<td style="color:var(--muted)">' + esc(p.category) + '</td>' +
    '<td class="num">' + fmtUSD(p.tvl_usd) + '</td>' +
    '<td class="num">' + fmtUSD(p.mcap_usd) + '</td>' +
    '<td class="num">' + fmtMult(p.multiple) + '×</td></tr>',
  ).join('');

/* ---------------- go ---------------- */
renderBoard();

/* Small API for scripted captures and testing. */
window.RADAR_APP = {
  showDetail,
  showView,
  setWatchlistOnly(on) { elWl.checked = !!on; renderBoard(); },
  setCategory(cat) { elCat.value = cat; renderBoard(); },
};
