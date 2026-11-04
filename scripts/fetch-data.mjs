#!/usr/bin/env node
/* ------------------------------------------------------------------
   HELIXORA data refresh

   Builds public/data/companies.json from public sources:
     - SEC EDGAR          cash, investments, debt, revenue, operating cash
                          flow, shares outstanding, offering filings
     - ClinicalTrials.gov phase, enrollment, indication, endpoint and
                          primary completion date for each program
     - Stock price        Alpha Vantage (if ALPHA_VANTAGE_KEY is set),
                          otherwise Yahoo Finance's public chart endpoint

   Anything no API can supply (peak sales, mechanism, partners, thesis
   notes) comes from config/assumptions.json, so it stays your judgment.

   Usage:
     SEC_USER_AGENT="Your Name you@example.com" node scripts/fetch-data.mjs

   The SEC asks every automated client to identify itself with a name and
   contact email in the User-Agent header. Requests without one get blocked.
------------------------------------------------------------------- */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { computeFPS, FPS_VERSION } from "../src/fps.js";
import { runwaySim, QUANT_VERSION } from "../src/quant.js";
import { readoutWindow, designFlags, successOdds, OFFICE_GROUPS, TRIALS_VERSION, kaplanMeier, stratumKey, durationCheck } from "../src/trials.js";

const ROOT = new URL("../", import.meta.url);
const OUT_DIR = new URL("public/data/", ROOT);
const OUT_FILE = new URL("companies.json", OUT_DIR);
const HISTORY_FILE = new URL("fps-history.json", OUT_DIR);
const BENCHMARK = { symbol: "XBI", name: "SPDR S&P Biotech ETF" };
const TRIAL_HISTORY_FILE = new URL("trial-history.json", OUT_DIR);
const PREDICTIONS_FILE = new URL("predictions.json", OUT_DIR);

const UA = process.env.SEC_USER_AGENT;
const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);
const DAY = 86400000;

// Defaults used when config/assumptions.json does not say otherwise.
// They are placeholders, and the app labels them as such.
const DEFAULTS = {
  peakByPhase: { "Phase I": 500, "Phase II": 600, "Phase III": 800, "Filed": 900, "Approved": 900 },
  launchByPhase: { "Phase I": 7, "Phase II": 4.5, "Phase III": 2.5, "Filed": 0.8, "Approved": 0 },
  costByPhase: { "Phase I": 90, "Phase II": 160, "Phase III": 260, "Filed": 30, "Approved": 0 },
  diff: 0.6, mkt: 0.6, patentYrs: 10,
};

