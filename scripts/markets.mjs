/* ------------------------------------------------------------------
   Markets data: indexes, Treasury yields, commodities, currencies,
   crypto and the funds tradable in the Virtual Exchange, each with a
   year of daily closes. Writes public/data/markets.json; run by the
   daily refresh. Prices are end-of-day or delayed (Yahoo Finance); the
   site tops them up during the day through /api/quotes.
------------------------------------------------------------------- */

import { writeFile } from "node:fs/promises";
import { MARKET_GROUPS, TRADABLE_FUNDS, MARKET_SYMBOLS } from "../server/markets-list.js";

const OUT = new URL("../public/data/markets.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A year of daily closes at full precision (currencies and yields need more than cents).
async function yahooQuote(s) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0 (Helixora markets)" } });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  const m = res?.meta;
  if (!(m?.regularMarketPrice > 0)) return null;
  const closes = res.indicators?.quote?.[0]?.close || [];
  const history = (res.timestamp || []).map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), closes[i]]).filter(([, c]) => c != null);
  const date = new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10);
  const prior = history.filter(([d]) => d < date);
  const vals = history.map(([, c]) => c);
  return { price: m.regularMarketPrice, date, history, prev: prior.length ? prior.at(-1)[1] : m.chartPreviousClose ?? null,
    hi52: m.fiftyTwoWeekHigh || Math.max(...vals), lo52: m.fiftyTwoWeekLow || Math.min(...vals) };
}

const names = Object.fromEntries([...MARKET_GROUPS.flatMap((g) => g.items), ...TRADABLE_FUNDS]);
const quotes = {};
const missing = [];
for (const s of MARKET_SYMBOLS) {
  await sleep(250);
  let q = null;
  try { q = await yahooQuote(s); } catch { q = null; }
  if (!q) { missing.push(s); console.warn("!", s, "no data"); continue; }
  const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
  quotes[s] = {
    s, n: names[s], price: r4(q.price), prev: r4(q.prev), date: q.date, hi52: r4(q.hi52), lo52: r4(q.lo52),
    history: q.history.map(([d, c]) => [d, r4(c)]),
  };
  console.log(s, q.price, q.date);
}
await writeFile(OUT, JSON.stringify({ meta: { generatedAt: new Date().toISOString(), source: "Yahoo Finance (end-of-day / delayed)", missing }, quotes }));
console.log(`Wrote markets.json: ${Object.keys(quotes).length} instruments, ${missing.length} missing.`);
