// app.js — UI controller. Wires the DOM to the pure logic + data layer.
import {
  grahamValue, discount, estimateGrowth, conservativeEps, runBacktest,
} from './finance.js';
import {
  sanitizeTicker, fetchChart, fetchFundamentals, loadSnapshot, fetchAAAYield,
} from './data.js';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'vi.history.v1';
const CACHE_KEY = 'vi.cache.v1';
const CACHE_TTL = 10 * 60 * 1000; // re-appraise after 10 minutes

// ---- appraisal cache (full result incl. history, so ledger clicks are instant)
function cacheLoad() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
  catch { return {}; }
}
function cacheGet(ticker) {
  const hit = cacheLoad()[ticker];
  return hit && Date.now() - hit.ts < CACHE_TTL ? hit : null;
}
function cacheSet(ticker, data) {
  const store = cacheLoad();
  store[ticker] = { ts: Date.now(), data };
  // keep the cache bounded: drop oldest beyond 30 tickers
  const keys = Object.keys(store).sort((a, b) => store[b].ts - store[a].ts);
  for (const k of keys.slice(30)) delete store[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch (_) { /* quota — skip */ }
}

// ---- formatting helpers ----
const fmtMoney = (n, cur = 'USD') =>
  n == null || !isFinite(n)
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
const fmtPct = (f, d = 1) => (f == null || !isFinite(f) ? '—' : `${(f * 100).toFixed(d)}%`);
const fmtBig = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return fmtMoney(n);
};
const fmtSortino = (s) => (s === Infinity ? '∞' : s == null ? '—' : s.toFixed(2));
// Safe DOM text node builder (never innerHTML with fetched/user data → no XSS).
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---- shared state for the current appraisal ----
let current = null; // { ticker, name, price, currency, intrinsic, discount, history, fundamentals, growthUsed, aaaYield, ... }
let aaaLive = null; // { yieldPct, asOf, source } once fetched from FRED

// ============================================================= assumptions
function readAssumptions() {
  const aaa = parseFloat($('aaaYield').value);
  const gOver = $('growthOverride').value.trim();
  const thr = parseFloat($('discountThreshold').value);
  return {
    aaaYield: isFinite(aaa) && aaa > 0 ? aaa : 4.9,
    growthOverride: gOver === '' ? null : parseFloat(gOver),
    discountThreshold: isFinite(thr) ? Math.max(0, Math.min(90, thr)) / 100 : 0.3,
  };
}

// ============================================================= appraisal
// Recompute value/discount for `c` from its stored fundamentals + the current
// g / Y inputs. Pure recalc — no network.
function revalue(c) {
  const damp = conservativeEps(c.fundamentals.eps, c.fundamentals.forwardEps);
  c.epsUsed = damp.eps;
  c.epsDamped = damp.damped;
  c.intrinsic = grahamValue(c.epsUsed, c.growthUsed, c.aaaYield);
  c.discount = discount(c.price, c.intrinsic);
}

function showResult(c, { cachedAt = null } = {}) {
  current = c;
  renderResult(c, { cachedAt });
  const canBacktest = Array.isArray(c.history) && c.history.length >= 2;
  $('backtest').hidden = !canBacktest;
  $('btOutput').replaceChildren();
}