const ACTIVE = new Set(["RECRUITING", "ACTIVE_NOT_RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]);
const PHASE_MAP = { EARLY_PHASE1: "Phase I", PHASE1: "Phase I", PHASE2: "Phase II", PHASE3: "Phase III", PHASE4: "Approved" };
const PHASE_ORDER = ["Phase I", "Phase II", "Phase III", "Filed", "Approved"];
const NOT_AN_ASSET = /placebo|vehicle|sham|saline|standard of care|standard-of-care|best supportive|usual care|no intervention|investigator'?s choice|physician'?s choice/i;
const EXTENSION = /\bextension\b|long[- ]term (safety|follow)|roll-?over|\bOLE\b|continuation study/i;
const ASSET_TYPES = new Set(["DRUG", "BIOLOGICAL", "GENETIC", "COMBINATION_PRODUCT"]);
// Marketed drugs that biotechs commonly combine their own asset with. They are never the
// sponsor's program, so they rank last and a trial using only these is ignored.
const COMMON_PARTNERS = new RegExp("^(" + [
  "tacrolimus", "mycophenolate", "mycophenolate mofetil", "prednisone", "prednisolone", "methylprednisolone", "dexamethasone", "basiliximab", "thymoglobulin", "everolimus", "cyclosporine", "metformin", "semaglutide", "insulin",
  "pembrolizumab", "nivolumab", "atezolizumab", "durvalumab", "ipilimumab", "cemiplimab", "tislelizumab",
  "crizotinib", "osimertinib", "trastuzumab", "pertuzumab", "bevacizumab", "cetuximab", "panitumumab", "rituximab",
  "docetaxel", "paclitaxel", "nab-paclitaxel", "carboplatin", "cisplatin", "oxaliplatin", "gemcitabine", "pemetrexed",
  "capecitabine", "fluorouracil", "5-fu", "irinotecan", "folfox", "folfiri", "etoposide", "cyclophosphamide",
  "fulvestrant", "letrozole", "anastrozole", "palbociclib", "ribociclib", "abemaciclib", "enzalutamide", "abiraterone",
  "lenalidomide", "pomalidomide", "dexamethasone", "prednisone", "bortezomib", "daratumumab", "azacitidine", "venetoclax",
  "semaglutide", "tirzepatide", "liraglutide", "metformin", "insulin", "chemotherapy", "standard chemotherapy",
].join("|") + ")$", "i");

/* ------------------------------ helpers ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toDate = (s) => new Date(s + "T00:00:00Z");
const monthsBetween = (a, b) => (toDate(b) - toDate(a)) / DAY / 30.44;
const near = (a, b, tolDays = 20) => Math.abs(toDate(a) - toDate(b)) <= tolDays * DAY;
const shiftYears = (iso, y) => { const d = toDate(iso); d.setUTCFullYear(d.getUTCFullYear() + y); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => new Date(toDate(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const round = (n, d = 1) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const M = (usd) => (usd == null ? null : usd / 1e6);
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn("  ! " + msg); };

async function getJSON(url, headers = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

// SEC fair-access policy: identify yourself, stay under 10 requests per second.
async function sec(url) {
  await sleep(200);
  return getJSON(url, { "User-Agent": UA, "Accept": "application/json" });
}

async function secText(url) {
  await sleep(200);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,text/plain" } });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/* ------------------------------- EDGAR ------------------------------- */

// The same period is often re-reported in later filings. Keep the most recent filing's value.
function dedupe(rows) {
  const byPeriod = new Map();
  for (const r of rows) {
    const key = (r.start || "") + "|" + r.end;
    const prev = byPeriod.get(key);
    if (!prev || r.filed > prev.filed) byPeriod.set(key, r);
  }
  return [...byPeriod.values()].sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
}

// Companies switch XBRL tags over the years. Among candidate tags, use the one with the newest data.
function pickSeries(facts, tags, { unit = "USD", ns = "us-gaap", instant } = {}) {
  let best = null;
  for (const tag of tags) {
    const raw = facts?.[ns]?.[tag]?.units?.[unit];
    if (!raw?.length) continue;
    const rows = dedupe(raw).filter((r) => (instant ? !r.start : !!r.start));
    if (!rows.length) continue;
    if (!best || rows.at(-1).end > best.rows.at(-1).end) best = { tag, rows };
  }
  return best;
}

function valueAt(facts, tags, date) {
  let best = null;
  for (const tag of tags) {
    const raw = facts?.["us-gaap"]?.[tag]?.units?.USD;
    if (!raw) continue;
    const hit = dedupe(raw).find((r) => !r.start && r.end === date);
    if (hit && (!best || hit.val > best.val)) best = { tag, val: hit.val };
  }
  return best;
}

// Trailing twelve months for a flow item (cash flow, revenue).
// 10-Qs report year-to-date figures, so TTM = last fiscal year + current YTD − prior-year YTD.
function trailing12(s, targetEnd = null) {
  if (!s) return null;
  const rows = s.rows;
  let latestEnd = rows.at(-1).end;
  if (targetEnd) {
    const hit = [...rows].reverse().find((r) => near(r.end, targetEnd, 20));
    if (!hit) return null;
    latestEnd = hit.end;
  }
  const cur = rows.filter((r) => r.end === latestEnd)
    .reduce((a, b) => (monthsBetween(a.start, a.end) >= monthsBetween(b.start, b.end) ? a : b));
  const dur = monthsBetween(cur.start, cur.end);
  if (dur > 11 && dur < 13) return { val: cur.val, end: cur.end, how: "fiscal year as reported", tag: s.tag };
  const annual = rows.find((r) => { const d = monthsBetween(r.start, r.end); return d > 11 && d < 13 && near(r.end, cur.start, 20); });
  const prior = rows.find((r) => near(r.start, shiftYears(cur.start, -1)) && near(r.end, shiftYears(cur.end, -1)));
  if (annual && prior) {
    return { val: annual.val + cur.val - prior.val, end: cur.end, how: "last fiscal year + current year-to-date − prior year-to-date", tag: s.tag };
  }
  return { val: (cur.val * 12) / dur, end: cur.end, how: `${Math.round(dur)}-month year-to-date figure annualized`, tag: s.tag };
}

function shareHistory(facts) {
  const raw = facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares
    || facts?.["us-gaap"]?.CommonStockSharesOutstanding?.units?.shares;
  if (!raw?.length) return [];
  // A filing with several share classes reports one row per class; add them up per filing.
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
    if (!prev || g.filed > prev.filed) byEnd.set(g.end, { end: g.end, filed: g.filed, val: total });
  }
  return [...byEnd.values()].sort((a, b) => (a.end < b.end ? -1 : 1));
}

function financialsFromFacts(facts) {
  const CASH = ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"];
  const ST_INV = ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "HeldToMaturitySecuritiesCurrent"];
  const LT_INV = ["LongTermInvestments", "MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "HeldToMaturitySecuritiesNoncurrent"];
  const DEBT = ["LongTermDebt", "ConvertibleNotesPayable", "LongTermDebtNoncurrent", "ConvertibleDebtNoncurrent", "LongTermNotesPayable", "SeniorNotes", "LongTermLoansPayable"];

  const cashS = pickSeries(facts, CASH, { instant: true });
  if (!cashS) return null;
  const asOf = cashS.rows.at(-1).end;
  const cashOnly = cashS.rows.at(-1).val;
  const st = valueAt(facts, ST_INV, asOf);
  const lt = valueAt(facts, LT_INV, asOf);
  const debt = valueAt(facts, DEBT, asOf);

  const ocfS = pickSeries(facts, ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]);
  const ocf = trailing12(ocfS);
  const ocfPrior = ocf ? trailing12(ocfS, shiftYears(ocf.end, -1)) : null;

  // Debt coming due within 24 months: the larger of debt classed as current on the latest balance
  // sheet and the scheduled principal repayments for the next two years (reported in the 10-K).
  const CUR_DEBT = ["LongTermDebtCurrent", "DebtCurrent", "ConvertibleNotesPayableCurrent", "ConvertibleDebtCurrent", "NotesPayableCurrent", "LoansPayableCurrent"];
  const curDebt = valueAt(facts, CUR_DEBT, asOf)?.val || 0;
  const y1 = pickSeries(facts, ["LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths"], { instant: true });
  const y2 = pickSeries(facts, ["LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo"], { instant: true });
  let sched = 0;
  if (y1 && monthsBetween(y1.rows.at(-1).end, asOf) < 15) {
    sched = y1.rows.at(-1).val + (y2 && y2.rows.at(-1).end === y1.rows.at(-1).end ? y2.rows.at(-1).val : 0);
  }
  const revS = pickSeries(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax"]);
  let rev = trailing12(revS);
  if (rev && monthsBetween(rev.end, asOf) > 15) rev = null; // stale tag, company no longer reports it

  const shares = shareHistory(facts);
  const sharesNow = shares.at(-1);
  let dil24 = null;
  if (sharesNow) {
    const target = shiftYears(sharesNow.end, -2);
    const old = [...shares].reverse().find((r) => r.end <= addDays(target, 60));
    if (old && old.val > 0) dil24 = ((sharesNow.val / old.val) - 1) * 100;
  }

  const cash = cashOnly + (st?.val || 0) + (lt?.val || 0);
  const ocfM = ocf ? M(ocf.val) : null;

  // Runway as it stood at each past balance sheet, dated by when that figure was FIRST filed,
  // so the Research page only uses what investors could actually have known at the time.
  const firstFiled = new Map();
  for (const tag of CASH) for (const r of facts?.["us-gaap"]?.[tag]?.units?.USD || []) {
    if (r.start || !r.filed) continue;
    if (!firstFiled.has(r.end) || r.filed < firstFiled.get(r.end)) firstFiled.set(r.end, r.filed);
  }
  const runwayHist = [];
  for (const r of cashS.rows.slice(-20)) {
    const t = trailing12(ocfS, r.end);
    if (!t || !near(t.end, r.end, 20)) continue;
    const total = r.val + (valueAt(facts, ST_INV, r.end)?.val || 0) + (valueAt(facts, LT_INV, r.end)?.val || 0);
    const burnM = -M(t.val) / 12;
    runwayHist.push({ end: r.end, filed: firstFiled.get(r.end) || r.filed, cash: Math.round(M(total)), burn: Math.round(burnM * 10) / 10,
      runway: burnM > 0 ? Math.round((M(total) / burnM) * 10) / 10 : null });
  }
  return {
    asOf,
    cash: M(cash),
    cashParts: [cashS.tag, st?.tag, lt?.tag].filter(Boolean),
    debt: M(debt?.val || 0),
    burn: ocfM == null ? null : Math.max(0.1, -ocfM / 12),
    cashFlowPositive: ocfM != null && ocfM > 0,
    burnHow: ocf?.how || null,
    burnPrior: ocfPrior ? -M(ocfPrior.val) / 12 : null,
    debtDue24: M(Math.max(curDebt, sched)),
    rev: rev ? Math.max(0, M(rev.val)) : 0,
    shares: sharesNow ? sharesNow.val / 1e6 : null,
    sharesAsOf: sharesNow?.end || null,
    dil24,
    runwayHist,
    revQ: quarterlyRevenue(revS),
  };
}

// Quarterly revenue: reported 3-month periods, plus Q4 worked out as the fiscal year less nine months year-to-date.
function quarterlyRevenue(s) {
  if (!s) return [];
  const q = new Map();
  for (const r of s.rows) { const d = monthsBetween(r.start, r.end); if (d > 2.5 && d < 3.5) q.set(r.end, r.val); }
  for (const r of s.rows) {
    const d = monthsBetween(r.start, r.end);
    if (d > 11 && d < 13 && !q.has(r.end)) {
      const ytd9 = s.rows.find((x) => x.start === r.start && monthsBetween(x.start, x.end) > 8.5 && monthsBetween(x.start, x.end) < 9.5);
      if (ytd9) q.set(r.end, r.val - ytd9.val);
    }
  }
  return [...q.entries()].sort().slice(-12).map(([end, v]) => [end, Math.round(M(v) * 10) / 10]);
}

// Plain-English labels for SEC forms and 8-K items, used for the filings news feed.
const FORM_LABEL = {
  "10-Q": "Quarterly report", "10-K": "Annual report", "8-K": "Current report",
  "424B4": "Priced stock offering", "424B5": "Stock offering prospectus", "S-3": "Shelf registration",
  "S-3ASR": "Shelf registration", "S-1": "Registration statement", "DEF 14A": "Proxy statement",
  "SC 13D": "Activist stake disclosed", "SCHEDULE 13D": "Activist stake disclosed",
};
const ITEM_LABEL = {
  "1.01": "signs a material agreement", "1.02": "ends a material agreement", "2.01": "completes an acquisition or sale",
  "2.02": "reports quarterly results", "2.03": "takes on new debt", "2.05": "announces restructuring costs",
  "3.02": "sells unregistered shares", "5.02": "announces a leadership change", "5.03": "amends its bylaws",
  "5.07": "reports shareholder vote results", "7.01": "issues an investor update", "8.01": "makes a company announcement",
};
const FEED_FORMS = new Set(Object.keys(FORM_LABEL));

function filingHeadline(name, form, items) {
  if (form === "8-K") {
    const codes = (items || "").split(",").map((x) => x.trim()).filter((x) => ITEM_LABEL[x]);
    const order = ["2.02", "1.01", "2.01", "5.02", "1.02", "2.03", "3.02", "2.05", "8.01", "7.01", "5.07", "5.03"];
    codes.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return `${name} ${codes.length ? ITEM_LABEL[codes[0]] : "files a current report"}`;
  }
  const verb = { "10-Q": "files its quarterly report", "10-K": "files its annual report", "424B4": "prices a stock offering",
    "424B5": "files a stock offering prospectus", "S-3": "registers shares for future sale", "S-3ASR": "registers shares for future sale",
    "S-1": "files a registration statement", "DEF 14A": "files its proxy statement" }[form];
  return verb ? `${name} ${verb}` : `${name}: ${FORM_LABEL[form]}`;
}

function newsFromSubmissions(sub, cik, name) {
  const r = sub?.filings?.recent;
  if (!r) return [];
  const out = [];
  for (let i = 0; i < r.form.length && out.length < 10; i++) {
    const form = r.form[i];
    if (!FEED_FORMS.has(form)) continue;
    out.push({
      date: r.filingDate[i],
      time: r.acceptanceDateTime?.[i] || null,
      form,
      formLabel: FORM_LABEL[form],
      headline: filingHeadline(name, form, r.items?.[i]),
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`,
    });
  }
  return out;
}

function filingsFromSubmissions(sub, cik) {
  const r = sub?.filings?.recent;
  if (!r) return { financings: [], lastPeriodic: null };
  const docUrl = (i) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`;
  const cutoff = shiftYears(TODAY_ISO, -3);
  const financings = [];
  const seen = new Set();
  let lastPeriodic = null;
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i], date = r.filingDate[i];
    if (!lastPeriodic && (form === "10-Q" || form === "10-K")) lastPeriodic = { form, date, url: docUrl(i) };
    if (date < cutoff) continue;
    if (form === "424B4" || form === "424B5") {
      if (seen.has(date)) continue;
      seen.add(date);
      financings.push({
        date,
        type: form === "424B4" ? "Priced offering (424B4)" : "Shelf takedown or ATM (424B5)",
        amt: null, dil: null, url: docUrl(i),
      });
    }
  }
  // Raise-ready capacity: the latest shelf registration (S-3, valid for three years) and recent
  // prospectus supplements, which are where at-the-market (ATM) programs are disclosed.
  let shelf = null;
  const supplements = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i], date = r.filingDate[i];
    if (date < cutoff) break;
    if (!shelf && (form === "S-3" || form === "S-3ASR")) shelf = { form, date, url: docUrl(i) };
    if (form === "424B5" && date >= shiftYears(TODAY_ISO, -2) && supplements.length < 3) supplements.push({ form, date, url: docUrl(i) });
  }
  return { financings: financings.slice(0, 8), lastPeriodic, shelf, supplements };
}

