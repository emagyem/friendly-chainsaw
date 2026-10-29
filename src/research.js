/* ------------------------------------------------------------------
   Research studies run in the browser on the site's own data file.

   offeringStudy  An event study of share prices around stock offerings
                  (424B prospectus filings), measured against the XBI
                  biotech ETF when the benchmark is available.
   momentum       3-, 6- and 12-month price returns, ranked.

   Both are descriptive. With a handful of companies they show what
   happened, not a tested trading signal; the page says so.
------------------------------------------------------------------- */

export const OFFERING_FORMS = /424B4|424B5|Priced offering|Shelf takedown/;
export const PRE = 10;   // trading days shown before the event
export const POST = 20;  // trading days shown after the event
const CLUSTER_DAYS = 5;  // a preliminary and final prospectus a few days apart = one offering

const DAY = 86400000;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Collapse each company's offering filings into one event per offering (the first filing date).
export function offeringEvents(companies) {
  const out = [];
  for (const c of companies) {
    const filings = (c.financings || []).filter((f) => OFFERING_FORMS.test(f.type || "")).sort((a, b) => a.date.localeCompare(b.date));
    let last = null;
    for (const f of filings) {
      if (last && dayDiff(last.date, f.date) <= CLUSTER_DAYS) { last.filings.push(f); continue; }
      last = { c, date: f.date, url: f.url, filings: [f] };
      out.push(last);
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// Close-to-close path around one event. Day 0 = last close BEFORE the first filing date,
// so the move on the announcement day itself counts as day +1.
function pathFor(history, date, bench) {
  const i0 = history.findLastIndex(([d]) => d < date);
  if (i0 < PRE || i0 + 1 >= history.length) return null;
  const p0 = history[i0][1];
  const bMap = bench ? new Map(bench) : null;
  const b0 = bMap?.get(history[i0][0]);
  const pts = [];
  for (let k = -PRE; k <= POST; k++) {
    const row = history[i0 + k];
    if (!row) break;
    const raw = row[1] / p0 - 1;
    const b = bMap && b0 ? bMap.get(row[0]) : null;
    pts.push({ k, date: row[0], raw, abn: b != null ? raw - (b / b0 - 1) : null });
  }
  return pts;
}

export function offeringStudy(companies, benchmark) {
  const bench = benchmark?.history?.length ? benchmark.history : null;
  const useAbn = !!bench;
  const rows = [];
  for (const e of offeringEvents(companies)) {
    const h = e.c.quote?.history || [];
    if (h.length < PRE + 2) continue;
    const pts = pathFor(h, e.date, bench);
    if (!pts) continue; // outside the price history the site keeps
    const at = (k) => pts.find((p) => p.k === k);
    const val = (k) => { const p = at(k); return p ? (useAbn ? p.abn : p.raw) : null; };
    // Run-up: from day -10 to day 0, i.e. the inverse of the day -10 point.
    const p10 = at(-PRE);
    let pre = null;
    if (p10) {
      const raw = 1 / (1 + p10.raw) - 1;
      const bench10 = p10.abn != null ? 1 / (1 + (p10.raw - p10.abn)) - 1 : null;
      pre = useAbn ? (bench10 != null ? raw - bench10 : null) : raw;
    }
    rows.push({ ...e, pts, d1: val(1), d5: val(5), d20: val(20), pre });
  }
  // Average path across events (each day uses the events that reach it).
  const path = [];
  for (let k = -PRE; k <= POST; k++) {
    const xs = rows.map((r) => r.pts.find((p) => p.k === k)).filter(Boolean).map((p) => (useAbn ? p.abn : p.raw)).filter((x) => x != null);
    if (xs.length) path.push({ k, avg: mean(xs) * 100, n: xs.length });
  }
  const sum = (key) => {
    const xs = rows.map((r) => r[key]).filter((x) => x != null);
    return { n: xs.length, mean: mean(xs), median: median(xs), down: xs.length ? xs.filter((x) => x < 0).length / xs.length : null };
  };
  return { rows, path, useAbn, benchmark: bench ? benchmark : null, d1: sum("d1"), d5: sum("d5"), d20: sum("d20") };
}

// Price return over the last n trading days, and the same for the benchmark.
function ret(history, n) {
  if (!history || history.length <= n) return null;
  return history.at(-1)[1] / history.at(-1 - n)[1] - 1;
}

export function momentum(companies, benchmark) {
  const b = benchmark?.history || null;
  const bm = { m3: ret(b, 63), m6: ret(b, 126), m12: ret(b, Math.min(251, (b?.length || 1) - 1)) };
  const rows = companies.map((c) => {
    const h = c.quote?.history || [];
    return { c, m3: ret(h, 63), m6: ret(h, 126), m12: ret(h, Math.min(251, h.length - 1)) };
  }).sort((a, b2) => (b2.m6 ?? -9) - (a.m6 ?? -9));
  return { rows, bench: b ? bm : null };
}
