/* ------------------------------------------------------------------
   Has a company been bought, or is it being bought?

   Read from the company's own SEC filing list (the submissions API):
   - A tender offer (Schedule TO-T, and the target's Schedule 14D-9) or a
     merger proxy (DEFM14A / PREM14A / DEFM14C) means a deal is under way.
   - A delisting notice (Form 25 / 25-NSE) or a deregistration (Form 15)
     after that means the deal has closed: the company is no longer listed
     on its own and leaves coverage.
   - A delisting or deregistration with no deal filing before it (a wind-down
     or bankruptcy) also takes a company off the site, labelled as delisted,
     once its ticker has also left the SEC's list of listed companies (a
     company changing exchange files a Form 25 too, but keeps its ticker
     and keeps filing quarterly reports).

   A reverse merger, where a private company merges into the listed one and
   the listed company carries on, files no Form 25 or 15, so it stays.
------------------------------------------------------------------- */

const DEAL = /^(SC TO-T|SCHEDULE TO-T|SC 14D9|SCHEDULE 14D9|SC 14D-9|DEFM14A|PREM14A|DEFM14C|PREM14C)(\/A)?$/i;
const TENDER = /^(SC TO-T|SCHEDULE TO-T|SC 14D9|SCHEDULE 14D9|SC 14D-9)(\/A)?$/i;
const OFFER = /^(SC TO-T|SCHEDULE TO-T)(\/A)?$/i; // filed by the buyer
const GONE = /^(25|25-NSE|15-12B|15-12G|15-15D)(\/A)?$/i;

const addDays = (iso, d) => new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);

// sub: parsed submissions JSON. today: ISO date.
// Returns null (independent), or { status: "pending" | "acquired" | "delisted", since, how, adsh }.
export function dealStatus(sub, today = new Date().toISOString().slice(0, 10)) {
  const r = sub?.filings?.recent;
  if (!r?.form) return null;
  const rows = r.form.map((form, i) => ({ form, date: r.filingDate[i], adsh: r.accessionNumber[i] }));
  const deals = rows.filter((x) => DEAL.test(x.form));
  let gone = rows.find((x) => GONE.test(x.form) && x.date >= addDays(today, -730));
  // A company that switches exchange also files a Form 25, then keeps filing quarterly reports.
  if (gone && rows.some((x) => /^(10-[QK]|20-F|40-F)/.test(x.form) && x.date > gone.date)) gone = null;
  if (gone) {
    // A deal filing in the 18 months before the delisting means it was bought.
    const deal = deals.find((d) => d.date <= gone.date && d.date >= addDays(gone.date, -548));
    const recent = deals.filter((d) => d.date <= gone.date && d.date >= addDays(gone.date, -548));
    return deal
      ? { status: "acquired", since: gone.date, how: recent.some((d) => TENDER.test(d.form)) ? "tender offer" : "merger vote", adsh: (recent.find((d) => OFFER.test(d.form)) || deal).adsh }
      : { status: "delisted", since: gone.date, how: gone.form, adsh: gone.adsh };
  }
  // A deal filed in the last 9 months that hasn't closed yet.
  const live = deals.filter((d) => d.date >= addDays(today, -270));
  if (live.length) {
    const t = live.find((d) => TENDER.test(d.form));
    const first = live.at(-1);
    return { status: "pending", since: first.date, how: t ? "tender offer" : "merger vote", adsh: (live.find((d) => OFFER.test(d.form)) || t || live[0]).adsh };
  }
  return null;
}

// Large drugmakers, matched by name when the filings don't carry an industry code.
const BIG_PHARMA = /\b(pfizer|merck|johnson & johnson|janssen|abbvie|bristol[- ]myers|eli lilly|lilly|amgen|gilead|regeneron|vertex|biogen|novartis|roche|genentech|sanofi|astrazeneca|glaxosmithkline|gsk|novo nordisk|takeda|bayer|boehringer|astellas|daiichi|eisai|otsuka|chugai|ono pharm|shionogi|ucb|ipsen|lundbeck|servier|teva|viatris|jazz pharm|alnylam|biomarin|incyte|neurocrine|united therapeutics|alexion|csl|grifols|sumitomo|kyowa kirin|zoetis|organon|bausch|sun pharma|dr\. reddy|menarini|chiesi|almirall|recordati|bial|ferring|halozyme|ultragenyx|sarepta|exelixis)\b/i;
// Financial buyers: private equity funds and their acquisition vehicles.
const FINANCIAL = /\b(capital|partners|equity|fund|investments?|management|advisors|bidco|topco|holdco|l\.?p\.?$|blackstone|kkr|carlyle|tpg|bain|warburg|apollo|eqt|permira|advent|cvc|hellman|vista|thoma|patient square|novaquest|blackrock)\b/i;
const PHARMA_SIC = new Set(["2833", "2834", "2835", "2836", "8731"]);

