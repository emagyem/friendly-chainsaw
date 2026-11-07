import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, ReferenceLine, BarChart, Bar, Cell, AreaChart, Area, ComposedChart
} from "recharts";
import { COMPANIES, META, HISTORY, INDUSTRY, CYBER } from "./data.js";
// Any company on the site, coverage or drug industry.
const findCo = (t) => COMPANIES.find((x) => x.t === t) || INDUSTRY.find((x) => x.t === t);
// Drug-industry segments, in the order the Drug Industry page shows them.
const SEGMENTS = [
  ["big-pharma", "Big pharma", "Large drugmakers that discover, develop and sell branded medicines."],
  ["generics", "Generics", "Makers of off-patent copies of medicines, including biosimilars, plus older brands."],
  ["otc", "Over-the-counter", "Medicines sold without a prescription: pain relief, cold and allergy, store brands."],
  ["api", "Ingredients & contract manufacturing", "Companies that make drugs, drug ingredients or drug packaging for other drugmakers. Most active-ingredient makers are in India, China and Europe and don't file with the SEC."],
  ["orphan", "Rare disease (orphan drugs)", "Companies whose medicines are mainly orphan drugs: treatments the FDA designates for diseases affecting fewer than 200,000 people in the US, which earn extra years of market exclusivity. Unlike the rest of this page, several still spend more cash than they bring in."],
  ["compounding", "Compounding", "Pharmacies that mix custom or sterile medicines, including large-scale compounded weight-loss drugs."],
];
const segLabel = (g) => SEGMENTS.find(([k]) => k === g)?.[1] || null;
import UNIVERSE from "../config/universe.json";
import { offeringStudy, raiseRunway, PRE, POST } from "./research.js";
import { successOdds, exclusivity, reviewOffice, windowConfidence, ODDS_SOURCE, TRIALS_VERSION } from "./trials.js";
import { runwaySim, equitySim, financingModel, FEATURES, QUANT_VERSION, burnForecast, raiseEstimate, anomalies } from "./quant.js";
import { computeFPS, nextMajorCatalyst, FPS_COMPONENTS, FPS_BANDS, FPS_CHANGELOG, FPS_VERSION, FPS_UPDATED, BUFFER_MONTHS, NO_CATALYST_MONTHS } from "./fps.js";

/* ------------------------------------------------------------------
   HELIXORA — biotech markets terminal
   Data comes from public/data/companies.json (SEC EDGAR, ClinicalTrials.gov,
   stock prices, plus config/assumptions.json), refreshed nightly.
   Falls back to a fictional sample dataset when that file is absent.
------------------------------------------------------------------- */

const PHASES = ["Discovery", "Preclinical", "Phase I", "Phase II", "Phase III", "Filed", "Approved"];
const PHASE_COLOR = {
  "Discovery": "#B9CFCB", "Preclinical": "#8FBDB6", "Phase I": "#54A29A",
  "Phase II": "#12706B", "Phase III": "#0C5670", "Filed": "#123E6B", "Approved": "#2F6B3A",
};
// Probability of eventual approval from current phase (sample priors, oncology discounted)
const POS = { "Discovery": 0.05, "Preclinical": 0.09, "Phase I": 0.14, "Phase II": 0.25, "Phase III": 0.55, "Filed": 0.90, "Approved": 1 };

const CAT_KIND = {
  readout: { label: "Trial readout", c: "#0C5670" },
  regulatory: { label: "Regulatory", c: "#123E6B" },
  earnings: { label: "Earnings", c: "#5A6B76" },
  financing: { label: "Financing", c: "#B8730F" },
  conference: { label: "Conference", c: "#5A6B76" },
  minor: { label: "Minor update", c: "#9AA6AD" },
};


/* ---------------------------- calculations ---------------------------- */