// ATM programs are set up under a sales agreement with a broker; the prospectus names it as a
// capitalized defined term. A base shelf prospectus only mentions "at the market" in passing.
const ATM_TERMS = /\b(Open Market Sale Agreement|Equity Distribution Agreement|Controlled Equity Offering|At[- ]the[- ]Market (?:Offering |Sales |Issuance )?(?:Sales )?Agreement|ATM (?:Sales )?Agreement|(?:Equity |Common Stock )?Sales Agreement)\b/;

async function raiseCapacity({ shelf, supplements }) {
  for (const doc of [...supplements, ...(shelf ? [shelf] : [])]) {
    const text = await secText(doc.url);
    const m = text && text.match(ATM_TERMS);
    if (m) return { capacity: "atm", atm: { ...doc, phrase: m[1] }, shelf };
  }
  return { capacity: shelf ? "shelf" : "none", atm: null, shelf };
}

/* ---------------------------- stock price ---------------------------- */

// Yahoo's chart endpoint gives the latest price plus a year of daily closes for the quote chart.
async function yahooQuote(ticker) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`,
    { "User-Agent": "Mozilla/5.0 (Helixora data refresh)" });
  const res = j?.chart?.result?.[0];
  const m = res?.meta;
  if (!(m?.regularMarketPrice > 0)) return null;
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const history = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    history.push([new Date(ts[i] * 1000).toISOString().slice(0, 10), Math.round(closes[i] * 100) / 100]);
  }
  const date = new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10);
  // Previous close: the last full session before the latest price.
  const prior = history.filter(([d]) => d < date);
  const prev = prior.length ? prior.at(-1)[1] : (m.chartPreviousClose || null);
  const closesOnly = history.map(([, c]) => c);
  return {
    price: m.regularMarketPrice, date, source: "Yahoo Finance", prev, history,
    hi52: m.fiftyTwoWeekHigh || (closesOnly.length ? Math.max(...closesOnly) : null),
    lo52: m.fiftyTwoWeekLow || (closesOnly.length ? Math.min(...closesOnly) : null),
    volume: m.regularMarketVolume || null,
  };
}

async function priceFor(ticker) {
  let y = null;
  try { y = await yahooQuote(ticker); } catch (e) { warn(`Yahoo price failed for ${ticker}: ${e.message}`); }
  if (y) return y;
  if (AV_KEY) {
    try {
      await sleep(1300); // free tier allows roughly one request per second
      const j = await getJSON(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`);
      const q = j?.["Global Quote"];
      const p = parseFloat(q?.["05. price"]);
      if (p > 0) {
        const prev = parseFloat(q["08. previous close"]);
        return { price: p, date: q["07. latest trading day"], source: "Alpha Vantage", prev: prev > 0 ? prev : null, history: [], hi52: null, lo52: null, volume: parseInt(q["06. volume"]) || null };
      }
      if (j?.Note || j?.Information) warn(`Alpha Vantage limit reached for ${ticker}: ${(j.Note || j.Information).slice(0, 90)}`);
    } catch (e) { warn(`Alpha Vantage failed for ${ticker}: ${e.message}`); }
  }
  return null;
}