async function appraise(rawTicker, { force = false } = {}) {
  const ticker = sanitizeTicker(rawTicker);
  const result = $('result');
  result.hidden = false;
  $('backtest').hidden = true;
  if (!ticker) {
    renderNotice(result, 'That doesn’t look like a valid ticker. Use letters only, e.g. AAPL.');
    return;
  }

  // Fresh cache hit (≤10 min) renders instantly — no refetch, no spinner.
  if (!force) {
    const hit = cacheGet(ticker);
    if (hit) { showResult(hit.data, { cachedAt: hit.ts }); saveHistory(hit.data); return; }
  }

  const status = loadingRow(`Appraising ${ticker}…`);
  result.replaceChildren(status);
  const slowTimer = setTimeout(() => {
    status.lastChild.textContent = ` Appraising ${ticker}… public data relays are slow today — still fetching.`;
  }, 6000);
  $('lookupBtn').disabled = true;

  try {
    const snapshot = await loadSnapshot();
    // Fundamentals never throw (they fall back to snapshot/none). Live chart
    // (price + history) can fail on flaky public proxies — degrade gracefully.
    // Fetch both in PARALLEL: this halves worst-case wait on slow relays.
    const [fundRes, chartRes] = await Promise.allSettled([
      fetchFundamentals(ticker, snapshot),
      fetchChart(ticker),
    ]);
    const fund = fundRes.value; // fetchFundamentals never rejects
    let chart, priceSource = 'live';
    if (chartRes.status === 'fulfilled') {
      chart = chartRes.value;
    } else {
      const snap = snapshot?.byTicker?.get(ticker);
      if (snap && snap.price != null) {
        chart = { price: snap.price, currency: 'USD', name: snap.name, exchange: null, history: [] };
        priceSource = 'snapshot';
      } else {
        throw new Error('Live price is unavailable right now, and this ticker isn’t in the offline snapshot.');
      }
    }

    const a = readAssumptions();
    const override = a.growthOverride != null && isFinite(a.growthOverride);
    const growthInfo = override
      ? { g: a.growthOverride, parts: [], basis: 'override' }
      : estimateGrowth(fund);

    const c = {
      ticker,
      name: fund.name || chart.name || ticker,
      price: chart.price,
      currency: chart.currency,
      exchange: chart.exchange,
      history: chart.history,
      fundamentals: fund,
      growthUsed: growthInfo.g,
      growthInfo,
      aaaYield: a.aaaYield,
      aaaMeta: aaaLive,
      priceSource,
      snapshotDate: snapshot?.generated,
    };
    revalue(c);
    showResult(c);
    cacheSet(ticker, c);
    saveHistory(c);
  } catch (err) {
    renderNotice(result, `Couldn’t appraise ${ticker}. ${err.message || 'Data source unavailable — try again in a moment.'}`);
  } finally {
    clearTimeout(slowTimer);
    $('lookupBtn').disabled = false;
  }
}

function renderResult(c, { cachedAt = null } = {}) {
  const result = $('result');
  result.replaceChildren();

  // cached banner — instant ledger recalls say when the numbers are from
  if (cachedAt) {
    const mins = Math.max(1, Math.round((Date.now() - cachedAt) / 60000));
    const note = el('p', 'cached-note');
    note.append(`Showing your appraisal from ${mins} minute${mins === 1 ? '' : 's'} ago. `);
    const re = el('button', 'linklike', 'Re-appraise now');
    re.type = 'button';
    re.addEventListener('click', () => appraise(c.ticker, { force: true }));
    note.appendChild(re);
    result.appendChild(note);
  }

  // --- left: identity + ledger ---
  const left = el('div', 'company');
  left.appendChild(el('p', 'company__eyebrow', `${c.ticker}${c.exchange ? ' · ' + c.exchange : ''}`));
  left.appendChild(el('h2', 'company__name', c.name));
  const f = c.fundamentals;
  left.appendChild(el('p', 'company__meta', f.sector || 'Sector n/a'));

  const table = el('table', 'ledger');
  const rows = [
    ['Market price', fmtMoney(c.price, c.currency)],
    ['Market cap', fmtBig(f.marketCap)],
    ['EPS (trailing)', f.eps == null ? '—' : fmtMoney(f.eps, c.currency)],
    ...(c.epsDamped ? [['EPS used (damped)', fmtMoney(c.epsUsed, c.currency)]] : []),
    ['Growth used (g)', `${c.growthUsed.toFixed(1)}%`],
    ['P/E', f.pe == null ? '—' : f.pe.toFixed(1)],
    ['P/B', f.pb == null ? '—' : f.pb.toFixed(2)],
    ['AAA yield (Y)', `${c.aaaYield.toFixed(1)}%`],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('th', null, k));
    tr.appendChild(el('td', null, v));
    table.appendChild(tr);
  }
  left.appendChild(table);

  const srcMap = { live: 'live Yahoo Finance', snapshot: 'bundled S&P 500 snapshot', none: 'no fundamentals found' };
  const src = el('p', 'src-note');
  src.append('Fundamentals: ');
  src.appendChild(el('code', null, srcMap[f.source] || f.source));
  src.append('. Price: ');
  if (c.priceSource === 'snapshot') {
    src.appendChild(el('code', null, `snapshot ${c.snapshotDate || ''}`));
    src.append(' (live feed busy — backtest paused).');
  } else {
    src.appendChild(el('code', null, 'live'));
    src.append('.');
  }
  left.appendChild(src);

  // manual entry fallback when we couldn't value it
  if (f.eps == null) {
    left.appendChild(buildManualEntry(c));
  }

  // --- right: verdict ---
  const right = el('div', 'verdict');
  const priceRow = el('div', 'verdict__row');
  priceRow.appendChild(el('span', 'verdict__label', 'Market says'));
  priceRow.appendChild(el('span', 'verdict__num verdict__price', fmtMoney(c.price, c.currency)));
  right.appendChild(priceRow);
  right.appendChild(el('hr', 'verdict__divider'));
  const valRow = el('div', 'verdict__row');
  valRow.appendChild(el('span', 'verdict__label', 'Graham says'));
  valRow.appendChild(el('span', 'verdict__num verdict__value', c.intrinsic == null ? '—' : fmtMoney(c.intrinsic, c.currency)));
  right.appendChild(valRow);

  right.appendChild(verdictStamp(c.discount));
  result.append(left, right);

  // --- full-width: show the math, then let them play with it ---
  result.appendChild(buildFormulaCard(c));
  result.appendChild(buildPlayground(c));
}

