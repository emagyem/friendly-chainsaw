/* ------------------------------------------------------------------
   Helixora Cyber Risk: what companies tell the SEC about cybersecurity,
   plus what anyone can see of their public web and email setup.

   For each company on the site (coverage and drug industry):
   1. Incidents: 8-K Item 1.05 filings ("material cybersecurity incident",
      required since 18 Dec 2023), and voluntary 8-K Item 8.01 cyber
      disclosures.
   2. Governance: the cybersecurity section every annual report must now
      carry (10-K Item 1C; 20-F Item 16K), scored against a checklist,
      with the sentence that earned each point.
   3. Public setup, checked passively: email-spoofing protection (SPF,
      DMARC), certificate rules (CAA), HTTPS and its settings, common
      browser security headers, and whether the company publishes a way to
      report security problems (security.txt). This is what a browser or
      mail server sees on a normal visit: a few DNS lookups and two or
      three ordinary page requests per company, identified by user agent.
      Nothing is scanned, probed or logged into.

   Plus a study: how share prices moved after every 8-K Item 1.05 filed
   by a US-listed company, against the S&P 500.

   Writes public/data/cyber.json. Run weekly by .github/workflows/cyber.yml.
------------------------------------------------------------------- */

import { readFile, writeFile } from "node:fs/promises";
import dns from "node:dns/promises";
import tls from "node:tls";
import { sec, secText } from "./fetch-data.mjs";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("public/data/cyber.json", ROOT);
const TODAY = new Date().toISOString().slice(0, 10);
const RULE_START = "2023-12-18";
const WEB_UA = "HelixoraCyberCheck/1.0 (+https://helixora.pages.dev/#about; passive public checks)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warnings = [];
const warn = (m) => { warnings.push(m); console.warn("!", m); };

/* ------------------------------ helpers ------------------------------ */

