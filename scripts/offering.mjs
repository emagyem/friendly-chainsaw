/* ------------------------------------------------------------------
   What a stock sale raised, read from the prospectus itself (424B4 or
   424B5 on SEC EDGAR). Only the cover page and the offering summary are
   read, where companies state the shares offered, the price and the
   shares outstanding before the sale.

   Returns, in millions of US dollars and millions of shares:
     { kind: "priced", amt, shares, price, before, dil }   a sale at a set price
     { kind: "atm", amt, upTo: true }                     an at-the-market program: the most it may sell
     { kind: "resale" }                                   shareholders selling their own shares; the company raises nothing
     { kind: "notes", amt, convertible }                  a bond sale (often convertible into shares later)
     { kind: "preliminary", amt }                         a draft filed before pricing; the final follows within days
     null                                                 couldn't be read
------------------------------------------------------------------- */

import { toText } from "./guidance.mjs";

const num = (s) => parseFloat(String(s).replace(/,/g, ""));
const scale = (v, unit) => (/billion/i.test(unit || "") ? v * 1000 : /million/i.test(unit || "") ? v : v / 1e6);

const STOCK = "(?:shares of (?:our |its )?(?:Class A )?(?:common stock|ordinary shares|common shares)|(?:Class A )?(?:ordinary|common) shares|American Depositary Shares|ADSs)";
const SUBJ = "\\b(?:is|are) offering\\s+(?:on an? [^,.]{0,40}? basis\\s+)?(?:up to\\s+)?(?:an aggregate of\\s+)?";
const ATM_UPTO = [
  /up to (?:a maximum )?(?:an )?aggregate (?:gross )?(?:offering|sales) (?:price|amount) of\s+\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?/i,
  /(?:aggregate (?:gross )?(?:sales|offering) (?:price|amount)|gross (?:sales )?proceeds|aggregate (?:offering )?amount)\s+of\s+up\s+to\s+\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?/i,
  /may offer and sell (?:shares of (?:our )?common stock (?:having an aggregate offering price of )?)?up to (?:an additional )?\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?/i,
];
const SALES_AGENT = /\b(sales agreement|sale agreement|equity distribution agreement|open market sale agreement|at[- ]the[- ]market|controlled equity offering|sales agent)\b/i;
const SELLING_HOLDERS = /\bselling (?:stock|share)holders?\b/i;
const OFFERING_SHARES = new RegExp(`${SUBJ}([\\d,]{5,})\\s+(?:of\\s+)?(?:(?:our|its)\\s+)?${STOCK}`, "i");
// A preliminary prospectus: the deal is sized in dollars and the share count is left blank until pricing.
const PRELIM_DOLLARS = new RegExp(`${SUBJ}\\$\\s?([\\d,.]+)\\s*(million|billion)?\\s+(?:of\\s+)?(?:(?:our|its)\\s+)?(?:shares|${STOCK})`, "i");
const PRELIM_BLANK = new RegExp(`${SUBJ}(?:of\\s+)?(?:(?:our|its)\\s+)?${STOCK}`, "i");
const NOTES = /\b(?:is|are) offering\s+\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?\s+(?:in\s+)?aggregate principal amount of\s+(?:our|its)?\s*([^;]{0,80}?notes)/i;
const PREFUNDED = /pre-funded warrants to purchase (?:up to )?(?:an aggregate of )?([\d,]{5,}) (?:shares|(?:Class A )?ordinary shares|common shares|ADSs)/i;
// Cover table: "Public offering price $ 9.00 [$ 8.999 per pre-funded warrant] $ 100,000,000"
const PRICE_TABLE = /(?:Public )?offering price\s*(?:\(\d\))?\s*\$\s?([\d,]*\.\d+)(?:\s*\(\d\))?(?:\s*\$\s?[\d,]*\.\d+(?:\s*\(\d\))?){0,2}\s*\$\s?([\d,]{7,}(?:\.\d+)?)/i;
const PRICE_TEXT = [
  /(?:public )?offering price (?:of|is)\s+\$\s?([\d,]*\.?\d+)\s+per (?:share|ADS|common share|ordinary share)/i,
  /offering price (?:per|for each|of each|for one) [\w\s-]{0,60}?(?:is|of)\s+\$\s?([\d,]*\.?\d+)/i,
  /purchase price (?:of|equal to)\s+\$\s?([\d,]*\.?\d+)\s+per (?:share|ADS)/i,
  /at a price of\s+\$\s?([\d,]*\.?\d+)\s+per (?:share|ADS)/i,
];
const BEFORE = /(?:common stock|ordinary shares|common shares|shares|ADSs?) outstanding (?:immediately )?(?:before|prior to) (?:this|the) offering\s*(?:\(\d\))?\s*:?\s*([\d,]{6,})/i;
const AFTER = /(?:common stock|ordinary shares|common shares|shares|ADSs?) (?:to be )?outstanding (?:immediately )?after (?:this|the) offering\s*(?:\(\d\))?\s*:?\s*([\d,]{6,})/i;

