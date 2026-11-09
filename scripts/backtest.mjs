#!/usr/bin/env node
/* ------------------------------------------------------------------
   HELIXORA historical backtest

   Question: did the Financing Pressure Score flag biotechs before they
   sold stock? Tested on every cash-burning biotech that filed with the
   SEC since 2012, including companies that later went bankrupt, were
   acquired or delisted, so the result isn't flattered by survivors.

   Everything is point-in-time: each company-quarter only uses figures
   that had been filed with the SEC by that date.

   Sources (all SEC EDGAR, free):
     - XBRL frames        every company reporting R&D spending, by period
                          (this finds dead companies too)
     - submissions        industry code, every filing and its date
     - companyfacts       cash, investments, operating cash flow, debt,
                          revenue, shares, public float, with filing dates
     - full-text search   at-the-market (ATM) sales agreements in
                          prospectus supplements, 2009 onward

   Not included in this version (see "limits" in the output):
     - catalyst timing: past expected trial dates aren't available in bulk,
       so every company gets the score's standard 18-month assumption
     - pipeline concentration
     - stock prices: market access uses the public float companies report
       in their 10-K instead, which exists for delisted companies too

   Usage: SEC_USER_AGENT="Name you@example.com" node scripts/backtest.mjs
------------------------------------------------------------------- */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { computeFPS, FPS_VERSION } from "../src/fps.js";
import { candidateSentences, eventsFromSentences, toText } from "./guidance.mjs";

const UA = process.env.SEC_USER_AGENT;
if (!UA) { console.error("Set SEC_USER_AGENT"); process.exit(1); }
const ROOT = new URL("../", import.meta.url);
const OUT = new URL("public/data/backtest.json", ROOT);
const CACHE = new URL(".cache/backtest/", ROOT);

const DAY = 86400000;
const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);
const START = "2012-01-01";
const SICS = new Set(["2834", "2836", "8731"]); // pharma preparations, biological products, commercial biological research
const MAX_REVENUE_M = 50; // trailing revenue above this isn't "clinical stage"
const JUMP = 0.15;
// A few well-known cases printed in full so the results can be checked by hand:
// Achaogen (bankrupt 2019), Clovis Oncology (bankrupt 2022), Viking Therapeutics, Arrowhead.
const EXAMPLES = new Set([1301501, 1466301, 1607678, 879407]); // a 15%+ jump in shares outstanding counts as a raise (catches ATM sales and private placements)

const toDate = (iso) => new Date(iso + "T00:00:00Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso, n) => new Date(toDate(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const shiftYears = (iso, y) => { const d = toDate(iso); d.setUTCFullYear(d.getUTCFullYear() + y); return d.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => (toDate(b) - toDate(a)) / DAY / 30.44;
const near = (a, b, tol = 20) => Math.abs(toDate(a) - toDate(b)) <= tol * DAY;
const M = (v) => v / 1e6;
const LAST_ASOF = addDays(TODAY_ISO, -365 - 45); // need a full year of outcomes after each date, plus filing lag

/* ------------------------------ fetching ------------------------------ */

let calls = 0;
async function sec(url, { cacheKey, json = true } = {}) {
  const file = cacheKey ? new URL(cacheKey.replace(/[^\w.-]/g, "_"), CACHE) : null;
  if (file && existsSync(file)) { const t = await readFile(file, "utf8"); return json ? JSON.parse(t) : t; }
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(125); // SEC fair access: under 10 requests a second
    calls++;
    let res;
    try { res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } }); }
    catch { await sleep(2000 * attempt); continue; }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const t = await res.text();
    if (file) await writeFile(file, t);
    return json ? JSON.parse(t) : t;
  }
  return null;
}

/* ------------------------- 1. the universe ------------------------- */

async function candidates() {
  const ciks = new Map();
  const periods = [];
  for (let y = 2010; y <= TODAY.getUTCFullYear(); y++) {
    periods.push(`CY${y}`);
    for (let q = 1; q <= 4; q++) periods.push(`CY${y}Q${q}`);
  }
  for (const p of periods) {
    const f = await sec(`https://data.sec.gov/api/xbrl/frames/us-gaap/ResearchAndDevelopmentExpense/USD/${p}.json`, { cacheKey: `frame-${p}.json` });
    for (const r of f?.data || []) if (!ciks.has(r.cik)) ciks.set(r.cik, r.entityName);
  }
  return ciks;
}

