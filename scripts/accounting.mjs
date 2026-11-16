/* ------------------------------------------------------------------
   Accounting checks: the quality of the cash and burn figures, dilution
   that hasn't happened yet, and events that often come before trouble.

   Everything here comes from the company's own tagged financial data
   (SEC XBRL) or its list of filings. Nothing is estimated: a figure the
   company doesn't report is left out rather than guessed.
------------------------------------------------------------------- */

const M = (usd) => (usd == null ? null : Math.round((usd / 1e6) * 10) / 10);
const daysApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;

/* ---- events in the filing list ---- */

// 8-K items a company must file within four business days.
const ITEM_FLAGS = {
  "4.02": ["restatement", "Told investors not to rely on earlier financial statements", "high"],
  "4.01": ["auditor", "Changed its auditor", "med"],
  "3.01": ["listing", "Received a notice about its stock-exchange listing, or moved exchanges", "med"],
};
const LATE = { "NT 10-K": "Told the SEC its annual report would be late", "NT 10-Q": "Told the SEC its quarterly report would be late" };

export function filingFlags(sub, cik, today, months = 24) {
  const r = sub?.filings?.recent;
  if (!r) return [];
  const since = new Date(new Date(today).getTime() - months * 30.44 * 864e5).toISOString().slice(0, 10);
  const url = (i) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`;
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i], date = r.filingDate[i];
    if (date < since) continue;
    if (LATE[form]) out.push({ kind: "late", sev: "med", date, label: LATE[form], url: url(i) });
    if (form === "8-K" || form === "8-K/A") {
      for (const item of String(r.items?.[i] || "").split(",").map((x) => x.trim())) {
        const f = ITEM_FLAGS[item];
        if (f && !out.some((x) => x.kind === f[0] && daysApart(x.date, date) < 10)) out.push({ kind: f[0], sev: f[2], date, label: f[1], url: url(i) });
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

// What a listing notice (8-K item 3.01) is about, read from the filing's text.
export function listingReason(text) {
  const t = (text || "").slice(0, 60000);
  if (/\b(transfer(?:ring)? (?:the |its )?listing|voluntar(?:y|ily) (?:delist|transfer|withdraw)|approved for listing on)\b/i.test(t)) return ["Moved, or is moving, its listing to another exchange", "low"];
  if (/\bminimum bid price\b|\$\s?1\.00 per share|bid price (?:of|requirement)/i.test(t)) {
    return /\bregained compliance\b/i.test(t) ? ["Regained compliance after its share price fell below the exchange's $1 minimum", "low"] : ["Exchange notice: share price below the $1 minimum (a reverse split often follows)", "high"];
  }
  if (/\b(stockholders'? equity|market value of (?:listed|publicly held)|minimum value of listed securities)\b/i.test(t)) return ["Exchange notice: below the exchange's minimum size or equity requirement", "high"];
  if (/\b(timely file|failure to file|delinquen|periodic report|Form 10-[KQ])\b/i.test(t) && /\bnot(?:ice| in compliance)\b/i.test(t)) return ["Exchange notice: a required financial report is overdue", "high"];
  if (/\b(audit committee|independent directors?|majority (?:of )?independent|board (?:of directors )?composition|compensation committee)\b/i.test(t)) return ["Exchange notice: board or audit-committee seats need filling", "low"];
  if (/\bregained compliance\b/i.test(t)) return ["Regained compliance with exchange listing rules", "low"];
  return null;
}

/* ---- figures from the tagged financial data ---- */

// The newest value of a point-in-time fact, if it's dated within `maxDays` of the balance sheet.
function instantNear(facts, tags, asOf, unit = "USD", maxDays = 20) {
  let best = null;
  for (const tag of tags) {
    const rows = (facts?.["us-gaap"]?.[tag]?.units?.[unit] || []).filter((r) => !r.start && daysApart(r.end, asOf) <= maxDays);
    if (!rows.length) continue;
    const row = rows.reduce((a, b) => (b.end > a.end || (b.end === a.end && (b.filed || "") > (a.filed || "")) ? b : a));
    if (!best || row.end > best.end) best = { tag, val: row.val, end: row.end };
  }
  return best;
}

export function accountingFromFacts(facts, fin, { pickSeries, trailing12 }) {
  if (!fin) return null;
  const asOf = fin.asOf;
  const ttm = (tags) => {
    const t = trailing12(pickSeries(facts, tags));
    return t && fin.ocfEnd && daysApart(t.end, fin.ocfEnd) <= 20 ? t.val : null;
  };

  // Burn with timing effects taken out. Cash received in advance from a partner (a rise in deferred
  // revenue) is real money but won't repeat, so it's removed. Unpaid bills (a rise in payables and
  // accruals) only delay spending, so they're removed too; paying down old bills is added back.
  const upfront = Math.max(0, ttm(["IncreaseDecreaseInContractWithCustomerLiability", "IncreaseDecreaseInDeferredRevenue"]) || 0);
  const both = ttm(["IncreaseDecreaseInAccountsPayableAndAccruedLiabilities"]);
  const ap = ttm(["IncreaseDecreaseInAccountsPayable", "IncreaseDecreaseInAccountsPayableTrade"]);
  const accr = ttm(["IncreaseDecreaseInAccruedLiabilities", "IncreaseDecreaseInAccruedLiabilitiesAndOtherOperatingLiabilities", "IncreaseDecreaseInOtherAccruedLiabilities"]);
  const payables = both != null ? both : ap != null || accr != null ? (ap || 0) + (accr || 0) : null;
  const ocf = fin.ocf * 1e6;
  const coreOcf = ocf - upfront - (payables || 0);
  const core = payables == null && !upfront ? null : {
    burn: coreOcf < 0 ? Math.round((-coreOcf / 12e6) * 100) / 100 : 0,
    upfront: M(upfront), payables: M(payables),
  };

  // Cash the company can't freely spend.
  const restricted = instantNear(facts, ["RestrictedCashAndCashEquivalents", "RestrictedCash"], asOf)
    || (() => { const c = instantNear(facts, ["RestrictedCashAndCashEquivalentsAtCarryingValue", "RestrictedCashCurrent", "RestrictedCashAndCashEquivalentsCurrent"], asOf), n = instantNear(facts, ["RestrictedCashNoncurrent", "RestrictedCashAndCashEquivalentsNoncurrent"], asOf); return c || n ? { val: (c?.val || 0) + (n?.val || 0) } : null; })();

  // Promises to pay that aren't debt.
  const lease = instantNear(facts, ["OperatingLeaseLiability"], asOf)
    || (() => { const c = instantNear(facts, ["OperatingLeaseLiabilityCurrent"], asOf), n = instantNear(facts, ["OperatingLeaseLiabilityNoncurrent"], asOf); return c || n ? { val: (c?.val || 0) + (n?.val || 0) } : null; })();
  const purchase = instantNear(facts, ["PurchaseObligation", "UnrecordedUnconditionalPurchaseObligationBalanceSheetAmount", "ContractualObligation", "LongTermPurchaseCommitmentAmount"], asOf, "USD", 400);

  // Shares that don't exist yet but can: options, unvested stock awards, warrants, convertible notes.
  // Companies report the total they left out of loss-per-share ("antidilutive securities"); where
  // they give only the parts, the parts are added up.
  const anti = (() => {
    const s = pickSeries(facts, ["AntidilutiveSecuritiesExcludedFromComputationOfEarningsPerShareAmount"], { unit: "shares" });
    const row = s?.rows.at(-1);
    return row && daysApart(row.end, asOf) <= 100 ? row.val : null;
  })();
  const options = instantNear(facts, ["ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingNumber"], asOf, "shares", 380)?.val ?? null;
  const awards = instantNear(facts, ["ShareBasedCompensationArrangementByShareBasedPaymentAwardEquityInstrumentsOtherThanOptionsNonvestedNumber"], asOf, "shares", 380)?.val ?? null;
  const warrants = instantNear(facts, ["ClassOfWarrantOrRightOutstanding"], asOf, "shares", 380)?.val ?? null;
  const parts = (options || 0) + (awards || 0) + (warrants || 0);
  const potential = Math.max(anti || 0, parts);
  const sharesNow = (fin.shares || 0) * 1e6;
  const overhang = potential > 0 && sharesNow > 0 && potential < sharesNow * 3 ? {
    shares: Math.round(potential / 1e4) / 100,
    pct: Math.round((potential / sharesNow) * 1000) / 10,
    options: options ? Math.round(options / 1e4) / 100 : null,
    awards: awards ? Math.round(awards / 1e4) / 100 : null,
    warrants: warrants ? Math.round(warrants / 1e4) / 100 : null,
    basis: anti && anti >= parts ? "total" : "parts",
  } : null;

  // Where the money goes: research against overhead.
  const rd = trailing12(pickSeries(facts, ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost", "ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost"]));
  const ga = trailing12(pickSeries(facts, ["GeneralAndAdministrativeExpense", "SellingGeneralAndAdministrativeExpense"]));
  const fresh = (t) => t && daysApart(t.end, asOf) <= 100;
  const spend = fresh(rd) && fresh(ga) && rd.val > 0 && ga.val > 0 ? { rd: M(rd.val), ga: M(ga.val), rdShare: Math.round((rd.val / (rd.val + ga.val)) * 1000) / 10 } : null;

  return {
    core,
    restricted: restricted?.val > 0 ? M(restricted.val) : null,
    lease: lease?.val > 0 ? M(lease.val) : null,
    purchase: purchase?.val > 0 ? M(purchase.val) : null,
    overhang, spend,
  };
}
