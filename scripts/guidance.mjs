/* ------------------------------------------------------------------
   Company guidance on upcoming catalysts, read from a 10-Q or 10-K.

   Biotechs say when they expect news: "we expect to report topline data
   in the second half of 2019", "PDUFA target action date of March 15,
   2020". Because each statement sits in a dated SEC filing, it shows
   exactly what investors were told at the time — the point-in-time
   catalyst date the backtest needs.

   expectedEvents(text, filedIso) returns the dated events mentioned,
   each with the date it implies (midpoint of the period named) and the
   sentence it came from. Only dates after the filing date and within
   three years count.
------------------------------------------------------------------- */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = MONTHS.map((m) => m.slice(0, 3));

// What makes a sentence about a catalyst, and what makes it forward-looking.
const EVENT = /\b(top-?line|data|results|read-?outs?|interim analys[ie]s|PDUFA|action date|approval decision|regulatory decision|FDA decision)\b/i;
const FUTURE = /\b(expects?|expected|anticipates?|anticipated|plans? to|on track|guid(?:e|ance)|projected|scheduled|target(?:ed|ing)?)\b/i;
const NOT_CATALYST = /\b(cash|runway|fund (?:our|its) operations|sufficient to|net loss|revenue|expenses?|financial results|earnings|conference call|lease|tax|interest rate)\b/i;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const yr = (s) => { const n = Number(s); return n < 100 ? 2000 + n : n; };

// Each pattern returns [start, end] of the period it names, as ISO dates.
const PERIODS = [
  // "March 15, 2020"
  [new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(20\\d\\d)\\b`, "gi"), (m) => { const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; const d = iso(m[3], mo, Number(m[2])); return [d, d]; }],
  // "first half of 2019", "second half of 2019", "1H 2019", "H2 2019", "2H19"
  [/\b(first|second|1st|2nd)\s+half\s+(?:of\s+)?(?:calendar\s+|fiscal\s+)?(?:year\s+)?(20\d\d)\b/gi, (m) => (/^(first|1st)$/i.test(m[1]) ? [iso(m[2], 1, 1), iso(m[2], 6, 30)] : [iso(m[2], 7, 1), iso(m[2], 12, 31)])],
  [/\b(?:([12])H|H([12]))\s*'?((?:20)?\d\d)\b/g, (m) => { const h = m[1] || m[2]; const y = yr(m[3]); return h === "1" ? [iso(y, 1, 1), iso(y, 6, 30)] : [iso(y, 7, 1), iso(y, 12, 31)]; }],
  // "third quarter of 2019", "Q3 2019", "3Q19", "fourth calendar quarter of 2019"
  [/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:calendar\s+|fiscal\s+)?quarter\s+(?:of\s+)?(?:calendar\s+|fiscal\s+)?(?:year\s+)?(20\d\d)\b/gi, (m) => { const q = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 }[m[1].toLowerCase()]; return [iso(m[2], q * 3 - 2, 1), iso(m[2], q * 3, q === 1 || q === 4 ? 31 : 30)]; }],
  [/\b(?:Q([1-4])|([1-4])Q)\s*'?((?:20)?\d\d)\b/g, (m) => { const q = Number(m[1] || m[2]); const y = yr(m[3]); return [iso(y, q * 3 - 2, 1), iso(y, q * 3, q === 1 || q === 4 ? 31 : 30)]; }],
  // "early 2019", "mid-2019", "late 2019", "end of 2019", "year-end 2019"
  [/\b(early|mid|middle of|late|end of|year-?end|the end of)[\s-]+(20\d\d)\b/gi, (m) => { const w = m[1].toLowerCase(); const y = m[2]; return /early/.test(w) ? [iso(y, 1, 1), iso(y, 4, 30)] : /mid|middle/.test(w) ? [iso(y, 5, 1), iso(y, 8, 31)] : /late/.test(w) ? [iso(y, 9, 1), iso(y, 12, 31)] : [iso(y, 10, 1), iso(y, 12, 31)]; }],
  // "June 2019"
  [new RegExp(`\\b(${MONTHS.join("|")})\\s+(20\\d\\d)\\b`, "gi"), (m) => { const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; return [iso(m[2], mo, 1), iso(m[2], mo, 28)]; }],
  // "in 2019", "during 2019", "by 2019"
  [/\b(?:in|during|by|within)\s+(?:calendar\s+|fiscal\s+)?(?:year\s+)?(20\d\d)\b/gi, (m) => [iso(m[1], 1, 1), iso(m[1], 12, 31)]],
];

// Relative phrases, resolved against the filing date.
function relative(sentence, filed) {
  const y = Number(filed.slice(0, 4));
  if (/\b(by|before|at|around) (the )?(end of (this|the) year|year-?end)\b|\blater this year\b|\bby the end of 20\d\d\b/i.test(sentence)) {
    const m = Number(filed.slice(5, 7));
    return m >= 11 ? null : [filed, iso(y, 12, 31)];
  }
  if (/\b(next|the following) year\b/i.test(sentence)) return [iso(y + 1, 1, 1), iso(y + 1, 12, 31)];
  return null;
}

const mid = (a, b) => new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString().slice(0, 10);

export function toText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/gi, "&").replace(/&#8217;|&rsquo;/gi, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"').replace(/&#\d+;|&\w+;/g, " ")
    .replace(/\s+/g, " ");
}

export function expectedEvents(text, filed) {
  const maxDate = new Date(Date.parse(filed) + 3 * 365 * 86400000).toISOString().slice(0, 10);
  const out = [];
  const sentences = text.split(/(?<=[.;!?])\s+(?=[A-Z(])/);
  for (const s of sentences) {
    if (s.length < 30 || s.length > 600) continue;
    if (!EVENT.test(s) || !FUTURE.test(s)) continue;
    // Skip sentences about cash runway or financial reporting, which name dates for other reasons.
    if (NOT_CATALYST.test(s) && !/\b(top-?line|PDUFA|read-?out)\b/i.test(s)) continue;
    const found = [];
    for (const [re, fn] of PERIODS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        try { const p = fn(m); if (p && !found.some((f) => f[0] === p[0] && f[1] === p[1])) found.push(p); } catch { /* bad date */ }
      }
    }
    if (!found.length) { const r = relative(s, filed); if (r) found.push(r); }
    for (const [a, b] of found) {
      const d = mid(a, b);
      if (b <= filed || d > maxDate) continue; // the period has already ended, or it's too far out
      out.push({ date: d < filed ? filed : d, kind: /PDUFA|action date|approval decision|regulatory decision|FDA decision/i.test(s) ? "regulatory" : "clinical", text: s.slice(0, 240) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
