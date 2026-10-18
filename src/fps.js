/* ------------------------------------------------------------------
   Financing Pressure Score (FPS)

   One number, 0 to 100, for one question: how likely is this company
   to need new money before its next major catalyst? It describes a
   financing situation. It is not a buy or sell signal.

   This module is shared by the website and by the nightly data job
   (scripts/fetch-data.mjs), so the published methodology and the
   published numbers always come from the same code.
------------------------------------------------------------------- */

export const FPS_VERSION = "1.0";
export const FPS_UPDATED = "2026-10-17";
export const BUFFER_MONTHS = 6;
// When no clinical or regulatory event is dated, assume the next one is this far away.
export const NO_CATALYST_MONTHS = 18;

export const FPS_COMPONENTS = [
  { key: "gap", label: "Runway-to-catalyst gap", weight: 0.35,
    measures: "Months of cash left after the next catalyst, with a 6-month buffer",
    rule: "A gap of 18 months or more scores 0; −6 months or less scores 100; linear in between" },
  { key: "trend", label: "Burn trend", weight: 0.15,
    measures: "Change in cash burn versus a year earlier",
    rule: "Burn down 20% or more scores 0; up 40% or more scores 100; linear in between" },
  { key: "capacity", label: "Raise-ready capacity", weight: 0.20,
    measures: "Whether an at-the-market (ATM) program or a shelf registration is on file",
    rule: "Active ATM 80; shelf only 50; neither 20" },
  { key: "debt", label: "Debt due within 24 months", weight: 0.10,
    measures: "Near-term debt relative to cash",
    rule: "No near-term debt scores 0; 50% of cash or more scores 100; linear in between" },
  { key: "access", label: "Market access", weight: 0.10,
    measures: "Annual cash burn as a share of market value",
    rule: "5% or less scores 0; 50% or more scores 100; linear in between" },
  { key: "concentration", label: "Pipeline concentration", weight: 0.10,
    measures: "How much rides on a single program",
    rule: "One program 100; two or three 50; four or more 20" },
];

export const FPS_BANDS = [
  { label: "High", min: 70, max: 100 },
  { label: "Elevated", min: 40, max: 69 },
  { label: "Low", min: 0, max: 39 },
];

export const FPS_CHANGELOG = [
  { version: "1.0", date: "2026-10-17", note: "First published version. Weights are a starting hypothesis and will be backtested against historical offerings; every change will be listed here." },
];

export const bandOf = (s) => (s == null ? null : s >= 70 ? "High" : s >= 40 ? "Elevated" : "Low");

const DAY = 86400000;
const clamp = (v) => Math.max(0, Math.min(100, v));
const lin = (x, zeroAt, hundredAt) => clamp(((x - zeroAt) / (hundredAt - zeroAt)) * 100);
const r1 = (n) => Math.round(n * 10) / 10;
const usd = (m) => (m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);
const daysUntil = (iso, today) => Math.round((new Date(iso + "T00:00:00") - today) / DAY);
const short = (l) => (l || "").replace(/ primary completion \(registry estimate\)/i, " data (est.)").replace(/ primary completion/i, " data");
const fmtDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// The next clinical or regulatory event. Estimated earnings dates only count when nothing else is dated.
export function nextMajorCatalyst(c, today = new Date()) {
  const up = (c.catalysts || []).filter((x) => daysUntil(x.date, today) >= 0)
    .sort((a, b) => daysUntil(a.date, today) - daysUntil(b.date, today));
  return up.find((x) => x.kind !== "earnings") || null;
}

export function computeFPS(c, today = new Date()) {
  const runway = c.cashFlowPositive ? 120 : Math.min(120, c.cash / c.burn);
  const cat = nextMajorCatalyst(c, today);
  const mtc = cat ? daysUntil(cat.date, today) / 30.44 : NO_CATALYST_MONTHS;
  const gap = runway - (mtc + BUFFER_MONTHS);
  const parts = {};

  parts.gap = {
    score: lin(gap, 18, -6),
    value: r1(gap),
    detail: c.cashFlowPositive
      ? "Operating cash flow is positive, so cash is not running down."
      : `${r1(runway)} months of cash − (${r1(mtc)} months to ${cat ? short(cat.label) : "an assumed catalyst"} + ${BUFFER_MONTHS}-month buffer) = ${r1(gap)} months`,
  };

  if (c.cashFlowPositive) {
    parts.trend = { score: 0, value: null, detail: "Operating cash flow is positive." };
  } else if (c.burnPrior > 0) {
    const pct = (c.burn / c.burnPrior - 1) * 100;
    parts.trend = { score: lin(pct, -20, 40), value: r1(pct),
      detail: `$${r1(c.burn)}M a month now vs $${r1(c.burnPrior)}M a year earlier (${pct >= 0 ? "+" : ""}${r1(pct)}%)` };
  }

  if (c.raise) {
    const cap = c.raise.capacity;
    parts.capacity = {
      score: cap === "atm" ? 80 : cap === "shelf" ? 50 : 20,
      value: cap,
      detail: cap === "atm" ? `At-the-market program on file (${c.raise.atm.form}, ${fmtDay(c.raise.atm.date)})`
        : cap === "shelf" ? `Shelf registration on file (${c.raise.shelf.form}, ${fmtDay(c.raise.shelf.date)}), no ATM found`
          : "No shelf registration or ATM program found in the past three years",
      url: cap === "atm" ? c.raise.atm.url : cap === "shelf" ? c.raise.shelf.url : null,
    };
  }

  const due = c.debtDue24 != null ? c.debtDue24 : c.debt === 0 ? 0 : null;
  if (due != null) {
    const pct = c.cash > 0 ? (due / c.cash) * 100 : 100;
    parts.debt = { score: lin(pct, 0, 50), value: r1(pct),
      detail: due === 0 ? "No debt due within 24 months reported" : `${usd(due)} due within 24 months vs ${usd(c.cash)} of cash (${r1(pct)}%)` };
  }

  if (c.mcap > 0) {
    const annual = c.cashFlowPositive ? 0 : c.burn * 12;
    const pct = (annual / c.mcap) * 100;
    parts.access = { score: lin(pct, 5, 50), value: r1(pct),
      detail: `${usd(annual)} a year of burn vs ${usd(c.mcap)} market value (${r1(pct)}%)` };
  }

  const n = (c.pipeline || []).length;
  if (n > 0) {
    parts.concentration = { score: n === 1 ? 100 : n <= 3 ? 50 : 20, value: n,
      detail: `${n} clinical program${n === 1 ? "" : "s"} tracked` };
  }

  let total = 0, weight = 0;
  const rows = FPS_COMPONENTS.map((k) => {
    const p = parts[k.key];
    if (p) { total += p.score * k.weight; weight += k.weight; }
    return { ...k, ...(p || {}), present: !!p, score: p ? Math.round(p.score) : null };
  });
  const score = weight > 0 ? Math.round(total / weight) : null;
  // Contribution is shown against the weights actually used, so the column adds up to the score.
  rows.forEach((row) => { row.contribution = row.present ? r1((row.score * row.weight) / weight) : null; });

  return {
    score, band: bandOf(score), parts: rows,
    runway: r1(runway), monthsToCatalyst: r1(mtc), gap: r1(gap), catalyst: cat,
    coverage: Math.round(weight * 100),
    missing: rows.filter((x) => !x.present).map((x) => x.label),
  };
}