const headerUrl = (cik, adsh) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${adsh}-index-headers.html`;
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&lt;|&gt;/g, " ").replace(/&amp;/g, "&").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&#x201[cd];/gi, '"').replace(/&#\w+;|&nbsp;/g, " ").replace(/\s+/g, " ");

// Who bought (or is buying) the company, and what kind of buyer it is.
// Returns { name, cik, sic, type: "pharma" | "financial" | "unknown" } or null.
// - Tender offers: the buyer files the Schedule TO, and the filing header names it with its industry code.
// - Merger votes: the target files the proxy alone, so the buyer is read from the proxy's text (the party defined as "Parent").
export async function buyerInfo(cik, adsh, ownName, secText) {
  if (!adsh) return null;
  const html = await secText(headerUrl(cik, adsh));
  if (!html) return null;
  const text = plain(html);
  const own = (ownName || "").toUpperCase().slice(0, 12);
  // A company's filing list also holds tender offers it makes for others. If the subject is another company, this one is the buyer.
  const subject = text.match(/SUBJECT COMPANY: COMPANY DATA: COMPANY CONFORMED NAME:\s*(.+?)\s+CENTRAL INDEX KEY/)?.[1];
  if (subject && own && !subject.toUpperCase().startsWith(own)) return { name: subject, cik: null, sic: null, type: "bidder", selfIsBidder: true };
  const filers = [...text.matchAll(/FILED BY: COMPANY DATA: COMPANY CONFORMED NAME:\s*(.+?)\s+CENTRAL INDEX KEY:\s*(\d+)(?:\s+STANDARD INDUSTRIAL CLASSIFICATION:[^[]*\[(\d{4})\])?/g)]
    .map((m) => ({ name: m[1].trim(), cik: m[2], sic: m[3] || null }))
    .filter((f) => !own || !f.name.toUpperCase().startsWith(own));
  let buyer = filers.find((f) => f.sic) || filers.find((f) => !/merger sub|acquisition|purchaser|\bsub\b/i.test(f.name)) || filers[0] || null;
  if (!buyer) {
    // A merger proxy: read the cover pages for the party defined as "Parent".
    const doc = text.match(/TYPE\s+(?:DEFM14A|PREM14A|DEFM14C|PREM14C)\s+SEQUENCE\s+1\s+FILENAME\s+(\S+)/i)?.[1];
    if (doc) {
      const body = await secText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${doc}`);
      const t = body ? plain(body).slice(0, 60000) : "";
      const parent = t.match(/([A-Z][A-Za-z0-9&.,'/ -]{2,70}?)\s*(?:,\s*an? [^()]{0,120})?\(\s*(?:the\s+)?"Parent"\s*\)/)?.[1]?.replace(/^.*?\b(?:with|by|among|between|and)\s+/i, "").trim();
      const named = t.match(BIG_PHARMA)?.[0];
      // A proxy whose "Parent" is the filer itself means the filer is the buyer (e.g. Amneal buying Kashiv in 2026).
      if (parent && own && parent.toUpperCase().startsWith(own.slice(0, 8))) return { name: parent, cik: null, sic: null, type: "bidder", selfIsBidder: true };
      if (parent || named) buyer = { name: parent || named, cik: null, sic: null };
    }
  }
  if (!buyer) return null;
  const type = (buyer.sic && PHARMA_SIC.has(buyer.sic)) || BIG_PHARMA.test(buyer.name) ? "pharma"
    : (buyer.sic && /^6/.test(buyer.sic)) || FINANCIAL.test(buyer.name) ? "financial" : "unknown";
  return { ...buyer, type };
}

// Is the buyer a drugmaker larger than the company it bought? Well-known large drugmakers count
// outright; any other drug-industry buyer counts when its public float exceeds the target's last market value.
// secJson: async (url) => parsed JSON | null.
export async function isLargerPharma(buyer, targetMcapM, secJson) {
  if (!buyer || buyer.type !== "pharma") return false;
  if (BIG_PHARMA.test(buyer.name)) return true;
  if (!buyer.cik || !targetMcapM) return false;
  const j = await secJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(buyer.cik).padStart(10, "0")}/dei/EntityPublicFloat.json`);
  const vals = j?.units?.USD || [];
  const last = vals.sort((a, b) => (a.end < b.end ? -1 : 1)).at(-1)?.val;
  return last ? last / 1e6 > targetMcapM : false;
}

export async function buyerName(cik, adsh, ownName, secText) {
  return (await buyerInfo(cik, adsh, ownName, secText))?.name || null;
}

const SMALL = new Set(["and", "of", "the", "&"]);
export const tidyName = (n) => n && n.toLowerCase().replace(/\b\w+/g, (w, i) => (i && SMALL.has(w) ? w : /^(ag|plc|nv|sa|se|llc|lp)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  .replace(/\b(Inc|Corp|Co|Ltd)\b\.?/g, "$1.").replace(/\.\./g, ".");
