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

/* --------------------------- burn forecast ---------------------------
   Holt's linear exponential smoothing on quarterly burn (from trailing
   twelve-month figures in past filings), with a widening interval. */

export function burnForecast(c, quarters = 4, alpha = 0.5, beta = 0.3) {
  const hist = (c.runwayHist || []).filter((r) => r.burn > 0).slice(-12);
  if (hist.length < 4 || c.cashFlowPositive) return null;
  const y = hist.map((r) => r.burn * 3);
  let level = y[0], trend = y[1] - y[0];
  const resid = [];
  for (let i = 1; i < y.length; i++) {
    const fc = level + trend;
    resid.push(y[i] - fc);
    const prevLevel = level;
    level = alpha * y[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const sd = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, resid.length - 1));
  const last = hist.at(-1).end;
  const fc = Array.from({ length: quarters }, (_, h) => {
    const v = Math.max(0, level + (h + 1) * trend);
    const band = 1.28 * sd * Math.sqrt(h + 1);
    const d = new Date(Date.parse(last) + (h + 1) * 91.3 * DAY).toISOString().slice(0, 10);
    return { d, v, lo: Math.max(0, v - band), hi: v + band };
  });
  return { history: hist.map((r) => ({ d: r.end, v: r.burn * 3 })), forecast: fc, sd };
}

/* ---------------------------- raise estimate ----------------------------
   Money needed to fund operations to 12 months past the next major catalyst
   (plus the score's 6-month buffer), at forecast burn. A scenario, not a call. */

export function raiseEstimate(c, monthsToCatalyst, { discount = 0.12, after = 12, buffer = 6 } = {}) {
  if (c.cashFlowPositive || !(c.burn > 0) || !c.quote?.price) return null;
  const f = burnForecast(c);
  const months = (monthsToCatalyst ?? 18) + after + buffer;
  // Forecast burn for the first year, then hold the last forecast quarter flat.
  let need = 0;
  for (let m = 0; m < months; m++) {
    const q = Math.floor(m / 3);
    const qb = f ? (f.forecast[Math.min(q, f.forecast.length - 1)].v) : c.burn * 3;
    need += qb / 3;
  }
  const gap = need - c.cash;
  if (gap <= 0) return { gap: 0, months, need };
  const price = c.quote.price * (1 - discount);
  const newShares = gap / price;
  return { gap, months, need, newShares, dilution: newShares / (c.shares + newShares), price, discount };
}

/* ---------------------------- anomaly alerts ----------------------------
   Robust z-scores (median and median absolute deviation) so one wild value
   doesn't hide the next. Flags only what is unusual for that company. */

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const robustZ = (x, xs) => { const m = median(xs); const mad = median(xs.map((v) => Math.abs(v - m))) * 1.4826; return mad > 0 ? (x - m) / mad : 0; };

export function anomalies(c, { benchmark, history, todayIso } = {}) {
  const out = [];
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const daysAgo = (d) => Math.round((Date.parse(today) - Date.parse(d)) / DAY);
  // 1. Burn jump in the latest filing
  const b = (c.runwayHist || []).filter((r) => r.burn > 0);
  if (b.length >= 6) {
    const ch = b.slice(1).map((r, i) => Math.log(r.burn / b[i].burn));
    const last = ch.at(-1), z = robustZ(last, ch.slice(0, -1));
    if (Math.abs(z) >= 3 && Math.abs(last) >= 0.15) out.push({ kind: "burn", sev: last > 0 ? "med" : "low", date: b.at(-1).filed, text: `Burn ${last > 0 ? "jumped" : "fell"} ${Math.round(Math.abs(Math.exp(last) - 1) * 100)}% in the latest filing, far outside its usual quarter-to-quarter change.` });
  }
  // 2. Unusual price move against the biotech index in the last week
  const h = c.quote?.history || [];
  const bm = benchmark?.history ? new Map(benchmark.history) : null;
  if (h.length > 60) {
    const ar = [];
    for (let i = 1; i < h.length; i++) {
      const r = h[i][1] / h[i - 1][1] - 1;
      const b0 = bm?.get(h[i - 1][0]), b1 = bm?.get(h[i][0]);
      ar.push({ d: h[i][0], v: r - (b0 && b1 ? b1 / b0 - 1 : 0) });
    }
    const base = ar.slice(0, -5).map((x) => x.v);
    for (const x of ar.slice(-5)) {
      const z = robustZ(x.v, base);
      if (Math.abs(z) >= 4 && Math.abs(x.v) >= 0.08) out.push({ kind: "price", sev: "med", date: x.d, text: `Shares moved ${x.v > 0 ? "+" : "−"}${Math.round(Math.abs(x.v) * 100)}% against the biotech index on ${x.d}, an unusually large move for this stock.` });
    }
  }
  // 3. New offering filings
  for (const f of (c.financings || []).filter((f) => daysAgo(f.date) >= 0 && daysAgo(f.date) <= 21)) {
    out.push({ kind: "offering", sev: "high", date: f.date, url: f.url, text: `New offering filing: ${f.type}.` });
  }
  // 4. Trial dates pushed back
  for (const p of c.pipeline || []) if (p.slips > 0) out.push({ kind: "trial", sev: "med", date: null, text: `${p.d}: completion date pushed back ${p.slips} time${p.slips === 1 ? "" : "s"} since tracking began.` });
  // 5. Financing Pressure band change in the last two weeks of snapshots
  const snaps = (history?.snapshots || []).filter((s) => s.scores?.[c.t]);
  if (snaps.length >= 2) {
    const recent = snaps.filter((s) => daysAgo(s.date) <= 14);
    const before = snaps.filter((s) => daysAgo(s.date) > 14).at(-1) || recent[0];
    const now = snaps.at(-1);
    if (before && now && before.scores[c.t].band !== now.scores[c.t].band) out.push({ kind: "score", sev: "med", date: now.date, text: `Financing pressure moved from ${before.scores[c.t].band} to ${now.scores[c.t].band}.` });
  }
  return out.map((a) => ({ ...a, t: c.t }));
}
