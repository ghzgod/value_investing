// data.js – network layer. GitHub Pages is static (no backend), so yfinance
// (Python) can't run in the browser. We read Yahoo Finance's public JSON
// endpoints – the same data yfinance wraps – through CORS proxies, plus a
// locally generated snapshot (data/sp500.json, built with yfinance) for the
// fundamentals the live browser path can't reach.
//
// Proxy reality (measured 2026-07-09, see project notes):
//   • corsproxy.io + allorigins  – DNS-blackholed / connection-refused (dead)
//   • codetabs                    – hangs the full timeout (unusable)
//   • r.jina.ai                   – WORKS for the Yahoo chart JSON (reader proxy)
//   • proxy.cors.sh               – WORKS for chart JSON *and* the FRED CSV
// So we race jina + cors.sh for price/history and use cors.sh for the AAA yield.
// Yahoo's quoteSummary (EPS/growth) is crumb-gated and returns empty/401 from a
// browser no matter the proxy, so fundamentals come from the bundled snapshot.

// Only A–Z, dot and dash; 1–7 chars. Blocks anything that could poison a URL.
export function sanitizeTicker(raw) {
  const t = String(raw || '').trim().toUpperCase();
  return /^[A-Z][A-Z.\-]{0,6}$/.test(t) ? t : null;
}

// Pull the first {...} JSON object out of a text body. jina's reader wraps the
// response in a little markdown preamble; cors.sh returns the raw JSON. Both are
// handled by slicing between the outermost braces.
function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in response');
  return JSON.parse(text.slice(a, b + 1));
}

async function fetchText(url, headers, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a Yahoo JSON endpoint through whichever working proxy answers first.
// `x-return-format: text` tells jina to hand back the raw body instead of markdown.
async function fetchYahooJson(yahooUrl, { timeout = 6500 } = {}) {
  const attempts = [
    fetchText(`https://r.jina.ai/${yahooUrl}`, { 'x-return-format': 'text' }, timeout).then(extractJson),
    fetchText(`https://proxy.cors.sh/${yahooUrl}`, {}, timeout).then(extractJson),
  ];
  try {
    return await Promise.any(attempts);
  } catch (err) {
    throw new Error('Live price feed is busy right now – try again in a moment.');
  }
}

// Current price + monthly history for the backtest, from the chart endpoint.
// This endpoint needs no auth crumb, so it is the reliable client-side path.
export async function fetchChart(ticker, range = '20y', interval = '1mo') {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${range}&interval=${interval}`;
  const data = await fetchYahooJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No price data for that ticker');
  const meta = result.meta || {};
  const stamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const history = [];
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    history.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return {
    ticker,
    price: meta.regularMarketPrice ?? (history.length ? history[history.length - 1].close : null),
    currency: meta.currency || 'USD',
    name: meta.longName || meta.shortName || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    history,
  };
}

// Parse stockanalysis.com's human-formatted numbers: "4.36B" -> 4.36e9,
// "17.49" -> 17.49, "n/a"/"-"/"" -> null.
function saNum(v) {
  if (v == null) return null;
  const str = String(v).trim();
  if (!str || str === 'n/a' || str === '-') return null;
  const m = str.replace(/[$,%]/g, '').match(/^(-?[\d.]+)\s*([TBMK]?)/i);
  if (!m) return null;
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[2].toUpperCase()];
  const n = parseFloat(m[1]) * mult;
  return isFinite(n) ? n : null;
}

// Live fundamentals for ANY US ticker from stockanalysis.com. Their API sends
// `access-control-allow-origin: *`, so we hit it directly (fast, no relay), then
// fall back to the jina reader if that's blocked. Returns null on miss.
const EMPTY_FUND = { source: 'none', name: null, sector: null, eps: null, forwardEps: null,
  earningsGrowth: null, growth: null, revGrowth: null, marketCap: null, pe: null, pb: null };
async function fetchLiveFundamentals(ticker) {
  const path = `stockanalysis.com/api/symbol/s/${encodeURIComponent(ticker)}/overview`;
  let json = null;
  try {
    json = JSON.parse(await fetchText(`https://${path}`, {}, 6000));
  } catch (_) {
    try { json = extractJson(await fetchText(`https://r.jina.ai/https://${path}`, { 'x-return-format': 'text' }, 7000)); }
    catch (__) { return null; }
  }
  const d = json && json.data;
  if (!d) return null;
  const eps = saNum(d.eps);
  const pe = saNum(d.peRatio);
  const fwdPE = saNum(d.forwardPE);
  const mktCap = saNum(d.marketCap);
  const shares = saNum(d.sharesOut);
  // Derive a forward EPS (for growth estimation) when a forward P/E is quoted:
  // price = marketCap / sharesOut, forwardEps = price / forwardPE.
  let forwardEps = null;
  if (fwdPE && fwdPE > 0 && mktCap && shares && shares > 0) {
    forwardEps = (mktCap / shares) / fwdPE;
  }
  if (eps == null && mktCap == null) return null; // nothing usable
  return {
    source: 'live',
    name: d.name || null, sector: null,
    eps, forwardEps,
    earningsGrowth: null, growth: null, revGrowth: null,
    marketCap: mktCap, pe, pb: null,
  };
}