const firstMatch = (text, list) => { for (const re of list) { const m = text.match(re); if (m) return m; } return null; };

export function parseOffering(html, sharesNowM = null) {
  if (!html) return null;
  const text = toText(html).slice(0, 150000);
  const cover = text.slice(0, 25000);
  const sm = cover.match(OFFERING_SHARES);

  if (SELLING_HOLDERS.test(cover.slice(0, 4000)) && !sm) return { kind: "resale" };

  const notes = cover.match(NOTES);
  if (notes) {
    const amt = scale(num(notes[1]), notes[2]);
    if (amt >= 1 && amt <= 20000) return { kind: "notes", amt: round(amt), convertible: /convertible|exchangeable/i.test(notes[3]) };
  }

  const atm = firstMatch(cover, ATM_UPTO);
  if (atm && SALES_AGENT.test(cover) && !sm) {
    const amt = scale(num(atm[1]), atm[2]);
    if (amt >= 1 && amt <= 20000) return { kind: "atm", amt: round(amt), upTo: true };
  }

  if (!sm) {
    const pd = cover.match(PRELIM_DOLLARS);
    if (pd) { const amt = scale(num(pd[1]), pd[2]); return { kind: "preliminary", amt: amt >= 1 && amt <= 20000 ? round(amt) : null }; }
    if (PRELIM_BLANK.test(cover) || /subject to completion|preliminary prospectus/i.test(cover.slice(0, 3000))) return { kind: "preliminary", amt: null };
    return null;
  }

  const pf = cover.match(PREFUNDED);
  const common = num(sm[1]);
  const shares = common + (pf ? num(pf[1]) : 0);
  const table = cover.match(PRICE_TABLE);
  const pm = table || firstMatch(cover, PRICE_TEXT);
  let price = pm ? num(pm[1]) : null;
  if (!(price > 0 && price <= 5000)) price = null;
  // The cover table's total is the cleanest figure; otherwise shares times price.
  let amt = price == null ? null
    : (table && num(table[2]) > shares * price * 0.5 && num(table[2]) < shares * price * 1.5 ? num(table[2]) : shares * price) / 1e6;
  if (amt != null && (amt < 0.5 || amt > 20000)) amt = null;

  let before = null, approx = false;
  const bm = text.match(BEFORE), am = text.match(AFTER);
  if (bm) before = num(bm[1]) / 1e6;
  else if (am && num(am[1]) > common) before = (num(am[1]) - common) / 1e6;
  if (!(before > 0) || before < (shares / 1e6) * 0.05) { before = sharesNowM; approx = true; }
  // In an IPO the "before" count is the founders' and venture investors' stake, so dilution isn't meaningful.
  const ipo = /\binitial public offering\b/i.test(cover.slice(0, 4000));
  const dil = before > 0 && !ipo ? ((shares / 1e6) / before) * 100 : null;
  return {
    kind: "priced", ...(ipo ? { ipo: true } : {}), amt: amt == null ? null : round(amt), shares: round(shares / 1e6, 2), price: price == null ? null : round(price, 2),
    before: before ? round(before, 1) : null, dil: dil != null && dil < 1000 ? round(dil) : null, approx: approx || undefined,
  };
}

function round(n, d = 1) { return Math.round(n * 10 ** d) / 10 ** d; }