// The Graham formula with THIS company's numbers plugged in, plus where each
// number came from — the learning half of the tool.
function buildFormulaCard(c) {
  const card = el('div', 'formula');
  card.appendChild(el('h3', 'formula__title', 'The math, shown honestly'));

  const eq = el('p', 'formula__eq');
  if (c.intrinsic != null && c.intrinsic > 0) {
    eq.textContent =
      `V = ${fmtMoney(c.epsUsed, c.currency)} × (8.5 + 2×${c.growthUsed.toFixed(1)}) × 4.4 ÷ ${c.aaaYield.toFixed(2)} = ${fmtMoney(c.intrinsic, c.currency)}`;
  } else {
    eq.textContent = 'V = EPS × (8.5 + 2g) × 4.4 ÷ Y — needs positive earnings to work.';
  }
  card.appendChild(eq);

  const why = el('ul', 'formula__why');
  const li = (text) => why.appendChild(el('li', null, text));

  if (c.epsDamped) {
    li(`EPS: trailing earnings are ${fmtMoney(c.fundamentals.eps, c.currency)}, but analysts expect ${fmtMoney(c.fundamentals.forwardEps, c.currency)} next year — a windfall year shouldn't be capitalised forever, so we split the difference: ${fmtMoney(c.epsUsed, c.currency)}.`);
  } else if (c.fundamentals.eps != null) {
    li(`EPS: trailing twelve-month earnings per share, ${fmtMoney(c.fundamentals.eps, c.currency)}.`);
  }

  const gi = c.growthInfo;
  if (gi?.basis === 'override') {
    li(`g = ${c.growthUsed.toFixed(1)}% — your override from the inputs panel.`);
  } else if (gi?.parts?.length) {
    const partsTxt = gi.parts
      .map((p) => `${p.label}: ${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(1)}%`)
      .join(' · ');
    li(`g = ${c.growthUsed.toFixed(1)}%/yr — the conservative median of ${partsTxt}, capped at 15%. One hot quarter can't set it.`);
  } else {
    li(`g = ${c.growthUsed.toFixed(1)}%/yr — neutral default; no growth data was available.`);
  }

  const am = c.aaaMeta;
  if (am?.source === 'live' || am?.source === 'cache') {
    li(`Y = ${c.aaaYield.toFixed(2)}% — Moody's AAA corporate bond yield (FRED, as of ${am.asOf}). Higher safe yields make future earnings worth less today.`);
  } else {
    li(`Y = ${c.aaaYield.toFixed(2)}% — AAA corporate bond yield (static fallback; live feed unavailable).`);
  }
  card.appendChild(why);
  return card;
}

