// Coverage screen. Applies published rules to public data and prints the result.
// Rules (approved 2026-11-17: every surviving pre-revenue drug developer):
//  1. Listed today on Nasdaq, NYSE or NYSE American (no OTC), per the SEC's list of listed companies.
//  2. SEC industry code 2834 (pharmaceutical preparations), 2836 (biological products) or 8731 (biological research).
//  3. Still standing: not bought or delisted, no bankruptcy or wind-down delisting, and still filing
//     quarterly or annual reports (one in the last 15 months).
//  4. Burning cash: operating cash flow negative in the latest fiscal year (any fiscal year end, any currency).
//  5. Pre-revenue: latest fiscal-year revenue under $50M, or under a quarter of the cash burned.
//  6. Still trading: a current stock price.
//  No size, trading-volume or trial filters. Companies that died stay in the historical backtest
//  (scripts/backtest.mjs), so the track record isn't flattered by survivors.
import { dealStatus } from "./deal-status.mjs";
const UA = process.env.SEC_USER_AGENT || "Helixora research contact@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SEC allows 10 requests a second; stay under it across all workers.
let nextSlot = 0;
async function secSlot() { const now = Date.now(); const at = Math.max(now, nextSlot); nextSlot = at + 125; if (at > now) await sleep(at - now); }
async function get(url, sec = false) {
  for (let i = 0; i < 4; i++) {
    try {
      if (sec) await secSlot();
      const r = await fetch(url, { headers: sec ? { "User-Agent": UA, Accept: "application/json" } : { "User-Agent": "Mozilla/5.0 (Helixora)", Accept: "application/json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(1000 * (i + 1));
  }
  return null;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const cik10 = (c) => String(c).padStart(10, "0");

// Latest full fiscal year of a concept, from the company's own annual report.
async function latestAnnual(cik, concepts) {
  let best = null;
  for (const [tax, tag] of concepts) {
    const j = await get(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(cik)}/${tax}/${tag}.json`, true);
    for (const [unit, rows] of Object.entries(j?.units || {})) {
      for (const f of rows) {
        if (!f.start || !f.end || !/^(10-K|20-F|40-F)/.test(f.form || "")) continue;
        const days = (Date.parse(f.end) - Date.parse(f.start)) / 86400000;
        if (days < 330 || days > 400) continue;
        if (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed)) best = { val: f.val, end: f.end, filed: f.filed, unit };
      }
    }
  }
  return best;
}

const funnel = [];
const tk = await get("https://www.sec.gov/files/company_tickers_exchange.json", true);
const rows = tk.data.map(([cik, name, ticker, exchange]) => ({ cik, name, ticker, exchange }));
let c = rows.filter((r) => ["Nasdaq", "NYSE", "NYSE American"].includes(r.exchange));
const byCik = new Map(); for (const r of c) if (!byCik.has(r.cik)) byCik.set(r.cik, r); c = [...byCik.values()];
funnel.push(["Listed today on Nasdaq, NYSE or NYSE American", c.length]);

const subs = await pool(c, 8, async (r) => {
  const s = await get(`https://data.sec.gov/submissions/CIK${cik10(r.cik)}.json`, true);
  if (!["2834", "2836", "8731"].includes(String(s?.sic))) return null;
  const rec = s.filings?.recent || {};
  const lastReport = (rec.form || []).map((f, i) => /^(10-[QK]|20-F|40-F)(\/A)?$/.test(f) ? rec.filingDate[i] : null).filter(Boolean).sort().at(-1) || null;
  return { ...r, sic: s.sic, deal: dealStatus(s), lastReport, sponsor: (s.name || r.name).replace(/,?\s+(inc|corp|corporation|ltd|limited|plc|n\.v|s\.a)\.?$/i, "").trim() };
});
c = subs.filter(Boolean); funnel.push(["Drug developer industry code (2834, 2836, 8731)", c.length]);
const died = [];
c = c.filter((r) => {
  if (r.deal && r.deal.status !== "pending") { died.push({ t: r.ticker, why: r.deal.status }); return false; }
  if (!r.lastReport || r.lastReport < daysAgo(456)) { died.push({ t: r.ticker, why: "stopped filing reports" }); return false; }
  return true;
});
funnel.push(["Still standing (not bought, delisted or wound down; still filing reports)", c.length]);

const OCF = [["us-gaap", "NetCashProvidedByUsedInOperatingActivities"], ["us-gaap", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], ["ifrs-full", "CashFlowsFromUsedInOperatingActivities"]];
const REV = [["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["ifrs-full", "Revenue"]];
const withFin = await pool(c, 8, async (r) => {
  const ocf = await latestAnnual(r.cik, OCF);
  if (!ocf || !(ocf.val < 0)) return null;
  const rev = await latestAnnual(r.cik, REV);
  const rv = rev && rev.unit === ocf.unit && rev.end >= ocf.end ? rev.val : rev && !rev.unit.startsWith("USD") ? null : rev?.val || 0;
  return { ...r, ocf: ocf.val, unit: ocf.unit, fy: ocf.end, rev: rv ?? 0 };
});
c = withFin.filter(Boolean); funnel.push(["Burning cash in its latest fiscal year", c.length]);
// $50M only applies to figures in dollars; for other currencies the share-of-burn test decides.
c = c.filter((r) => (r.unit.startsWith("USD") && r.rev < 50e6) || r.rev < -r.ocf / 4);
funnel.push(["Pre-revenue (revenue under $50M, or under a quarter of cash burned)", c.length]);

const priced = await pool(c, 4, async (r) => {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(r.ticker)}?range=3mo&interval=1d`);
  const res = j?.chart?.result?.[0]; const px = res?.meta?.regularMarketPrice;
  if (!(px > 0)) return null;
  const vol = res.indicators?.quote?.[0]?.volume || [], cl = res.indicators?.quote?.[0]?.close || [];
  const dv = vol.map((v, i) => (v && cl[i] ? v * cl[i] : null)).filter(Boolean);
  return { ...r, price: px, adv: dv.length ? dv.reduce((a, b) => a + b, 0) / dv.length / 1e6 : 0 };
});
c = priced.filter(Boolean); funnel.push(["Still trading (has a current stock price)", c.length]);

// Trials are shown for context and used for ordering only; they no longer decide coverage.
const norm = (s) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|co|holdings|sa|ag|nv)\b/g, "").replace(/\s+/g, " ").trim();
c = await pool(c, 3, async (r) => {
  const u = new URL("https://clinicaltrials.gov/api/v2/studies");
  u.searchParams.set("query.spons", r.sponsor);
  u.searchParams.set("filter.overallStatus", "RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION");
  u.searchParams.set("filter.advanced", "AREA[Phase](PHASE1 OR PHASE2 OR PHASE3)");
  u.searchParams.set("fields", "NCTId,LeadSponsorName,Phase,PrimaryCompletionDate,Condition");
  u.searchParams.set("pageSize", "100");
  const j = await get(u.toString()); await sleep(200);
  const want = norm(r.sponsor);
  const own = (j?.studies || []).map((s) => s.protocolSection).filter((p) => { const l = norm(p?.sponsorCollaboratorsModule?.leadSponsor?.name || ""); return l && (l.includes(want) || want.includes(l)); });
  const dates = own.map((p) => { let d = p.statusModule?.primaryCompletionDateStruct?.date; if (d && d.length === 7) d += "-15"; return d; }).filter((d) => d && d >= today).sort();
  const p3 = own.filter((p) => (p.designModule?.phases || []).includes("PHASE3")).length;
  const conds = [...new Set(own.flatMap((p) => p.conditionsModule?.conditions || []))].slice(0, 2);
  return { ...r, trials: own.length, phase3: p3, next: dates[0] || null, conds };
});
c.sort((a, b) => (a.next || "9999") < (b.next || "9999") ? -1 : a.next === b.next ? a.ticker.localeCompare(b.ticker) : 1);
const out = { asOf: today, funnel, qualified: c.length, excludedAsDead: died, ranked: c.map((r) => ({ t: r.ticker, n: r.name, adv: Math.round(r.adv * 10) / 10, trials: r.trials, phase3: r.phase3, next: r.next, conds: r.conds, fy: r.fy })) };
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
const TARGET = (uni.policy?.total ?? Infinity) - (uni.originalCoverage || []).length;
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
    if (!rank.has(t)) {
      const d = died.find((x) => x.t === t);
      removed.push({ t, why: d ? ({ acquired: "bought", delisted: "delisted" }[d.why] || d.why) : "no longer meets the coverage rules" });
      return false;
    }
    if (rank.get(t) >= KEEP_RANK) { removed.push({ t, why: `next trial completion now ranks ${rank.get(t) + 1} of ${c.length}` }); return false; }
    return true;
  });
  for (const r of c) {
    if (keep.length >= TARGET) break;
    if (keep.includes(r.ticker) || original.has(r.ticker) || broken.has(r.ticker)) continue;
    keep.push(r.ticker); added.push({ t: r.ticker, why: "meets the coverage rules" });
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
