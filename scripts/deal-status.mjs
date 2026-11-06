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
  if (gone && rows.some((x) => /^10-[QK]/.test(x.form) && x.date > gone.date)) gone = null;
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

// Best effort: the buyer's name, from the "FILED BY" block of a tender-offer filing's header.
// secText: async (url) => string | null. Returns null when it can't be told.
export async function buyerName(cik, adsh, ownName, secText) {
  if (!adsh) return null;
  const html = await secText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${adsh}-index-headers.html`);
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&lt;|&gt;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  // Only the header's FILED BY blocks name the buyer (a merger proxy is filed by the target alone).
  const names = [...text.matchAll(/FILED BY: COMPANY DATA: COMPANY CONFORMED NAME:\s*(.+?)\s+CENTRAL INDEX KEY/g)].map((m) => m[1].trim());
  const own = (ownName || "").toUpperCase().slice(0, 12);
  const others = names.filter((n) => !own || !n.toUpperCase().startsWith(own));
  // Prefer the parent over its purpose-built merger subsidiary.
  return others.find((n) => !/merger sub|acquisition|purchaser|\bsub\b/i.test(n)) || others[0] || null;
}

const SMALL = new Set(["and", "of", "the", "&"]);
export const tidyName = (n) => n && n.toLowerCase().replace(/\b\w+/g, (w, i) => (i && SMALL.has(w) ? w : /^(ag|plc|nv|sa|se|llc|lp)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
  .replace(/\b(Inc|Corp|Co|Ltd)\b\.?/g, "$1.").replace(/\.\./g, ".");