const plain = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ")
  .replace(/<\/(p|div|tr|li|h\d|br)>/gi, ". ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/gi, "&").replace(/&#8217;|&rsquo;|&#x2019;/gi, "'")
  .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&#x201[cd];/gi, '"').replace(/&#8212;|&#x2014;|&mdash;/gi, "—").replace(/&#\w+;|&\w+;/g, " ")
  .replace(/\s+/g, " ").replace(/(\. ){2,}/g, ". ");
const sentences = (t) => t.split(/(?<=[.;!?])\s+(?=[A-Z(“"])/).map((s) => s.trim()).filter((s) => s.length > 25 && s.length < 700);
const docUrl = (cik, adsh, doc) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${doc}`;

async function web(url, opts = {}) {
  await sleep(300);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(url, { redirect: opts.redirect || "follow", signal: ctl.signal, headers: { "User-Agent": WEB_UA, Accept: opts.accept || "text/html,*/*" } });
    clearTimeout(t);
    const body = opts.body ? (await r.text()).slice(0, 20000) : null;
    if (!opts.body) r.body?.cancel?.();
    return { status: r.status, url: r.url, headers: r.headers, body };
  } catch (e) { return { error: String(e.cause?.code || e.message || e) }; }
}

/* ----------------------------- incidents ----------------------------- */

// 8-K filings with Item 1.05, read from the company's filing list.
function item105(sub, cik) {
  const r = sub?.filings?.recent;
  if (!r?.form) return [];
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    if (!/^8-K/.test(r.form[i]) || r.filingDate[i] < RULE_START) continue;
    if (!String(r.items?.[i] || "").split(",").includes("1.05")) continue;
    out.push({ date: r.filingDate[i], form: r.form[i], item: "1.05", amended: r.form[i] === "8-K/A", url: docUrl(cik, r.accessionNumber[i], r.primaryDocument[i]) });
  }
  return out;
}

// Voluntary disclosures (Item 8.01 or 7.01): an 8-K whose main document says the company found an incident.
const FOUND = /\b(detected|identified|discovered|became aware of|experienced|is investigating|responding to)\b[^.]{0,160}\b(cybersecurity incident|cyber[- ]?attack|ransomware|unauthori[sz]ed (?:access|third party|actor)|threat actor|security incident)\b/i;
async function voluntary(cik) {
  const q = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"cybersecurity incident"')}&forms=8-K&dateRange=custom&startdt=${RULE_START}&enddt=${TODAY}&ciks=${String(cik).padStart(10, "0")}`;
  const r = await sec(q);
  const out = [];
  for (const h of r?.hits?.hits || []) {
    const s = h._source;
    if ((s.items || []).includes("1.05")) continue; // counted above
    const [adsh, file] = String(h._id).split(":");
    if (!file || /ex-?99|ex99/i.test(file) && !(s.items || []).some((x) => x === "8.01" || x === "7.01")) continue;
    const text = await secText(docUrl(cik, adsh, file));
    // The company saying it found one, not risk-warning wording ("we may experience…", "any cybersecurity incident…").
    const hit = text && sentences(plain(text)).find((x) => FOUND.test(x) && /\b(we|the Company|our)\b/i.test(x) && !/\b(may|could|might|would|if|any|potential|risks?|no assurance|forward-looking)\b/i.test(x));
    if (hit) out.push({ date: s.file_date, form: s.form, item: (s.items || []).filter((x) => x !== "9.01").join(", ") || "8.01", amended: false, url: docUrl(cik, adsh, file), text: hit.slice(0, 300) });
  }
  // One per filing date.
  return [...new Map(out.map((x) => [x.date, x])).values()];
}

/* ----------------------------- governance ---------------------------- */

// The annual report's cybersecurity section: 10-K Item 1C, 20-F Item 16K.
// Inline markup sometimes splits a word in two ("Cybe rsecurity"); match headings letter by letter, allowing a stray space.
const loose = (word) => word.split("").map((ch) => (/[a-z]/i.test(ch) ? ch : `\\${ch}`)).join("\\s?");
const CYBER_W = loose("cybersecurity");
function cyberSection(text, form) {
  const sep = "\\.?\\s*[—:\\-–.]?\\s*";
  const start = new RegExp(form === "20-F" ? `item\\s*16\\s*\\.?\\s*k${sep}${CYBER_W}` : `item\\s*1\\s*\\.?\\s*c${sep}${CYBER_W}`, "gi");
  const stop = form === "20-F" ? /item\s*17\b|part\s*iii\b/i : new RegExp(`item\\s*2${sep}${loose("propert")}`, "i");
  let best = "";
  for (const m of text.matchAll(start)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40000);
    const end = rest.search(stop);
    const body = (end > 0 ? rest.slice(0, end) : rest.slice(0, 12000)).trim();
    if (body.length > best.length) best = body; // the table of contents entry is short; the real section is long
  }
  if (best.length > 300) return best;
  // Some filings drop the heading in the body (Sarepta's 2025 10-K): take what sits between Item 1B and Item 2.
  if (form !== "20-F") {
    const twos = [...text.matchAll(new RegExp(`item\\s*2${sep}${loose("propert")}`, "gi"))];
    for (const m2 of twos.reverse()) {
      const before = text.slice(Math.max(0, m2.index - 40000), m2.index);
      const b = [...before.matchAll(new RegExp(`item\\s*1\\s*\\.?\\s*b${sep}${loose("unresolved")}`, "gi"))].at(-1);
      if (!b) continue;
      const body = before.slice(b.index + b[0].length).replace(/^[^.]{0,40}comments[\s.]*/i, "").replace(/^[\s.]*(none|not applicable)\.?/i, "").trim();
      if (body.length > 300 && /cyber/i.test(body)) return body;
    }
  }
  // Annual reports laid out in the company's own format (GSK's 20-F): a "Cyber security" heading followed by
  // "Risk management and strategy". Take the next stretch of text.
  for (const m of text.matchAll(new RegExp(`(?:${CYBER_W}|cyber\\s+security)\\s*\\.?\\s*(?:${loose("risk management and strategy")}|${loose("risk management")})`, "gi"))) {
    const rest = text.slice(m.index, m.index + 12000);
    const end = rest.slice(500).search(/\bitem\s*\d{1,2}\s*\.?\s*[a-z]?\b\s*\.?\s*[A-Z]|\bpart\s+i{1,3}v?\b/i);
    const body = end > 0 ? rest.slice(0, 500 + end) : rest;
    if (body.length > 300 && /board|committee/i.test(body)) return body;
  }
  return null;
}

// Each check: what a reader of the section would look for. Points add to 100.
const ROLE = /\b(Chief Information Security Officer|CISO|Chief Security Officer|(?:Vice President|Head|Director|Senior Director|Manager|Lead)\b[ ,]+(?:of |for )?(?:\w+ ){0,2}(?:Information|Cyber|IT)[- ]?security)\b/i;
const CHECKS = [
  ["leader", 15, "Names a security leader (a general IT head earns 8 of 15)", ROLE],
  ["experience", 5, "Describes that person's experience or credentials", /\b(\d+|[a-z]+-?[a-z]*)\+? years\b[^.]{0,60}\b(experience|in the (?:\w+ ){0,3}(?:field|industry)|in (?:information )?(?:technology|security|cybersecurity))|\b(?:over|more than|nearly|approximately|about)\s+(?:\d+|[a-z]+)\s+years\b|\b(significant|extensive|deep|substantial|broad)\b[^.]{0,30}\bexperience\b|\b(CISSP|CISM|CISA|CRISC|CEH|GIAC)\b/i],
  ["board", 15, "A board committee or the board oversees cyber risk", /\b(Board|Committee)\b[^.]{0,160}\b(oversight|oversee|oversees|responsib\w*|monitor\w*|receives? (?:\w+ ){0,3}(?:reports?|updates?|briefings?))\b|\b(oversight|oversee|reports?|updates?|briefs?)\b[^.]{0,120}\b(Board of Directors|Audit Committee|Risk Committee|the Board)\b/i],
  ["cadence", 10, "Says how often the board is briefed", /\b(quarterly|at least (?:annually|twice|semi-annually|once a year|once per year|yearly)|annually|each (?:regular(?:ly scheduled)? )?(?:board |committee )?meeting|semi-annual(?:ly)?|monthly|twice a year|every (?:quarter|year))\b[^.]{0,120}\b(report|update|brief|present|review|meet)|\b(report|update|brief|present|review|meet)\w*\b[^.]{0,120}\b(quarterly|at least (?:annually|twice|semi-annually)|annually|semi-annual(?:ly)?|twice a year|every quarter|each (?:regular(?:ly scheduled)? )?(?:board |committee )?meeting)/i],
  ["outside", 10, "Uses outside assessors or testers", /\b(third[- ]party|third parties|external|independent|outside)\b[^.]{0,80}\b(assessor|consultant|auditor|penetration|assessment|advisor|expert|firm|audit|vendor|partner|specialist)s?\b/i],
  ["testing", 5, "Tests defences (penetration tests, simulations, tabletop exercises)", /penetration test|tabletop|red[- ]team|vulnerability (?:scan|assessment|test)|(?:threat|breach|incident|attack|phishing)[- ](?:response )?simulation|simulat\w+ (?:of )?(?:cyber|attack|incident|phishing)/i],
  ["irp", 10, "Has an incident response plan or process", /incident response|response plans?\b|incident (?:management|handling|escalation) (?:plan|process|policy|procedures?)|escalation (?:path|process|procedures?)\b[^.]{0,80}\bincident/i],
  ["framework", 10, "Follows a recognised framework (NIST, ISO 27001, CIS, SOC 2)", /\bNIST\b|National Institute of Standards and Technology|ISO(?:\/IEC)?\s?2700[12]|\bCIS (?:Controls|Critical)|Center for Internet Security|\bSOC ?2\b|\bHITRUST\b|\bCOBIT\b/i],
  ["vendors", 10, "Manages third-party and vendor risk", /(vendors?|suppliers?|service providers?|third[- ]party providers?|business partners)\b[^.]{0,100}\b(risk|assess|due diligence|oversight|review|monitor|evaluat|audit|contract)|\b(risk|assess|due diligence|oversight|review|monitor|evaluat|consider)\w*\b[^.]{0,100}\b(vendors?|suppliers?|service providers?|third[- ]party providers?)\b/i],
  ["training", 5, "Trains staff (security awareness, phishing tests)", /\b(security awareness|phishing (?:simulation|test|exercise|campaign)s?|(?:cyber|security|data protection)[\w ,-]{0,60}training|train(?:s|ing)? (?:our |all )?(?:employees|personnel|staff|workforce)|(?:employees?|personnel|staff|workforce)\b[^.]{0,60}\btraining|education and training)\b/i],
  ["insurance", 5, "Carries cyber insurance", /cyber(?:security)?[- ](?:liability |risk )?insurance|insurance[^.]{0,60}\bcyber/i],
];
const NO_STAFF = /\b(do not|does not|don't)\b[^.]{0,30}\b(have|employ|maintain)\b[^.]{0,40}\b(dedicated|full-time|internal|in-house)\b[^.]{0,40}\b(security|cybersecurity|IT|information technology)\b/i;
const NO_MATERIAL = /\b(have not|has not|did not|are not aware of)\b[^.]{0,80}\b(identified|experienced|encountered|been materially affected|any)\b[^.]{0,120}\b(material|cybersecurity (?:threats|incidents))\b/i;

function scoreGovernance(section) {
  const ss = sentences(section);
  const IT_HEAD = /\b(Chief Information Officer|CIO|Chief Technology Officer|Chief Digital Officer|Chief Information and Digital Officer|(?:Vice President|Head|Director|Senior Director|Manager)\b[^.]{0,25}\b(?:of )?(?:Information Technology|IT|Technology Services)\b)/;
  const items = CHECKS.map(([key, pts, label, re]) => {
    let s = ss.find((x) => re.test(x));
    let got = s ? pts : 0;
    if (!s && key === "leader") { s = ss.find((x) => IT_HEAD.test(x)); got = s ? 8 : 0; }
    return { key, label, pts, got, met: got > 0, evidence: s ? s.slice(0, 280) : null };
  });
  let score = items.reduce((a, x) => a + x.got, 0);
  const noStaff = ss.find((x) => NO_STAFF.test(x));
  if (noStaff) score = Math.max(0, score - 10);
  return {
    score, items,
    noStaff: noStaff ? noStaff.slice(0, 280) : null,
    saysNoMaterial: (ss.find((x) => NO_MATERIAL.test(x)) || "").slice(0, 280) || null,
    words: section.split(/\s+/).length,
  };
}

// The company's own website domain, read from its annual report ("our website, www.example.com").
const NOT_OWN = /(^|\.)(sec\.gov|clinicaltrials\.gov|fda\.gov|nih\.gov|cms\.gov|ftc\.gov|europa\.eu|who\.int|ema\.europa\.eu|cdc\.gov|nasdaq\.com|nyse\.com|xbrl\.org|ifrs\.org|fasb\.org|pcaob\.?us|irs\.gov|gov\.uk|go\.jp|linkedin\.com|twitter\.com|x\.com|facebook\.com|youtube\.com|instagram\.com|adobe\.com|w3\.org|lseg\.com|globenewswire\.com|businesswire\.com|prnewswire\.com|nasdaqomx\.com|gcs-web\.com|q4cdn\.com|q4ir\.com|q4web\.com|investorroom\.com|equisolve\.net|notified\.com|edgar-online\.com|tsx\.com|sedarplus\.ca)$/i;
function domainFrom(text, name) {
  const counts = new Map();
  for (const m of text.matchAll(/\b(?:https?:\/\/)?(?:www\.|investors?\.|ir\.)?([a-z0-9][a-z0-9-]{1,40}\.(?:com|net|org|io|co|bio|us|ch|dk|fr|co\.uk|com\.au|ca|ie|nl|be|se|de|eu|jp|in|ai|health|tx|pharma|global|life))\b/gi)) {
    const d = m[1].toLowerCase();
    if (NOT_OWN.test(d)) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const key = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Prefer a domain that looks like the company's name; otherwise the most mentioned one.
  return (ranked.find(([d]) => key && d.replace(/[^a-z0-9]/g, "").includes(key)) || ranked[0] || [null])[0];
}

/* ------------------------- public setup checks ------------------------ */

async function txt(name) { try { return (await dns.resolveTxt(name)).map((r) => r.join("")); } catch { return []; } }

async function emailChecks(domain) {
  const [mx, root, dmarcTxt, caa] = await Promise.all([
    dns.resolveMx(domain).catch(() => []), txt(domain), txt(`_dmarc.${domain}`), dns.resolveCaa(domain).catch(() => []),
  ]);
  const spf = root.find((r) => /^v=spf1/i.test(r)) || null;
  const dmarc = dmarcTxt.find((r) => /^v=DMARC1/i.test(r)) || null;
  return {
    mx: mx.length > 0,
    // "redirect=" hands the rules to another domain's record; give it the benefit of the doubt as "soft".
    spf: spf ? (/-all\b/.test(spf) ? "strict" : /~all\b|redirect=/.test(spf) ? "soft" : "weak") : "missing",
    dmarc: dmarc ? ((dmarc.match(/\bp=(\w+)/i)?.[1] || "none").toLowerCase()) : "missing",
    dmarcPct: dmarc ? Number(dmarc.match(/\bpct=(\d+)/i)?.[1] || 100) : null,
    caa: caa.length > 0,
  };
}

function tlsInfo(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = sock.getPeerCertificate();
      const out = { protocol: sock.getProtocol(), validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString().slice(0, 10) : null, issuer: cert?.issuer?.O || null, authorized: sock.authorized };
      sock.end();
      resolve(out);
    });
    sock.on("error", (e) => resolve({ error: e.code || e.message }));
    sock.on("timeout", () => { sock.destroy(); resolve({ error: "timeout" }); });
  });
}

async function webChecks(domain) {
  const plainHttp = await web(`http://${domain}/`, { redirect: "manual" });
  const toHttps = plainHttp.status >= 300 && plainHttp.status < 400 && /^https:/i.test(plainHttp.headers?.get("location") || "");
  const page = await web(`https://${domain}/`);
  if (page.error) {
    const www = await web(`https://www.${domain}/`);
    if (www.error) return { reachable: false, error: page.error };
    Object.assign(page, www);
  }
  const host = new URL(page.url).hostname;
  const h = (k) => page.headers.get(k);
  const hsts = h("strict-transport-security");
  const csp = h("content-security-policy");
  const t = await tlsInfo(host);
  let securityTxt = false;
  for (const base of [...new Set([`https://${host}`, `https://${domain}`])]) {
    const r = await web(`${base}/.well-known/security.txt`, { body: true, accept: "text/plain" });
    if (r.status === 200 && /^\s*Contact:/im.test(r.body || "") && !/<html/i.test(r.body || "")) { securityTxt = true; break; }
  }
  return {
    reachable: true, host, status: page.status, httpToHttps: toHttps,
    hsts: hsts ? Number(hsts.match(/max-age=(\d+)/i)?.[1] || 0) : 0,
    csp: !!csp, frame: !!h("x-frame-options") || /frame-ancestors/i.test(csp || ""), nosniff: /nosniff/i.test(h("x-content-type-options") || ""),
    referrer: !!h("referrer-policy"), server: (h("server") || "").slice(0, 40) || null,
    tls: t.protocol || null, certExpires: t.validTo || null, certIssuer: t.issuer || null, certOk: t.authorized ?? null,
    securityTxt,
  };
}

// Points for the public setup, out of 100, each with a plain-language label.
function scoreSetup(email, w) {
  const days = w?.certExpires ? Math.round((Date.parse(w.certExpires) - Date.parse(TODAY)) / 86400000) : null;
  const items = [
    ["dmarc", 15, "Blocks email spoofing of its domain (DMARC)", email.dmarc === "reject" ? 15 : email.dmarc === "quarantine" ? 10 : email.dmarc === "none" ? 3 : 0, `policy: ${email.dmarc}`],
    ["spf", 10, "Lists which servers may send its email (SPF)", email.spf === "strict" ? 10 : email.spf === "soft" ? 8 : email.spf === "weak" ? 3 : 0, email.spf],
    ["caa", 5, "Limits who can issue its web certificates (CAA)", email.caa ? 5 : 0, email.caa ? "set" : "not set"],
    ["https", 10, "Sends visitors to the secure (HTTPS) site", w?.httpToHttps ? 10 : 0, w?.httpToHttps ? "yes" : "no"],
    ["hsts", 10, "Tells browsers to always use HTTPS (HSTS)", w?.hsts >= 15552000 ? 10 : w?.hsts > 0 ? 5 : 0, w?.hsts ? `${Math.round(w.hsts / 86400)} days` : "not set"],
    ["tls", 10, "Uses current encryption (TLS 1.3 or 1.2)", w?.tls === "TLSv1.3" ? 10 : w?.tls === "TLSv1.2" ? 7 : 0, w?.tls || "unknown"],
    ["cert", 5, "Has a valid certificate that isn't about to expire", w?.certOk && days > 14 ? 5 : 0, days != null ? `expires in ${days} days` : "unknown"],
    ["csp", 10, "Restricts what code its pages can load (CSP)", w?.csp ? 10 : 0, w?.csp ? "set" : "not set"],
    ["frame", 5, "Stops other sites framing its pages", w?.frame ? 5 : 0, w?.frame ? "set" : "not set"],
    ["nosniff", 5, "Stops browsers guessing file types", w?.nosniff ? 5 : 0, w?.nosniff ? "set" : "not set"],
    ["referrer", 5, "Limits what it leaks to other sites (Referrer-Policy)", w?.referrer ? 5 : 0, w?.referrer ? "set" : "not set"],
    ["securitytxt", 10, "Publishes how to report a security problem (security.txt)", w?.securityTxt ? 10 : 0, w?.securityTxt ? "published" : "not found"],
  ].map(([key, pts, label, got, detail]) => ({ key, label, pts, got, detail }));
  return { score: items.reduce((a, x) => a + x.got, 0), items };
}

/* ------------------------------ grading ------------------------------ */

// Overall: half governance, half public setup, less 10 points per material incident in the last two years (max 20).
function grade(gov, setup, incidents) {
  if (gov == null && setup == null) return { overall: null, grade: null };
  const parts = [gov, setup].filter((x) => x != null);
  const base = parts.reduce((a, b) => a + b, 0) / parts.length;
  const recent = incidents.filter((x) => x.item === "1.05" && !x.amended && x.date >= new Date(Date.parse(TODAY) - 730 * 86400000).toISOString().slice(0, 10)).length;
  const overall = Math.max(0, Math.round(base - Math.min(20, recent * 10)));
  return { overall, grade: overall >= 80 ? "A" : overall >= 65 ? "B" : overall >= 50 ? "C" : overall >= 35 ? "D" : "F", incidentPenalty: Math.min(20, recent * 10) };
}

/* --------------------------- incident study --------------------------- */

async function chart(ticker, from, to) {
  await sleep(250);
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${Math.floor(Date.parse(from) / 1000)}&period2=${Math.floor(Date.parse(to) / 1000)}&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0 (Helixora research)" } });
    const j = r.ok ? await r.json() : null;
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp || [], c = res?.indicators?.adjclose?.[0]?.adjclose || res?.indicators?.quote?.[0]?.close || [];
    return ts.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), c[i]]).filter(([, v]) => v != null);
  } catch { return []; }
}