const TODAY = new Date();
const days = (iso) => Math.round((new Date(iso + "T00:00:00") - TODAY) / 86400000);
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const money = (m) => (m >= 1e6 ? `$${(m / 1e6).toFixed(2)}T` : m >= 100000 ? `$${Math.round(m / 1000)}B` : m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);
const num = (n, d = 1) => (n == null || !isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const LIVE = META.live;
// Share-count growth: measured from SEC filings when live, summed from the financing table otherwise.
const shareGrowth = (c) => (c.dil24 != null ? c.dil24 : c.financings.reduce((s, f) => s + (f.dil || 0), 0));
const dilutionPhrase = (c) => (c.dil24 != null ? "over the last two years of SEC filings" : "across the financings on file");
const leadProgram = (c) => [...c.pipeline].sort((a, b) => phaseRank(b.ph) - phaseRank(a.ph))[0];
const ExtLink = ({ href, children }) => (href ? <a className="src" href={href} target="_blank" rel="noreferrer">{children}</a> : children);

// Capped at ten years so cash-flow-positive companies do not show absurd figures.
function runway(c) { return Math.min(c.cash / c.burn, 120); }

function rnpv(p, { discount = 0.11, margin = 0.42, patentYrs = 11, posOverride = null } = {}) {
  const pos = posOverride ?? p.odds?.loa ?? POS[p.ph];
  const ramp = 5;
  let pv = 0;
  for (let t = 1; t <= p.launch + patentYrs + 2; t++) {
    let sales = 0;
    if (t > p.launch) {
      const y = t - p.launch;
      sales = p.peak * Math.min(1, y / ramp);
      if (y > patentYrs) sales *= 0.25;
    }
    pv += (sales * margin) / Math.pow(1 + discount, t);
  }
  // Development spend stops if a trial fails, so weight it partway toward the success case
  const costWeight = pos + (1 - pos) * 0.45;
  let costPv = 0;
  const yrsToSpend = Math.max(1, Math.round(p.launch));
  for (let t = 1; t <= yrsToSpend; t++) costPv += ((p.cost * costWeight) / yrsToSpend) / Math.pow(1 + discount, t);
  return Math.max(0, pv * pos - costPv);
}

function pipelineValue(c, opts) { return c.pipeline.reduce((s, p) => s + rnpv(p, opts), 0); }

// The next clinical or regulatory event. Estimated earnings dates only count when nothing else is dated.
function nextCatalyst(c) {
  const major = nextMajorCatalyst(c, TODAY);
  if (major) return major;
  return c.catalysts.filter((x) => days(x.date) >= 0).sort((a, b) => days(a.date) - days(b.date))[0] || null;
}
// "VK2735 Phase III primary completion (registry estimate)" -> "VK2735 Phase III data (est.)"
const shortLabel = (l) => (l || "").replace(/ primary completion \(registry estimate\)/i, " data (est.)").replace(/ primary completion/i, " data")
  .replace(/Next quarterly report \(estimated\)/i, "Quarterly report (est.)").replace(/ data \(estimated\)$/i, " data (est.)");
// For use inside sentences, where "(est.)" reads badly.
const plainLabel = (l) => shortLabel(l).replace(/ \(est\.\)$/, "").replace(/ data$/, " results").replace(/ PDUFA target action date$/, " FDA decision");
// "about a year", "about 16 months": how a person would say a span of months.
const monthsSay = (m) => {
  const r = Math.round(m);
  if (r >= 120) return "more than ten years";
  if (r === 12) return "about a year";
  if (r === 18) return "about a year and a half";
  if (r === 24) return "about two years";
  if (r === 36) return "about three years";
  if (r <= 1) return "about a month";
  return `about ${r} months`;
};
const fmtRunway = (r, unit = "mo") => (r >= 120 ? "10+ yrs" : `${num(r)} ${unit}`);
// Capitalize a sentence, but leave drug names like "z-rostudirsen" as written.
const cap = (t) => (t && /^[a-z]+[\s,]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function phaseRank(ph) { return PHASES.indexOf(ph); }

function scoreParts(c) {
  const r = runway(c);
  const financial = Math.max(0, Math.min(100,
    (Math.min(r, 36) / 36) * 85 + (c.debt === 0 ? 15 : Math.max(0, 15 - (c.debt / c.cash) * 30))));

  const best = Math.max(...c.pipeline.map((p) => phaseRank(p.ph)));
  const depth = Math.min(1, c.pipeline.length / 3);
  const pipeline = Math.min(100, (best / 6) * 62 + depth * 20 + c.diff * 18);

  const nc = nextCatalyst(c);
  const d = nc ? days(nc.date) : 999;
  const nearness = d <= 30 ? 100 : d <= 90 ? 85 : d <= 180 ? 65 : d <= 365 ? 40 : 15;
  const cnt = Math.min(1, c.catalysts.filter((x) => days(x.date) >= 0 && days(x.date) < 365).length / 3);
  const catalyst = Math.round(nearness * 0.75 + cnt * 25);

  const market = Math.round(c.mkt * 100);

  const pv = pipelineValue(c);
  const ratio = c.ev / Math.max(pv, 1);
  const valuation = Math.round(Math.max(0, Math.min(100, 100 - (ratio - 0.45) * 80)));

  const strategic = Math.min(100, c.partners.length * 28 + Math.min(c.patentYrs, 14) * 4 + (c.rev > 0 ? 12 : 0));

  return { financial, pipeline, catalyst, market, valuation, strategic };
}

const WEIGHTS = [
  ["Financial strength", "financial", 0.20],
  ["Pipeline quality", "pipeline", 0.25],
  ["Catalyst profile", "catalyst", 0.15],
  ["Market opportunity", "market", 0.15],
  ["Valuation", "valuation", 0.15],
  ["Strategic position", "strategic", 0.10],
];

function bis(c) {
  const p = scoreParts(c);
  return Math.round(WEIGHTS.reduce((s, [, k, w]) => s + p[k] * w, 0));
}

function alertsFor(c) {
  const out = [];
  const r = runway(c);
  if (r < 12) out.push({ sev: "high", text: `Only ${monthsSay(r)} of cash left, so it will probably need to raise money before its next big event.` });
  else if (r < 18) out.push({ sev: "med", text: `${cap(monthsSay(r))} of cash left. Companies in this spot often raise early, while the stock is doing well.` });
  const nc = nextCatalyst(c);
  // A routine quarterly report is worth noting, not a reason to act.
  if (nc && nc.kind === "earnings") out.push({ sev: "low", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  else if (nc && days(nc.date) <= 45) out.push({ sev: "high", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  else if (nc && days(nc.date) <= 120) out.push({ sev: "low", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  const atm = c.financings.find((f) => f.type === "ATM program" && days(f.date) > -540);
  if (atm) out.push({ sev: "med", text: `It has had an at-the-market program since ${fmtDate(atm.date)}, so it can sell new shares quietly, without announcing a deal.` });
  const dil = shareGrowth(c);
  if (dil > 25) out.push({ sev: "med", text: `The number of shares has grown about ${num(dil, 0)}% ${dilutionPhrase(c)}, which shrinks each existing holder's slice.` });
  if (c.deal?.status === "pending") out.push({ sev: "high", text: `Being bought${c.deal.by ? ` by ${c.deal.by}` : ""}: a ${c.deal.how} has been under way since ${fmtDate(c.deal.since)}. Its financing risk matters little while the deal is pending, and it leaves Helixora once the deal closes.` });
  if (c.stale) out.push({ sev: "low", text: "We couldn't update this company in the latest refresh, so these figures are from an earlier run." });
  const evpv = c.ev / Math.max(pipelineValue(c), 1);
  if (evpv < 0.8) out.push({ sev: "low", text: `The company is valued about ${num((1 - evpv) * 100, 0)}% below our rough estimate of what its pipeline is worth. That estimate leans on a placeholder sales figure, so check it before calling the stock cheap.` });
  return out;
}

/* ------------------------------ trace UI ------------------------------ */

function Trace({ value, unit, source, calc, reading, tone, link }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <span className="tr-wrap" ref={ref}>
      <button className={"tr-val " + (tone || "")} onClick={() => setOpen(!open)} aria-expanded={open}>
        {value}{unit ? <span className="tr-unit">{unit}</span> : null}
      </button>
      {open && (
        <span className="tr-pop" role="dialog">
          <span className="tr-row"><b>From</b><ExtLink href={link}>{source}</ExtLink></span>
          <span className="tr-row"><b>Calculated</b>{calc}</span>
          <span className="tr-row"><b>Reading</b>{reading}</span>
        </span>
      )}
    </span>
  );
}

function Bar100({ v, color }) {
  return <span className="bar100"><span style={{ width: `${Math.max(2, Math.min(100, v))}%`, background: color || "var(--teal)" }} /></span>;
}

function PhaseTrack({ ph }) {
  const idx = phaseRank(ph);
  return (
    <span className="ptrack" title={ph}>
      {PHASES.map((p, i) => (
        <span key={p} className={"pseg " + (i <= idx ? "on" : "")} style={i <= idx ? { background: PHASE_COLOR[ph] } : {}} />
      ))}
    </span>
  );
}

/* ------------------------------ views ------------------------------ */

/* --------------------------- market helpers --------------------------- */

const UP = "#0A7D4F", DOWN = "#C2272D", FLAT = "#5E6B73";
const fmtPx = (p) => (p == null ? "—" : `$${p.toFixed(2)}`);
const signed = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`);
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const shortDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
const hasQuotes = () => COMPANIES.some((c) => c.quote?.chgPct != null);

// Direction is always carried by an arrow and a sign as well as color.
function Arrow({ v }) {
  return <span aria-hidden="true" className="arw">{v > 0 ? "▲" : v < 0 ? "▼" : "■"}</span>;
}

function Change({ c, abs = false }) {
  const q = c.quote;
  if (!q || q.chgPct == null) return <span className="chg flat">—</span>;
  return (
    <span className={"chg " + dirOf(q.chgPct)}>
      <Arrow v={q.chgPct} />
      {abs ? `${signed(q.chg)} (${signed(q.chgPct)}%)` : `${signed(q.chgPct)}%`}
    </span>
  );
}

/* ------------------------------ ticker strip ------------------------------ */

function TickerStrip({ go }) {
  const reps = Math.max(2, Math.ceil(16 / COMPANIES.length));
  const row = (copy) => COMPANIES.map((c) => (
    <button key={copy + c.t} className="tk" onClick={() => go("company", c.t)} tabIndex={copy === 0 ? 0 : -1}>
      <b>{c.t}</b>
      <span className="tk-px">{c.quote ? fmtPx(c.quote.price) : money(c.mcap)}</span>
      {c.quote && <Change c={c} />}
    </button>
  ));
  const half = Array.from({ length: reps }, (_, i) => row(i));
  const half2 = Array.from({ length: reps }, (_, i) => row(reps + i));
  return (
    <div className="strip" aria-label="Latest prices">
      <div className="strip-track">
        <div className="strip-half">{half}</div>
        <div className="strip-half" aria-hidden="true">{half2}</div>
      </div>
    </div>
  );
}

/* ------------------------------ price chart ------------------------------ */

const RANGES = [["1M", 31], ["3M", 92], ["6M", 183], ["1Y", 366]];

function PriceChart({ c, height = 260, compact = false }) {
  const [range, setRange] = useState(compact ? "6M" : "1Y");
  const h = c.quote?.history || [];
  if (h.length < 2) {
    return <div className="nochart">Price history appears here after the next data refresh.</div>;
  }
  const span = RANGES.find(([k]) => k === range)[1];
  const cutoff = new Date(Date.parse(h.at(-1)[0]) - span * 86400000).toISOString().slice(0, 10);
  const data = h.filter(([d]) => d >= cutoff).map(([d, p]) => ({ d, p }));
  const first = data[0].p, last = data.at(-1).p;
  const pct = ((last / first) - 1) * 100;
  const color = pct > 0 ? UP : pct < 0 ? DOWN : FLAT;
  const axisTick = { fontSize: 11, fill: "#5E6B73" };
  return (
    <div className="pchart">
      {!compact && (
        <div className="ranges">
          <div role="group" aria-label="Chart range">
            {RANGES.map(([k]) => (
              <button key={k} className={k === range ? "on" : ""} aria-pressed={k === range} onClick={() => setRange(k)}>{k}</button>
            ))}
          </div>
          <span className={"chg " + dirOf(pct)}>{range} <Arrow v={pct} />{signed(pct)}%</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#E4E9EB" vertical={false} />
          <XAxis dataKey="d" hide={compact} axisLine={false} tickLine={false} minTickGap={48} tick={axisTick}
            tickFormatter={(d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", span > 100 ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" })} />
          <YAxis orientation="right" hide={compact} domain={["auto", "auto"]} axisLine={false} tickLine={false} width={52} tick={axisTick}
            tickFormatter={(v) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`} />
          <Tooltip cursor={{ stroke: "#8A979E", strokeDasharray: "3 3" }} content={({ payload }) => {
            if (!payload || !payload.length) return null;
            const d = payload[0].payload;
            return <div className="rtip"><b>{fmtPx(d.p)}</b><br />{fmtDate(d.d)}</div>;
          }} />
          <Area type="linear" dataKey="p" stroke={color} strokeWidth={2} fill={color} fillOpacity={0.07}
            dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: color }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RangeBar({ lo, hi, v }) {
  if (lo == null || hi == null || v == null || hi <= lo) return null;
  const pos = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return (
    <span className="rbar" title={`${fmtPx(v)} within ${fmtPx(lo)}–${fmtPx(hi)}`}>
      <span className="rbar-track"><span className="rbar-dot" style={{ left: `${pos}%` }} /></span>
      <span className="rbar-ends"><span>{fmtPx(lo)}</span><span>{fmtPx(hi)}</span></span>
    </span>
  );
}

/* ------------------------------ data briefs ------------------------------
   Headlines written from the dataset itself. Every claim is a figure the
   terminal already shows, so nothing here is reported news.            */

function briefs() {
  const out = [];
  const used = new Set();
  const add = (b) => { if (b && !used.has(b.c.t + b.kind)) { used.add(b.c.t + b.kind); out.push(b); } };
  const runwayLine = (c) => c.cashFlowPositive
    ? `It brings in more cash than it spends, and has ${money(c.cash)} in cash and investments.`
    : `It has ${money(c.cash)} in cash and investments and spends about $${num(c.burn)}M a month, enough for ${monthsSay(runway(c))}.`;

  // Regulatory decisions in the next six months
  const reg = [];
  COMPANIES.forEach((c) => c.catalysts.forEach((x) => { const d = days(x.date); if (x.kind === "regulatory" && d >= 0 && d <= 180) reg.push({ c, x, d }); }));
  reg.sort((a, b) => a.d - b.d).forEach(({ c, x, d }) => add({
    kind: "reg", c, weight: 100 - d / 10,
    headline: `${c.n} is ${d <= 7 ? "days" : `${d} days`} away from an FDA decision`,
    dek: `The FDA is due to rule on ${x.drug || "its application"} by ${fmtDate(x.date)}. ${runwayLine(c)}`,
  }));

  // Biggest price moves
  if (hasQuotes()) {
    const movers = COMPANIES.filter((c) => c.quote?.chgPct != null).sort((a, b) => Math.abs(b.quote.chgPct) - Math.abs(a.quote.chgPct));
    movers.slice(0, 2).forEach((c) => {
      const q = c.quote;
      const offHigh = q.hi52 ? ((q.price / q.hi52) - 1) * 100 : null;
      add({
        kind: "move", c, weight: Math.abs(q.chgPct) * 6,
        headline: `${c.n} shares ${q.chgPct >= 0 ? (q.chgPct >= 8 ? "jump" : "rise") : (q.chgPct <= -8 ? "slide" : "fall")} ${Math.abs(q.chgPct).toFixed(1)}%`,
        dek: `The stock closed at ${fmtPx(q.price)} on ${fmtDate(q.date)}${offHigh != null ? (offHigh < -1 ? `, ${Math.abs(offHigh).toFixed(0)}% below its high of the past year (${fmtPx(q.hi52)})` : ", near its high of the past year") : ""}. The market values the company at ${money(c.mcap)}.`,
      });
    });
  }

  // Nearest trial readouts
  const ro = [];
  COMPANIES.forEach((c) => c.catalysts.forEach((x) => { const d = days(x.date); if (x.kind === "readout" && d >= 0 && d <= 240) ro.push({ c, x, d }); }));
  ro.sort((a, b) => a.d - b.d).slice(0, 3).forEach(({ c, x, d }) => {
    const p = c.pipeline.find((pp) => pp.d === x.drug);
    add({
      kind: "readout", c, weight: 60 - d / 8,
      headline: `${x.drug || c.n} ${p ? `${p.ph} ` : ""}results could be ${d} days away`,
      dek: `${c.n}${p ? ` is testing ${x.drug} in ${p.ind.toLowerCase()}` : " has a trial finishing soon"}. ${x.est ? `The trial registry lists ${fmtDate(x.date)}, but results often come out weeks or months after that.` : `The company expects results by ${fmtDate(x.date)}.`}`,
    });
  });

  // Shortest runway
  const tight = [...COMPANIES].filter((c) => !c.cashFlowPositive).sort((a, b) => runway(a) - runway(b))[0];
  if (tight) {
    const nc = nextCatalyst(tight);
    add({
      kind: "runway", c: tight, weight: 70 - runway(tight),
      headline: `${tight.n} has less cash runway than any company we track`,
      dek: `${runwayLine(tight)}${nc ? ` Its next big event, ${plainLabel(nc.label)}, is expected around ${fmtDate(nc.date)}.` : ""}`,
    });
  }

  // Dilution
  const dil = [...COMPANIES].filter((c) => c.dil24 != null).sort((a, b) => b.dil24 - a.dil24)[0];
  if (dil && dil.dil24 > 15) {
    add({
      kind: "dilution", c: dil, weight: dil.dil24 / 2,
      headline: dil.dil24 >= 100
        ? `${dil.n} has ${(1 + dil.dil24 / 100).toFixed(1)} times as many shares as two years ago`
        : `${dil.n} has ${dil.dil24.toFixed(0)}% more shares than two years ago`,
      dek: `It now has ${num(dil.shares, 1)} million shares, according to its latest SEC filing${dil.financings.length ? `, after ${dil.financings.length === 1 ? "one offering filing" : `${dil.financings.length} offering filings`} in the past three years` : ""}. Every new share shrinks existing holders' slice.`,
    });
  }
  // Financing pressure leads the page: the company most likely to need money before its next catalyst.
  const pressed = [...COMPANIES].map((c) => ({ c, f: fpsOf(c) })).filter((x) => x.f.score != null).sort((a, b) => b.f.score - a.f.score);
  pressed.slice(0, 2).forEach(({ c, f }, i) => {
    const cat = f.catalyst;
    add({
      kind: "pressure", c, weight: (i === 0 ? 300 : 90) + f.score,
      headline: c.cashFlowPositive ? `${c.n} is under little pressure to raise money`
        : `${c.n} has ${monthsSay(f.runway)} of cash${cat ? ` and ${cat.kind === "regulatory" ? "an FDA decision" : `${(c.pipeline.find((p) => p.d === cat.drug)?.ph || "trial")} results`} due in ${monthsSay(f.monthsToCatalyst)}` : " and nothing big on the calendar"}`,
      dek: `That puts it at ${f.score} out of 100 on our Financing Pressure Score, in the ${f.band} band. ${!cat
        ? `With no trial result or FDA decision dated, we assume the next one is ${NO_CATALYST_MONTHS} months away${(() => { const t = f.parts.find((p) => p.key === "trend"); return t?.present && t.value > 10 ? `, and it's spending ${Math.round(t.value)}% more than a year ago` : ""; })()}.`
        : Math.round(f.gap) < 0
        ? `Allowing a ${BUFFER_MONTHS}-month cushion after ${cat ? plainLabel(cat.label) : "its next big event"}, it's about ${Math.round(-f.gap)} months short.`
        : Math.round(f.gap) === 0 ? `Allowing a ${BUFFER_MONTHS}-month cushion after ${cat ? plainLabel(cat.label) : "its next big event"}, it has almost nothing to spare.`
          : `Allowing a ${BUFFER_MONTHS}-month cushion after ${cat ? plainLabel(cat.label) : "its next big event"}, it has about ${Math.round(f.gap)} months to spare.`}${c.raise?.capacity === "atm" ? " It already has an at-the-market program, so it can start selling shares any day." : c.raise?.capacity === "shelf" ? " It has a shelf registration ready, which makes a quick raise easy." : ""}`,
    });
  });
  return out.filter((b) => !(b.kind === "runway" && out.some((x) => x.kind === "pressure" && x.c.t === b.c.t)))
    .sort((a, b) => b.weight - a.weight);
}

function wire() {
  const all = [];
  const seen = new Set();
  COMPANIES.forEach((c) => (c.news || []).forEach((n) => {
    // Several prospectus supplements for one offering often land the same day; show one.
    const key = c.t + n.form + n.date;
    if (!seen.has(key)) { seen.add(key); all.push({ ...n, c }); }
  }));
  return all.sort((a, b) => (b.date === a.date ? (b.time || "").localeCompare(a.time || "") : b.date.localeCompare(a.date))).slice(0, 11);
}

/* --------------------------------- home --------------------------------- */

function Kicker({ c, go }) {
  return <button className="kicker" onClick={() => go("company", c.t)}>{c.n} <span className="kicker-t">{c.t}</span></button>;
}

function Home({ go, watch, toggleWatch }) {
  const stories = useMemo(() => briefs(), []);
  const feed = useMemo(() => wire(), []);
  const quotes = hasQuotes();
  const lead = stories[0];
  const rest = stories.slice(1, 7);

  const movers = [...COMPANIES].sort((a, b) => quotes ? Math.abs(b.quote?.chgPct ?? 0) - Math.abs(a.quote?.chgPct ?? 0) : b.mcap - a.mcap).slice(0, 10)
    .sort((a, b) => quotes ? (b.quote?.chgPct ?? -999) - (a.quote?.chgPct ?? -999) : 0);

  const upcoming = useMemo(() => {
    const all = [];
    // Clinical and regulatory events lead; estimated earnings dates fill in only if there are few.
    COMPANIES.forEach((c) => c.catalysts.forEach((x) => { const d = days(x.date); if (d >= 0) all.push({ ...x, c, d }); }));
    const main = all.filter((x) => x.kind !== "earnings").sort((a, b) => a.d - b.d);
    const filler = all.filter((x) => x.kind === "earnings").sort((a, b) => a.d - b.d);
    return [...main, ...filler].slice(0, 6).sort((a, b) => a.d - b.d);
  }, []);

  const flagged = useMemo(() =>
    COMPANIES.map((c) => ({ c, a: alertsFor(c) }))
      .filter((x) => x.a.some((y) => y.sev === "high" || y.sev === "med"))
      .sort((a, b) => runway(a.c) - runway(b.c)).slice(0, 5), []);

  const scatter = COMPANIES.map((c) => {
    const nc = nextCatalyst(c);
    return { x: nc ? Math.min(days(nc.date), 400) : 400, y: Math.min(runway(c), 40), z: Math.sqrt(c.mcap), t: c.t, name: c.n };
  });

  return (
    <div className="front-wrap">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="id-line">Know which biotechs will have to raise money, and roughly when.</h1>
          <p className="id-sub">We follow {COMPANIES.length} clinical-stage biotechs: how much cash they have, when their big news is due, and how fast they could sell stock. Every number links back to the filing it came from.</p>
          <div className="id-ctas">
            <button className="btn primary" onClick={() => go("report")}>Read the Financing Pressure Report</button>
            <button className="btn ghost" onClick={() => go("method")}>How the score works</button>
          </div>
        </div>
        <div className="hero-rail">
          <p className="rail-cap">Today's Financing Pressure Score for every company we track. Pick one to see why.</p>
          <PressureRail go={go} />
        </div>
      </section>
      <div className="front">
        <section className="lead" aria-labelledby="lead-h">
          {lead ? (
            <>
              <Kicker c={lead.c} go={go} />
              <h1 id="lead-h" className="lead-h"><button onClick={() => go("company", lead.c.t)}>{lead.headline}</button></h1>
              <p className="lead-dek">{cap(lead.dek)}</p>
              <div className="lead-chart">
                {lead.c.quote?.history?.length > 1
                  ? <><div className="lead-px"><b>{fmtPx(lead.c.quote.price)}</b><Change c={lead.c} abs /></div><PriceChart c={lead.c} height={150} compact /></>
                  : null}
              </div>
              <p className="byline">Our software writes these headlines from SEC filings, ClinicalTrials.gov and market prices{LIVE ? `, updated ${fmtDate(META.generatedAt.slice(0, 10))}` : ""}.</p>
            </>
          ) : <p className="empty">No briefs yet. They appear after the first data refresh.</p>}

          <div className="briefs">
            {rest.map((b, i) => (
              <article key={i} className="brief">
                <Kicker c={b.c} go={go} />
                <h2><button onClick={() => go("company", b.c.t)}>{b.headline}</button></h2>
                <p>{cap(b.dek)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="wire" aria-labelledby="wire-h">
          <h2 id="wire-h" className="colhead">Latest filings</h2>
          {feed.length === 0 && <p className="empty">SEC filings appear here after the next data refresh.</p>}
          <ol className="wire-list">
            {feed.map((n, i) => (
              <li key={i}>
                <span className="wire-meta"><span>{shortDate(n.date)}</span><button className="wire-t" onClick={() => go("company", n.c.t)}>{n.c.t}</button><span>{n.form}</span></span>
                <a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a>
              </li>
            ))}
          </ol>
          {feed.length > 0 && <p className="colnote">Each headline links to the filing on SEC EDGAR.</p>}
        </section>

        <aside className="side">
          <section aria-labelledby="mov-h">
            <h2 id="mov-h" className="colhead">{quotes ? "Movers" : "Universe"}</h2>
            <table className="mtable">
              <thead><tr><th>Company</th><th className="r">{quotes ? "Last" : "Mkt cap"}</th><th className="r">{quotes ? "Chg %" : "Runway"}</th></tr></thead>
              <tbody>
                {movers.map((c) => (
                  <tr key={c.t} onClick={() => go("company", c.t)}>
                    <td><button className="mt-t" onClick={(e) => { e.stopPropagation(); go("company", c.t); }}>{c.t}</button><span className="mt-n">{c.n}</span></td>
                    <td className="r num">{quotes ? fmtPx(c.quote?.price) : money(c.mcap)}</td>
                    <td className="r num">{quotes ? <Change c={c} /> : `${num(runway(c), 0)} mo`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {quotes && <p className="colnote">The 10 biggest moves from the previous close.</p>}
          </section>

          <section aria-labelledby="up-h">
            <h2 id="up-h" className="colhead">Coming up</h2>
            <ul className="uplist">
              {upcoming.map((e, i) => (
                <li key={i}>
                  <span className="up-d"><b>{e.d}</b>days</span>
                  <button onClick={() => go("company", e.c.t)}><span className="up-t">{e.c.t}</span>{shortLabel(e.label)}{e.est && !/est/i.test(shortLabel(e.label)) ? <em> (est.)</em> : null}</button>
                </li>
              ))}
            </ul>
            <button className="morelink" onClick={() => go("catalysts")}>Full calendar</button>
          </section>

          <section aria-labelledby="rl-h-home">
            <h2 id="rl-h-home" className="colhead">Financing pressure</h2>
            <ul className="mini-fps">
              {byPressure().slice(0, 5).map((c) => (
                <li key={c.t}><button onClick={() => go("company", c.t, "pressure")}><b>{c.t}</b><span>{fmtRunway(fpsOf(c).runway)} cash</span><BandBadge c={c} /></button></li>
              ))}
            </ul>
            <button className="morelink" onClick={() => go("report")}>Full report</button>
          </section>

          <section aria-labelledby="wl-h">
            <h2 id="wl-h" className="colhead">Your watchlist</h2>
            {watch.length === 0 && <p className="colnote">Star a company on its quote page to follow it here.</p>}
            <ul className="wl">
              {watch.map((t) => findCo(t)).filter(Boolean).map((c) => (
                <li key={c.t}>
                  <button className="wl-row" onClick={() => go("company", c.t)}>
                    <b>{c.t}</b><span>{c.quote ? fmtPx(c.quote.price) : money(c.mcap)}</span>{c.quote ? <Change c={c} /> : <span />}
                  </button>
                  <button className="wl-x" aria-label={`Remove ${c.t} from watchlist`} onClick={() => toggleWatch(c.t)}>×</button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      <AlertsPanel go={go} />

      <div className="two wide-left">
        <section className="panel">
          <header className="ph"><h2>Financing Pressure Score</h2>
            <span className="ph-note">How likely each company is to need new money before its next big event. The dashed lines mark the Elevated (40) and High (70) bands.</span></header>
          <FpsChart go={go} />
        </section>
        <section className="panel"><RaiseList go={go} /></section>
      </div>

      <div className="two">
        <section className="panel">
          <header className="ph"><h2>Cash runway vs. next catalyst</h2>
            <span className="ph-note">Lower left: less than a year of cash with an event coming soon. Bubble size shows market value.</span></header>
          <div className="chart">
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 12, right: 16, bottom: 28, left: 4 }}>
                <CartesianGrid stroke="#E4E9EB" />
                <XAxis type="number" dataKey="x" name="Days to next catalyst" domain={[0, 400]}
                  tick={{ fontSize: 11, fill: "#5E6B73" }}
                  label={{ value: "days to next catalyst", position: "insideBottom", offset: -14, fontSize: 11, fill: "#5E6B73" }} />
                <YAxis type="number" dataKey="y" name="Runway" domain={[0, 40]}
                  tick={{ fontSize: 11, fill: "#5E6B73" }}
                  label={{ value: "months of cash", angle: -90, position: "insideLeft", fontSize: 11, fill: "#5E6B73" }} />
                <ZAxis dataKey="z" range={[60, 420]} />
                <ReferenceLine y={12} stroke="#B8730F" strokeDasharray="4 3" />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ payload }) => {
                  if (!payload || !payload.length) return null;
                  const d = payload[0].payload;
                  return <div className="rtip"><b>{d.t}</b> {d.name}<br />{d.y >= 40 ? "40+" : num(d.y)} months of cash, next event in {d.x >= 400 ? "400+" : d.x} days</div>;
                }} />
                <Scatter data={scatter} fill="#12706B" fillOpacity={0.72} stroke="#fff" strokeWidth={2} onClick={(d) => go("company", d.t)} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="panel">
          <header className="ph"><h2>Risk flags</h2><span className="ph-note">Based on cash runway, catalyst timing and share dilution.</span></header>
          <div className="alist">
            {flagged.length === 0 && <p className="empty">No company trips a runway, timing or dilution rule today.</p>}
            {flagged.map(({ c, a }) => (
              <div key={c.t} className="arow">
                <div className="arow-head">
                  <button className="tick" onClick={() => go("company", c.t)}>{c.t}</button>
                  <span className="aname">{c.n}</span>
                </div>
                {a.filter((x) => x.sev !== "low").map((x, i) => <div key={i} className={"alert " + x.sev}>{x.text}</div>)}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Screen({ go }) {
  const [q, setQ] = useState("");
  const [area, setArea] = useState("All");
  const [minPhase, setMinPhase] = useState("Phase I");
  const capCeiling = useMemo(() => Math.max(4000, Math.ceil(Math.max(...COMPANIES.map((c) => c.mcap)) / 500) * 500), []);
  const [maxCap, setMaxCap] = useState(capCeiling);
  const [minRun, setMinRun] = useState(0);
  const [within, setWithin] = useState(730);
  const [sort, setSort] = useState("fps");
  const [band, setBand] = useState("All");
  const [dir, setDir] = useState(-1);

  const areas = ["All", ...Array.from(new Set(COMPANIES.map((c) => c.area)))];

  const rows = useMemo(() => {
    const out = COMPANIES.filter((c) => {
      if (q && !(c.t + " " + c.n + " " + c.pipeline.map((p) => p.d + p.ind + p.tgt).join(" ")).toLowerCase().includes(q.toLowerCase())) return false;
      if (area !== "All" && c.area !== area) return false;
      if (!c.pipeline.some((p) => phaseRank(p.ph) >= phaseRank(minPhase))) return false;
      if (c.mcap > maxCap) return false;
      if (runway(c) < minRun) return false;
      if (band !== "All" && fpsOf(c).band !== band) return false;
      const nc = nextCatalyst(c);
      if (!nc || days(nc.date) > within) return false;
      return true;
    }).map((c) => {
      const nc = nextCatalyst(c);
      return { c, bis: bis(c), fps: fpsOf(c).score ?? -1, run: runway(c), nd: nc ? days(nc.date) : 9999, nc, pv: pipelineValue(c) };
    });
    const key = { fps: (r) => r.fps, bis: (r) => r.bis, run: (r) => r.run, cap: (r) => r.c.mcap, cash: (r) => r.c.cash, next: (r) => -r.nd, pv: (r) => r.pv, ticker: (r) => r.c.t };
    return out.sort((a, b) => {
      const A = key[sort](a), B = key[sort](b);
      return (typeof A === "string" ? A.localeCompare(B) : A - B) * dir;
    });
  }, [q, area, minPhase, maxCap, minRun, within, sort, dir, band]);

  const th = (k, label, align) => (
    <th className={align} onClick={() => { if (sort === k) setDir(-dir); else { setSort(k); setDir(-1); } }}>
      {label}<span className="sortmark">{sort === k ? (dir === -1 ? "▾" : "▴") : ""}</span>
    </th>
  );

  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Screener</h2></header>
        <div className="filters">
          <label className="f"><span>Company, drug, or target</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`obesity, KRAS, ${COMPANIES[0].t}`} /></label>
          <label className="f"><span>Therapeutic area</span>
            <select value={area} onChange={(e) => setArea(e.target.value)}>{areas.map((a) => <option key={a}>{a}</option>)}</select></label>
          <label className="f"><span>Most advanced program at least</span>
            <select value={minPhase} onChange={(e) => setMinPhase(e.target.value)}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="f"><span>Market cap at or below {money(maxCap)}</span>
            <input type="range" min="100" max={capCeiling} step="50" value={maxCap} onChange={(e) => setMaxCap(+e.target.value)} /></label>
          <label className="f"><span>Runway of at least {minRun} months</span>
            <input type="range" min="0" max="36" value={minRun} onChange={(e) => setMinRun(+e.target.value)} /></label>
          <label className="f"><span>Financing pressure band</span>
            <select value={band} onChange={(e) => setBand(e.target.value)}>{["All", "High", "Elevated", "Low"].map((b) => <option key={b}>{b}</option>)}</select></label>
          <label className="f"><span>Next catalyst within {within} days</span>
            <input type="range" min="30" max="730" step="15" value={within} onChange={(e) => setWithin(+e.target.value)} /></label>
        </div>
      </section>

      <section className="panel">
        <header className="ph"><h2>{rows.length} matches</h2>
          <span className="ph-note">Sorted by Financing Pressure Score. Select a column to re-sort.</span></header>
        {rows.length === 0 ? (
          <div className="empty">Nothing clears those filters. Widen the market cap ceiling or push the catalyst window out.</div>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr>
                {th("ticker", "Ticker")}<th>Company</th><th>Lead program</th>
                {th("cap", "Market cap", "r")}{th("cash", "Cash", "r")}{th("run", "Runway", "r")}
                {th("next", "Next catalyst", "r")}{th("pv", "Pipeline rNPV", "r")}{th("fps", "Financing pressure", "r")}
              </tr></thead>
              <tbody>
                {rows.map(({ c, run, nd, nc, pv }) => {
                  const lead = leadProgram(c);
                  return (
                    <tr key={c.t} onClick={() => go("company", c.t)}>
                      <td><span className="tick">{c.t}</span></td>
                      <td className="nm">{c.n}<span className="sub">{c.area}</span></td>
                      <td><PhaseTrack ph={lead.ph} /><span className="sub">{lead.d} · {lead.ind}</span></td>
                      <td className="r mono">{money(c.mcap)}</td>
                      <td className="r mono">{money(c.cash)}</td>
                      <td className={"r mono nowrap " + (run < 12 ? "warn" : "")}>{fmtRunway(run)}</td>
                      <td className="r mono">{nd > 9000 ? "—" : `${nd}d`}<span className="sub r clip" title={nc?.label}>{nc ? shortLabel(nc.label) : ""}</span></td>
                      <td className="r mono">{money(pv)}</td>
                      <td className="r"><BandBadge c={c} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Company({ ticker, go, watch, toggleWatch, initialTab = "overview" }) {
  const c = findCo(ticker) || COMPANIES[0];
  const [tab, setTab] = useState(initialTab);
  // Opened straight to a tab (e.g. Cyber, from the Cyber Scores page): bring the tabs into view.
  const tabsRef = useRef(null);
  useEffect(() => { if (initialTab !== "overview") setTimeout(() => tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 350); }, [initialTab]);
  const [newShares, setNewShares] = useState(0);
  const [raise, setRaise] = useState(0);
  const [disc, setDisc] = useState(11);
  const [posAdj, setPosAdj] = useState(0);

  const r = runway(c);
  const parts = scoreParts(c);
  const score = bis(c);
  const pv = pipelineValue(c, { discount: disc / 100 });
  const nc = nextCatalyst(c);

  const cashCurve = useMemo(() => {
    const out = [];
    for (let m = 0; m <= 36; m += 1) {
      const base = c.cash - c.burn * m + (c.rev / 12) * m * 0.45;
      out.push({ m, cash: Math.max(0, base), withRaise: Math.max(0, base + (m >= 6 ? raise : 0)) });
    }
    return out;
  }, [c, raise]);

  const dilution = useMemo(() => {
    const post = c.shares + newShares;
    return { post, pct: newShares === 0 ? 0 : (newShares / post) * 100, proceeds: newShares * (c.mcap / c.shares) * 0.88 };
  }, [c, newShares]);

  const tabs = [["overview", "Overview"], ["pressure", "Financing pressure"], ["financials", "Financials"], ["pipeline", "Pipeline"], ["catalysts", "Catalysts"], ["valuation", "Valuation"], ["score", "Score"], ...(CYBER.companies?.[c.t] ? [["cyber", "Cyber"]] : [])];

  return (
    <div className="stack">
      <section className="quote">
        <div className="q-top">
          <div className="q-id">
            <h1>{c.n}{c.deal?.status === "pending" && <span className="deal-tag">Being acquired</span>}{segLabel(c.group) && <span className="deal-tag bp-tag">{segLabel(c.group)}</span>}</h1>
            <span className="q-tk">{c.t}</span>
            <span className="q-area">{c.area}</span>
          </div>
          <button className={"watchbtn " + (watch.includes(c.t) ? "on" : "")} aria-pressed={watch.includes(c.t)} onClick={() => toggleWatch(c.t)}>
            {watch.includes(c.t) ? "★ On your watchlist" : "☆ Add to watchlist"}
          </button>
        </div>
        {segLabel(c.group) && <p className="bp-note">Part of the wider drug industry, tracked for comparison and not ranked with the biotechs. {c.n} {c.cashFlowPositive ? "generates cash from its business, so the financing-pressure measures on this page mostly don't apply" : "is spending more cash than it brings in"}. {c.pipeline.length ? "Its pipeline here shows only its own active Phase III trials." : "It has no active Phase III trials of its own."}{c.src?.fxNote ? ` ${c.src.fxNote}.` : ""}</p>}
        {c.quote ? (
          <div className="q-px">
            <span className="q-price">{fmtPx(c.quote.price)}</span>
            <Change c={c} abs />
            <span className="q-asof">Close, {fmtDate(c.quote.date)}</span>
          </div>
        ) : (
          <div className="q-px"><span className="q-price">{money(c.mcap)}</span><span className="q-asof">Market value</span></div>
        )}
        <div className="q-body">
          <div className="q-chart"><PriceChart c={c} /></div>
          <dl className="q-key">
            <dt>Financing Pressure Score</dt><dd><button className="linkish" onClick={() => setTab("pressure")}><BandBadge c={c} /></button></dd>
            <dt>Previous close</dt><dd className="num">{fmtPx(c.quote?.prev)}</dd>
            <dt>52-week range</dt><dd><RangeBar lo={c.quote?.lo52} hi={c.quote?.hi52} v={c.quote?.price} />{c.quote?.hi52 == null && "—"}</dd>
            <dt>Market value</dt><dd className="num">{money(c.mcap)}</dd>
            <dt>Enterprise value</dt><dd className="num">{money(c.ev)}</dd>
            <dt>Shares outstanding</dt><dd className="num">{num(c.shares, 1)}M</dd>
            <dt>Cash and investments</dt><dd className="num">{money(c.cash)}</dd>
            <dt>Cash runway</dt><dd className={"num " + (r < 12 ? "warn" : "")}>{c.cashFlowPositive ? "Cash flow positive" : fmtRunway(r, "months")}</dd>
            <dt>Next catalyst</dt><dd>{nc ? <>{fmtDate(nc.date)} <span className="sub inline">({days(nc.date)} days)</span></> : "None dated"}</dd>
            <dt>Research score</dt><dd className="num">{Number.isFinite(score) ? <>{score} <span className="sub inline">of 100</span></> : "—"}</dd>
          </dl>
        </div>
        {c.note && <p className="q-note">{c.note}</p>}
        {c.news?.length > 0 && (
          <div className="q-news">
            <h2 className="colhead">Recent filings</h2>
            <ul>
              {c.news.filter((n, i, all) => all.findIndex((m) => m.form === n.form && m.date === n.date) === i).slice(0, 4).map((n, i) => (
                <li key={i}><span className="wire-meta"><span>{fmtDate(n.date)}</span><span>{n.form}</span></span><a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a></li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <nav className="tabs" ref={tabsRef}>
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>

      {tab === "pressure" && <div className="stack"><FpsPanel c={c} go={go} /><RunwaySimPanel c={c} /></div>}
      {tab === "cyber" && <CyberPanel t={c.t} go={go} />}

      {tab === "overview" && (
        <div className="two">
          <section className="panel">
            <header className="ph"><h2>Key figures</h2><span className="ph-note">Tap any figure to see where it came from and how we worked it out.</span></header>
            <div className="metrics">
              <div className="metric"><span>Cash runway</span>
                <Trace value={r >= 120 ? "10+" : num(r)} unit={r >= 120 ? " years" : " months"} tone={r < 12 ? "warn" : ""}
                  source={c.src ? `${c.src.filing?.form || "SEC filing"} balance sheet as of ${fmtDate(c.src.asOf)}: cash plus marketable securities` : `Cash of ${money(c.cash)} and quarterly operating cash use, latest filing`}
                  link={c.src?.filing?.url}
                  calc={`${money(c.cash)} ÷ ${num(c.burn)}M per month`}
                  reading={r < 12 ? "Financing is likely needed before the next big event." : r < 18 ? "Enough to reach the next event, not enough to negotiate from strength after it." : "Funded through the next catalyst with room to spare."} />
              </div>
              <div className="metric"><span>Monthly cash burn</span>
                <Trace value={num(c.burn)} unit="M"
                  source={c.src ? "Operating cash flow from SEC XBRL filings, trailing twelve months" : "Operating cash flow and capital expenditure, trailing four quarters"}
                  link={c.src?.filing?.url}
                  calc={c.src?.burnHow ? `Trailing twelve-month operating cash use (${c.src.burnHow}) ÷ 12` : "Trailing twelve-month net cash use ÷ 12"}
                  reading={c.cashFlowPositive ? "Operating cash flow is positive, so runway is not the constraint here." : c.burn > 20 ? "Heavy spend, consistent with a late-stage trial running." : "Burn is in line with a mid-stage clinical program."} />
              </div>
              <div className="metric"><span>Enterprise value</span>
                <Trace value={money(c.ev)}
                  source={c.src ? `Share price $${num(c.src.price, 2)} (${c.src.priceSource}, ${fmtDate(c.src.priceDate)}) × ${num(c.shares, 1)}M shares, less cash, plus debt` : "Market capitalization, cash, and debt"}
                  calc={`${money(c.mcap)} − ${money(c.cash)} + ${money(c.debt)}`}
                  reading={`The market is paying ${money(c.ev)} for the pipeline itself.`} />
              </div>
              <div className="metric"><span>Pipeline rNPV</span>
                <Trace value={money(pv)}
                  source={c.pipeline.some((p) => p.est) ? "Phase from ClinicalTrials.gov. Peak sales and development cost are standard assumptions by phase, not company-specific forecasts" : "Per-program peak sales, phase, and development cost estimates"}
                  calc="Risk-adjusted NPV summed across programs, 11% discount rate"
                  reading={c.ev / pv < 0.85 ? "Enterprise value sits under the modeled pipeline value. Either the market disputes these assumptions or it is discounting execution." : "Enterprise value already matches or exceeds the modeled pipeline value, so the assumptions need to be right."} />
              </div>
              <div className="metric"><span>Next catalyst</span>
                <Trace value={nc ? `${days(nc.date)}` : "—"} unit=" days"
                  source={nc?.est ? "Estimated: trial primary completion date from ClinicalTrials.gov, or the usual quarterly filing cadence" : "Company guidance, trial registry, and regulatory calendar"}
                  calc={nc ? `${fmtDate(nc.date)} minus today` : "No dated event"}
                  reading={nc ? nc.label : "Nothing dated in the current window."} />
              </div>
              <div className="metric"><span>Shares outstanding</span>
                <Trace value={num(c.shares, 0)} unit="M"
                  source={c.src ? `Cover page of the latest SEC filing, as of ${fmtDate(c.src.sharesAsOf)}` : "Cover page of the most recent periodic filing"}
                  link={c.src?.filing?.url}
                  calc="As reported"
                  reading={`Up roughly ${num(shareGrowth(c), 0)}% ${dilutionPhrase(c)}.`} />
              </div>
            </div>
          </section>

          <section className="panel">
            <header className="ph"><h2>Risk flags</h2></header>
            <div className="alist tight">
              {alertsFor(c).length === 0 && <div className="empty">Nothing stands out right now. Cash, timing and dilution are all in normal ranges.</div>}
              {alertsFor(c).map((x, i) => <div key={i} className={"alert " + x.sev}>{x.text}</div>)}
            </div>
            <header className="ph mt"><h2>Company facts</h2></header>
            <dl className="facts">
              <dt>Therapeutic area</dt><dd>{c.area}</dd>
              <dt>Programs</dt><dd>{c.pipeline.length}</dd>
              <dt>Employees</dt><dd className="mono">{c.emp ?? "—"}</dd>
              <dt>Institutional ownership</dt><dd className="mono">{c.own == null ? "—" : `${num(c.own, 0)}%`}</dd>
              <dt>Revenue, trailing</dt><dd className="mono">{c.rev ? money(c.rev) : "None"}</dd>
              <dt>Debt</dt><dd className="mono">{c.debt ? money(c.debt) : "None"}</dd>
              <dt>Partnerships</dt><dd>{c.partners.length ? c.partners.join("; ") : "None disclosed"}</dd>
              <dt>Patent life, lead asset</dt><dd className="mono">{c.patentYrs} years{c.src?.defaults?.includes("patent life") ? " (default)" : ""}</dd>
              {c.src && <><dt>SEC filer</dt><dd><ExtLink href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.src.cik}&type=10-Q`}>CIK {c.src.cik}</ExtLink></dd></>}
              {c.src?.defaults?.length > 0 && <><dt>Placeholder inputs</dt><dd>{c.src.defaults.join(", ")}</dd></>}
            </dl>
          </section>
        </div>
      )}
      {tab === "overview" && <AlertsPanel go={go} only={c.t} />}

      {tab === "financials" && (
        <div className="stack">
          <section className="panel">
            <header className="ph"><h2>Cash runway</h2>
              <span className="ph-note">How long the cash lasts at today's spending. Drag the slider to see what a new raise would do.</span></header>
            <label className="f wide"><span>Model a raise of {money(raise)} in month 6</span>
              <input type="range" min="0" max="400" step="10" value={raise} onChange={(e) => setRaise(+e.target.value)} /></label>
            <div className="chart">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={cashCurve} margin={{ top: 10, right: 20, bottom: 24, left: 8 }}>
                  <CartesianGrid stroke="#E4E9EB" vertical={false} />
                  <XAxis dataKey="m" interval={5} tick={{ fontSize: 11, fill: "#5A6B76" }}
                    label={{ value: "months from today", position: "insideBottom", offset: -12, fontSize: 11, fill: "#5A6B76" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#5A6B76" }} tickFormatter={(v) => `$${v}M`} />
                  <Tooltip formatter={(v, n) => [`$${Math.round(v)}M`, n === "cash" ? "Current plan" : "With the modeled raise"]}
                    labelFormatter={(l) => `Month ${l}`} />
                  {nc && days(nc.date) / 30.4 < 36 && (
                    <ReferenceLine x={Math.round(days(nc.date) / 30.4)} stroke="#0C5670" strokeDasharray="4 3"
                      label={{ value: "next catalyst", fontSize: 10, fill: "#0C5670", position: "top" }} />
                  )}
                  <Line type="monotone" dataKey="cash" stroke="#10202E" strokeWidth={2} dot={false} />
                  {raise > 0 && <Line type="monotone" dataKey="withRaise" stroke="#12706B" strokeWidth={2} strokeDasharray="5 3" dot={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="two">
            <section className="panel">
              <header className="ph"><h2>Dilution estimator</h2><span className="ph-note">Effect of a new share issue on existing holders.</span></header>
              <label className="f wide"><span>Issue {num(newShares, 0)}M new shares</span>
                <input type="range" min="0" max={Math.round(c.shares * 0.5)} value={newShares} onChange={(e) => setNewShares(+e.target.value)} /></label>
              <div className="metrics two-up">
                <div className="metric"><span>Shares after issue</span><b className="mono">{num(dilution.post, 0)}M</b></div>
                <div className="metric"><span>Ownership given up</span><b className="mono warn">{num(dilution.pct)}%</b></div>
                <div className="metric"><span>Gross proceeds at a 12% discount</span><b className="mono">{money(dilution.proceeds)}</b></div>
                <div className="metric"><span>Runway added</span><b className="mono">{num(dilution.proceeds / c.burn)} mo</b></div>
              </div>
            </section>

            <section className="panel">
              <header className="ph"><h2>Financing history</h2><span className="ph-note">Offering filings from the past three years.</span></header>
              <table className="grid plain">
                <thead><tr><th>Date</th><th>Instrument</th><th className="r">Size</th><th className="r">Share count impact</th></tr></thead>
                <tbody>
                  {c.financings.length === 0 && <tr><td colSpan="4" className="empty">No offering filings in the last three years.</td></tr>}
                  {c.financings.map((f, i) => (
                    <tr key={i}><td className="mono">{fmtDate(f.date)}</td><td><ExtLink href={f.url}>{f.type}</ExtLink></td>
                      <td className="r mono">{f.amt != null ? money(f.amt) : "—"}</td><td className="r mono">{f.dil ? `+${num(f.dil)}%` : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <BurnForecastPanel c={c} />
        </div>
      )}

      {tab === "pipeline" && (
        <section className="panel">
          <header className="ph"><h2>Pipeline</h2><span className="ph-note">Risk-adjusted value by program.</span></header>
          <div className="prog-list">
            {c.pipeline.map((p) => {
              const v = rnpv(p, { discount: disc / 100 });
              return (
                <article key={p.d} className="prog">
                  <div className="prog-top">
                    <div>
                      <h3>{p.d}</h3>
                      <div className="prog-ind">{p.ind}</div>
                    </div>
                    <span className="phasechip" style={{ background: PHASE_COLOR[p.ph] }}>{p.ph}</span>
                  </div>
                  <PhaseTrack ph={p.ph} />
                  <dl className="facts small">
                    <dt>Target</dt><dd>{p.tgt || "—"}</dd>
                    <dt>Mechanism</dt><dd>{p.moa || "—"}</dd>
                    <dt>Primary endpoint</dt><dd>{p.ep}</dd>
                    <dt>Enrollment</dt><dd className="mono">{p.n ? p.n : "—"}</dd>
                    <dt>Expected data</dt><dd className="mono">{p.window ? <>{fmtDate(p.window.lo)} to {fmtDate(p.window.hi)} <span className="sub">{p.window.stale ? "Registry date overdue, so a wide window" : `${windowConfidence(p.window)} window`}; registry date {fmtDate(p.ro)}{p.roType === "COMPANY GUIDANCE" ? " (company guidance)" : ""}</span></> : <>{fmtDate(p.ro)} <span className="sub inline">({days(p.ro)}d)</span></>}</dd>
                    {p.flags?.flags?.length ? <><dt>Trial design</dt><dd><div className="flagwrap">{p.flags.flags.map((f) => <span key={f.label} className={"flag " + ({ high: "flag-high", med: "flag-med", low: "flag-low", info: "flag-info" })[f.sev]} title={f.detail}>{f.label}</span>)}</div></dd></> : null}
                    {p.nct && <><dt>Registry</dt><dd className="mono"><ExtLink href={`https://clinicaltrials.gov/study/${p.nct}`}>{p.nct}</ExtLink>{p.trials > 1 ? <span className="sub inline"> +{p.trials - 1} more</span> : null}</dd></>}
                    {p.duration && <><dt>Similar trials</dt><dd>{p.duration.median ? <>Took a median {p.duration.median} months ({p.duration.p25}–{p.duration.p75}); this one plans {p.duration.planned}</> : <>This one plans {p.duration.planned} months</>}<span className="sub">{p.duration.key}, {p.duration.n.toLocaleString("en-US")} trials</span></dd></>}
                    {(() => { const sc = readoutScenario(p); return sc ? <><dt>If this phase succeeds</dt><dd className="mono">{pctW(sc.ifUp)} approval odds <span className="sub">about 0% if it fails; {money(sc.stake)} of value at stake</span></dd></> : null; })()}
                    {p.labels && <><dt>Labeled as</dt><dd>{[p.odds?.area || p.area, p.modality, p.rare && "rare disease", p.biomarker && "biomarker-selected"].filter(Boolean).join(", ") || "—"}<span className="sub">Disease area {p.labels.area}; drug type {p.labels.modality}; {p.labels.rare}; {p.labels.biomarker}.</span></dd></>}
                    <dt>Probability of approval</dt><dd className="mono">{Math.round((p.odds?.loa ?? POS[p.ph]) * 100)}%{p.odds ? <span className="sub">{p.odds.area}{p.odds.factors.length ? `; ${p.odds.factors.join(", ").toLowerCase()}` : ""}</span> : null}</dd>
                    <dt>Peak sales estimate</dt><dd className="mono">{money(p.peak)}{p.est ? <span className="sub inline"> placeholder</span> : null}</dd>
                    <dt>Risk-adjusted value</dt><dd className="mono strong">{money(v)}</dd>
                  </dl>
                </article>
              );
            })}
          </div>
          {(c.rivals || []).length > 0 && (
            <>
              <h3 className="subhead">Rival trials that could move {c.t}</h3>
              <ul className="watch">
                {c.rivals.slice(0, 6).map((r) => <li key={r.nct}><b>{r.drugs.join(", ")}</b> from {r.sponsor} ({r.ph}{r.china ? `, ${r.china === "only" ? "China only" : "includes China"}` : ""}), in {r.ind}; completes {r.pcd ? fmtDate(r.pcd) : "date not given"}. <a className="src" href={`https://clinicaltrials.gov/study/${r.nct}`} target="_blank" rel="noreferrer">{r.nct}</a></li>)}
              </ul>
            </>
          )}
        </section>
      )}

      {tab === "catalysts" && (
        <section className="panel">
          <header className="ph"><h2>Catalyst calendar</h2><span className="ph-note">Dated events only.</span></header>
          <div className="timeline">
            {[...c.catalysts].sort((a, b) => days(a.date) - days(b.date)).map((x, i) => {
              const d = days(x.date);
              return (
                <div key={i} className={"tl " + (d < 0 ? "past" : "")}>
                  <div className="tl-dot" style={{ background: CAT_KIND[x.kind].c }} />
                  <div className="tl-date mono">{fmtDate(x.date)}</div>
                  <div className="tl-body">
                    <div className="tl-label">{x.label}</div>
                    <div className="sub">{CAT_KIND[x.kind].label}{x.drug ? ` · ${x.drug}` : ""}{x.est ? " · estimated date" : ""}</div>
                  </div>
                  <div className={"tl-days mono " + (d >= 0 && d <= 45 ? "warn" : "")}>{d < 0 ? "reported" : `${d}d`}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === "valuation" && (
        <div className="stack">
          <section className="panel">
            <header className="ph"><h2>Risk-adjusted pipeline value</h2>
              <span className="ph-note">Adjust the assumptions to test the model. This is not a price target.</span></header>
            <div className="two">
              <label className="f wide"><span>Discount rate {disc}%</span>
                <input type="range" min="6" max="20" value={disc} onChange={(e) => setDisc(+e.target.value)} /></label>
              <label className="f wide"><span>Adjust every probability of success by {posAdj > 0 ? "+" : ""}{posAdj} points</span>
                <input type="range" min="-10" max="10" value={posAdj} onChange={(e) => setPosAdj(+e.target.value)} /></label>
            </div>
            <div className="chart">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={c.pipeline.map((p) => ({
                  name: p.d,
                  value: rnpv(p, { discount: disc / 100, posOverride: Math.max(0.01, (p.odds?.loa ?? POS[p.ph]) + posAdj / 100) }),
                  ph: p.ph,
                }))} margin={{ top: 10, right: 16, bottom: 10, left: 8 }}>
                  <CartesianGrid stroke="#DCE2E5" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#5A6B76" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#5A6B76" }} tickFormatter={(v) => `$${v}M`} />
                  <Tooltip formatter={(v) => [`$${Math.round(v)}M`, "Risk-adjusted value"]} />
                  <Bar dataKey="value">
                    {c.pipeline.map((p) => <Cell key={p.d} fill={PHASE_COLOR[p.ph]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="metrics two-up">
              <div className="metric"><span>Modeled pipeline value</span><b className="mono">{money(c.pipeline.reduce((s, p) => s + rnpv(p, { discount: disc / 100, posOverride: Math.max(0.01, (p.odds?.loa ?? POS[p.ph]) + posAdj / 100) }), 0))}</b></div>
              <div className="metric"><span>Enterprise value today</span><b className="mono">{money(c.ev)}</b></div>
              <div className="metric"><span>Enterprise value as a share of modeled value</span><b className="mono">{num((c.ev / pv) * 100, 0)}%</b></div>
              <div className="metric"><span>Cash per share</span><b className="mono">${num(c.cash / c.shares, 2)}</b></div>
            </div>
          </section>
          <EquityRangePanel c={c} />
          <ScenarioPanel c={c} />
        </div>
      )}

      {tab === "score" && (
        <section className="panel">
          <header className="ph"><h2>Score breakdown</h2>
            <span className="ph-note">A research framework, not a prediction.</span></header>
          <div className="scorewrap">
            <div className="bigscore"><span className="mono">{score}</span><small>out of 100</small></div>
            <div className="scorelist">
              {WEIGHTS.map(([label, key, w]) => (
                <div key={key} className="scorerow">
                  <span className="sl">{label}<em>{Math.round(w * 100)}% weight</em></span>
                  <Bar100 v={parts[key]} color={PHASE_COLOR[PHASES[Math.min(6, Math.floor(parts[key] / 16))]]} />
                  <span className="mono sv">{Math.round(parts[key])}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Catalysts({ go }) {
  const [kind, setKind] = useState("All");
  const events = useMemo(() => {
    const all = [];
    COMPANIES.forEach((c) => c.catalysts.forEach((x) => all.push({ ...x, c })));
    return all.filter((e) => days(e.date) >= -60 && (kind === "All" || e.kind === kind))
      .sort((a, b) => days(a.date) - days(b.date));
  }, [kind]);

  const byMonth = useMemo(() => {
    const m = {};
    events.forEach((e) => {
      const k = new Date(e.date + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
      (m[k] = m[k] || []).push(e);
    });
    return m;
  }, [events]);

  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Catalyst calendar</h2><span className="ph-note">All dated events, by month.</span></header>
        <div className="chips">
          {["All", ...Object.keys(CAT_KIND)].map((k) => (
            <button key={k} className={"chip " + (kind === k ? "on" : "")} onClick={() => setKind(k)}
              style={kind === k && k !== "All" ? { background: CAT_KIND[k].c, borderColor: CAT_KIND[k].c } : {}}>
              {k === "All" ? "All events" : CAT_KIND[k].label}
            </button>
          ))}
        </div>
        {Object.entries(byMonth).map(([month, list]) => (
          <div key={month} className="month">
            <h3 className="monthhead">{month}<span className="mono">{list.length}</span></h3>
            {list.map((e, i) => {
              const d = days(e.date);
              return (
                <button key={i} className={"evrow " + (d < 0 ? "past" : "")} onClick={() => go("company", e.c.t)}>
                  <span className="ev-date mono">{fmtDate(e.date).replace(", " + new Date(e.date + "T00:00:00").getFullYear(), "")}</span>
                  <span className="ev-kind" style={{ background: CAT_KIND[e.kind].c }} />
                  <span className="tick">{e.c.t}</span>
                  <span className="ev-label">{e.label}{e.lo && e.hi ? <span className="sub">likely {fmtDate(e.lo)} to {fmtDate(e.hi)}{e.reg ? `; registry date ${fmtDate(e.reg)}` : ""}</span> : null}</span>
                  <span className="ev-run mono">{num(runway(e.c), 0)} mo cash</span>
                  <span className={"ev-days mono " + (d >= 0 && d <= 45 ? "warn" : "")}>{d < 0 ? "reported" : `${d}d`}</span>
                </button>
              );
            })}
          </div>
        ))}
      </section>
    </div>
  );
}

function Compare() {
  const [sel, setSel] = useState(() => COMPANIES.slice(0, 3).map((c) => c.t));
  const set = (i, v) => setSel(sel.map((s, j) => (j === i ? v : s)));
  const cols = sel.map((t) => findCo(t)).filter(Boolean);

  const rows = [
    ["Therapeutic area", (c) => c.area],
    ["Most advanced program", (c) => leadProgram(c).ph],
    ["Programs", (c) => c.pipeline.length],
    ["Market cap", (c) => money(c.mcap), 1],
    ["Enterprise value", (c) => money(c.ev), 1],
    ["Cash", (c) => money(c.cash), 1],
    ["Debt", (c) => (c.debt ? money(c.debt) : "None"), 1],
    ["Monthly burn", (c) => (c.cashFlowPositive ? "Cash-generating" : `$${num(c.burn)}M`), 1],
    ["Runway", (c) => (c.cashFlowPositive ? "Not needed" : `${num(runway(c))} mo`), 1],
    ["Next catalyst", (c) => (nextCatalyst(c) ? `${days(nextCatalyst(c).date)}d` : "—"), 1],
    ["Pipeline rNPV", (c) => money(pipelineValue(c)), 1],
    ["EV / rNPV", (c) => `${num((c.ev / pipelineValue(c)) * 100, 0)}%`, 1],
    ["Institutional ownership", (c) => (c.own == null ? "—" : `${num(c.own, 0)}%`), 1],
    ["Financing Pressure Score", (c) => <BandBadge c={c} />],
    ["Runway-to-catalyst gap", (c) => fmtGap(fpsOf(c).gap), 1],
    ["Raise-ready capacity", (c) => capacityLabel(c)],
    ["Research score", (c) => { const v = bis(c); return Number.isFinite(v) ? v : "—"; }, 1],
  ];

  return (
    <section className="panel">
      <header className="ph"><h2>Compare</h2><span className="ph-note">Up to three companies side by side.</span></header>
      <table className="grid compare">
        <thead>
          <tr>
            <th className="lbl">Metric</th>
            {sel.map((s, i) => (
              <th key={i}>
                <select value={s} onChange={(e) => set(i, e.target.value)}>
                  <optgroup label="Coverage">{COMPANIES.map((c) => <option key={c.t} value={c.t}>{c.t} — {c.n}</option>)}</optgroup>
                  {SEGMENTS.map(([g, l]) => { const cs = INDUSTRY.filter((c) => c.group === g); return cs.length ? <optgroup key={g} label={l}>{cs.map((c) => <option key={c.t} value={c.t}>{c.t} — {c.n}</option>)}</optgroup> : null; })}
                </select>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, fn, mono]) => (
            <tr key={label}>
              <td className="lbl">{label}</td>
              {cols.map((c) => <td key={c.t} className={mono ? "mono r" : "r"}>{fn(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Ask() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const { mount: tsMount, token: tsToken, ready: tsReady, used: tsUsed } = useHumanCheck();

  const suggestions = [
    "Which companies may need financing within 12 months?",
    `Compare ${COMPANIES.slice(0, 3).map((c) => c.t).join(", ").replace(/, ([^,]*)$/, " and $1")} on financing risk.`,
    "Which Phase III oncology programs read out first?",
    "Which companies have an at-the-market program and under 18 months of cash?",
  ];


  const local = (question) => {
    const ql = question.toLowerCase();
    const hits = COMPANIES.filter((c) => ql.includes(c.t.toLowerCase()));
    const pool = hits.length ? hits : COMPANIES;
    if (ql.includes("financ") || ql.includes("runway") || ql.includes("dilut")) {
      const list = [...pool].sort((a, b) => runway(a) - runway(b)).slice(0, 4);
      return "Sorted by months of cash on hand:\n\n" + list.map((c) =>
        `${c.t} — ${num(runway(c))} months (${money(c.cash)} cash, $${num(c.burn)}M monthly burn). Next event: ${nextCatalyst(c) ? `${nextCatalyst(c).label}, ${days(nextCatalyst(c).date)} days out` : "none dated"}.`
      ).join("\n") + "\n\nAnything under twelve months should be assumed to raise before the readout, which usually means pricing at a discount.";
    }
    if (ql.includes("oncolog") || ql.includes("phase iii") || ql.includes("phase 3")) {
      const progs = [];
      pool.forEach((c) => c.pipeline.forEach((p) => { if (phaseRank(p.ph) >= 4) progs.push({ c, p }); }));
      progs.sort((a, b) => days(a.p.ro) - days(b.p.ro));
      return "Late-stage programs by readout date:\n\n" + progs.slice(0, 6).map(({ c, p }) =>
        `${c.t} ${p.d} — ${p.ph}, ${p.ind}. Expected ${fmtDate(p.ro)} (${days(p.ro)} days).`).join("\n");
    }
    const list = [...pool].sort((a, b) => bis(b) - bis(a)).slice(0, 5);
    return "By composite score:\n\n" + list.map((c) =>
      `${c.t} — score ${bis(c)}. ${money(c.cash)} cash, ${num(runway(c))} months runway, enterprise value ${money(c.ev)} against modeled pipeline value of ${money(pipelineValue(c))}.`).join("\n");
  };

  const send = async (question) => {
    const text = (question ?? q).trim();
    if (!text || busy || !tsReady) return;
    setQ("");
    setLog((l) => [...l, { role: "user", text }]);
    setBusy(true);
    try {
      // The API key lives in the serverless function (api/ask.js), never in the browser.
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only the question is sent; the server builds the data from the published data file.
        body: JSON.stringify({ question: text, turnstileToken: tsToken }),
      });
      tsUsed();
      if (res.status === 429) {
        setLog((l) => [...l, { role: "ai", text: "That's a lot of questions in a short time. Wait a minute and ask again.", fallback: true }]);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(`ask endpoint returned ${res.status}`);
      const data = await res.json();
      const out = (data.text || "").trim();
      setLog((l) => [...l, { role: "ai", text: out || local(text), traced: true }]);
    } catch {
      setLog((l) => [...l, { role: "ai", text: local(text), fallback: true }]);
    }
    setBusy(false);
  };

  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Ask</h2>
          <span className="ph-note">Answers use only the figures on this site.</span></header>
        {log.length === 0 && (
          <div className="sugg">
            {suggestions.map((s) => <button key={s} disabled={!tsReady} onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        <div className="log">
          {log.map((m, i) => (
            <div key={i} className={"msg " + m.role}>
              {m.role === "ai" && <span className="msg-tag">{m.fallback ? "Answered from the local dataset" : "Answered from the terminal dataset"}</span>}
              <div className="msg-body">{m.text}</div>
            </div>
          ))}
          {busy && <div className="msg ai"><div className="msg-body dim">Reading the dataset…</div></div>}
        </div>
        <div className="askbar">
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask about runway, catalysts, valuation, or a specific ticker" />
          <button onClick={() => send()} disabled={busy || !q.trim() || !tsReady}>{tsReady ? "Ask" : "Checking…"}</button>
        </div>
        <div ref={tsMount} className="ts-box" />
      </section>
    </div>
  );
}

/* ------------------------- financing pressure -------------------------
   The Financing Pressure Score (see src/fps.js) and everything built on it:
   the Raise List, the Pressure Report, the About us page, the public
   track record and the waitlist.                                        */

const FPS_CACHE = new Map();
const fpsOf = (c) => {
  if (!FPS_CACHE.has(c.t)) FPS_CACHE.set(c.t, computeFPS(c, TODAY));
  return FPS_CACHE.get(c.t);
};
const BAND_COLOR = { High: "#9E2140", Elevated: "#B8730F", Low: "#12706B" };
const capacityLabel = (c) => (!c.raise ? "—" : c.raise.capacity === "atm" ? "Active ATM" : c.raise.capacity === "shelf" ? "Shelf only" : "None found");
const byPressure = () => [...COMPANIES].sort((a, b) => (fpsOf(b).score ?? -1) - (fpsOf(a).score ?? -1));
const fmtGap = (g) => { const r = Math.round(g); return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)} mo`; };
const OFFERING = /424B4|424B5|Priced offering|Shelf takedown/;

function BandBadge({ c, size }) {
  const f = fpsOf(c);
  if (f.score == null) return <span className="sub inline">—</span>;
  return (
    <span className={"fps fps-" + f.band.toLowerCase() + (size === "lg" ? " lg" : "")} title={`Financing Pressure Score ${f.score} of 100, ${f.band} band`}>
      <b>{f.score}</b><span>{f.band}</span>
    </span>
  );
}

// Every company placed on the 0–100 Financing Pressure scale, with the band zones behind it.
function PressureRail({ go }) {
  const all = byPressure().map((c) => ({ c, s: fpsOf(c).score, band: fpsOf(c).band })).filter((p) => p.s != null);
  // With many companies, label only the highest-pressure ones; the rest are dots you can hover or select.
  const labeled = new Set(all.slice(0, all.length > 12 ? 7 : all.length).map((p) => p.c.t));
  const pts = all.filter((p) => labeled.has(p.c.t)).sort((a, b) => a.s - b.s);
  const dots = [...all].sort((a, b) => a.s - b.s);
  // Labels that would collide go into a second or third lane.
  const lanesEnd = [];
  pts.forEach((p) => {
    let lane = lanesEnd.findIndex((end) => p.s - end >= 9);
    if (lane === -1 && lanesEnd.length < 3) lane = lanesEnd.length;
    if (lane === -1) { p.hide = true; return; } // no room: the dot stays, the label doesn't
    lanesEnd[lane] = p.s;
    p.lane = lane;
  });
  const lanes = Math.max(1, lanesEnd.length);
  return (
    <div className="rail" style={{ "--lanes": lanes }}>
      <div className="rail-labels" aria-hidden="true">
        {pts.filter((p) => !p.hide).map((p) => (
          <span key={p.c.t} className={"rail-tag b-" + p.band.toLowerCase()} style={{ left: `${p.s}%`, "--lane": p.lane }}>{p.c.t}</span>
        ))}
      </div>
      <div className="rail-track">
        {FPS_BANDS.map((b) => (
          <span key={b.label} className={"rail-zone z-" + b.label.toLowerCase()} style={{ left: `${b.min}%`, width: `${(b.max === 100 ? 100 : b.max + 1) - b.min}%` }}>
            <em>{b.label}</em>
          </span>
        ))}
        {dots.map((p) => (
          <button key={p.c.t} className={"rail-dot b-" + p.band.toLowerCase() + (labeled.has(p.c.t) ? "" : " quiet")} style={{ left: `${p.s}%` }}
            onClick={() => go("company", p.c.t, "pressure")}
            aria-label={`${p.c.n}: Financing Pressure Score ${p.s}, ${p.band}`} title={`${p.c.t} ${p.s} · ${p.band}`} />
        ))}
      </div>
      <div className="rail-axis" aria-hidden="true"><span>0</span><span>40</span><span>70</span><span>100</span></div>
      {dots.length > pts.length && <p className="rail-note">{dots.length} companies; the most pressed are labeled. Hover over or tap any dot.</p>}
    </div>
  );
}

function FpsChart({ go, height }) {
  const data = byPressure().map((c) => ({ t: c.t, n: c.n, s: fpsOf(c).score ?? 0, band: fpsOf(c).band }));
  return (
    <ResponsiveContainer width="100%" height={height || Math.max(220, data.length * 34 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 18, left: 4 }} barCategoryGap={6}>
        <CartesianGrid stroke="#E4E9EB" horizontal={false} />
        <XAxis type="number" domain={[0, 100]} ticks={[0, 20, 40, 60, 70, 80, 100]} tick={{ fontSize: 11, fill: "#5E6B73" }}
          label={{ value: "Financing Pressure Score", position: "insideBottom", offset: -10, fontSize: 11, fill: "#5E6B73" }} />
        <YAxis type="category" dataKey="t" width={52} tick={{ fontSize: 12, fill: "#151D22", fontWeight: 700 }} axisLine={false} tickLine={false} />
        <ReferenceLine x={40} stroke="#B8730F" strokeDasharray="4 3" label={{ value: "Elevated", position: "top", fontSize: 10, fill: "#8A5609" }} />
        <ReferenceLine x={70} stroke="#9E2140" strokeDasharray="4 3" label={{ value: "High", position: "top", fontSize: 10, fill: "#9E2140" }} />
        <Tooltip cursor={{ fill: "rgba(14,42,46,.05)" }} content={({ payload }) => {
          if (!payload || !payload.length) return null;
          const d = payload[0].payload;
          return <div className="rtip"><b>{d.t}</b> {d.n}<br />Score {d.s} of 100, {d.band}</div>;
        }} />
        <Bar dataKey="s" radius={[0, 3, 3, 0]} onClick={(d) => go && go("company", d.t, "pressure")} style={{ cursor: go ? "pointer" : "default" }}
          label={{ position: "right", fontSize: 12, fill: "#151D22", fontWeight: 600 }} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.t} fill={BAND_COLOR[d.band]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function RaiseList({ go }) {
  const ranked = byPressure();
  const high = ranked.filter((c) => fpsOf(c).band === "High");
  const elevated = ranked.filter((c) => fpsOf(c).band === "Elevated");
  const row = (c) => {
    const f = fpsOf(c);
    return (
      <li key={c.t}>
        <button onClick={() => go("company", c.t, "pressure")}>
          <span className="rl-t">{c.t}</span>
          <span className="rl-n">{c.n}<em>{f.runway >= 120 ? "10+ years" : `${Math.round(f.runway)} months`} of cash · {f.catalyst ? `${plainLabel(f.catalyst.label)} in ~${Math.round(f.monthsToCatalyst)} months` : "nothing big on the calendar"}</em></span>
          <BandBadge c={c} />
        </button>
      </li>
    );
  };
  return (
    <div className="raiselist">
      <h3 className="rl-h">Raise List</h3>
      <p className="rl-note">Companies scoring 70 or higher. We check six months later whether each one raised money, and publish the result.</p>
      {high.length ? <ul>{high.map(row)}</ul> : <p className="rl-empty">No company scores 70 or higher today.</p>}
      {elevated.length > 0 && (<><h4 className="rl-sub">Elevated, 40 to 69</h4><ul>{elevated.map(row)}</ul></>)}
    </div>
  );
}

function FpsPanel({ c, go }) {
  const f = fpsOf(c);
  if (f.score == null) return <section className="panel"><p className="empty">Not enough data to score this company yet.</p></section>;
  const q = c.src?.filing;
  const cat = f.catalyst;
  const prog = cat ? c.pipeline.find((p) => p.d === cat.drug) : null;
  const atmUrl = c.raise?.atm?.url || c.raise?.shelf?.url;
  const interp = f.band === "High"
    ? "It will very likely sell new shares around its next big event, and existing holders would be diluted."
    : f.band === "Elevated"
      ? "A raise before or soon after its next big event is quite possible. Watch for offering filings."
      : "Its cash comfortably covers the next big event, so it's under little pressure to raise soon.";
  const steps = [
    ["Source data", `Cash and investments: ${money(c.cash)}`, q ? <ExtLink href={q.url}>{q.form} balance sheet, {fmtDate(c.src.asOf)}</ExtLink> : "Latest filing"],
    ["Source data", c.cashFlowPositive ? "Operating cash flow is positive" : `Operating cash burn: ${money(c.burn * 3)} a quarter (${money(c.burn)} a month)`, q ? <ExtLink href={q.url}>Cash-flow statement, trailing twelve months</ExtLink> : "Latest filing"],
    ["Calculated", `Runway ≈ ${fmtRunway(f.runway, "months")}`, c.cashFlowPositive ? "Cash flow positive" : `${money(c.cash)} ÷ ${money(c.burn)} a month`],
    ["Source data", cat ? `${shortLabel(cat.label)}: ${fmtDate(cat.date)}` : `No dated catalyst; ${NO_CATALYST_MONTHS} months assumed`, prog?.nct ? <ExtLink href={`https://clinicaltrials.gov/study/${prog.nct}`}>ClinicalTrials.gov {prog.nct}</ExtLink> : cat ? "Company guidance" : "Methodology default"],
    ["Calculated", `Catalyst gap ≈ ${fmtGap(f.gap)}`, `${num(f.runway, 0)} − (${num(f.monthsToCatalyst, 0)} + ${BUFFER_MONTHS})`],
    ["Source data", c.raise ? (c.raise.capacity === "atm" ? `Active ATM program (${c.raise.atm.phrase})` : c.raise.capacity === "shelf" ? "Shelf registration, no ATM found" : "No shelf or ATM found") : "Not available", atmUrl ? <ExtLink href={atmUrl}>{c.raise.capacity === "atm" ? c.raise.atm.form : c.raise.shelf.form} filing</ExtLink> : "SEC filing index, past three years"],
    ["Interpretation", interp, "Generated from the figures above; no buy or sell view"],
  ];
  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Financing Pressure Score</h2>
          <span className="ph-note">How likely {c.n} is to need new money before its next big event.</span></header>
        <div className="fps-head">
          <BandBadge c={c} size="lg" />
          <p>{interp} {f.missing.length > 0 && <span className="sub inline">Scored on {f.coverage}% of the weights; not available: {f.missing.join(", ").toLowerCase()}.</span>}</p>
        </div>
        <h3 className="subhead">How the score traces to the filings</h3>
        <div className="tablewrap">
          <table className="grid plain trace">
            <thead><tr><th>Step</th><th>Value</th><th>Where it comes from</th></tr></thead>
            <tbody>{steps.map(([a, b, d], i) => <tr key={i}><td className="sub-c">{a}</td><td>{b}</td><td className="sub-c">{d}</td></tr>)}</tbody>
          </table>
        </div>
        <h3 className="subhead">Score breakdown</h3>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Component</th><th className="r">Weight</th><th className="r">Component score</th><th className="r">Contribution</th><th>Basis</th></tr></thead>
            <tbody>
              {f.parts.map((p) => (
                <tr key={p.key} className={p.present ? "" : "dim"}>
                  <td>{p.label}</td>
                  <td className="r mono">{Math.round(p.weight * 100)}%</td>
                  <td className="r mono">{p.present ? p.score : "—"}</td>
                  <td className="r mono">{p.present ? num(p.contribution) : "—"}</td>
                  <td className="sub-c">{p.present ? (p.url ? <ExtLink href={p.url}>{p.detail}</ExtLink> : p.detail) : "Not available"}</td>
                </tr>
              ))}
              <tr className="total"><td>Total</td><td className="r mono">100%</td><td /><td className="r mono">{f.score}</td><td /></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <header className="ph"><h2>What to watch next quarter</h2></header>
        <ul className="watch">
          <li>Any filing announcing an offering, a private placement or share sales through its ATM program.</li>
          <li>Whether spending keeps rising before {cat ? plainLabel(cat.label) : "its next big event"}{f.parts.find((p) => p.key === "trend")?.present ? ` (it's ${f.parts.find((p) => p.key === "trend").value >= 0 ? "up" : "down"} ${num(Math.abs(f.parts.find((p) => p.key === "trend").value), 0)}% on a year ago)` : ""}.</li>
          <li>Any change to the expected date of that event, which would move the score.</li>
          <li>New partnerships, grants or loans: money that doesn't mean selling shares, which would ease the pressure.</li>
        </ul>
        {go && <button className="morelink" onClick={() => go("method")}>How the score is calculated</button>}
      </section>
    </div>
  );
}

/* ---------------------------- human check ----------------------------
   Cloudflare Turnstile on the forms that cost money or collect data.
   It stays off until TURNSTILE_SITE_KEY is set in Cloudflare; then most
   visitors see nothing, and only suspicious traffic gets a challenge.   */

let TS_KEY; // undefined = not looked up yet, null = off
let TS_SCRIPT;
async function turnstileKey() {
  if (TS_KEY === undefined) {
    try { TS_KEY = ((await (await fetch("/api/config")).json()).turnstileSiteKey || "").trim() || null; } catch { TS_KEY = null; }
  }
  return TS_KEY;
}
function loadTurnstile() {
  if (!TS_SCRIPT) TS_SCRIPT = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    el.async = true;
    el.onload = () => resolve(window.turnstile);
    el.onerror = reject;
    document.head.appendChild(el);
  });
  return TS_SCRIPT;
}
function useHumanCheck() {
  const [el, setEl] = useState(null); // the box the widget draws into (a callback ref)
  const [on, setOn] = useState(false);
  const [token, setToken] = useState(null);
  const [widget, setWidget] = useState(null);
  useEffect(() => {
    if (!el) return;
    const h = { live: true, id: null };
    turnstileKey().then(async (key) => {
      if (!key || !h.live) return;
      setOn(true);
      const ts = await loadTurnstile();
      if (!h.live) return;
      h.id = ts.render(el, {
        sitekey: key, appearance: "interaction-only",
        callback: setToken, "expired-callback": () => setToken(null), "error-callback": () => setToken(null),
      });
      setWidget(h.id);
    }).catch(() => setOn(false));
    return () => { h.live = false; if (h.id != null && window.turnstile) window.turnstile.remove(h.id); };
  }, [el]);
  // Each token works once; get a fresh one after every submission.
  const used = () => { setToken(null); if (widget != null && window.turnstile) window.turnstile.reset(widget); };
  return { mount: setEl, token, ready: !on || !!token, used };
}

function Waitlist({ compact, band }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [state, setState] = useState("idle");
  const { mount: tsMount, token: tsToken, ready: tsReady, used: tsUsed } = useHumanCheck();
  const submit = async (e) => {
    e.preventDefault();
    if (!tsReady) return;
    setState("sending");
    try {
      // Sign-ups are stored in Cloudflare D1 by functions/api/waitlist.js.
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, botField: "", turnstileToken: tsToken }),
      });
      tsUsed();
      setState(res.ok ? "done" : "error");
    } catch { setState("error"); }
  };
  if (state === "done") return <div className={"waitlist" + (compact ? " compact" : "")}><p className="wl-done">You're on the list. The next Financing Pressure Report will come to {email}.</p></div>;
  return (
    <form className={"waitlist" + (compact ? " compact" : "") + (band ? " in-band" : "")} name="waitlist" onSubmit={submit}>
      {!band && <h3>Get the Financing Pressure Report by email</h3>}
      {!compact && !band && <p>A short note when the Raise List changes, with every number linked to its filing. No hype, no stock picks.</p>}
      <div className="wl-fields">
        <label className="sr" htmlFor={"wl-email" + (compact ? "-c" : "")}>Email</label>
        <input id={"wl-email" + (compact ? "-c" : "")} type="email" name="email" required placeholder="you@fund.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="sr" htmlFor={"wl-role" + (compact ? "-c" : "")}>Your role</label>
        <select id={"wl-role" + (compact ? "-c" : "")} name="role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Your role (optional)</option>
          <option>Fund analyst or PM</option>
          <option>Family office</option>
          <option>Independent investor</option>
          <option>Biotech operator</option>
          <option>Other</option>
        </select>
        <button type="submit" disabled={state === "sending" || !tsReady}>{state === "sending" ? "Joining…" : tsReady ? "Join the waitlist" : "Checking…"}</button>
      </div>
      <div ref={tsMount} className="ts-box" />
      {state === "error" && <p className="wl-err">That didn't go through. Check your connection and try again.</p>}
      <p className="wl-fine">We'll only email you about Helixora. Unsubscribe any time. <a className="src" href="#privacy">How we handle your email</a></p>
    </form>
  );
}

// Public track record: every company flagged at 70+, and whether it filed an offering within six months.
function trackRecord() {
  const firstFlag = {};
  for (const snap of HISTORY.snapshots || []) {
    for (const [t, v] of Object.entries(snap.scores || {})) {
      if (v.fps != null && v.fps >= 70 && !firstFlag[t]) firstFlag[t] = snap.date;
    }
  }
  const rows = Object.entries(firstFlag).map(([t, date]) => {
    const c = COMPANIES.find((x) => x.t === t);
    const due = new Date(Date.parse(date) + 183 * 86400000).toISOString().slice(0, 10);
    const raise = (c?.financings || []).filter((f) => f.date >= date && f.date <= due && OFFERING.test(f.type || "")).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    const status = raise ? "raised" : TODAY.toISOString().slice(0, 10) > due ? "missed" : "pending";
    return { t, n: c?.n || t, date, due, raise, status, daysToRaise: raise ? Math.round((Date.parse(raise.date) - Date.parse(date)) / 86400000) : null };
  });
  const q = (d) => `Q${Math.floor(new Date(d).getUTCMonth() / 3) + 1} ${new Date(d).getUTCFullYear()}`;
  const quarters = {};
  rows.forEach((r) => { (quarters[q(r.date)] = quarters[q(r.date)] || []).push(r); });
  return { rows, quarters, since: (HISTORY.snapshots || [])[0]?.date };
}

function TrackRecord({ go }) {
  const { rows, quarters, since } = trackRecord();
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  return (
    <section className="panel" id="track-record">
      <header className="ph"><h2>Track record</h2>
        <span className="ph-note">Every company that reaches the Raise List, and whether it filed an equity offering within six months. Misses stay on the page.</span></header>
      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr><th>Quarter flagged</th><th className="r">Companies flagged (70+)</th><th className="r">Raised within 6 months</th><th className="r">Still open</th><th className="r">Hit rate</th><th className="r">Median days to raise</th></tr></thead>
          <tbody>
            {Object.keys(quarters).length === 0 && <tr><td colSpan="6" className="empty">No company has reached 70 since scoring began{since ? ` on ${fmtDate(since)}` : ""}. The first flags will appear here.</td></tr>}
            {Object.entries(quarters).map(([qt, list]) => {
              const decided = list.filter((r) => r.status !== "pending");
              const hits = list.filter((r) => r.status === "raised");
              return (
                <tr key={qt}>
                  <td>{qt}</td><td className="r mono">{list.length}</td><td className="r mono">{hits.length}</td>
                  <td className="r mono">{list.length - decided.length}</td>
                  <td className="r mono">{decided.length ? `${Math.round((hits.length / decided.length) * 100)}%` : "Due " + fmtDate(list.map((r) => r.due).sort().at(-1))}</td>
                  <td className="r mono">{median(hits.map((r) => r.daysToRaise)) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <ul className="tr-list">
          {rows.map((r) => (
            <li key={r.t}>
              <button className="tick" onClick={() => go("company", r.t, "pressure")}>{r.t}</button> flagged {fmtDate(r.date)}:{" "}
              {r.status === "raised" ? <>raised, <ExtLink href={r.raise.url}>{r.raise.type}</ExtLink> filed {fmtDate(r.raise.date)}</> : r.status === "missed" ? "no offering filed within six months (a miss)" : `open until ${fmtDate(r.due)}`}
            </li>
          ))}
        </ul>
      )}
      <p className="colnote">Scores are recorded every weekday{since ? ` since ${fmtDate(since)}` : ""}. A hit is any priced offering or prospectus supplement (424B4 or 424B5) filed within 183 days of the first flag.</p>
    </section>
  );
}

function PressureReport({ go }) {
  const ranked = byPressure().filter((c) => fpsOf(c).score != null);
  const high = ranked.filter((c) => fpsOf(c).band === "High");
  const top = ranked[0];
  const tf = top ? fpsOf(top) : null;
  const edition = LIVE ? fmtDate(META.generatedAt.slice(0, 10)) : fmtDate(TODAY.toISOString().slice(0, 10));
  const topTrend = tf?.parts.find((p) => p.key === "trend");
  const capPhrase = top?.raise?.capacity === "atm" ? ", and it already has an at-the-market program it can sell shares through" : top?.raise?.capacity === "shelf" ? ", with a shelf registration on file" : "";
  const headline = top && !tf.catalyst
    ? `Top of the list this week: ${top.n}. It has ${monthsSay(tf.runway)} of cash and no trial result or FDA decision on the calendar. ${topTrend?.present && topTrend.value > 10 ? `It's spending ${Math.round(topTrend.value)}% more than a year ago` : "Its spending is steady"}${capPhrase}.`
    : top
    ? `Top of the list this week: ${top.n}. It has ${monthsSay(tf.runway)} of cash${tf.catalyst ? `, and ${plainLabel(tf.catalyst.label)} is ${monthsSay(tf.monthsToCatalyst)} away` : ""}, ${Math.round(tf.gap) <= 0 ? "which leaves almost no cushion once the news is out" : `which leaves about ${Math.round(tf.gap)} months to spare after a ${BUFFER_MONTHS}-month cushion`}${capPhrase}.`
    : "";
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">The Financing Pressure Report, edition of {edition}</p>
        <h1 className="report-h">{high.length} of {ranked.length} companies {high.length === 1 ? "has" : "have"} high financing pressure</h1>
        <p className="lead-dek">{headline}</p>
        <p className="byline">Built from SEC filings, ClinicalTrials.gov and market prices. Every figure links to its source on the company pages.</p>
      </section>

      <div className="two wide-left">
        <section className="panel">
          <header className="ph"><h2>Financing Pressure Score by company</h2><span className="ph-note">Dashed lines mark the Elevated (40) and High (70) bands.</span></header>
          <FpsChart go={go} />
        </section>
        <section className="panel"><RaiseList go={go} /></section>
      </div>

      <section className="panel">
        <header className="ph"><h2>Ranked table</h2></header>
        <div className="tablewrap">
          <table className="grid">
            <thead><tr><th>Company</th><th>Area and stage</th><th className="r">Cash</th><th className="r">Qtr burn</th><th className="r">Runway</th><th>Next catalyst</th><th className="r">Gap</th><th>Raise capacity</th><th className="r">Score</th></tr></thead>
            <tbody>
              {ranked.map((c) => {
                const f = fpsOf(c);
                return (
                  <tr key={c.t} onClick={() => go("company", c.t, "pressure")}>
                    <td><span className="tick">{c.t}</span><span className="sub">{c.n}</span></td>
                    <td>{c.area}<span className="sub">{leadProgram(c)?.ph}</span></td>
                    <td className="r mono">{money(c.cash)}</td>
                    <td className="r mono">{c.cashFlowPositive ? "Positive" : money(c.burn * 3)}</td>
                    <td className="r mono nowrap">{fmtRunway(f.runway)}</td>
                    <td>{f.catalyst ? <>{shortLabel(f.catalyst.label)}<span className="sub">in {num(f.monthsToCatalyst, 0)} mo</span></> : <span className="sub inline">None dated</span>}</td>
                    <td className={"r mono nowrap " + (f.gap < 0 ? "neg" : "")}>{fmtGap(f.gap)}</td>
                    <td>{capacityLabel(c)}</td>
                    <td className="r"><BandBadge c={c} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="colnote">Gap = runway minus (months to catalyst + {BUFFER_MONTHS}-month buffer). Negative means the company is likely to need money before, or soon after, its catalyst.</p>
      </section>

      <SurvivalMonitor go={go} />
      {top && (<><h2 className="section-h">Company spotlight: {top.n}</h2><FpsPanel c={top} go={go} /></>)}

      <p className="disclaimer">This report is general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.</p>
    </div>
  );
}

const PILLARS = [
  ["Financing risk first", "We tell you who's likely to raise money, and when.", "The Financing Pressure Score and the Raise List"],
  ["Every number traced", "Tap any figure and see the filing it came from.", "Source links on every metric and a published methodology"],
  ["Built for the middle", "Serious biotech analysis without a terminal-sized bill.", "Free to use while in early access"],
  ["Honest about uncertainty", "We publish our misses as well as our hits.", "A public, scored track record"],
];

/* ------------------------------ research ------------------------------ */

const pct = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${signed(x * 100, d)}%`);
const pctCls = (x) => (x == null ? "" : x > 0 ? "chg up" : x < 0 ? "chg down" : "chg flat");
const mo = (m) => (m == null ? "Cash flow positive" : m >= 120 ? "10+ years" : `${num(m, 0)} months`);
const CAPACITY = { atm: "Yes, ATM on file", shelf: "Shelf on file", none: "No shelf found" };

const PITFALLS = [
  ["Look-ahead bias", "Using information that wasn't public yet.", "Cash left at each offering uses only the last balance sheet filed before it. Price moves start from the close before the first offering filing. Scores are saved each day as published and never recalculated."],
  ["Survivorship bias", "Studying only companies that are still around.", "The study covers today's tracked companies, so ones that failed or were bought are missing. That's a known gap; names that leave the list will stay in the history."],
  ["Overfitting", "Tuning a model until it fits the past.", "The score's weights are a published starting point (version 1.0). Any change is logged and judged on data that comes after it."],
  ["Small samples", "Treating a few cases as a pattern.", "Every result shows how many offerings it rests on. Nothing here is called a signal before it holds across far more companies and years."],
];

/* ------------------------------ backtest ------------------------------
   Results of scripts/backtest.mjs: the score run point-in-time on every
   cash-burning biotech that filed with the SEC since 2012, dead ones too. */

function useBacktest() {
  const [bt, setBt] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.BASE_URL}data/backtest.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (live) setBt(j); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return bt;
}

function Backtest() {
  const bt = useBacktest();
  if (!bt) return null;
  const P = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const hi = bt.bands.find((b) => b.band === "High"), lo = bt.bands.find((b) => b.band === "Low");
  const lift = hi && lo && lo.raised12 > 0 ? hi.raised12 / lo.raised12 : null;
  const decData = bt.deciles.map((d, i) => ({ label: `${d.from}–${d.to}`, rate: Math.round(d.raised12 * 100), i }));
  const runData = bt.runwayBuckets.map((b) => ({ label: b.to == null ? `${b.from}+` : `${b.from}–${b.to}`, rate: Math.round(b.raised12 * 100), n: b.n }));
  const yrs = bt.years.filter((y) => y.n >= 50);
  const COMP = { gap: bt.catalystTiming ? "Runway vs the next guided event" : "Cash runway (vs the standard 18-month assumption)", trend: "Burn trend", capacity: "Raise-ready (shelf or ATM)", debt: "Debt due within 24 months", access: "Burn vs public float" };
  return (
    <section className="panel" id="backtest">
      <header className="ph"><h2>Backtest: every biotech since {bt.years[0]?.year}, including the ones that died</h2>
        <span className="ph-note">Updated {fmtDate(bt.generatedAt.slice(0, 10))} · score version {bt.fpsVersion}</span></header>
      <p className="finding">
        We ran today's score on {bt.rows.toLocaleString()} past balance sheets from {bt.companies.toLocaleString()} cash-burning biotechs
        ({bt.companiesNoLongerFiling.toLocaleString()} of which have since stopped filing), using only what had been filed at the time.
        Companies the score put in the High band went on to sell stock within a year {P(hi?.raised12)} of the time, against {P(lo?.raised12)} for the Low band{lift ? `, about ${lift.toFixed(1)} times as often` : ""}. The average was {P(bt.base12)}.
      </p>
      <div className="metrics four">
        <div className="metric"><span>High band: raised within a year</span><b>{P(hi?.raised12)}</b></div>
        <div className="metric"><span>Low band: raised within a year</span><b>{P(lo?.raised12)}</b></div>
        <div className="metric"><span>Ranking accuracy (AUC)</span><b>{bt.auc != null ? bt.auc.toFixed(2) : "—"}</b></div>
        <div className="metric"><span>Cash runway alone (AUC)</span><b>{bt.aucRunwayOnly != null ? bt.aucRunwayOnly.toFixed(2) : "—"}</b></div>
      </div>
      <p className="colnote">AUC: pick one company-quarter that was followed by a raise and one that wasn't. The AUC is how often the score ranks the first one higher. 0.50 is a coin flip; 1.00 is perfect.</p>

      <div className="two">
        <div>
          <h3 className="subh">Share that raised within a year, by score</h3>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={decData} margin={{ top: 16, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#E4E9EB" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: "#5E6B73" }} axisLine={false} tickLine={false} interval={0} />
                <YAxis unit="%" tick={{ fontSize: 11, fill: "#5E6B73" }} width={38} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} formatter={(v) => [`${v}%`, "Raised within a year"]} labelFormatter={(l) => `Score ${l}`} />
                <Bar dataKey="rate" fill="#0E7C74" radius={[3, 3, 0, 0]} label={{ position: "top", fontSize: 10.5, fill: "#2B3439", formatter: (v) => `${v}%` }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="colnote">Each bar is a tenth of all company-quarters, lowest scores on the left.</p>
        </div>
        <div>
          <h3 className="subh">Share that raised within a year, by months of cash left</h3>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={runData} margin={{ top: 16, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#E4E9EB" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5E6B73" }} axisLine={false} tickLine={false} interval={0} />
                <YAxis unit="%" tick={{ fontSize: 11, fill: "#5E6B73" }} width={38} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} formatter={(v) => [`${v}%`, "Raised within a year"]} labelFormatter={(l) => `${l} months of cash`} />
                <Bar dataKey="rate" fill="#5B8DB8" radius={[3, 3, 0, 0]} label={{ position: "top", fontSize: 10.5, fill: "#2B3439", formatter: (v) => `${v}%` }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="colnote">Months of cash at the balance sheet date: cash and investments divided by the past year's average monthly burn.</p>
        </div>
      </div>

      <div className="two">
        <div className="tablewrap">
          <h3 className="subh">By band</h3>
          <table className="grid plain">
            <thead><tr><th>Band</th><th className="num">Company-quarters</th><th className="num">Raised within 6 months</th><th className="num">Within 12 months</th></tr></thead>
            <tbody>{bt.bands.map((b) => <tr key={b.band}><td><b>{b.band}</b></td><td className="num">{b.n.toLocaleString()}</td><td className="num">{P(b.raised6)}</td><td className="num">{P(b.raised12)}</td></tr>)}</tbody>
          </table>
          <h3 className="subh">Which parts of the score carry the signal</h3>
          <table className="grid plain">
            <thead><tr><th>Part</th><th className="num">AUC on its own</th></tr></thead>
            <tbody>{Object.entries(bt.components).map(([k, v]) => <tr key={k}><td>{COMP[k] || k}</td><td className="num">{v.auc != null ? v.auc.toFixed(2) : "—"}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="tablewrap">
          <h3 className="subh">Year by year</h3>
          <table className="grid plain">
            <thead><tr><th>Year</th><th className="num">Quarters</th><th className="num">Average</th><th className="num">High band</th><th className="num">Low band</th><th className="num">AUC</th></tr></thead>
            <tbody>{yrs.map((y) => <tr key={y.year}><td>{y.year}</td><td className="num">{y.n.toLocaleString()}</td><td className="num">{P(y.base)}</td><td className="num">{P(y.high)}</td><td className="num">{P(y.low)}</td><td className="num">{y.auc != null ? y.auc.toFixed(2) : "—"}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      {bt.offeringsOnly && bt.raisedOrEnded && (
        <div className="tablewrap">
          <h3 className="subh">Does it hold up if you count a raise differently?</h3>
          <table className="grid plain">
            <thead><tr><th>What counts as "had to raise"</th><th className="num">Average</th><th className="num">High band</th><th className="num">Low band</th><th className="num">AUC</th></tr></thead>
            <tbody>
              {[["Offering filing or a 15%+ jump in shares (main result)", bt], ["Formal offering filings only", bt.offeringsOnly], ["Raised, or stopped filing within the year (bankruptcy, wind-down or sale)", bt.raisedOrEnded], ...(bt.catalystTiming ? [["Main result, but ignoring companies' catalyst guidance (flat 18 months)", { base12: bt.base12, ...bt.catalystTiming.withoutGuidance }]] : [])].map(([l, v]) => (
                <tr key={l}><td>{l}</td><td className="num">{P(v.base12)}</td><td className="num">{P(v.bands.find((x) => x.band === "High")?.raised12)}</td><td className="num">{P(v.bands.find((x) => x.band === "Low")?.raised12)}</td><td className="num">{v.auc?.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="colnote">Share-count jumps catch money raised through at-the-market sales and private placements, which often don't get their own offering filing.</p>
        </div>
      )}

      <div className="takeaways">
        <h3 className="subh">What this tells us</h3>
        <ul className="watch">
          <li><b>The score points the right way, but the signal is modest.</b> High-band companies raised more often than Low-band ones in {yrs.filter((y) => y.high > y.low).length} of {yrs.length} years, but an AUC of {bt.auc?.toFixed(2)} is a long way from perfect. Treat a High score as "more likely", not "certain".</li>
          <li><b>Almost every cash-burning biotech raises often.</b> {P(bt.base12)} of company-quarters were followed by a raise within a year, so the useful question is less "will they raise?" than "how soon, and how badly do they need it?"</li>
          {(() => { const a = bt.runwayBuckets[0], b = bt.runwayBuckets[1]; return a && b && a.raised12 < b.raised12 ? <li><b>Companies nearly out of cash often can't raise at all.</b> With under 6 months left, only {P(a.raised12)} raised within a year, fewer than the {P(b.raised12)} with 6–12 months. Many of the rest were sold, wound down or went bankrupt instead. The "raised or stopped filing" row counts those too.</li> : null; })()}
          {(() => { const c = Object.entries(bt.components).sort((x, y) => (y[1].auc || 0) - (x[1].auc || 0))[0]; return c ? <li><b>The strongest single part is "{COMP[c[0]] || c[0]}"</b> (AUC {c[1].auc?.toFixed(2)}). Burn trend and debt add almost nothing on their own. That points to re-weighting the score toward what works; any change will be logged on the About us page.</li> : null; })()}
          {bt.catalystTiming ? (
            <li><b>Catalyst timing comes from what companies told investors at the time.</b> We read {bt.catalystTiming.filingsRead.toLocaleString()} quarterly and annual reports for dated guidance like "topline data in the second half of 2019"; {P(bt.catalystTiming.shareWithGuidance)} of company-quarters had some. With those dates the score's ranking accuracy is {bt.auc?.toFixed(2)}, against {bt.catalystTiming.withoutGuidance.auc?.toFixed(2)} with the flat 18-month assumption{bt.catalystTiming.guidedRowsOnly.auc != null ? ` (${bt.catalystTiming.guidedRowsOnly.auc.toFixed(2)} vs ${bt.catalystTiming.guidedRowsOnly.aucWithoutGuidance.toFixed(2)} on just the quarters that had guidance)` : ""}.{bt.auc < bt.catalystTiming.withoutGuidance.auc ? " So knowing when news is due made the score slightly worse, not better. One likely reason: biotechs often raise money right after a readout, while the shares are up, so a catalyst coming soon doesn't mean less need for cash, which is how the score treats it today." : ""}</li>
          ) : (
            <li><b>Catalyst timing, a key input to the score's biggest part, couldn't be tested yet.</b> Every company was given the same 18-month assumption, so the true score may do better or worse than this.</li>
          )}
        </ul>
      </div>

      <p className="prose">
        <b>Survivors vs the rest.</b> For companies still filing today the ranking accuracy is {bt.survivors.auc?.toFixed(2) ?? "—"}; for companies that have since stopped filing it's {bt.nonSurvivors.auc?.toFixed(2) ?? "—"}.
        {bt.leadMonthsHigh != null ? ` When a High-band company did raise, the median wait was ${num(bt.leadMonthsHigh, 1)} months after the balance sheet that flagged it.` : ""}
      </p>
      <details className="limits">
        <summary>How this was done, and what it leaves out</summary>
        <p className="prose"><b>Who's in it.</b> {bt.universe}</p>
        <p className="prose"><b>What counts as a raise.</b> {bt.outcome}</p>
        <p className="prose"><b>No hindsight.</b> {bt.pointInTime}</p>
        <ul className="watch">{bt.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
        <p className="colnote">The code is <ExtLink href="https://github.com/emagyem/friendly-chainsaw/blob/main/scripts/backtest.mjs">scripts/backtest.mjs</ExtLink>; it reruns every month.</p>
      </details>
    </section>
  );
}

function Research({ go }) {
  const rr = useMemo(() => raiseRunway(COMPANIES), []);
  const study = useMemo(() => offeringStudy(COMPANIES, META.benchmark), []);
  const n = study.rows.length;
  const upDay1 = study.rows.filter((r) => r.d1 > 0).length;
  const down20 = study.rows.filter((r) => r.d20 != null && r.d20 < 0).length;
  const n20 = study.rows.filter((r) => r.d20 != null).length;
  const over36 = rr.bins.at(-1).n;
  const since = rr.rows.length ? rr.rows.at(-1).date.slice(0, 4) : null;
  const zone = COMPANIES.map((c) => ({ c, f: fpsOf(c) })).filter(({ f }) => f.runway < 24)
    .sort((a, b) => a.f.runway - b.f.runway);
  const [zoneShown, zoneMore] = useMore(zone, 15);
  const snaps = HISTORY.snapshots || [];
  const firstSnap = snaps[0]?.date;
  const firstCheck = firstSnap ? new Date(Date.parse(firstSnap) + 182 * 86400000).toISOString().slice(0, 10) : null;
  const barData = rr.bins.map((b) => ({ ...b, need: b.hi <= 24 }));

  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Research</p>
        <h1 className="report-h">Could you have seen the raise coming?</h1>
        <p className="prose">Helixora's whole idea is spotting who has to raise money before they do. This page tests that idea against what really happened: {rr.rows.length} stock offerings by these companies since {since}, judged only on what had been filed before each one.</p>
      </section>

      <Backtest />

      <section className="panel">
        <header className="ph"><h2>How much cash companies had left when they raised</h2>
          <span className="ph-note">For each offering, the runway from the last balance sheet filed before it, less the months of burn since that date.{rr.rows.length > rr.n ? ` ${rr.rows.length - rr.n === 1 ? "One offering, by a company whose operating cash flow was positive, is" : `${rr.rows.length - rr.n} offerings by companies with positive operating cash flow are`} left out of the counts.` : ""}</span></header>
        {rr.n === 0 ? <p className="empty">Runway history appears after the next data refresh.</p> : (
          <>
            <p className="finding">{rr.under24} of {rr.n} offerings came with less than two years of cash left, the range Helixora's score is built to flag. Another {over36} came with three years or more: those companies raised because they could, not because they had to.</p>
            <div className="metrics four">
              <div className="metric"><span>Raised with under 2 years left</span><b>{rr.under24} of {rr.n}</b></div>
              <div className="metric"><span>Median cash left at the raise</span><b>{num(rr.median, 0)} months</b></div>
              <div className="metric"><span>Raised with 3+ years left</span><b>{over36} of {rr.n}</b></div>
              <div className="metric"><span>Companies under 2 years today</span><b>{zone.length} of {COMPANIES.length}</b></div>
            </div>
            <div className="chart">
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={barData} margin={{ top: 18, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="#E4E9EB" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11.5, fill: "#5E6B73" }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#5E6B73" }} width={28} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} content={({ payload }) => {
                    if (!payload || !payload.length) return null;
                    const d = payload[0].payload;
                    return <div className="rtip"><b>{d.n} offering{d.n === 1 ? "" : "s"}</b><br />{d.label} of cash left</div>;
                  }} />
                  <Bar dataKey="n" radius={[6, 6, 0, 0]} isAnimationActive={false} label={{ position: "top", fontSize: 12, fill: "#33434A" }}>
                    {barData.map((d) => <Cell key={d.label} fill={d.need ? "#B3264A" : "#9FB4B6"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="colnote">Offerings by months of cash left. Red bars are raises made with under two years of cash, the ones that build up as pressure first.</p>
            <details className="more">
            <summary>All {rr.rows.length} offerings, with the filing each figure came from</summary>
            <div className="tablewrap">
              <table className="grid">
                <thead><tr><th>Offering</th><th>Company</th><th>Last balance sheet before it</th><th className="r">Cash left at the offering</th></tr></thead>
                <tbody>
                  {rr.rows.map((r, i) => (
                    <tr key={i} onClick={() => go("company", r.c.t, "pressure")}>
                      <td className="nowrap"><a className="src" href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{fmtDate(r.date)}</a></td>
                      <td><b>{r.c.t}</b><span className="sub">{r.c.n}</span></td>
                      <td>{fmtDate(r.basis.end)}<span className="sub">filed {fmtDate(r.basis.filed)}</span></td>
                      <td className="r"><span className={r.left != null && r.left < 24 ? "neg-strong" : ""}>{mo(r.left)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </details>
          </>
        )}
      </section>

      <section className="panel">
        <header className="ph"><h2>Who is in that range today</h2>
          <span className="ph-note">Companies with under two years of cash at today's figures, the range where {rr.under24} of the {rr.n} past offerings happened. Sorted by cash left.</span></header>
        {zone.length === 0 ? <p className="empty">No tracked company is under two years of cash today.</p> : (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr><th>Company</th><th className="r">Cash left</th><th>Next major catalyst</th><th>Can sell shares now?</th><th className="r">Financing pressure</th></tr></thead>
              <tbody>
                {zoneShown.map(({ c, f }) => (
                  <tr key={c.t} onClick={() => go("company", c.t, "pressure")}>
                    <td><b>{c.t}</b><span className="sub">{c.n}</span></td>
                    <td className="r">{num(f.runway, 1)} months</td>
                    <td>{f.catalyst ? <>{fmtDate(f.catalyst.date)}<span className="sub">{shortLabel(f.catalyst.label)}</span></> : <span className="sub inline">None dated</span>}</td>
                    <td>{CAPACITY[c.raise?.capacity] || "—"}</td>
                    <td className="r"><BandBadge c={c} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {zoneMore}{" "}
        <button className="morelink" onClick={() => go("report")}>Read the full Financing Pressure Report</button>
      </section>

      <section className="panel">
        <header className="ph"><h2>Why it pays to know first</h2>
          <span className="ph-note">What share prices did around the {n} offerings inside the site's one-year price history. Day 0 is the last close before the first filing. {study.useAbn ? `Returns are measured relative to ${study.benchmark.symbol} (${study.benchmark.name}), so sector-wide moves are taken out.` : "Returns are raw price changes for now; a biotech benchmark (XBI) is added at the next data refresh."}</span></header>
        {n === 0 ? <p className="empty">No offerings fall inside the price history yet.</p> : (
          <>
            <p className="finding">On {upDay1} of {n} offerings the stock {study.useAbn ? `beat ${study.benchmark.symbol}` : "rose"} on the filing day, a sign that many companies raise into good news. Over the next 20 trading days, {down20} of {n20} ended lower{study.useAbn ? ` than ${study.benchmark.symbol}` : ""}. Investors who saw the raise coming could plan for both.</p>
            <div className="metrics four">
              <div className="metric"><span>Filing day, average</span><b className={pctCls(study.d1.mean)}>{pct(study.d1.mean)}</b><em>median {pct(study.d1.median)}</em></div>
              <div className="metric"><span>After 5 trading days</span><b className={pctCls(study.d5.mean)}>{pct(study.d5.mean)}</b><em>median {pct(study.d5.median)}</em></div>
              <div className="metric"><span>After 20 trading days</span><b className={pctCls(study.d20.mean)}>{pct(study.d20.mean)}</b><em>median {pct(study.d20.median)}</em></div>
              <div className="metric"><span>Lower after 20 days</span><b>{study.d20.down == null ? "—" : `${Math.round(study.d20.down * 100)}%`}</b><em>of {study.d20.n} offerings</em></div>
            </div>
            <div className="chart">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={study.path} margin={{ top: 16, right: 16, bottom: 24, left: 4 }}>
                  <CartesianGrid stroke="#E4E9EB" vertical={false} />
                  <XAxis dataKey="k" type="number" domain={[-PRE, POST]} ticks={[-10, -5, 0, 5, 10, 15, 20]} tick={{ fontSize: 11, fill: "#5E6B73" }}
                    label={{ value: "trading days from the offering", position: "insideBottom", offset: -12, fontSize: 11, fill: "#5E6B73" }} />
                  <YAxis tickFormatter={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`} tick={{ fontSize: 11, fill: "#5E6B73" }} width={48} />
                  <ReferenceLine y={0} stroke="#8A979E" />
                  <ReferenceLine x={0} stroke="#0E7C74" strokeDasharray="4 3" label={{ value: "Day 0", position: "insideTopLeft", fontSize: 11, fill: "#0E7C74" }} />
                  <Tooltip content={({ payload }) => {
                    if (!payload || !payload.length) return null;
                    const d = payload[0].payload;
                    return <div className="rtip"><b>{d.avg > 0 ? "+" : ""}{num(d.avg)}%</b> average on day {d.k > 0 ? "+" : ""}{d.k}<br />{d.n} offerings</div>;
                  }} />
                  <Line type="linear" dataKey="avg" stroke="#0E7C74" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="colnote">Average {study.useAbn ? `return relative to ${study.benchmark.symbol}` : "price change"} from day 0. One large move can pull the average a long way, so read it with the medians above.</p>
            <details className="more">
              <summary>Each offering's price moves</summary>
              <div className="tablewrap">
                <table className="grid">
                  <thead><tr><th>First filing</th><th>Company</th><th className="r">10 days before</th><th className="r">Filing day</th><th className="r">+5 days</th><th className="r">+20 days</th></tr></thead>
                  <tbody>
                    {study.rows.map((r, i) => (
                      <tr key={i} onClick={() => go("company", r.c.t)}>
                        <td className="nowrap"><a className="src" href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{fmtDate(r.date)}</a></td>
                        <td><b>{r.c.t}</b><span className="sub">{r.c.n}</span></td>
                        <td className="r"><span className={pctCls(r.pre)}>{pct(r.pre)}</span></td>
                        <td className="r"><span className={pctCls(r.d1)}>{pct(r.d1)}</span></td>
                        <td className="r"><span className={pctCls(r.d5)}>{pct(r.d5)}</span></td>
                        <td className="r"><span className={pctCls(r.d20)}>{r.d20 == null ? "not yet" : pct(r.d20)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>

      <section className="panel">
        <header className="ph"><h2>Does the score call raises ahead of time?</h2>
          <span className="ph-note">The test that matters most. The score passes only if it flags companies before they raise, not after.</span></header>
        <ol className="tr-list">
          <li>Companies scoring 70 or higher should file a stock offering within six months more often than companies scoring under 40.</li>
          <li>The warning should come early: a company should usually reach Elevated or High months before its offering, not the week of it.</li>
          <li>The score should beat cash runway alone. If runway explains everything, the other parts get cut.</li>
        </ol>
        <p className="prose" style={{ marginTop: 14 }}>
          {firstSnap
            ? <>Scores have been saved every weekday since {fmtDate(firstSnap)} ({snaps.length} snapshots so far). The first six-month check is due around {fmtDate(firstCheck)}, and the results will be published whether they support the score or not.</>
            : <>Daily score snapshots start with the next data refresh.</>}
          {" "}<button className="morelink" onClick={() => go("method")}>See the track record</button>
        </p>
      </section>

      <FinancingModelPanel />

      <section className="panel">
        <header className="ph"><h2>How these studies avoid fooling themselves</h2>
          <span className="ph-note">A finding can look strong on past data and still be wrong. These are the usual reasons, and what Helixora does about each.</span></header>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Pitfall</th><th>What it means</th><th>What Helixora does</th></tr></thead>
            <tbody>{PITFALLS.map(([a, b, c]) => <tr key={a}><td className="nowrap"><b>{a}</b></td><td>{b}</td><td>{c}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <p className="disclaimer">Research on past financing filings and price moves. It is not investment advice and does not recommend buying or selling any security. Past patterns may not repeat.</p>
    </div>
  );
}

/* Long lists start short, with a button to show the rest. */
function useMore(list, n) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, n);
  const more = list.length > n ? <button className="morelink" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${list.length}`}</button> : null;
  return [shown, more];
}

/* ------------------------ readout scenarios (Bayes) ------------------------
   If this phase succeeds, the program's chance of approval becomes
   P(approval | success) = P(approval) / P(success this phase), which is the
   product of the remaining phase rates. If it fails, the program usually stops. */

const NEXT_PHASE = { "Phase I": "Phase II", "Phase II": "Phase III", "Phase III": "Filed", Filed: "Approved" };
function readoutScenario(p) {
  if (!p.odds || !NEXT_PHASE[p.ph] || p.ph === "Approved") return null;
  const now = successOdds(p), next = successOdds({ ...p, ph: NEXT_PHASE[p.ph] });
  if (!now || !next) return null;
  const pass = now.steps[0].adj;
  const v = (pos) => rnpv(p, { posOverride: pos });
  const up = v(next.loa), down = 0, mid = v(now.loa);
  return { pass, now: now.loa, ifUp: next.loa, ifDown: 0, valueUp: up, valueDown: down, valueNow: mid, stake: up - down };
}

function ReadoutStakes({ go }) {
  const rows = useMemo(() => COMPANIES.flatMap((c) => (c.pipeline || []).filter((p) => ["Phase II", "Phase III", "Filed"].includes(p.ph))
    .map((p) => ({ c, p, s: readoutScenario(p) })).filter((r) => r.s && r.s.stake > 0)).sort((a, b) => b.s.stake / b.c.mcap - a.s.stake / a.c.mcap), []);
  const [shown, more] = useMore(rows, 15);
  return (
    <section className="panel">
      <header className="ph"><h2>What the next result is worth</h2>
        <span className="ph-note">How each program's chance of approval and risk-adjusted value change if its current phase succeeds or fails. A success leaves only the later phases to clear, so the odds jump; a failure usually ends the program.</span></header>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>Program</th><th className="r">Chance this phase succeeds</th><th className="r">Approval odds now</th><th className="r">If it succeeds</th><th className="r">Value at stake</th><th className="r">Share of market value</th></tr></thead>
          <tbody>
            {shown.map(({ c, p, s }) => (
              <tr key={c.t + p.d} onClick={() => go("company", c.t, "pipeline")}>
                <td><b>{c.t}</b> {p.d}<span className="sub">{p.ph}{p.window ? ` · data ${fmtDate(p.window.lo)} to ${fmtDate(p.window.hi)}` : ""}</span></td>
                <td className="r">{pctW(s.pass)}</td>
                <td className="r">{pctW(s.now)}</td>
                <td className="r"><b>{pctW(s.ifUp)}</b><span className="sub">about 0% if it fails</span></td>
                <td className="r">{money(s.stake)}<span className="sub">${num(s.stake / c.shares, 2)} a share</span></td>
                <td className="r"><b>{pctW(s.stake / c.mcap)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more}
      <p className="colnote">Value at stake is the gap between the program's risk-adjusted value after a success and after a failure, using the same placeholder peak sales as the Valuation tab. It shows which results matter most to each company, not how its shares will move.</p>
    </section>
  );
}

/* --------------------- valuation scenarios and sensitivity --------------------- */

function equityAt(c, { posMul = 1, posAdd = 0, peakMul = 1, launchAdd = 0, discount = 0.11, margin = 0.42, patentAdd = 0 } = {}) {
  const pipe = (c.pipeline || []).reduce((s, p) => {
    const base = p.ph === "Approved" ? 1 : (p.odds?.loa ?? POS[p.ph]);
    const pos = p.ph === "Approved" ? 1 : Math.max(0.005, Math.min(0.97, base * posMul + posAdd));
    return s + rnpv({ ...p, peak: p.peak * peakMul, launch: Math.max(0, p.launch + launchAdd) }, { discount, margin, patentYrs: (c.patentYrs || 10) + patentAdd, posOverride: pos });
  }, 0);
  return pipe + c.cash - (c.debt || 0);
}

const SCENARIOS = [
  ["Bear", 0.25, { posMul: 0.7, peakMul: 0.5, launchAdd: 1.5, discount: 0.13 }, "Odds 30% lower, half the peak sales, 18 months later, 13% discount rate"],
  ["Base", 0.5, {}, "Helixora odds and current inputs, 11% discount rate"],
  ["Bull", 0.25, { posMul: 1.2, peakMul: 1.5, launchAdd: -0.5, discount: 0.09 }, "Odds 20% higher, 1.5 times peak sales, 6 months sooner, 9% discount rate"],
];
const SENS = [
  ["Approval odds ±10 points", { posAdd: -0.1 }, { posAdd: 0.1 }],
  ["Peak sales ±50%", { peakMul: 0.5 }, { peakMul: 1.5 }],
  ["Launch a year later / sooner", { launchAdd: 1 }, { launchAdd: -1 }],
  ["Discount rate 13% / 9%", { discount: 0.13 }, { discount: 0.09 }],
  ["Profit margin 32% / 52%", { margin: 0.32 }, { margin: 0.52 }],
  ["Exclusivity 3 years shorter / longer", { patentAdd: -3 }, { patentAdd: 3 }],
];

function ScenarioPanel({ c }) {
  const base = equityAt(c);
  const sc = SCENARIOS.map(([name, w, o, desc]) => ({ name, w, desc, v: equityAt(c, o) }));
  const weighted = sc.reduce((s, x) => s + x.w * x.v, 0);
  const tor = SENS.map(([label, lo, hi]) => ({ label, lo: equityAt(c, lo) - base, hi: equityAt(c, hi) - base }))
    .sort((a, b) => (Math.abs(b.hi - b.lo)) - Math.abs(a.hi - a.lo));
  return (
    <section className="panel">
      <header className="ph"><h2>Bear, base and bull cases</h2>
        <span className="ph-note">Equity value (pipeline plus cash minus debt) under three sets of assumptions, weighted 25/50/25, and which single assumption moves the answer most.</span></header>
      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr><th>Case</th><th>Assumptions</th><th className="r">Equity value</th><th className="r">Per share</th></tr></thead>
          <tbody>
            {sc.map((x) => <tr key={x.name}><td><b>{x.name}</b> <span className="sub inline">{Math.round(x.w * 100)}%</span></td><td>{x.desc}</td><td className="r">{money(x.v)}</td><td className="r">${num(x.v / c.shares, 2)}</td></tr>)}
            <tr className="total"><td>Probability-weighted</td><td /><td className="r">{money(weighted)}</td><td className="r">${num(weighted / c.shares, 2)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="colnote">Market value today: {money(c.mcap)} (${num(c.quote?.price, 2)} a share).</p>
      <h3 className="subhead">What moves the value most</h3>
      <ResponsiveContainer width="100%" height={tor.length * 44 + 20}>
        <BarChart data={tor} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={230} tick={{ fontSize: 12.5, fill: "#33434A" }} axisLine={false} tickLine={false} />
          <ReferenceLine x={0} stroke="#8A979E" />
          <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} content={({ payload }) => payload?.length ? <div className="rtip"><b>{payload[0].payload.label}</b><br />{money(payload[0].payload.lo)} / {money(payload[0].payload.hi)} vs base</div> : null} />
          <Bar dataKey="lo" stackId="a" fill="#B3264A" isAnimationActive={false} />
          <Bar dataKey="hi" stackId="a" fill="#0E7C74" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <p className="colnote">Each bar changes one assumption and holds the rest at the base case: red is the lower setting, teal the higher. Not a price target.</p>
    </section>
  );
}

/* ----------------------- burn forecast and raise estimate ----------------------- */

function BurnForecastPanel({ c }) {
  const f = useMemo(() => burnForecast(c), [c]);
  const fps = fpsOf(c);
  const r = useMemo(() => raiseEstimate(c, fps.catalyst ? fps.monthsToCatalyst : null), [c, fps.catalyst, fps.monthsToCatalyst]);
  if (!f) return null;
  const data = [...f.history.map((x) => ({ d: x.d, v: x.v })), ...f.forecast.map((x, i) => ({ d: x.d, fv: x.v, band: [x.lo, x.hi], ...(i === 0 ? {} : {}) }))];
  data[f.history.length - 1].fv = data[f.history.length - 1].v;
  return (
    <div className="two">
      <section className="panel">
        <header className="ph"><h2>Burn forecast</h2>
          <span className="ph-note">Quarterly cash burn from past filings, projected four quarters ahead with exponential smoothing (Holt's method). The shaded band covers roughly 80% of outcomes if past swings continue.</span></header>
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#E4E9EB" vertical={false} />
            <XAxis dataKey="d" tickFormatter={(d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" })} tick={{ fontSize: 11, fill: "#5E6B73" }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(x) => money(x)} tick={{ fontSize: 11, fill: "#5E6B73" }} width={56} axisLine={false} tickLine={false} />
            <Tooltip content={({ payload }) => payload?.length ? <div className="rtip"><b>{money(payload[0].payload.v ?? payload[0].payload.fv)}</b> a quarter<br />{fmtDate(payload[0].payload.d)}{payload[0].payload.v == null ? " (forecast)" : ""}</div> : null} />
            <Area dataKey="band" stroke="none" fill="#0E7C74" fillOpacity={0.12} isAnimationActive={false} />
            <Line dataKey="v" stroke="#0D1B21" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="fv" stroke="#0E7C74" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
      <section className="panel">
        <header className="ph"><h2>Likely size of the next raise</h2>
          <span className="ph-note">Cash needed to fund the company to 12 months past its next big event, plus a 6-month buffer, at forecast burn.</span></header>
        {!r ? <p className="empty">Not enough data to estimate.</p> : r.gap <= 0 ? (
          <p className="finding">No raise needed: current cash covers the next {Math.round(r.months)} months at forecast burn.</p>
        ) : (
          <>
            <p className="finding">About {money(r.gap)} more is needed to cover the next {Math.round(r.months)} months. Raised at a {Math.round(r.discount * 100)}% discount to today's price, that's roughly {num(r.newShares, 0)}M new shares, diluting holders by about {pctW(r.dilution)}.</p>
            <dl className="facts small">
              <dt>Cash needed</dt><dd>{money(r.need)} over {Math.round(r.months)} months</dd>
              <dt>Cash on hand</dt><dd>{money(c.cash)}</dd>
              <dt>Assumed offer price</dt><dd>${num(r.price, 2)}</dd>
            </dl>
          </>
        )}
        <p className="colnote">A scenario, not a prediction of when or how a company raises. Partnerships, debt or an ATM drip can replace a single offering.</p>
      </section>
    </div>
  );
}

/* ----------------------------- anomaly alerts ----------------------------- */

const ALERT_ICON = { burn: "Burn", price: "Price", offering: "Offering", trial: "Trial", score: "Score" };
function AlertsPanel({ go, only }) {
  const list = useMemo(() => COMPANIES.filter((c) => !only || c.t === only)
    .flatMap((c) => anomalies(c, { benchmark: META.benchmark, history: HISTORY, todayIso: TODAY.toISOString().slice(0, 10), version: FPS_VERSION }))
    .sort((a, b) => ({ high: 0, med: 1, low: 2 }[a.sev] - { high: 0, med: 1, low: 2 }[b.sev]) || (b.date || "").localeCompare(a.date || "")), [only]);
  if (only && !list.length) return null;
  return (
    <section className={only ? "panel" : "panel"}>
      <header className="ph"><h2>{only ? "Unusual changes" : "What changed: unusual moves to check"}</h2>
        <span className="ph-note">We only flag what's unusual for that particular company: a jump in spending, a big move against the biotech index, a new offering filing, a delayed trial, or a change in its pressure band.</span></header>
      {list.length === 0 ? <p className="empty">Nothing unusual right now.</p> : (
        <ul className="alertlist">
          {list.map((a, i) => (
            <li key={i} className={"al al-" + a.sev}>
              <span className="al-kind">{ALERT_ICON[a.kind]}</span>
              {!only && <button className="tick" onClick={() => go("company", a.t)}>{a.t}</button>}
              <span className="al-text">{a.text}{a.url && <> <a className="src" href={a.url} target="_blank" rel="noreferrer">Filing</a></>}</span>
              {a.date && <span className="sub inline">{fmtDate(a.date)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------- quant panels ---------------------------- */

function RunwaySimPanel({ c }) {
  const sim = useMemo(() => runwaySim(c), [c]);
  if (!sim) return (
    <section className="panel"><header className="ph"><h2>Cash survival simulation</h2></header>
      <p className="empty">{c.cashFlowPositive ? "Operating cash flow is positive, so cash isn't running down." : "Not enough data to simulate."}</p></section>
  );
  return (
    <section className="panel">
      <header className="ph"><h2>Cash survival simulation</h2>
        <span className="ph-note">10,000 simulated paths of quarterly cash, with burn that keeps its recent trend ({sim.drift >= 0 ? "+" : ""}{num(sim.drift * 100, 0)}% a quarter) and swings as much as it has in past filings. No new financing, partner payments or product revenue are assumed.</span></header>
      <div className="metrics four">
        <div className="metric"><span>Out of cash within 12 months</span><b>{pctW(sim.p12)}</b></div>
        <div className="metric"><span>Within 18 months</span><b>{pctW(sim.p18)}</b></div>
        <div className="metric"><span>Within 24 months</span><b>{pctW(sim.p24)}</b></div>
        <div className="metric"><span>Median time to empty</span><b>{sim.median ? `${sim.median} months` : `${sim.horizon}+ months`}</b></div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={[{ m: 0, p: 0 }, ...sim.curve].map((d) => ({ ...d, pp: d.p * 100 }))} margin={{ top: 8, right: 16, bottom: 22, left: 0 }}>
          <CartesianGrid stroke="#E4E9EB" vertical={false} />
          <XAxis dataKey="m" type="number" domain={[0, sim.horizon]} ticks={[0, 6, 12, 18, 24, 30, 36].filter((t) => t <= sim.horizon)} tick={{ fontSize: 11, fill: "#5E6B73" }}
            label={{ value: "months from the last balance sheet", position: "insideBottom", offset: -12, fontSize: 11, fill: "#5E6B73" }} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: "#5E6B73" }} width={44} />
          <Tooltip content={({ payload }) => payload?.length ? <div className="rtip"><b>{num(payload[0].payload.pp, 0)}%</b> of paths out of cash by month {payload[0].payload.m}</div> : null} />
          <Area type="stepAfter" dataKey="pp" stroke="#B3264A" fill="#B3264A" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <p className="colnote">A scenario, not a prediction: companies almost always raise money or cut spending before cash runs out. Read it as how urgent a raise is. Model version {QUANT_VERSION}.</p>
    </section>
  );
}

function EquityRangePanel({ c }) {
  const e = useMemo(() => equitySim(c), [c]);
  if (!e) return null;
  const data = e.hist.map((h) => ({ ...h, label: money(h.x) }));
  return (
    <section className="panel">
      <header className="ph"><h2>Range of equity values</h2>
        <span className="ph-note">4,000 simulations. Each program succeeds or fails at its Helixora odds, with uncertain peak sales and launch timing; equity is pipeline value plus cash minus debt. A range, not a price target.</span></header>
      <div className="metrics four">
        <div className="metric"><span>Low case (10th percentile)</span><b>{money(e.p10)}</b></div>
        <div className="metric"><span>Middle (median)</span><b>{money(e.p50)}</b></div>
        <div className="metric"><span>High case (90th percentile)</span><b>{money(e.p90)}</b></div>
        <div className="metric"><span>Market value today</span><b>{money(c.mcap)}</b><em>{pctW(e.above)} of simulations above it</em></div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap={1}>
          <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: "#5E6B73" }} interval={4} axisLine={false} tickLine={false} />
          <YAxis hide />
          <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} content={({ payload }) => payload?.length ? <div className="rtip">Around <b>{payload[0].payload.label}</b><br />{payload[0].payload.n} simulations</div> : null} />
          <Bar dataKey="n" isAnimationActive={false}>{data.map((d) => <Cell key={d.x} fill={d.x > c.mcap ? "#0E7C74" : "#9FB4B6"} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
      {e.implied != null && (
        <p className="finding" style={{ marginTop: 14 }}>
          To justify today's {money(c.mcap)} market value, the tracked programs would need about {money(e.impliedPeak)} in combined peak sales{e.placeholders ? `, ${num(e.implied, 1)} times Helixora's placeholder figures` : ""}.
        </p>
      )}
      <p className="colnote">{e.placeholders ? `${e.placeholders} of ${e.programs} programs use placeholder peak sales, so the range mostly shows the effect of the odds and timing. ` : ""}Programs Helixora doesn't track, partnership income and platform value aren't counted, so a high multiple can reflect them. Teal bars are outcomes above today's market value.</p>
    </section>
  );
}

function SurvivalMonitor({ go }) {
  const rows = useMemo(() => COMPANIES.map((c) => ({ c, s: runwaySim(c) })).sort((a, b) => (b.s?.p18 ?? -1) - (a.s?.p18 ?? -1)), []);
  const [shown, more] = useMore(rows, 15);
  return (
    <section className="panel">
      <header className="ph"><h2>Cash survival monitor</h2>
        <span className="ph-note">The chance each company would run out of cash, from 10,000 simulated burn paths with no new money. The higher it is, the sooner a raise is likely.</span></header>
      <div className="tablewrap">
        <table className="grid">
          <thead><tr><th>Company</th><th className="r">Cash left</th><th className="r">Out within 18 months</th><th className="r">24 months</th><th className="r">36 months</th><th className="r">Financing pressure</th></tr></thead>
          <tbody>
            {shown.map(({ c, s }) => (
              <tr key={c.t} onClick={() => go("company", c.t, "pressure")}>
                <td><b>{c.t}</b><span className="sub">{c.n}</span></td>
                <td className="r">{c.cashFlowPositive ? "Cash flow positive" : mo(fpsOf(c).runway)}</td>
                <td className="r"><b>{s ? pctW(s.p18) : "—"}</b></td>
                <td className="r">{s ? pctW(s.p24) : "—"}</td>
                <td className="r">{s ? pctW(s.p36) : "—"}</td>
                <td className="r"><BandBadge c={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more}
      <p className="colnote">Doesn't count new financing, partner payments or product revenue, so approved companies look tighter than they are.</p>
    </section>
  );
}

function FinancingModelPanel() {
  const m = useMemo(() => financingModel(COMPANIES, TODAY.toISOString().slice(0, 10)), []);
  if (!m) return null;
  const beats = m.skill > 0;
  return (
    <section className="panel">
      <header className="ph"><h2>Can a model predict the next raise? A first test</h2>
        <span className="ph-note">A simple statistical model (logistic regression) that guesses whether a company will start a stock offering within 12 months. It learned from {m.n} company-quarters ({m.events} followed by an offering), each dated by when its balance sheet was first made public, and every company is predicted by a version that never saw it.</span></header>
      <p className="finding">{beats
        ? `It beats simply guessing the average, but only by ${pctW(m.skill)} on the Brier score. That's a start, not proof.`
        : `Not yet. ${pctW(m.base)} of company-quarters were followed by an offering within a year, so simply assuming the average does better than the model (Brier score ${num(m.brierBase, 3)} vs. ${num(m.brier, 3)}).`}</p>
      <p className="prose">{beats ? "" : "For these companies, raising within a year is the norm; the open question is timing, which is what the Financing Pressure Score and readout windows address. The model needs a much larger group of companies, including ones that failed or were bought, before it can be judged. "}Inputs: {FEATURES.join(", ").toLowerCase()}. Period: offerings from {fmtDate(m.start)}, judged on balance sheets filed up to {fmtDate(m.cutoff)}.</p>
      {beats && (
        <div className="tablewrap"><table className="grid plain"><thead><tr><th>Company</th><th className="r">Chance of an offering in 12 months</th></tr></thead>
          <tbody>{m.now.map((r) => <tr key={r.t}><td><b>{r.t}</b></td><td className="r">{pctW(r.p)}</td></tr>)}</tbody></table></div>
      )}
      <p className="colnote">Brier score: the average squared gap between predicted chance and what happened. Lower is better. Model version {QUANT_VERSION}.</p>
    </section>
  );
}

/* ---------------------------- trials and FDA ---------------------------- */

const pctW = (x, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const SEV_CLS = { high: "flag-high", med: "flag-med", low: "flag-low", info: "flag-info" };

// When a program could reach the market: the approval date if approved, the FDA decision date if filed,
// otherwise the estimated data date plus about a year to file and be reviewed (Phase III), or the phase default.
function expectedApproval(c, p) {
  if (p.ph === "Approved") return p.approval ? { date: p.approval, basis: "Approved" } : null;
  const fda = (c.catalysts || []).find((x) => x.kind === "regulatory" && x.drug === p.d && days(x.date) >= 0);
  if (fda) return { date: fda.date, basis: "FDA decision date" };
  if (p.ph === "Filed") return null;
  if (p.ph === "Phase III" && p.window) return { date: new Date(Date.parse(p.window.mid) + 365 * 86400000).toISOString().slice(0, 10), basis: "Data window + 1 year" };
  if (p.launch != null) return { date: new Date(TODAY.getTime() + p.launch * 365.25 * 86400000).toISOString().slice(0, 10), basis: `${p.ph} typical timeline` };
  return null;
}

function WindowBar({ w, from, span }) {
  if (!w) return null;
  const x = (iso) => Math.max(0, Math.min(100, ((Date.parse(iso) - from) / span) * 100));
  return (
    <span className="wbar" title={`${fmtDate(w.lo)} to ${fmtDate(w.hi)} · registry ${fmtDate(w.reg)}`}>
      <span className="wbar-band" style={{ left: `${x(w.lo)}%`, width: `${Math.max(1.2, x(w.hi) - x(w.lo))}%` }} />
      <span className="wbar-mid" style={{ left: `${x(w.mid)}%` }} />
      {w.reg && <span className="wbar-reg" style={{ left: `${x(w.reg)}%` }} />}
    </span>
  );
}

function SalesModel() {
  const [v, setV] = useState({ pts: 50000, dx: 60, tx: 50, share: 25, price: 150, years: 5 });
  const set = (k) => (e) => setV({ ...v, [k]: Number(e.target.value) || 0 });
  const treated = v.pts * (v.dx / 100) * (v.tx / 100) * (v.share / 100);
  const peak = (treated * v.price * 1000) / 1e6;
  const curve = Array.from({ length: Math.max(2, v.years + 2) }, (_, i) => {
    const t = (i + 1) / v.years;
    const s = 1 / (1 + Math.exp(-8 * (t - 0.5)));
    const s0 = 1 / (1 + Math.exp(4)), s1 = 1 / (1 + Math.exp(-4));
    return { y: `Year ${i + 1}`, sales: Math.round(peak * Math.min(1, (s - s0) / (s1 - s0))) };
  });
  // Called as a function, not used as <F/>: a component defined here would remount, and lose focus, on every keystroke.
  const field = ({ k, label, unit, step = 1 }) => (
    <label className="f" key={k}><span>{label}</span><input type="number" min="0" step={step} value={v[k]} onChange={set(k)} />{unit && <em className="unit">{unit}</em>}</label>
  );
  return (
    <div className="salesmodel">
      <div className="filters">
        {field({ k: "pts", label: "US patients with the disease" })}
        {field({ k: "dx", label: "Diagnosed", unit: "%" })}
        {field({ k: "tx", label: "Treated with a drug", unit: "%" })}
        {field({ k: "share", label: "Share this drug wins", unit: "%" })}
        {field({ k: "price", label: "Net price per patient per year", unit: "$ thousands" })}
        {field({ k: "years", label: "Years to reach peak" })}
      </div>
      <p className="finding" style={{ marginTop: 18 }}>{Math.round(treated).toLocaleString("en-US")} patients on the drug at peak, worth {money(peak)} a year in US sales.</p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={curve} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#E4E9EB" vertical={false} />
          <XAxis dataKey="y" tick={{ fontSize: 11, fill: "#5E6B73" }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(x) => money(x)} tick={{ fontSize: 11, fill: "#5E6B73" }} width={60} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} content={({ payload }) => payload?.length ? <div className="rtip"><b>{money(payload[0].payload.sales)}</b> in {payload[0].payload.y}</div> : null} />
          <Bar dataKey="sales" fill="#0E7C74" radius={[5, 5, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <p className="colnote">The starting numbers are an example, not a forecast for any company. Replace them with figures you've researched. Uptake follows an S-shaped launch curve that reaches peak in the years you set.</p>
    </div>
  );
}

function Outlook({ go }) {
  const progs = useMemo(() => COMPANIES.flatMap((c) => (c.pipeline || []).map((p) => ({ c, p }))), []);
  const timed = progs.filter(({ p }) => p.window && p.ph !== "Approved" && p.ph !== "Phase I" && !p.trial?.ext)
    .sort((a, b) => a.p.window.mid.localeCompare(b.p.window.mid));
  const from = TODAY.getTime(), span = 42 * 30.44 * 86400000;
  const late = progs.filter(({ p }) => ["Phase II", "Phase III", "Filed", "Approved"].includes(p.ph));
  const flagged = progs.filter(({ p }) => p.flags?.flags?.length);
  const fdaEvents = COMPANIES.flatMap((c) => (c.catalysts || []).filter((x) => x.kind === "regulatory" && days(x.date) >= 0).map((x) => ({ c, x, p: (c.pipeline || []).find((p) => p.d === x.drug) })));
  const fda = META.fda;
  const rivals = COMPANIES.flatMap((c) => (c.rivals || []).slice(0, 4).map((r) => ({ c, r })));
  const allRivals = COMPANIES.flatMap((c) => (c.rivals || []).map((r) => ({ c, r })));
  const china = allRivals.filter(({ r }) => r.china);
  const launched = progs.filter(({ p }) => p.ph === "Approved");
  const officeStat = (name) => fda?.byOffice?.find((o) => o.office === name);
  const oddsRows = late.filter(({ p }) => p.odds && p.ph !== "Approved");
  const exRows = late.map(({ c, p }) => { const ea = expectedApproval(c, p); const ex = ea ? exclusivity(p, ea.date) : null; return ex ? { c, p, ea, ex } : null; }).filter(Boolean);
  const [timedShown, timedMore] = useMore(timed, 20);
  const [oddsShown, oddsMore] = useMore(oddsRows, 15);
  const [flagShown, flagMore] = useMore(flagged, 15);
  const [rivalShown, rivalMore] = useMore(rivals, 20);
  const [chinaShown, chinaMore] = useMore(china, 12);
  const [exShown, exMore] = useMore(exRows, 15);
  const yearTicks = [0, 6, 12, 18, 24, 30, 36, 42].map((m) => ({ m, label: new Date(from + m * 30.44 * 86400000).toLocaleDateString("en-US", { month: "short", year: "numeric" }) }));

  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Trials and FDA</p>
        <h1 className="report-h">What's coming, how likely it is to work, and what could move it</h1>
        <p className="prose">For every program we track: when results are likely, warning signs in how the trial was designed, the odds of approval, how the FDA tends to decide, rival trials, launch sales, and how long the drug is protected from copies. Each model is a first version ({TRIALS_VERSION}) with its rules written out below, and we'll check it against what actually happens.</p>
      </section>

      <section className="panel">
        <header className="ph"><h2>When the data will actually land</h2>
          <span className="ph-note">Registry dates are plans, and they slip. Each bar is Helixora's estimated readout window; the dot is its middle, which the Financing Pressure Score now uses, and the tick is the date in the registry.</span></header>
        <div className="gantt">
          <div className="gantt-axis"><span />{<span className="gantt-ticks">{yearTicks.map((t) => <em key={t.m} style={{ left: `${(t.m / 42) * 100}%` }}>{t.label}</em>)}</span>}</div>
          {timedShown.map(({ c, p }) => (
            <button key={c.t + p.d} className="gantt-row" onClick={() => go("company", c.t, "pipeline")}>
              <span className="gantt-label"><b>{c.t}</b> {p.d}<span className="sub">{p.trial?.ph || p.ph}{p.trial?.ind && p.trial.ind !== p.ind ? ` in ${p.trial.ind}` : ""} · {p.window.stale ? "registry date overdue, so a wide window" : `${windowConfidence(p.window).toLowerCase()} window`}, {fmtDate(p.window.lo)} to {fmtDate(p.window.hi)}</span></span>
              <WindowBar w={p.window} from={from} span={span} />
            </button>
          ))}
        </div>
        {timedMore}
        <details className="more"><summary>How the window is set</summary>
          <ul className="tr-list">
            <li>Start from the trial's primary completion date on ClinicalTrials.gov. Topline data usually follows by 2 weeks to 3.5 months.</li>
            <li>Enrollment closed: allow 3 more months on the late side. Still enrolling: 6 more (9 for Phase III). Not yet enrolling: shift 3 months later and add a year.</li>
            <li>Registry not updated in over a year: 6 more months. Each time Helixora sees the date pushed back: 3 more (up to 6).</li>
            <li>If the registry plan is quicker than 75% of similar trials took (Kaplan-Meier curves from thousands of industry Phase II and III trials since 2012, by phase and size, counting trials still running), the late end moves out 4 months.</li>
            <li>A date the company has guided to replaces the registry date. If the window has already passed with no news, it restarts from today.</li>
          </ul>
        </details>
      </section>

      <section className="panel">
        <header className="ph"><h2>Chance of approval, fitted to each drug</h2>
          <span className="ph-note">Most models use one industry average per phase. Here each program starts from published success rates for its disease area, then adjusts for drug type, rare disease and biomarker-selected patients.</span></header>
        <div className="tablewrap">
          <table className="grid">
            <thead><tr><th>Program</th><th>Phase</th><th>Disease area</th><th>Adjusted for</th><th className="r">Industry average</th><th className="r">Helixora odds</th></tr></thead>
            <tbody>
              {oddsShown.map(({ c, p }) => (
                <tr key={c.t + p.d} onClick={() => go("company", c.t, "pipeline")}>
                  <td><b>{c.t}</b> {p.d}<span className="sub">{p.ind}</span></td>
                  <td className="nowrap">{p.ph}</td>
                  <td>{p.odds.area}</td>
                  <td>{p.odds.factors.length ? p.odds.factors.join(", ") : <span className="sub inline">Disease area only</span>}</td>
                  <td className="r">{pctW(successOdds({ ph: p.ph, area: "All indications" })?.loa)}</td>
                  <td className="r"><b>{pctW(p.odds.loa)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {oddsMore}
        <p className="colnote">Source: <a className="src" href={ODDS_SOURCE.url} target="_blank" rel="noreferrer">{ODDS_SOURCE.title}</a>. Adjustments are applied at half strength because the published factors overlap. Trial design flags are shown separately rather than folded into the odds, because there's no published rate to weight them by.</p>
      </section>

      <section className="panel">
        <header className="ph"><h2>Red flags in trial design</h2>
          <span className="ph-note">Warning signs read from each program's lead trial on ClinicalTrials.gov: size, randomization, blinding, control arm, endpoint type, sites, and date changes.</span></header>
        {flagged.length === 0 ? <p className="empty">No warning signs found in the lead trials.</p> : (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr><th>Program</th><th>Lead trial</th><th>What stands out</th></tr></thead>
              <tbody>
                {flagShown.map(({ c, p }) => (
                  <tr key={c.t + p.d} onClick={() => go("company", c.t, "pipeline")}>
                    <td><b>{c.t}</b> {p.d}<span className="sub">{p.ph}</span></td>
                    <td className="nowrap"><a className="src" href={`https://clinicaltrials.gov/study/${p.nct}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{p.nct}</a><span className="sub">{p.trial?.n || "—"} patients</span></td>
                    <td><div className="flagwrap">{p.flags.flags.map((f) => <span key={f.label} className={"flag " + SEV_CLS[f.sev]} title={f.detail}>{f.label}</span>)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {flagMore}
      </section>

      <section className="panel">
        <header className="ph"><h2>FDA decisions</h2>
          <span className="ph-note">Upcoming decisions with base rates, and what the FDA's own published rejection letters show about why drugs get turned down.</span></header>
        {fdaEvents.length === 0 ? <p className="empty">No FDA decision dates on file for tracked companies.</p> : (
          <div className="fdacards">
            {fdaEvents.map(({ c, x, p }) => {
              const office = p ? reviewOffice(p) : null;
              const st = office ? officeStat(office) : null;
              const odds = p ? successOdds({ ...p, ph: "Filed" }) : null;
              return (
                <article key={c.t + x.date} className="fdacard">
                  <span className="sub">{fmtDate(x.date)} · in {days(x.date)} days</span>
                  <h3><b>{c.t}</b> {x.drug || x.label}</h3>
                  <dl className="facts small">
                    {odds && <><dt>Approval odds</dt><dd><b>{pctW(odds.loa)}</b> <span className="sub inline">({odds.area} average {pctW(odds.steps[0].base)}{odds.factors.length ? `, adjusted for ${odds.factors.join(", ").toLowerCase()}` : ""})</span></dd></>}
                    {office && <><dt>Likely reviewer</dt><dd>{office}</dd></>}
                    {st && <><dt>That office's letters</dt><dd>{st.n} published rejections; {pctW(st.mfg / st.n)} cite manufacturing, {pctW(st.eff / st.n)} cite efficacy evidence</dd></>}
                  </dl>
                </article>
              );
            })}
          </div>
        )}
        {fda ? (
          <>
            <h3 className="subhead">Why the FDA says no: {fda.total} published rejection letters, {fda.first?.slice(0, 4)} to {fda.last?.slice(0, 4)}</h3>
            <ResponsiveContainer width="100%" height={Math.max(160, fda.reasons.length * 38)}>
              <BarChart data={fda.reasons.map((r) => ({ ...r, share: Math.round((r.n / fda.total) * 100) }))} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 8 }}>
                <XAxis type="number" hide domain={[0, 100]} />
                <YAxis type="category" dataKey="label" width={210} tick={{ fontSize: 12.5, fill: "#33434A" }} axisLine={false} tickLine={false} />
                <Bar dataKey="share" fill="#B3264A" radius={[0, 5, 5, 0]} isAnimationActive={false} label={{ position: "right", fontSize: 12, fill: "#33434A", formatter: (v) => `${v}%` }} />
              </BarChart>
            </ResponsiveContainer>
            <p className="colnote">Share of letters that mention each kind of problem (a letter can name several), found by keyword in the letter text. Source: <a className="src" href="https://open.fda.gov/apis/transparency/completeresponseletters/" target="_blank" rel="noreferrer">openFDA complete response letters</a>. The FDA has published only part of its letters, so this shows patterns, not exact rates. Advisory committee votes aren't covered yet.</p>
          </>
        ) : <p className="empty">FDA letter statistics appear after the next data refresh.</p>}
      </section>

      <ReadoutStakes go={go} />

      <section className="panel">
        <header className="ph"><h2>Read-through: rival trials that could move these stocks</h2>
          <span className="ph-note">Other companies' Phase II and III trials in the same diseases, finishing in the next 18 months. A rival's result can lift or sink a tracked company's shares before its own data arrives.</span></header>
        {rivals.length === 0 ? <p className="empty">Rival trials appear after the next data refresh.</p> : (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr><th>Tracked program</th><th>Rival trial</th><th>Sponsor</th><th>Phase</th><th>Completes</th><th>Where</th></tr></thead>
              <tbody>
                {rivalShown.map(({ c, r }) => (
                  <tr key={c.t + r.nct} onClick={() => go("company", c.t, "pipeline")}>
                    <td><b>{c.t}</b> {r.forDrug}<span className="sub">{r.ind}</span></td>
                    <td><a className="src" href={`https://clinicaltrials.gov/study/${r.nct}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{r.drugs.join(", ")}</a><span className="sub">{r.nct}</span></td>
                    <td>{r.sponsor}</td>
                    <td className="nowrap">{r.ph || "—"}</td>
                    <td className="nowrap">{r.pcd ? fmtDate(r.pcd) : "—"}</td>
                    <td>{r.china === "only" ? <span className="flag flag-med">China only</span> : r.china === "some" ? <span className="flag flag-low">Includes China</span> : <span className="sub inline">{r.countries.slice(0, 2).join(", ")}{r.nCountries > 2 ? ` +${r.nCountries - 2}` : ""}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rivalMore}
        <p className="colnote">The four soonest per company; each company's Pipeline tab lists more. Matched by disease from ClinicalTrials.gov, industry sponsors only. Helixora doesn't yet estimate how far a rival result should move each stock.</p>
      </section>

      <section className="panel">
        <header className="ph"><h2>China and ex-US programs</h2>
          <span className="ph-note">More drugs licensed by US companies now come from Chinese biotechs, and their trials are easy to miss. These are rival trials run entirely or partly in China.</span></header>
        {china.length === 0 ? <p className="empty">No China-based rival trials found in the tracked diseases.</p> : (
          <ul className="watch">
            {chinaShown.map(({ c, r }) => (
              <li key={c.t + r.nct}><b>{r.drugs.join(", ")}</b> from {r.sponsor} ({r.ph}, {r.china === "only" ? "China only" : "includes China"}), competing with <button className="linkish tick" onClick={() => go("company", c.t, "pipeline")}>{c.t}</button> {r.forDrug} in {r.ind}. Completes {r.pcd ? fmtDate(r.pcd) : "date not given"}. <a className="src" href={`https://clinicaltrials.gov/study/${r.nct}`} target="_blank" rel="noreferrer">{r.nct}</a></li>
            ))}
          </ul>
        )}
        {chinaMore}
      </section>

      <section className="panel">
        <header className="ph"><h2>Sales after approval</h2>
          <span className="ph-note">Many approved drugs miss sales expectations. Track what launched products actually sell, and build your own patient-based forecast.</span></header>
        {launched.length === 0 ? <p className="empty">No tracked company has an approved product yet.</p> : launched.map(({ c, p }) => (
          <div key={c.t + p.d} className="launch">
            <h3 className="subhead">{c.t} {p.d}{p.approval ? `, approved ${fmtDate(p.approval)}` : ""}</h3>
            {(c.revQ || []).length ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={c.revQ.map(([d, v]) => ({ d, v }))} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="#E4E9EB" vertical={false} />
                  <XAxis dataKey="d" tickFormatter={(d) => new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" })} tick={{ fontSize: 11, fill: "#5E6B73" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(x) => money(x)} tick={{ fontSize: 11, fill: "#5E6B73" }} width={56} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "rgba(14,124,116,.06)" }} content={({ payload }) => payload?.length ? <div className="rtip"><b>{money(payload[0].payload.v)}</b> quarter ending {fmtDate(payload[0].payload.d)}</div> : null} />
                  <Bar dataKey="v" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                    {c.revQ.map(([d]) => <Cell key={d} fill={p.approval && d >= p.approval ? "#0E7C74" : "#9FB4B6"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="empty">No quarterly revenue reported yet.</p>}
            <p className="colnote">Total quarterly revenue from SEC filings, including any partnership income; quarters after approval in teal. Product sales from the first full quarter appear once the company files that 10-Q.</p>
          </div>
        ))}
        <h3 className="subhead">Patient-based sales model</h3>
        <SalesModel />
      </section>

      <section className="panel">
        <header className="ph"><h2>When copies can compete</h2>
          <span className="ph-note">The earliest date US law lets a generic or biosimilar launch, from the approval pathway. Patents, lawsuits and settlements can push the real date later; those aren't modeled yet.</span></header>
        <div className="tablewrap">
          <table className="grid">
            <thead><tr><th>Program</th><th>Pathway</th><th>Expected approval</th><th>Protection</th><th className="r">Earliest competition</th></tr></thead>
            <tbody>
              {exShown.map(({ c, p, ea, ex }) => {
                return (
                  <tr key={c.t + p.d} onClick={() => go("company", c.t, "pipeline")}>
                    <td><b>{c.t}</b> {p.d}<span className="sub">{p.ph}</span></td>
                    <td>{ex.path === "BLA" ? "Biologic (BLA)" : "Drug (NDA)"}</td>
                    <td>{fmtDate(ea.date)}<span className="sub">{ea.basis}</span></td>
                    <td>{ex.path === "BLA" ? "12 years biologic exclusivity" : "5 years new-drug exclusivity"}{ex.orphan ? <span className="sub">{ex.orphan === "likely" ? "Orphan exclusivity (7 years) if designated" : "Orphan exclusivity, 7 years"}</span> : null}</td>
                    <td className="r"><b>{new Date(ex.until + "T00:00:00").getFullYear()}</b>{ex.patent ? <span className="sub">patents to {ex.patent}</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {exMore}
        <p className="colnote">Programs whose drug type doesn't map to a pathway are left out. "Expected approval" for unfiled programs is a rough guide.</p>
      </section>

      <p className="disclaimer">Research models built from public data. They are not investment advice and do not recommend buying or selling any security.</p>
    </div>
  );
}

/* -------------------------------- about -------------------------------- */

const COMPETITORS = [
  ["Helixora", "Yes", "Yes", "Yes, with a published formula", "Yes"],
  ["DilutionTracker", "Yes, with risk ratings", "No", "No", "Offering history"],
  ["BiopharmaWatch", "Runway and dilution on company pages", "Yes", "Not described", "Not described"],
  ["BioPharmCatalyst", "Not a focus", "Yes", "No", "No"],
];

const PROBLEMS = [
  ["live", "Cash runway and dilution risk", "Small biotechs raise money again and again. Knowing who has to raise next, and when, matters for returns.",
    "The Financing Pressure Score joins cash, burn, debt, ATM and shelf filings with the next catalyst date. Next: predicting the timing and size of the next offering, and catching raises made from strength.", "report"],
  ["live", "Catalyst timing", "Readout dates are often vague, like \"2H 2027,\" and they slip.",
    "Every trial gets an estimated readout window from its registry status, staleness and recorded date slips, and the score uses it. Next: calibrating the windows against actual readouts and adding options-market pricing.", "outlook"],
  ["live", "Trial success odds that fit the drug", "Most models use industry-wide averages by phase.",
    "Odds start from published rates for each disease area, then adjust for drug type, rare disease and biomarker selection. The Valuation tab now uses them. Next: mechanism and sponsor track record.", "outlook"],
  ["live", "Red flags in trial design", "Small studies, soft endpoints and changed analysis plans often come before failure.",
    "Each lead trial is checked for size, randomization, blinding, control arm, endpoint type, sites and date changes. Next: statistical power and changes to the analysis plan.", "outlook"],
  ["live", "FDA behavior", "Advisory votes, delays and rejection letters follow patterns few people track.",
    "Every upcoming FDA decision gets base-rate odds and the record of the office likely to review it, from 445 published rejection letters. Next: advisory committee votes and review delays.", "outlook"],
  ["live", "Read-through between companies", "One company's result moves its competitors' shares too.",
    "Rival Phase II and III trials in the same diseases, finishing within 18 months, are listed for every company. Next: estimating how much a rival's result should move each stock.", "outlook"],
  ["live", "China and ex-US pipelines", "More licensed drugs now come from Chinese biotechs, and the data is scattered.",
    "Rival trials run entirely or partly in China are flagged and gathered in one list. Next: tracking licensing deals.", "outlook"],
  ["live", "Sales after approval", "Many approved drugs miss sales expectations.",
    "Launched products' quarterly revenue is tracked from SEC filings, beside a patient-based sales model you can fill in. Next: comparing launches with past ones.", "outlook"],
  ["live", "Patent cliffs", "Exclusivity often ends later or sooner than the main patent suggests.",
    "The earliest date a copy can compete under US law is worked out from each drug's approval pathway. Next: patent dates, lawsuits and settlements.", "outlook"],
];
const STATUS = { live: "Live, version 1", next: "Next", later: "Not yet" };

const TRACKS = [
  ["Valuation", "What a company and its pipeline may be worth under stated assumptions, as a range rather than one price.",
    "Risk-adjusted pipeline value with drug-specific odds, and a 4,000-run simulation of equity value against market value.",
    "Updating odds when new trial results arrive, and counting warrants, convertibles and royalties in the share count."],
  ["Prediction", "The chance of specific events, like a raise or a readout, from what was public at the time.",
    "Readout windows, a cash survival simulation, and a first financing-risk model, published even though it doesn't yet beat the simple average.",
    "Time-to-event models for readouts and raises, tested on a much larger group of companies."],
  ["Market research", "Whether any of this lines up with how share prices actually move.",
    "An event study of share prices around stock offerings, measured against the biotech index.",
    "Event studies around trial results and FDA decisions with exact announcement times, and costed, out-of-sample tests."],
];

const LIBRARY = [
  ["Risk-adjusted net present value", "Built", "Every program, with drug-specific odds (Valuation tab)."],
  ["Monte Carlo simulation", "Built", "Cash survival paths and a range of equity values."],
  ["Dilution and financing risk", "Built", "Financing Pressure Score, likely size of the next raise and its dilution, and a first logistic model."],
  ["Bayesian clinical probability", "Built", "Odds after a readout succeeds or fails, and the value at stake (Trials & FDA)."],
  ["Event studies", "Partial", "Share prices around stock offerings. Trial results and FDA decisions need exact announcement times first."],
  ["Survival analysis", "Built", "Kaplan-Meier curves of how long about 16,000 industry trials took, used to check each registry timeline."],
  ["Scenario and sensitivity analysis", "Built", "Bear, base and bull cases and a chart of which assumption matters most."],
  ["Time-series forecasting", "Built", "Quarterly burn projected with exponential smoothing."],
  ["Anomaly detection", "Built", "Alerts for unusual burn, price moves, new offerings, trial delays and band changes."],
  ["Logistic regression", "Built", "The financing-risk test; published even though it doesn't beat the average yet."],
  ["Multi-factor ranking", "Later", "Ranking 8 companies says little. Waits for the wider universe."],
  ["Document text extraction", "Partial", "FDA letters are read by keyword; reading trial delays out of 8-K filings comes next."],
  ["Random forests and gradient boosting", "Later", "Need thousands of labeled outcomes; would overfit today."],
  ["Portfolio optimization", "Not planned", "Helixora is research, not personal portfolio advice."],
];

const JUDGED = [
  ["Readout windows", "Share of readouts that land inside the window", "Tracking from November 2026"],
  ["Trial-duration curves", "Concordance: do trials predicted to run longer actually run longer?", "Tracking from November 2026"],
  ["Burn forecast", "Error against each new quarterly filing", "Checked at every 10-Q"],
  ["Financing Pressure Score", "Whether High scorers raise within six months more often than Low scorers", "First check due April 2027"],
  ["Financing-risk model", "Brier score against simply assuming the average", "First test published: not yet better"],
  ["Approval odds", "Calibration: of drugs given 70%, about 70% should succeed", "Needs outcomes; starts with each readout"],
  ["Offering event study", "Abnormal returns with ranges, checked for overlapping news", "Live on the Research page"],
  ["Equity value range", "How much the range moves when each assumption changes", "Published for each company"],
];

// One page for who Helixora is and how it works (the former About and Methodology pages).
const ABOUT_SECTIONS = [["problem", "The problem"], ["compare", "How it compares"], ["score", "The score"], ["coverage", "Coverage"], ["cyber", "Cyber Risk"], ["track", "Track record"], ["roadmap", "Roadmap"], ["sources", "Sources"]];

function About({ go, anchor }) {
  const rr = useMemo(() => raiseRunway(COMPANIES), []);
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  useEffect(() => { if (anchor) setTimeout(() => jump(anchor), 80); }, [anchor]);
  return (
    <div className="stack about">
      <section className="panel report-head">
        <p className="kicker-static">About us</p>
        <h1 className="report-h">We help investors see a biotech's next stock sale coming.</h1>
        <p className="lead-dek">Catalyst calendars give you dates. Professional terminals cost a fortune. Helixora puts a company's cash, its upcoming news and its ability to raise money side by side, for funds, family offices and serious individual investors, and shows you the filing behind every number.</p>
        <nav className="toc" aria-label="On this page">
          {ABOUT_SECTIONS.map(([id, l]) => <button key={id} onClick={() => jump(id)}>{l}</button>)}
        </nav>
      </section>

      <section className="pillars">
        {PILLARS.map(([h, m, p]) => (
          <div key={h} className="pillar"><h3>{h}</h3><p>{m}</p><span>{p}</span></div>
        ))}
      </section>

      <section className="panel" id="problem">
        <header className="ph"><h2>The problem</h2></header>
        <p className="lead-dek problem-h">Biotech investors keep getting hit by stock offerings they could have seen coming.</p>
        <p className="prose">Clinical-stage biotechs burn cash and earn little, so most of them sell new shares again and again. Each raise dilutes existing shareholders, often at a discount. The warning signs are public, but they sit in three different places, and almost nobody lines them up in time.</p>
        <div className="three">
          <div className="metric"><span>How much cash is left</span><b className="three-b">The quarterly report</b><em>10-Q and 10-K filings on SEC EDGAR</em></div>
          <div className="metric"><span>When the next big event lands</span><b className="three-b">Trial registries and FDA dates</b><em>ClinicalTrials.gov, company guidance</em></div>
          <div className="metric"><span>Whether shares can be sold overnight</span><b className="three-b">Shelf and ATM filings</b><em>S-3 and 424B prospectuses</em></div>
        </div>
      </section>

      <section className="panel">
        <header className="ph"><h2>What Helixora does</h2></header>
        <p className="prose">Helixora puts those three pieces side by side and answers one question for every company: <b>does the cash run out before the next big readout or FDA decision, and can the company sell stock quickly when it wants to?</b> The answer is the Financing Pressure Score, from 0 to 100. Every number links to the filing it came from, and the formula is public.</p>
        <div className="id-ctas" style={{ marginTop: 6 }}>
          <button className="btn primary" onClick={() => go("report")}>See today's Pressure Report</button>
          <button className="btn" onClick={() => jump("score")}>How the score works</button>
        </div>
      </section>

      <div className="two">
        <section className="panel">
          <header className="ph"><h2>Who it's for</h2></header>
          <ul className="watch">
            <li><b>Biotech analysts and fund managers</b> who don't want to hold a stock into a discounted offering, or who look for companies likely to raise.</li>
            <li><b>Generalist investors with biotech exposure</b> who don't have time to read every filing.</li>
            <li><b>Individual biotech investors</b>, who are hurt most by surprise offerings.</li>
            <li><b>Biotech management and investor relations</b>, to see how the market reads their runway.</li>
          </ul>
        </section>
        <section className="panel">
          <header className="ph"><h2>Where Helixora stands today</h2></header>
          <ul className="watch">
            <li>It covers {COMPANIES.length} clinical-stage companies, with more to come.</li>
            <li>The score is a published starting point. Its first six-month test against real offerings is due in April 2027, and the results will be published either way.</li>
            {rr.n > 0 && <li>Past offerings show two kinds of raise: {rr.under24} of {rr.n} came from companies with under two years of cash, and {rr.bins.at(-1).n} from companies with three years or more that raised after good news. The score is built for the first kind; catching the second is on the roadmap. <button className="morelink" style={{ padding: 0 }} onClick={() => go("research")}>See the research</button></li>}
          </ul>
        </section>
      </div>

      <section className="panel" id="compare">
        <header className="ph"><h2>How it compares</h2>
          <span className="ph-note">Other tools cover half of the question. Dilution trackers show how easily a company can raise; catalyst calendars show when its big day is. Helixora joins the two.</span></header>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Tool</th><th>Cash, shelf and ATM</th><th>Catalyst dates</th><th>One score joining both</th><th>Each figure linked to its filing</th></tr></thead>
            <tbody>{COMPETITORS.map((r, i) => <tr key={r[0]} className={i === 0 ? "us" : ""}>{r.map((v, j) => <td key={j}>{j === 0 ? <b>{v}</b> : v}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="colnote">Other tools are described from their public pages as of October 2026 and may have changed.</p>
      </section>

      <section className="panel" id="problems">
        <header className="ph"><h2>The problems biotech investors face, and where Helixora is on each</h2>
          <span className="ph-note">Each now has a first version on the site, built from public data with its rules written out. Each card says what comes next.</span></header>
        <div className="probs">
          {PROBLEMS.map(([st, title, pain, where, link]) => (
            <article key={title} className={"prob st-" + st}>
              <span className={"stchip st-" + st}>{STATUS[st]}</span>
              <h3>{title}</h3>
              <p className="prob-pain">{pain}</p>
              {where && <p className="prob-where">{where}</p>}
              {link && <button className="morelink" onClick={() => go(link)}>{link === "report" ? "Open the Pressure Report" : "Open Trials & FDA"}</button>}
            </article>
          ))}
        </div>
      </section>

      <section className="panel" id="score">
        <header className="ph"><h2>The Financing Pressure Score</h2><span className="ph-note">Version {FPS_VERSION}, updated {fmtDate(FPS_UPDATED)}</span></header>
        <p className="prose">One number from 0 to 100 for one question: how likely is a company to need new money before its next big event? It describes a financing situation. It never says buy or sell.</p>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Component</th><th className="r">Weight</th><th>What it measures</th><th>How it is scored</th></tr></thead>
            <tbody>{FPS_COMPONENTS.map((k) => <tr key={k.key}><td>{k.label}</td><td className="r mono">{Math.round(k.weight * 100)}%</td><td>{k.measures}</td><td className="sub-c">{k.rule}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="bands">
          {FPS_BANDS.map((b) => <span key={b.label} className={"fps fps-" + b.label.toLowerCase()}><b>{b.min}–{b.max}</b><span>{b.label}</span></span>)}
        </div>
        <h3 className="subhead">Definitions</h3>
        <dl className="facts defs">
          <dt>Runway</dt><dd>Cash, cash equivalents and marketable securities divided by monthly operating cash burn. Burn is the trailing twelve months of operating cash flow from SEC filings, divided by twelve, which smooths out lumpy quarters.</dd>
          <dt>Next catalyst</dt><dd>The next clinical or regulatory event: the middle of Helixora's estimated readout window for a trial (built from its ClinicalTrials.gov dates, status and history), or a date the company has guided to, such as a PDUFA date. Earnings, extension studies and readouts with overdue registry dates do not count. If nothing is dated, we assume {NO_CATALYST_MONTHS} months.</dd>
          <dt>Gap</dt><dd>Runway minus (months to catalyst + a {BUFFER_MONTHS}-month buffer). The buffer reflects that companies rarely wait until the cash is gone to raise.</dd>
          <dt>Raise-ready capacity</dt><dd>An at-the-market program is identified from a sales agreement disclosed in a prospectus supplement (424B5) or shelf registration (S-3) filed in the past three years. Each company page links to the filing used.</dd>
          <dt>Missing data</dt><dd>If a component can't be calculated from filings, it is left out and the remaining weights are scaled up. The company page says which components were used.</dd>
        </dl>
        <p className="colnote">These weights are our best first guess. We'll test them against past offerings and log every change below.</p>
      </section>

      <div id="coverage" className="anchor"><CoveragePanel /></div>
      <div id="cyber" className="anchor"><CyberAbout go={go} /></div>
      <div id="track" className="anchor"><TrackRecord go={go} /></div>

      <section className="panel" id="roadmap">
        <header className="ph"><h2>Where Helixora is going</h2>
          <span className="ph-note">The research question behind everything on this site.</span></header>
        <p className="finding">Can we tell when a small biotech's clinical prospects, its chance of surviving financially, or its capital structure imply a value very different from its share price?</p>
        <h3 className="subhead">Three research tracks, each judged on its own</h3>
        <div className="probs">
          {TRACKS.map(([title, aim, built, next]) => (
            <article key={title} className="prob">
              <h3 style={{ marginTop: 0 }}>{title}</h3>
              <p className="prob-pain">{aim}</p>
              <p className="prob-where"><b>Built:</b> {built}</p>
              <p className="prob-where" style={{ marginTop: 6 }}><b>Next:</b> {next}</p>
            </article>
          ))}
        </div>
        <h3 className="subhead">Three products, in this order</h3>
        <ol className="tr-list">
          <li><b>Cash and dilution tracker.</b> Live now: the Pressure Report, the Financing Pressure Score and the cash simulation. <button className="morelink" style={{ padding: 0 }} onClick={() => go("report")}>Open</button></li>
          <li><b>Trials and FDA events.</b> A first version is live: readout windows, trial design flags, FDA decisions and rival trials. <button className="morelink" style={{ padding: 0 }} onClick={() => go("outlook")}>Open</button></li>
          <li><b>Pipeline valuation.</b> Started: drug-by-drug odds and a simulated range of values on each company's Valuation tab.</li>
        </ol>
        <h3 className="subhead">The model library</h3>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Method</th><th>Status</th><th>Where it is</th></tr></thead>
            <tbody>{LIBRARY.map(([a, b, c]) => <tr key={a}><td><b>{a}</b></td><td><span className={"stchip " + (b === "Built" ? "st-live" : b === "Partial" ? "st-next" : "st-later")}>{b}</span></td><td>{c}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="colnote">Each model is validated on its own before any of them are combined, so one model's strength can't hide another's weakness. A single combined score across all of them waits until each has a track record.</p>
        <h3 className="subhead">How each model will be judged</h3>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>Model</th><th>Measured by</th><th>Status</th></tr></thead>
            <tbody>{JUDGED.map(([a, b, c]) => <tr key={a}><td><b>{a}</b></td><td>{b}</td><td>{c}</td></tr>)}</tbody>
          </table>
        </div>
        <h3 className="subhead">Data rules</h3>
        <ul className="watch">
          <li>Every figure carries two dates: what it describes, and when the public could first see it. Past studies use only what was public at the time.</li>
          <li>Every prediction is logged each day with the version of the model that made it, and never edited afterward. <a className="src" href="/data/predictions.json" target="_blank" rel="noreferrer">Download the prediction log</a></li>
          <li>Coverage grows from {COMPANIES.length} companies to 50 to 100 U.S.-listed clinical-stage biotechs, picked by published rules, including companies that later fail or are bought so past results aren't flattered.</li>
        </ul>
      </section>

      <div className="two" id="sources">
        <section className="panel">
          <header className="ph"><h2>Change log</h2></header>
          <ul className="watch">{FPS_CHANGELOG.map((x) => <li key={x.version}><b>Version {x.version}, {fmtDate(x.date)}.</b> {x.note}</li>)}</ul>
        </section>
        <section className="panel">
          <header className="ph"><h2>Sources</h2></header>
          <ul className="watch">
            <li><ExtLink href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces">SEC EDGAR</ExtLink>: balance sheets, cash flows, share counts, offering filings, shelf registrations.</li>
            <li><ExtLink href="https://clinicaltrials.gov/data-api/api">ClinicalTrials.gov</ExtLink>: trial phase, enrollment, endpoints and primary completion dates.</li>
            <li>Yahoo Finance: previous closing prices, used for market value.</li>
          </ul>
        </section>
      </div>

      <p className="disclaimer">Helixora publishes general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.</p>
    </div>
  );
}

/* ------------------------------ cyber risk ------------------------------ */

const GRADE_TONE = { A: "g-a", B: "g-b", C: "g-c", D: "g-d", F: "g-f" };
const CyberGrade = ({ g, big }) => (g ? <span className={"cgrade " + GRADE_TONE[g] + (big ? " big" : "")}>{g}</span> : <span className="cgrade none">—</span>);
const pctMove = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const groupName = (g) => (g === "coverage" ? "Biotech coverage" : segLabel(g) || g);

// What the grade is made of, said once and used on every cyber page.
function CyberMethodNote({ go }) {
  return (
    <p className="colnote">
      <b>How the grade works.</b> Half comes from the company's own annual report: the cybersecurity section every US-listed company must now include (10-K Item 1C, or Item 16K in a foreign company's 20-F), scored against an 11-point checklist. Half comes from passive checks of its public website and email setup: the same things a browser or mail server sees on a normal visit. Each material incident filed under 8-K Item 1.05 in the last two years takes off 10 points (up to 20). A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, F below. A good grade means the company describes and shows sound basics; it can't prove a company is secure, and a weak public setup doesn't mean it has been breached. <button className="linkish" onClick={() => go("cybermethod")}>More on the method, and how to dispute a finding</button>.
    </p>
  );
}

function CyberScores({ go }) {
  const all = Object.values(CYBER.companies || {});
  const [grp, setGrp] = useState("all");
  const [sort, setSort] = useState("overall");
  const [q, setQ] = useState("");
  if (!all.length) return <section className="panel"><header className="ph"><h2>Cyber Scores</h2></header><p className="prose">Cyber scores arrive with the next weekly cyber check.</p></section>;
  const groups = [["all", "All"], ["coverage", "Biotech coverage"], ...SEGMENTS.filter(([g]) => all.some((x) => x.group === g)).map(([g, l]) => [g, l])];
  const keys = {
    overall: (x) => x.overall ?? -1, gov: (x) => x.governance?.score ?? -1, setup: (x) => x.setup?.score ?? -1,
    inc: (x) => x.incidents.length, name: (x) => x.n,
  };
  const rows = all
    .filter((x) => grp === "all" || x.group === grp)
    .filter((x) => !q || (x.t + " " + x.n).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === "name" ? a.n.localeCompare(b.n) : sort === "inc" ? keys.inc(b) - keys.inc(a) : keys[sort](a) - keys[sort](b)));
  const th = (k, label, r = true) => <th className={r ? "r" : ""} onClick={() => setSort(k)}>{label}<span className="sortmark">{sort === k ? "▾" : ""}</span></th>;
  const m = CYBER.meta || {};
  const withInc = all.filter((x) => x.incidents.some((i) => i.item === "1.05"));
  const gap = (x) => {
    const miss = (x.setup?.items || []).filter((i) => i.got === 0).map((i) => i.key);
    return [miss.includes("dmarc") && "email can be spoofed", miss.includes("securitytxt") && "no bug-report contact", x.governance == null && "no cyber section found", x.governance?.noStaff && "no dedicated security staff"].filter(Boolean).slice(0, 2).join("; ");
  };
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Cyber Risk</p>
        <h1 className="report-h">How well do drug companies guard their systems?</h1>
        <p className="lead-dek">A grade for each of the {all.length} companies on Helixora, from what they tell the SEC about cybersecurity and what anyone can see of their public web and email setup. Lowest grades first. Click a company for the evidence behind every point.</p>
        <div className="metrics four">
          {["A", "B", "C", "D"].map((g) => <div className="metric" key={g}><span>Grade {g}{g === "D" ? " or F" : ""}</span><b>{g === "D" ? (m.grades?.D || 0) + (m.grades?.F || 0) : m.grades?.[g] || 0}</b></div>)}
        </div>
        <p className="byline">{withInc.length ? <>{withInc.length} {withInc.length === 1 ? "company has" : "companies have"} filed a material cyber incident since the SEC rule began in December 2023: {withInc.map((x) => x.t).join(", ")}. </> : "None of these companies has filed a material cyber incident since the SEC rule began in December 2023. "}Checked {fmtDate((m.generatedAt || "").slice(0, 10))}.</p>
      </section>
      <section className="panel">
        <div className="chips">{groups.map(([k, l]) => <button key={k} className={"chip" + (grp === k ? " on" : "")} onClick={() => setGrp(k)}>{l}</button>)}</div>
        <input className="cyber-search" placeholder="Filter by company or ticker" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tablewrap">
          <table className="grid">
            <thead><tr>{th("name", "Company", false)}{th("overall", "Grade")}{th("gov", "Governance (annual report)")}{th("setup", "Public setup")}{th("inc", "Incidents filed")}<th>Biggest gaps</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.t} onClick={() => go("company", x.t, "cyber")}>
                <td className="nm"><span className="tick">{x.t}</span> {x.n}<span className="sub">{groupName(x.group)}{x.domain ? ` · ${x.domain}` : ""}</span></td>
                <td className="r"><CyberGrade g={x.grade} /> <span className="num">{x.overall ?? ""}</span></td>
                <td className="r num">{x.governance ? x.governance.score : <span className="sub">not found</span>}</td>
                <td className="r num">{x.setup ? x.setup.score : <span className="sub">not checked</span>}</td>
                <td className="r num">{x.incidents.length ? <b className="down">{x.incidents.length}</b> : "0"}</td>
                <td className="sub">{gap(x) || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <CyberMethodNote go={go} />
      </section>
    </div>
  );
}

function CyberIncidents({ go }) {
  const st = CYBER.study;
  const ours = Object.values(CYBER.companies || {}).flatMap((x) => x.incidents.map((i) => ({ ...i, t: x.t, n: x.n }))).sort((a, b) => (a.date < b.date ? 1 : -1));
  const onSite = (t) => !!findCo(t);
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Cyber Incidents</p>
        <h1 className="report-h">What happens to a stock after a company reports a cyber attack</h1>
        <p className="lead-dek">Since 18 December 2023, a US-listed company must file an 8-K under Item 1.05 within four business days of deciding a cybersecurity incident is material. This page follows every such first filing and measures the share price against the S&P 500 afterwards.</p>
      </section>
      {st && st.day1 ? (
        <section className="panel">
          <header className="ph"><h2>Share price against the S&P 500 after a first Item 1.05 filing</h2><span className="ph-note">{st.day1.n} incidents with prices, of {st.firstFilings} first filings ({st.allFilings} Item 1.05 filings in all, counting updates)</span></header>
          <div className="metrics four">
            <div className="metric"><span>Next trading day, average</span><b className={st.day1.mean < 0 ? "down" : "up"}>{pctMove(st.day1.mean)}</b></div>
            <div className="metric"><span>After a week, average</span><b className={st.day5.mean < 0 ? "down" : "up"}>{pctMove(st.day5.mean)}</b></div>
            <div className="metric"><span>After a month, average</span><b className={st.day30.mean < 0 ? "down" : "up"}>{pctMove(st.day30.mean)}</b></div>
            <div className="metric"><span>Fell behind the market within a month</span><b>{st.day30.shareDown}%</b></div>
          </div>
          <p className="finding">The typical company (the median) was {pctMove(st.day1.median)} the next day, {pctMove(st.day5.median)} after a week and {pctMove(st.day30.median)} after a month, against the S&P 500. Most of the damage comes after the first day, as the cost and scope of an incident become clearer.</p>
          <p className="colnote">Day 0 is the first trading day on or after the filing date, measured from the previous close (8-Ks are often filed after the market closes). "After a week" is five trading days; "after a month" is 21. Small sample, many industries, and other news can land in the same window, so read these as a rough guide, not a forecast.</p>
          <div className="tablewrap">
            <table className="grid">
              <thead><tr><th>Filed</th><th>Company</th><th className="r">Next day</th><th className="r">Week</th><th className="r">Month</th><th></th></tr></thead>
              <tbody>{st.events.map((e) => (
                <tr key={e.cik + e.date} onClick={onSite(e.ticker) ? () => go("company", e.ticker, "cyber") : undefined} className={onSite(e.ticker) ? "" : "noclick"}>
                  <td>{fmtDate(e.date)}</td>
                  <td className="nm"><span className="tick">{e.ticker}</span> {tidy(e.name)}{onSite(e.ticker) ? <span className="sub"> · on Helixora</span> : null}</td>
                  <td className={"r num " + (e.d1 < 0 ? "down" : "up")}>{pctMove(e.d1)}</td>
                  <td className={"r num " + (e.d5 < 0 ? "down" : "up")}>{pctMove(e.d5)}</td>
                  <td className={"r num " + (e.d30 < 0 ? "down" : "up")}>{pctMove(e.d30)}</td>
                  <td><a className="src" href={e.url} target="_blank" rel="noopener noreferrer" onClick={(ev) => ev.stopPropagation()}>8-K</a></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : <section className="panel"><p className="prose">The incident study arrives with the next weekly cyber check.</p></section>}
      <section className="panel">
        <header className="ph"><h2>Incidents at companies on Helixora</h2></header>
        {ours.length ? (
          <ul className="cy-inc">{ours.map((i) => (
            <li key={i.t + i.date + i.item}><button className="linkish" onClick={() => go("company", i.t, "cyber")}><b>{i.t}</b> {i.n}</button> · {fmtDate(i.date)} · {i.item === "1.05" ? "material incident (Item 1.05)" : `voluntary disclosure (Item ${i.item})`}{i.amended ? " · update" : ""} · <a className="src" href={i.url} target="_blank" rel="noopener noreferrer">filing</a>{i.text ? <span className="sub"> "{i.text}"</span> : null}</li>
          ))}</ul>
        ) : <p className="prose">None of the companies on Helixora has disclosed a cybersecurity incident to the SEC since December 2023.</p>}
      </section>
    </div>
  );
}

// "BOSTON SCIENTIFIC CORP" → "Boston Scientific Corp"
const tidy = (n) => (n && n === n.toUpperCase() ? n.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\/[a-z]+\/?$/i, "").trim() : n);

function CyberPanel({ t }) {
  const x = CYBER.companies?.[t];
  if (!x) return null;
  const g = x.governance, s = x.setup;
  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Cyber risk</h2><span className="ph-note">Checked {fmtDate((CYBER.meta?.generatedAt || "").slice(0, 10))}</span></header>
        <div className="cy-head">
          <CyberGrade g={x.grade} big />
          <div className="metrics four">
            <div className="metric"><span>Overall</span><b>{x.overall ?? "—"}</b></div>
            <div className="metric"><span>Governance, from the annual report</span><b>{g ? g.score : "—"}</b></div>
            <div className="metric"><span>Public setup{x.domain ? ` (${x.domain})` : ""}</span><b>{s ? s.score : "—"}</b></div>
            <div className="metric"><span>Incidents filed since Dec 2023</span><b className={x.incidents.length ? "down" : ""}>{x.incidents.length}</b></div>
          </div>
        </div>
        {x.incidentPenalty ? <p className="finding">{x.incidentPenalty} points off for material incidents filed in the last two years.</p> : null}
        {x.incidents.length > 0 && (
          <ul className="cy-inc">{x.incidents.map((i) => <li key={i.date + i.item}>{fmtDate(i.date)} · {i.item === "1.05" ? "material incident (8-K Item 1.05)" : `voluntary disclosure (8-K Item ${i.item})`}{i.amended ? " · update" : ""} · <a className="src" href={i.url} target="_blank" rel="noopener noreferrer">read the filing</a>{i.text ? <span className="sub"> "{i.text}"</span> : null}</li>)}</ul>
        )}
      </section>
      <section className="panel">
        <header className="ph"><h2>What its annual report says</h2>{x.annual && <span className="ph-note"><a className="src" href={x.annual.url} target="_blank" rel="noopener noreferrer">{x.annual.form} filed {fmtDate(x.annual.date)}</a></span>}</header>
        {g ? (
          <>
            <table className="grid plain cy-check">
              <tbody>{g.items.map((i) => (
                <tr key={i.key}>
                  <td className={"cy-mark " + (i.got === i.pts ? "ok" : i.got ? "part" : "no")}>{i.got === i.pts ? "✓" : i.got ? "◐" : "✗"}</td>
                  <td><b>{i.label}</b>{i.evidence ? <span className="cy-quote">"{i.evidence}"</span> : <span className="sub"> Not found in the section.</span>}</td>
                  <td className="r num">{i.got}/{i.pts}</td>
                </tr>
              ))}</tbody>
            </table>
            {g.noStaff && <p className="finding">10 points off: the company says it has no dedicated security staff. <span className="cy-quote">"{g.noStaff}"</span></p>}
            {g.saysNoMaterial && <p className="colnote">The company also states: "{g.saysNoMaterial}"</p>}
          </>
        ) : <p className="prose">We couldn't find the cybersecurity section in its latest annual report{x.annual ? ` (${x.annual.form}, ${fmtDate(x.annual.date)})` : ""}. That can mean it's worded or laid out unusually rather than missing; the grade uses the public setup alone.</p>}
      </section>
      <section className="panel">
        <header className="ph"><h2>What anyone can see of its setup</h2>{x.domain && <span className="ph-note">{x.web?.host || x.domain}</span>}</header>
        {s ? (
          <table className="grid plain cy-check">
            <tbody>{s.items.map((i) => (
              <tr key={i.key}>
                <td className={"cy-mark " + (i.got === i.pts ? "ok" : i.got ? "part" : "no")}>{i.got === i.pts ? "✓" : i.got ? "◐" : "✗"}</td>
                <td><b>{i.label}</b><span className="sub"> {i.detail}</span></td>
                <td className="r num">{i.got}/{i.pts}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="prose">We couldn't find or reach the company's website, so its public setup isn't scored.</p>}
        <p className="colnote">These are passive checks: a few DNS lookups and two or three ordinary page requests, identified as Helixora. Nothing is scanned, probed or logged into. Missing items are common good practice, not proof of a weakness.</p>
      </section>
      <CorrectionForm ticker={t} topic="cyber" />
    </div>
  );
}

function CorrectionForm({ ticker, topic = "other" }) {
  const [msg, setMsg] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");
  const { mount, token, ready, used } = useHumanCheck();
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setState("sending");
    try {
      const res = await fetch("/api/correction", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticker, topic, message: msg, email, botField: "", turnstileToken: token }) });
      used();
      setState(res.ok ? "done" : "error");
    } catch { setState("error"); }
  };
  if (state === "done") return <section className="panel"><p className="wl-done">Thanks. We'll review it, and if we got something wrong we'll correct it and note the change.</p></section>;
  return (
    <section className="panel">
      <header className="ph"><h2>Something wrong here?</h2></header>
      <form className="correction" onSubmit={submit}>
        <p className="prose">If you work at {ticker ? ticker : "a company we cover"} or spot a mistake, tell us what's wrong and, if you can, where to see the right answer. We read every report and correct mistakes.</p>
        <label className="sr" htmlFor="corr-msg">What's wrong</label>
        <textarea id="corr-msg" required minLength={10} maxLength={2000} rows={4} placeholder="What's wrong, and where can we check it?" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <div className="wl-fields">
          <label className="sr" htmlFor="corr-email">Email (optional)</label>
          <input id="corr-email" type="email" placeholder="Your email, if you'd like a reply (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" disabled={state === "sending" || !ready}>{state === "sending" ? "Sending…" : ready ? "Send" : "Checking…"}</button>
        </div>
        <div ref={mount} className="ts-box" />
        {state === "error" && <p className="wl-err">That didn't go through. Try again in a minute.</p>}
      </form>
    </section>
  );
}

/* ---------------------------- drug industry ---------------------------- */

function IndustryTable({ rows, go }) {
  const [sort, setSort] = useState("mcap");
  const keys = {
    mcap: (c) => -(c.mcap || 0), rev: (c) => -(c.rev || 0), ocf: (c) => -(c.ocf ?? -1e12), cash: (c) => -(c.cash || 0),
    next: (c) => { const n = (c.catalysts || []).filter((x) => x.kind !== "earnings" && days(x.date) >= 0).map((x) => days(x.date)); return n.length ? Math.min(...n) : 1e9; }, chg: (c) => -(c.quote?.chgPct ?? -1e9),
  };
  const sorted = [...rows].sort((a, b) => keys[sort](a) - keys[sort](b));
  const th = (k, label) => <th className="r" onClick={() => setSort(k)}>{label}<span className="sortmark">{sort === k ? "▾" : ""}</span></th>;
  return (
    <div className="tablewrap">
      <table className="grid">
        <thead><tr><th>Company</th>{th("mcap", "Market value")}{th("rev", "Revenue, last 12 mo")}{th("ocf", "Operating cash flow, 12 mo")}{th("cash", "Cash")}<th className="r">Debt</th><th className="r">Phase III programs</th>{th("next", "Next late-stage result")}{th("chg", "Price")}</tr></thead>
        <tbody>{sorted.map((c) => {
          // The next trial result or FDA decision; a routine quarterly report doesn't count here.
          const n = (c.catalysts || []).filter((x) => x.kind !== "earnings" && days(x.date) >= 0).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
          return (
            <tr key={c.t} onClick={() => go("company", c.t)}>
              <td className="nm"><span className="tick">{c.t}</span> {c.n}<span className="sub">{c.area}{c.src?.currency ? ` · reports in ${c.src.currency}` : ""}{c.stale ? " · not updated today" : ""}</span></td>
              <td className="r num">{money(c.mcap)}</td>
              <td className="r num">{money(c.rev)}</td>
              <td className="r num">{c.ocf == null ? "—" : c.ocf < 0 ? `−${money(-c.ocf)}` : money(c.ocf)}</td>
              <td className="r num">{money(c.cash)}</td>
              <td className="r num">{c.debt ? money(c.debt) : "None"}</td>
              <td className="r num">{c.pipeline.length || "—"}</td>
              <td className="r">{n ? <>{fmtDate(n.date)}<span className="sub"> {shortLabel(n.label)}</span></> : "—"}</td>
              <td className="r num">{c.quote?.price != null ? `$${num(c.quote.price)} ` : "—"}<Change c={c} /></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function Industry({ go }) {
  if (!INDUSTRY.length) return <section className="panel"><header className="ph"><h2>Drug Industry</h2></header><p className="prose">Drug industry figures arrive with the next data refresh.</p></section>;
  const total = INDUSTRY.reduce((s, c) => s + (c.mcap || 0), 0);
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Drug Industry</p>
        <h1 className="report-h">Who makes the world's legal medicines</h1>
        <p className="lead-dek">The {INDUSTRY.length} drug-industry companies here are the ones that buy, partner with, supply and compete against the {COMPANIES.length} biotechs Helixora covers. Together they're worth about {money(total)}. Most make money, so the Financing Pressure Score mostly doesn't apply to them. They're here for comparison and are never ranked with the biotechs.</p>
        <p className="byline">Jump to: {SEGMENTS.filter(([g]) => INDUSTRY.some((c) => c.group === g)).map(([g, l], i) => <span key={g}>{i ? " · " : ""}<a href={`#seg-${g}`} onClick={(e) => { e.preventDefault(); document.getElementById(`seg-${g}`)?.scrollIntoView({ behavior: "smooth" }); }}>{l}</a></span>)}</p>
      </section>
      {SEGMENTS.map(([g, label, blurb]) => {
        const rows = INDUSTRY.filter((c) => c.group === g);
        if (!rows.length) return null;
        return (
          <section className="panel" key={g} id={`seg-${g}`}>
            <header className="ph"><h2>{label}</h2><span className="ph-note">{blurb} {rows.length} {rows.length === 1 ? "company" : "companies"}, worth about {money(rows.reduce((s, c) => s + (c.mcap || 0), 0))}.</span></header>
            <IndustryTable rows={rows} go={go} />
          </section>
        );
      })}
      <p className="colnote">From each company's latest 10-Q, 10-K or 20-F on SEC EDGAR, and ClinicalTrials.gov. Foreign companies' figures are converted to US dollars at today's exchange rate; they report in detail once or twice a year, so their figures can be older (each company page gives the date). Only companies that file with the SEC can be included, which leaves out Roche, Bayer, Merck KGaA, Boehringer Ingelheim, Daiichi Sankyo, Astellas, Sandoz and most Indian, Chinese and European generic and ingredient makers.</p>
    </div>
  );
}

function CyberAbout({ go }) {
  const m = CYBER.meta;
  return (
    <section className="panel">
      <header className="ph"><h2>Cyber Risk: method and fairness</h2></header>
      <p className="prose">Helixora grades the cybersecurity of every company on the site from two kinds of public information, refreshed weekly. <button className="linkish" onClick={() => go("cyber")}>See the scores</button> or <button className="linkish" onClick={() => go("incidents")}>the incident study</button>.</p>
      <p className="prose"><b>What companies tell the SEC.</b> Since December 2023, every US-listed company must describe in its annual report how it manages cyber risk (10-K Item 1C; 20-F Item 16K for foreign companies), and must file an 8-K under Item 1.05 within four business days of deciding an incident is material. We read the cybersecurity section and award points for: {(m?.checks || []).map((c) => `${c.label.toLowerCase()} (${c.pts})`).join("; ")}. A company saying it has no dedicated security staff loses 10 points. Every point on a company's Cyber tab shows the sentence that earned it, linked to the filing. We also look for voluntary incident disclosures (8-K Items 8.01 and 7.01) where the company says it found an incident.</p>
      <p className="prose"><b>What anyone can see.</b> For each company's own website domain we check, passively: whether its email domain is protected against spoofing (DMARC, SPF), whether certificate issuance is restricted (CAA), whether the site uses HTTPS with current encryption, a valid certificate and HSTS, four common browser security headers, and whether it publishes a security.txt file telling researchers how to report a problem. That takes a few DNS lookups and two or three ordinary page requests per company, sent with the user agent "{m?.userAgent || "HelixoraCyberCheck"}". We don't scan ports, test for vulnerabilities, try logins or touch anything a normal visitor wouldn't.</p>
      <p className="prose"><b>What a grade can't tell you.</b> A strong report and tidy public setup are signs of sound basics, not proof a company is secure; a missing header is common practice, not a breach. The checks only cover a company's main website and email domain. If you work at a company we grade and think a finding is wrong, use the "Something wrong here?" form on its Cyber tab, or the one below. We review every report, correct mistakes and note the change.</p>
      <CorrectionForm topic="cyber" />
    </section>
  );
}

function CoveragePanel() {
  const g = UNIVERSE.grandfathered || {};
  return (
    <section className="panel">
      <header className="ph"><h2>Which companies Helixora covers, and why</h2>
        <span className="ph-note">Coverage follows published rules so it can't be picked to flatter results. Screened on {fmtDate(UNIVERSE.screenedOn)}; approved {fmtDate(UNIVERSE.approved)}.</span></header>
      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr><th>Rule</th><th className="r">Companies left</th></tr></thead>
          <tbody>{UNIVERSE.funnel.map(([rule, n], i) => <tr key={i}><td>{i + 1}. {rule}</td><td className="r">{n.toLocaleString("en-US")}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="prose" style={{ marginTop: 14 }}>{UNIVERSE.selection} The first {UNIVERSE.originalCoverage.length} companies stay unless they are bought{Object.keys(g).length ? <>, including {Object.keys(g).length} that sit outside today's rules: {Object.entries(g).map(([t, why]) => `${t} (${why.toLowerCase()})`).join(", ")}</> : null}. Companies are never dropped quietly; any change is listed here.</p>
      <p className="prose"><b>When a company is bought.</b> A company with a deal still pending stays, marked "Being acquired", until the deal closes. Once it closes, the company is removed from the site, whoever bought it, and the removal is listed below. The same goes for the drug-industry companies. Deals are read from each company's SEC filings every day.</p>
      {UNIVERSE.policy && <p className="prose">Turnover (approved {fmtDate(UNIVERSE.policy.approved)}): the screen re-runs on the 3rd of each month. A selected company stays while it still qualifies{UNIVERSE.policy.keepRank ? ` and ranks in the top ${UNIVERSE.policy.keepRank} by soonest Phase II or III completion` : ""}; otherwise it leaves, and open places are filled in order of soonest Phase II or III completion until coverage reaches {UNIVERSE.policy.total ?? UNIVERSE.policy.target} companies. Companies that leave keep their full score history.</p>}
      {(UNIVERSE.changes || []).length > 0 && (
        <>
          <h3 className="subhead">Coverage changes</h3>
          <ul className="watch">
            {[...UNIVERSE.changes].reverse().map((ch) => (
              <li key={ch.date}><b>{fmtDate(ch.date)}.</b>{" "}
                {ch.added.length ? <>Added {ch.added.length === UNIVERSE.selected.length && ch.added.every((a) => a.why === "initial selection") ? `the first ${ch.added.length} companies` : ch.added.map((a) => `${a.t} (${a.why})`).join(", ")}. </> : null}
                {ch.removed.length ? <>Removed {ch.removed.map((r) => `${r.t} (${r.why})`).join(", ")}.</> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="colnote">Everyone who qualifies in the latest screen: <a className="src" href="/data/universe.json" target="_blank" rel="noreferrer">download</a>. Program labels (disease area, drug type, rare disease, biomarker) are set automatically from drug names and trial records; each program card shows how.</p>
    </section>
  );
}

function RemoveMe() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");
  const { mount: tsMount, token: tsToken, ready: tsReady, used: tsUsed } = useHumanCheck();
  const submit = async (e) => {
    e.preventDefault();
    if (!tsReady) return;
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", email, turnstileToken: tsToken }),
      });
      tsUsed();
      setState(res.ok ? "done" : "error");
    } catch { setState("error"); }
  };
  if (state === "done") return <p className="wl-done">Done. If {email} was on the waitlist, it has been deleted.</p>;
  return (
    <form className="removeme" onSubmit={submit}>
      <label className="sr" htmlFor="rm-email">Email to remove</label>
      <input id="rm-email" type="email" required placeholder="you@fund.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn" type="submit" disabled={state === "sending" || !tsReady}>{state === "sending" ? "Removing…" : "Remove my email"}</button>
      <div ref={tsMount} className="ts-box" />
      {state === "error" && <p className="wl-err">That didn't go through. Try again in a few minutes.</p>}
    </form>
  );
}

function Privacy() {
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">Privacy</p>
        <h1 className="report-h">What Helixora collects, and what it doesn't.</h1>
        <p className="lead-dek">You can read every page without an account. Helixora sets no tracking cookies and doesn't sell or share data.</p>
      </section>
      <section className="panel">
        <header className="ph"><h2>What we collect</h2></header>
        <div className="tablewrap">
          <table className="grid plain">
            <thead><tr><th>When</th><th>What</th><th>Why</th><th>How long</th></tr></thead>
            <tbody>
              <tr><td><b>You join the waitlist</b></td><td>Your email, the role you pick (optional), your country as reported by Cloudflare, and the sign-up time</td><td>To send the Financing Pressure Report and see who it's useful to</td><td>Until you remove it</td></tr>
              <tr><td><b>You use Ask Helixora</b></td><td>Your question, sent to Anthropic's API to write the answer</td><td>To answer it. Helixora doesn't store questions.</td><td>Not kept by Helixora; Anthropic handles API data under its own terms</td></tr>
              <tr><td><b>You submit a form</b></td><td>A one-way scrambled code made from your IP address and the date; Cloudflare Turnstile may check your browser</td><td>To limit abuse and stop bots</td><td>Codes expire within a day</td></tr>
              <tr><td><b>You change a setting</b></td><td>Your watchlist and menu layout, stored in your own browser</td><td>To remember your choices</td><td>Until you clear your browser data; never sent to us</td></tr>
            </tbody>
          </table>
        </div>
        <p className="colnote">The site runs on Cloudflare, which processes visitors' IP addresses to deliver pages and block attacks. If page-view counts are turned on, they come from Cloudflare Web Analytics, which doesn't use cookies or track individuals.</p>
      </section>
      <section className="panel">
        <header className="ph"><h2>Remove your email</h2></header>
        <p className="prose">Enter the address you signed up with and it will be deleted from the waitlist straight away.</p>
        <RemoveMe />
      </section>
      <p className="disclaimer">Last updated November 4, 2026. If this page changes, the date above will change too.</p>
    </div>
  );
}

/* -------------------------------- logo --------------------------------
   The "x" in helixora is one turn of a double helix: two strands crossing,
   with base-pair rungs at the open ends. The masthead version adds a thin
   helix running under the whole word.                                     */

const HELIX_A = "M0.0,6.0 L1.2,6.6 L2.5,7.2 L3.8,7.8 L5.0,8.3 L6.2,8.7 L7.5,9.0 L8.8,9.1 L10.0,9.2 L11.2,9.1 L12.5,9.0 L13.8,8.7 L15.0,8.3 L16.2,7.8 L17.5,7.2 L18.8,6.6 L20.0,6.0 L21.2,5.4 L22.5,4.8 L23.8,4.2 L25.0,3.7 L26.2,3.3 L27.5,3.0 L28.8,2.9 L30.0,2.8 L31.2,2.9 L32.5,3.0 L33.8,3.3 L35.0,3.7 L36.2,4.2 L37.5,4.8 L38.8,5.4 L40.0,6.0 L41.2,6.6 L42.5,7.2 L43.8,7.8 L45.0,8.3 L46.2,8.7 L47.5,9.0 L48.8,9.1 L50.0,9.2 L51.2,9.1 L52.5,9.0 L53.8,8.7 L55.0,8.3 L56.2,7.8 L57.5,7.2 L58.8,6.6 L60.0,6.0 L61.2,5.4 L62.5,4.8 L63.8,4.2 L65.0,3.7 L66.2,3.3 L67.5,3.0 L68.8,2.9 L70.0,2.8 L71.2,2.9 L72.5,3.0 L73.8,3.3 L75.0,3.7 L76.2,4.2 L77.5,4.8 L78.8,5.4 L80.0,6.0 L81.2,6.6 L82.5,7.2 L83.8,7.8 L85.0,8.3 L86.2,8.7 L87.5,9.0 L88.8,9.1 L90.0,9.2 L91.2,9.1 L92.5,9.0 L93.8,8.7 L95.0,8.3 L96.2,7.8 L97.5,7.2 L98.8,6.6 L100.0,6.0 L101.2,5.4 L102.5,4.8 L103.8,4.2 L105.0,3.7 L106.2,3.3 L107.5,3.0 L108.8,2.9 L110.0,2.8 L111.2,2.9 L112.5,3.0 L113.8,3.3 L115.0,3.7 L116.2,4.2 L117.5,4.8 L118.8,5.4 L120.0,6.0 L121.2,6.6 L122.5,7.2 L123.8,7.8 L125.0,8.3 L126.2,8.7 L127.5,9.0 L128.8,9.1 L130.0,9.2 L131.2,9.1 L132.5,9.0 L133.8,8.7 L135.0,8.3 L136.2,7.8 L137.5,7.2 L138.8,6.6 L140.0,6.0 L141.2,5.4 L142.5,4.8 L143.8,4.2 L145.0,3.7 L146.2,3.3 L147.5,3.0 L148.8,2.9 L150.0,2.8 L151.2,2.9 L152.5,3.0 L153.8,3.3 L155.0,3.7 L156.2,4.2 L157.5,4.8 L158.8,5.4 L160.0,6.0 L161.2,6.6 L162.5,7.2 L163.8,7.8 L165.0,8.3 L166.2,8.7 L167.5,9.0 L168.8,9.1 L170.0,9.2 L171.2,9.1 L172.5,9.0 L173.8,8.7 L175.0,8.3 L176.2,7.8 L177.5,7.2 L178.8,6.6 L180.0,6.0 L181.2,5.4 L182.5,4.8 L183.8,4.2 L185.0,3.7 L186.2,3.3 L187.5,3.0 L188.8,2.9 L190.0,2.8 L191.2,2.9 L192.5,3.0 L193.8,3.3 L195.0,3.7 L196.2,4.2 L197.5,4.8 L198.8,5.4 L200.0,6.0";
const HELIX_B = "M0.0,6.0 L1.2,5.4 L2.5,4.8 L3.8,4.2 L5.0,3.7 L6.2,3.3 L7.5,3.0 L8.8,2.9 L10.0,2.8 L11.2,2.9 L12.5,3.0 L13.8,3.3 L15.0,3.7 L16.2,4.2 L17.5,4.8 L18.8,5.4 L20.0,6.0 L21.2,6.6 L22.5,7.2 L23.8,7.8 L25.0,8.3 L26.2,8.7 L27.5,9.0 L28.8,9.1 L30.0,9.2 L31.2,9.1 L32.5,9.0 L33.8,8.7 L35.0,8.3 L36.2,7.8 L37.5,7.2 L38.8,6.6 L40.0,6.0 L41.2,5.4 L42.5,4.8 L43.8,4.2 L45.0,3.7 L46.2,3.3 L47.5,3.0 L48.8,2.9 L50.0,2.8 L51.2,2.9 L52.5,3.0 L53.8,3.3 L55.0,3.7 L56.2,4.2 L57.5,4.8 L58.8,5.4 L60.0,6.0 L61.2,6.6 L62.5,7.2 L63.8,7.8 L65.0,8.3 L66.2,8.7 L67.5,9.0 L68.8,9.1 L70.0,9.2 L71.2,9.1 L72.5,9.0 L73.8,8.7 L75.0,8.3 L76.2,7.8 L77.5,7.2 L78.8,6.6 L80.0,6.0 L81.2,5.4 L82.5,4.8 L83.8,4.2 L85.0,3.7 L86.2,3.3 L87.5,3.0 L88.8,2.9 L90.0,2.8 L91.2,2.9 L92.5,3.0 L93.8,3.3 L95.0,3.7 L96.2,4.2 L97.5,4.8 L98.8,5.4 L100.0,6.0 L101.2,6.6 L102.5,7.2 L103.8,7.8 L105.0,8.3 L106.2,8.7 L107.5,9.0 L108.8,9.1 L110.0,9.2 L111.2,9.1 L112.5,9.0 L113.8,8.7 L115.0,8.3 L116.2,7.8 L117.5,7.2 L118.8,6.6 L120.0,6.0 L121.2,5.4 L122.5,4.8 L123.8,4.2 L125.0,3.7 L126.2,3.3 L127.5,3.0 L128.8,2.9 L130.0,2.8 L131.2,2.9 L132.5,3.0 L133.8,3.3 L135.0,3.7 L136.2,4.2 L137.5,4.8 L138.8,5.4 L140.0,6.0 L141.2,6.6 L142.5,7.2 L143.8,7.8 L145.0,8.3 L146.2,8.7 L147.5,9.0 L148.8,9.1 L150.0,9.2 L151.2,9.1 L152.5,9.0 L153.8,8.7 L155.0,8.3 L156.2,7.8 L157.5,7.2 L158.8,6.6 L160.0,6.0 L161.2,5.4 L162.5,4.8 L163.8,4.2 L165.0,3.7 L166.2,3.3 L167.5,3.0 L168.8,2.9 L170.0,2.8 L171.2,2.9 L172.5,3.0 L173.8,3.3 L175.0,3.7 L176.2,4.2 L177.5,4.8 L178.8,5.4 L180.0,6.0 L181.2,6.6 L182.5,7.2 L183.8,7.8 L185.0,8.3 L186.2,8.7 L187.5,9.0 L188.8,9.1 L190.0,9.2 L191.2,9.1 L192.5,9.0 L193.8,8.7 L195.0,8.3 L196.2,7.8 L197.5,7.2 L198.8,6.6 L200.0,6.0";
const HELIX_RUNGS = [[10.0, 3.4, 8.6], [30.0, 3.4, 8.6], [50.0, 3.4, 8.6], [70.0, 3.4, 8.6], [90.0, 3.4, 8.6], [110.0, 3.4, 8.6], [130.0, 3.4, 8.6], [150.0, 3.4, 8.6], [170.0, 3.4, 8.6], [190.0, 3.4, 8.6]];

function HelixX() {
  return (
    <svg className="xg" viewBox="0 0 30 30" aria-hidden="true">
      <line x1="4.3" y1="5.7" x2="4.3" y2="24.3" className="xg-rung" />
      <line x1="25.7" y1="5.7" x2="25.7" y2="24.3" className="xg-rung" />
      <path d="M26.9,3.1 C15,3.1 15,26.9 3.1,26.9" className="xg-b" />
      <path d="M3.1,3.1 C15,3.1 15,26.9 26.9,26.9" className="xg-a" />
    </svg>
  );
}

function Wordmark({ underline = false }) {
  return (
    <span className="wm">
      Heli<HelixX />ora
      {underline && (
        <svg className="wm-ul" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
          {HELIX_RUNGS.map(([x, y1, y2]) => <line key={x} x1={x} y1={y1} x2={x} y2={y2} className="ul-rung" />)}
          <path d={HELIX_B} className="ul-b" />
          <path d={HELIX_A} className="ul-a" />
        </svg>
      )}
    </span>
  );
}

/* ------------------------------- shell ------------------------------- */

// Sections and their pages, grouped the way a financial news site groups them.
const NAV = [
  { k: "markets", l: "Markets", items: [["home", "Overview"], ["company", "Quotes"], ["screen", "Screener"], ["compare", "Compare"], ["industry", "Drug Industry"]] },
  { k: "risk", l: "Financing Risk", items: [["report", "Pressure Report"], ["research", "Research"]] },
  { k: "trials", l: "Trials & FDA", items: [["outlook", "Outlook"], ["catalysts", "Catalyst Calendar"]] },
  { k: "cyber", l: "Cyber Risk", items: [["cyber", "Cyber Scores"], ["incidents", "Cyber Incidents"]] },
  { k: "ask", l: "Ask Helixora", items: [["ask", "Ask Helixora"]] },
  { k: "about", l: "About us", items: [["about", "About us"]] },
];
const groupOf = (v) => NAV.find((g) => g.items.some(([k]) => k === (v === "privacy" ? "about" : v))) || NAV[0];

const WATCH_KEY = "readout-watchlist";
function loadWatch() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_KEY) || "null");
    if (Array.isArray(saved)) return saved.filter((t) => COMPANIES.some((c) => c.t === t));
  } catch { /* storage unavailable */ }
  return COMPANIES.slice(0, 3).map((c) => c.t);
}

export default function App() {
  const [view, setView] = useState("home");
  const [ticker, setTicker] = useState(COMPANIES[0].t);
  const [watch, setWatch] = useState(loadWatch);
  const [omni, setOmni] = useState("");
  // Menu down the left side ("side") or across the top ("top"); remembered per visitor.
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem("helixora-layout") === "side" ? "side" : "top"; } catch { return "top"; } });
  useEffect(() => { try { localStorage.setItem("helixora-layout", layout); } catch { /* ignore */ } }, [layout]);

  useEffect(() => { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watch)); } catch { /* ignore */ } }, [watch]);

  const [companyTab, setCompanyTab] = useState("overview");
  // "method" (the old Methodology page) now opens the About us page at the score section.
  const [anchor, setAnchor] = useState(null);
  const go = (v, t, tab) => {
    const a = v === "method" ? "score" : v === "cybermethod" ? "cyber" : null;
    if (a) v = "about";
    if (t) setTicker(t); setCompanyTab(tab || "overview"); setAnchor(a); setView(v);
    if (!a) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // helixora.pages.dev/#privacy opens the Privacy page (linked from the waitlist form).
  useEffect(() => {
    const fromHash = () => { if (window.location.hash === "#privacy") { setView("privacy"); window.scrollTo({ top: 0 }); } };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useEffect(() => { if (view !== "privacy" && window.location.hash === "#privacy") history.replaceState(null, "", window.location.pathname); }, [view]);
  const toggleWatch = (t) => setWatch((w) => (w.includes(t) ? w.filter((x) => x !== t) : [...w, t]));

  const matches = omni.trim()
    ? [...COMPANIES, ...INDUSTRY].filter((c) => (c.t + " " + c.n).toLowerCase().includes(omni.toLowerCase())).slice(0, 6)
    : [];

  const cur = groupOf(view);
  const pick = (k) => { go(k); if (document.activeElement) document.activeElement.blur(); };
  const dateline = TODAY.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className={"app lay-" + layout}>
      <style>{CSS}</style>
      <a className="skip" href="#main">Skip to content</a>

      <header className="mast">
        <div className="utility">
          <div className="utility-in">
            <span className="utility-date">{dateline}</span>
            {LIVE && <span className="hide-sm">Data refreshed {new Date(META.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
            <span className="hide-sm">Financing risk research on {COMPANIES.length} clinical-stage biotechs</span>
            <span className="utility-sp" />
            <button className="utility-btn" onClick={() => setLayout("side")}>Menu on side</button>
            <button className="utility-cta" onClick={() => document.getElementById("signup")?.scrollIntoView({ behavior: "smooth" })}>Get the report</button>
          </div>
        </div>
        <div className="mast-in">
          <button className="wordmark" onClick={() => go("home")} aria-label="Helixora home">
            <Wordmark underline />
          </button>
          <div className="omni">
            <input value={omni} onChange={(e) => setOmni(e.target.value)} placeholder="Search a company or ticker" aria-label="Search a company or ticker"
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { go("company", matches[0].t); setOmni(""); } }} />
            {matches.length > 0 && (
              <div className="omnilist">
                {matches.map((c) => (
                  <button key={c.t} onClick={() => { go("company", c.t); setOmni(""); }}>
                    <b>{c.t}</b>{c.n}<span className="sub">{segLabel(c.group) || c.area}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <nav className="nav" aria-label="Sections">
            {NAV.map((g) => (
              <div key={g.k} className={"nav-group" + (g === cur ? " cur" : "") + (g.items.length === 1 ? " solo" : "")}>
                <button className="nav-top" onClick={() => pick(g.items[0][0])}>{g.l}</button>
                <div className="nav-menu">
                  {g.items.map(([k, l]) => <button key={k} className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined} onClick={() => pick(k)}>{l}</button>)}
                </div>
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <span className="dateline">{dateline}</span>
            {LIVE && <span className="side-asof">Data refreshed {new Date(META.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
            <button className="layout-btn" onClick={() => setLayout(layout === "side" ? "top" : "side")}
              aria-label={layout === "side" ? "Move the menu to the top" : "Move the menu to the side"} title={layout === "side" ? "Move the menu to the top" : "Move the menu to the side"}>
              <svg viewBox="0 0 20 20" aria-hidden="true">{layout === "side"
                ? <><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" /><path d="M2.5 7.5h15" /></>
                : <><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" /><path d="M7.5 3.5v13" /></>}</svg>
              <span>{layout === "side" ? "Menu on top" : "Menu on side"}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="content">
      <nav className="subnav" aria-label={cur.l + " pages"}>
        <div className="subnav-in">
          <span className="subnav-h">{cur.l}</span>
          {cur.items.length > 1
            ? cur.items.map(([k, l]) => <button key={k} className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined} onClick={() => go(k)}>{l}</button>)
            : view !== "about" ? null : ABOUT_SECTIONS.map(([id, l]) => <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{l}</button>)}
        </div>
      </nav>
      <div className="tape">
        <TickerStrip go={go} />
      </div>
      {!LIVE && <div className="samplebar">Showing the built-in sample dataset. Companies and figures are fictional until the data refresh runs.</div>}

      <main className="main" id="main">
        {view === "home" && <Home go={go} watch={watch} toggleWatch={toggleWatch} />}
        {view === "screen" && <Screen go={go} />}
        {view === "company" && <Company key={ticker + companyTab} ticker={ticker} initialTab={companyTab} go={go} watch={watch} toggleWatch={toggleWatch} />}
        {view === "report" && <PressureReport go={go} />}
        {view === "catalysts" && <Catalysts go={go} />}
        {view === "compare" && <Compare />}
        {(view === "industry" || view === "bigpharma") && <Industry go={go} />}
        {view === "cyber" && <CyberScores go={go} />}
        {view === "incidents" && <CyberIncidents go={go} />}
        {view === "ask" && <Ask />}
        {view === "research" && <Research go={go} />}
        {view === "about" && <About key={anchor || "top"} go={go} anchor={anchor} />}
        {view === "privacy" && <Privacy />}
        {view === "outlook" && <Outlook go={go} />}
      </main>

      <section className="cta-band" id="signup" aria-labelledby="cta-h">
        <div className="cta-in">
          <div className="cta-copy">
            <p className="cta-kicker">Free while in early access</p>
            <h2 id="cta-h">Get the Financing Pressure Report by email</h2>
            <p>A short note when the Raise List changes, with every number linked to its filing. No hype, no stock picks.</p>
          </div>
          <Waitlist band />
        </div>
      </section>
      <footer className="foot">
        <div className="foot-wrap foot-top">
          <div className="foot-brand">
            <span className="wordmark small" aria-label="Helixora"><Wordmark /></span>
            <p>Financing-risk research on {COMPANIES.length} clinical-stage biotechs. We help investors see the next stock sale coming, with every number traced to its filing.</p>
          </div>
          <nav className="foot-col" aria-label="Markets">
            <h3>Markets</h3>
            <button onClick={() => go("home")}>Overview</button>
            <button onClick={() => go("company")}>Quotes</button>
            <button onClick={() => go("screen")}>Screener</button>
            <button onClick={() => go("compare")}>Compare</button>
          </nav>
          <nav className="foot-col" aria-label="Research">
            <h3>Research</h3>
            <button onClick={() => go("report")}>Financing Pressure Report</button>
            <button onClick={() => go("research")}>Research</button>
            <button onClick={() => go("outlook")}>Trials &amp; FDA outlook</button>
            <button onClick={() => go("catalysts")}>Catalyst calendar</button>
            <button onClick={() => go("ask")}>Ask Helixora</button>
          </nav>
          <nav className="foot-col" aria-label="Company">
            <h3>Company</h3>
            <button onClick={() => go("about")}>About us</button>
            <button onClick={() => go("method")}>How the score works</button>
            <a href="#privacy">Privacy</a>
            <button onClick={() => document.getElementById("signup")?.scrollIntoView({ behavior: "smooth" })}>Get the report</button>
          </nav>
        </div>
        <div className="foot-bottom">
          <div className="foot-wrap">
            <p>
            {LIVE ? (
              <>Financials from SEC EDGAR filings, trial data from ClinicalTrials.gov, prices from Yahoo Finance at the previous close. Refreshed {new Date(META.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
                {" "}Headlines on the front page are written automatically from these figures. Trial readout dates are registry estimates unless marked otherwise, and peak sales marked as placeholders are defaults, not forecasts.{" "}</>
            ) : (
              <>Showing the built-in sample dataset: companies, figures, and dates are fictional.{" "}</>
            )}
            Helixora publishes general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.
                      </p>
            <p className="foot-copy">© {TODAY.getFullYear()} Helixora. Data from SEC EDGAR, ClinicalTrials.gov, openFDA and Yahoo Finance.</p>
          </div>
        </div>
      </footer>
      </div>
    </div>
  );
}

/* -------------------------------- css -------------------------------- */

const CSS = `

.app{--mast:#072B2D;--mast2:#0D3A3C;--ink:#0D1B21;--ink2:#33434A;--mut:#5B6B72;--bg:#EEF3F3;--paper:#FFFFFF;--tint:#F5F8F8;
--rule:#D9E2E3;--rule2:#E7EDEE;--teal:#0E7C74;--teal-d:#09605A;--mint:#6EE7D2;--up:#0A7D4F;--down:#C2272D;
--amber:#B8730F;--crimson:#B3264A;--moss:#2F6B3A;--deep:#0C5670;--indigo:#123E6B;
--r-xl:22px;--r-lg:16px;--r-md:10px;--r-sm:7px;
--display:'Bricolage Grotesque Variable','Arial Narrow',system-ui,sans-serif;--sans:'Instrument Sans Variable',system-ui,sans-serif;
font-family:var(--sans);color:var(--ink);background:var(--bg);min-height:100vh;display:grid;grid-template-columns:244px minmax(0,1fr);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;font-optical-sizing:auto;}
.app h1{font-family:var(--display);}
.app h2,.app h3{font-family:var(--sans);}
.nowrap{white-space:nowrap;}
.clip{max-width:170px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.app *{box-sizing:border-box;}
.app :where(button){font-family:inherit;cursor:pointer;color:inherit;}
.app :focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:4px;}
.app :where(a){color:inherit;}
.num,.mono{font-variant-numeric:tabular-nums;}
.warn{color:var(--amber);}
.good{color:var(--moss);}
.sub{display:block;font-size:12.5px;color:var(--mut);font-weight:400;}
.sub.inline{display:inline;}
.sub.r{text-align:right;}
a.src{text-decoration:underline;text-decoration-color:rgba(14,124,116,.4);text-underline-offset:3px;}
a.src:hover{color:var(--teal);}
.skip{position:absolute;left:-9999px;top:8px;background:#fff;padding:8px 12px;z-index:100;border-radius:var(--r-sm);}
.skip:focus{left:8px;}

/* sidebar */
.mast{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--mast);color:#E6F1F0;border-right:1px solid rgba(110,231,210,.12);scrollbar-width:thin;}
.mast-in{display:flex;flex-direction:column;gap:22px;min-height:100%;padding:28px 16px 20px;}
.foot-in{max-width:1320px;margin:0 auto;padding:0 24px;}
.wordmark{flex:none;align-self:flex-start;margin-left:8px;display:inline-flex;align-items:center;background:none;border:0;padding:0 0 7px;font-family:var(--display);font-weight:800;font-stretch:75%;font-size:34px;letter-spacing:-.03em;color:#fff !important;line-height:1;--strand2:#2FB3A3;--rung:#8FE0D5;}
.wm{position:relative;display:inline-block;white-space:nowrap;}
.xg{display:inline-block;height:.53em;width:.5em;vertical-align:baseline;margin:0 .015em 0 .02em;overflow:visible;}
.xg-a,.xg-b{fill:none;stroke-width:6.2;stroke-linecap:round;}
.xg-a{stroke:currentColor;}
.xg-b{stroke:var(--strand2);}
.xg-rung{stroke:var(--rung);stroke-width:2.6;stroke-linecap:round;}
.wm-ul{position:absolute;left:0;bottom:-.24em;height:.26em;width:calc(100% - .05em);overflow:visible;}
.ul-a,.ul-b{fill:none;stroke-width:1.8;vector-effect:non-scaling-stroke;}
.ul-a{stroke:currentColor;opacity:.9;}
.ul-b{stroke:var(--strand2);}
.ul-rung{stroke:var(--rung);stroke-width:1.2;opacity:.6;vector-effect:non-scaling-stroke;}
.wordmark:hover .xg-b,.wordmark:hover .ul-b{stroke:var(--mint);}
.wordmark.small{font-size:24px;color:var(--ink) !important;padding:0;--strand2:var(--teal);--rung:#7CC4BA;}

.nav{display:flex;flex-direction:column;gap:2px;}
.nav button{background:none;border:0;color:#B5CCCB;padding:10px 14px;font-size:14.5px;font-weight:500;text-align:left;border-radius:var(--r-md);white-space:nowrap;transition:background .15s,color .15s;}
.nav button:hover{color:#fff;background:rgba(255,255,255,.07);}
.nav button.on{color:var(--mast);background:var(--mint);font-weight:600;}
.nav{gap:16px;}
.nav-group{display:flex;flex-direction:column;gap:2px;}
.nav-menu{display:flex;flex-direction:column;gap:2px;}
.nav .nav-top{padding:2px 14px 4px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#6F9796;}
.nav .nav-top:hover{background:none;color:#fff;}
.nav-group.cur .nav-top{color:var(--mint);}
.about [id]{scroll-margin-top:150px;}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px;padding-top:18px;border-top:1px solid var(--rule2);}
.toc button{background:var(--tint);border:1px solid var(--rule);border-radius:999px;padding:7px 14px;font-size:13.5px;font-weight:600;color:var(--ink2);transition:background .15s,border-color .15s,color .15s;}
.toc button:hover{background:#E3F5F2;border-color:var(--teal);color:var(--teal-d);}
.subnav{display:none;background:var(--paper);border-bottom:1px solid var(--rule);}
.subnav-in{max-width:1320px;margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;}
.subnav-in::-webkit-scrollbar{display:none;}
.subnav-h{font-family:var(--display);font-weight:700;font-size:19px;letter-spacing:-.01em;margin-right:18px;padding-right:18px;border-right:1px solid var(--rule);white-space:nowrap;line-height:1.2;}
.subnav button{background:none;border:0;border-bottom:2px solid transparent;padding:14px 12px 12px;font-size:14px;font-weight:500;color:var(--mut);white-space:nowrap;transition:color .15s,border-color .15s;}
.subnav button:hover{color:var(--ink);}
.subnav button.on{color:var(--ink);font-weight:600;border-bottom-color:var(--teal);}
.side-foot{margin-top:auto;display:grid;gap:4px;padding:16px 8px 0;border-top:1px solid rgba(255,255,255,.09);font-size:12px;color:#7E9E9D;}
.side-foot .dateline{font-size:12.5px;font-weight:600;color:#A9C4C3;}
.layout-btn{display:inline-flex;align-items:center;gap:8px;margin-top:10px;justify-self:start;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#CFE2E1 !important;border-radius:999px;padding:6px 12px 6px 9px;font-size:12.5px;font-weight:600;transition:background .15s,border-color .15s;}
.layout-btn:hover{background:rgba(255,255,255,.12);border-color:var(--mint);}
.layout-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;}

/* menu across the top */
.app.lay-top{display:block;}
.app.lay-top .mast{position:sticky;top:0;z-index:50;height:auto;overflow:visible;border-right:0;border-bottom:1px solid rgba(110,231,210,.12);background:rgba(7,43,46,.95);backdrop-filter:saturate(140%) blur(12px);-webkit-backdrop-filter:saturate(140%) blur(12px);}
.app.lay-top .mast-in{flex-direction:row;align-items:center;gap:20px;min-height:66px;max-width:1320px;margin:0 auto;padding:0 24px;}
.app.lay-top .wordmark{margin-left:0;}
.app.lay-top .nav{flex-direction:row;flex:1;min-width:0;order:2;gap:2px;}
.app.lay-top .nav-group{position:relative;}
.app.lay-top .nav .nav-top{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:9px 14px;font-size:14.5px;font-weight:600;letter-spacing:0;text-transform:none;color:#B5CCCB;}
.app.lay-top .nav .nav-top::after{content:"";width:6px;height:6px;margin-top:-3px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg);opacity:.7;}
.app.lay-top .nav-group:hover .nav-top,.app.lay-top .nav-group:focus-within .nav-top{color:#fff;background:rgba(255,255,255,.07);}
.app.lay-top .nav-group.cur .nav-top{color:#fff;box-shadow:inset 0 -2px 0 var(--mint);border-radius:999px 999px 6px 6px;}
.app.lay-top .nav-menu{display:none;position:absolute;top:calc(100% + 8px);left:0;min-width:210px;padding:6px;background:var(--paper);border:1px solid var(--rule);border-radius:var(--r-md);box-shadow:0 18px 40px rgba(7,43,46,.22);z-index:60;}
.app.lay-top .nav-menu::before{content:"";position:absolute;left:0;right:0;top:-10px;height:10px;}
.app.lay-top .nav-group:hover .nav-menu,.app.lay-top .nav-group:focus-within .nav-menu{display:flex;}
.app.lay-top .nav-group.solo .nav-menu{display:none;}
.app.lay-top .toc{display:none;}
@media (min-width:961px){.app.lay-side .solo .nav-top{display:none;}}
.app.lay-top .nav .solo .nav-top::after{display:none;}
.app.lay-top .nav-menu button{color:var(--ink2);padding:9px 12px;font-size:14px;border-radius:var(--r-sm);}
.app.lay-top .nav-menu button:hover{background:var(--tint);color:var(--ink);}
.app.lay-top .nav-menu button.on{background:#E3F5F2;color:var(--teal-d);}
.app.lay-top .subnav{display:block;}
.app.lay-top .omni{order:3;width:230px;}
.app.lay-top .side-foot{order:4;margin:0;padding:0;border:0;display:block;}
.app.lay-top .side-foot .dateline,.app.lay-top .side-asof{display:none;}
.app.lay-top .layout-btn{margin:0;padding:7px;}
.app.lay-top .layout-btn span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.app.lay-top .tape{position:static;}
@media (max-width:1320px){
  .app.lay-top .mast{position:static;}
  .app.lay-top .mast-in{flex-wrap:wrap;gap:0 16px;padding-top:10px;}
  .app.lay-top .omni{order:2;margin-left:auto;}
  .app.lay-top .side-foot{order:3;}
  .app.lay-top .nav{order:4;flex-basis:100%;margin:6px -12px 8px;padding:0 12px;}
}

.omni{position:relative;flex:none;width:100%;}
.omni input{width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;border-radius:999px;padding:9px 14px;font:inherit;font-size:14px;transition:background .15s,border-color .15s;}
.omni input:focus{background:rgba(255,255,255,.14);border-color:var(--mint);outline:none;}
.omni input::placeholder{color:#8DADAD;}
.omnilist{position:absolute;top:44px;left:0;right:0;background:var(--paper);border:1px solid var(--rule);border-radius:var(--r-md);box-shadow:0 18px 40px rgba(7,43,46,.22);z-index:60;overflow:hidden;padding:4px;}
.omnilist button{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;padding:9px 11px;border:0;background:none;color:var(--ink);font-size:14px;border-radius:var(--r-sm);}
.omnilist button:hover{background:var(--tint);}
.omnilist b{min-width:44px;}
.omnilist .sub{margin-left:auto;}

/* tape: date and prices under the header */
.content{min-width:0;display:flex;flex-direction:column;min-height:100vh;}
.tape{position:sticky;top:0;z-index:40;display:flex;align-items:stretch;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--rule);}
.strip{flex:1;min-width:0;color:var(--ink);overflow:hidden;position:relative;-webkit-mask-image:linear-gradient(90deg,transparent,#000 40px,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(90deg,transparent,#000 40px,#000 calc(100% - 40px),transparent);}
.strip-track{display:flex;width:max-content;animation:tape 70s linear infinite;}
.strip:hover .strip-track,.strip:focus-within .strip-track{animation-play-state:paused;}
.strip-half{display:flex;}
@keyframes tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}
.tk{display:flex;align-items:baseline;gap:8px;background:none;border:0;padding:10px 18px;white-space:nowrap;font-size:13.5px;}
.tk:hover{background:var(--tint);}
.tk b{font-weight:700;font-size:13.5px;letter-spacing:.01em;}
.tk-px{font-variant-numeric:tabular-nums;color:var(--ink2);}
.samplebar{background:#FBF1DF;color:#7A4E08;font-size:12.5px;padding:6px 20px;text-align:center;}

/* change */
.chg{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap;}
.chg.up{color:var(--up);}
.chg.down{color:var(--down);}
.chg.flat{color:var(--mut);}
.arw{font-size:.72em;margin-right:3px;position:relative;top:-1px;}

/* layout */
.main{width:100%;max-width:1320px;margin:0 auto;padding:28px 28px 56px;}
.stack{display:flex;flex-direction:column;gap:20px;}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;}
.front-wrap{display:flex;flex-direction:column;gap:20px;}
.front{display:grid;grid-template-columns:minmax(0,1fr) 300px 330px;gap:20px;align-items:start;}
.lead,.wire,.side>section{background:var(--paper);border:1px solid var(--rule2);border-radius:var(--r-lg);}
.lead{padding:28px 30px 26px;}
.wire{padding:22px 22px 18px;}
.side{display:flex;flex-direction:column;gap:20px;}
.side>section{padding:20px 20px 16px;}
.colhead{font-family:var(--display);font-size:18px;font-weight:700;font-stretch:92%;margin:0 0 8px;letter-spacing:-.01em;line-height:1.2;}
.colnote{font-size:12.5px;color:var(--mut);margin:10px 0 0;}

/* hero */
.hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:44px;align-items:center;background:var(--mast);color:#E6F1F0;border-radius:var(--r-xl);padding:40px 44px 40px;overflow:hidden;isolation:isolate;}
.hero::before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse 60% 90% at 100% 0%,rgba(110,231,210,.16),transparent 60%);}
.id-line{font-family:var(--display);font-size:clamp(30px,3.4vw,46px);font-weight:700;font-stretch:84%;letter-spacing:-.025em;line-height:1.02;margin:0;color:#fff;max-width:17ch;text-wrap:balance;}
.id-sub{margin:16px 0 0;color:#A9C4C3;font-size:16.5px;max-width:46ch;line-height:1.5;}
.id-ctas{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px;}
.hero .btn.primary{background:var(--mint);border-color:var(--mint);color:var(--mast) !important;}
.hero .btn.primary:hover{background:#9AF0E0;border-color:#9AF0E0;}
.btn.ghost{background:transparent;border-color:rgba(255,255,255,.22);color:#fff !important;}
.btn.ghost:hover{border-color:var(--mint);background:rgba(255,255,255,.05);}
.hero-rail{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:var(--r-lg);padding:20px 22px 16px;}
.rail-cap{margin:0 0 6px;font-size:13px;color:#A9C4C3;}

/* pressure rail */
.rail{--lane-h:24px;padding:0 14px;}
.rail-labels{position:relative;height:calc(var(--lanes) * var(--lane-h) + 6px);}
.rail-tag{position:absolute;bottom:calc(var(--lane) * var(--lane-h) + 4px);transform:translateX(-50%);font-size:12px;font-weight:700;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:#fff;white-space:nowrap;}
.rail-tag::after{content:"";position:absolute;left:50%;top:100%;width:1px;height:calc(var(--lane) * var(--lane-h) + 4px);background:rgba(255,255,255,.28);}
.rail-track{position:relative;height:38px;border-radius:999px;background:rgba(255,255,255,.06);}
.rail-zone{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;}
.rail-zone em{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);font-style:normal;font-size:12px;font-weight:600;pointer-events:none;white-space:nowrap;}
.z-low{background:rgba(110,231,210,.13);border-radius:999px 0 0 999px;color:#8FE0D5;}
.z-elevated{background:rgba(232,176,72,.16);color:#F0C677;}
.z-high{background:rgba(232,97,130,.18);border-radius:0 999px 999px 0;color:#F49AB0;}
.rail-dot{position:absolute;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid var(--mast);padding:0;transition:transform .15s;}
.rail-dot:hover,.rail-dot:focus-visible{transform:scale(1.3);}
.rail-dot.quiet{width:12px;height:12px;margin:-6px 0 0 -6px;border-width:2px;opacity:.85;}
.rail-note{margin:4px 0 0;font-size:12px;color:#7E9E9D;}
.rail-dot.b-low{background:var(--mint);}
.rail-dot.b-elevated{background:#F0B44C;}
.rail-dot.b-high{background:#F16D8F;}
.rail-axis{position:relative;height:18px;margin-top:8px;font-size:11px;color:#7E9E9D;font-variant-numeric:tabular-nums;}
.rail-axis span{position:absolute;transform:translateX(-50%);}
.rail-axis span:nth-child(1){left:0;}
.rail-axis span:nth-child(2){left:40%;}
.rail-axis span:nth-child(3){left:70%;}
.rail-axis span:nth-child(4){left:100%;}

/* lead story */
.kicker{background:none;border:0;padding:0;font-size:13px;font-weight:600;color:var(--teal) !important;display:inline-flex;gap:6px;align-items:baseline;}
.kicker:hover{text-decoration:underline;text-underline-offset:3px;}
.kicker-t{font-weight:500;color:var(--mut);}
.lead-h{font-family:var(--display);font-size:clamp(32px,3.7vw,50px);line-height:1.02;font-weight:700;font-stretch:84%;letter-spacing:-.025em;margin:10px 0 14px;max-width:18ch;text-wrap:balance;}
.lead-h button,.brief h2 button{background:none;border:0;padding:0;font:inherit;text-align:left;letter-spacing:inherit;}
.lead-h button:hover,.brief h2 button:hover{color:var(--teal);}
.lead-dek{font-size:17px;line-height:1.6;color:var(--ink2);margin:0 0 20px;max-width:58ch;}
.lead-chart{background:var(--tint);border-radius:var(--r-md);padding:14px 14px 6px;}
.lead-px{display:flex;gap:10px;align-items:baseline;margin-bottom:4px;}
.lead-px b{font-size:24px;font-weight:600;letter-spacing:-.015em;font-variant-numeric:tabular-nums;}
.byline{font-size:12.5px;color:var(--mut);margin:12px 0 0;}
.briefs{display:grid;grid-template-columns:1fr 1fr;gap:0 32px;margin-top:26px;border-top:1px solid var(--rule2);}
.brief{padding:18px 0 18px;border-bottom:1px solid var(--rule2);}
.brief h2{font-family:var(--display);font-size:19px;line-height:1.22;font-weight:650;font-stretch:92%;margin:5px 0 7px;letter-spacing:-.012em;text-wrap:balance;}
.brief p{margin:0;font-size:14px;color:var(--mut);line-height:1.55;}

/* filings wire */
.wire-list{list-style:none;margin:0;padding:0;}
.wire-list li{padding:12px 0;border-bottom:1px solid var(--rule2);}
.wire-list li:last-child{border-bottom:0;}
.wire-meta{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--mut);margin-bottom:4px;}
.wire-t{background:#E3F2EF;border:0;padding:1px 7px;border-radius:999px;font-weight:700;color:var(--teal-d) !important;font-size:11.5px;}
.wire-list a,.q-news a{font-size:14.5px;line-height:1.4;font-weight:600;text-decoration:none;}
.wire-list a:hover,.q-news a:hover{color:var(--teal);text-decoration:underline;text-underline-offset:3px;}

/* side column */
.mtable{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums;}
.mtable th{font-weight:500;font-size:12px;color:var(--mut);text-align:left;padding:0 0 6px 10px;}
.mtable th:first-child,.mtable td:first-child{padding-left:0;}
.mtable th.r,.mtable td.r{text-align:right;}
.mtable td{padding:8px 0 8px 10px;border-top:1px solid var(--rule2);vertical-align:baseline;}
.mtable tbody tr{cursor:pointer;}
.mtable tbody tr:hover{background:var(--tint);}
.mt-t{background:none;border:0;padding:0;font-weight:700;font-size:13.5px;margin-right:6px;}
.mt-n{font-size:12px;color:var(--mut);display:block;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.uplist{list-style:none;margin:0;padding:0;}
.uplist li{display:grid;grid-template-columns:48px 1fr;gap:12px;padding:9px 0;border-top:1px solid var(--rule2);align-items:center;}
.up-d{font-size:11px;color:var(--mut);line-height:1.1;text-align:center;background:var(--tint);border-radius:var(--r-sm);padding:6px 0;}
.up-d b{display:block;font-size:18px;color:var(--ink);font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums;}
.uplist button{background:none;border:0;padding:0;text-align:left;font-size:13.5px;line-height:1.4;}
.uplist button:hover{color:var(--teal);}
.uplist em{color:var(--mut);font-style:normal;font-size:12px;}
.up-t{font-weight:700;margin-right:6px;}
.morelink{background:none;border:0;padding:10px 0 0;font-size:13.5px;font-weight:600;color:var(--teal) !important;}
.morelink:hover{text-decoration:underline;text-underline-offset:3px;}
.wl{list-style:none;margin:0;padding:0;}
.wl li{display:flex;align-items:center;border-top:1px solid var(--rule2);}
.wl-row{flex:1;display:grid;grid-template-columns:50px 1fr auto;gap:8px;background:none;border:0;padding:9px 0;text-align:left;font-size:13.5px;font-variant-numeric:tabular-nums;}
.wl-row:hover{background:var(--tint);}
.wl-x{background:none;border:0;color:var(--mut);font-size:17px;padding:0 4px 0 10px;}
.wl-x:hover{color:var(--down);}

/* quote page */
.quote{background:var(--paper);border:1px solid var(--rule2);border-radius:var(--r-lg);padding:28px 30px 28px;}
.q-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
.q-id{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.q-id h1{font-family:var(--display);font-size:clamp(30px,3.2vw,42px);font-weight:700;font-stretch:86%;margin:0;letter-spacing:-.022em;line-height:1.05;}
.q-tk{font-size:14px;font-weight:700;color:var(--teal-d);background:#E3F2EF;padding:2px 9px;border-radius:999px;letter-spacing:.02em;}
.q-area{font-size:13.5px;color:var(--mut);}
.watchbtn{background:#fff;border:1px solid var(--rule);padding:8px 14px;font-size:13.5px;font-weight:600;border-radius:999px;transition:border-color .15s,background .15s;}
.watchbtn:hover{border-color:var(--teal);}
.watchbtn.on{background:#E3F2EF;border-color:#9CCAC3;color:var(--teal-d) !important;}
.q-px{display:flex;align-items:baseline;gap:14px;margin:14px 0 20px;flex-wrap:wrap;}
.q-price{font-size:clamp(38px,3.8vw,50px);font-weight:600;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums;}
.q-px .chg{font-size:18px;font-weight:600;}
.q-asof{font-size:12.5px;color:var(--mut);}
.q-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:32px;align-items:start;}
.q-key{display:grid;grid-template-columns:auto 1fr;margin:0;font-size:14px;font-variant-numeric:tabular-nums;background:var(--tint);border-radius:var(--r-md);padding:6px 16px;}
.q-key dt,.q-key dd{padding:9px 0;border-bottom:1px solid var(--rule2);margin:0;}
.q-key dt:last-of-type,.q-key dd:last-of-type{border-bottom:0;}
.q-key dt{color:var(--mut);}
.q-key dd{text-align:right;font-weight:500;}
.q-note{font-size:15px;color:var(--mut);margin:18px 0 0;max-width:70ch;}
.q-news{margin-top:22px;}
.q-news ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 28px;}
.q-news li{padding:10px 0;border-bottom:1px solid var(--rule2);}
.rbar{display:inline-block;width:150px;vertical-align:middle;}
.rbar-track{display:block;position:relative;height:5px;background:var(--rule);border-radius:999px;margin-top:4px;}
.rbar-dot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--teal);border:2px solid #fff;box-shadow:0 0 0 1px var(--rule);}
.rbar-ends{display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-top:4px;font-variant-numeric:tabular-nums;font-weight:400;}

/* price chart */
.pchart{width:100%;}
.ranges{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;}
.ranges [role=group]{display:flex;gap:2px;background:var(--tint);border:1px solid var(--rule2);border-radius:999px;padding:3px;}
.ranges button{background:none;border:0;padding:5px 13px;font-size:12.5px;font-weight:600;color:var(--mut) !important;border-radius:999px;}
.ranges button:hover{color:var(--ink) !important;}
.ranges button.on{background:var(--ink);color:#fff !important;}
.ranges .chg{font-size:13px;}
.nochart{display:flex;align-items:center;justify-content:center;min-height:180px;background:var(--tint);border-radius:var(--r-md);color:var(--mut);font-size:13px;text-align:center;padding:20px;}

/* panels (analysis views) */
.panel{background:var(--paper);border:1px solid var(--rule2);border-radius:var(--r-lg);padding:24px 26px 24px;}
.ph{display:flex;align-items:baseline;gap:6px 16px;margin:0 0 18px;flex-wrap:wrap;}
.ph.mt{margin-top:28px;}
.ph h2{font-family:var(--display);font-size:20px;font-weight:700;font-stretch:90%;margin:0;letter-spacing:-.014em;line-height:1.2;}
.ph-note{font-size:13.5px;color:var(--mut);flex-basis:100%;max-width:75ch;}
.empty{font-size:14px;color:var(--mut);padding:12px 0;margin:0;}

/* alerts */
.alist{display:flex;flex-direction:column;gap:16px;}
.alist.tight{gap:8px;}
.arow-head{display:flex;align-items:center;gap:9px;margin-bottom:6px;}
.aname{font-size:13px;color:var(--mut);}
.alert{font-size:13.5px;padding:8px 12px;border-radius:var(--r-sm);background:var(--tint);line-height:1.45;position:relative;padding-left:26px;}
.alert::before{content:"";position:absolute;left:11px;top:14px;width:7px;height:7px;border-radius:50%;background:var(--mut);}
.alert.high{background:#FCF0F3;}
.alert.high::before{background:var(--crimson);}
.alert.med{background:#FCF6EA;}
.alert.med::before{background:var(--amber);}
.alert.low{background:#EFF6F8;}
.alert.low::before{background:var(--deep);}
.tick{font-weight:700;font-size:13.5px;background:none;color:var(--ink) !important;padding:0;border:0;letter-spacing:.01em;}
button.tick:hover{color:var(--teal) !important;}
.tick.lg{font-size:15px;}
.star{background:none;border:0;color:var(--rule);font-size:17px;line-height:1;padding:2px;}
.star.on,.star:hover{color:var(--amber) !important;}

/* tables */
.tablewrap{overflow-x:auto;}
.grid{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;}
.grid th{text-align:left;font-weight:600;font-size:12px;color:var(--mut);padding:9px 12px;background:var(--tint);white-space:nowrap;cursor:pointer;}
.grid th:first-child{border-radius:var(--r-sm) 0 0 var(--r-sm);}
.grid th:last-child{border-radius:0 var(--r-sm) var(--r-sm) 0;}
.grid th.r,.grid td.r{text-align:right;}
.grid td{padding:11px 12px;border-bottom:1px solid var(--rule2);vertical-align:top;}
.grid tbody tr:hover{background:var(--tint);cursor:pointer;}
.grid.plain tbody tr:hover{background:none;cursor:default;}
.grid.plain th{cursor:default;}
.sortmark{margin-left:4px;color:var(--teal);}
.nm{max-width:200px;}
.bisnum{font-size:14px;font-weight:600;}
.bar100{display:block;width:74px;height:5px;background:var(--rule2);margin-left:auto;margin-top:5px;border-radius:999px;overflow:hidden;}
.bar100 span{display:block;height:100%;border-radius:999px;}
.grid.compare td.lbl,.grid.compare th.lbl{text-align:left;color:var(--mut);font-size:13px;width:210px;}
.grid.compare select{width:100%;font-family:inherit;font-size:13.5px;padding:6px 8px;border:1px solid var(--rule);border-radius:var(--r-sm);background:#fff;}
.grid.compare tbody tr:hover{background:var(--tint);cursor:default;}

/* phase track */
.ptrack{display:flex;gap:2px;margin-bottom:4px;}
.pseg{width:16px;height:5px;background:var(--rule2);border-radius:999px;}
.phasechip{color:#fff;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;}

/* filters */
.filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px 24px;}
.f{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0;font-size:12.5px;font-weight:500;color:var(--mut);}
.f.wide{margin-bottom:12px;}
.f input[type=text],.f input:not([type]),.f select{font-family:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r-md);background:#fff;color:var(--ink);}
.f input:focus,.f select:focus{border-color:var(--teal);outline:none;box-shadow:0 0 0 3px rgba(14,124,116,.15);}
.f input[type=range]{accent-color:var(--teal);}

/* tabs */
.tabs{display:flex;gap:4px;overflow-x:auto;background:var(--paper);border:1px solid var(--rule2);border-radius:999px;padding:4px;width:max-content;max-width:100%;scrollbar-width:none;}
.tabs button{background:none;border:0;padding:8px 16px;font-size:14px;color:var(--mut) !important;border-radius:999px;white-space:nowrap;font-weight:600;transition:background .15s,color .15s;}
.tabs button:hover{color:var(--ink) !important;background:var(--tint);}
.tabs button.on{color:#fff !important;background:var(--mast);}

/* metrics + trace */
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.metrics.two-up{grid-template-columns:1fr 1fr;}
.metric{background:var(--tint);border-radius:var(--r-md);padding:12px 14px;}
.metric>span{display:block;font-size:12.5px;color:var(--mut);margin-bottom:3px;}
.metrics.four{grid-template-columns:repeat(4,1fr);margin:0 0 18px;}
.metric em{display:block;font-style:normal;font-size:12.5px;color:var(--mut);margin-top:2px;}
.metric b.chg{font-size:22px;}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px;}
.three-b{display:block;font-size:17px !important;line-height:1.3;margin:2px 0;}
.grid.plain tr.us td{background:#E3F2EF;}
.probs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.prob{border:1px solid var(--rule2);border-radius:var(--r-md);padding:16px 18px;display:flex;flex-direction:column;align-items:flex-start;}
.prob.st-live{border-color:#9CCAC3;background:#F2FAF8;}
.prob.st-next{border-color:#EBCF9C;background:#FFFBF2;}
.prob h3{font-size:16px;font-weight:700;margin:10px 0 6px;}
.prob-pain{font-size:13.5px;color:var(--mut);margin:0 0 8px;}
.prob-where{font-size:14px;margin:0;}
.stchip{font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;white-space:nowrap;}
.stchip.st-live{background:#DFF2EE;color:#0A5752;}
.stchip.st-next{background:#FBF0DA;color:#7A4E08;}
.stchip.st-later{background:var(--tint);color:var(--mut);}
.gantt{display:grid;gap:2px;}
.gantt-axis{display:grid;grid-template-columns:300px 1fr;gap:16px;height:22px;}
.gantt-ticks{position:relative;}
.gantt-ticks em{position:absolute;transform:translateX(-50%);font-style:normal;font-size:11px;color:var(--mut);white-space:nowrap;}
.gantt-ticks em:first-child{transform:none;}
.gantt-ticks em:last-child{transform:translateX(-100%);}
.gantt-row{display:grid;grid-template-columns:300px 1fr;gap:16px;align-items:center;background:none;border:0;border-top:1px solid var(--rule2);padding:9px 0;text-align:left;}
.gantt-row:hover{background:var(--tint);}
.gantt-label{font-size:14px;}
.wbar{position:relative;display:block;height:14px;background:var(--tint);border-radius:999px;}
.wbar-band{position:absolute;top:0;bottom:0;background:rgba(14,124,116,.28);border-radius:999px;}
.wbar-mid{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--teal);border:2px solid #fff;}
.wbar-reg{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--ink);opacity:.55;}
.flagwrap{display:flex;flex-wrap:wrap;gap:5px;}
.flag{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;cursor:help;}
.flag-high{background:#FBE8EE;color:#8F1D3D;}
.flag-med{background:#FBF0DA;color:#7A4E08;}
.flag-low{background:#EEF1F2;color:#36434B;}
.flag-info{background:#E7F1FB;color:#123E6B;}
.fdacards{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:8px;}
.fdacard{border:1px solid var(--rule2);border-radius:var(--r-md);padding:16px 18px;}
.fdacard h3{font-size:17px;font-weight:600;margin:4px 0 8px;}
.salesmodel .f input{width:100%;}
.unit{font-style:normal;font-size:11.5px;color:var(--mut);}
.launch{margin-bottom:14px;}
.alertlist{list-style:none;margin:0;padding:0;display:grid;gap:8px;}
.al{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px;padding:10px 14px;border-radius:var(--r-sm);background:var(--tint);font-size:14px;}
.al-high{background:#FCF0F3;}
.al-med{background:#FCF6EA;}
.al-kind{font-size:11.5px;font-weight:700;padding:1px 8px;border-radius:999px;background:#fff;color:var(--ink2);}
.al-text{flex:1;min-width:200px;}
.neg-strong{color:var(--crimson);font-weight:600;}
details.more{margin-top:18px;}
details.more summary{cursor:pointer;font-size:14.5px;font-weight:700;margin-bottom:10px;}
details.more summary:hover{color:var(--teal);}
.finding{font-family:var(--display);font-size:clamp(19px,1.8vw,23px);font-weight:600;font-stretch:92%;letter-spacing:-.012em;line-height:1.3;margin:0 0 18px;max-width:52ch;text-wrap:balance;}
.metric b{font-size:22px;font-weight:600;letter-spacing:-.015em;font-variant-numeric:tabular-nums;}
.tr-wrap{position:relative;display:inline-block;}
.tr-val{font-size:22px;font-weight:600;letter-spacing:-.015em;background:none;border:0;padding:0;color:var(--ink);border-bottom:1px dotted var(--teal);font-variant-numeric:tabular-nums;}
.tr-val.warn{color:var(--amber) !important;border-bottom-color:var(--amber);}
.tr-unit{font-size:13px;font-weight:400;color:var(--mut);}
.tr-pop{position:absolute;top:34px;left:0;width:320px;background:var(--mast);color:#DCE9E9;padding:14px 16px;border-radius:var(--r-md);z-index:30;display:grid;gap:8px;box-shadow:0 18px 40px rgba(7,43,46,.3);}
.tr-row{display:block;font-size:12.5px;line-height:1.45;}
.tr-row b{display:block;font-size:11px;color:var(--mint);font-weight:600;margin-bottom:1px;}

/* facts */
.facts{display:grid;grid-template-columns:auto 1fr;gap:8px 20px;margin:0;font-size:14px;}
.facts dt{color:var(--mut);font-size:13.5px;}
.facts dd{margin:0;}
.facts.small{font-size:13.5px;margin-top:12px;gap:6px 16px;}
.facts .strong{font-weight:600;color:var(--teal);}

/* programs */
.prog-list{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.prog{border:1px solid var(--rule2);border-radius:var(--r-md);padding:16px 18px;}
.prog-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;}
.prog h3{margin:0;font-size:16px;font-weight:700;}
.prog-ind{font-size:13.5px;color:var(--mut);margin-top:2px;}

/* timeline */
.timeline{display:flex;flex-direction:column;}
.tl{display:grid;grid-template-columns:12px 120px 1fr auto;gap:12px;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--rule2);}
.tl.past{opacity:.5;}
.tl-dot{width:9px;height:9px;border-radius:50%;align-self:center;}
.tl-date{font-size:13px;color:var(--mut);}
.tl-label{font-size:14.5px;}
.tl-days{font-size:13px;}

/* calendar */
.cgrade{display:inline-block;min-width:26px;text-align:center;font-weight:700;font-size:13px;padding:3px 7px;border-radius:4px;color:#fff;}
.cgrade.big{font-size:34px;min-width:64px;padding:10px 0;border-radius:8px;}
.cgrade.g-a{background:#1f7a4d;}.cgrade.g-b{background:#4f8f3a;}.cgrade.g-c{background:#b7891b;}.cgrade.g-d{background:#c4622d;}.cgrade.g-f{background:#b4232a;}.cgrade.none{background:var(--rule);color:var(--mut);}
.cy-head{display:flex;gap:20px;align-items:center;flex-wrap:wrap;}.cy-head .metrics{flex:1;min-width:0;}
.cy-check td{vertical-align:top;padding:10px 8px;}.cy-mark{width:28px;font-weight:700;}.cy-mark.ok{color:#1f7a4d;}.cy-mark.part{color:#b7891b;}.cy-mark.no{color:#b4232a;}
.cy-quote{display:block;margin-top:4px;font-size:13px;color:var(--mut);font-style:italic;}
.cy-inc{margin:8px 0 0;padding-left:18px;}.cy-inc li{margin:6px 0;font-size:14px;}
.cyber-search{width:100%;max-width:340px;margin:0 0 12px;padding:8px 10px;border:1px solid var(--rule);border-radius:6px;font:inherit;}
.correction textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--rule);border-radius:6px;font:inherit;margin:8px 0;}
tr.noclick{cursor:default;}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;}
.chip{font-size:13px;font-weight:600;padding:6px 14px;border:1px solid var(--rule);background:#fff;border-radius:999px;color:var(--mut) !important;transition:background .15s,border-color .15s;}
.chip:hover{border-color:var(--teal);}
.chip.on{background:var(--mast);border-color:var(--mast);color:#fff !important;}
.month{margin-bottom:24px;}
.monthhead{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--display);font-size:18px;font-weight:700;font-stretch:92%;letter-spacing:-.01em;margin:0 0 6px;padding-bottom:6px;border-bottom:1px solid var(--rule);}
.monthhead .mono{font-family:var(--sans);font-size:12.5px;color:var(--mut);font-weight:400;letter-spacing:0;}
.evrow{display:grid;grid-template-columns:72px 8px auto 1fr auto auto;gap:12px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--rule2);padding:10px 6px;border-radius:var(--r-sm);}
.evrow:hover{background:var(--tint);}
.evrow.past{opacity:.48;}
.ev-date{font-size:12.5px;color:var(--mut);}
.ev-kind{width:8px;height:8px;border-radius:50%;}
.ev-label{font-size:14.5px;}
.ev-run{font-size:12.5px;color:var(--mut);}
.ev-days{font-size:13px;}

/* score */
.scorewrap{display:grid;grid-template-columns:150px 1fr;gap:28px;align-items:center;}
.bigscore{text-align:center;}
.bigscore span{font-size:60px;font-weight:600;line-height:1;letter-spacing:-.04em;font-variant-numeric:tabular-nums;}
.bigscore small{display:block;font-size:12.5px;color:var(--mut);margin-top:4px;}
.scorelist{display:grid;gap:12px;}
.scorerow{display:grid;grid-template-columns:200px 1fr 34px;gap:14px;align-items:center;}
.sl{font-size:14px;}
.sl em{display:block;font-style:normal;font-size:12px;color:var(--mut);}
.scorerow .bar100{width:100%;height:8px;margin:0;}
.sv{font-size:14px;text-align:right;}

/* ask */
.sugg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;}
.sugg button{text-align:left;font-size:14px;padding:13px 15px;background:var(--tint);border:1px solid var(--rule2);border-radius:var(--r-md);transition:border-color .15s,background .15s;}
.sugg button:hover{background:#fff;border-color:var(--teal);}
.log{display:flex;flex-direction:column;gap:14px;margin-bottom:16px;}
.msg.user{align-self:flex-end;text-align:right;}
.msg.user .msg-body{background:var(--mast);color:#fff;padding:10px 15px;border-radius:var(--r-lg) var(--r-lg) 4px var(--r-lg);display:inline-block;font-size:14.5px;max-width:70ch;text-align:left;}
.msg.ai .msg-body{background:var(--tint);border:1px solid var(--rule2);padding:14px 17px;border-radius:var(--r-lg) var(--r-lg) var(--r-lg) 4px;font-size:14.5px;white-space:pre-wrap;max-width:78ch;line-height:1.6;}
.msg-tag{display:block;font-size:12px;color:var(--mut);margin-bottom:5px;}
.msg-body.dim{color:var(--mut);}
.askbar{display:flex;gap:8px;background:var(--paper);border:1px solid var(--rule);border-radius:999px;padding:5px;}
.askbar:focus-within{border-color:var(--teal);box-shadow:0 0 0 3px rgba(14,124,116,.15);}
.askbar input{flex:1;min-width:0;font-family:inherit;font-size:15px;padding:8px 14px;border:0;background:none;outline:none;}
.askbar button{background:var(--teal);color:#fff !important;border:0;border-radius:999px;padding:9px 22px;font-size:14px;font-weight:600;}
.askbar button:hover{background:var(--teal-d);}
.askbar button:disabled{background:var(--rule);}

.chart{margin-top:4px;}
.rtip{background:var(--mast);color:#E6F1F0;font-size:12.5px;padding:8px 11px;border-radius:var(--r-sm);line-height:1.45;font-variant-numeric:tabular-nums;box-shadow:0 10px 24px rgba(7,43,46,.25);}

/* footer */
.foot{background:var(--paper);border-top:1px solid var(--rule2);margin-top:auto;}
.foot-in{display:flex;gap:32px;align-items:flex-start;padding-top:28px;padding-bottom:36px;}
.foot p{margin:0;font-size:13px;color:var(--mut);max-width:100ch;line-height:1.6;}

/* financing pressure */
.fps{display:inline-flex;align-items:baseline;gap:6px;padding:2px 10px 2px 9px;border-radius:999px;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.4;}
.fps b{font-weight:700;font-size:13.5px;}
.fps span{font-size:12px;font-weight:600;}
.fps-high{background:#FBE8EE;color:#8F1D3D;}
.fps-elevated{background:#FBF0DA;color:#7A4E08;}
.fps-low{background:#DFF2EE;color:#0A5752;}
.fps.lg{padding:8px 16px;gap:10px;border-radius:var(--r-md);}
.fps.lg b{font-size:36px;letter-spacing:-.03em;line-height:1;}
.fps.lg span{font-size:15px;}
.linkish{background:none;border:0;padding:0;cursor:pointer;}
.fps-head{display:flex;gap:20px;align-items:center;margin:0 0 20px;}
.fps-head p{margin:0;font-size:15.5px;max-width:70ch;}
.subhead{font-size:15px;font-weight:700;margin:24px 0 10px;}
.sub-c{color:var(--mut);font-size:13px;}
.grid.plain tr.dim td{color:#9AA6AD;}
.grid.plain tr.total td{font-weight:700;border-top:1px solid var(--ink);border-bottom:0;}
.grid td.neg{color:var(--crimson);}
.watch{margin:0;padding-left:18px;display:grid;gap:8px;font-size:14.5px;}
.raiselist ul{list-style:none;margin:0;padding:0;}
.raiselist li button{display:grid;grid-template-columns:52px 1fr auto;gap:10px;align-items:center;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--rule2);padding:10px 4px;}
.raiselist li button:hover{background:var(--tint);}
.rl-h{font-family:var(--display);font-size:20px;font-weight:700;font-stretch:90%;letter-spacing:-.014em;margin:0 0 6px;}
.rl-note{font-size:13.5px;color:var(--mut);margin:0 0 12px;}
.rl-empty{font-size:14px;margin:0 0 6px;padding:12px 14px;background:var(--tint);border-radius:var(--r-md);}
.rl-sub{font-size:13px;font-weight:600;color:var(--mut);margin:16px 0 4px;}
.rl-t{font-weight:700;}
.rl-n{font-size:13.5px;}
.rl-n em{display:block;font-style:normal;font-size:12px;color:var(--mut);}
.mini-fps{list-style:none;margin:0;padding:0;}
.mini-fps button{display:grid;grid-template-columns:50px 1fr auto;gap:8px;align-items:center;width:100%;background:none;border:0;border-top:1px solid var(--rule2);padding:8px 0;text-align:left;font-size:13.5px;}
.mini-fps button:hover{background:var(--tint);}
.mini-fps span{color:var(--mut);}
.two.wide-left{grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);}

/* buttons */
.btn{background:#fff;border:1px solid var(--rule);border-radius:999px;padding:10px 18px;font-size:14px;font-weight:600;white-space:nowrap;transition:background .15s,border-color .15s;}
.btn:hover{border-color:var(--teal);}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff !important;}
.btn.primary:hover{background:var(--teal-d);border-color:var(--teal-d);}

/* report + about us */
.report-head{padding:32px 34px;}
.kicker-static{font-size:13px;font-weight:600;color:var(--teal);margin:0 0 8px;}
.report-h{font-family:var(--display);font-size:clamp(30px,3.4vw,46px);font-weight:700;font-stretch:84%;letter-spacing:-.025em;line-height:1.03;margin:0 0 14px;max-width:24ch;text-wrap:balance;}
.section-h{font-family:var(--display);font-size:22px;font-weight:700;font-stretch:90%;letter-spacing:-.015em;margin:12px 0 -4px;}
.disclaimer{font-size:12.5px;color:var(--mut);margin:0;max-width:100ch;}
.prose{font-size:15.5px;line-height:1.6;max-width:70ch;margin:0 0 14px;}
.pillars{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;}
.pillar{padding:22px 22px;background:var(--paper);border:1px solid var(--rule2);border-radius:var(--r-lg);}
.pillar h3{font-family:var(--display);font-size:18px;font-weight:700;font-stretch:92%;letter-spacing:-.01em;margin:0 0 8px;}
.pillar p{margin:0 0 12px;font-size:14.5px;}
.pillar span{font-size:12.5px;color:var(--mut);}
.bands{display:flex;gap:10px;margin:16px 0 4px;flex-wrap:wrap;}
.facts.defs{grid-template-columns:170px 1fr;gap:12px 20px;font-size:14.5px;}
.facts.defs dd{max-width:80ch;}
.tr-list{margin:12px 0 0;padding-left:18px;font-size:14.5px;display:grid;gap:6px;}
.trace td:first-child{white-space:nowrap;}

/* waitlist */
.waitlist{background:var(--paper);border:1px solid var(--rule2);border-radius:var(--r-lg);padding:22px 24px;}
.waitlist h3{font-family:var(--display);font-size:20px;font-weight:700;font-stretch:90%;letter-spacing:-.014em;margin:0 0 6px;}
.waitlist p{margin:0 0 14px;font-size:14.5px;color:var(--ink2);}
.wl-fields{display:flex;gap:8px;flex-wrap:wrap;}
.wl-fields input,.wl-fields select{font:inherit;font-size:14.5px;padding:10px 14px;border:1px solid var(--rule);border-radius:999px;background:#fff;color:var(--ink);}
.wl-fields input:focus,.wl-fields select:focus{border-color:var(--teal);outline:none;box-shadow:0 0 0 3px rgba(14,124,116,.15);}
.wl-fields input{flex:1 1 220px;}
.wl-fields button{background:var(--teal);color:#fff !important;border:0;border-radius:999px;padding:10px 22px;font-size:14.5px;font-weight:600;}
.wl-fields button:hover{background:var(--teal-d);}
.wl-fields button:disabled{opacity:.6;}
.wl-fine{font-size:12.5px !important;color:var(--mut) !important;margin:10px 0 0 !important;}
.wl-err{color:var(--crimson) !important;margin:10px 0 0 !important;}
.wl-done{font-weight:600;margin:0 !important;}
.waitlist.compact{border:0;border-top:1px solid var(--rule2);border-radius:0;padding:14px 0 0;background:none;}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}

@media (max-width:1500px){
  .front{grid-template-columns:minmax(0,1fr) 300px;}
  .front>.side{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,1fr);gap:20px;}
  .pillars{grid-template-columns:1fr 1fr;}
}
@media (max-width:1240px){
  .probs{grid-template-columns:1fr 1fr;}
  .hero{grid-template-columns:1fr;gap:28px;padding:32px 28px;}
}
@media (max-width:960px){
  .app{display:block;}
  .mast{position:static;height:auto;overflow:visible;border-right:0;}
  .mast-in{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 16px 4px;min-height:0;}
  .wordmark{margin-left:0;}
  .omni{flex:1;width:auto;min-width:140px;}
  .nav,.app.lay-top .nav{flex-direction:row;flex-basis:100%;gap:2px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:2px 16px 8px;}
  .nav::-webkit-scrollbar{display:none;}
  .nav-menu,.app.lay-top .nav-menu,.app.lay-top .nav-group:hover .nav-menu,.app.lay-top .nav-group:focus-within .nav-menu{display:none;}
  .nav .nav-top,.app.lay-top .nav .nav-top{border-radius:999px;padding:8px 13px;font-size:14px;font-weight:600;letter-spacing:0;text-transform:none;color:#B5CCCB;white-space:nowrap;box-shadow:none;}
  .nav .nav-top::after,.app.lay-top .nav .nav-top::after{display:none;}
  .nav-group.cur .nav-top,.app.lay-top .nav-group.cur .nav-top{color:var(--mast);background:var(--mint);}
  .subnav{display:block;}
  .toc{display:none;}
  .subnav-in{padding:0 16px;}
  .subnav-h{display:none;}
  .side-foot,.app.lay-top .side-foot{display:none;}
  .app.lay-top .mast-in{padding:12px 16px 4px;min-height:0;gap:8px 16px;}
  .app.lay-top .omni{flex:1;width:auto;min-width:140px;margin-left:0;}
  .app.lay-top .nav{margin:0 -16px;padding:2px 16px 8px;}
}
@media (max-width:860px){
  .two.wide-left,.pillars{grid-template-columns:1fr;}
  .fps-head{flex-direction:column;align-items:flex-start;}
  .facts.defs{grid-template-columns:1fr;}
  .front,.front>.side{grid-template-columns:1fr;}
  .briefs,.two,.filters,.prog-list,.metrics,.sugg,.q-body{grid-template-columns:1fr;}
  .metrics.four{grid-template-columns:1fr 1fr;}
  .three,.probs,.fdacards{grid-template-columns:1fr;}
  .gantt-axis,.gantt-row{grid-template-columns:1fr;gap:6px;}
  .gantt-axis>span:first-child{display:none;}
  .gantt-ticks em:nth-child(even){display:none;}
  .wordmark{font-size:30px;}
  .lead,.quote,.panel,.report-head{padding:22px 18px;}
  .hero{padding:28px 20px;border-radius:var(--r-lg);}
  .hero-rail{padding:16px 12px 12px;}
  .main{padding:16px 16px 40px;}
  .foot-in{padding-left:16px;padding-right:16px;}
  .q-price{font-size:36px;}
  .scorewrap{grid-template-columns:1fr;}
  .scorerow{grid-template-columns:130px 1fr 30px;}
  .evrow{grid-template-columns:60px 8px auto 1fr;}
  .ev-run,.ev-days{display:none;}
  .tl{grid-template-columns:12px 92px 1fr;}
  .tl-days{display:none;}
  .foot-in{flex-direction:column;gap:16px;}
  .rail-zone.z-elevated em{font-size:0;}
  .rail-zone.z-elevated em::after{content:"Elev.";font-size:11px;}
}
@media (prefers-reduced-motion:reduce){
  .strip{overflow-x:auto;}
  .strip-track{animation:none;}
  .strip-half[aria-hidden]{display:none;}
  .app *{transition:none !important;}
}
/* ---------- financial-news look: white masthead, black bars, serif headlines, ruled sections ---------- */
.app{--bg:#FFFFFF;--tint:#F4F6F7;--rule:#D3D8DB;--rule2:#E2E6E8;--ink:#101417;--ink2:#2B3439;--mut:#5C676D;
--serif:'Source Serif 4 Variable',Georgia,'Times New Roman',serif;--r-xl:4px;--r-lg:3px;--r-md:3px;--r-sm:3px;}
.app h1,.lead-h,.report-h,.brief h2,.pillar h3,.prob h3,.subnav-h{font-family:var(--serif);font-stretch:normal;}
.lead-h{font-size:clamp(30px,3.2vw,44px);line-height:1.08;font-weight:700;letter-spacing:-.015em;}
.report-h{font-size:clamp(28px,3vw,40px);line-height:1.1;font-weight:700;letter-spacing:-.012em;}
.hero h1{font-family:var(--serif);font-weight:700;letter-spacing:-.015em;}
.brief h2{font-size:19px;line-height:1.25;font-weight:650;letter-spacing:-.005em;}
.pillar h3{font-size:19px;letter-spacing:-.005em;}
.panel,.lead,.wire,.side>section,.pillar{border:0;border-top:2px solid var(--ink);border-radius:0;box-shadow:none;background:var(--paper);}
.panel{padding:14px 0 6px;}
.lead{padding:14px 0 6px;}
.side>section{padding:12px 0 6px;}
.pillar{padding:14px 0 4px;}
.report-head{padding:18px 0 10px;border-top:0;}
.ph{margin-bottom:14px;}
.wire{padding:12px 0 6px;}
.ts-box:empty{display:none;}
.subh{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 8px;color:var(--ink);}
.takeaways{margin:18px 0 16px;padding:16px 20px;background:var(--tint);border-left:3px solid var(--teal);}
.takeaways .subh{margin-top:0;}
.limits{margin-top:14px;border-top:1px solid var(--rule2);padding-top:12px;}
.limits summary{cursor:pointer;font-weight:700;font-size:14px;color:var(--teal-d);}
.limits[open] summary{margin-bottom:10px;}
.ts-box{margin-top:12px;}
.removeme{display:flex;flex-wrap:wrap;gap:10px;align-items:center;max-width:560px;}
.removeme input{flex:1;min-width:200px;font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--rule);border-radius:3px;}
.removeme .ts-box,.removeme .wl-err{flex-basis:100%;}
.foot-link{color:#fff !important;text-decoration:underline;text-underline-offset:3px;}
.quote{border:0;border-radius:0;padding:14px 0 6px;}
.q-id h1{font-family:var(--serif);font-stretch:normal;letter-spacing:-.015em;}
.problem-h{font-family:var(--serif);font-size:24px;font-weight:650;line-height:1.25;color:var(--ink);margin-bottom:10px;}
.rl-h{font-family:var(--sans);font-size:13px;font-weight:800;font-stretch:normal;text-transform:uppercase;letter-spacing:.08em;line-height:1.3;}
.ph h2{font-family:var(--sans);font-size:13px;font-weight:800;font-stretch:normal;text-transform:uppercase;letter-spacing:.08em;line-height:1.3;}
.side>section h2,.wire h2{font-family:var(--sans);text-transform:uppercase;letter-spacing:.08em;font-size:13px;font-weight:800;font-stretch:normal;}
.kicker-static,.kicker{text-transform:uppercase;letter-spacing:.07em;font-size:12px;font-weight:700;}
.btn{border-radius:3px;}
.lead-chart{border-radius:0;background:var(--tint);}
.hero{border-radius:0;}
.hero-rail{border-radius:3px;}
.tape{background:#fff;border-bottom:1px solid var(--rule);}
.foot{background:#0B0F12;border-top:0;}
.foot p{color:#A9B3B8;}
.foot .wordmark.small{color:#fff !important;--strand2:var(--mint);}
.subnav{border-bottom:1px solid var(--rule);}
.subnav-h{font-size:22px;font-weight:700;letter-spacing:-.01em;}
.subnav button.on{border-bottom-width:3px;border-bottom-color:var(--ink);}

/* top masthead */
.utility{display:none;}
.app.lay-top .utility{display:block;background:#0B0F12;color:#C3CCD0;font-size:12.5px;}
.utility-in{max-width:1320px;margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:20px;height:34px;white-space:nowrap;overflow:hidden;}
.utility-date{color:#fff;font-weight:600;}
.utility-sp{flex:1;}
.utility-btn{background:none;border:0;padding:4px 0;font-size:12.5px;font-weight:600;color:#C3CCD0 !important;}
.utility-btn:hover{color:#fff !important;text-decoration:underline;text-underline-offset:3px;}
.app.lay-top .mast{position:static;background:#fff;color:var(--ink);border-bottom:1px solid var(--rule);backdrop-filter:none;-webkit-backdrop-filter:none;}
.app.lay-top .mast-in{flex-wrap:wrap;align-items:center;gap:0 24px;min-height:0;padding:20px 24px 0;}
.app.lay-top .mast .wordmark{order:1;font-size:40px;color:var(--ink) !important;--strand2:var(--teal);--rung:#7CC4BA;}
.app.lay-top .mast .wordmark:hover .xg-b,.app.lay-top .mast .wordmark:hover .ul-b{stroke:var(--teal-d);}
.app.lay-top .omni{order:2;margin-left:auto;width:300px;}
.app.lay-top .omni input{background:var(--tint);border-color:var(--rule);color:var(--ink);border-radius:3px;}
.app.lay-top .omni input:focus{background:#fff;border-color:var(--ink);}
.app.lay-top .omni input::placeholder{color:var(--mut);}
.app.lay-top .side-foot{display:none;}
.app.lay-top .nav{order:3;flex-basis:100%;margin:16px 0 0;padding:0;border-top:1px solid var(--rule);gap:0;}
.app.lay-top .nav .nav-top{color:var(--ink);border-radius:0;padding:13px 18px 12px;font-size:15px;font-weight:700;box-shadow:none;}
.app.lay-top .nav-group:first-child .nav-top{padding-left:0;}
.app.lay-top .nav-group:hover .nav-top,.app.lay-top .nav-group:focus-within .nav-top{background:none;color:var(--teal-d);}
.app.lay-top .nav-group.cur .nav-top{color:var(--ink);background:none;border-radius:0;box-shadow:inset 0 -4px 0 var(--teal);}
.app.lay-top .nav-menu{top:100%;border-radius:0 0 3px 3px;border-top:2px solid var(--ink);}
.app.lay-top .nav-menu::before{display:none;}
@media (max-width:960px){
  .utility-in{padding:0 16px;}
  .utility .hide-sm{display:none;}
  .app.lay-top .mast-in{padding:12px 16px 0;gap:10px 14px;}
  .app.lay-top .mast .wordmark{font-size:30px;}
  .app.lay-top .omni{flex:1;width:auto;min-width:140px;}
  .app.lay-top .nav{margin:10px -16px 0;padding:0 6px;overflow-x:auto;}
  .app.lay-top .nav .nav-top,.app.lay-top .nav-group:first-child .nav-top{padding:11px 10px;font-size:14px;color:var(--ink);background:none;}
  .app.lay-top .nav-group.cur .nav-top{color:var(--ink);background:none;box-shadow:inset 0 -3px 0 var(--teal);}
  .main{padding:18px 16px 44px;}
}
/* ---------- theme finish: spacing, story cards, sign-up band, footer ---------- */
.stack{gap:32px;}
.front-wrap{gap:32px;}
.main{padding-top:32px;}
.briefs{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:28px;border-top:0;}
.brief{display:flex;flex-direction:column;padding:18px 20px 20px;border:1px solid var(--rule2);border-top:3px solid var(--teal);border-radius:4px;background:#fff;box-shadow:0 1px 2px rgba(16,20,23,.04);transition:box-shadow .2s,transform .2s;}
.brief:hover{box-shadow:0 10px 26px rgba(16,20,23,.09);transform:translateY(-2px);}
.brief h2 button:hover{color:var(--teal-d);}
.lead-h button:hover{color:var(--teal-d);}
.utility-cta{background:var(--mint);color:#062B2E !important;border:0;border-radius:3px;padding:5px 12px;font-size:12.5px;font-weight:700;}
.utility-cta:hover{background:#fff;}
.deal-tag.bp-tag { background: var(--teal); }
.bp-note { margin: 8px 0 0; font-size: 14px; color: var(--mut); max-width: 760px; }
.deal-tag { display:inline-block; vertical-align:middle; margin-left:12px; font: 600 11px/1 var(--sans, system-ui); letter-spacing:.06em; text-transform:uppercase; padding:5px 8px; border-radius:3px; background:#b4232a; color:#fff; }
.cta-band{background:var(--mast);color:#fff;margin-top:56px;}
.cta-in{max-width:1320px;margin:0 auto;padding:44px 24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:40px;align-items:center;}
.cta-kicker{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mint);}
.cta-copy h2{font-family:var(--serif);font-size:clamp(24px,2.4vw,32px);line-height:1.15;font-weight:700;letter-spacing:-.01em;margin:0 0 10px;color:#fff;}
.cta-copy p{margin:0;color:#B9CFCD;font-size:15px;line-height:1.55;max-width:52ch;}
.waitlist.in-band{background:none;border:0;padding:0;}
.waitlist.in-band .wl-fields input,.waitlist.in-band .wl-fields select{border-color:transparent;border-radius:3px;padding:12px 14px;}
.waitlist.in-band .wl-fields button{background:var(--mint);color:#062B2E !important;border-radius:3px;padding:12px 22px;font-weight:700;}
.waitlist.in-band .wl-fields button:hover{background:#fff;}
.waitlist.in-band .wl-fine{color:#9DB8B5 !important;}
.waitlist.in-band .wl-fine .src{color:#fff !important;}
.waitlist.in-band .wl-done{color:#fff;font-size:16px;}
.waitlist.in-band .wl-err{color:#FFB4B4 !important;}
.foot{margin-top:0;}
.foot-wrap{max-width:1320px;margin:0 auto;padding:0 24px;}
.foot-top{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(3,minmax(0,1fr));gap:40px;padding-top:52px;padding-bottom:44px;}
.foot-brand p{margin:14px 0 0;max-width:38ch;font-size:14px;line-height:1.6;}
.foot-col{display:flex;flex-direction:column;align-items:flex-start;gap:2px;}
.foot-col h3{margin:4px 0 12px;font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#fff;}
.foot-col button,.foot-col a{background:none;border:0;padding:5px 0;font-size:14px;color:#A9B3B8 !important;text-align:left;text-decoration:none;}
.foot-col button:hover,.foot-col a:hover{color:#fff !important;}
.foot-bottom{border-top:1px solid rgba(255,255,255,.1);}
.foot-bottom .foot-wrap{padding-top:22px;padding-bottom:30px;display:grid;gap:10px;}
.foot-bottom p{margin:0;font-size:12.5px !important;line-height:1.6;color:#8D989E !important;max-width:none;}
.foot-copy{color:#C3CCD0 !important;}
@media (max-width:960px){
  .briefs{grid-template-columns:minmax(0,1fr);}
  .cta-in{grid-template-columns:minmax(0,1fr);gap:22px;padding:34px 16px;}
  .foot-wrap{padding:0 16px;}
  .foot-top{grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 20px;padding-top:38px;padding-bottom:32px;}
  .foot-brand{grid-column:1/-1;}
  .main{padding-top:22px;}
}
`;
