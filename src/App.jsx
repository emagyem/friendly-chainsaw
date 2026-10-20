import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, ReferenceLine, BarChart, Bar, Cell, AreaChart, Area
} from "recharts";
import { COMPANIES, META, HISTORY } from "./data.js";
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
};


/* ---------------------------- calculations ---------------------------- */

const TODAY = new Date();
const days = (iso) => Math.round((new Date(iso + "T00:00:00") - TODAY) / 86400000);
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const money = (m) => (m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);
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
  const pos = posOverride ?? POS[p.ph];
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
  .replace(/Next quarterly report \(estimated\)/i, "Quarterly report (est.)");
// For use inside sentences, where "(est.)" reads badly.
const plainLabel = (l) => shortLabel(l).replace(/ \(est\.\)$/, "");
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
  if (r < 12) out.push({ sev: "high", text: `Cash runway of ${num(r)} months. Financing likely before the next major catalyst.` });
  else if (r < 18) out.push({ sev: "med", text: `Cash runway of ${num(r)} months. Watch for an opportunistic raise.` });
  const nc = nextCatalyst(c);
  // A routine quarterly report is worth noting, not a reason to act.
  if (nc && nc.kind === "earnings") out.push({ sev: "low", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  else if (nc && days(nc.date) <= 45) out.push({ sev: "high", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  else if (nc && days(nc.date) <= 120) out.push({ sev: "low", text: `${shortLabel(nc.label)} in ${days(nc.date)} days.` });
  const atm = c.financings.find((f) => f.type === "ATM program" && days(f.date) > -540);
  if (atm) out.push({ sev: "med", text: `ATM program open since ${fmtDate(atm.date)}. Dilution can arrive without an announcement.` });
  const dil = shareGrowth(c);
  if (dil > 25) out.push({ sev: "med", text: `Share count up roughly ${num(dil, 0)}% ${dilutionPhrase(c)}.` });
  if (c.stale) out.push({ sev: "low", text: "The latest refresh could not update this company, so these figures are from an earlier run." });
  const evpv = c.ev / Math.max(pipelineValue(c), 1);
  if (evpv < 0.8) out.push({ sev: "low", text: `Enterprise value is ${num((1 - evpv) * 100, 0)}% below the modeled risk-adjusted pipeline value. Check the peak sales assumption before reading that as cheap.` });
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
    ? `Operating cash flow is positive, and it holds ${money(c.cash)} in cash and investments.`
    : `It holds ${money(c.cash)} in cash and investments against a burn of $${num(c.burn)}M a month, about ${num(runway(c), 0)} months of runway.`;

  // Regulatory decisions in the next six months
  const reg = [];
  COMPANIES.forEach((c) => c.catalysts.forEach((x) => { const d = days(x.date); if (x.kind === "regulatory" && d >= 0 && d <= 180) reg.push({ c, x, d }); }));
  reg.sort((a, b) => a.d - b.d).forEach(({ c, x, d }) => add({
    kind: "reg", c, weight: 100 - d / 10,
    headline: `${c.n} faces an FDA decision ${d <= 1 ? "this week" : `in ${d} days`}`,
    dek: `The FDA's target action date for ${x.drug || "its application"} is ${fmtDate(x.date)}. ${runwayLine(c)}`,
  }));

  // Biggest price moves
  if (hasQuotes()) {
    const movers = COMPANIES.filter((c) => c.quote?.chgPct != null).sort((a, b) => Math.abs(b.quote.chgPct) - Math.abs(a.quote.chgPct));
    movers.slice(0, 2).forEach((c) => {
      const q = c.quote;
      const offHigh = q.hi52 ? ((q.price / q.hi52) - 1) * 100 : null;
      add({
        kind: "move", c, weight: Math.abs(q.chgPct) * 6,
        headline: `${c.n} shares ${q.chgPct >= 0 ? "rise" : "fall"} ${Math.abs(q.chgPct).toFixed(1)}%`,
        dek: `The stock closed at ${fmtPx(q.price)} on ${fmtDate(q.date)}${offHigh != null ? `, ${Math.abs(offHigh).toFixed(0)}% ${offHigh < 0 ? "below" : "above"} its 52-week high of ${fmtPx(q.hi52)}` : ""}. Market value stands at ${money(c.mcap)}.`,
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
      headline: `${x.drug || c.n} ${p ? `${p.ph} ` : ""}data expected in ${d} days`,
      dek: `${c.n}${p ? ` is testing ${x.drug} in ${p.ind.toLowerCase()}` : ""}. The ${x.est ? "estimated " : ""}date is ${fmtDate(x.date)}${x.est ? ", taken from the trial registry, so topline results may come later" : ""}.`,
    });
  });

  // Shortest runway
  const tight = [...COMPANIES].filter((c) => !c.cashFlowPositive).sort((a, b) => runway(a) - runway(b))[0];
  if (tight) {
    const nc = nextCatalyst(tight);
    add({
      kind: "runway", c: tight, weight: 70 - runway(tight),
      headline: `${tight.n} has the shortest cash runway in the group`,
      dek: `${runwayLine(tight)}${nc ? ` Its next dated event, ${shortLabel(nc.label)}, is due ${fmtDate(nc.date)}.` : ""}`,
    });
  }

  // Dilution
  const dil = [...COMPANIES].filter((c) => c.dil24 != null).sort((a, b) => b.dil24 - a.dil24)[0];
  if (dil && dil.dil24 > 15) {
    add({
      kind: "dilution", c: dil, weight: dil.dil24 / 2,
      headline: `${dil.n}${dil.n.endsWith("s") ? "'" : "'s"} share count is up ${dil.dil24.toFixed(0)}% in two years`,
      dek: `Shares outstanding now total ${num(dil.shares, 1)} million, according to its latest SEC filing. ${dil.financings.length} offering ${dil.financings.length === 1 ? "filing" : "filings"} in the past three years.`,
    });
  }
  // Financing pressure leads the page: the company most likely to need money before its next catalyst.
  const pressed = [...COMPANIES].map((c) => ({ c, f: fpsOf(c) })).filter((x) => x.f.score != null).sort((a, b) => b.f.score - a.f.score);
  pressed.slice(0, 2).forEach(({ c, f }, i) => {
    const cat = f.catalyst;
    add({
      kind: "pressure", c, weight: (i === 0 ? 300 : 90) + f.score,
      headline: c.cashFlowPositive ? `${c.n} faces little financing pressure`
        : `${c.n} has ${num(f.runway, 0)} months of cash${cat ? ` and ${cat.kind === "regulatory" ? "an FDA decision" : `a ${(c.pipeline.find((p) => p.d === cat.drug)?.ph || "trial")} readout`} in ${num(f.monthsToCatalyst, 0)}` : ""}`,
      dek: `Its Financing Pressure Score is ${f.score}, in the ${f.band} band. ${!cat
        ? `No clinical or regulatory event is dated, so the score assumes one ${NO_CATALYST_MONTHS} months out${(() => { const t = f.parts.find((p) => p.key === "trend"); return t?.present && t.value > 10 ? `, and burn is up ${Math.round(t.value)}% from a year earlier` : ""; })()}.`
        : Math.round(f.gap) < 0
        ? `Counting a ${BUFFER_MONTHS}-month buffer after ${cat ? plainLabel(cat.label) : "its next catalyst"}, its cash falls about ${Math.round(-f.gap)} months short.`
        : Math.round(f.gap) === 0 ? `Counting a ${BUFFER_MONTHS}-month buffer after ${cat ? plainLabel(cat.label) : "its next catalyst"}, it has almost nothing to spare.`
          : `Counting a ${BUFFER_MONTHS}-month buffer after ${cat ? plainLabel(cat.label) : "its next catalyst"}, it has about ${Math.round(f.gap)} months to spare.`}${c.raise?.capacity === "atm" ? " An at-the-market program is on file, so it can sell shares at any time." : c.raise?.capacity === "shelf" ? " A shelf registration is on file." : ""}`,
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

  const movers = [...COMPANIES].sort((a, b) => quotes ? (b.quote?.chgPct ?? -999) - (a.quote?.chgPct ?? -999) : b.mcap - a.mcap);

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
      <section className="idbar">
        <div>
          <h1 className="id-line">The platform that tells you who has to raise money, and when.</h1>
          <p className="id-sub">Cash, catalysts and the capacity to raise, for {COMPANIES.length} clinical-stage biotechs. Every number traced to its filing.</p>
        </div>
        <div className="id-ctas">
          <button className="btn primary" onClick={() => go("report")}>Read the Financing Pressure Report</button>
          <button className="btn" onClick={() => go("method")}>How the score works</button>
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
              <p className="byline">Written automatically from SEC filings, ClinicalTrials.gov and market prices{LIVE ? `, updated ${fmtDate(META.generatedAt.slice(0, 10))}` : ""}.</p>
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
            {quotes && <p className="colnote">Change from the previous close.</p>}
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
              {watch.map((t) => COMPANIES.find((x) => x.t === t)).filter(Boolean).map((c) => (
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

      <div className="two wide-left">
        <section className="panel">
          <header className="ph"><h2>Financing Pressure Score</h2>
            <span className="ph-note">How likely each company is to need new money before its next major catalyst. Dashed lines mark the Elevated (40) and High (70) bands.</span></header>
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
  const c = COMPANIES.find((x) => x.t === ticker) || COMPANIES[0];
  const [tab, setTab] = useState(initialTab);
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

  const tabs = [["overview", "Overview"], ["pressure", "Financing pressure"], ["financials", "Financials"], ["pipeline", "Pipeline"], ["catalysts", "Catalysts"], ["valuation", "Valuation"], ["score", "Score"]];

  return (
    <div className="stack">
      <section className="quote">
        <div className="q-top">
          <div className="q-id">
            <h1>{c.n}</h1>
            <span className="q-tk">{c.t}</span>
            <span className="q-area">{c.area}</span>
          </div>
          <button className={"watchbtn " + (watch.includes(c.t) ? "on" : "")} aria-pressed={watch.includes(c.t)} onClick={() => toggleWatch(c.t)}>
            {watch.includes(c.t) ? "★ On your watchlist" : "☆ Add to watchlist"}
          </button>
        </div>
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
            <dt>Research score</dt><dd className="num">{score} <span className="sub inline">of 100</span></dd>
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

      <nav className="tabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>

      {tab === "pressure" && <FpsPanel c={c} go={go} />}

      {tab === "overview" && (
        <div className="two">
          <section className="panel">
            <header className="ph"><h2>Key figures</h2><span className="ph-note">Select a figure to see its source and calculation.</span></header>
            <div className="metrics">
              <div className="metric"><span>Cash runway</span>
                <Trace value={r >= 120 ? "10+" : num(r)} unit={r >= 120 ? " years" : " months"} tone={r < 12 ? "warn" : ""}
                  source={c.src ? `${c.src.filing?.form || "SEC filing"} balance sheet as of ${fmtDate(c.src.asOf)}: cash plus marketable securities` : `Cash of ${money(c.cash)} and quarterly operating cash use, latest filing`}
                  link={c.src?.filing?.url}
                  calc={`${money(c.cash)} ÷ ${num(c.burn)}M per month`}
                  reading={r < 12 ? "Financing is likely needed before the next major catalyst." : r < 18 ? "Enough to reach the next event, not enough to negotiate from strength after it." : "Funded through the next catalyst with room to spare."} />
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
              {alertsFor(c).length === 0 && <div className="empty">No rules fired. Cash, timing, and dilution all sit inside normal bands.</div>}
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

      {tab === "financials" && (
        <div className="stack">
          <section className="panel">
            <header className="ph"><h2>Cash runway</h2>
              <span className="ph-note">Straight-line burn against reported cash. Use the slider to model a financing.</span></header>
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
                    <dt>Expected readout</dt><dd className="mono">{fmtDate(p.ro)} <span className="sub inline">({days(p.ro)}d{p.roType === "ESTIMATED" ? ", registry estimate" : ""})</span></dd>
                    {p.nct && <><dt>Registry</dt><dd className="mono"><ExtLink href={`https://clinicaltrials.gov/study/${p.nct}`}>{p.nct}</ExtLink>{p.trials > 1 ? <span className="sub inline"> +{p.trials - 1} more</span> : null}</dd></>}
                    <dt>Probability of approval</dt><dd className="mono">{Math.round(POS[p.ph] * 100)}%</dd>
                    <dt>Peak sales estimate</dt><dd className="mono">{money(p.peak)}{p.est ? <span className="sub inline"> placeholder</span> : null}</dd>
                    <dt>Risk-adjusted value</dt><dd className="mono strong">{money(v)}</dd>
                  </dl>
                </article>
              );
            })}
          </div>
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
                  value: rnpv(p, { discount: disc / 100, posOverride: Math.max(0.01, POS[p.ph] + posAdj / 100) }),
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
              <div className="metric"><span>Modeled pipeline value</span><b className="mono">{money(c.pipeline.reduce((s, p) => s + rnpv(p, { discount: disc / 100, posOverride: Math.max(0.01, POS[p.ph] + posAdj / 100) }), 0))}</b></div>
              <div className="metric"><span>Enterprise value today</span><b className="mono">{money(c.ev)}</b></div>
              <div className="metric"><span>Enterprise value as a share of modeled value</span><b className="mono">{num((c.ev / pv) * 100, 0)}%</b></div>
              <div className="metric"><span>Cash per share</span><b className="mono">${num(c.cash / c.shares, 2)}</b></div>
            </div>
          </section>
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
                  <span className="ev-label">{e.label}</span>
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
  const cols = sel.map((t) => COMPANIES.find((c) => c.t === t)).filter(Boolean);

  const rows = [
    ["Therapeutic area", (c) => c.area],
    ["Most advanced program", (c) => leadProgram(c).ph],
    ["Programs", (c) => c.pipeline.length],
    ["Market cap", (c) => money(c.mcap), 1],
    ["Enterprise value", (c) => money(c.ev), 1],
    ["Cash", (c) => money(c.cash), 1],
    ["Debt", (c) => (c.debt ? money(c.debt) : "None"), 1],
    ["Monthly burn", (c) => `$${num(c.burn)}M`, 1],
    ["Runway", (c) => `${num(runway(c))} mo`, 1],
    ["Next catalyst", (c) => (nextCatalyst(c) ? `${days(nextCatalyst(c).date)}d` : "—"), 1],
    ["Pipeline rNPV", (c) => money(pipelineValue(c)), 1],
    ["EV / rNPV", (c) => `${num((c.ev / pipelineValue(c)) * 100, 0)}%`, 1],
    ["Institutional ownership", (c) => (c.own == null ? "—" : `${num(c.own, 0)}%`), 1],
    ["Financing Pressure Score", (c) => <BandBadge c={c} />],
    ["Runway-to-catalyst gap", (c) => fmtGap(fpsOf(c).gap), 1],
    ["Raise-ready capacity", (c) => capacityLabel(c)],
    ["Research score", (c) => bis(c), 1],
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
                  {COMPANIES.map((c) => <option key={c.t} value={c.t}>{c.t} — {c.n}</option>)}
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
    if (!text || busy) return;
    setQ("");
    setLog((l) => [...l, { role: "user", text }]);
    setBusy(true);
    try {
      // The API key lives in the serverless function (api/ask.js), never in the browser.
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only the question is sent; the server builds the data from the published data file.
        body: JSON.stringify({ question: text }),
      });
      if (res.status === 429) {
        setLog((l) => [...l, { role: "ai", text: "That's a lot of questions in a short time. Wait a minute and ask again.", fallback: true }]);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(`ask endpoint returned ${res.status}`);
      const data = await res.json();
      const out = (data.text || "").trim();
      setLog((l) => [...l, { role: "ai", text: out || local(text), traced: true }]);
    } catch (e) {
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
            {suggestions.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
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
          <button onClick={() => send()} disabled={busy || !q.trim()}>Ask</button>
        </div>
      </section>
    </div>
  );
}

/* ------------------------- financing pressure -------------------------
   The Financing Pressure Score (see src/fps.js) and everything built on it:
   the Raise List, the Pressure Report, the methodology page, the public
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
          <span className="rl-n">{c.n}<em>{fmtRunway(f.runway, "months")} of cash, {f.catalyst ? `${plainLabel(f.catalyst.label)} in ${Math.round(f.monthsToCatalyst)} months` : "no dated catalyst"}</em></span>
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
    ? "High likelihood of an equity raise around the next catalyst; existing holders face dilution risk."
    : f.band === "Elevated"
      ? "A raise before or soon after the next catalyst is plausible; watch for offering filings."
      : "Cash covers the next catalyst with room to spare; near-term financing pressure is low.";
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
          <span className="ph-note">How likely {c.n} is to need new money before its next major catalyst.</span></header>
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
          <li>Any 8-K announcing an offering, private placement or ATM sales.</li>
          <li>Whether burn rises further ahead of {cat ? shortLabel(cat.label) : "the next catalyst"}{f.parts.find((p) => p.key === "trend")?.present ? ` (currently ${f.parts.find((p) => p.key === "trend").value > 0 ? "+" : ""}${num(f.parts.find((p) => p.key === "trend").value, 0)}% year on year)` : ""}.</li>
          <li>Changes to the catalyst date, which would move the gap and the score.</li>
          <li>New partnerships or non-dilutive funding that would lower pressure.</li>
        </ul>
        {go && <button className="morelink" onClick={() => go("method")}>How the score is calculated</button>}
      </section>
    </div>
  );
}

function Waitlist({ compact }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [state, setState] = useState("idle");
  const submit = async (e) => {
    e.preventDefault();
    setState("sending");
    try {
      const res = await fetch("/__forms.html", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ "form-name": "waitlist", email, role, "bot-field": "" }).toString(),
      });
      setState(res.ok ? "done" : "error");
    } catch { setState("error"); }
  };
  if (state === "done") return <div className={"waitlist" + (compact ? " compact" : "")}><p className="wl-done">You're on the list. The next Financing Pressure Report will come to {email}.</p></div>;
  return (
    <form className={"waitlist" + (compact ? " compact" : "")} name="waitlist" onSubmit={submit}>
      <input type="hidden" name="form-name" value="waitlist" />
      <h3>Get the Financing Pressure Report by email</h3>
      {!compact && <p>A short note when the Raise List changes, with every number linked to its filing. No hype, no stock picks.</p>}
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
        <button type="submit" disabled={state === "sending"}>{state === "sending" ? "Joining…" : "Join the waitlist"}</button>
      </div>
      {state === "error" && <p className="wl-err">That didn't go through. Check your connection and try again.</p>}
      <p className="wl-fine">We'll only email you about Helixora. Unsubscribe any time.</p>
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
    ? `${top.n} has about ${Math.round(tf.runway)} months of cash and no dated clinical or regulatory event. ${topTrend?.present && topTrend.value > 10 ? `Its burn is up ${Math.round(topTrend.value)}% from a year earlier` : "Its burn is steady"}${capPhrase.replace(", and it already has", ", and it already has").replace(", with a shelf", ", and it has a shelf")}.`
    : top
    ? `${top.n} has about ${num(tf.runway, 0)} months of cash${tf.catalyst ? ` and its ${plainLabel(tf.catalyst.label)} is ${Math.round(tf.monthsToCatalyst)} months away` : ""}, ${Math.round(tf.gap) <= 0 ? "leaving almost no buffer once the data is in" : `leaving about ${Math.round(tf.gap)} months of cash after a ${BUFFER_MONTHS}-month buffer`}${top.raise?.capacity === "atm" ? ", and it already has an at-the-market program it can sell shares through" : top.raise?.capacity === "shelf" ? ", with a shelf registration on file" : ""}.`
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

      {top && (<><h2 className="section-h">Company spotlight: {top.n}</h2><FpsPanel c={top} go={go} /></>)}

      <Waitlist />
      <p className="disclaimer">This report is general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.</p>
    </div>
  );
}

const PILLARS = [
  ["Financing risk first", "We tell you who has to raise, and when.", "The Financing Pressure Score and the Raise List"],
  ["Every number traced", "Select any figure and see the filing it came from.", "Source links on every metric and a published methodology"],
  ["Built for the middle", "Terminal-grade biotech analysis without a terminal-sized bill.", "Free to use while in early access"],
  ["Honest about uncertainty", "We publish our misses as well as our hits.", "A public, scored track record"],
];

function Methodology({ go }) {
  return (
    <div className="stack">
      <section className="panel report-head">
        <p className="kicker-static">About Helixora</p>
        <h1 className="report-h">The platform that tells you who has to raise money, and when.</h1>
        <p className="lead-dek">Catalyst calendars show dates. Enterprise terminals cost a fortune. Helixora connects cash, catalysts and the capacity to raise capital, for funds, family offices and serious independent investors, with every number traced to its filing.</p>
      </section>

      <section className="pillars">
        {PILLARS.map(([h, m, p]) => (
          <div key={h} className="pillar"><h3>{h}</h3><p>{m}</p><span>{p}</span></div>
        ))}
      </section>

      <section className="panel">
        <header className="ph"><h2>The Financing Pressure Score</h2><span className="ph-note">Version {FPS_VERSION}, updated {fmtDate(FPS_UPDATED)}</span></header>
        <p className="prose">One number from 0 to 100 for one question: how likely is a company to need new money before its next major catalyst? It describes a financing situation. It never says buy or sell.</p>
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
          <dt>Next catalyst</dt><dd>The next dated clinical or regulatory event: a trial's primary completion date on ClinicalTrials.gov, or a date the company has guided to, such as a PDUFA date. Earnings dates do not count. If nothing is dated, we assume {NO_CATALYST_MONTHS} months.</dd>
          <dt>Gap</dt><dd>Runway minus (months to catalyst + a {BUFFER_MONTHS}-month buffer). The buffer reflects that companies rarely wait until the cash is gone to raise.</dd>
          <dt>Raise-ready capacity</dt><dd>An at-the-market program is identified from a sales agreement disclosed in a prospectus supplement (424B5) or shelf registration (S-3) filed in the past three years. Each company page links to the filing used.</dd>
          <dt>Missing data</dt><dd>If a component can't be calculated from filings, it is left out and the remaining weights are scaled up. The company page says which components were used.</dd>
        </dl>
        <p className="colnote">Weights are a starting hypothesis. We will backtest them against historical offerings and publish every change below.</p>
      </section>

      <TrackRecord go={go} />

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

      <Waitlist />
      <p className="disclaimer">Helixora publishes general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.</p>
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

  useEffect(() => { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watch)); } catch { /* ignore */ } }, [watch]);

  const [companyTab, setCompanyTab] = useState("overview");
  const go = (v, t, tab) => { if (t) setTicker(t); setCompanyTab(tab || "overview"); setView(v); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const toggleWatch = (t) => setWatch((w) => (w.includes(t) ? w.filter((x) => x !== t) : [...w, t]));

  const matches = omni.trim()
    ? COMPANIES.filter((c) => (c.t + " " + c.n).toLowerCase().includes(omni.toLowerCase())).slice(0, 6)
    : [];

  const nav = [["home", "Markets"], ["report", "Pressure Report"], ["screen", "Screener"], ["company", "Quotes"], ["catalysts", "Calendar"], ["compare", "Compare"], ["ask", "Ask"], ["method", "Methodology"]];
  const dateline = TODAY.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="app">
      <style>{CSS}</style>
      <a className="skip" href="#main">Skip to content</a>

      <header className="mast">
        <div className="mast-in">
          <button className="wordmark" onClick={() => go("home")} aria-label="Helixora home">
            <Wordmark underline />
          </button>
          <span className="mast-tag">Know who has to raise, before they do.</span>
          <div className="omni">
            <input value={omni} onChange={(e) => setOmni(e.target.value)} placeholder="Search a company or ticker" aria-label="Search a company or ticker"
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { go("company", matches[0].t); setOmni(""); } }} />
            {matches.length > 0 && (
              <div className="omnilist">
                {matches.map((c) => (
                  <button key={c.t} onClick={() => { go("company", c.t); setOmni(""); }}>
                    <b>{c.t}</b>{c.n}<span className="sub">{c.area}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <nav className="nav" aria-label="Sections">
          <div className="nav-in">
            {nav.map(([k, l]) => <button key={k} className={view === k ? "on" : ""} aria-current={view === k ? "page" : undefined} onClick={() => go(k)}>{l}</button>)}
            <span className="dateline">{dateline}</span>
          </div>
        </nav>
        <TickerStrip go={go} />
        {!LIVE && <div className="samplebar">Showing the built-in sample dataset. Companies and figures are fictional until the data refresh runs.</div>}
      </header>

      <main className="main" id="main">
        {view === "home" && <Home go={go} watch={watch} toggleWatch={toggleWatch} />}
        {view === "screen" && <Screen go={go} />}
        {view === "company" && <Company key={ticker + companyTab} ticker={ticker} initialTab={companyTab} go={go} watch={watch} toggleWatch={toggleWatch} />}
        {view === "report" && <PressureReport go={go} />}
        {view === "method" && <Methodology go={go} />}
        {view === "catalysts" && <Catalysts go={go} />}
        {view === "compare" && <Compare />}
        {view === "ask" && <Ask />}
      </main>

      <footer className="foot">
        <div className="foot-in">
          <span className="wordmark small" aria-label="Helixora"><Wordmark /></span>
          <p>
            {LIVE ? (
              <>Financials from SEC EDGAR filings, trial data from ClinicalTrials.gov, prices from Yahoo Finance at the previous close. Refreshed {new Date(META.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
                {" "}Headlines on the front page are written automatically from these figures. Trial readout dates are registry estimates unless marked otherwise, and peak sales marked as placeholders are defaults, not forecasts.{" "}</>
            ) : (
              <>Showing the built-in sample dataset: companies, figures, and dates are fictional.{" "}</>
            )}
            Helixora publishes general research about companies' financing situations. It is not investment advice, is not tailored to any reader, and does not recommend buying or selling any security.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------- css -------------------------------- */

const CSS = `

.app{--mast:#0E2A2E;--mast2:#163B40;--ink:#151D22;--ink2:#36434B;--mut:#5E6B73;--bg:#F2F4F5;--paper:#FFFFFF;
--rule:#D3DADD;--rule2:#E6EAEC;--teal:#12706B;--teal-d:#0C5652;--up:#0A7D4F;--down:#C2272D;
--amber:#B8730F;--crimson:#9E2140;--moss:#2F6B3A;--deep:#0C5670;--indigo:#123E6B;
--display:'Bricolage Grotesque Variable','Arial Narrow',system-ui,sans-serif;--sans:'Instrument Sans Variable',system-ui,sans-serif;
font-family:var(--sans);color:var(--ink);background:var(--bg);min-height:100vh;font-size:14.5px;line-height:1.5;-webkit-font-smoothing:antialiased;font-optical-sizing:auto;}
.app h1{font-family:var(--display);}
.app h2,.app h3{font-family:var(--sans);}
.nowrap{white-space:nowrap;}
.clip{max-width:170px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.app *{box-sizing:border-box;}
.app :where(button){font-family:inherit;cursor:pointer;color:inherit;}
.app :focus-visible{outline:2px solid var(--teal);outline-offset:2px;}
.app :where(a){color:inherit;}
.num,.mono{font-variant-numeric:tabular-nums;}
.warn{color:var(--amber);}
.good{color:var(--moss);}
.sub{display:block;font-size:12px;color:var(--mut);font-weight:400;}
.sub.inline{display:inline;}
.sub.r{text-align:right;}
a.src{text-decoration:underline;text-decoration-color:rgba(18,112,107,.45);text-underline-offset:2px;}
a.src:hover{color:var(--teal);}
.skip{position:absolute;left:-9999px;top:8px;background:#fff;padding:8px 12px;z-index:100;}
.skip:focus{left:8px;}

/* masthead */
.mast{background:var(--mast);color:#E8F0F0;}
.mast-in,.nav-in,.foot-in{max-width:1280px;margin:0 auto;padding:0 20px;}
.mast-in{display:flex;align-items:center;gap:18px;height:74px;}
.wordmark{display:inline-flex;align-items:center;background:none;border:0;padding:0 0 8px;font-family:var(--display);font-weight:800;font-stretch:75%;font-size:40px;letter-spacing:-.03em;color:#fff !important;line-height:1;--strand2:#2FB3A3;--rung:#8FE0D5;}
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
.wordmark:hover .xg-b,.wordmark:hover .ul-b{stroke:#5FD6C6;}
.wordmark.small{font-size:24px;color:var(--ink) !important;padding:0;--strand2:var(--teal);--rung:#7CC4BA;}
.mast-tag{font-size:14px;font-stretch:90%;color:#9FBDBD;padding-left:16px;border-left:1px solid #2A5258;line-height:1.2;}
.omni{position:relative;margin-left:auto;width:min(340px,40vw);}
.omni input{width:100%;background:var(--mast2);border:1px solid #2A5258;color:#fff;border-radius:2px;padding:8px 11px;font:inherit;font-size:13.5px;}
.omni input::placeholder{color:#8FAEAF;}
.omnilist{position:absolute;top:40px;left:0;right:0;background:var(--paper);border:1px solid var(--rule);box-shadow:0 12px 28px rgba(14,42,46,.25);z-index:60;}
.omnilist button{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;padding:9px 11px;border:0;background:none;color:var(--ink);font-size:13.5px;}
.omnilist button:hover{background:var(--bg);}
.omnilist b{min-width:44px;}
.omnilist .sub{margin-left:auto;}

.nav{background:var(--mast2);border-top:1px solid #23494E;}
.nav-in{display:flex;align-items:center;gap:2px;overflow-x:auto;}
.nav button{background:none;border:0;color:#BFD3D3;padding:11px 14px;font-size:14px;font-weight:500;border-bottom:3px solid transparent;white-space:nowrap;}
.nav button:hover{color:#fff;}
.nav button.on{color:#fff;border-bottom-color:#2FB3A3;}
.dateline{margin-left:auto;font-size:12.5px;color:#8FAEAF;white-space:nowrap;padding-left:16px;}

/* ticker strip */
.strip{background:var(--paper);color:var(--ink);border-bottom:1px solid var(--rule);overflow:hidden;position:relative;}
.strip-track{display:flex;width:max-content;animation:tape 70s linear infinite;}
.strip:hover .strip-track,.strip:focus-within .strip-track{animation-play-state:paused;}
.strip-half{display:flex;}
@keyframes tape{from{transform:translateX(0)}to{transform:translateX(-50%)}}
.tk{display:flex;align-items:baseline;gap:8px;background:none;border:0;border-right:1px solid var(--rule2);padding:9px 18px;white-space:nowrap;font-size:13.5px;}
.tk:hover{background:var(--bg);}
.tk b{font-weight:700;font-size:13.5px;letter-spacing:.01em;}
.tk-px{font-variant-numeric:tabular-nums;}
.samplebar{background:#FBF1DF;color:#7A4E08;font-size:12.5px;padding:6px 20px;text-align:center;}

/* change */
.chg{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap;}
.chg.up{color:var(--up);}
.chg.down{color:var(--down);}
.chg.flat{color:var(--mut);}
.arw{font-size:.72em;margin-right:3px;position:relative;top:-1px;}

/* layout */
.main{max-width:1280px;margin:0 auto;padding:22px 20px 40px;}
.stack{display:flex;flex-direction:column;gap:18px;}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;}
.front-wrap{display:flex;flex-direction:column;gap:22px;}
.front{display:grid;grid-template-columns:minmax(0,1fr) 290px 330px;gap:0;background:var(--paper);border:1px solid var(--rule);}
.front>section,.front>aside{padding:20px 22px 22px;}
.front>.wire,.front>.side{border-left:1px solid var(--rule2);}
.colhead{font-family:var(--sans);font-size:15px;font-weight:700;margin:0 0 4px;padding-bottom:9px;border-bottom:1px solid var(--ink);letter-spacing:.005em;line-height:1.2;}
.colnote{font-size:12px;color:var(--mut);margin:8px 0 0;}

/* lead story */
.kicker{background:none;border:0;padding:0;font-size:13px;font-weight:600;color:var(--teal) !important;display:inline-flex;gap:6px;align-items:baseline;}
.kicker:hover{text-decoration:underline;}
.kicker-t{font-weight:500;color:var(--mut);}
.lead-h{font-family:var(--display);font-size:clamp(32px,3.6vw,46px);line-height:1.06;font-weight:700;font-stretch:88%;letter-spacing:-.015em;margin:8px 0 12px;max-width:20ch;}
.lead-h button,.brief h2 button{background:none;border:0;padding:0;font:inherit;text-align:left;letter-spacing:inherit;}
.lead-h button:hover,.brief h2 button:hover{color:var(--teal);}
.lead-dek{font-size:17px;line-height:1.55;color:var(--ink2);margin:0 0 16px;max-width:60ch;}
.lead-chart{border-top:1px solid var(--rule2);padding-top:10px;}
.lead-px{display:flex;gap:10px;align-items:baseline;margin-bottom:4px;}
.lead-px b{font-size:22px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;}
.byline{font-size:12px;color:var(--mut);margin:10px 0 0;}
.briefs{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;margin-top:22px;border-top:1px solid var(--ink);}
.brief{padding:15px 0 16px;border-bottom:1px solid var(--rule2);}
.brief h2{font-size:17px;line-height:1.3;font-weight:650;margin:4px 0 6px;letter-spacing:-.005em;}
.brief p{margin:0;font-size:14px;color:var(--mut);line-height:1.5;}

/* filings wire */
.wire-list{list-style:none;margin:0;padding:0;}
.wire-list li{padding:10px 0;border-bottom:1px solid var(--rule2);}
.wire-list li:last-child{border-bottom:0;}
.wire-meta{display:flex;gap:10px;font-size:12px;color:var(--mut);margin-bottom:3px;}
.wire-t{background:none;border:0;padding:0;font-weight:700;color:var(--teal) !important;font-size:12px;}
.wire-list a,.q-news a{font-size:14.5px;line-height:1.38;font-weight:600;text-decoration:none;}
.wire-list a:hover,.q-news a:hover{color:var(--teal);text-decoration:underline;}

/* side column */
.side{display:flex;flex-direction:column;gap:26px;}
.mtable{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums;}
.mtable th{font-weight:500;font-size:12px;color:var(--mut);text-align:left;padding:0 0 6px 10px;}
.mtable th:first-child,.mtable td:first-child{padding-left:0;}
.mtable th.r,.mtable td.r{text-align:right;}
.mtable td{padding:7px 0 7px 10px;border-top:1px solid var(--rule2);vertical-align:baseline;}
.mtable tbody tr{cursor:pointer;}
.mtable tbody tr:hover{background:var(--bg);}
.mt-t{background:none;border:0;padding:0;font-weight:700;font-size:13.5px;margin-right:6px;}
.mt-n{font-size:12px;color:var(--mut);display:block;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.uplist{list-style:none;margin:0;padding:0;}
.uplist li{display:grid;grid-template-columns:48px 1fr;gap:10px;padding:8px 0;border-top:1px solid var(--rule2);align-items:start;}
.up-d{font-size:11px;color:var(--mut);line-height:1.1;}
.up-d b{display:block;font-size:18px;color:var(--ink);font-weight:600;line-height:1.1;font-variant-numeric:tabular-nums;}
.uplist button{background:none;border:0;padding:0;text-align:left;font-size:13.5px;line-height:1.4;}
.uplist button:hover{color:var(--teal);}
.uplist em{color:var(--mut);font-style:normal;font-size:12px;}
.up-t{font-weight:600;margin-right:6px;}
.morelink{background:none;border:0;padding:6px 0 0;font-size:13px;font-weight:600;color:var(--teal) !important;}
.morelink:hover{text-decoration:underline;}
.wl{list-style:none;margin:0;padding:0;}
.wl li{display:flex;align-items:center;border-top:1px solid var(--rule2);}
.wl-row{flex:1;display:grid;grid-template-columns:50px 1fr auto;gap:8px;background:none;border:0;padding:8px 0;text-align:left;font-size:13px;font-variant-numeric:tabular-nums;}
.wl-row:hover{background:var(--bg);}
.wl-x{background:none;border:0;color:var(--mut);font-size:17px;padding:0 4px 0 10px;}
.wl-x:hover{color:var(--down);}

/* quote page */
.quote{background:var(--paper);border:1px solid var(--rule);padding:20px 22px 22px;}
.q-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
.q-id{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.q-id h1{font-family:var(--display);font-size:clamp(28px,3vw,36px);font-weight:700;font-stretch:90%;margin:0;letter-spacing:-.012em;line-height:1.1;}
.q-tk{font-size:15px;font-weight:600;color:var(--mut);}
.q-area{font-size:13px;color:var(--mut);}
.watchbtn{background:#fff;border:1px solid var(--rule);padding:7px 12px;font-size:13px;font-weight:500;border-radius:2px;}
.watchbtn:hover{border-color:var(--teal);}
.watchbtn.on{background:#E6F2F0;border-color:#9CCAC3;color:var(--teal-d) !important;}
.q-px{display:flex;align-items:baseline;gap:14px;margin:10px 0 16px;flex-wrap:wrap;}
.q-price{font-size:clamp(36px,3.6vw,44px);font-weight:600;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;}
.q-px .chg{font-size:18px;font-weight:600;}
.q-asof{font-size:12.5px;color:var(--mut);}
.q-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:28px;align-items:start;}
.q-key{display:grid;grid-template-columns:auto 1fr;margin:0;font-size:14px;border-top:1px solid var(--ink);font-variant-numeric:tabular-nums;}
.q-key dt,.q-key dd{padding:8px 0;border-bottom:1px solid var(--rule2);margin:0;}
.q-key dt{color:var(--mut);}
.q-key dd{text-align:right;font-weight:500;}
.q-note{font-size:14.5px;color:var(--mut);margin:16px 0 0;max-width:70ch;}
.q-news{margin-top:18px;}
.q-news ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 24px;}
.q-news li{padding:9px 0;border-bottom:1px solid var(--rule2);}
.rbar{display:inline-block;width:150px;vertical-align:middle;}
.rbar-track{display:block;position:relative;height:4px;background:var(--rule);border-radius:2px;margin-top:4px;}
.rbar-dot{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--ink);border:2px solid #fff;}
.rbar-ends{display:flex;justify-content:space-between;font-size:11px;color:var(--mut);margin-top:4px;font-variant-numeric:tabular-nums;font-weight:400;}

/* price chart */
.pchart{width:100%;}
.ranges{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:12px;}
.ranges [role=group]{display:flex;border:1px solid var(--rule);border-radius:2px;overflow:hidden;}
.ranges button{background:#fff;border:0;border-right:1px solid var(--rule);padding:5px 12px;font-size:12.5px;font-weight:500;color:var(--mut) !important;}
.ranges button:last-child{border-right:0;}
.ranges button.on{background:var(--ink);color:#fff !important;}
.ranges .chg{font-size:13px;}
.nochart{display:flex;align-items:center;justify-content:center;min-height:180px;background:var(--bg);color:var(--mut);font-size:13px;text-align:center;padding:20px;}

/* panels (analysis views) */
.panel{background:var(--paper);border:1px solid var(--rule);padding:18px 20px 20px;}
.ph{display:flex;align-items:baseline;gap:14px;margin:0 0 16px;padding-bottom:10px;border-bottom:1px solid var(--rule);flex-wrap:wrap;}
.ph.mt{margin-top:22px;}
.ph h2{font-size:16px;font-weight:700;margin:0;letter-spacing:.005em;line-height:1.2;}
.ph-note{font-size:13px;color:var(--mut);}
.empty{font-size:13.5px;color:var(--mut);padding:12px 0;margin:0;}

/* alerts */
.alist{display:flex;flex-direction:column;gap:14px;}
.alist.tight{gap:8px;}
.arow-head{display:flex;align-items:center;gap:9px;margin-bottom:5px;}
.aname{font-size:13px;color:var(--mut);}
.alert{font-size:13px;padding:6px 10px;border-left:3px solid var(--rule);background:#F6F8F8;line-height:1.45;}
.alert.high{border-left-color:var(--crimson);background:#FBF3F4;}
.alert.med{border-left-color:var(--amber);background:#FBF7EF;}
.alert.low{border-left-color:var(--deep);background:#F2F7F9;}
.tick{font-weight:700;font-size:13px;background:none;color:var(--ink) !important;padding:0;border:0;letter-spacing:.01em;}
button.tick:hover{color:var(--teal) !important;}
.tick.lg{font-size:15px;}
.star{background:none;border:0;color:var(--rule);font-size:16px;line-height:1;padding:2px;}
.star.on,.star:hover{color:var(--amber) !important;}

/* tables */
.tablewrap{overflow-x:auto;}
.grid{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums;}
.grid th{text-align:left;font-weight:500;font-size:12px;color:var(--mut);padding:6px 10px;border-bottom:1px solid var(--rule);white-space:nowrap;cursor:pointer;}
.grid th.r,.grid td.r{text-align:right;}
.grid td{padding:9px 10px;border-bottom:1px solid var(--rule2);vertical-align:top;}
.grid tbody tr:hover{background:#F6F8F8;cursor:pointer;}
.grid.plain tbody tr:hover{background:none;cursor:default;}
.grid.plain th{cursor:default;}
.sortmark{margin-left:4px;color:var(--teal);}
.nm{max-width:200px;}
.bisnum{font-size:14px;font-weight:600;}
.bar100{display:block;width:74px;height:4px;background:var(--rule2);margin-left:auto;margin-top:4px;border-radius:2px;overflow:hidden;}
.bar100 span{display:block;height:100%;}
.grid.compare td.lbl,.grid.compare th.lbl{text-align:left;color:var(--mut);font-size:13px;width:210px;}
.grid.compare select{width:100%;font-family:inherit;font-size:13px;padding:5px 6px;border:1px solid var(--rule);border-radius:2px;background:#fff;}
.grid.compare tbody tr:hover{background:#F6F8F8;cursor:default;}

/* phase track */
.ptrack{display:flex;gap:2px;margin-bottom:4px;}
.pseg{width:16px;height:5px;background:var(--rule2);border-radius:1px;}
.phasechip{color:#fff;font-size:12px;padding:2px 8px;border-radius:2px;white-space:nowrap;}

/* filters */
.filters{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 22px;}
.f{display:grid;gap:5px;font-size:12.5px;color:var(--mut);}
.f.wide{margin-bottom:10px;}
.f input[type=text],.f input:not([type]),.f select{font-family:inherit;font-size:13.5px;padding:7px 9px;border:1px solid var(--rule);border-radius:2px;background:#fff;color:var(--ink);}
.f input[type=range]{accent-color:var(--teal);}

/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--rule);overflow-x:auto;}
.tabs button{background:none;border:0;padding:10px 16px;font-size:14px;color:var(--mut) !important;border-bottom:3px solid transparent;margin-bottom:-1px;white-space:nowrap;font-weight:500;}
.tabs button:hover{color:var(--ink) !important;}
.tabs button.on{color:var(--ink) !important;border-bottom-color:var(--teal);}

/* metrics + trace */
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:16px 22px;}
.metrics.two-up{grid-template-columns:1fr 1fr;}
.metric>span{display:block;font-size:12.5px;color:var(--mut);margin-bottom:2px;}
.metric b{font-size:21px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;}
.tr-wrap{position:relative;display:inline-block;}
.tr-val{font-size:21px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;background:none;border:0;padding:0;color:var(--ink);border-bottom:1px dotted var(--teal);font-variant-numeric:tabular-nums;}
.tr-val.warn{color:var(--amber) !important;border-bottom-color:var(--amber);}
.tr-unit{font-size:13px;font-weight:400;color:var(--mut);}
.tr-pop{position:absolute;top:32px;left:0;width:320px;background:var(--mast);color:#DCE9E9;padding:12px 14px;border-radius:2px;z-index:30;display:grid;gap:8px;box-shadow:0 14px 30px rgba(14,42,46,.3);}
.tr-row{display:block;font-size:12.5px;line-height:1.45;}
.tr-row b{display:block;font-size:11px;color:#7FC2B8;font-weight:500;margin-bottom:1px;}

/* facts */
.facts{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;margin:0;font-size:13.5px;}
.facts dt{color:var(--mut);font-size:13px;}
.facts dd{margin:0;}
.facts.small{font-size:13px;margin-top:10px;gap:5px 16px;}
.facts .strong{font-weight:600;color:var(--teal);}

/* programs */
.prog-list{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.prog{border:1px solid var(--rule2);padding:14px 15px;}
.prog-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;}
.prog h3{margin:0;font-size:16px;font-weight:700;}
.prog-ind{font-size:13px;color:var(--mut);margin-top:2px;}

/* timeline */
.timeline{display:flex;flex-direction:column;}
.tl{display:grid;grid-template-columns:12px 120px 1fr auto;gap:12px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--rule2);}
.tl.past{opacity:.5;}
.tl-dot{width:8px;height:8px;border-radius:50%;align-self:center;}
.tl-date{font-size:13px;color:var(--mut);}
.tl-label{font-size:14px;}
.tl-days{font-size:13px;}

/* calendar */
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.chip{font-size:12.5px;padding:5px 12px;border:1px solid var(--rule);background:#fff;border-radius:99px;color:var(--mut) !important;}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff !important;}
.month{margin-bottom:20px;}
.monthhead{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--sans);font-size:15px;font-weight:700;margin:0 0 4px;padding-bottom:5px;border-bottom:1px solid var(--rule);}
.monthhead .mono{font-family:var(--sans);font-size:12.5px;color:var(--mut);font-weight:400;}
.evrow{display:grid;grid-template-columns:72px 8px auto 1fr auto auto;gap:12px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--rule2);padding:9px 2px;}
.evrow:hover{background:#F6F8F8;}
.evrow.past{opacity:.48;}
.ev-date{font-size:12.5px;color:var(--mut);}
.ev-kind{width:8px;height:8px;border-radius:50%;}
.ev-label{font-size:14px;}
.ev-run{font-size:12.5px;color:var(--mut);}
.ev-days{font-size:13px;}

/* score */
.scorewrap{display:grid;grid-template-columns:150px 1fr;gap:28px;align-items:center;}
.bigscore{text-align:center;}
.bigscore span{font-size:56px;font-weight:600;line-height:1;letter-spacing:-.03em;font-variant-numeric:tabular-nums;}
.bigscore small{display:block;font-size:12.5px;color:var(--mut);margin-top:4px;}
.scorelist{display:grid;gap:12px;}
.scorerow{display:grid;grid-template-columns:200px 1fr 34px;gap:14px;align-items:center;}
.sl{font-size:13.5px;}
.sl em{display:block;font-style:normal;font-size:12px;color:var(--mut);}
.scorerow .bar100{width:100%;height:7px;margin:0;}
.sv{font-size:13.5px;text-align:right;}

/* ask */
.sugg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
.sugg button{text-align:left;font-size:13.5px;padding:11px 13px;background:#F6F8F8;border:1px solid var(--rule2);border-radius:2px;}
.sugg button:hover{background:#fff;border-color:var(--teal);}
.log{display:flex;flex-direction:column;gap:14px;margin-bottom:14px;}
.msg.user .msg-body{background:var(--mast);color:#fff;padding:9px 12px;border-radius:2px;display:inline-block;font-size:14px;max-width:70ch;}
.msg.ai .msg-body{background:#F6F8F8;border-left:3px solid var(--teal);padding:12px 15px;font-size:14px;white-space:pre-wrap;max-width:78ch;line-height:1.55;}
.msg-tag{display:block;font-size:12px;color:var(--mut);margin-bottom:4px;}
.msg-body.dim{color:var(--mut);}
.askbar{display:flex;gap:8px;}
.askbar input{flex:1;font-family:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--rule);border-radius:2px;}
.askbar button{background:var(--teal);color:#fff !important;border:0;border-radius:2px;padding:10px 22px;font-size:14px;font-weight:500;}
.askbar button:disabled{background:var(--rule);}

.chart{margin-top:4px;}
.rtip{background:var(--mast);color:#E8F0F0;font-size:12.5px;padding:7px 10px;border-radius:2px;line-height:1.45;font-variant-numeric:tabular-nums;}

/* footer */
.foot{border-top:1px solid var(--rule);background:var(--paper);margin-top:12px;}
.foot-in{display:flex;gap:24px;align-items:flex-start;padding-top:20px;padding-bottom:28px;}
.foot p{margin:0;font-size:12.5px;color:var(--mut);max-width:100ch;line-height:1.55;}


/* financing pressure */
.fps{display:inline-flex;align-items:baseline;gap:6px;padding:2px 8px 2px 7px;border-radius:3px;border:1px solid;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.35;}
.fps b{font-weight:700;font-size:13.5px;}
.fps span{font-size:12px;font-weight:600;}
.fps-high{background:#FBEFF2;border-color:#E7B9C5;color:#8A1C37;}
.fps-elevated{background:#FCF4E6;border-color:#EBCF9C;color:#7A4E08;}
.fps-low{background:#EAF4F2;border-color:#B5D9D3;color:#0C5652;}
.fps.lg{padding:6px 12px;gap:10px;}
.fps.lg b{font-size:34px;letter-spacing:-.02em;line-height:1;}
.fps.lg span{font-size:15px;}
.linkish{background:none;border:0;padding:0;cursor:pointer;}
.fps-head{display:flex;gap:18px;align-items:center;margin:0 0 18px;}
.fps-head p{margin:0;font-size:15px;max-width:70ch;}
.subhead{font-size:14px;font-weight:700;margin:20px 0 8px;}
.sub-c{color:var(--mut);font-size:13px;}
.grid.plain tr.dim td{color:#9AA6AD;}
.grid.plain tr.total td{font-weight:700;border-top:1px solid var(--ink);border-bottom:0;}
.grid td.neg{color:var(--crimson);}
.watch{margin:0;padding-left:18px;display:grid;gap:7px;font-size:14px;}
.raiselist ul{list-style:none;margin:0;padding:0;}
.raiselist li button{display:grid;grid-template-columns:52px 1fr auto;gap:10px;align-items:center;width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--rule2);padding:9px 0;}
.raiselist li button:hover{background:var(--bg);}
.rl-h{font-size:16px;font-weight:700;margin:0 0 4px;}
.rl-note{font-size:13px;color:var(--mut);margin:0 0 10px;}
.rl-empty{font-size:14px;margin:0 0 6px;padding:10px 12px;background:#F6F8F8;border-left:3px solid var(--teal);}
.rl-sub{font-size:13px;font-weight:600;color:var(--mut);margin:14px 0 4px;}
.rl-t{font-weight:700;}
.rl-n{font-size:13.5px;}
.rl-n em{display:block;font-style:normal;font-size:12px;color:var(--mut);}
.mini-fps{list-style:none;margin:0;padding:0;}
.mini-fps button{display:grid;grid-template-columns:50px 1fr auto;gap:8px;align-items:center;width:100%;background:none;border:0;border-top:1px solid var(--rule2);padding:7px 0;text-align:left;font-size:13px;}
.mini-fps button:hover{background:var(--bg);}
.mini-fps span{color:var(--mut);}
.two.wide-left{grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);}

/* identity bar */
.idbar{display:flex;justify-content:space-between;align-items:center;gap:24px;background:var(--paper);border:1px solid var(--rule);border-left:4px solid var(--teal);padding:18px 22px;}
.id-line{font-family:var(--display);font-size:clamp(22px,2.3vw,29px);font-weight:700;font-stretch:90%;letter-spacing:-.012em;line-height:1.15;margin:0;}
.id-sub{margin:6px 0 0;color:var(--mut);font-size:14.5px;}
.id-ctas{display:flex;gap:10px;flex-wrap:wrap;flex:none;}
.btn{background:#fff;border:1px solid var(--rule);border-radius:2px;padding:9px 14px;font-size:14px;font-weight:600;white-space:nowrap;}
.btn:hover{border-color:var(--teal);}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff !important;}
.btn.primary:hover{background:var(--teal-d);}

/* report + methodology */
.report-head{padding:24px 26px;}
.kicker-static{font-size:13px;font-weight:600;color:var(--teal);margin:0 0 6px;}
.report-h{font-family:var(--display);font-size:clamp(28px,3.2vw,40px);font-weight:700;font-stretch:90%;letter-spacing:-.015em;line-height:1.08;margin:0 0 12px;max-width:26ch;}
.section-h{font-size:18px;font-weight:700;margin:8px 0 -4px;}
.disclaimer{font-size:12.5px;color:var(--mut);margin:0;max-width:100ch;}
.prose{font-size:15px;max-width:72ch;margin:0 0 14px;}
.pillars{display:grid;grid-template-columns:repeat(4,1fr);gap:0;background:var(--paper);border:1px solid var(--rule);}
.pillar{padding:18px 20px;border-left:1px solid var(--rule2);}
.pillar:first-child{border-left:0;}
.pillar h3{font-size:15px;font-weight:700;margin:0 0 6px;}
.pillar p{margin:0 0 10px;font-size:14.5px;}
.pillar span{font-size:12.5px;color:var(--mut);}
.bands{display:flex;gap:10px;margin:14px 0 4px;flex-wrap:wrap;}
.facts.defs{grid-template-columns:170px 1fr;gap:10px 18px;font-size:14px;}
.facts.defs dd{max-width:80ch;}
.tr-list{margin:12px 0 0;padding-left:18px;font-size:14px;display:grid;gap:5px;}
.trace td:first-child{white-space:nowrap;}

/* waitlist */
.waitlist{background:var(--paper);border:1px solid var(--rule);border-top:3px solid var(--teal);padding:18px 20px;}
.waitlist h3{font-size:16px;font-weight:700;margin:0 0 4px;}
.waitlist p{margin:0 0 12px;font-size:14px;color:var(--ink2);}
.wl-fields{display:flex;gap:8px;flex-wrap:wrap;}
.wl-fields input,.wl-fields select{font:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--rule);border-radius:2px;background:#fff;color:var(--ink);}
.wl-fields input{flex:1 1 220px;}
.wl-fields button{background:var(--teal);color:#fff !important;border:0;border-radius:2px;padding:9px 18px;font-size:14px;font-weight:600;}
.wl-fields button:disabled{opacity:.6;}
.wl-fine{font-size:12px !important;color:var(--mut) !important;margin:8px 0 0 !important;}
.wl-err{color:var(--crimson) !important;margin:8px 0 0 !important;}
.wl-done{font-weight:600;margin:0 !important;}
.waitlist.compact{border:0;border-top:1px solid var(--ink);padding:10px 0 0;background:none;}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
@media (max-width:1180px){
  .pillars{grid-template-columns:1fr 1fr;}
  .pillar:nth-child(3){border-left:0;}
  .front{grid-template-columns:minmax(0,1fr) 300px;}
  .front>.side{grid-column:1/-1;border-left:0;border-top:1px solid var(--rule2);display:grid;grid-template-columns:repeat(3,1fr);gap:26px;}
}
@media (max-width:860px){
  .idbar{flex-direction:column;align-items:flex-start;}
  .two.wide-left,.pillars{grid-template-columns:1fr;}
  .pillar{border-left:0;border-top:1px solid var(--rule2);}
  .pillar:first-child{border-top:0;}
  .fps-head{flex-direction:column;align-items:flex-start;}
  .facts.defs{grid-template-columns:1fr;}
  .front{grid-template-columns:1fr;}
  .front>.wire{border-left:0;border-top:1px solid var(--rule2);}
  .front>.side{grid-template-columns:1fr;}
  .briefs,.two,.filters,.prog-list,.metrics,.sugg,.q-body{grid-template-columns:1fr;}
  .mast-tag,.dateline{display:none;}
  .mast-in{gap:12px;}
  .wordmark{font-size:32px;}
  .omni{width:auto;flex:1;}
  .front>section,.front>aside,.quote,.panel{padding-left:16px;padding-right:16px;}
  .main{padding:16px 12px 32px;}
  .q-price{font-size:34px;}
  .scorewrap{grid-template-columns:1fr;}
  .scorerow{grid-template-columns:130px 1fr 30px;}
  .evrow{grid-template-columns:60px 8px auto 1fr;}
  .ev-run,.ev-days{display:none;}
  .tl{grid-template-columns:12px 92px 1fr;}
  .tl-days{display:none;}
  .foot-in{flex-direction:column;}
}
@media (prefers-reduced-motion:reduce){
  .strip{overflow-x:auto;}
  .strip-track{animation:none;}
  .strip-half[aria-hidden]{display:none;}
  .app *{transition:none !important;}
}
`;
