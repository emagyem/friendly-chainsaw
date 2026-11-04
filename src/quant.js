/* ------------------------------------------------------------------
   Quantitative models, run in the browser and in the data refresh.

   runwaySim       Monte Carlo of quarterly cash with uncertain, trending
                   burn. Chance the cash runs out by each horizon, with no
                   new financing. A scenario estimate, not a forecast.
   equitySim       Monte Carlo of pipeline value: each program succeeds or
                   fails at its odds, with uncertain peak sales and launch
                   timing. Equity = pipeline + cash − debt, as a range.
   financingModel  Logistic regression for "an offering within 12 months",
                   fit on point-in-time company-quarters and tested by
                   leaving each company out in turn.
------------------------------------------------------------------- */

import { offeringEvents } from "./research.js";

export const QUANT_VERSION = "1.0";
const DAY = 86400000;

// Small seeded generator so every visitor sees the same simulated numbers.
function rng(seed = 42) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  return { u, n };
}
const pctile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
const seedOf = (s) => [...s].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);

/* ----------------------------- runway ----------------------------- */

// Quarter-to-quarter change in trailing burn from past filings sets the drift (at half strength,
// capped at ±10% a quarter) and the volatility (between 5% and 30% a quarter).
export function burnDynamics(c) {
  const b = (c.runwayHist || []).map((r) => r.burn).filter((x) => x > 0).slice(-9);
  const g = [];
  for (let i = 1; i < b.length; i++) g.push(Math.log(b[i] / b[i - 1]));
  if (g.length < 3) return { drift: 0, vol: 0.15, n: g.length };
  const m = g.reduce((s, x) => s + x, 0) / g.length;
  const sd = Math.sqrt(g.reduce((s, x) => s + (x - m) ** 2, 0) / (g.length - 1));
  return { drift: Math.max(-0.1, Math.min(0.1, m / 2)), vol: Math.max(0.05, Math.min(0.3, sd)), n: g.length };
}

export function runwaySim(c, { quarters = 12, sims = 10000 } = {}) {
  if (c.cashFlowPositive || !(c.burn > 0) || !(c.cash > 0)) return null;
  const { drift, vol, n } = burnDynamics(c);
  const r = rng(seedOf(c.t + "runway"));
  const outBy = new Array(quarters).fill(0);
  const ends = [];
  for (let s = 0; s < sims; s++) {
    let cash = c.cash, burn = c.burn * 3, out = null;
    for (let q = 0; q < quarters; q++) {
      burn *= Math.exp(drift - vol * vol / 2 + vol * r.n());
      cash -= burn;
      if (cash <= 0 && out == null) out = q;
    }
    if (out != null) for (let q = out; q < quarters; q++) outBy[q]++;
    ends.push(out == null ? Infinity : (out + 1) * 3);
  }
  ends.sort((a, b) => a - b);
  const curve = outBy.map((k, q) => ({ m: (q + 1) * 3, p: k / sims }));
  const at = (m) => curve.find((x) => x.m === m)?.p ?? null;
  const med = pctile(ends, 0.5);
  return { curve, p6: at(6), p12: at(12), p18: at(18), p24: at(24), p36: at(36), median: isFinite(med) ? med : null, drift, vol, n, horizon: quarters * 3 };
}

/* ----------------------------- valuation ----------------------------- */

const MARGIN = 0.42, RAMP = 5, PEAK_SIGMA = 0.6;
function salesPV(peak, launch, patentYrs, disc) {
  let pv = 0;
  for (let t = 1; t <= Math.ceil(launch) + patentYrs + 2; t++) {
    if (t <= launch) continue;
    const y = t - launch;
    let s = peak * Math.min(1, y / RAMP);
    if (y > patentYrs) s *= 0.25;
    pv += (s * MARGIN) / Math.pow(1 + disc, t);
  }
  return pv;
}
function costPV(cost, launch, disc) {
  const yrs = Math.max(1, Math.round(launch));
  let pv = 0;
  for (let t = 1; t <= yrs; t++) pv += (cost / yrs) / Math.pow(1 + disc, t);
  return pv;
}

export function equitySim(c, { sims = 4000, disc = 0.11 } = {}) {
  const progs = (c.pipeline || []).filter((p) => p.peak > 0);
  if (!progs.length) return null;
  const r = rng(seedOf(c.t + "equity"));
  const vals = [];
  let salesSum = 0, costSum = 0;
  const patentYrs = c.patentYrs || 10;
  for (let s = 0; s < sims; s++) {
    let pipe = 0;
    for (const p of progs) {
      const odds = p.ph === "Approved" ? 1 : (p.odds?.loa ?? null);
      if (odds == null) continue;
      const launch = Math.max(0, (p.launch || 0) + r.n() * (0.25 * (p.launch || 0) + (p.ph === "Approved" ? 0 : 0.5)));
      const win = r.u() < odds;
      const peak = p.peak * Math.exp(-PEAK_SIGMA * PEAK_SIGMA / 2 + PEAK_SIGMA * r.n());
      // Development spend stops early when a program fails, so a failure costs about 45% of the plan.
      const sp = win ? salesPV(peak, launch, patentYrs, disc) : 0;
      const cp = costPV(p.cost || 0, launch, disc) * (win ? 1 : 0.45);
      salesSum += sp; costSum += cp;
      pipe += sp - cp;
    }
    vals.push(pipe + c.cash - (c.debt || 0));
  }
  vals.sort((a, b) => a - b);
  const above = vals.filter((v) => v > c.mcap).length / sims;
  const bins = 24, lo = pctile(vals, 0.01), hi = pctile(vals, 0.99), w = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, i) => ({ x: lo + (i + 0.5) * w, n: 0 }));
  for (const v of vals) { const i = Math.floor((v - lo) / w); if (i >= 0 && i < bins) hist[i].n++; }
  const placeholders = progs.filter((p) => p.est).length;
  // Sales value is proportional to peak sales, so the market value implies a multiple of the assumed peaks.
  const meanSales = salesSum / sims, meanCost = costSum / sims;
  const implied = meanSales > 0 ? (c.mcap - c.cash + (c.debt || 0) + meanCost) / meanSales : null;
  const peakTotal = progs.reduce((s2, p) => s2 + p.peak, 0);
  return { implied, impliedPeak: implied != null ? implied * peakTotal : null, peakTotal, p10: pctile(vals, 0.1), p50: pctile(vals, 0.5), p90: pctile(vals, 0.9), mean: vals.reduce((s, v) => s + v, 0) / sims, above, hist, placeholders, programs: progs.length };
}