/* ------------------------- ClinicalTrials.gov ------------------------- */

const normName = (s) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|co|company|holdings|sa|ag|nv)\b/g, "").replace(/\s+/g, " ").trim();

async function trialsFor(sponsor) {
  const out = [];
  let token = null;
  do {
    const u = new URL("https://clinicaltrials.gov/api/v2/studies");
    u.searchParams.set("query.spons", sponsor);
    u.searchParams.set("pageSize", "100");
    if (token) u.searchParams.set("pageToken", token);
    const j = await getJSON(u.toString(), { "Accept": "application/json" });
    for (const s of j?.studies || []) out.push(s.protocolSection);
    token = j?.nextPageToken || null;
    await sleep(250);
  } while (token && out.length < 600);
  const want = normName(sponsor);
  return out.filter((p) => {
    const lead = normName(p?.sponsorCollaboratorsModule?.leadSponsor?.name || "");
    return p?.designModule?.studyType === "INTERVENTIONAL" && lead && (lead.includes(want) || want.includes(lead));
  });
}

const cleanDrug = (name) => {
  const s = name
    .replace(/^\s*(drug|biological|genetic|combination product|device|other)\s*:\s*/i, "")
    .replace(/^\s*(sub-?retinal|intravitreal|intrathecal|intravenous|subcutaneous|oral)?\s*administration of\s+/i, "")
    .replace(/^\s*(low|high|mid|medium|middle)[- ]dose\s+/i, "")
    .replace(/\s+(dose|cohort|arm|part|level)\s*[0-9a-z]?\s*$/i, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/^\s*(sc|iv|po|oral|subcutaneous|intravenous|inhaled|topical)\s+/i, "")
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|µg|ug|g|ml|mg\/kg|iu|units?)\b.*$/i, "")
    .replace(/\s+(oral|subcutaneous|intravenous|iv|sc|injection|tablets?|capsules?|for injection|low dose|high dose)\b.*$/i, "")
    .replace(/\s+/g, " ").trim();
  // Development codes like "VK2735 QW" or "ARO-APOC3 cohort 2": the code alone names the program.
  const first = s.split(" ")[0].replace(/[-–]+$/, "");
  if (/[a-z]/i.test(first) && /\d/.test(first) && first.length >= 4) return first.replace(/-\d{3}$/, (m) => (/^[A-Z]+\d{3}-\d{3}$/.test(first) ? "" : m));
  // A sentence instead of a name ("Phase 1 Part A - dose escalation TYRA-200 ..."): use the development code in it.
  if (s.length > 40) { const code = s.match(/\b[A-Z]{2,}[A-Z0-9]*-?\d{2,}[A-Z0-9-]*\b/); return code ? code[0] : s.split(/\s+/).slice(0, 4).join(" "); }
  // Biologic names carry a four-letter FDA suffix ("zopapogene imadenovec-drba"); the program is the same drug.
  return s.replace(/-[a-z]{4}$/, "").replace(/[-–]+$/, "").trim();
};

function trialRow(p) {
  const phases = (p.designModule?.phases || []).map((x) => PHASE_MAP[x]).filter(Boolean);
  const ph = phases.sort((a, b) => PHASE_ORDER.indexOf(b) - PHASE_ORDER.indexOf(a))[0] || null;
  const pc = p.statusModule?.primaryCompletionDateStruct;
  let ro = pc?.date || null;
  if (ro && ro.length === 7) ro += "-15"; // registry often gives YYYY-MM only
  const drugs = (p.armsInterventionsModule?.interventions || [])
    .filter((i) => ASSET_TYPES.has(i.type) && i.name && !NOT_AN_ASSET.test(i.name))
    .map((i) => cleanDrug(i.name)).filter(Boolean);
  const own = drugs.filter((d) => !COMMON_PARTNERS.test(d));
  const di = p.designModule?.designInfo || {};
  const title = p.identificationModule?.briefTitle || "";
  const official = p.identificationModule?.officialTitle || "";
  const locs = p.contactsLocationsModule?.locations || [];
  const prim = p.outcomesModule?.primaryOutcomes || [];
  const ext = EXTENSION.test(`${title} ${official} ${di.interventionModelDescription || ""}`);
  return {
    nct: p.identificationModule?.nctId,
    title,
    status: p.statusModule?.overallStatus,
    ph, ro, roType: pc?.type || null,
    n: p.designModule?.enrollmentInfo?.count || 0,
    ind: p.conditionsModule?.conditions?.[0] || "—",
    ep: (prim[0]?.measure || "—").slice(0, 110),
    drugs: own,
    ext,
    design: {
      nct: p.identificationModule?.nctId, title, status: p.statusModule?.overallStatus, ext,
      n: p.designModule?.enrollmentInfo?.count || 0, nType: p.designModule?.enrollmentInfo?.type || null,
      alloc: di.allocation || null, model: di.interventionModel || null, masking: di.maskingInfo?.masking || null,
      arms: (p.armsInterventionsModule?.armGroups || []).map((a) => a.type).filter(Boolean),
      primary: (prim[0]?.measure || "").slice(0, 200), primaryCount: prim.length,
      sites: locs.length, countries: [...new Set(locs.map((l) => l.country).filter(Boolean))].slice(0, 12),
      start: p.statusModule?.startDateStruct?.date || null, startType: p.statusModule?.startDateStruct?.type || null,
      lastUpdate: p.statusModule?.lastUpdatePostDateStruct?.date || null,
    },
  };
}