// Sliders that recompute the valuation live — feel how g and Y move V.
function buildPlayground(c) {
  const box = el('div', 'playground');
  box.appendChild(el('h3', 'formula__title', 'Play with the inputs'));
  box.appendChild(el('p', 'playground__hint',
    'Drag and watch the verdict move. Growth is the formula’s heaviest lever — exactly why optimistic analysts can justify any price.'));

  const grid = el('div', 'playground__grid');
  const mkSlider = (label, min, max, step, val, fmt, onInput) => {
    const wrapEl = el('label', 'playground__ctl');
    const head = el('span', 'playground__lab');
    head.append(label + ' ');
    const out = el('b', null, fmt(val));
    head.appendChild(out);
    const input = el('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = val;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = fmt(v);
      onInput(v);
    });
    wrapEl.append(head, input);
    grid.appendChild(wrapEl);
    return input;
  };

  const refresh = () => {
    revalue(c);
    // update verdict panel + formula card in place
    const num = document.querySelector('.verdict__value');
    if (num) num.textContent = c.intrinsic == null ? '—' : fmtMoney(c.intrinsic, c.currency);
    const oldStamp = document.querySelector('.stamp');
    if (oldStamp) oldStamp.replaceWith(verdictStamp(c.discount));
    const card = document.querySelector('.formula');
    if (card) card.replaceWith(buildFormulaCard(c));
    buyOut.textContent = buyText();
  };

  mkSlider('Growth g', 0, 25, 0.5, c.growthUsed, (v) => `${v.toFixed(1)}%/yr`, (v) => {
    c.growthUsed = v;
    c.growthInfo = { g: v, parts: [], basis: 'override' };
    $('growthOverride').value = v; // keep backtest + next appraisal in sync
    refresh();
  });
  mkSlider('AAA yield Y', 2, 10, 0.05, c.aaaYield, (v) => `${v.toFixed(2)}%`, (v) => {
    c.aaaYield = v;
    $('aaaYield').value = v;
    $('aaaYield').dataset.userSet = '1';
    refresh();
  });
  const thr0 = readAssumptions().discountThreshold * 100;
  let thr = thr0;
  mkSlider('Buy discount', 0, 90, 5, thr0, (v) => `${v.toFixed(0)}%`, (v) => {
    thr = v;
    $('discountThreshold').value = v;
    refresh();
  });

  const buyText = () => {
    if (!(c.intrinsic > 0)) return 'No intrinsic value — the buy rule never triggers.';
    const buyAt = c.intrinsic * (1 - thr / 100);
    const trig = c.price <= buyAt;
    return `Buy trigger: price ≤ ${fmtMoney(buyAt, c.currency)} (${thr.toFixed(0)}% below value) — at ${fmtMoney(c.price, c.currency)} today that's ${trig ? 'a BUY' : 'no trade'}.`;
  };
  const buyOut = el('p', 'playground__buy', buyText());

  box.append(grid, buyOut);
  return box;
}

function verdictStamp(disc) {
  const stamp = el('div', 'stamp');
  if (disc == null) {
    stamp.classList.add('is-fair');
    stamp.append('Uncertain');
    stamp.appendChild(el('small', null, 'not enough data to value'));
    return stamp;
  }
  if (disc >= 0.1) {
    stamp.classList.add('is-under');
    stamp.append(`${fmtPct(disc, 0)} below value`);
    stamp.appendChild(el('small', null, 'trades at a discount'));
  } else if (disc <= -0.1) {
    stamp.classList.add('is-over');
    stamp.append(`${fmtPct(-disc, 0)} above value`);
    stamp.appendChild(el('small', null, 'trades at a premium'));
  } else {
    stamp.classList.add('is-fair');
    stamp.append('Fairly valued');
    stamp.appendChild(el('small', null, 'near intrinsic value'));
  }
  return stamp;
}

// Manual EPS / growth entry when automatic fundamentals are missing.
function buildManualEntry(c) {
  const box = el('div', 'manual');
  box.appendChild(el('p', null, 'No earnings found automatically — enter them to value it:'));
  const epsL = el('label', null, 'EPS');
  const epsI = el('input'); epsI.type = 'number'; epsI.step = '0.01'; epsI.placeholder = '5.00';
  epsL.appendChild(epsI);
  const gL = el('label', null, 'Growth % / yr');
  const gI = el('input'); gI.type = 'number'; gI.step = '0.5'; gI.placeholder = '8';
  gL.appendChild(gI);
  const go = el('button', 'btn btn--sm', 'Value it');
  go.type = 'button';
  go.addEventListener('click', () => {
    const eps = parseFloat(epsI.value);
    const g = parseFloat(gI.value);
    if (!isFinite(eps)) return;
    c.fundamentals.eps = eps;
    if (isFinite(g)) {
      c.growthUsed = g;
      c.growthInfo = { g, parts: [], basis: 'override' };
    }
    revalue(c);
    renderResult(c);
    saveHistory(c);
  });
  box.append(epsL, gL, go);
  return box;
}

