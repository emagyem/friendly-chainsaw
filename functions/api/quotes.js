/* ------------------------------------------------------------------
   GET /api/quotes?s=SPY,BTC-USD,AAPL…  Delayed live prices for the
   Markets page and the Virtual Exchange.

   Only symbols on the site can be requested (the instruments in
   server/markets-list.js and the companies in /data/companies.json), up
   to 40 at a time, so this can't be used as a general price proxy. Each
   upstream price is cached at Cloudflare's edge for 3 minutes, and the
   response for 60 seconds, so heavy traffic doesn't multiply requests to
   the data source. Prices are delayed (typically 15 minutes for US
   stocks) and come from Yahoo Finance.
------------------------------------------------------------------- */

import { json, sameOrigin } from "../../server/ask-core.js";
import { MARKET_SYMBOLS } from "../../server/markets-list.js";

let siteTickers = { at: 0, set: null };
async function allowed(env, request) {
  if (!siteTickers.set || Date.now() - siteTickers.at > 30 * 60 * 1000) {
    const set = new Set(MARKET_SYMBOLS);
    try {
      const r = await env.ASSETS.fetch(new URL("/data/companies.json", request.url));
      const d = await r.json();
      for (const c of [...(d.companies || []), ...(d.industry || [])]) set.add(c.t);
    } catch { /* fall back to the market list */ }
    siteTickers = { at: Date.now(), set };
  }
  return siteTickers.set;
}

async function one(s) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=5m`, {
      headers: { "User-Agent": "Mozilla/5.0 (Helixora quotes)" },
      cf: { cacheTtl: 180, cacheEverything: true },
    });
    if (!r.ok) return null;
    const m = (await r.json())?.chart?.result?.[0]?.meta;
    if (!(m?.regularMarketPrice > 0)) return null;
    return { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose ?? null, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, state: m.marketState || null };
  } catch { return null; }
}

export async function onRequestGet({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  const ok = await allowed(env, request);
  const want = [...new Set((new URL(request.url).searchParams.get("s") || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!want.length || want.length > 40) return json(400, { error: "Ask for 1 to 40 symbols" });
  const bad = want.filter((s) => !ok.has(s) && !ok.has(s.toLowerCase()) && ![...ok].some((x) => x.toUpperCase() === s));
  if (bad.length) return json(400, { error: `Not available: ${bad.join(", ")}` });
  // Match the case the list uses (e.g. "^GSPC", "BTC-USD").
  const canon = (s) => [...ok].find((x) => x.toUpperCase() === s) || s;
  const out = {};
  await Promise.all(want.map(async (s) => { const q = await one(canon(s)); if (q) out[canon(s)] = q; }));
  return json(200, { quotes: out, delayed: true, source: "Yahoo Finance" }, { "cache-control": "public, max-age=60" });
}