const pad = (cik) => String(cik).padStart(10, "0");

async function filingsFor(cik) {
  const sub = await sec(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`, { cacheKey: `sub-${cik}.json` });
  if (!sub) return null;
  const rows = [];
  const add = (r) => { for (let i = 0; i < r.form.length; i++) rows.push({ form: r.form[i], date: r.filingDate[i], adsh: r.accessionNumber[i], doc: r.primaryDocument?.[i] }); };
  add(sub.filings.recent);
  return { sub, rows, add };
}

/* -------------------- 2. ATM programs (full-text search) -------------------- */

// The defined terms brokers use for at-the-market sales agreements.
const ATM_PHRASES = ['"sales agreement"', '"equity distribution agreement"', '"open market sale agreement"', '"controlled equity offering"', '"at market issuance sales agreement"', '"at-the-market sales agreement"', '"equity sales agreement"'];

async function atmFilings() {
  const hits = new Map(); // cik -> sorted dates
  for (let y = 2009; y <= TODAY.getUTCFullYear(); y++) {
    for (const phrase of ATM_PHRASES) {
      for (let from = 0; from < 3000; from += 100) {
        const q = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(phrase)}&forms=424B5&dateRange=custom&startdt=${y}-01-01&enddt=${y}-12-31&from=${from}`;
        const r = await sec(q, { cacheKey: `efts-${y}-${phrase}-${from}.json` });
        const list = r?.hits?.hits || [];
        for (const h of list) {
          const s = h._source;
          if (!(s.sics || []).some((x) => SICS.has(String(x)))) continue;
          for (const c of s.ciks || []) {
            const k = Number(c);
            if (!hits.has(k)) hits.set(k, new Set());
            hits.get(k).add(s.file_date);
          }
        }
        if (list.length < 100) break;
      }
    }
  }
  const out = new Map();
  for (const [k, v] of hits) out.set(k, [...v].sort());
  return out;
}

/* --------------------- 3. point-in-time financials --------------------- */

