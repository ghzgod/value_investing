// finance.js – pure valuation & backtest logic (no DOM, no network).
// Works as an ES module in both the browser and Node (for tests).

// Benjamin Graham's revised intrinsic-value formula (the one from the video):
//   V = [ EPS * (8.5 + 2g) * 4.4 ] / Y
//   EPS = trailing twelve-month earnings per share
//   g   = expected annual growth rate, in PERCENT (e.g. 10 for 10%)
//   8.5 = base P/E for a no-growth company
//   4.4 = AAA corporate bond yield in 1962 (Graham's anchor)
//   Y   = current AAA corporate bond yield, in PERCENT
export function grahamValue(eps, growthPct, aaaYieldPct) {
  if (!isFinite(eps) || !isFinite(growthPct) || !isFinite(aaaYieldPct)) return null;
  if (aaaYieldPct <= 0) return null;
  // Graham's formula produces meaningless negatives for loss-making firms.
  if (eps <= 0) return 0;
  return (eps * (8.5 + 2 * growthPct) * 4.4) / aaaYieldPct;
}

// Discount of market price to intrinsic value, as a fraction.
// +0.30 means the stock trades 30% BELOW intrinsic value (undervalued).
export function discount(price, intrinsic) {
  if (!isFinite(price) || !isFinite(intrinsic) || intrinsic <= 0) return null;
  return (intrinsic - price) / intrinsic;
}

// Compound annual growth rate from start->end over `years`.
export function cagr(start, end, years) {
  if (!(start > 0) || !(end > 0) || !(years > 0)) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

// Sortino ratio: like Sharpe but only penalises downside volatility.
// `returns` = periodic (e.g. monthly) simple returns. `mar` = minimum
// acceptable return per period (default 0). `periodsPerYear` annualises it.
export function sortino(returns, mar = 0, periodsPerYear = 12) {
  const r = returns.filter((x) => isFinite(x));
  if (r.length < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  let downSq = 0;
  for (const x of r) {
    const d = Math.min(0, x - mar);
    downSq += d * d;
  }
  const downsideDev = Math.sqrt(downSq / r.length);
  if (downsideDev === 0) return Infinity; // no downside at all
  return ((mean - mar) / downsideDev) * Math.sqrt(periodsPerYear);
}

// Max peak-to-trough drawdown of an equity series, as a positive fraction.
export function maxDrawdown(series) {
  let peak = -Infinity, mdd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

// Simple return series from a value series.
function periodReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0) out.push(series[i] / series[i - 1] - 1);
  }
  return out;
}