/* ------------------------ financing-risk model ------------------------ */

const sig = (z) => 1 / (1 + Math.exp(-z));

// One row per company-quarter, dated by when that balance sheet was FIRST filed.
// Label: the company started a stock offering in the following 12 months.
export function financingDataset(companies, todayIso) {
  const events = offeringEvents(companies);
  const start = events.length ? events.reduce((m, e) => (e.date < m ? e.date : m), events[0].date) : null;
  const cutoff = new Date(Date.parse(todayIso) - 365 * DAY).toISOString().slice(0, 10);
  const rows = [];
  for (const c of companies) {
    const mine = events.filter((e) => e.c.t === c.t).map((e) => e.date);
    const hist = (c.runwayHist || []).filter((h) => h.filed);
    hist.forEach((h, i) => {
      const x = featuresAt(c, hist, i, mine);
      if (!x) return;
      const t = h.filed;
      const end = new Date(Date.parse(t) + 365 * DAY).toISOString().slice(0, 10);
      const known = start && t >= start && t <= cutoff;
      rows.push({ t: c.t, date: t, x, y: known ? (mine.some((d) => d > t && d <= end) ? 1 : 0) : null });
    });
  }
  return { rows, start, cutoff };
}

export const FEATURES = ["Months of cash (log)", "Burn growth over a year", "Raised in the past year"];
function featuresAt(c, hist, i, offerDates) {
  const h = hist[i];
  const runway = h.runway == null ? 120 : Math.max(1, Math.min(120, h.runway));
  const prev = hist[i - 4];
  const growth = prev && prev.burn > 0 && h.burn > 0 ? Math.max(-1, Math.min(1, Math.log(h.burn / prev.burn))) : 0;
  const yearAgo = new Date(Date.parse(h.filed) - 365 * DAY).toISOString().slice(0, 10);
  const raised = offerDates.some((d) => d <= h.filed && d > yearAgo) ? 1 : 0;
  return [Math.log(runway), growth, raised];
}

function fit(rows, lambda = 1, iters = 3000, lr = 0.1) {
  const k = rows[0].x.length;
  const mu = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r.x[j], 0) / rows.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r.x[j] - mu[j]) ** 2, 0) / rows.length) || 1);
  const Z = rows.map((r) => r.x.map((v, j) => (v - mu[j]) / sd[j]));
  let b0 = 0; const w = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    let g0 = 0; const g = new Array(k).fill(0);
    rows.forEach((r, i) => { const e = sig(b0 + Z[i].reduce((s, z, j) => s + z * w[j], 0)) - r.y; g0 += e; Z[i].forEach((z, j) => { g[j] += e * z; }); });
    b0 -= lr * g0 / rows.length;
    for (let j = 0; j < k; j++) w[j] -= lr * (g[j] / rows.length + lambda * w[j] / rows.length);
  }
  return { predict: (x) => sig(b0 + x.reduce((s, v, j) => s + ((v - mu[j]) / sd[j]) * w[j], 0)), w, b0 };
}

export function financingModel(companies, todayIso) {
  const { rows, start, cutoff } = financingDataset(companies, todayIso);
  const train = rows.filter((r) => r.y != null);
  if (train.length < 12 || !train.some((r) => r.y) || train.every((r) => r.y)) return null;
  const base = train.reduce((s, r) => s + r.y, 0) / train.length;
  // Leave one company out: each company is predicted by a model that never saw it.
  let brier = 0, brierBase = 0;
  const tickers = [...new Set(train.map((r) => r.t))];
  for (const t of tickers) {
    const tr = train.filter((r) => r.t !== t), te = train.filter((r) => r.t === t);
    if (!tr.some((r) => r.y) || tr.every((r) => r.y)) continue;
    const m = fit(tr);
    const br = tr.reduce((s, r) => s + r.y, 0) / tr.length;
    for (const r of te) { brier += (m.predict(r.x) - r.y) ** 2; brierBase += (br - r.y) ** 2; }
  }
  brier /= train.length; brierBase /= train.length;
  const model = fit(train);
  const now = companies.map((c) => {
    const latest = rows.filter((r) => r.t === c.t).at(-1);
    return latest ? { t: c.t, asOf: latest.date, p: model.predict(latest.x), x: latest.x } : null;
  }).filter(Boolean).sort((a, b) => b.p - a.p);
  return { n: train.length, events: train.filter((r) => r.y).length, companies: tickers.length, base, brier, brierBase, skill: 1 - brier / brierBase, weights: model.w, now, start, cutoff };
}