const CASH = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"];
const ST_INV = ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "AvailableForSaleSecuritiesCurrent", "HeldToMaturitySecuritiesCurrent"];
const LT_INV = ["LongTermInvestments", "MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "AvailableForSaleSecuritiesNoncurrent", "HeldToMaturitySecuritiesNoncurrent"];
const OCF = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"];
const REV = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"];
const CUR_DEBT = ["LongTermDebtCurrent", "DebtCurrent", "ConvertibleNotesPayableCurrent", "ConvertibleDebtCurrent", "NotesPayableCurrent", "LoansPayableCurrent"];

// Only rows filed on or before `asOf`; for each period keep the latest of those.
function series(facts, tags, asOf, { instant, ns = "us-gaap", unit = "USD" } = {}) {
  let best = null;
  for (const tag of tags) {
    const raw = facts?.[ns]?.[tag]?.units?.[unit];
    if (!raw) continue;
    const byPeriod = new Map();
    for (const r of raw) {
      if (!r.filed || r.filed > asOf || (instant ? !!r.start : !r.start)) continue;
      const key = (r.start || "") + "|" + r.end;
      const prev = byPeriod.get(key);
      if (!prev || r.filed > prev.filed) byPeriod.set(key, r);
    }
    const rows = [...byPeriod.values()].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    if (rows.length && (!best || rows.at(-1).end > best.rows.at(-1).end)) best = { tag, rows };
  }
  return best;
}

function instantAt(facts, tags, end, asOf) {
  let val = 0;
  for (const tag of tags) {
    const s = series(facts, [tag], asOf, { instant: true });
    const hit = s?.rows.find((r) => r.end === end);
    if (hit && hit.val > val) val = hit.val;
  }
  return val;
}

// Trailing twelve months ending near `end` (10-Qs report year-to-date figures).
function ttm(s, end) {
  if (!s) return null;
  const rows = s.rows.filter((r) => near(r.end, end, 20));
  if (!rows.length) return null;
  const cur = rows.reduce((a, b) => (monthsBetween(a.start, a.end) >= monthsBetween(b.start, b.end) ? a : b));
  const dur = monthsBetween(cur.start, cur.end);
  if (dur > 11 && dur < 13) return cur.val;
  const annual = s.rows.find((r) => { const d = monthsBetween(r.start, r.end); return d > 11 && d < 13 && near(r.end, cur.start, 20); });
  const prior = s.rows.find((r) => near(r.start, shiftYears(cur.start, -1)) && near(r.end, shiftYears(cur.end, -1)));
  if (annual && prior) return annual.val + cur.val - prior.val;
  return dur >= 2.5 ? (cur.val * 12) / dur : null;
}

// Shares outstanding from cover pages and balance sheets, one figure per date, with when it was filed.
function shareRows(facts) {
  const raw = [...(facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares || [])];
  const byFiling = new Map();
  for (const r of raw) {
    const key = r.accn + "|" + r.end;
    const g = byFiling.get(key) || { end: r.end, filed: r.filed, vals: new Set() };
    g.vals.add(r.val);
    byFiling.set(key, g);
  }
  const byEnd = new Map();
  for (const g of byFiling.values()) {
    const total = [...g.vals].reduce((s, v) => s + v, 0);
    const prev = byEnd.get(g.end);
    if (!prev || g.filed < prev.filed) byEnd.set(g.end, { end: g.end, filed: g.filed, val: total });
  }
  return [...byEnd.values()].filter((r) => r.val > 0).sort((a, b) => (a.end < b.end ? -1 : 1));
}

function companyQuarters(facts, filings, atmDates) {
  // Balance-sheet dates from 10-Q / 10-K filings, dated by when they were first filed.
  const firstFiled = new Map();
  for (const tag of CASH) for (const r of facts?.["us-gaap"]?.[tag]?.units?.USD || []) {
    if (r.start || !r.filed || !/^10-[QK]/.test(r.form || "")) continue;
    if (!firstFiled.has(r.end) || r.filed < firstFiled.get(r.end)) firstFiled.set(r.end, r.filed);
  }
  const shelves = filings.filter((f) => f.form === "S-3" || f.form === "S-3ASR").map((f) => f.date);
  const floats = (facts?.dei?.EntityPublicFloat?.units?.USD || []).filter((r) => r.val > 0);
  const out = [];
  for (const [end, filed] of [...firstFiled.entries()].sort()) {
    if (filed < START || filed > LAST_ASOF || monthsBetween(end, filed) > 6) continue;
    const cashS = series(facts, CASH, filed, { instant: true });
    const cashRow = cashS?.rows.find((r) => r.end === end);
    if (!cashRow) continue;
    const cash = M(cashRow.val + instantAt(facts, ST_INV, end, filed) + instantAt(facts, LT_INV, end, filed));
    const ocfS = series(facts, OCF, filed);
    const ocf = ttm(ocfS, end);
    if (ocf == null) continue;
    const revS = series(facts, REV, filed);
    const rev = M(Math.max(0, ttm(revS, end) || 0));
    if (rev > MAX_REVENUE_M) continue;
    const ocfPrior = ttm(ocfS, shiftYears(end, -1));
    const burn = Math.max(0.1, -M(ocf) / 12);
    const fl = floats.filter((r) => r.filed <= filed && monthsBetween(r.end, filed) <= 18).sort((a, b) => (a.filed < b.filed ? -1 : 1)).at(-1);
    const shelf = shelves.filter((d) => d <= filed && d > shiftYears(filed, -3)).at(-1);
    const atm = (atmDates || []).filter((d) => d <= filed && d > shiftYears(filed, -2)).at(-1);
    const c = {
      cash, burn,
      burnPrior: ocfPrior != null && ocfPrior < 0 ? -M(ocfPrior) / 12 : null,
      cashFlowPositive: ocf > 0,
      debtDue24: M(instantAt(facts, CUR_DEBT, end, filed)),
      mcap: fl ? M(fl.val) : 0,
      raise: atm ? { capacity: "atm", atm: { form: "424B5", date: atm }, shelf: shelf ? { form: "S-3", date: shelf } : null }
        : shelf ? { capacity: "shelf", atm: null, shelf: { form: "S-3", date: shelf } } : { capacity: "none", atm: null, shelf: null },
      pipeline: [], catalysts: [],
    };
    if (c.cashFlowPositive) continue; // not burning cash: outside the question
    const f = computeFPS(c, toDate(filed));
    out.push({ end, filed, cash: Math.round(cash), runway: f.runway, score: f.score, band: f.band,
      parts: Object.fromEntries(f.parts.filter((p) => p.present).map((p) => [p.key, p.score])), coverage: f.coverage, _c: c });
  }
  return out;
}

/* ------------------- 3b. catalyst timing from guidance ------------------- */

// What the company said, in the 10-Q or 10-K behind this balance sheet, about when news is due.
let guidanceDocs = 0, guidanceFound = 0;
async function guidanceAt(cik, filings, filed) {
  const f = filings.find((x) => x.date === filed && /^10-[QK]/.test(x.form) && x.doc);
  if (!f) return [];
  // Cache the candidate sentences, not the dates, so the date rules can be tuned without re-reading filings.
  const key = `guids-${f.adsh}.json`;
  const file = new URL(key, CACHE);
  let sentences;
  if (existsSync(file)) sentences = JSON.parse(await readFile(file, "utf8"));
  else {
    const html = await sec(`https://www.sec.gov/Archives/edgar/data/${cik}/${f.adsh.replace(/-/g, "")}/${f.doc}`, { json: false });
    sentences = html && html.length < 25e6 ? candidateSentences(toText(html)) : [];
    await writeFile(file, JSON.stringify(sentences));
  }
  guidanceDocs++;
  const events = eventsFromSentences(sentences, filed).slice(0, 12);
  if (events.length) guidanceFound++;
  return events;
}

/* ------------------------------ 4. outcomes ------------------------------ */

function raiseEvents(filings, shares) {
  const ev = [];
  const seen = new Set();
  for (const f of filings) {
    if ((f.form === "424B4" || f.form === "424B5") && !seen.has(f.date)) { seen.add(f.date); ev.push({ date: f.date, how: "offering filing" }); }
  }
  for (let i = 1; i < shares.length; i++) {
    const a = shares[i - 1], b = shares[i];
    if (monthsBetween(a.end, b.end) > 7) continue; // gaps too long to date the raise
    if (b.val / a.val - 1 >= JUMP) ev.push({ date: b.end, how: "share count jump" });
  }
  return ev.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ----------------------------- 5. evaluation ----------------------------- */

function auc(rows, key, higherIsRiskier = true) {
  const pos = rows.filter((r) => r.y12).map((r) => r[key]);
  const neg = rows.filter((r) => !r.y12).map((r) => r[key]);
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  // Rank-sum (Mann-Whitney) with ties averaged.
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) rankSum += avg;
    i = j;
  }
  const a = (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
  return higherIsRiskier ? a : 1 - a;
}

const rate = (rows, k = "y12") => (rows.length ? rows.filter((r) => r[k]).length / rows.length : null);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function evaluate(rows, companies) {
  const bands = ["High", "Elevated", "Low"].map((b) => {
    const g = rows.filter((r) => r.band === b);
    return { band: b, n: g.length, raised12: r3(rate(g)), raised6: r3(rate(g, "y6")) };
  });
  const deciles = [];
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  for (let d = 0; d < 10; d++) {
    const g = sorted.slice(Math.floor((d * sorted.length) / 10), Math.floor(((d + 1) * sorted.length) / 10));
    if (g.length) deciles.push({ from: g[0].score, to: g.at(-1).score, n: g.length, raised12: r3(rate(g)) });
  }
  const years = [...new Set(rows.map((r) => r.filed.slice(0, 4)))].sort().map((y) => {
    const g = rows.filter((r) => r.filed.startsWith(y));
    const hi = g.filter((r) => r.band === "High"), lo = g.filter((r) => r.band === "Low");
    return { year: y, n: g.length, base: r3(rate(g)), high: r3(rate(hi)), low: r3(rate(lo)), auc: r3(auc(g, "score")) };
  });
  const runwayBuckets = [[0, 6], [6, 12], [12, 18], [18, 24], [24, 36], [36, 999]].map(([a, b]) => {
    const g = rows.filter((r) => r.runway >= a && r.runway < b);
    return { from: a, to: b === 999 ? null : b, n: g.length, raised12: r3(rate(g)) };
  });
  const lead = rows.filter((r) => r.band === "High" && r.y12).map((r) => r.lead);
  const alive = rows.filter((r) => companies.get(r.cik)?.alive);
  const dead = rows.filter((r) => !companies.get(r.cik)?.alive);
  const comp = {};
  for (const k of ["gap", "trend", "capacity", "debt", "access"]) {
    const g = rows.filter((r) => r.parts[k] != null).map((r) => ({ ...r, v: r.parts[k] }));
    comp[k] = { n: g.length, auc: r3(auc(g, "v")) };
  }
  return {
    rows: rows.length,
    companies: new Set(rows.map((r) => r.cik)).size,
    companiesNoLongerFiling: new Set(dead.map((r) => r.cik)).size,
    events12: rows.filter((r) => r.y12).length,
    base12: r3(rate(rows)), base6: r3(rate(rows, "y6")),
    auc: r3(auc(rows, "score")),
    aucRunwayOnly: r3(auc(rows.map((r) => ({ ...r, neg: -r.runway })), "neg")),
    components: comp,
    bands, deciles, years, runwayBuckets,
    leadMonthsHigh: median(lead),
    survivors: { rows: alive.length, auc: r3(auc(alive, "score")), base12: r3(rate(alive)) },
    nonSurvivors: { rows: dead.length, auc: r3(auc(dead, "score")), base12: r3(rate(dead)) },
  };
}

/* -------------------------------- main -------------------------------- */

/* ------------------------- share-price returns -------------------------
   What a simple strategy would have earned: each company's share return over
   the 6 and 12 months after a balance sheet was filed, against the XBI biotech
   ETF over the same days. Prices exist only for companies still listed under
   their current ticker (delisted companies drop out), so these figures lean
   towards survivors; the raise test above doesn't have that problem. */

async function dailyCloses(ticker) {
  const key = `px2-${ticker.replace(/[^A-Za-z0-9.-]/g, "_")}.json`;
  const file = new URL(key, CACHE);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  await new Promise((r) => setTimeout(r, 250));
  let out = [];
  try {
    // Ask for daily prices by date range: "range=max" quietly switches to monthly prices for long histories.
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=1104537600&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0 (Helixora backtest)" } });
    const res = r.ok ? (await r.json())?.chart?.result?.[0] : null;
    const adj = res?.indicators?.adjclose?.[0]?.adjclose || res?.indicators?.quote?.[0]?.close || [];
    out = (res?.timestamp || []).map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), adj[i]]).filter(([, v]) => v != null && v > 0);
  } catch { out = []; }
  await writeFile(file, JSON.stringify(out));
  return out;
}