// ============================================================= backtest
function runBacktestUI() {
  if (!current) return;
  const out = $('btOutput');
  const bal = parseFloat($('startBalance').value);
  const startingBalance = isFinite(bal) && bal > 0 ? bal : 10000;
  const { discountThreshold } = readAssumptions();

  const bt = runBacktest(current.history, current.intrinsic, {
    startingBalance, discountThreshold, growthPct: current.growthUsed,
  });
  if (!bt) {
    renderNotice(out, 'Not enough price history to backtest this ticker.');
    return;
  }
  out.replaceChildren();

  if (current.intrinsic == null || current.intrinsic <= 0) {
    const note = el('p', 'notice notice--info',
      'No intrinsic value, so the value-timing rule never triggers — only buy-and-hold is shown.');
    out.appendChild(note);
  }

  // stats grid
  const stats = el('div', 'bt-stats');
  const mk = (k, v) => { const s = el('div', 'bt-stat'); s.appendChild(el('div', 'bt-stat__k', k)); s.appendChild(el('div', 'bt-stat__v', v)); return s; };
  stats.append(
    mk('Value strategy', fmtMoney(bt.strategy.finalValue, current.currency)),
    mk('Strat. annualized', fmtPct(bt.strategy.cagr)),
    mk('Strat. Sortino', fmtSortino(bt.strategy.sortino)),
    mk('Buy & hold', fmtMoney(bt.hold.finalValue, current.currency)),
    mk('Hold annualized', fmtPct(bt.hold.cagr)),
    mk('Hold Sortino', fmtSortino(bt.hold.sortino)),
  );
  out.appendChild(stats);

  out.appendChild(drawChart(bt, current.currency));

  const legend = el('div', 'bt-legend');
  const leg = (color, label) => { const s = el('span'); const sw = el('span', 'swatch'); sw.style.background = color; s.append(sw, document.createTextNode(label)); return s; };
  legend.append(
    leg('var(--value)', `Value strategy · ${bt.strategy.trades} trade${bt.strategy.trades === 1 ? '' : 's'}`),
    leg('var(--ink-soft)', 'Buy & hold'),
  );
  out.appendChild(legend);

  const beat = bt.strategy.finalValue > bt.hold.finalValue;
  const v = el('p', 'bt-verdict');
  v.textContent = beat
    ? `Over ${bt.years.toFixed(1)} years, timing the discount beat buy-and-hold — the exception, not the rule.`
    : `Over ${bt.years.toFixed(1)} years, simply holding beat timing the discount. Just like the video found.`;
  out.appendChild(v);
}

// Lightweight custom canvas line chart (no chart library dependency).
function drawChart(bt, cur) {
  const wrap = el('div', 'bt-chart');
  const canvas = document.createElement('canvas');
  const W = 900, H = 320, pad = 44;
  canvas.width = W; canvas.height = H;
  canvas.style.width = '100%'; canvas.style.height = 'auto';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label',
    `Equity curve: value strategy ends at ${fmtMoney(bt.strategy.finalValue, cur)}, buy-and-hold at ${fmtMoney(bt.hold.finalValue, cur)}.`);
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#222';
  const inkSoft = css.getPropertyValue('--ink-soft').trim() || '#555';
  const value = css.getPropertyValue('--value').trim() || 'green';
  const rule = 'rgba(40,40,60,0.12)';

  const s = bt.strategy.series, h = bt.hold.series;
  const all = s.concat(h);
  const min = Math.min(...all), max = Math.max(...all);
  const n = s.length;
  const x = (i) => pad + (i / (n - 1)) * (W - pad * 1.4);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - pad * 1.8);

  // gridlines + y labels
  ctx.font = '12px Archivo, sans-serif'; ctx.fillStyle = inkSoft; ctx.strokeStyle = rule;
  for (let g = 0; g <= 4; g++) {
    const val = min + (g / 4) * (max - min);
    const yy = y(val);
    ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(W - pad * 0.4, yy); ctx.stroke();
    ctx.fillText(fmtBig(val), 2, yy - 3);
  }
  // date labels (first / mid / last)
  ctx.fillStyle = inkSoft;
  [0, Math.floor(n / 2), n - 1].forEach((i) => {
    const yr = bt.dates[i]?.slice(0, 4) || '';
    ctx.fillText(yr, Math.min(x(i), W - 34), H - 14);
  });

  const line = (series, color, width) => {
    ctx.beginPath(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineJoin = 'round';
    series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  };
  line(h, inkSoft, 1.6);
  line(s, value, 2.6);
  return wrap;
}

