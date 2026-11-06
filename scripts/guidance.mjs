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

// Readout or decision language: a future verb tied to the result itself, not
// to something done with results already in hand ("submit the results to a journal").
const READOUT = [
  /\b(report|announce|release|disclose|share|receive|obtain|have|expect|anticipate)\w*\b[^.;]{0,80}?\b(top-?line|initial|interim|preliminary|primary(?:[ -]endpoint)?|final|full|key|clinical|trial|study|phase \d\w*)?\s*(data|results?|read-?outs?)\b/i,
  /\b(top-?line|interim|preliminary|initial)\s+(data|results?|read-?outs?|analys[ie]s)\b[^.;]{0,80}?\b(expected|anticipated|planned|on track|scheduled)\b/i,
  /\b(data|results?)\b[^.;]{0,60}?\b(expected|anticipated|planned|on track|scheduled)\b/i,
  /\bread-?outs?\b/i,
  /\b(PDUFA|target action date|action date|approval decision|regulatory decision|FDA decision|FDA approval)\b/i,
];
// Things that mention data or results but aren't a market-moving readout.
const NOT_READOUT = /\b(journal|publication|publish|medical meetings?|scientific (?:meeting|conference)s?|congress|poster|initiate|commence|begin|start|enrol(?:l|ment|led|ling)|dose the first|IND|CTA|financial results|conference call|earnings)\b/i;
const STRONG = /\b(top-?line|PDUFA|action date|read-?out)\b/i;

// Sentences worth keeping from a filing: forward-looking catalyst talk with a date-like phrase.
// Cached per filing so the date logic below can change without re-downloading.
export function candidateSentences(text) {
  const out = [];
  for (const s of text.split(/(?<=[.;!?])\s+(?=[A-Z(])/)) {
    if (s.length < 30 || s.length > 600) continue;
    if (!EVENT.test(s) || !FUTURE.test(s)) continue;
    if (!/\b20\d\d\b|\b\d?[QH][1-4]?\s*'?\d\d\b|this year|next year|year-?end/i.test(s)) continue;
    if (NOT_CATALYST.test(s) && !STRONG.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 60) break;
  }
  return out;
}

// Of the periods named in a sentence, use the one that follows the readout words most
// closely ("report top-line data in the first half of 2017"), so other dates in the same
// sentence ("end enrollment in 2016") don't get used.
function closestPeriod(s, found) {
  const anchors = [];
  const re = /\b(top-?line|data|results?|read-?outs?|PDUFA|action date|approval|decision)\b/gi;
  let m;
  while ((m = re.exec(s))) anchors.push(m.index);
  if (!anchors.length) return found[0];
  let best = found[0], bestD = Infinity;
  for (const f of found) {
    const before = anchors.filter((a) => a < f.at).map((a) => f.at - a);
    const d = before.length ? Math.min(...before) : 1000 + Math.min(...anchors.map((a) => a - f.at));
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

export function eventsFromSentences(sentences, filed) {
  const maxDate = new Date(Date.parse(filed) + 3 * 365 * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (const raw of sentences) {
    const s = raw.replace(/&#x2019;|&#8217;/g, "'");
    if (!READOUT.some((r) => r.test(s))) continue;
    if (NOT_READOUT.test(s) && !STRONG.test(s)) continue;
    // Keep only periods that haven't ended and aren't too far out, then pick the one nearest the readout words.
    const found = [];
    for (const [re, fn] of PERIODS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        try {
          const p = fn(m);
          if (!p || p[1] <= filed || found.some((f) => f.p[0] === p[0] && f.p[1] === p[1])) continue;
          // A period already under way counts from the filing date to its end.
          const a = p[0] < filed ? filed : p[0];
          if (mid(a, p[1]) > maxDate) continue;
          found.push({ p: [a, p[1]], at: m.index });
        } catch { /* bad date */ }
      }
    }
    if (!found.length) { const r = relative(s, filed); if (r) found.push({ p: r, at: 0 }); }
    if (!found.length) continue;
    const { p } = closestPeriod(s, found);
    out.push({ date: mid(p[0], p[1]), kind: /PDUFA|action date|approval decision|regulatory decision|FDA decision|FDA approval/i.test(s) ? "regulatory" : "clinical", text: s.slice(0, 240) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function expectedEvents(text, filed) {
  return eventsFromSentences(candidateSentences(text), filed);
}