// Group a sponsor's trials into drug programs. In combination trials the company's own
// asset is usually the intervention that shows up across the most of its trials.
function programsFromTrials(trials, assumed = {}) {
  const rows = trials.map(trialRow).filter((t) => t.ph && t.drugs.length);
  const freq = new Map();
  for (const t of rows) for (const d of new Set(t.drugs.map((x) => x.toLowerCase()))) freq.set(d, (freq.get(d) || 0) + 1);

  const aliasTo = new Map();
  for (const [key, a] of Object.entries(assumed)) {
    aliasTo.set(key.toLowerCase(), key);
    for (const al of a.aliases || []) aliasTo.set(al.toLowerCase(), key);
  }

  const groups = new Map();
  for (const t of rows) {
    const ranked = [...t.drugs].sort((a, b) =>
      (aliasTo.has(b.toLowerCase()) - aliasTo.has(a.toLowerCase()))
      || (freq.get(b.toLowerCase()) - freq.get(a.toLowerCase()))
      || (/\d/.test(b) - /\d/.test(a)));
    const name = ranked[0];
    const key = aliasTo.get(name.toLowerCase()) || name;
    const g = groups.get(key.toLowerCase()) || { name: key, trials: [] };
    g.trials.push(t);
    groups.set(key.toLowerCase(), g);
  }

  const programs = [];
  for (const g of groups.values()) {
    const active = g.trials.filter((t) => ACTIVE.has(t.status));
    const a = assumed[g.name] || {};
    if (!active.length && !a.ph) continue; // nothing running and not marked filed/approved
    const pool = active.length ? active : g.trials;
    // An open-label extension finishing is not a pivotal readout: prefer any other trial.
    const best = [...pool].sort((x, y) =>
      (x.ext - y.ext)
      || PHASE_ORDER.indexOf(y.ph) - PHASE_ORDER.indexOf(x.ph)
      || ((x.ro || "9999") < (y.ro || "9999") ? -1 : 1))[0];
    const top = [...pool].sort((x, y) => PHASE_ORDER.indexOf(y.ph) - PHASE_ORDER.indexOf(x.ph))[0];
    const ph = a.ph || top.ph;
    const est = a.peak == null;
    programs.push({
      d: a.name || g.name,
      ind: a.ind || top.ind,
      tgt: a.tgt || "—",
      moa: a.moa || "—",
      ph,
      n: best.n,
      ro: a.ro || best.ro || addDays(TODAY_ISO, 365),
      roType: a.ro ? "COMPANY GUIDANCE" : best.roType,
      ep: a.ep || top.ep,
      peak: a.peak ?? DEFAULTS.peakByPhase[ph],
      launch: a.launch ?? DEFAULTS.launchByPhase[ph],
      cost: a.cost ?? DEFAULTS.costByPhase[ph],
      est,
      nct: best.nct,
      trials: g.trials.length,
      activeTrials: active.length,
      status: best.status,
      trial: { ...best.design, ph: best.ph, ind: best.ind },
    });
  }
  programs.sort((x, y) => PHASE_ORDER.indexOf(y.ph) - PHASE_ORDER.indexOf(x.ph) || (x.ro < y.ro ? -1 : 1));
  return programs.slice(0, 6);
}

/* ---------------------------- read-through ----------------------------
   Other companies' mid- and late-stage trials in the same diseases, finishing
   in the next 18 months. Their results can move the tracked company's shares. */

const STOP = new Set(["disease", "diseases", "disorder", "patients", "with", "type", "adult", "adults", "advanced", "metastatic", "chronic", "severe", "moderate", "syndrome", "solid", "amenable", "group", "healthy", "participants", "mixed", "primary", "treatment", "people", "cancer", "tumors", "tumor"]);
const keyWords = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));

async function rivalsFor(pipeline, sponsor) {
  const lead = pipeline.filter((p) => ["Phase II", "Phase III", "Filed", "Approved"].includes(p.ph) && p.ind && p.ind !== "—" && !/healthy/i.test(p.ind)).slice(0, 3);
  const later = addDays(TODAY_ISO, 548);
  const own = normName(sponsor);
  const out = new Map();
  for (const p of lead) {
    const want = keyWords(p.ind);
    if (!want.length) continue;
    try {
      const u = new URL("https://clinicaltrials.gov/api/v2/studies");
      u.searchParams.set("query.cond", p.ind);
      u.searchParams.set("filter.overallStatus", "RECRUITING,ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING,ENROLLING_BY_INVITATION");
      u.searchParams.set("filter.advanced", `AREA[Phase](PHASE2 OR PHASE3) AND AREA[PrimaryCompletionDate]RANGE[${TODAY_ISO},${later}] AND AREA[LeadSponsorClass]INDUSTRY`);
      u.searchParams.set("fields", "NCTId,BriefTitle,LeadSponsorName,Phase,PrimaryCompletionDate,OverallStatus,InterventionName,InterventionType,LocationCountry,Condition,EnrollmentCount");
      u.searchParams.set("pageSize", "60");
      const j = await getJSON(u.toString(), { Accept: "application/json" });
      await sleep(300);
      for (const st of j?.studies || []) {
        const ps = st.protocolSection || {};
        const nct = ps.identificationModule?.nctId;
        const lead = ps.sponsorCollaboratorsModule?.leadSponsor?.name || "";
        if (!nct || out.has(nct)) continue;
        const ln = normName(lead);
        if (ln && (ln.includes(own) || own.includes(ln))) continue;
        const conds = (ps.conditionsModule?.conditions || []).join(" ");
        const have = new Set(keyWords(conds + " " + (ps.identificationModule?.briefTitle || "")));
        const hits = want.filter((w) => have.has(w)).length;
        if (hits < Math.min(2, want.length)) continue; // must share the disease, not just one word
        const drugs = (ps.armsInterventionsModule?.interventions || []).filter((i) => ASSET_TYPES.has(i.type) && !NOT_AN_ASSET.test(i.name || "")).map((i) => cleanDrug(i.name)).filter(Boolean)
          .map((d) => (d.length > 40 ? d.split(/[,;.]/)[0].split(" ").slice(0, 4).join(" ") + "…" : d));
        if (!drugs.length) continue;
        const countries = (ps.contactsLocationsModule?.locations || []).map((l) => l.country).filter(Boolean);
        const uniq = [...new Set(countries)];
        const phs = (ps.designModule?.phases || []).map((x) => PHASE_MAP[x]).filter(Boolean);
        let pcd = ps.statusModule?.primaryCompletionDateStruct?.date || null;
        if (pcd && pcd.length === 7) pcd += "-15";
        out.set(nct, {
          nct, sponsor: lead, title: (ps.identificationModule?.briefTitle || "").slice(0, 160), ph: phs.at(-1) || null,
          pcd, n: ps.designModule?.enrollmentInfo?.count || null, drugs: [...new Set(drugs)].slice(0, 3),
          forDrug: p.d, ind: p.ind, countries: uniq.slice(0, 6), nCountries: uniq.length,
          china: uniq.length === 1 && uniq[0] === "China" ? "only" : uniq.includes("China") ? "some" : null,
        });
      }
    } catch (e) { warn(`Read-through search failed for ${p.d}: ${e.message}`); }
  }
  return [...out.values()].sort((a, b) => (a.pcd || "9") < (b.pcd || "9") ? -1 : 1).slice(0, 12);
}