// ============================================================= scan
async function runScan() {
  const out = $('scanOutput');
  const btn = $('scanBtn');
  btn.disabled = true;
  out.replaceChildren(loadingRow('Scanning the S&P 500…'));
  try {
    const snap = await loadSnapshot();
    if (!snap || !snap.list.length) throw new Error('Snapshot unavailable');
    const a = readAssumptions();
    const scored = [];
    for (const c of snap.list) {
      if (c.eps == null || c.price == null) continue;
      const g = estimateGrowth({ earningsGrowth: c.growth, revGrowth: c.revGrowth, eps: c.eps, forwardEps: c.forwardEps }).g;
      const { eps } = conservativeEps(c.eps, c.forwardEps);
      const iv = grahamValue(eps, g, a.aaaYield);
      const d = discount(c.price, iv);
      if (d == null || iv <= 0) continue;
      scored.push({ ...c, iv, disc: d, g });
    }
    scored.sort((x, y) => y.disc - x.disc);
    renderScan(out, scored.slice(0, 40), snap.generated, scored.length);
  } catch (err) {
    renderNotice(out, `Scan failed: ${err.message}.`);
  } finally {
    btn.disabled = false;
  }
}

function renderScan(out, rows, generated, total) {
  out.replaceChildren();
  const meta = el('p', 'scan__note',
    `Top ${rows.length} of ${total} valuable names, most discounted first · snapshot ${generated || 'n/a'} · click a row to appraise live.`);
  out.appendChild(meta);

  const wrap = el('div', 'scan-wrap');
  const table = el('table', 'scan-table');
  const thead = el('thead'); const htr = el('tr');
  ['Ticker', 'Company', 'Price', 'Graham value', 'Discount'].forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr); table.appendChild(thead);
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, r.ticker));
    tr.appendChild(el('td', null, r.name || ''));
    tr.appendChild(el('td', null, fmtMoney(r.price)));
    tr.appendChild(el('td', null, fmtMoney(r.iv)));
    const d = el('td', 'disc', fmtPct(r.disc, 0)); tr.appendChild(d);
    tr.addEventListener('click', () => {
      $('ticker').value = r.ticker;
      appraise(r.ticker);
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tb.appendChild(tr);
  }
  table.appendChild(tb); wrap.appendChild(table); out.appendChild(wrap);
}

