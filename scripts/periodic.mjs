/* ------------------------------------------------------------------
   What a company says in its latest quarterly or annual report (10-Q, 10-K).

   Four things are read from the text, each kept with the sentence it came from:
     runway   how long management says its cash will last
     atm      how much stock it actually sold through its at-the-market program
     other    money that doesn't come from selling shares: royalty deals,
              loan money not yet drawn, payments due from partners
     events   FDA decision dates and advisory committee meetings it has announced
------------------------------------------------------------------- */

import { toText } from "./guidance.mjs";

// Bump when the reading rules change, so reports read under older rules are read again.
export const PERIODIC_PARSER = 1;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORDNUM = { twelve: 12, eighteen: 18, "twenty-four": 24, "twenty four": 24, thirty: 30, "thirty-six": 36, "thirty six": 36, one: 1, two: 2, three: 3 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addMonths = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const clip = (s, n = 320) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const sentences = (text) => text.split(/(?<=[.;])\s+(?=[A-Z(])/).filter((s) => s.length > 40 && s.length < 900);
const dollars = (v, unit) => { const n = parseFloat(String(v).replace(/,/g, "")); return /billion/i.test(unit || "") ? n * 1000 : /million/i.test(unit || "") ? n : n / 1e6; };
const ORD = { first: 1, second: 2, third: 3, fourth: 4 };

/* ---- runway guidance ---- */

const CASH_WORDS = /\b(cash|capital resources|marketable securities|investments)\b/i;
const FUND_WORDS = /\b(sufficient|fund|enable us|support|finance|runway)\b/i;
const OPS_WORDS = /\b(operat|capital expenditure|requirements|planned|runway|obligations)\b/i;
const DOUBT = /\b(raises?d?|there is|exists?)\s+substantial doubt\s+(?:about|regarding|as to)\s+(?:the company's|our|its)\s+ability to continue as a going concern/i;
const NOT_DOUBT = /\b(whether|evaluat|alleviat|mitigat|do(?:es)? not|did not|no longer|if (?:we|the)|could|may|would)\b/i;

// Turn "into the second half of 2028" into the first day that phrase covers.
function horizon(s, filed) {
  let m;
  if ((m = s.match(/\b(?:into|through|until|to)\s+(?:at least\s+)?(?:the\s+)?(first|second)\s+half\s+of\s+(?:calendar\s+year\s+)?(20\d\d)/i))) {
    const through = /^(through)$/i.test(s.slice(m.index).split(/\s+/)[0]);
    const h = ORD[m[1].toLowerCase()];
    return { until: through ? iso(m[2], h === 1 ? 6 : 12, 30) : iso(m[2], h === 1 ? 1 : 7, 1), say: `${through ? "through" : "into"} the ${m[1].toLowerCase()} half of ${m[2]}` };
  }
  if ((m = s.match(/\b(into|through|until|to)\s+(?:at least\s+)?(?:the\s+)?(first|second|third|fourth)\s+quarter\s+of\s+(?:calendar\s+year\s+)?(20\d\d)/i))) {
    const q = ORD[m[2].toLowerCase()], through = /through/i.test(m[1]);
    return { until: through ? iso(m[3], q * 3, 28) : iso(m[3], q * 3 - 2, 1), say: `${through ? "through" : "into"} the ${m[2].toLowerCase()} quarter of ${m[3]}` };
  }
  if ((m = s.match(/\b(into|through|until)\s+(?:at least\s+)?(?:the\s+)?(?:(early|mid|middle of|late|end of|beginning of)[-\s]+)?(?:calendar\s+year\s+)?(20\d\d)\b/i))) {
    const through = /through/i.test(m[1]) || /end of/i.test(m[2] || "");
    const part = (m[2] || "").toLowerCase();
    const until = through ? iso(m[3], 12, 31) : /mid/.test(part) ? iso(m[3], 7, 1) : /late/.test(part) ? iso(m[3], 10, 1) : iso(m[3], 1, 1);
    return { until, say: `${through ? "through" : "into"} ${part && !/end of/.test(part) ? part.replace("middle of", "mid") + " " : ""}${m[3]}` };
  }
  if ((m = s.match(/\bbeyond\s+(?:the\s+end\s+of\s+)?(20\d\d)\b/i))) return { until: iso(Number(m[1]) + 1, 1, 1), say: `beyond ${m[1]}` };
  if ((m = s.match(/\b(?:at least|for)\s+(?:the\s+)?(?:next\s+)?(\d{2}|twelve|eighteen|twenty[- ]four|thirty|thirty[- ]six)\s+months\b/i))) {
    const n = WORDNUM[m[1].toLowerCase()] || parseInt(m[1], 10);
    if (n >= 12 && n <= 60) return { until: addMonths(filed, n), say: `at least the next ${n} months`, floor: true };
  }
  if ((m = s.match(/\bat least\s+(?:the\s+next\s+)?(one|two|three)\s+years?\b/i))) return { until: addMonths(filed, WORDNUM[m[1].toLowerCase()] * 12), say: `at least ${m[1].toLowerCase()} year${m[1].toLowerCase() === "one" ? "" : "s"}`, floor: true };
  return null;
}

function runwayGuidance(sents, filed) {
  const doubt = sents.find((s) => DOUBT.test(s) && !NOT_DOUBT.test(s));
  if (doubt) return { kind: "doubt", say: "substantial doubt it can keep operating for another 12 months", until: addMonths(filed, 12), text: clip(doubt) };
  let floor = null;
  for (const s of sents) {
    if (!CASH_WORDS.test(s) || !FUND_WORDS.test(s) || !OPS_WORDS.test(s)) continue;
    if (/\b(if|assum(?:e|ing) (?:that )?(?:we|the company) (?:receive|complete|raise))\b/i.test(s) && /\b(proceeds|offering|milestone)\b/i.test(s)) continue;
    const h = horizon(s, filed);
    if (!h || h.until <= filed) continue;
    if (!h.floor) return { kind: "dated", say: h.say, until: h.until, text: clip(s) };
    if (!floor || h.until > floor.until) floor = { kind: "floor", say: h.say, until: h.until, text: clip(s) };
  }
  return floor;
}

/* ---- at-the-market sales ---- */

const ATM_WORDS = /\b(at[- ]the[- ]market|ATM|sales agreement|sale agreement|equity distribution agreement|controlled equity|open market sale)\b/i;
const SOLD = /\b(?:sold|issued and sold|issued)\s+(?:an aggregate of\s+|a total of\s+|approximately\s+)?([\d,]{4,}(?:\.\d+)?)\s*(million)?\s+(?:shares|ADSs|ordinary shares|American Depositary Shares)/i;
const PROCEEDS = /\b(net|gross|aggregate)\s+proceeds(?:,[^,]{0,60},)?\s+of\s+(?:approximately\s+)?\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?/i;
const NONE_SOLD = /\b(no shares (?:have been|had been|were) (?:sold|issued)|(?:have|had|has) not (?:yet )?sold any|did not sell any|not sold any shares)\b/i;
const PERIOD = /\b(?:during|for|in)\s+the\s+(three|six|nine|twelve)\s+months\s+ended\s+([A-Z][a-z]+ \d{1,2}, 20\d\d)|\b(?:during|for|in)\s+the\s+(?:fiscal\s+)?year\s+ended\s+([A-Z][a-z]+ \d{1,2}, 20\d\d)/i;

function atmUse(sents) {
  let best = null;
  for (const s of sents) {
    if (!ATM_WORDS.test(s)) continue;
    const sold = s.match(SOLD), pr = s.match(PROCEEDS);
    if (sold && pr) {
      const shares = parseFloat(sold[1].replace(/,/g, "")) * (sold[2] ? 1e6 : 1);
      const amt = dollars(pr[2], pr[3]);
      if (!(amt > 0.05 && amt < 5000) || !(shares > 1000)) continue;
      const per = s.match(PERIOD);
      const row = { used: true, amt: Math.round(amt * 10) / 10, shares: Math.round(shares), net: /net/i.test(pr[1]), months: per ? ({ three: 3, six: 6, nine: 9, twelve: 12 }[per[1]] || 12) : null, periodEnd: per ? per[2] || per[3] : null, text: clip(s) };
      // The most recent, shortest period is the most telling: "three months ended" beats "since inception".
      if (!best || !best.used || (row.months || 99) < (best.months || 99)) best = row;
    } else if (!best && NONE_SOLD.test(s)) {
      best = { used: false, text: clip(s) };
    }
  }
  return best;
}

/* ---- money that isn't a share sale ---- */

const MONEY = /\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)/i;
const OTHER = [
  ["royalty", /\b(royalty (?:purchase|financing|monetization|interest|sale)|sale of (?:a portion of )?(?:our |its |future )?royalt|synthetic royalty)/i, /\b(received|receive|upfront|proceeds|payment)\b/i],
  ["loan", /\b(term loan|loan (?:and security )?agreement|credit facility|loan facility|debt facility)\b/i, /\b(additional|remaining|up to|available)\b[^.]{0,120}\b(available|drawn|draw|tranche|borrow|at our option|upon (?:the )?achievement)\b/i],
  ["partner", /\b(collaboration|license|licensing|option)\s+(?:and license\s+)?agreement\b/i, /\b(eligible to receive|entitled to receive|will receive|upfront payment|milestone payments?)\b/i],
];

function otherMoney(sents) {
  const out = [];
  for (const [kind, a, b] of OTHER) {
    const hit = sents.find((s) => a.test(s) && b.test(s) && MONEY.test(s) && !/\b(we|the company) (?:will|are required to|is required to|agreed to) pay\b/i.test(s));
    if (!hit) continue;
    const m = hit.match(MONEY);
    out.push({ kind, amt: Math.round(dollars(m[1], m[2]) * 10) / 10, text: clip(hit) });
  }
  return out;
}

/* ---- FDA dates the company has announced ---- */

const DATE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s+(20\\d\\d)\\b`, "gi");
const FDA_EVENTS = [
  ["pdufa", /\b(PDUFA|Prescription Drug User Fee Act|target action date|goal date)\b/i, "FDA decision date"],
  ["adcom", /\b(advisory committee|AdCom)\b[^.]{0,80}\b(meeting|scheduled|convene|to be held)\b/i, "FDA advisory committee meeting"],
];

function fdaEvents(sents, today) {
  const out = [];
  for (const s of sents) {
    for (const [kind, re, label] of FDA_EVENTS) {
      const hit = s.match(re);
      if (!hit) continue;
      DATE.lastIndex = 0;
      let m, best = null;
      while ((m = DATE.exec(s))) {
        const date = iso(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]);
        const dist = Math.abs(m.index - hit.index);
        if (date > today && dist < 260 && (!best || dist < best.dist)) best = { date, dist };
      }
      if (best && !out.some((e) => e.kind === kind && e.date === best.date)) out.push({ kind, date: best.date, label, text: clip(s, 260) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 4);
}

export function readPeriodic(html, filed, today = new Date().toISOString().slice(0, 10)) {
  if (!html) return null;
  const sents = sentences(toText(html).replace(/&#x2019;|&#8217;|’/g, "'").replace(/&#160;|&nbsp;/g, " "));
  if (sents.length < 50) return null;
  return { v: PERIODIC_PARSER, runway: runwayGuidance(sents, filed), atm: atmUse(sents), other: otherMoney(sents), events: fdaEvents(sents, today) };
}