/* ------------------------- trial durations (KM) -------------------------
   Industry Phase II and III trials started 2012 to 2024: months from start to
   primary completion. Finished trials are events; running ones are censored. */

async function durationTables() {
  const rows = [];
  for (const [status, done] of [["COMPLETED", true], ["ACTIVE_NOT_RECRUITING,RECRUITING,ENROLLING_BY_INVITATION", false]]) {
    for (const phase of ["PHASE2", "PHASE3"]) {
      let token = null, pages = 0;
      do {
        const u = new URL("https://clinicaltrials.gov/api/v2/studies");
        u.searchParams.set("filter.overallStatus", status);
        u.searchParams.set("filter.advanced", `AREA[Phase]${phase} AND AREA[LeadSponsorClass]INDUSTRY AND AREA[StudyType]INTERVENTIONAL AND AREA[StartDate]RANGE[2012-01-01,2024-12-31]`);
        u.searchParams.set("fields", "NCTId,Phase,StartDate,PrimaryCompletionDate,EnrollmentCount");
        u.searchParams.set("pageSize", "1000");
        if (token) u.searchParams.set("pageToken", token);
        const j = await getJSON(u.toString(), { Accept: "application/json" });
        for (const st of j?.studies || []) {
          const ps = st.protocolSection || {};
          const phs = ps.designModule?.phases || [];
          if (phs.length !== 1) continue; // skip combined Phase I/II and II/III trials
          const ph = PHASE_MAP[phs[0]];
          const n = ps.designModule?.enrollmentInfo?.count;
          let sd = ps.statusModule?.startDateStruct?.date; if (!sd) continue; if (sd.length === 7) sd += "-15";
          let m;
          if (done) {
            // A completed trial's primary completion date is the actual one (the API omits the type when fields are filtered).
            const pc = ps.statusModule?.primaryCompletionDateStruct;
            if (!pc?.date || pc.type === "ESTIMATED") continue;
            const pd = pc.date.length === 7 ? pc.date + "-15" : pc.date;
            m = monthsBetween(sd, pd);
          } else m = monthsBetween(sd, TODAY_ISO);
          const key = stratumKey(ph, n);
          if (key && m > 0 && m < 200) rows.push({ key, m: Math.ceil(m), done });
        }
        token = j?.nextPageToken || null;
        pages++;
        await sleep(250);
      } while (token && pages < 8);
    }
  }
  const tables = {};
  for (const key of [...new Set(rows.map((r) => r.key))]) {
    const rs = rows.filter((r) => r.key === key);
    tables[key] = { n: rs.length, events: rs.filter((r) => r.done).length, S: kaplanMeier(rs) };
  }
  return tables;
}

/* --------------------------- FDA rejections ---------------------------
   Every complete response letter the FDA has published (openFDA). Summed
   by reviewing office and by the kind of problem the letter names. */

// Standard closing sections (safety update, labeling, proprietary name) appear in almost every letter,
// so these patterns look for wording that names an actual deficiency.
const CRL_REASONS = [
  ["Manufacturing or facility", /inspection of the (manufacturing )?facilit|facility inspection|objectionable conditions|Form FDA[- ]483|current good manufacturing practice|\bcGMP\b|product quality (deficienc|issue)|drug substance|sterility assurance|container closure|stability data (are|were) (inadequate|insufficient)/i],
  ["Clinical efficacy evidence", /substantial evidence of effectiveness|adequate and well[- ]controlled (stud|trial|investigation)s? (to|that)|(did|does) not (demonstrate|establish|provide)|failed to (demonstrate|meet|establish)|not statistically significant|additional (adequate and well[- ]controlled|clinical) (stud|trial)/i],
  ["Safety concerns", /safety (concern|signal)s?|unacceptable risk|benefit[- ]risk (profile|assessment) (is|was|does)|risks? (outweigh|of .{0,40} outweigh)|not been (shown|demonstrated) to be safe|insufficient (safety|exposure) data|hepatotoxicity|QT prolongation/i],
  ["Bioequivalence or drug levels", /bioequivalen|comparative bioavailability|relative bioavailability|pharmacokinetic (bridge|bridging|comparability)/i],
  ["Device or human factors", /human factors (study|validation)|device constituent|usability (study|testing)|use[- ]related risk/i],
];
async function crlSummary() {
  const rows = [];
  for (let skip = 0; skip < 3000; skip += 100) {
    const j = await getJSON(`https://api.fda.gov/transparency/crl.json?search=letter_type:%22COMPLETE+RESPONSE%22&limit=100&skip=${skip}`, { Accept: "application/json" });
    const res = j?.results || [];
    rows.push(...res);
    await sleep(300);
    if (res.length < 100) break;
  }
  if (!rows.length) return null;
  const byOffice = new Map(), byYear = new Map(), reasons = new Map(CRL_REASONS.map(([k]) => [k, 0]));
  const officeReasons = new Map();
  let first = null, last = null;
  for (const r of rows) {
    const d = r.letter_date ? r.letter_date.replace(/^(\d\d)\/(\d\d)\/(\d{4})$/, "$3-$1-$2") : null;
    if (d) { first = !first || d < first ? d : first; last = !last || d > last ? d : last; byYear.set(d.slice(0, 4), (byYear.get(d.slice(0, 4)) || 0) + 1); }
    const centers = [].concat(r.approver_center || []).join(" | ");
    const office = (OFFICE_GROUPS.find(([, re]) => re.test(centers)) || ["Office not named in the letter"])[0];
    byOffice.set(office, (byOffice.get(office) || 0) + 1);
    const text = r.text || "";
    const hit = CRL_REASONS.filter(([, re]) => re.test(text)).map(([k]) => k);
    for (const k of hit) reasons.set(k, reasons.get(k) + 1);
    const o = officeReasons.get(office) || { n: 0, mfg: 0, eff: 0 };
    o.n++; if (hit.includes("Manufacturing or facility")) o.mfg++; if (hit.includes("Clinical efficacy evidence")) o.eff++;
    if (!hit.length) reasons.set("No specific reason matched", (reasons.get("No specific reason matched") || 0) + 1);
    officeReasons.set(office, o);
  }
  return {
    total: rows.length, first, last,
    byYear: [...byYear.entries()].sort(),
    byOffice: [...byOffice.entries()].sort((a, b) => b[1] - a[1]).map(([office, n]) => ({ office, n, ...officeReasons.get(office) })),
    reasons: [...reasons.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
  };
}

/* ------------------------------ assemble ------------------------------ */

function shortName(edgarName) {
  return edgarName.replace(/,?\s+(inc|corp|corporation|ltd|limited|plc|n\.v|s\.a)\.?$/i, "").trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bInc\b/g, "Inc.");
}

