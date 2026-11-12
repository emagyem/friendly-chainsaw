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
export const PERIODIC_PARSER = 2;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WORDNUM = { twelve: 12, eighteen: 18, "twenty-four": 24, "twenty four": 24, thirty: 30, "thirty-six": 36, "thirty six": 36, one: 1, two: 2, three: 3 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addMonths = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const clip = (s, n = 320) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const sentences = (text) => text.split(/(?<=[.;])\s+(?=[A-Z(])/).filter((s) => s.length > 40 && s.length < 900);
const dollars = (v, unit) => { const n = parseFloat(String(v).replace(/,/g, "")); return /billion/i.test(unit || "") ? n * 1000 : /million/i.test(unit || "") ? n : n / 1e6; };
const ORD = { first: 1, second: 2, third: 3, fourth: 4 };

/* ---- runway guidance ---- */

const CASH_WORDS = /\b(cash|capital resources|marketable securities|investments|funds|liquidity)\b/i;
const FUND_WORDS = /\b(sufficient|funds?|funding|enable us|support|finance|runway|liquidity)\b/i;
const OPS_WORDS = /\b(operat\w*|capital expenditures?|requirements|planned|runway|obligations|milestones)\b/i;
// "will not be sufficient to fund operations for the next twelve months": the same warning in other words.
const NOT_ENOUGH = /\b(not be sufficient|do(?:es)? not (?:currently )?have sufficient|(?:is|are) not sufficient|insufficient)\b/i;
const DOUBT = /\b(raises?d?|there is|exists?)\s+substantial doubt\s+(?:about|regarding|as to)\s+(?:the company's|our|its)\s+ability to continue as a going concern/i;
// A wrong going-concern flag would be a serious error, so anything hedged, negated or hypothetical is skipped.
const NOT_DOUBT = /\b(no|not|whether|evaluat\w*|alleviat\w*|mitigat\w*|if|could|may|might|would|unless|risk factors?|previously|prior year)\b/i;

// Turn "into the second half of 2028" into the first day that phrase covers.
function horizon(s, filed) {
  let m;
  if ((m = s.match(new RegExp(`\\b(?:through|until|into)\\s+(?:at least\\s+)?(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s+(20\\d\\d)`, "i")))) {
    return { until: iso(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]), say: `through at least ${m[1]} ${m[2]}, ${m[3]}` };
  }
  if ((m = s.match(/\bto\s+(early|mid|late)[-\s]+(20\d\d)\b/i))) {
    const part = m[1].toLowerCase();
    return { until: iso(m[2], part === "mid" ? 7 : part === "late" ? 10 : 1, 1), say: `to ${part} ${m[2]}` };
  }
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
  if ((m = s.match(/\b(?:at least|for|over|beyond|more than|through)\s+(?:a period of\s+)?(?:at least\s+)?(?:the\s+)?(?:next\s+)?(\d{2}|twelve|eighteen|twenty[- ]four|thirty|thirty[- ]six)\s+months\b/i))) {
    const n = WORDNUM[m[1].toLowerCase()] || parseInt(m[1], 10);
    if (n >= 12 && n <= 60) return { until: addMonths(filed, n), say: `at least the next ${n} months`, floor: true };
  }
  if ((m = s.match(/\b(?:at least|for|through)\s+(?:a period of\s+)?(?:at least\s+)?(?:the\s+)?(?:next\s+)?(one|two|three)[- ]years?\b/i))) return { until: addMonths(filed, WORDNUM[m[1].toLowerCase()] * 12), say: `at least ${m[1].toLowerCase()} year${m[1].toLowerCase() === "one" ? "" : "s"}`, floor: true };
  return null;
}

function runwayGuidance(sents, filed) {
  const doubt = sents.find((s) => DOUBT.test(s) && !NOT_DOUBT.test(s));
  if (doubt) return { kind: "doubt", say: "there is substantial doubt about its ability to keep operating", until: null, text: clip(doubt) };
  const short = sents.find((s) => CASH_WORDS.test(s) && NOT_ENOUGH.test(s) && OPS_WORDS.test(s) && /\b(twelve months|12 months|one[- ]year)\b/i.test(s) && !/\b(may|could|might|if we|whether)\b/i.test(s));
  if (short) return { kind: "doubt", say: "its cash won't cover the next 12 months without new funding", until: null, text: clip(short) };
  let floor = null;
  for (const s of sents) {
    if (!CASH_WORDS.test(s) || !FUND_WORDS.test(s) || !OPS_WORDS.test(s)) continue;
    if (/\b(not|unable|insufficient|no assurance|cannot)\b/i.test(s)) continue;
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
const NONE_SOLD = /\b(no shares (?:of common stock )?(?:have been|had been|were) (?:sold|issued)|(?:have|had|has) not (?:yet )?(?:sold|issued) any|did no\s?t (?:sell|issue) any|not sold any shares)\b/i;
const PERIOD = /\b(?:during|for|in)\s+the\s+(three|six|nine|twelve)\s+months\s+ended\s+([A-Z][a-z]+ \d{1,2}, 20\d\d)|\b(?:during|for|in)\s+the\s+(?:fiscal\s+)?year\s+ended\s+([A-Z][a-z]+ \d{1,2}, 20\d\d)/i;

function atmUse(sents) {
  let best = null;
  for (const s of sents) {
    if (!ATM_WORDS.test(s)) continue;
    const sold = s.match(SOLD), pr = s.match(PROCEEDS);
    if (NONE_SOLD.test(s)) { if (!best) best = { used: false, text: clip(s) }; continue; }
    if (sold && pr) {
      const shares = parseFloat(sold[1].replace(/,/g, "")) * (sold[2] ? 1e6 : 1);
      const amt = dollars(pr[2], pr[3]);
      if (!(amt > 0.05 && amt < 5000) || !(shares > 1000)) continue;
      const per = s.match(PERIOD);
      const row = { used: true, amt: Math.round(amt * 10) / 10, shares: Math.round(shares), net: /net/i.test(pr[1]), months: per ? ({ three: 3, six: 6, nine: 9, twelve: 12 }[per[1]] || 12) : null, periodEnd: per ? per[2] || per[3] : null, text: clip(s) };
      // The most recent, shortest period is the most telling: "three months ended" beats "since inception".
      if (!best || !best.used || (row.months || 99) < (best.months || 99)) best = row;
    }
  }
  return best;
}

/* ---- money that isn't a share sale ---- */

const AMT = "\\$\\s?([\\d,]+(?:\\.\\d+)?)\\s*(million|billion)";
const OTHER = [
  // Cash already received for selling a share of future royalties.
  ["royalty", new RegExp(`\\breceived\\s+(?:an? )?(?:upfront payment of\\s+|gross proceeds of\\s+|net proceeds of\\s+)?${AMT}[^.]{0,160}\\broyalt`, "i"), /interest expense/i],
  // Loan money the company can still draw.
  ["loan", new RegExp(`${AMT}[^.]{0,70}\\b(?:remains? available|available for draw|(?:that )?may be drawn|available to (?:be )?(?:drawn|borrow)|of additional (?:advances|term loans?|borrowings))`, "i"), /\b(repa(?:y|id)|terminat|expired|no longer available)\b/i],
  // Payments a partner may still owe the company.
  ["partner", new RegExp(`\\b(?:we|the company)\\s+(?:is|are|will be|may be|remains?|may become)\\s+(?:also\\s+)?(?:eligible|entitled)\\s+to\\s+receive\\b[^.]{0,140}?${AMT}`, "i"), /\b(tax|refund|reimburse)/i],
];

function otherMoney(sents) {
  const out = [];
  for (const [kind, want, skip] of OTHER) {
    for (const s of sents) {
      const m = s.match(want);
      if (!m || skip.test(s)) continue;
      const amt = Math.round(dollars(m[1], m[2]) * 10) / 10;
      if (!(amt >= 1)) continue;
      out.push({ kind, amt, text: clip(s) });
      break;
    }
  }
  return out;
}

/* ---- FDA dates the company has announced ---- */

const DATE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),\\s+(20\\d\\d)\\b`, "gi");
const FDA_EVENTS = [
  ["pdufa", /\b(PDUFA|Prescription Drug User Fee Act|target action date|goal date)\b/i, "FDA decision date"],
  ["adcom", /\b(advisory committee|AdCom)\b[^.]{0,80}\b(meeting|scheduled|convene|to be held)\b/i, "FDA advisory committee meeting"],
];

// A report also mentions rivals' FDA dates and the law's own renewal date. Only the company's own
// applications count: the sentence, or the one before it, must speak in the first person, and
// nothing nearby may read like a description of someone else.
const OWN = /\b(our|we|the Company's|the Company)\b/i;
const OWN_FILING = /\b(?:our|the Company's)\s+(?:\w+\s+){0,3}(?:BLA|NDA|sNDA|sBLA|MAA|application|submission|resubmission)\b|\bwe (?:re)?submitted\b/i;
const NOT_OWN = /\b(compet\w*|aware of|other companies|such as|being developed by|marketed by|expires?|reauthoriz\w*|announced that their|is pursuing|is developing|are developing)\b|\(PDUFA/i;
// "Capricor's BLA", "Sarepta submitted": someone else's application (case matters here).
const THEIR_FILING = /\b(?!The\b|Our\b|Company\b)[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?['’]s?\s+(?:BLA|NDA|sNDA|sBLA|MAA)\b|\b(?!We\b|The\b)[A-Z][a-z]+ (?:submitted|filed) (?:an? )?s?(?:BLA|NDA)/;
const OTHER_CO = /\b[A-Z][A-Za-z-]+(?:\s[A-Z][A-Za-z-]+)?\s(?:Therapeutics|Pharmaceuticals?|Pharma|Biosciences|Biotherapeutics|Biopharma|Sciences|Biotech|Inc\.?|Corp\.?|Ltd\.?|AG|plc)\b/g;

function fdaEvents(sents, today, ownName = "") {
  const out = [];
  const own = ownName.toLowerCase().split(/\s+/)[0] || "\u0000";
  sents.forEach((s, i) => {
    for (const [kind, re, label] of FDA_EVENTS) {
      const hit = s.match(re);
      if (!hit) continue;
      const before = `${sents[i - 4] || ""} ${sents[i - 3] || ""} ${sents[i - 2] || ""} ${sents[i - 1] || ""}`;
      if (!OWN.test(s) && !OWN_FILING.test(sents[i - 1] || "")) continue;
      if (NOT_OWN.test(s) || THEIR_FILING.test(s) || /\b(compet\w*|aware of|other companies|being developed by)\b/i.test(before)) continue;
      const others = (`${sents[i - 1] || ""} ${s}`.match(OTHER_CO) || []).filter((n) => !n.toLowerCase().startsWith(own));
      if (others.length) continue;
      DATE.lastIndex = 0;
      let m, best = null;
      while ((m = DATE.exec(s))) {
        const date = iso(m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]);
        const dist = Math.abs(m.index - hit.index);
        if (date > today && dist < 260 && (!best || dist < best.dist)) best = { date, dist };
      }
      if (best && !out.some((e) => e.kind === kind && e.date === best.date)) out.push({ kind, date: best.date, label, text: clip(s, 260) });
    }
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 3);
}

export function readPeriodic(html, filed, today = new Date().toISOString().slice(0, 10), ownName = "") {
  if (!html) return null;
  const sents = sentences(toText(html).replace(/&#x2019;|&#8217;|’/g, "'").replace(/&#160;|&nbsp;/g, " "));
  if (sents.length < 50) return null;
  return { v: PERIODIC_PARSER, runway: runwayGuidance(sents, filed), atm: atmUse(sents), other: otherMoney(sents), events: fdaEvents(sents, today, ownName) };
}