// Backtest the video's value-timing rule on a single ticker's price history.
//   history: [{ date: 'YYYY-MM-DD', close: Number }, ...] (chronological)
//   intrinsic: current Graham intrinsic value
//   opts.startingBalance, opts.discountThreshold (buy when price <= IV*(1-thr))
//   opts.growthPct: annual earnings-growth % used to scale intrinsic value
//     BACKWARD through time (earnings were smaller in the past), so the
//     intrinsic line grows over the period instead of being a flat line at
//     today's level. Without this, a currently-cheap stock is "always a buy"
//     and the strategy degenerates into buy-and-hold.
//
// Strategy: start in cash. Buy all-in when price sits at/below the time-scaled
// buy level; sell back to cash once price recovers to the time-scaled intrinsic
// value. Mirrors the video: "the algorithm sold them all when they recovered."
// Benchmark: buy-and-hold from the first month.
export function runBacktest(history, intrinsic, opts = {}) {
  const startingBalance = opts.startingBalance > 0 ? opts.startingBalance : 10000;
  const discountThreshold = isFinite(opts.discountThreshold) ? opts.discountThreshold : 0.3;
  const growthPct = isFinite(opts.growthPct) ? Math.max(0, opts.growthPct) : 0;
  const pts = (history || []).filter((p) => p && p.close > 0);
  if (pts.length < 2) return null;

  const periodsPerYear = 12; // history is expected monthly
  const hasIV = intrinsic > 0;
  const endMs = new Date(pts[pts.length - 1].date).getTime();
  const gRate = 1 + growthPct / 100;
  // Intrinsic value at point p, scaled back by growth from today.
  const ivAt = (p) => {
    if (!hasIV) return null;
    const yearsBefore = (endMs - new Date(p.date).getTime()) / (365.25 * 24 * 3600 * 1000);
    return intrinsic / Math.pow(gRate, yearsBefore);
  };

  // Buy-and-hold benchmark.
  const holdUnits = startingBalance / pts[0].close;
  const holdSeries = pts.map((p) => holdUnits * p.close);

  // Value-timing strategy.
  const stratSeries = [];
  let cash = startingBalance, units = 0, invested = false, trades = 0;
  for (const p of pts) {
    const iv = ivAt(p);
    if (iv != null) {
      const buyLevel = iv * (1 - discountThreshold);
      if (!invested && p.close <= buyLevel) {
        units = cash / p.close; cash = 0; invested = true; trades++;
      } else if (invested && p.close >= iv) {
        cash = units * p.close; units = 0; invested = false; trades++;
      }
    }
    stratSeries.push(cash + units * p.close);
  }

  const years =
    (new Date(pts[pts.length - 1].date) - new Date(pts[0].date)) /
    (365.25 * 24 * 3600 * 1000);

  const build = (series) => ({
    series,
    finalValue: series[series.length - 1],
    totalReturn: series[series.length - 1] / startingBalance - 1,
    cagr: cagr(startingBalance, series[series.length - 1], years),
    sortino: sortino(periodReturns(series), 0, periodsPerYear),
    maxDrawdown: maxDrawdown(series),
  });

  return {
    startingBalance,
    discountThreshold,
    years,
    dates: pts.map((p) => p.date),
    strategy: { ...build(stratSeries), trades, everInvested: invested || trades > 0 },
    hold: build(holdSeries),
  };
}

// Convenience: clamp a raw yfinance growth fraction (e.g. 0.12) to a sane
// percentage for Graham's g, so a single fluke quarter can't blow up the value.
export function normalizeGrowth(growthFraction, cap = 20) {
  if (!isFinite(growthFraction)) return 5; // neutral default
  const pct = growthFraction * 100;
  return Math.max(0, Math.min(cap, pct));
}

// Graham's g is meant to be the expected LONG-RUN growth rate, but yfinance's
// earningsGrowth is a single quarter's year-over-year change – for a windfall
// year it reads +300% and, capped naively, hands every insurer a 43x earnings
// multiple. Estimate g from three independent signals and take their
// CONSERVATIVE median (lower-middle when the count is even):
//   1. earnings growth (quarterly YoY, spiky)
//   2. revenue growth (stable, hard to fake)
//   3. analyst-implied growth: forward EPS vs trailing EPS
// Clamped to [0, 15] – Graham warned against paying for hyper-growth.
export function estimateGrowth({ earningsGrowth, revGrowth, eps, forwardEps } = {}, cap = 15) {
  const parts = [];
  if (isFinite(earningsGrowth)) parts.push({ label: 'earnings growth (last quarter, YoY)', pct: earningsGrowth * 100 });
  if (isFinite(revGrowth)) parts.push({ label: 'revenue growth (YoY)', pct: revGrowth * 100 });
  if (isFinite(eps) && eps > 0 && isFinite(forwardEps) && forwardEps > 0) {
    parts.push({ label: 'analyst-implied (forward vs trailing EPS)', pct: (forwardEps / eps - 1) * 100 });
  }
  if (!parts.length) return { g: 5, parts, basis: 'default' };
  const sorted = parts.map((p) => p.pct).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return { g: Math.max(0, Math.min(cap, median)), parts, basis: 'median' };
}

// One blockbuster year shouldn't be capitalised at 40x forever. When analysts
// expect earnings to FALL (forward EPS below trailing), split the difference
// so the windfall only half-counts. Otherwise trailing EPS stands.
export function conservativeEps(eps, forwardEps) {
  if (!isFinite(eps)) return { eps: eps ?? null, damped: false };
  if (eps > 0 && isFinite(forwardEps) && forwardEps > 0 && forwardEps < eps) {
    return { eps: (eps + forwardEps) / 2, damped: true };
  }
  return { eps, damped: false };
}