async function buildCompany(ticker, a, cikByTicker, cls = {}, trialHist = {}, durTables = null) {
  const cik = cikByTicker.get(ticker);
  if (!cik) throw new Error(`ticker not found in SEC's company list`);
  const cik10 = String(cik).padStart(10, "0");

  const [facts, sub] = [await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`), await sec(`https://data.sec.gov/submissions/CIK${cik10}.json`)];
  if (!facts?.facts) throw new Error("no XBRL financial data on EDGAR");
  const fin = financialsFromFacts(facts.facts);
  if (!fin) throw new Error("no cash figure in XBRL data");
  if (fin.burn == null) throw new Error("no operating cash flow in XBRL data");
  if (!fin.shares) throw new Error("no shares outstanding figure");

  const listed = cikByTicker.titles?.get(ticker);
  const name = a.name || (listed && listed !== listed.toUpperCase() ? shortName(listed) : titleCase(shortName(sub?.name || facts.entityName || ticker)));
  const filed = filingsFromSubmissions(sub, cik);
  const { financings, lastPeriodic } = filed;
  const raise = await raiseCapacity(filed);

  const px = a.price ? { price: a.price, date: TODAY_ISO, source: "config/assumptions.json", prev: null, history: [] } : await priceFor(ticker);
  if (!px) throw new Error("no stock price available");
  const mcap = px.price * fin.shares;

  const sponsor = a.sponsor || shortName(sub?.name || facts.entityName);
  const trials = await trialsFor(sponsor);
  const pipeline = programsFromTrials(trials, a.programs || {});
  if (!pipeline.length) throw new Error(`no active trials found for sponsor "${sponsor}" (set "sponsor" in assumptions.json)`);

  // Classification for the drug-development models, then timing, design and odds per program.
  for (const p of pipeline) {
    const k = (cls.programs || {})[p.d] || {};
    Object.assign(p, { modality: cls.modality || null }, k);
    const seen = trialHist[p.nct] || [];
    p.slips = seen.reduce((n, x, i) => n + (i > 0 && Date.parse(x[1]) - Date.parse(seen[i - 1][1]) > 30 * DAY ? 1 : 0), 0);
    p.duration = durTables ? durationCheck(p, durTables, TODAY_ISO) : null;
    const settled = p.ph === "Approved" || p.ph === "Filed";
    p.window = settled ? null : readoutWindow(p, TODAY_ISO);
    p.flags = settled ? { flags: [], points: 0, level: null } : designFlags(p, TODAY_ISO);
    const odds = successOdds(p);
    p.odds = odds ? { loa: round(odds.loa, 4), base: round(odds.baseLoa, 4), area: odds.area, modality: odds.modality, factors: odds.factors } : null;
  }

  const catalysts = [];
  for (const p of pipeline) {
    if (p.ph === "Approved" || p.ph === "Filed") continue;
    const w = p.window;
    const date = w ? w.mid : p.ro;
    const dd = (toDate(date) - TODAY) / DAY;
    if (dd > -120 && dd < 730) {
      // Extension studies aren't pivotal, and an overdue registry date can't be relied on:
      // both appear on the calendar but don't count toward the Financing Pressure Score.
      const minor = !!p.trial?.ext || !!w?.stale;
      catalysts.push({
        date, kind: minor ? "minor" : "readout", drug: p.d, est: p.roType !== "ACTUAL",
        lo: w?.lo || null, hi: w?.hi || null, reg: p.ro, nct: p.nct,
        label: p.trial?.ext ? `${p.d} extension study completes (safety follow-up)`
          : w?.stale ? `${p.d} ${p.trial?.ph || p.ph} data (registry date overdue)`
          : `${p.d} ${p.trial?.ph || p.ph}${p.trial?.ind && p.trial.ind.toLowerCase() !== (p.ind || "").toLowerCase() ? ` (${p.trial.ind})` : ""} data (estimated)`,
      });
    }
  }
  if (lastPeriodic) {
    let next = addDays(lastPeriodic.date, 91);
    while (next < TODAY_ISO) next = addDays(next, 91);
    catalysts.push({ date: next, kind: "earnings", drug: null, est: true, label: "Next quarterly report (estimated)" });
  }
  for (const c of a.catalysts || []) catalysts.push({ drug: null, ...c });

  const mergedFinancings = (a.financings?.length ? a.financings : financings)
    .sort((x, y) => (x.date < y.date ? 1 : -1));

  return {
    t: ticker,
    n: name,
    area: a.area || sub?.sicDescription || "Biotechnology",
    mcap: round(mcap, 1),
    ev: round(mcap - fin.cash + fin.debt, 1),
    cash: round(fin.cash, 1),
    debt: round(fin.debt, 1),
    burn: round(fin.burn, 2),
    rev: round(fin.rev, 1),
    shares: round(fin.shares, 2),
    own: a.own ?? null,
    emp: a.emp ?? null,
    partners: a.partners || [],
    patentYrs: a.patentYrs ?? DEFAULTS.patentYrs,
    diff: a.diff ?? DEFAULTS.diff,
    mkt: a.mkt ?? DEFAULTS.mkt,
    pipeline,
    catalysts,
    financings: mergedFinancings,
    note: a.note || "",
    dil24: round(fin.dil24, 1),
    runwayHist: fin.runwayHist || [],
    revQ: fin.revQ || [],
    rivals: await rivalsFor(pipeline, sponsor),
    burnPrior: round(fin.burnPrior, 2),
    debtDue24: round(fin.debtDue24, 1),
    raise,
    quote: {
      price: round(px.price, 2),
      prev: round(px.prev, 2),
      chg: px.prev ? round(px.price - px.prev, 2) : null,
      chgPct: px.prev ? round(((px.price / px.prev) - 1) * 100, 2) : null,
      hi52: round(px.hi52, 2),
      lo52: round(px.lo52, 2),
      volume: px.volume,
      date: px.date,
      history: px.history || [],
    },
    news: newsFromSubmissions(sub, cik, name),
    cashFlowPositive: fin.cashFlowPositive,
    src: {
      cik: String(cik),
      asOf: fin.asOf,
      cashParts: fin.cashParts,
      burnHow: fin.burnHow,
      sharesAsOf: fin.sharesAsOf,
      filing: lastPeriodic,
      price: round(px.price, 2),
      priceDate: px.date,
      priceSource: px.source,
      sponsor,
      trials: trials.length,
      defaults: [
        a.diff == null && "differentiation", a.mkt == null && "market opportunity",
        a.patentYrs == null && "patent life", pipeline.some((p) => p.est) && "peak sales",
      ].filter(Boolean),
    },
  };
}

async function main() {
  if (!UA || !/@/.test(UA)) {
    console.error('Set SEC_USER_AGENT to a name and contact email, e.g. SEC_USER_AGENT="Jane Doe jane@example.com"');
    process.exit(1);
  }
  const config = JSON.parse(await readFile(new URL("config/companies.json", ROOT), "utf8"));
  const assumptions = JSON.parse(await readFile(new URL("config/assumptions.json", ROOT), "utf8"));
  let classes = {};
  try { classes = JSON.parse(await readFile(new URL("config/programs.json", ROOT), "utf8")); } catch { /* optional */ }
  let trialHist = {};
  try { trialHist = JSON.parse(await readFile(TRIAL_HISTORY_FILE, "utf8")); } catch { /* first run */ }

  let previous = {};
  try {
    const prev = JSON.parse(await readFile(OUT_FILE, "utf8"));
    for (const c of prev.companies || []) previous[c.t] = c;
    previous.__meta = prev.meta;
  } catch { /* first run */ }

  console.log("Loading SEC ticker list…");
  const tickers = await sec("https://www.sec.gov/files/company_tickers.json");
  const cikByTicker = new Map(Object.values(tickers || {}).map((r) => [r.ticker.toUpperCase(), r.cik_str]));
  // The ticker list keeps companies' own capitalization ("DBV Technologies"); EDGAR's filer names are all caps.
  cikByTicker.titles = new Map(Object.values(tickers || {}).map((r) => [r.ticker.toUpperCase(), r.title]));

  let durTables = null;
  try { durTables = await durationTables(); console.log(`Trial-duration tables: ${Object.entries(durTables).map(([k, v]) => `${k} n=${v.n}`).join("; ")}`); }
  catch (e) { warn(`Trial-duration download failed: ${e.message}`); durTables = previous.__meta?.durations || null; }

  const companies = [];
  for (const raw of config.tickers) {
    const ticker = raw.toUpperCase();
    console.log(`${ticker}…`);
    try {
      const c = await buildCompany(ticker, assumptions[ticker] || {}, cikByTicker, classes[ticker] || {}, trialHist, durTables);
      companies.push(c);
      console.log(`  ${c.n}: cash $${c.cash}M, burn $${c.burn}M/mo, ${c.pipeline.length} programs, mcap $${c.mcap}M`);
    } catch (e) {
      if (previous[ticker]) {
        warn(`${ticker}: ${e.message}. Kept the previous run's figures.`);
        companies.push({ ...previous[ticker], stale: true });
      } else {
        warn(`${ticker}: ${e.message}. Skipped.`);
      }
    }
  }

  if (!companies.length) {
    console.error("No companies could be built. Leaving the existing data file untouched.");
    process.exit(1);
  }

  // Sector benchmark for the Research page's event study: the SPDR S&P Biotech ETF.
  let benchmark = null;
  try {
    const y = await yahooQuote(BENCHMARK.symbol);
    if (y?.history?.length) benchmark = { ...BENCHMARK, history: y.history };
  } catch (e) { warn(`Benchmark ${BENCHMARK.symbol} price failed: ${e.message}`); }

  let fda = null;
  try { fda = await crlSummary(); } catch (e) { warn(`FDA letters download failed: ${e.message}`); }
  if (!fda && previous.__meta?.fda) fda = previous.__meta.fda;

  // Record each lead trial's registry completion date when it changes, to count slips over time.
  for (const c of companies) for (const p of c.pipeline || []) {
    if (!p.nct || !p.ro || p.roType === "COMPANY GUIDANCE") continue;
    const h = trialHist[p.nct] || [];
    if (!h.length || h.at(-1)[1] !== p.ro) h.push([TODAY_ISO, p.ro]);
    trialHist[p.nct] = h.slice(-20);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(TRIAL_HISTORY_FILE, JSON.stringify(trialHist) + "\n");

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      benchmark,
      fda,
      durations: durTables,
      sources: ["SEC EDGAR XBRL company facts", "SEC EDGAR filing index", "ClinicalTrials.gov API v2", "Yahoo Finance"],
      warnings,
    },
    companies,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 1) + "\n");

  // Keep a daily record of every score. It is the raw material for the public track record:
  // which companies were flagged, and whether they went on to raise money.
  let history = { snapshots: [] };
  try { history = JSON.parse(await readFile(HISTORY_FILE, "utf8")); } catch { /* first run */ }
  const snap = { date: TODAY_ISO, v: FPS_VERSION, scores: {} };
  for (const c of companies) {
    const f = computeFPS(c, TODAY);
    snap.scores[c.t] = { fps: f.score, band: f.band };
  }
  history.snapshots = history.snapshots.filter((x) => x.date !== TODAY_ISO).concat(snap).slice(-500);
  await writeFile(HISTORY_FILE, JSON.stringify(history) + "\n");

  // Prediction log: what Helixora published each day, with the model versions that produced it,
  // so any past figure can be checked against what later happened.
  let log = { note: "Daily record of Helixora's published predictions. Never edited after the day it was written.", days: [] };
  try { log = JSON.parse(await readFile(PREDICTIONS_FILE, "utf8")); } catch { /* first run */ }
  const day = { date: TODAY_ISO, models: { financingPressure: FPS_VERSION, trials: TRIALS_VERSION, quant: QUANT_VERSION }, companies: {} };
  for (const c of companies) {
    const f = computeFPS(c, TODAY);
    const sim = runwaySim(c);
    day.companies[c.t] = {
      fps: f.score, band: f.band, runwayMonths: f.runway,
      outOfCash18m: sim ? round(sim.p18, 3) : null,
      nextCatalyst: f.catalyst ? { date: f.catalyst.date, label: f.catalyst.label } : null,
      programs: Object.fromEntries((c.pipeline || []).map((p) => [p.d, { phase: p.ph, approvalOdds: p.odds?.loa ?? null, readoutLikely: p.window?.mid ?? null, readoutWindow: p.window ? [p.window.lo, p.window.hi] : null }])),
    };
  }
  if (!log.days.some((d) => d.date === TODAY_ISO)) log.days.push(day); // the first record of a day stands
  log.days = log.days.slice(-400);
  await writeFile(PREDICTIONS_FILE, JSON.stringify(log) + "\n");
  console.log(`\nWrote ${companies.length} companies to public/data/companies.json (${warnings.length} warnings).`);
}

// Export internals for tests; run only when invoked directly.
export { financialsFromFacts, trailing12, programsFromTrials, filingsFromSubmissions, newsFromSubmissions, shareHistory, main };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