// Fundamentals (EPS, growth, sector, market cap). S&P 500 names come from the
// bundled snapshot instantly; any other ticker is fetched live from
// stockanalysis.com. Never rejects – the UI falls back to manual entry on a miss.
export async function fetchFundamentals(ticker, snapshot) {
  const s = snapshot?.byTicker?.get(ticker);
  if (s) {
    return {
      source: 'snapshot',
      name: s.name, sector: s.sector, eps: s.eps,
      forwardEps: s.forwardEps ?? null,
      // `earningsGrowth` is the key estimateGrowth() reads (yfinance's quarterly
      // YoY earnings change); the snapshot stores it as `growth`.
      earningsGrowth: s.growth, growth: s.growth,
      revGrowth: s.revGrowth ?? null,
      marketCap: s.marketCap, pe: s.pe, pb: s.pb,
    };
  }
  try {
    const live = await fetchLiveFundamentals(ticker);
    if (live) return live;
  } catch (_) { /* fall through to none */ }
  return { ...EMPTY_FUND };
}

// Live Moody's Seasoned Aaa corporate-bond yield (FRED series DAAA) – the real
// "Y" in Graham's formula, so it isn't a hand-typed assumption. cors.sh is the
// only proxy that fetches the FRED CSV; we cache the result and fall back to the
// last-known value if the feed is unavailable.
// Returns { yieldPct, asOf, source } – `asOf` is the FRED observation date on a
// live read, or null when we fall back. The UI keys off these field names.
const AAA_FALLBACK = 5.7; // Moody's Aaa, ~mid-2026
let _aaaPromise;
export function fetchAAAYield() {
  if (_aaaPromise) return _aaaPromise;
  const url = 'https://proxy.cors.sh/https://fred.stlouisfed.org/graph/fredgraph.csv?id=DAAA';
  _aaaPromise = fetchText(url, {}, 6000)
    .then((txt) => {
      // rows look like "2026-07-08,5.69"; the series uses "." for missing days.
      const rows = txt.match(/\d{4}-\d\d-\d\d,[\d.]+/g) || [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const [date, val] = rows[i].split(',');
        const y = parseFloat(val);
        if (isFinite(y) && y > 0) return { yieldPct: y, asOf: date, source: 'live' };
      }
      throw new Error('no usable AAA row');
    })
    .catch(() => ({ yieldPct: AAA_FALLBACK, asOf: null, source: 'fallback' }));
  return _aaaPromise;
}

// Back-compat alias in case any caller uses the lowercase spelling.
export { fetchAAAYield as fetchAaaYield };

// Load the locally generated S&P 500 snapshot (name/sector/EPS/growth/price).
let _snapshotPromise;
export function loadSnapshot() {
  if (_snapshotPromise) return _snapshotPromise;
  _snapshotPromise = fetch('data/sp500.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('snapshot missing'))))
    .then((snap) => {
      const list = snap.constituents || [];
      const byTicker = new Map(list.map((c) => [c.ticker, c]));
      return { ...snap, list, byTicker };
    })
    .catch(() => null);
  return _snapshotPromise;
}
