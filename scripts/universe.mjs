// Draft universe screen. Applies published rules to public data and prints the result.
// Rules:
//  1. Listed on Nasdaq, NYSE or NYSE American (no OTC).
//  2. SEC industry code 2834 (pharmaceutical preparations), 2836 (biological products) or 8731 (biological research).
//  3. Burning cash: operating cash flow in fiscal 2025 below -$20M.
//  4. Clinical stage: 2025 revenue under $50M, or under a quarter of the cash burned.
//  5. Market value between $100M and $5B (small and micro cap).
//  6. Tradable: average daily dollar volume over the last 3 months of at least $1M.
//  7. At least one active, company-sponsored Phase II or III trial on ClinicalTrials.gov.
//  Rank: soonest Phase II/III primary completion; keep the first 30.
const UA = process.env.SEC_USER_AGENT || "Helixora research contact@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, sec = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: sec ? { "User-Agent": UA, Accept: "application/json" } : { "User-Agent": "Mozilla/5.0 (Helixora)", Accept: "application/json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(800 * (i + 1));
  }
  return null;
}
const frame = async (tax, tag, unit, period) => {
  const j = await get(`https://data.sec.gov/api/xbrl/frames/${tax}/${tag}/${unit}/${period}.json`, true);
  const m = new Map(); for (const d of j?.data || []) m.set(d.cik, d.val); return m;
};
const funnel = [];
const tk = await get("https://www.sec.gov/files/company_tickers_exchange.json", true);
const rows = tk.data.map(([cik, name, ticker, exchange]) => ({ cik, name, ticker, exchange }));
let c = rows.filter((r) => ["Nasdaq", "NYSE", "NYSE American"].includes(r.exchange));
const byCik = new Map(); for (const r of c) if (!byCik.has(r.cik)) byCik.set(r.cik, r); c = [...byCik.values()];
funnel.push(["Listed on Nasdaq, NYSE or NYSE American", c.length]);
const ocf = await frame("us-gaap", "NetCashProvidedByUsedInOperatingActivities", "USD", "CY2025");
const rev1 = await frame("us-gaap", "Revenues", "USD", "CY2025");
const rev2 = await frame("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "USD", "CY2025");
c = c.filter((r) => ocf.has(r.cik) && ocf.get(r.cik) < -20e6);
funnel.push(["Burned over $20M in operating cash in 2025", c.length]);
c = c.filter((r) => { const rv = Math.max(rev1.get(r.cik) || 0, rev2.get(r.cik) || 0); return rv < 50e6 || rv < -ocf.get(r.cik) / 4; });
funnel.push(["Clinical stage (little revenue)", c.length]);
const keep = [];
for (const r of c) {
  const s = await get(`https://data.sec.gov/submissions/CIK${String(r.cik).padStart(10, "0")}.json`, true);
  await sleep(120);
  if (["2834", "2836", "8731"].includes(String(s?.sic))) keep.push({ ...r, sic: s.sic, sponsor: (s.name || r.name).replace(/,?\s+(inc|corp|corporation|ltd|limited|plc|n\.v|s\.a)\.?$/i, "").trim() });
}
c = keep; funnel.push(["Drug developer industry code (2834, 2836, 8731)", c.length]);
const cash = await frame("us-gaap", "CashAndCashEquivalentsAtCarryingValue", "USD", "CY2026Q2I");
const sh = await frame("dei", "EntityCommonStockSharesOutstanding", "shares", "CY2026Q2I");
const priced = [];
for (const r of c) {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(r.ticker)}?range=3mo&interval=1d`);
  await sleep(150);
  const res = j?.chart?.result?.[0]; const px = res?.meta?.regularMarketPrice;
  const shares = sh.get(r.cik); if (!(px > 0) || !shares) continue;
  const vol = res.indicators?.quote?.[0]?.volume || [], cl = res.indicators?.quote?.[0]?.close || [];
  const dv = vol.map((v, i) => (v && cl[i] ? v * cl[i] : null)).filter(Boolean);
  const adv = dv.length ? dv.reduce((a, b) => a + b, 0) / dv.length : 0;
  priced.push({ ...r, price: px, mcap: px * shares / 1e6, adv: adv / 1e6, cash: (cash.get(r.cik) || 0) / 1e6, burn: -ocf.get(r.cik) / 12e6 });
}
c = priced.filter((r) => r.mcap >= 100 && r.mcap <= 5000); funnel.push(["Market value $100M to $5B", c.length]);
c = c.filter((r) => r.adv >= 1); funnel.push(["Trades at least $1M a day", c.length]);
const today = new Date().toISOString().slice(0, 10);
const norm = (s) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|co|holdings|sa|ag|nv)\b/g, "").replace(/\s+/g, " ").trim();
const withTrials = [];
for (const r of c) {
  const u = new URL("https://clinicaltrials.gov/api/v2/studies");
  u.searchParams.set("query.spons", r.sponsor);
  u.searchParams.set("filter.overallStatus", "RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION");
  u.searchParams.set("filter.advanced", "AREA[Phase](PHASE2 OR PHASE3)");
  u.searchParams.set("fields", "NCTId,LeadSponsorName,Phase,PrimaryCompletionDate,Condition");
  u.searchParams.set("pageSize", "100");
  const j = await get(u.toString()); await sleep(250);
  const want = norm(r.sponsor);
  const own = (j?.studies || []).map((s) => s.protocolSection).filter((p) => { const l = norm(p?.sponsorCollaboratorsModule?.leadSponsor?.name || ""); return l && (l.includes(want) || want.includes(l)); });
  if (!own.length) continue;
  const dates = own.map((p) => { let d = p.statusModule?.primaryCompletionDateStruct?.date; if (d && d.length === 7) d += "-15"; return d; }).filter((d) => d && d >= today).sort();
  const p3 = own.filter((p) => (p.designModule?.phases || []).includes("PHASE3")).length;
  const conds = [...new Set(own.flatMap((p) => p.conditionsModule?.conditions || []))].slice(0, 2);
  withTrials.push({ ...r, trials: own.length, phase3: p3, next: dates[0] || null, conds });
}
c = withTrials; funnel.push(["Has an active company-sponsored Phase II or III trial", c.length]);
c.sort((a, b) => (a.next || "9999") < (b.next || "9999") ? -1 : 1);
const out = { asOf: today, funnel, picked: c.slice(0, 30), qualified: c.length, all: c };
console.log("UNIVERSE_JSON_START" + JSON.stringify(out) + "UNIVERSE_JSON_END");
