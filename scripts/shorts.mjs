/* ------------------------------------------------------------------
   Short interest from FINRA (consolidated, all exchanges).

   Brokers report the shares their customers hold short twice a month, as of
   settlement dates around the 15th and the end of each month. FINRA publishes
   each cycle about a week later. One request per date covers every ticker.
   FINRA describes this as public data for non-commercial use: check its terms
   before relying on it in a paid product.
------------------------------------------------------------------- */

const URL_SI = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";
const iso = (d) => d.toISOString().slice(0, 10);

// Mid-month and month-end dates going back `months`, newest first.
function candidateDates(today, months) {
  const out = [];
  for (let k = 0; k <= months; k++) {
    const y = today.getUTCFullYear(), m = today.getUTCMonth() - k;
    const end = new Date(Date.UTC(y, m + 1, 0)), mid = new Date(Date.UTC(y, m, 15));
    for (const d of [end, mid]) if (d < today) out.push(d);
  }
  return out;
}

async function fetchCycle(date, tickers) {
  const res = await fetch(URL_SI, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      limit: 5000,
      domainFilters: [{ fieldName: "symbolCode", values: tickers }],
      compareFilters: [{ compareType: "EQUAL", fieldName: "settlementDate", fieldValue: date }],
    }),
  });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`FINRA ${res.status}`);
  const t = await res.text();
  return t.trim() ? JSON.parse(t) : [];
}

// ticker → [{ date, short, adv, dtc }] oldest first, for about the last year.
export async function shortInterest(tickers, { today = new Date(), months = 12, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const out = Object.fromEntries(tickers.map((t) => [t, []]));
  for (const d of candidateDates(today, months)) {
    // Settlement falls on a business day: step back over weekends and holidays until FINRA has rows.
    let rows = [];
    for (let back = 0; back < 4 && !rows.length; back++) {
      const day = new Date(d.getTime() - back * 864e5);
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      try { rows = await fetchCycle(iso(day), tickers); } catch (e) { console.warn(`  short interest ${iso(day)}: ${e.message}`); }
      await wait(300);
    }
    for (const r of rows) {
      if (!out[r.symbolCode]) continue;
      out[r.symbolCode].push({ date: r.settlementDate, short: r.currentShortPositionQuantity, adv: r.averageDailyVolumeQuantity || null, dtc: r.daysToCoverQuantity || null });
    }
  }
  for (const t of tickers) out[t].sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// Latest cycle, its share of shares outstanding, and the change over about three months.
export function summarizeShort(hist, sharesOutM, adr = 1) {
  if (!hist?.length || !(sharesOutM > 0)) return null;
  const last = hist.at(-1), back = hist.length > 6 ? hist.at(-7) : hist[0];
  const pct = (n) => Math.round(((n * (adr || 1)) / (sharesOutM * 1e6)) * 1000) / 10;
  return {
    date: last.date,
    shares: last.short,
    pct: pct(last.short),
    dtc: last.dtc != null ? Math.round(last.dtc * 10) / 10 : null,
    chg3m: back && back !== last && back.short > 0 ? Math.round(((last.short / back.short) - 1) * 1000) / 10 : null,
    history: hist.slice(-24).map((h) => ({ date: h.date, pct: pct(h.short) })),
  };
}