// ============================================================= history (localStorage)
function loadHistoryStore() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function saveHistory(c) {
  const store = loadHistoryStore().filter((h) => h.ticker !== c.ticker);
  store.unshift({
    ticker: c.ticker, name: c.name, price: c.price, currency: c.currency,
    intrinsic: c.intrinsic, discount: c.discount, ts: Date.now(),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(store.slice(0, 30)));
  renderHistory();
}
function renderHistory() {
  const list = $('historyList');
  const store = loadHistoryStore();
  list.replaceChildren();
  $('historyEmpty').hidden = store.length > 0;
  $('clearHistory').hidden = store.length === 0;
  for (const h of store) {
    const li = el('li', 'history__item');
    li.appendChild(el('span', 'history__tk', h.ticker));
    li.appendChild(el('span', 'history__co', h.name || ''));
    const d = el('span', 'history__disc');
    if (h.discount == null) { d.textContent = '—'; }
    else { d.textContent = (h.discount >= 0 ? '▼ ' : '▲ ') + fmtPct(Math.abs(h.discount), 0);
      d.style.color = h.discount >= 0.1 ? 'var(--value)' : h.discount <= -0.1 ? 'var(--market)' : 'var(--gold)'; }
    li.appendChild(d);
    li.appendChild(el('span', 'history__date', new Date(h.ts).toLocaleDateString()));
    li.addEventListener('click', () => { $('ticker').value = h.ticker; appraise(h.ticker); document.querySelector('.search').scrollIntoView({ behavior: 'smooth' }); });
    list.appendChild(li);
  }
}

// ============================================================= ticker tape
async function buildTape() {
  const snap = await loadSnapshot();
  const track = $('tapeTrack');
  if (!snap || !snap.list.length) { $('tape').hidden = true; return; }
  const a = { aaaYield: aaaLive?.yieldPct ?? 4.9 };
  const items = snap.list
    .filter((c) => c.eps != null && c.price != null)
    .map((c) => {
      const g = estimateGrowth({ earningsGrowth: c.growth, revGrowth: c.revGrowth, eps: c.eps, forwardEps: c.forwardEps }).g;
      const { eps } = conservativeEps(c.eps, c.forwardEps);
      return { ...c, disc: discount(c.price, grahamValue(eps, g, a.aaaYield)) };
    })
    .filter((c) => c.disc != null)
    .sort((x, y) => y.disc - x.disc)
    .slice(0, 24);
  const frag = document.createDocumentFragment();
  const render = (c) => {
    const span = el('span', 'tape__item');
    span.appendChild(el('b', null, c.ticker));
    span.append(' ' + fmtMoney(c.price) + ' ');
    const d = el('span', c.disc >= 0 ? 'up' : 'down', `${c.disc >= 0 ? '−' : '+'}${Math.abs(c.disc * 100).toFixed(0)}% vs value`);
    span.appendChild(d);
    return span;
  };
  // duplicate the list so the -50% translate loop is seamless
  [...items, ...items].forEach((c) => frag.appendChild(render(c)));
  track.replaceChildren(frag);
}

// ============================================================= shared UI bits
function loadingRow(text) {
  const p = el('p', 'notice notice--info');
  p.appendChild(el('span', 'spinner'));
  p.append(' ' + text);
  return p;
}
function renderNotice(container, text) {
  container.replaceChildren(el('p', 'notice', text));
}

// ---- guide (help) open/close ----
function openGuide() {
  const g = $('guide'); g.hidden = false; g.setAttribute('aria-hidden', 'false');
  $('guideClose').focus();
}
function closeGuide() {
  const g = $('guide'); g.hidden = true; g.setAttribute('aria-hidden', 'true');
  $('helpBtn').focus();
}

// ============================================================= theme
const THEME_KEY = 'vi.theme';
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  const btn = $('themeBtn');
  if (btn) {
    btn.textContent = mode === 'dark' ? '☀' : '☾';
    btn.setAttribute('aria-label', mode === 'dark' ? 'Switch to day edition' : 'Switch to night edition');
  }
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const mode = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(mode);
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    // canvas chart bakes theme colors in at draw time — redraw if one is up
    if (current && !$('backtest').hidden && $('btOutput').querySelector('canvas')) runBacktestUI();
  });
}

// Pull the live AAA yield and make it the default Y (unless the user already
// typed their own). The input stays editable — live data, not gospel.
async function initAAAYield() {
  aaaLive = await fetchAAAYield();
  const input = $('aaaYield');
  if (aaaLive.source !== 'fallback' && !input.dataset.userSet) {
    input.value = aaaLive.yieldPct;
  }
  const note = $('aaaNote');
  if (note) {
    note.textContent = aaaLive.source === 'fallback'
      ? 'AAA yield: live feed unavailable — using a static 4.9%. Edit it if you know better.'
      : `AAA yield: Moody's Aaa corporate bonds via FRED, as of ${aaaLive.asOf}.`;
  }
}

// ============================================================= init
function init() {
  $('dateline').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  initTheme();
  $('lookupForm').addEventListener('submit', (e) => { e.preventDefault(); appraise($('ticker').value); });
  $('btForm').addEventListener('submit', (e) => { e.preventDefault(); runBacktestUI(); });
  $('scanBtn').addEventListener('click', runScan);
  $('clearHistory').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });
  $('aaaYield').addEventListener('input', () => { $('aaaYield').dataset.userSet = '1'; });

  $('helpBtn').addEventListener('click', openGuide);
  $('guideClose').addEventListener('click', closeGuide);
  $('guideScrim').addEventListener('click', closeGuide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('guide').hidden) closeGuide(); });

  renderHistory();
  // live AAA yield first so the tape prices against the real Y, then the tape
  initAAAYield().finally(buildTape);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