// Close on the first trading day on or after a date (within 10 days), by binary search.
function closeOn(px, date) {
  let lo = 0, hi = px.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (px[m][0] >= date) { ans = m; hi = m - 1; } else lo = m + 1; }
  if (ans < 0 || monthsBetween(date, px[ans][0]) > 0.35) return null;
  return px[ans][1];
}

function excess(px, bench, from, months) {
  const to = addDays(from, Math.round(months * 30.44));
  if (to > TODAY_ISO) return null;
  const a = closeOn(px, from), b = closeOn(px, to), x = closeOn(bench, from), y = closeOn(bench, to);
  if (!a || !b || !x || !y) return null;
  const ret = b / a - 1;
  // A tenfold move in a few months is almost always a price-data error around a reverse split; skip it.
  if (ret > 9 || ret < -0.995) return null;
  return { ret, excess: (b / a) - (y / x) };
}

const r1 = (v) => Math.round(v * 1000) / 10;
// Median first: small-biotech returns are dominated by a few huge winners and price-data glitches.
// The mean is "trimmed": each value is capped at the 5th and 95th percentiles of the whole sample.
let CAP = [-Infinity, Infinity];
function retStats(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < 20) return null;
  const t = v.map((x) => Math.min(CAP[1], Math.max(CAP[0], x)));
  return { n: v.length, mean: r1(t.reduce((a, b) => a + b, 0) / t.length), median: r1(v[Math.floor(v.length / 2)]), shareBehind: Math.round((v.filter((x) => x < 0).length / v.length) * 100) };
}

