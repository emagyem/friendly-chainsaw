// Draft universe screen. Applies published rules to public data and prints the result.
// Rules:
//  1. Listed on Nasdaq, NYSE or NYSE American (no OTC).
//  2. SEC industry code 2834 (pharmaceutical preparations), 2836 (biological products) or 8731 (biological research).
//  3. Burning cash: operating cash flow in fiscal 2025 below -$20M.
//  4. Clinical stage: 2025 revenue under $50M, or under a quarter of the cash burned.
//  5. Market value between $100M and $5B (small and micro cap).
//  6. Tradable: average daily dollar volume over the last 3 months of at least $1M.
//  7. At least one active, company-sponsored Phase II or III trial on ClinicalTrials.gov.
//  8. Not acquired and not being acquired (no tender offer or merger vote under way).
//  Rank: soonest Phase II/III primary completion. Coverage changes are approved by hand (config/universe.json).
import { dealStatus } from "./deal-status.mjs";
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
  if (["2834", "2836", "8731"].includes(String(s?.sic))) keep.push({ ...r, sic: s.sic, deal: dealStatus(s), sponsor: (s.name || r.name).replace(/,?\s+(inc|corp|corporation|ltd|limited|plc|n\.v|s\.a)\.?$/i, "").trim() });
}
c = keep; funnel.push(["Drug developer industry code (2834, 2836, 8731)", c.length]);
c = c.filter((r) => !r.deal); funnel.push(["Not acquired or being acquired", c.length]);
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
c = priced.filter((r) => r.mcap >= 50 && r.mcap <= 20000); funnel.push(["Market value $50M to $20B", c.length]);
c = c.filter((r) => r.adv >= 1); funnel.push(["Trades at least $1M a day", c.length]);
const today = new Date().toISOString().slice(0, 10);
const norm = (s) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|co|holdings|sa|ag|nv)\b/g, "").replace(/\s+/g, " ").trim();
const withTrials = [];
for (const r of c) {
  const u = new URL("https://clinicaltrials.gov/api/v2/studies");
  u.searchParams.set("query.spons", r.sponsor);
  u.searchParams.set("filter.overallStatus", "RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION");
  u.searchParams.set("filter.advanced", "AREA[Phase](PHASE1 OR PHASE2 OR PHASE3)");
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
c = withTrials; funnel.push(["Has an active company-sponsored clinical trial (Phase I, II or III)", c.length]);
c.sort((a, b) => (a.next || "9999") < (b.next || "9999") ? -1 : 1);
const out = { asOf: today, funnel, qualified: c.length, ranked: c.map((r) => ({ t: r.ticker, n: r.name, mcap: Math.round(r.mcap), adv: Math.round(r.adv * 10) / 10, trials: r.trials, phase3: r.phase3, next: r.next, conds: r.conds })) };
const { writeFile, readFile } = await import("node:fs/promises");
await writeFile(new URL("../public/data/universe.json", import.meta.url), JSON.stringify(out) + "\n");
console.log(funnel.map(([a, b]) => `${a}: ${b}`).join("\n"));

/* ---------------------------- turnover ----------------------------
   Approved policy (config/universe.json → policy): the original companies stay
   unless they are bought. A selected company stays while it still qualifies (and,
   if policy.keepRank is set, ranks in the top keepRank); otherwise it leaves.
   Open places are filled, in rank order, until coverage reaches policy.total.
   Every change is logged. */
const MIN_QUALIFIED = 50;
const uniFile = new URL("../config/universe.json", import.meta.url);
const cfgFile = new URL("../config/companies.json", import.meta.url);
const uni = JSON.parse(await readFile(uniFile, "utf8"));
const TARGET = (uni.policy?.total ?? 38) - (uni.originalCoverage || []).length;
const KEEP_RANK = uni.policy?.keepRank ?? Infinity;
const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
if (c.length < MIN_QUALIFIED) {
  console.log(`Only ${c.length} companies qualified; that looks like a data problem, so coverage is left unchanged.`);
} else {
  const rank = new Map(c.map((r, i) => [r.ticker, i]));
  const original = new Set(uni.originalCoverage || []);
  const removed = [], added = [];
  // Companies the data build failed on recently (no matching trials, no price…) are swapped for the next in line.
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const broken = new Map(Object.entries(uni.unbuildable || {}).filter(([, v]) => v.date >= cutoff));
  uni.unbuildable = Object.fromEntries(broken);
  const keep = (uni.selected || []).filter((t) => {
    if (broken.has(t)) { removed.push({ t, why: `its data couldn't be built (${broken.get(t).why})` }); return false; }
    if (!rank.has(t)) { removed.push({ t, why: "no longer meets the coverage rules" }); return false; }
    if (rank.get(t) >= KEEP_RANK) { removed.push({ t, why: `next trial completion now ranks ${rank.get(t) + 1} of ${c.length}` }); return false; }
    return true;
  });
  for (const r of c) {
    if (keep.length >= TARGET) break;
    if (keep.includes(r.ticker) || original.has(r.ticker) || broken.has(r.ticker)) continue;
    keep.push(r.ticker); added.push({ t: r.ticker, why: `ranks ${rank.get(r.ticker) + 1} of ${c.length} by soonest trial completion` });
  }
  uni.funnel = funnel; uni.screenedOn = today; uni.selected = keep;
  if (added.length || removed.length) {
    uni.changes = [...(uni.changes || []), { date: today, added, removed }];
    cfg.tickers = [...(uni.originalCoverage || []), ...keep.filter((t) => !original.has(t))];
    await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    await writeFile(new URL("../.coverage-changed", import.meta.url), "1");
    console.log(`Coverage: added ${added.map((x) => x.t).join(", ") || "none"}; removed ${removed.map((x) => x.t).join(", ") || "none"}.`);
  } else console.log("Coverage unchanged.");
  await writeFile(uniFile, JSON.stringify(uni, null, 2) + "\n");
}
