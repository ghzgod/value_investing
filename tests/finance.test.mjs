// Minimal zero-dependency test runner for the pure valuation logic.
// Run:  node tests/finance.test.mjs
import {
  grahamValue, discount, cagr, sortino, maxDrawdown, runBacktest, normalizeGrowth,
  estimateGrowth, conservativeEps,
} from '../assets/js/finance.js';

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(name, cond) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); }
}

// --- grahamValue ---
// EPS=5, g=10%, Y=4.4  ->  5*(8.5+20)*4.4/4.4 = 5*28.5 = 142.5
ok('graham basic', approx(grahamValue(5, 10, 4.4), 142.5));
ok('graham higher yield lowers value', grahamValue(5, 10, 8.8) < grahamValue(5, 10, 4.4));
ok('graham negative eps -> 0', grahamValue(-2, 10, 4.4) === 0);
ok('graham bad yield -> null', grahamValue(5, 10, 0) === null);
ok('graham NaN -> null', grahamValue(NaN, 10, 4.4) === null);

// --- discount ---
ok('discount undervalued', approx(discount(70, 100), 0.3));
ok('discount overvalued negative', approx(discount(120, 100), -0.2));
ok('discount bad intrinsic -> null', discount(70, 0) === null);

// --- cagr ---
ok('cagr doubling over 1yr', approx(cagr(100, 200, 1), 1));
ok('cagr flat', approx(cagr(100, 100, 5), 0));
ok('cagr bad input -> null', cagr(0, 100, 1) === null);

// --- sortino ---
ok('sortino all-positive -> Infinity', sortino([0.01, 0.02, 0.03]) === Infinity);
ok('sortino too-short -> null', sortino([0.01]) === null);
ok('sortino penalises downside', typeof sortino([0.02, -0.03, 0.01, -0.05]) === 'number');

// --- maxDrawdown ---
ok('maxDrawdown 100->50', approx(maxDrawdown([100, 120, 60, 90]), 0.5));
ok('maxDrawdown monotonic up -> 0', maxDrawdown([1, 2, 3, 4]) === 0);

// --- normalizeGrowth ---
ok('normalizeGrowth fraction->pct', approx(normalizeGrowth(0.12), 12));
ok('normalizeGrowth caps', normalizeGrowth(2.0, 20) === 20);
ok('normalizeGrowth NaN default', normalizeGrowth(NaN) === 5);

// --- estimateGrowth ---
// Allstate-style windfall: +338% quarterly earnings spike must NOT set g.
// Candidates sorted: [-41.7 implied, +3.0 revenue, +338 earnings] -> median 3.0.
const allG = estimateGrowth({ earningsGrowth: 3.384, revGrowth: 0.03, eps: 45.21, forwardEps: 26.37 });
ok('estimateGrowth ignores windfall spike', approx(allG.g, 3.0, 0.1));
ok('estimateGrowth reports its inputs', allG.parts.length === 3);
// MSFT-style steady grower: [15.2, 18.3, 23.4] -> lower-median 18.3, capped at 15.
const msftG = estimateGrowth({ earningsGrowth: 0.234, revGrowth: 0.183, eps: 16.8, forwardEps: 19.36 });
ok('estimateGrowth caps at 15', msftG.g === 15);
// Two candidates take the LOWER middle (conservative).
const twoG = estimateGrowth({ earningsGrowth: 3.384, revGrowth: 0.03 });
ok('estimateGrowth even count picks lower-middle', approx(twoG.g, 3.0, 0.1));
ok('estimateGrowth no data -> 5% default', estimateGrowth({}).g === 5 && estimateGrowth({}).basis === 'default');
ok('estimateGrowth negative clamps to 0', estimateGrowth({ revGrowth: -0.2 }).g === 0);

// --- conservativeEps ---
const dampALL = conservativeEps(45.21, 26.37);
ok('conservativeEps damps windfall', dampALL.damped && approx(dampALL.eps, (45.21 + 26.37) / 2));
const keepMSFT = conservativeEps(16.8, 19.36);
ok('conservativeEps keeps rising earnings', !keepMSFT.damped && keepMSFT.eps === 16.8);
ok('conservativeEps no forward -> unchanged', conservativeEps(5, null).eps === 5);
ok('conservativeEps negative eps untouched', conservativeEps(-2, 1).eps === -2);

// --- runBacktest ---
const hist = [
  { date: '2000-01-01', close: 100 },
  { date: '2000-02-01', close: 60 },   // drops to buy level
  { date: '2000-03-01', close: 80 },
  { date: '2001-01-01', close: 100 },  // recovers to intrinsic -> sell
  { date: '2002-01-01', close: 130 },
];
const bt = runBacktest(hist, 100, { startingBalance: 10000, discountThreshold: 0.3 });
ok('backtest returns object', bt && typeof bt === 'object');
ok('backtest hold buys at start', approx(bt.hold.series[0], 10000));
ok('backtest hold final tracks price', approx(bt.hold.finalValue, 10000 * 130 / 100));
ok('backtest strategy traded', bt.strategy.trades >= 1);
// Strategy buys at 60 (100 units), sells at 100 -> cash 10000*100/60 ≈ 16666, then stays cash.
ok('backtest strategy sold to cash near recovery', bt.strategy.finalValue > 16000 && bt.strategy.finalValue < 17000);
ok('backtest too-short -> null', runBacktest([{ date: '2000-01-01', close: 100 }], 100) === null);
ok('backtest no intrinsic -> hold only, no trades', runBacktest(hist, 0).strategy.trades === 0);

// Growth-scaling: a currently-cheap stock whose earnings grew should NOT
// degenerate to buy-and-hold — the scaled intrinsic line makes it sell early.
const grower = [
  { date: '2005-01-01', close: 10 },
  { date: '2010-01-01', close: 40 },
  { date: '2015-01-01', close: 90 },
  { date: '2020-01-01', close: 160 },
  { date: '2025-01-01', close: 300 },
];
const flat = runBacktest(grower, 600, { growthPct: 0, discountThreshold: 0.3 });
const scaled = runBacktest(grower, 600, { growthPct: 25, discountThreshold: 0.3 });
ok('flat-IV cheap stock degenerates to hold', approx(flat.strategy.finalValue, flat.hold.finalValue, 1e-3));
ok('growth-scaled IV diverges from hold', Math.abs(scaled.strategy.finalValue - scaled.hold.finalValue) > 1);
ok('growth-scaled IV still trades', scaled.strategy.trades >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
