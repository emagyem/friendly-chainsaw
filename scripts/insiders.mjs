/* ------------------------------------------------------------------
   Insider trades from SEC Form 4.

   Directors, officers and 10% owners must report each trade in their
   company's stock within two business days. Only open-market buys (code P)
   and sales (code S) are kept; grants, option exercises and gifts are left
   out because they aren't decisions to put money in or take it out.

   Each sale is sorted into one of three kinds, read from the filing:
     plan  sold under a Rule 10b5-1 plan set up months earlier
     tax   sold to cover taxes when stock awards vested
     sold  everything else: a sale the insider chose to make now
------------------------------------------------------------------- */

// A field is either <tag><value>x</value>…</tag> (footnote markers may follow the value) or <tag>x</tag>.
const val = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  const v = m[1].match(/<value>([\s\S]*?)<\/value>/i);
  return (v ? v[1] : m[1].replace(/<[^>]+>/g, "")).trim();
};
const unescape = (s) => (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

const TAX = /\b(tax(es)?|withholding|sell[- ]to[- ]cover|satisfy[^.]{0,60}(tax|withholding)|cover[^.]{0,40}tax)/i;
const PLAN = /10b5-1/i;

// The Form 4 filings a company's own submissions list shows for the last `days` days.
export function form4Filings(sub, cik, days = 365, today = new Date()) {
  const r = sub?.filings?.recent;
  if (!r) return [];
  const since = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== "4" || r.filingDate[i] < since) continue;
    const acc = r.accessionNumber[i];
    const doc = String(r.primaryDocument[i] || "").replace(/^xslF345X\d+\//, "");
    if (!doc.endsWith(".xml")) continue;
    out.push({ acc, filed: r.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc.replace(/-/g, "")}/${doc}` });
  }
  return out;
}

// One Form 4 → its open-market trades.
export function parseForm4(xml) {
  if (!xml || !/<ownershipDocument/i.test(xml)) return null;
  const owner = unescape(val(xml, "rptOwnerName") || "");
  const rel = (xml.match(/<reportingOwnerRelationship>[\s\S]*?<\/reportingOwnerRelationship>/i) || [""])[0];
  const yes = (tag) => /^(1|true)$/i.test(val(rel, tag) || "");
  const title = unescape(val(rel, "officerTitle") || "") || (yes("isDirector") ? "Director" : yes("isTenPercentOwner") ? "10% owner" : "Insider");
  // Officers and directors run the company; a 10% holder is usually an investment fund trading its own position.
  const role = isEntity(owner) ? "holder" : yes("isOfficer") || yes("isDirector") ? "insider" : yes("isTenPercentOwner") ? "holder" : "insider";
  const footnotes = Object.fromEntries([...xml.matchAll(/<footnote id="([^"]+)">([\s\S]*?)<\/footnote>/gi)].map((m) => [m[1], unescape(m[2]).replace(/\s+/g, " ")]));
  const planBox = /<aff10b5One>\s*(?:<value>)?\s*(1|true)/i.test(xml);
  const tx = [];
  for (const block of xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || []) {
    const code = val(block, "transactionCode");
    if (code !== "P" && code !== "S") continue;
    const shares = parseFloat(val(block, "transactionShares"));
    const price = parseFloat(val(block, "transactionPricePerShare"));
    if (!(shares > 0)) continue;
    const notes = [...block.matchAll(/<footnoteId id="([^"]+)"/gi)].map((m) => footnotes[m[1]] || "").join(" ");
    const kind = code === "P" ? "buy" : TAX.test(notes) ? "tax" : planBox || PLAN.test(notes) ? "plan" : "sold";
    tx.push({ date: val(block, "transactionDate"), kind, shares: Math.round(shares), price: price > 0 ? Math.round(price * 100) / 100 : null });
  }
  return { owner: tidyOwner(owner), title, role, tx };
}

// Funds and companies file under their own names, sometimes as "directors" because they hold a board seat.
const ENTITY = /\b(LLC|L\.?L\.?C|L\.?P\.?|Ltd|Limited|Fund|Funds|Capital|Partners|Holdings|Management|Inc|Corp|Corporation|Trust|Advisors|Advisers|Ventures|Investments?|Group|AG|S\.?A|N\.?V|plc|GmbH|Foundation)\b\.?/i;
export const isEntity = (name) => ENTITY.test(name || "");

// "ZANTE GREG" → "Greg Zante"; fund names keep their capitals.
function tidyOwner(n) {
  if (!n) return "";
  if (isEntity(n)) return n;
  const parts = n.split(/\s+/).map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w));
  return parts.length >= 2 ? [...parts.slice(1), parts[0]].join(" ") : parts.join(" ");
}

// Totals over the window, in millions of dollars, plus the latest trades to list.
export function summarizeInsiders(rows, today = new Date(), days = 365) {
  const since = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);
  const recent90 = new Date(today.getTime() - 90 * 864e5).toISOString().slice(0, 10);
  const all = rows.filter((r) => r.date >= since).sort((a, b) => (a.date < b.date ? 1 : -1));
  const fund = (r) => r.role === "holder" || isEntity(r.owner);
  const inWin = all.filter((r) => !fund(r)), funds = all.filter(fund);
  const usd = (r) => (r.price ? (r.shares * r.price) / 1e6 : 0);
  const sum = (kind, from = since) => inWin.filter((r) => r.kind === kind && r.date >= from).reduce((s, r) => s + usd(r), 0);
  const people = (kind) => new Set(inWin.filter((r) => r.kind === kind).map((r) => r.owner)).size;
  const r1 = (x) => Math.round(x * 100) / 100;
  return {
    days,
    bought: r1(sum("buy")), buyers: people("buy"),
    sold: r1(sum("sold")), sellers: people("sold"),
    planSold: r1(sum("plan")), taxSold: r1(sum("tax")),
    bought90: r1(sum("buy", recent90)), sold90: r1(sum("sold", recent90)),
    holders: { bought: r1(funds.filter((r) => r.kind === "buy").reduce((s, r) => s + usd(r), 0)), sold: r1(funds.filter((r) => r.kind !== "buy").reduce((s, r) => s + usd(r), 0)), names: [...new Set(funds.map((r) => r.owner))].slice(0, 3) },
    trades: inWin.slice(0, 15).map((r) => ({ ...r, usd: r1(usd(r)) })),
  };
}