// Every 8-K Item 1.05 filed by a listed company since the rule began.
async function allIncidents() {
  const seen = new Map();
  for (let from = 0; from < 3000; from += 100) {
    const r = await sec(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"Item 1.05"')}&forms=8-K&dateRange=custom&startdt=${RULE_START}&enddt=${TODAY}&from=${from}`);
    const hits = r?.hits?.hits || [];
    for (const h of hits) {
      const s = h._source;
      if (!(s.items || []).includes("1.05") || s.form !== "8-K") continue;
      const ticker = (s.display_names || []).map((n) => n.match(/\(([A-Z.-]{1,6})(?:,|\))/)?.[1]).find(Boolean);
      const name = (s.display_names?.[0] || "").replace(/\s*\(.*$/, "").trim();
      const key = `${s.ciks?.[0]}|${s.file_date}`;
      if (!seen.has(key)) seen.set(key, { cik: Number(s.ciks?.[0]), name, ticker: ticker || null, date: s.file_date, url: docUrl(s.ciks?.[0], String(h._id).split(":")[0], String(h._id).split(":")[1] || "") });
    }
    if (hits.length < 100) break;
  }
  // A company's first Item 1.05 filing about an incident is the news; later ones within 120 days are updates.
  const byCo = new Map();
  for (const e of [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const last = byCo.get(e.cik);
    if (last && Date.parse(e.date) - Date.parse(last) < 120 * 86400000) { e.update = true; } else byCo.set(e.cik, e.date);
  }
  return [...seen.values()];
}

async function eventStudy(events) {
  const firsts = events.filter((e) => !e.update && e.ticker);
  const spy = await chart("SPY", "2023-11-01", TODAY);
  const spyAt = new Map(spy);
  const rows = [];
  for (const e of firsts) {
    const px = await chart(e.ticker, new Date(Date.parse(e.date) - 20 * 86400000).toISOString().slice(0, 10), new Date(Date.parse(e.date) + 50 * 86400000).toISOString().slice(0, 10));
    if (px.length < 10) continue;
    // Day 0: the first trading day on or after the filing date (8-Ks are often filed after the close).
    const i0 = px.findIndex(([d]) => d >= e.date);
    if (i0 < 1) continue;
    const base = px[i0 - 1];
    const ret = (k) => {
      const p = px[i0 + k];
      if (!p || !spyAt.get(base[0]) || !spyAt.get(p[0])) return null;
      return Math.round(((p[1] / base[1]) - (spyAt.get(p[0]) / spyAt.get(base[0]))) * 1000) / 10; // % vs S&P 500
    };
    rows.push({ ...e, d1: ret(0), d5: ret(4), d30: ret(20) });
  }
  const stat = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    return { n: v.length, mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10, median: v[Math.floor(v.length / 2)], shareDown: Math.round(v.filter((x) => x < 0).length / v.length * 100) };
  };
  return { events: rows.sort((a, b) => (a.date < b.date ? 1 : -1)), day1: stat("d1"), day5: stat("d5"), day30: stat("d30"), allFilings: events.length, firstFilings: firsts.length };
}

/* -------------------------------- main -------------------------------- */

async function main() {
  const data = JSON.parse(await readFile(new URL("public/data/companies.json", ROOT), "utf8"));
  const overrides = JSON.parse(await readFile(new URL("config/cyber-domains.json", ROOT), "utf8").catch(() => "{}"));
  // CYBER_ONLY=AAA,BBB limits a test run to those tickers.
  const only = (process.env.CYBER_ONLY || "").split(",").filter(Boolean);
  const companies = [...(data.companies || []), ...(data.industry || [])].filter((c) => !only.length || only.includes(c.t));
  const tk = await sec("https://www.sec.gov/files/company_tickers.json");
  const cikBy = new Map(Object.values(tk || {}).map((r) => [r.ticker.toUpperCase(), r.cik_str]));
  const out = {};
  for (const c of companies) {
    const cik = cikBy.get(c.t) || c.src?.cik;
    console.log(`${c.t}…`);
    try {
      const sub = await sec(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`);
      const incidents = [...item105(sub, cik), ...(await voluntary(cik))].sort((a, b) => (a.date < b.date ? 1 : -1));
      // Latest annual report.
      const r = sub.filings.recent;
      // The original annual report (an amendment often carries only Part III, without the cyber section).
      const i = r.form.findIndex((f) => f === "10-K" || f === "20-F");
      let gov = null, domain = overrides[c.t] || null, annual = null;
      if (i >= 0) {
        annual = { form: r.form[i], date: r.filingDate[i], url: docUrl(cik, r.accessionNumber[i], r.primaryDocument[i]) };
        const html = await secText(annual.url);
        if (html) {
          const text = plain(html);
          const section = cyberSection(text, r.form[i]);
          gov = section ? scoreGovernance(section) : null;
          if (!domain) domain = domainFrom(text, c.n);
        }
      }
      if (!domain && sub.website) domain = String(sub.website).replace(/^https?:\/\/(www\.)?/i, "").replace(/\/.*$/, "");
      let email = null, w = null, setup = null;
      if (domain) {
        email = await emailChecks(domain);
        w = await webChecks(domain);
        if (!w.reachable) warn(`${c.t}: ${domain} not reachable (${w.error})`);
        setup = scoreSetup(email, w.reachable ? w : null);
      } else warn(`${c.t}: no website domain found`);
      out[c.t] = {
        t: c.t, n: c.n, group: c.group || "coverage", domain, annual,
        governance: gov, setup, email, web: w, incidents,
        ...grade(gov?.score ?? null, setup?.score ?? null, incidents),
      };
      console.log(`  ${domain || "—"} gov ${gov?.score ?? "—"} setup ${setup?.score ?? "—"} incidents ${incidents.length} → ${out[c.t].grade || "—"}`);
    } catch (e) { warn(`${c.t}: ${e.message}`); }
  }

  console.log("Incident study…");
  let study = null;
  try { study = await eventStudy(await allIncidents()); } catch (e) { warn(`incident study: ${e.message}`); }

  const graded = Object.values(out).filter((x) => x.grade);
  const meta = {
    generatedAt: new Date().toISOString(), companies: Object.keys(out).length, graded: graded.length,
    grades: Object.fromEntries(["A", "B", "C", "D", "F"].map((g) => [g, graded.filter((x) => x.grade === g).length])),
    checks: CHECKS.map(([key, pts, label]) => ({ key, pts, label })), userAgent: WEB_UA, warnings,
  };
  await writeFile(OUT, JSON.stringify({ meta, companies: out, study }, null, 0));
  console.log(`Wrote cyber.json: ${meta.companies} companies, ${meta.graded} graded, ${study?.firstFilings ?? 0} incidents studied.`);
}

export { cyberSection, scoreGovernance, domainFrom, scoreSetup, plain };
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