async function addReturns(rows, companies) {
  const bench = await dailyCloses("XBI");
  const tick = [...companies.values()].filter((c) => c.ticker);
  let n = 0;
  const px = new Map();
  for (const c of tick) {
    if (++n % 100 === 0) console.log(`  prices ${n}/${tick.length}`);
    px.set(c.cik, await dailyCloses(c.ticker));
  }
  for (const r of rows) {
    const p = px.get(r.cik);
    if (!p?.length) continue;
    const e6 = excess(p, bench, r.filed, 6), e12 = excess(p, bench, r.filed, 12);
    if (e6) r.x6 = e6.excess;
    if (e12) { r.x12 = e12.excess; r.ret12 = e12.ret; }
  }
  const priced = rows.filter((r) => r.x12 != null);
  const all12 = priced.map((r) => r.x12).sort((a, b) => a - b);
  CAP = [all12[Math.floor(all12.length * 0.05)], all12[Math.floor(all12.length * 0.95)]];
  const bands = ["High", "Elevated", "Moderate", "Low"].map((b) => ({ band: b, m12: retStats(priced.filter((r) => r.band === b), "x12"), m6: retStats(rows.filter((r) => r.x6 != null && r.band === b), "x6") }));
  // Deciles of the score, riskiest last.
  const sorted = [...priced].sort((a, b) => a.score - b.score);
  const deciles = Array.from({ length: 10 }, (_, i) => {
    const part = sorted.slice(Math.floor((i * sorted.length) / 10), Math.floor(((i + 1) * sorted.length) / 10));
    return { decile: i + 1, n: part.length, mean12: retStats(part, "x12")?.mean ?? null, median12: retStats(part, "x12")?.median ?? null };
  });
  // A simple yearly strategy: hold the Low band and avoid (or short) the High band, equal-weighted, from each filing for 12 months.
  const years = [...new Set(priced.map((r) => r.filed.slice(0, 4)))].sort().map((y) => {
    const yr = priced.filter((r) => r.filed.startsWith(y));
    const lo = retStats(yr.filter((r) => r.band === "Low"), "x12"), hi = retStats(yr.filter((r) => r.band === "High"), "x12");
    return { year: y, low: lo?.median ?? null, high: hi?.median ?? null, spread: lo && hi ? Math.round((lo.median - hi.median) * 10) / 10 : null, nLow: lo?.n || 0, nHigh: hi?.n || 0 };
  }).filter((y) => y.spread != null);
  const hiS = bands[0].m12, loS = bands[3].m12;
  return {
    benchmark: "XBI (SPDR S&P Biotech ETF)",
    priced: priced.length, pricedCompanies: new Set(priced.map((r) => r.cik)).size, rows: rows.length,
    bands, deciles, years,
    spread12: hiS && loS ? Math.round((loS.median - hiS.median) * 10) / 10 : null,
    spread12Mean: hiS && loS ? Math.round((loS.mean - hiS.mean) * 10) / 10 : null,
    trim: [r1(CAP[0]), r1(CAP[1])],
    yearsLowBeatHigh: years.filter((y) => y.spread > 0).length, yearsCounted: years.length,
    raisedVsNot: { raised6: retStats(rows.filter((r) => r.x6 != null && r.y6), "x6"), notRaised6: retStats(rows.filter((r) => r.x6 != null && !r.y6), "x6") },
    method: "Medians, and means with each return capped at the 5th and 95th percentiles of all returns. Moves of more than tenfold, or a near-total loss within the window, are treated as price-data errors and left out.",
    caveat: "Prices are only available for companies still listed under their current ticker, so companies that were delisted, went bankrupt or were bought are missing. Those were often the worst (and sometimes best) outcomes, so treat these returns as indicative. Returns are before trading costs, and short-selling small biotechs is costly and sometimes impossible.",
  };
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  console.log("Finding every company that reported R&D spending since 2010…");
  const cands = await candidates();
  console.log(`  ${cands.size} companies`);

  console.log("Keeping drug and biotech companies…");
  const companies = new Map();
  let i = 0;
  for (const [cik, name] of cands) {
    if (++i % 500 === 0) console.log(`  ${i}/${cands.size}`);
    const f = await filingsFor(cik);
    if (!f || !SICS.has(String(f.sub.sic))) continue;
    for (const file of f.sub.filings.files || []) {
      if (file.filingTo < "2009-01-01") continue;
      const older = await sec(`https://data.sec.gov/submissions/${file.name}`, { cacheKey: `subx-${file.name}` });
      if (older) f.add(older);
    }
    const last = f.rows.reduce((m, r) => (r.date > m ? r.date : m), "");
    companies.set(cik, { cik, name: f.sub.name || name, sic: String(f.sub.sic), filings: f.rows, last, alive: last >= addDays(TODAY_ISO, -400) && (f.sub.tickers || []).length > 0, ticker: (f.sub.tickers || [])[0] || null });
  }
  console.log(`  ${companies.size} drug and biotech companies`);

  console.log("Finding at-the-market sales agreements…");
  const atm = await atmFilings();
  console.log(`  ${atm.size} companies with an ATM prospectus`);

  console.log("Scoring every company-quarter…");
  const rows = [];
  const examples = [];
  i = 0;
  for (const co of companies.values()) {
    if (++i % 200 === 0) console.log(`  ${i}/${companies.size}, ${rows.length} rows, ${calls} requests`);
    const facts = (await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(co.cik)}.json`, {}))?.facts;
    if (!facts) continue;
    const qs = companyQuarters(facts, co.filings, atm.get(co.cik));
    if (!qs.length) continue;
    const events = raiseEvents(co.filings, shareRows(facts));
    for (const q of qs) {
      // Score again with the company's own guided catalyst dates (point-in-time: from the filing itself).
      const guided = await guidanceAt(co.cik, co.filings, q.filed);
      const c = { ...q._c, catalysts: guided.map((e) => ({ date: e.date, kind: e.kind, label: "Company-guided event" })) };
      delete q._c;
      const g = computeFPS(c, toDate(q.filed));
      q.scoreNoCat = q.score; q.bandNoCat = q.band; q.partsNoCat = q.parts;
      q.score = g.score; q.band = g.band; q.runway = g.runway;
      q.parts = Object.fromEntries(g.parts.filter((p) => p.present).map((p) => [p.key, p.score]));
      q.guided = guided.length > 0; q.monthsToEvent = g.catalyst ? g.monthsToCatalyst : null;
      const next = events.find((e) => e.date > q.filed);
      const y12 = !!next && next.date <= addDays(q.filed, 365);
      const y6 = !!next && next.date <= addDays(q.filed, 182);
      const off = events.find((e) => e.date > q.filed && e.how === "offering filing");
      const yOff12 = !!off && off.date <= addDays(q.filed, 365);
      const yOff6 = !!off && off.date <= addDays(q.filed, 182);
      // Stopped filing within the year (bankruptcy, wind-down or sale): the need for money was resolved without a raise.
      const ended = !co.alive && co.last <= addDays(q.filed, 365);
      rows.push({ cik: co.cik, ...q, y12, y6, yOff12, yOff6, yEnd12: y12 || ended, yEnd6: y6 || (!co.alive && co.last <= addDays(q.filed, 182)), how: y12 ? next.how : null, lead: y12 ? Math.round(monthsBetween(q.filed, next.date) * 10) / 10 : null });
      if (EXAMPLES.has(co.cik) && q.filed >= "2016-01-01") examples.push({ name: co.name, filed: q.filed, cash: q.cash, runway: q.runway, score: q.score, band: q.band, scoreWithoutGuidance: q.scoreNoCat, monthsToEvent: q.monthsToEvent, guidance: guided[0]?.text || null, raisedWithinYear: y12, how: y12 ? next.how : null, nextRaise: next?.date || null });
    }
  }
  console.log(`  ${rows.length} company-quarters`);

  console.log("Share-price returns after each filing…");
  const returns = await addReturns(rows, companies);
  console.log(`  ${returns.priced} company-quarters priced, from ${returns.pricedCompanies} companies; Low minus High 12-month: ${returns.spread12} points`);

  const result = evaluate(rows, companies);
  result.returns = returns;
  // Robustness: count only formal offering filings as a raise, ignoring share-count jumps.
  const off = evaluate(rows.map((r) => ({ ...r, y12: r.yOff12, y6: r.yOff6 })), companies);
  result.offeringsOnly = { base12: off.base12, auc: off.auc, bands: off.bands };
  const end = evaluate(rows.map((r) => ({ ...r, y12: r.yEnd12, y6: r.yEnd6 })), companies);
  result.raisedOrEnded = { base12: end.base12, auc: end.auc, bands: end.bands, survivorsAuc: end.survivors.auc, nonSurvivorsAuc: end.nonSurvivors.auc };
  result.eventsByHow = { "offering filing": rows.filter((r) => r.how === "offering filing").length, "share count jump": rows.filter((r) => r.how === "share count jump").length };
  result.examples = examples;
  // Catalyst timing: how much the company-guided dates add.
  const nc = evaluate(rows.map((r) => ({ ...r, score: r.scoreNoCat, band: r.bandNoCat, parts: r.partsNoCat })), companies);
  const gRows = rows.filter((r) => r.guided);
  result.catalystTiming = {
    filingsRead: guidanceDocs, filingsWithGuidance: guidanceFound,
    rowsWithGuidance: gRows.length, shareWithGuidance: Math.round((gRows.length / rows.length) * 1000) / 1000,
    withoutGuidance: { auc: nc.auc, bands: nc.bands },
    guidedRowsOnly: { rows: gRows.length, auc: auc(gRows, "score"), aucWithoutGuidance: auc(gRows.map((r) => ({ ...r, score: r.scoreNoCat })), "score"), base12: rate(gRows) },
  };
  const out = {
    generatedAt: new Date().toISOString(),
    fpsVersion: FPS_VERSION,
    question: "Did the Financing Pressure Score flag biotechs before they sold stock?",
    universe: `Every company with industry code 2834, 2836 or 8731 that reported R&D spending to the SEC, burned cash, and had under $${MAX_REVENUE_M}M of trailing revenue, at each balance sheet filed ${START.slice(0, 4)}–${LAST_ASOF.slice(0, 4)}. Includes companies that later stopped filing.`,
    outcome: `A stock offering filing (424B4 or 424B5) or a jump of ${JUMP * 100}%+ in shares outstanding within 12 months after the balance sheet was filed.`,
    pointInTime: "Each row uses only figures filed with the SEC on or before its date, including the catalyst dates the company gave in that filing.",
    limits: [
      "Catalyst timing comes from what each company said in the 10-Q or 10-K behind that balance sheet (for example, \"topline data in the second half of 2019\"), read automatically. Where no dated guidance was found, the score's standard assumption of an event 18 months out is used. The reader can misread a sentence, and companies' own timelines often slip.",
      "Pipeline concentration isn't included; the score is re-weighted over the parts that are.",
      "Market access uses the public float reported in each 10-K instead of daily market value, because price history isn't freely available for delisted companies.",
      "An ATM program is detected from sales-agreement language in prospectus supplements found by SEC full-text search; a few may be missed or misread.",
      "A share-count jump can also come from a merger or debt conversion, not only a stock sale.",
    ],
    requests: calls,
    ...result,
  };
  await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ ...out, deciles: undefined, years: undefined }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
