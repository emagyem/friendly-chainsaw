import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, ReferenceLine, BarChart, Bar, Cell
} from "recharts";

/* ------------------------------------------------------------------
   READOUT — biotech intelligence terminal (MVP)
   Sample data only. Companies and figures are fictional.
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

const C = (t, n, area, mcap, ev, cash, debt, burn, rev, shares, own, emp, partners, patentYrs, diff, mkt, pipeline, catalysts, financings, note) =>
  ({ t, n, area, mcap, ev, cash, debt, burn, rev, shares, own, emp, partners, patentYrs, diff, mkt, pipeline, catalysts, financings, note });

const COMPANIES = [
  C("NVRA", "Novara Therapeutics", "Oncology", 1240, 880, 412, 30, 21.5, 0, 74.2, 61, 640, ["Takeda-style regional partner"], 11, 0.8, 0.85,
    [
      { d: "NVR-214", ind: "2L metastatic colorectal cancer", tgt: "KRAS G12D", moa: "Covalent inhibitor", ph: "Phase III", n: 612, ro: "2026-11-18", ep: "Progression-free survival", peak: 1400, launch: 2.5, cost: 240 },
      { d: "NVR-330", ind: "Pancreatic adenocarcinoma", tgt: "KRAS G12D", moa: "Covalent inhibitor", ph: "Phase II", n: 180, ro: "2027-04-02", ep: "Objective response rate", peak: 750, launch: 4.5, cost: 150 },
      { d: "NVR-402", ind: "Solid tumors, basket", tgt: "SOS1", moa: "Allosteric modulator", ph: "Phase I", n: 48, ro: "2027-06-15", ep: "Safety, MTD", peak: 400, launch: 7, cost: 95 },
    ],
    [
      { date: "2026-11-18", kind: "readout", label: "NVR-214 Phase III interim PFS", drug: "NVR-214" },
      { date: "2026-10-29", kind: "earnings", label: "Q3 results", drug: null },
      { date: "2027-04-02", kind: "readout", label: "NVR-330 Phase II ORR", drug: "NVR-330" },
    ],
    [{ date: "2025-03-11", type: "Follow-on offering", amt: 230, dil: 12.4 }, { date: "2024-06-02", type: "ATM program", amt: 75, dil: 5.1 }],
    "Lead program is the entire equity story; interim look lands before year-end."),

  C("CRLX", "Cerelix Bio", "Neurology", 486, 300, 198, 12, 9.4, 0, 44.8, 38, 310, [], 13, 0.7, 0.6,
    [
      { d: "CRX-101", ind: "Focal onset seizures", tgt: "Kv7.2/7.3", moa: "Potassium channel opener", ph: "Phase II", n: 240, ro: "2027-01-22", ep: "Seizure frequency reduction", peak: 900, launch: 4, cost: 175 },
      { d: "CRX-118", ind: "Essential tremor", tgt: "Kv7.2/7.3", moa: "Potassium channel opener", ph: "Phase I", n: 60, ro: "2026-12-09", ep: "Safety, PK", peak: 520, launch: 6.5, cost: 80 },
    ],
    [
      { date: "2026-12-09", kind: "readout", label: "CRX-118 Phase I safety and PK", drug: "CRX-118" },
      { date: "2027-01-22", kind: "readout", label: "CRX-101 Phase II topline", drug: "CRX-101" },
    ],
    [{ date: "2025-09-30", type: "Private placement", amt: 120, dil: 18.9 }],
    "Two shots on goal from one channel; both readouts inside five months."),

  C("ATLM", "Atlomen Sciences", "Rare disease", 2180, 1790, 520, 130, 26.0, 18.5, 58.9, 71, 780, ["Regional commercialization partner, EU"], 14, 0.9, 0.7,
    [
      { d: "ATL-Gx1", ind: "Fabry disease", tgt: "GLA", moa: "AAV gene therapy", ph: "Filed", n: 66, ro: "2027-02-14", ep: "PDUFA decision", peak: 1100, launch: 0.6, cost: 60 },
      { d: "ATL-Gx4", ind: "Pompe disease", tgt: "GAA", moa: "AAV gene therapy", ph: "Phase III", n: 132, ro: "2027-08-20", ep: "6-minute walk distance", peak: 860, launch: 2.8, cost: 210 },
      { d: "ATL-207", ind: "Hereditary angioedema", tgt: "Kallikrein", moa: "Base editing", ph: "Phase I", n: 24, ro: "2027-05-11", ep: "Attack rate", peak: 640, launch: 6, cost: 120 },
    ],
    [
      { date: "2027-02-14", kind: "regulatory", label: "ATL-Gx1 PDUFA target action date", drug: "ATL-Gx1" },
      { date: "2026-09-25", kind: "conference", label: "Rare disease investor day", drug: null },
      { date: "2027-08-20", kind: "readout", label: "ATL-Gx4 Phase III topline", drug: "ATL-Gx4" },
    ],
    [{ date: "2026-01-20", type: "Convertible notes", amt: 300, dil: 0 }, { date: "2024-11-05", type: "Follow-on offering", amt: 260, dil: 9.8 }],
    "First approval decision converts the company from clinical to commercial."),

  C("VYNT", "Vyantis Pharma", "Immunology", 740, 610, 142, 0, 13.8, 0, 44, 52, 265, [], 9, 0.5, 0.75,
    [
      { d: "VYN-8", ind: "Ulcerative colitis", tgt: "TL1A", moa: "Monoclonal antibody", ph: "Phase II", n: 310, ro: "2026-10-07", ep: "Clinical remission at wk 12", peak: 1600, launch: 4.2, cost: 260 },
      { d: "VYN-15", ind: "Atopic dermatitis", tgt: "OX40L", moa: "Monoclonal antibody", ph: "Phase I", n: 72, ro: "2027-03-30", ep: "EASI-75", peak: 980, launch: 6.5, cost: 130 },
    ],
    [
      { date: "2026-10-07", kind: "readout", label: "VYN-8 Phase II induction data", drug: "VYN-8" },
      { date: "2026-11-12", kind: "earnings", label: "Q3 results", drug: null },
    ],
    [{ date: "2025-05-14", type: "Follow-on offering", amt: 165, dil: 15.2 }],
    "Crowded target, narrow runway. Readout and financing need are close together."),

  C("HLXR", "Helixar Therapeutics", "Cell therapy", 395, 210, 121, 8, 11.2, 4.4, 36.0, 29, 240, ["Manufacturing alliance"], 10, 0.6, 0.55,
    [
      { d: "HLX-CAR7", ind: "Relapsed multiple myeloma", tgt: "GPRC5D", moa: "Autologous CAR-T", ph: "Phase II", n: 96, ro: "2027-02-27", ep: "Overall response rate", peak: 700, launch: 3.8, cost: 195 },
      { d: "HLX-NK2", ind: "AML, post-transplant", tgt: "CD33", moa: "Allogeneic NK", ph: "Phase I", n: 36, ro: "2026-12-18", ep: "Safety, expansion", peak: 430, launch: 6.2, cost: 105 },
    ],
    [
      { date: "2026-12-18", kind: "readout", label: "HLX-NK2 dose escalation update", drug: "HLX-NK2" },
      { date: "2026-10-16", kind: "financing", label: "ATM capacity refresh filed", drug: null },
    ],
    [{ date: "2026-04-08", type: "ATM program", amt: 60, dil: 14.1 }, { date: "2024-09-19", type: "Private placement", amt: 95, dil: 21.0 }],
    "Under 12 months of cash with an ATM already open. Assume dilution."),

  C("PMBR", "Pembra Biosciences", "Metabolic", 3120, 2740, 690, 210, 32.5, 41.2, 96, 64, 820, ["Global obesity co-development"], 12, 0.8, 0.95,
    [
      { d: "PMB-40", ind: "Obesity", tgt: "GLP-1/GIP", moa: "Oral small molecule", ph: "Phase III", n: 1480, ro: "2027-05-28", ep: "Percent weight loss at wk 68", peak: 3200, launch: 2.4, cost: 640 },
      { d: "PMB-52", ind: "MASH with fibrosis", tgt: "FGF21", moa: "Fc fusion", ph: "Phase II", n: 220, ro: "2026-11-05", ep: "Fibrosis improvement", peak: 1250, launch: 4.4, cost: 230 },
    ],
    [
      { date: "2026-11-05", kind: "readout", label: "PMB-52 Phase IIb biopsy data", drug: "PMB-52" },
      { date: "2027-05-28", kind: "readout", label: "PMB-40 Phase III topline", drug: "PMB-40" },
      { date: "2026-10-22", kind: "earnings", label: "Q3 results", drug: null },
    ],
    [{ date: "2026-02-26", type: "Follow-on offering", amt: 450, dil: 8.2 }],
    "Largest market opportunity in the sample universe, priced accordingly."),

  C("ORNS", "Orionis Medicines", "Oncology", 168, 96, 74, 0, 6.8, 0, 22.5, 19, 120, [], 8, 0.7, 0.5,
    [
      { d: "ORN-11", ind: "HR+/HER2- breast cancer", tgt: "CDK2", moa: "Selective inhibitor", ph: "Phase II", n: 128, ro: "2027-03-12", ep: "Objective response rate", peak: 620, launch: 4.6, cost: 145 },
      { d: "ORN-24", ind: "Small cell lung cancer", tgt: "DLL3", moa: "T-cell engager", ph: "Phase I", n: 40, ro: "2027-07-08", ep: "Safety, RP2D", peak: 510, launch: 7, cost: 100 },
    ],
    [
      { date: "2027-03-12", kind: "readout", label: "ORN-11 Phase II expansion data", drug: "ORN-11" },
    ],
    [{ date: "2025-11-13", type: "Registered direct", amt: 48, dil: 24.6 }],
    "Micro-cap with credible data but a balance sheet that forces a raise."),

  C("KTVA", "Kestrava Bio", "Infectious disease", 912, 705, 260, 55, 12.0, 34.5, 51.0, 66, 330, ["Government procurement agreement"], 12, 0.6, 0.65,
    [
      { d: "KTV-3", ind: "Multidrug-resistant gram-negative infection", tgt: "PBP3", moa: "Beta-lactamase inhibitor combo", ph: "Phase III", n: 420, ro: "2027-01-15", ep: "Clinical cure at test-of-cure", peak: 540, launch: 2.2, cost: 180 },
      { d: "KTV-9", ind: "RSV in older adults", tgt: "F protein", moa: "Prefusion vaccine", ph: "Phase II", n: 900, ro: "2027-06-04", ep: "Immunogenicity", peak: 1150, launch: 4.1, cost: 300 },
    ],
    [
      { date: "2027-01-15", kind: "readout", label: "KTV-3 Phase III topline", drug: "KTV-3" },
      { date: "2026-09-30", kind: "regulatory", label: "End-of-Phase-II meeting, KTV-9", drug: "KTV-9" },
    ],
    [{ date: "2025-07-22", type: "Term loan", amt: 55, dil: 0 }],
    "Revenue from procurement contracts softens the burn relative to peers."),

  C("SYNQ", "Synquell Therapeutics", "Ophthalmology", 254, 150, 104, 0, 7.6, 0, 31.0, 24, 145, [], 10, 0.8, 0.45,
    [
      { d: "SYN-6", ind: "Geographic atrophy", tgt: "Complement C3", moa: "Intravitreal implant", ph: "Phase II", n: 156, ro: "2026-12-03", ep: "Lesion growth rate", peak: 820, launch: 4.3, cost: 165 },
    ],
    [
      { date: "2026-12-03", kind: "readout", label: "SYN-6 Phase II 12-month lesion data", drug: "SYN-6" },
      { date: "2026-11-06", kind: "earnings", label: "Q3 results", drug: null },
    ],
    [{ date: "2026-03-05", type: "Follow-on offering", amt: 85, dil: 19.4 }],
    "Single-asset company. The December readout is binary for the equity."),

  C("DRVN", "Daravin Labs", "Cardiometabolic", 1410, 1120, 336, 45, 16.4, 8.0, 63.0, 58, 390, ["Cardiology device co-promote"], 11, 0.5, 0.8,
    [
      { d: "DRV-77", ind: "Hypertrophic cardiomyopathy", tgt: "Cardiac myosin", moa: "Allosteric inhibitor", ph: "Phase III", n: 380, ro: "2027-04-21", ep: "Peak VO2 change", peak: 1050, launch: 2.6, cost: 260 },
      { d: "DRV-91", ind: "Lp(a)-driven ASCVD", tgt: "Lp(a)", moa: "siRNA", ph: "Phase II", n: 300, ro: "2027-09-10", ep: "Lp(a) reduction", peak: 1450, launch: 4.8, cost: 290 },
    ],
    [
      { date: "2027-04-21", kind: "readout", label: "DRV-77 Phase III topline", drug: "DRV-77" },
      { date: "2026-10-30", kind: "earnings", label: "Q3 results", drug: null },
    ],
    [{ date: "2025-12-09", type: "Follow-on offering", amt: 310, dil: 10.6 }],
    "Well capitalized into its pivotal readout; little near-term financing pressure."),

  C("LUMV", "Lumeva Bio", "Respiratory", 318, 205, 88, 10, 8.9, 0, 27.5, 21, 160, [], 9, 0.4, 0.5,
    [
      { d: "LMV-2", ind: "Chronic cough", tgt: "P2X3", moa: "Antagonist", ph: "Phase II", n: 260, ro: "2027-02-05", ep: "24-hour cough frequency", peak: 700, launch: 4.4, cost: 160 },
      { d: "LMV-14", ind: "Severe asthma", tgt: "TSLP", moa: "Inhaled antibody fragment", ph: "Preclinical", n: 0, ro: "2027-10-01", ep: "IND enabling", peak: 890, launch: 8, cost: 140 },
    ],
    [
      { date: "2027-02-05", kind: "readout", label: "LMV-2 Phase IIb topline", drug: "LMV-2" },
      { date: "2026-10-09", kind: "conference", label: "Respiratory partnering summit", drug: null },
    ],
    [{ date: "2026-06-18", type: "ATM program", amt: 40, dil: 13.7 }],
    "Me-too mechanism in a class where two competitors already failed."),

  C("AXBN", "Axabion Therapeutics", "Autoimmune", 665, 430, 235, 0, 14.6, 0, 47.5, 53, 290, ["Academic discovery alliance"], 13, 0.9, 0.7,
    [
      { d: "AXB-5", ind: "Systemic lupus erythematosus", tgt: "CD19", moa: "Autologous CAR-T", ph: "Phase II", n: 84, ro: "2027-03-19", ep: "Drug-free remission at 12 mo", peak: 1350, launch: 4.1, cost: 240 },
      { d: "AXB-12", ind: "Myasthenia gravis", tgt: "FcRn", moa: "Subcutaneous antibody", ph: "Phase I", n: 54, ro: "2026-11-27", ep: "IgG reduction", peak: 760, launch: 6, cost: 115 },
    ],
    [
      { date: "2026-11-27", kind: "readout", label: "AXB-12 Phase I PD data", drug: "AXB-12" },
      { date: "2027-03-19", kind: "readout", label: "AXB-5 Phase II remission data", drug: "AXB-5" },
    ],
    [{ date: "2026-05-07", type: "Private placement", amt: 180, dil: 16.3 }],
    "Differentiated mechanism in autoimmune, where cell therapy data has moved fast."),
];

/* ---------------------------- calculations ---------------------------- */

const TODAY = new Date();
const days = (iso) => Math.round((new Date(iso + "T00:00:00") - TODAY) / 86400000);
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const money = (m) => (m >= 1000 ? `$${(m / 1000).toFixed(2)}B` : `$${Math.round(m)}M`);
const num = (n, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function runway(c) { return c.cash / c.burn; }

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

function nextCatalyst(c) {
  const up = c.catalysts.filter((x) => days(x.date) >= 0).sort((a, b) => days(a.date) - days(b.date));
  return up[0] || null;
}

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
  if (nc && days(nc.date) <= 45) out.push({ sev: "high", text: `${nc.label} in ${days(nc.date)} days.` });
  else if (nc && days(nc.date) <= 120) out.push({ sev: "low", text: `${nc.label} in ${days(nc.date)} days.` });
  const atm = c.financings.find((f) => f.type === "ATM program" && days(f.date) > -540);
  if (atm) out.push({ sev: "med", text: `ATM program open since ${fmtDate(atm.date)}. Dilution can arrive without an announcement.` });
  const dil = c.financings.reduce((s, f) => s + f.dil, 0);
  if (dil > 25) out.push({ sev: "med", text: `Share count up roughly ${num(dil, 0)}% across the last two financings.` });
  const evpv = c.ev / Math.max(pipelineValue(c), 1);
  if (evpv < 0.8) out.push({ sev: "low", text: `Enterprise value is ${num((1 - evpv) * 100, 0)}% below the modeled risk-adjusted pipeline value. Check the peak sales assumption before reading that as cheap.` });
  return out;
}

/* ------------------------------ trace UI ------------------------------ */

function Trace({ value, unit, source, calc, reading, tone }) {
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
          <span className="tr-row"><b>From</b>{source}</span>
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

function Scan({ go, watch, toggleWatch }) {
  const tape = useMemo(() => {
    const all = [];
    COMPANIES.forEach((c) => c.catalysts.forEach((x) => { if (days(x.date) >= 0 && days(x.date) <= 120) all.push({ ...x, c }); }));
    return all.sort((a, b) => days(a.date) - days(b.date));
  }, []);

  const flagged = useMemo(() =>
    COMPANIES.map((c) => ({ c, a: alertsFor(c) }))
      .filter((x) => x.a.some((y) => y.sev === "high"))
      .sort((a, b) => runway(a.c) - runway(b.c)), []);

  const scatter = COMPANIES.map((c) => {
    const nc = nextCatalyst(c);
    return { x: nc ? days(nc.date) : 400, y: Math.min(runway(c), 40), z: Math.sqrt(c.mcap), t: c.t, name: c.n };
  });

  return (
    <div className="stack">
      <section className="hero">
        <div className="hero-left">
          <div className="hero-q">Which biotechs deserve attention today?</div>
          <p className="hero-sub">
            {tape.length} dated events across {COMPANIES.length} companies in the next 120 days.
            {" "}{flagged.length} companies carry a financing or timing flag worth reading before anything else.
          </p>
        </div>
        <div className="hero-right">
          <div className="hero-date">{TODAY.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
        </div>
      </section>

      <section className="panel">
        <header className="ph"><h2>Next 120 days</h2><span className="ph-note">Ordered by date. Click through for the full company file.</span></header>
        <div className="tape">
          {tape.map((e, i) => (
            <button key={i} className="tapecard" onClick={() => go("company", e.c.t)}>
              <span className="tape-d" style={{ color: CAT_KIND[e.kind].c }}>{days(e.date)}d</span>
              <span className="tape-t">{e.c.t}</span>
              <span className="tape-l">{e.label}</span>
              <span className="tape-date">{fmtDate(e.date)}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="two">
        <section className="panel">
          <header className="ph"><h2>Needs a decision</h2><span className="ph-note">Rules fire on runway, catalyst timing, and open ATM capacity.</span></header>
          <div className="alist">
            {flagged.map(({ c, a }) => (
              <div key={c.t} className="arow">
                <div className="arow-head">
                  <button className="tick" onClick={() => go("company", c.t)}>{c.t}</button>
                  <span className="aname">{c.n}</span>
                  <button className={"star " + (watch.includes(c.t) ? "on" : "")} onClick={() => toggleWatch(c.t)} title="Add to watchlist">★</button>
                </div>
                {a.map((x, i) => <div key={i} className={"alert " + x.sev}>{x.text}</div>)}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <header className="ph"><h2>Runway against the next catalyst</h2><span className="ph-note">Lower left is the pressure zone: a near-term event and less than a year of cash.</span></header>
          <div className="chart">
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 12, right: 16, bottom: 28, left: 4 }}>
                <CartesianGrid stroke="#DCE2E5" />
                <XAxis type="number" dataKey="x" name="Days to next catalyst" domain={[0, 400]}
                  tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }}
                  label={{ value: "days to next catalyst", position: "insideBottom", offset: -14, fontSize: 11, fill: "#5A6B76" }} />
                <YAxis type="number" dataKey="y" name="Runway" domain={[0, 40]}
                  tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }}
                  label={{ value: "months of cash", angle: -90, position: "insideLeft", fontSize: 11, fill: "#5A6B76" }} />
                <ZAxis dataKey="z" range={[60, 420]} />
                <ReferenceLine y={12} stroke="#B8730F" strokeDasharray="4 3" />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ payload }) => {
                  if (!payload || !payload.length) return null;
                  const d = payload[0].payload;
                  return <div className="rtip"><b>{d.t}</b> {d.name}<br />{num(d.y)} months of cash · next event in {d.x} days</div>;
                }} />
                <Scatter data={scatter} fill="#12706B" fillOpacity={0.72} onClick={(d) => go("company", d.t)} />
              </ScatterChart>
            </ResponsiveContainer>
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
  const [maxCap, setMaxCap] = useState(4000);
  const [minRun, setMinRun] = useState(0);
  const [within, setWithin] = useState(365);
  const [sort, setSort] = useState("bis");
  const [dir, setDir] = useState(-1);

  const areas = ["All", ...Array.from(new Set(COMPANIES.map((c) => c.area)))];

  const rows = useMemo(() => {
    const out = COMPANIES.filter((c) => {
      if (q && !(c.t + " " + c.n + " " + c.pipeline.map((p) => p.d + p.ind + p.tgt).join(" ")).toLowerCase().includes(q.toLowerCase())) return false;
      if (area !== "All" && c.area !== area) return false;
      if (!c.pipeline.some((p) => phaseRank(p.ph) >= phaseRank(minPhase))) return false;
      if (c.mcap > maxCap) return false;
      if (runway(c) < minRun) return false;
      const nc = nextCatalyst(c);
      if (!nc || days(nc.date) > within) return false;
      return true;
    }).map((c) => {
      const nc = nextCatalyst(c);
      return { c, bis: bis(c), run: runway(c), nd: nc ? days(nc.date) : 9999, nc, pv: pipelineValue(c) };
    });
    const key = { bis: (r) => r.bis, run: (r) => r.run, cap: (r) => r.c.mcap, cash: (r) => r.c.cash, next: (r) => -r.nd, pv: (r) => r.pv, ticker: (r) => r.c.t };
    return out.sort((a, b) => {
      const A = key[sort](a), B = key[sort](b);
      return (typeof A === "string" ? A.localeCompare(B) : A - B) * dir;
    });
  }, [q, area, minPhase, maxCap, minRun, within, sort, dir]);

  const th = (k, label, align) => (
    <th className={align} onClick={() => { if (sort === k) setDir(-dir); else { setSort(k); setDir(-1); } }}>
      {label}<span className="sortmark">{sort === k ? (dir === -1 ? "▾" : "▴") : ""}</span>
    </th>
  );

  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Screen the universe</h2><span className="ph-note">Every filter maps to a question an analyst already asks out loud.</span></header>
        <div className="filters">
          <label className="f"><span>Company, drug, or target</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="KRAS, obesity, NVRA" /></label>
          <label className="f"><span>Therapeutic area</span>
            <select value={area} onChange={(e) => setArea(e.target.value)}>{areas.map((a) => <option key={a}>{a}</option>)}</select></label>
          <label className="f"><span>Most advanced program at least</span>
            <select value={minPhase} onChange={(e) => setMinPhase(e.target.value)}>{PHASES.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="f"><span>Market cap at or below {money(maxCap)}</span>
            <input type="range" min="100" max="4000" step="50" value={maxCap} onChange={(e) => setMaxCap(+e.target.value)} /></label>
          <label className="f"><span>Runway of at least {minRun} months</span>
            <input type="range" min="0" max="36" value={minRun} onChange={(e) => setMinRun(+e.target.value)} /></label>
          <label className="f"><span>Next catalyst within {within} days</span>
            <input type="range" min="30" max="365" step="15" value={within} onChange={(e) => setWithin(+e.target.value)} /></label>
        </div>
      </section>

      <section className="panel">
        <header className="ph"><h2>{rows.length} matches</h2>
          <span className="ph-note">Score weights follow the plan: pipeline 25, financial 20, catalyst 15, market 15, valuation 15, strategic 10.</span></header>
        {rows.length === 0 ? (
          <div className="empty">Nothing clears those filters. Widen the market cap ceiling or push the catalyst window out.</div>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <thead><tr>
                {th("ticker", "Ticker")}<th>Company</th><th>Lead program</th>
                {th("cap", "Market cap", "r")}{th("cash", "Cash", "r")}{th("run", "Runway", "r")}
                {th("next", "Next catalyst", "r")}{th("pv", "Pipeline rNPV", "r")}{th("bis", "Score", "r")}
              </tr></thead>
              <tbody>
                {rows.map(({ c, bis: s, run, nd, nc, pv }) => {
                  const lead = [...c.pipeline].sort((a, b) => phaseRank(b.ph) - phaseRank(a.ph))[0];
                  return (
                    <tr key={c.t} onClick={() => go("company", c.t)}>
                      <td><span className="tick">{c.t}</span></td>
                      <td className="nm">{c.n}<span className="sub">{c.area}</span></td>
                      <td><PhaseTrack ph={lead.ph} /><span className="sub">{lead.d} · {lead.ind}</span></td>
                      <td className="r mono">{money(c.mcap)}</td>
                      <td className="r mono">{money(c.cash)}</td>
                      <td className={"r mono " + (run < 12 ? "warn" : run > 24 ? "good" : "")}>{num(run)} mo</td>
                      <td className="r mono">{nd}d<span className="sub r">{nc ? nc.label.slice(0, 26) : "—"}</span></td>
                      <td className="r mono">{money(pv)}</td>
                      <td className="r"><span className="bisnum">{s}</span><Bar100 v={s} /></td>
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

function Company({ ticker, go, watch, toggleWatch }) {
  const c = COMPANIES.find((x) => x.t === ticker) || COMPANIES[0];
  const [tab, setTab] = useState("overview");
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

  const tabs = [["overview", "Overview"], ["financials", "Financials"], ["pipeline", "Pipeline"], ["catalysts", "Catalysts"], ["valuation", "Valuation"], ["score", "Score"]];

  return (
    <div className="stack">
      <section className="cohead">
        <div>
          <div className="cohead-t"><span className="tick lg">{c.t}</span><h1>{c.n}</h1>
            <button className={"star " + (watch.includes(c.t) ? "on" : "")} onClick={() => toggleWatch(c.t)}>★</button></div>
          <p className="cohead-note">{c.note}</p>
        </div>
        <div className="cohead-stats">
          <div><span>Market cap</span><b className="mono">{money(c.mcap)}</b></div>
          <div><span>Cash</span><b className="mono">{money(c.cash)}</b></div>
          <div><span>Runway</span><b className={"mono " + (r < 12 ? "warn" : "")}>{num(r)} mo</b></div>
          <div><span>Score</span><b className="mono">{score}</b></div>
        </div>
      </section>

      <nav className="tabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>

      {tab === "overview" && (
        <div className="two">
          <section className="panel">
            <header className="ph"><h2>What the numbers say</h2><span className="ph-note">Click any underlined figure to see where it came from.</span></header>
            <div className="metrics">
              <div className="metric"><span>Cash runway</span>
                <Trace value={num(r)} unit=" months" tone={r < 12 ? "warn" : ""}
                  source={`Cash of ${money(c.cash)} and quarterly operating cash use, latest filing`}
                  calc={`${money(c.cash)} ÷ ${num(c.burn)}M per month`}
                  reading={r < 12 ? "Financing is likely needed before the next major catalyst." : r < 18 ? "Enough to reach the next event, not enough to negotiate from strength after it." : "Funded through the next catalyst with room to spare."} />
              </div>
              <div className="metric"><span>Monthly cash burn</span>
                <Trace value={num(c.burn)} unit="M"
                  source="Operating cash flow and capital expenditure, trailing four quarters"
                  calc="Trailing twelve-month net cash use ÷ 12"
                  reading={c.burn > 20 ? "Heavy spend, consistent with a late-stage trial running." : "Burn is in line with a mid-stage clinical program."} />
              </div>
              <div className="metric"><span>Enterprise value</span>
                <Trace value={money(c.ev)}
                  source="Market capitalization, cash, and debt"
                  calc={`${money(c.mcap)} − ${money(c.cash)} + ${money(c.debt)}`}
                  reading={`The market is paying ${money(c.ev)} for the pipeline itself.`} />
              </div>
              <div className="metric"><span>Pipeline rNPV</span>
                <Trace value={money(pv)}
                  source="Per-program peak sales, phase, and development cost estimates"
                  calc="Risk-adjusted NPV summed across programs, 11% discount rate"
                  reading={c.ev / pv < 0.85 ? "Enterprise value sits under the modeled pipeline value. Either the market disputes these assumptions or it is discounting execution." : "Enterprise value already matches or exceeds the modeled pipeline value, so the assumptions need to be right."} />
              </div>
              <div className="metric"><span>Next catalyst</span>
                <Trace value={nc ? `${days(nc.date)}` : "—"} unit=" days"
                  source="Company guidance, trial registry, and regulatory calendar"
                  calc={nc ? `${fmtDate(nc.date)} minus today` : "No dated event"}
                  reading={nc ? nc.label : "Nothing dated in the current window."} />
              </div>
              <div className="metric"><span>Shares outstanding</span>
                <Trace value={num(c.shares, 0)} unit="M"
                  source="Cover page of the most recent periodic filing"
                  calc="As reported"
                  reading={`Up roughly ${num(c.financings.reduce((s, f) => s + f.dil, 0), 0)}% from the financings on file.`} />
              </div>
            </div>
          </section>

          <section className="panel">
            <header className="ph"><h2>Open flags</h2><span className="ph-note">Generated from the same rules that drive alerts.</span></header>
            <div className="alist tight">
              {alertsFor(c).length === 0 && <div className="empty">No rules fired. Cash, timing, and dilution all sit inside normal bands.</div>}
              {alertsFor(c).map((x, i) => <div key={i} className={"alert " + x.sev}>{x.text}</div>)}
            </div>
            <header className="ph mt"><h2>Company facts</h2></header>
            <dl className="facts">
              <dt>Therapeutic area</dt><dd>{c.area}</dd>
              <dt>Programs</dt><dd>{c.pipeline.length}</dd>
              <dt>Employees</dt><dd className="mono">{c.emp}</dd>
              <dt>Institutional ownership</dt><dd className="mono">{num(c.own, 0)}%</dd>
              <dt>Revenue, trailing</dt><dd className="mono">{c.rev ? money(c.rev) : "None"}</dd>
              <dt>Debt</dt><dd className="mono">{c.debt ? money(c.debt) : "None"}</dd>
              <dt>Partnerships</dt><dd>{c.partners.length ? c.partners.join("; ") : "None disclosed"}</dd>
              <dt>Patent life, lead asset</dt><dd className="mono">{c.patentYrs} years</dd>
            </dl>
          </section>
        </div>
      )}

      {tab === "financials" && (
        <div className="stack">
          <section className="panel">
            <header className="ph"><h2>When the cash runs out</h2>
              <span className="ph-note">Straight-line burn against reported cash. Drag the raise to test a financing.</span></header>
            <label className="f wide"><span>Model a raise of {money(raise)} in month 6</span>
              <input type="range" min="0" max="400" step="10" value={raise} onChange={(e) => setRaise(+e.target.value)} /></label>
            <div className="chart">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={cashCurve} margin={{ top: 10, right: 20, bottom: 24, left: 8 }}>
                  <CartesianGrid stroke="#DCE2E5" />
                  <XAxis dataKey="m" tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }}
                    label={{ value: "months from today", position: "insideBottom", offset: -12, fontSize: 11, fill: "#5A6B76" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }} tickFormatter={(v) => `$${v}M`} />
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
              <header className="ph"><h2>Dilution estimator</h2><span className="ph-note">What a raise costs the shares you already own.</span></header>
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
              <header className="ph"><h2>Financing history</h2><span className="ph-note">How this company has raised before is the best guide to how it will raise next.</span></header>
              <table className="grid plain">
                <thead><tr><th>Date</th><th>Instrument</th><th className="r">Size</th><th className="r">Share count impact</th></tr></thead>
                <tbody>
                  {c.financings.map((f, i) => (
                    <tr key={i}><td className="mono">{fmtDate(f.date)}</td><td>{f.type}</td>
                      <td className="r mono">{money(f.amt)}</td><td className="r mono">{f.dil ? `+${num(f.dil)}%` : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      )}

      {tab === "pipeline" && (
        <section className="panel">
          <header className="ph"><h2>Pipeline</h2><span className="ph-note">Each program valued on its own, then summed.</span></header>
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
                    <dt>Target</dt><dd>{p.tgt}</dd>
                    <dt>Mechanism</dt><dd>{p.moa}</dd>
                    <dt>Primary endpoint</dt><dd>{p.ep}</dd>
                    <dt>Enrollment</dt><dd className="mono">{p.n ? p.n : "—"}</dd>
                    <dt>Expected readout</dt><dd className="mono">{fmtDate(p.ro)} <span className="sub inline">({days(p.ro)}d)</span></dd>
                    <dt>Probability of approval</dt><dd className="mono">{Math.round(POS[p.ph] * 100)}%</dd>
                    <dt>Peak sales estimate</dt><dd className="mono">{money(p.peak)}</dd>
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
          <header className="ph"><h2>Catalyst calendar</h2><span className="ph-note">Dated events only. Guidance without a date is not a catalyst.</span></header>
          <div className="timeline">
            {[...c.catalysts].sort((a, b) => days(a.date) - days(b.date)).map((x, i) => {
              const d = days(x.date);
              return (
                <div key={i} className={"tl " + (d < 0 ? "past" : "")}>
                  <div className="tl-dot" style={{ background: CAT_KIND[x.kind].c }} />
                  <div className="tl-date mono">{fmtDate(x.date)}</div>
                  <div className="tl-body">
                    <div className="tl-label">{x.label}</div>
                    <div className="sub">{CAT_KIND[x.kind].label}{x.drug ? ` · ${x.drug}` : ""}</div>
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
              <span className="ph-note">Assumptions are yours to move. The output is a range to argue with, not a price target.</span></header>
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
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#5A6B76", fontFamily: "IBM Plex Mono" }} tickFormatter={(v) => `$${v}M`} />
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
            <span className="ph-note">A research framework, not a prediction. Every component is reproducible from the inputs above.</span></header>
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
        <header className="ph"><h2>Catalyst calendar</h2><span className="ph-note">Everything dated across the universe, grouped by month.</span></header>
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
  const [sel, setSel] = useState(["NVRA", "ATLM", "HLXR"]);
  const set = (i, v) => setSel(sel.map((s, j) => (j === i ? v : s)));
  const cols = sel.map((t) => COMPANIES.find((c) => c.t === t)).filter(Boolean);

  const rows = [
    ["Therapeutic area", (c) => c.area],
    ["Most advanced program", (c) => [...c.pipeline].sort((a, b) => phaseRank(b.ph) - phaseRank(a.ph))[0].ph],
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
    ["Institutional ownership", (c) => `${num(c.own, 0)}%`, 1],
    ["Score", (c) => bis(c), 1],
  ];

  return (
    <section className="panel">
      <header className="ph"><h2>Compare</h2><span className="ph-note">Three companies, one set of definitions.</span></header>
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
    "Compare NVRA, ATLM and DRVN on financing risk.",
    "Which Phase III oncology programs read out first?",
    "Where is enterprise value furthest below modeled pipeline value?",
  ];

  const facts = () => COMPANIES.map((c) => ({
    ticker: c.t, name: c.n, area: c.area,
    market_cap_musd: c.mcap, enterprise_value_musd: c.ev, cash_musd: c.cash, debt_musd: c.debt,
    monthly_burn_musd: c.burn, runway_months: +runway(c).toFixed(1),
    revenue_ttm_musd: c.rev, shares_out_m: c.shares, score: bis(c),
    pipeline_rnpv_musd: Math.round(pipelineValue(c)),
    programs: c.pipeline.map((p) => ({ drug: p.d, indication: p.ind, target: p.tgt, phase: p.ph, expected_readout: p.ro, peak_sales_musd: p.peak })),
    catalysts: c.catalysts.map((x) => ({ date: x.date, days_away: days(x.date), event: x.label })),
    financings: c.financings,
  }));

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
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are the research assistant inside a biotech investment research terminal. Answer only from the JSON dataset below. Never invent a company, number, or date that is not present. Cite the specific figures you used inline, in plain prose, e.g. "$412M cash against $21.5M monthly burn". If the data cannot answer the question, say exactly what is missing. Keep the answer under 180 words, no markdown headers, no bullet symbols other than plain hyphens. End with one line beginning "Worth checking:" naming the single assumption that most affects the conclusion.

DATA (all dollar figures in millions USD; this is sample data for a prototype):
${JSON.stringify(facts())}

QUESTION: ${text}`
          }],
        }),
      });
      const data = await res.json();
      const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      setLog((l) => [...l, { role: "ai", text: out || local(text), traced: true }]);
    } catch (e) {
      setLog((l) => [...l, { role: "ai", text: local(text), fallback: true }]);
    }
    setBusy(false);
  };

  return (
    <div className="stack">
      <section className="panel">
        <header className="ph"><h2>Ask the data</h2>
          <span className="ph-note">Answers are restricted to the figures in this terminal, so you can check every one.</span></header>
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

/* ------------------------------- shell ------------------------------- */

export default function App() {
  const [view, setView] = useState("scan");
  const [ticker, setTicker] = useState("NVRA");
  const [watch, setWatch] = useState(["NVRA", "ATLM"]);
  const [omni, setOmni] = useState("");

  const go = (v, t) => { if (t) setTicker(t); setView(v); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const toggleWatch = (t) => setWatch((w) => (w.includes(t) ? w.filter((x) => x !== t) : [...w, t]));

  const matches = omni.trim()
    ? COMPANIES.filter((c) => (c.t + " " + c.n).toLowerCase().includes(omni.toLowerCase())).slice(0, 6)
    : [];

  const nav = [["scan", "Scan"], ["screen", "Screen"], ["company", "Company"], ["catalysts", "Catalysts"], ["compare", "Compare"], ["ask", "Ask"]];

  return (
    <div className="app">
      <style>{CSS}</style>

      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="bname">Readout</span>
          <span className="btag">biotech intelligence terminal</span>
        </div>

        <div className="omni">
          <input value={omni} onChange={(e) => setOmni(e.target.value)} placeholder="Jump to a company" aria-label="Jump to a company" />
          {matches.length > 0 && (
            <div className="omnilist">
              {matches.map((c) => (
                <button key={c.t} onClick={() => { go("company", c.t); setOmni(""); }}>
                  <span className="tick">{c.t}</span>{c.n}<span className="sub">{c.area}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className="mainnav">
          {nav.map(([k, l]) => <button key={k} className={view === k ? "on" : ""} onClick={() => go(k)}>{l}</button>)}
        </nav>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="railhead">Watchlist</div>
          {watch.length === 0 && <p className="railempty">Star a company to follow its runway and catalysts here.</p>}
          {watch.map((t) => {
            const c = COMPANIES.find((x) => x.t === t);
            const nc = nextCatalyst(c);
            return (
              <button key={t} className={"railrow " + (view === "company" && ticker === t ? "on" : "")} onClick={() => go("company", t)}>
                <span className="tick">{c.t}</span>
                <span className="railn">{c.n}</span>
                <span className={"railr mono " + (runway(c) < 12 ? "warn" : "")}>{num(runway(c), 0)} mo</span>
                <span className="railc">{nc ? `${days(nc.date)}d to ${nc.label.toLowerCase()}` : "no dated event"}</span>
              </button>
            );
          })}
          <div className="railhead mt">Universe</div>
          {COMPANIES.map((c) => (
            <button key={c.t} className={"railrow slim " + (view === "company" && ticker === c.t ? "on" : "")} onClick={() => go("company", c.t)}>
              <span className="tick">{c.t}</span><span className="railn">{c.n}</span>
              <span className="railr mono">{bis(c)}</span>
            </button>
          ))}
        </aside>

        <main className="main">
          {view === "scan" && <Scan go={go} watch={watch} toggleWatch={toggleWatch} />}
          {view === "screen" && <Screen go={go} />}
          {view === "company" && <Company ticker={ticker} go={go} watch={watch} toggleWatch={toggleWatch} />}
          {view === "catalysts" && <Catalysts go={go} />}
          {view === "compare" && <Compare />}
          {view === "ask" && <Ask />}
          <footer className="foot">
            Prototype built on sample data. Companies, figures, and dates are fictional and are here to exercise the calculations, not to describe any real security.
            Research and screening tool only; nothing here is investment advice.
          </footer>
        </main>
      </div>
    </div>
  );
}

/* -------------------------------- css -------------------------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.app{--ink:#10202E;--bg:#E6E9EA;--paper:#FFFFFF;--rule:#CBD3D7;--rule2:#E1E6E8;
--teal:#12706B;--deep:#0C5670;--indigo:#123E6B;--amber:#B8730F;--crimson:#9E2140;--moss:#2F6B3A;--mut:#5A6B76;
font-family:'Archivo',system-ui,sans-serif;color:var(--ink);background:var(--bg);min-height:100vh;font-size:14px;line-height:1.45;
-webkit-font-smoothing:antialiased;}
.app *{box-sizing:border-box;}
.app button{font-family:inherit;cursor:pointer;}
.app :focus-visible{outline:2px solid var(--deep);outline-offset:2px;}
.mono{font-family:'IBM Plex Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums;}
.warn{color:var(--amber);}
.good{color:var(--moss);}
.sub{display:block;font-size:11.5px;color:var(--mut);font-weight:400;}
.sub.inline{display:inline;}
.sub.r{text-align:right;}

/* top bar */
.top{display:flex;align-items:center;gap:20px;padding:0 20px;height:56px;background:var(--ink);color:#EAF0F2;position:sticky;top:0;z-index:40;}
.brand{display:flex;align-items:baseline;gap:9px;}
.mark{width:11px;height:11px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 3px rgba(18,112,107,.28);align-self:center;}
.bname{font-size:17px;font-weight:700;letter-spacing:-.2px;}
.btag{font-size:11.5px;color:#8FA3AE;}
.omni{position:relative;flex:1;max-width:340px;}
.omni input{width:100%;background:#1B2E3D;border:1px solid #2B4256;color:#EAF0F2;border-radius:3px;padding:7px 10px;font-size:13px;}
.omni input::placeholder{color:#7D94A1;}
.omnilist{position:absolute;top:38px;left:0;right:0;background:var(--paper);border:1px solid var(--rule);border-radius:3px;box-shadow:0 10px 26px rgba(16,32,46,.22);overflow:hidden;z-index:50;}
.omnilist button{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;padding:8px 10px;border:0;background:none;color:var(--ink);font-size:13px;}
.omnilist button:hover{background:#F0F4F5;}
.omnilist .sub{margin-left:auto;}
.mainnav{display:flex;gap:2px;margin-left:auto;}
.mainnav button{background:none;border:0;color:#9FB3BE;padding:8px 12px;font-size:13.5px;border-bottom:2px solid transparent;}
.mainnav button:hover{color:#EAF0F2;}
.mainnav button.on{color:#fff;border-bottom-color:var(--teal);}

/* layout */
.body{display:flex;align-items:flex-start;}
.rail{width:232px;flex:none;background:#F3F5F6;border-right:1px solid var(--rule);min-height:calc(100vh - 56px);padding:12px 0 40px;position:sticky;top:56px;max-height:calc(100vh - 56px);overflow-y:auto;}
.railhead{font-size:12px;color:var(--mut);padding:4px 14px 8px;}
.railhead.mt{margin-top:16px;border-top:1px solid var(--rule2);padding-top:14px;}
.railempty{font-size:12px;color:var(--mut);padding:0 14px 8px;}
.railrow{display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;width:100%;text-align:left;background:none;border:0;border-left:3px solid transparent;padding:7px 14px;align-items:baseline;}
.railrow:hover{background:#E9EEEF;}
.railrow.on{background:#fff;border-left-color:var(--teal);}
.railn{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.railr{font-size:12px;color:var(--mut);}
.railc{grid-column:1/-1;font-size:11px;color:var(--mut);}
.railrow.slim{padding:5px 14px;}
.main{flex:1;min-width:0;padding:20px 22px 60px;}
.stack{display:flex;flex-direction:column;gap:16px;}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;}

/* panels */
.panel{background:var(--paper);border:1px solid var(--rule);border-radius:3px;padding:16px 18px 18px;}
.ph{display:flex;align-items:baseline;gap:14px;margin:0 0 14px;padding-bottom:9px;border-bottom:1px solid var(--rule2);flex-wrap:wrap;}
.ph.mt{margin-top:20px;}
.ph h2{font-size:15px;font-weight:600;margin:0;letter-spacing:-.1px;}
.ph-note{font-size:12px;color:var(--mut);}
.empty{font-size:13px;color:var(--mut);padding:14px 0;}

/* hero */
.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;background:var(--ink);color:#EAF0F2;border-radius:3px;padding:26px 24px;}
.hero-q{font-size:30px;line-height:1.14;font-weight:600;letter-spacing:-.6px;max-width:19ch;}
.hero-sub{margin:12px 0 0;font-size:13.5px;color:#A9BDC7;max-width:62ch;}
.hero-date{font-size:12.5px;color:#8FA3AE;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}

/* tape */
.tape{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;}
.tapecard{flex:none;width:186px;text-align:left;background:#F7F9F9;border:1px solid var(--rule2);border-top:3px solid var(--teal);border-radius:2px;padding:10px 11px;display:grid;gap:3px;}
.tapecard:hover{background:#fff;border-color:var(--rule);}
.tape-d{font-family:'IBM Plex Mono',monospace;font-size:17px;font-weight:600;}
.tape-t{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--ink);font-weight:600;}
.tape-l{font-size:12.5px;line-height:1.3;}
.tape-date{font-size:11px;color:var(--mut);font-family:'IBM Plex Mono',monospace;}

/* alerts */
.alist{display:flex;flex-direction:column;gap:14px;}
.alist.tight{gap:8px;}
.arow-head{display:flex;align-items:center;gap:9px;margin-bottom:5px;}
.aname{font-size:13px;color:var(--mut);}
.alert{font-size:12.8px;padding:6px 10px;border-left:3px solid var(--rule);background:#F7F9F9;line-height:1.4;}
.alert.high{border-left-color:var(--crimson);background:#FBF3F4;}
.alert.med{border-left-color:var(--amber);background:#FBF7EF;}
.alert.low{border-left-color:var(--deep);background:#F2F7F9;}
.tick{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:12.5px;background:var(--ink);color:#fff;padding:2px 6px;border-radius:2px;border:0;}
.tick.lg{font-size:15px;padding:3px 8px;}
.star{background:none;border:0;color:var(--rule);font-size:16px;line-height:1;padding:2px;}
.star:hover{color:var(--amber);}
.star.on{color:var(--amber);}

/* tables */
.tablewrap{overflow-x:auto;}
.grid{width:100%;border-collapse:collapse;font-size:13px;}
.grid th{text-align:left;font-weight:500;font-size:12px;color:var(--mut);padding:6px 10px;border-bottom:1px solid var(--rule);white-space:nowrap;cursor:pointer;}
.grid th.r,.grid td.r{text-align:right;}
.grid td{padding:9px 10px;border-bottom:1px solid var(--rule2);vertical-align:top;}
.grid tbody tr:hover{background:#F5F8F8;cursor:pointer;}
.grid.plain tbody tr:hover{background:none;cursor:default;}
.grid.plain th{cursor:default;}
.sortmark{margin-left:4px;color:var(--teal);}
.nm{max-width:190px;}
.bisnum{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;}
.bar100{display:block;width:74px;height:4px;background:var(--rule2);margin-left:auto;margin-top:4px;border-radius:2px;overflow:hidden;}
.bar100 span{display:block;height:100%;}
.grid.compare td.lbl,.grid.compare th.lbl{text-align:left;color:var(--mut);font-size:12.5px;width:210px;}
.grid.compare select{width:100%;font-family:inherit;font-size:12.5px;padding:4px 6px;border:1px solid var(--rule);border-radius:2px;background:#fff;}
.grid.compare tbody tr:hover{background:#F5F8F8;cursor:default;}

/* phase track */
.ptrack{display:flex;gap:2px;margin-bottom:4px;}
.pseg{width:16px;height:5px;background:var(--rule2);border-radius:1px;}
.phasechip{color:#fff;font-size:11.5px;padding:2px 8px;border-radius:2px;white-space:nowrap;}

/* filters */
.filters{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 20px;}
.f{display:grid;gap:5px;font-size:12px;color:var(--mut);}
.f.wide{margin-bottom:10px;}
.f input[type=text],.f input:not([type]),.f select{font-family:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--rule);border-radius:2px;background:#fff;color:var(--ink);}
.f input[type=range]{accent-color:var(--teal);}

/* company header */
.cohead{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;background:var(--paper);border:1px solid var(--rule);border-top:3px solid var(--teal);border-radius:3px;padding:16px 18px;}
.cohead-t{display:flex;align-items:center;gap:10px;}
.cohead-t h1{font-size:20px;margin:0;font-weight:600;letter-spacing:-.3px;}
.cohead-note{margin:8px 0 0;font-size:13px;color:var(--mut);max-width:64ch;}
.cohead-stats{display:flex;gap:26px;text-align:right;flex:none;}
.cohead-stats span{display:block;font-size:11.5px;color:var(--mut);}
.cohead-stats b{font-size:17px;font-weight:600;}

/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--rule);}
.tabs button{background:none;border:0;padding:8px 14px;font-size:13.5px;color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-1px;}
.tabs button:hover{color:var(--ink);}
.tabs button.on{color:var(--ink);border-bottom-color:var(--teal);font-weight:500;}

/* metrics + trace */
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:16px 22px;}
.metrics.two-up{grid-template-columns:1fr 1fr;}
.metric>span{display:block;font-size:12px;color:var(--mut);margin-bottom:2px;}
.metric b{font-size:19px;font-weight:600;}
.tr-wrap{position:relative;display:inline-block;}
.tr-val{font-family:'IBM Plex Mono',monospace;font-size:19px;font-weight:600;background:none;border:0;padding:0;color:var(--ink);border-bottom:1px dotted var(--teal);}
.tr-val.warn{color:var(--amber);border-bottom-color:var(--amber);}
.tr-unit{font-size:13px;font-weight:400;color:var(--mut);}
.tr-pop{position:absolute;top:30px;left:0;width:310px;background:var(--ink);color:#DCE7EC;padding:11px 13px;border-radius:3px;z-index:30;display:grid;gap:8px;box-shadow:0 14px 30px rgba(16,32,46,.3);}
.tr-row{display:block;font-size:12px;line-height:1.4;}
.tr-row b{display:block;font-size:10.5px;color:#7FA9A6;font-weight:500;margin-bottom:1px;}

/* facts */
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:0;font-size:13px;}
.facts dt{color:var(--mut);font-size:12.5px;}
.facts dd{margin:0;}
.facts.small{font-size:12.5px;margin-top:10px;gap:4px 16px;}
.facts .strong{font-weight:600;color:var(--teal);}

/* programs */
.prog-list{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.prog{border:1px solid var(--rule2);border-radius:2px;padding:13px 14px;}
.prog-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;}
.prog h3{margin:0;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;}
.prog-ind{font-size:12.5px;color:var(--mut);margin-top:2px;}

/* timeline */
.timeline{display:flex;flex-direction:column;}
.tl{display:grid;grid-template-columns:12px 120px 1fr auto;gap:12px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--rule2);}
.tl.past{opacity:.5;}
.tl-dot{width:8px;height:8px;border-radius:50%;align-self:center;}
.tl-date{font-size:12.5px;color:var(--mut);}
.tl-label{font-size:13.5px;}
.tl-days{font-size:13px;}

/* catalyst list */
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
.chip{font-size:12px;padding:4px 11px;border:1px solid var(--rule);background:#fff;border-radius:99px;color:var(--mut);}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff;}
.month{margin-bottom:18px;}
.monthhead{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;font-weight:500;color:var(--mut);margin:0 0 4px;padding-bottom:4px;border-bottom:1px solid var(--rule);}
.evrow{display:grid;grid-template-columns:72px 8px auto 1fr auto auto;gap:12px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--rule2);padding:9px 2px;}
.evrow:hover{background:#F5F8F8;}
.evrow.past{opacity:.48;}
.ev-date{font-size:12px;color:var(--mut);}
.ev-kind{width:8px;height:8px;border-radius:50%;}
.ev-label{font-size:13.5px;}
.ev-run{font-size:12px;color:var(--mut);}
.ev-days{font-size:12.5px;}

/* score */
.scorewrap{display:grid;grid-template-columns:150px 1fr;gap:28px;align-items:center;}
.bigscore{text-align:center;}
.bigscore span{font-size:58px;font-weight:600;line-height:1;letter-spacing:-2px;}
.bigscore small{display:block;font-size:12px;color:var(--mut);margin-top:4px;}
.scorelist{display:grid;gap:12px;}
.scorerow{display:grid;grid-template-columns:200px 1fr 34px;gap:14px;align-items:center;}
.sl{font-size:13px;}
.sl em{display:block;font-style:normal;font-size:11.5px;color:var(--mut);}
.scorerow .bar100{width:100%;height:7px;margin:0;}
.sv{font-size:13px;text-align:right;}

/* ask */
.sugg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
.sugg button{text-align:left;font-size:13px;padding:10px 12px;background:#F7F9F9;border:1px solid var(--rule2);border-radius:2px;color:var(--ink);}
.sugg button:hover{background:#fff;border-color:var(--teal);}
.log{display:flex;flex-direction:column;gap:14px;margin-bottom:14px;}
.msg.user .msg-body{background:var(--ink);color:#fff;padding:9px 12px;border-radius:3px;display:inline-block;font-size:13.5px;max-width:70ch;}
.msg.ai .msg-body{background:#F5F8F8;border-left:3px solid var(--teal);padding:11px 14px;font-size:13.5px;white-space:pre-wrap;max-width:78ch;line-height:1.55;}
.msg-tag{display:block;font-size:11px;color:var(--mut);margin-bottom:4px;}
.msg-body.dim{color:var(--mut);}
.askbar{display:flex;gap:8px;}
.askbar input{flex:1;font-family:inherit;font-size:13.5px;padding:9px 12px;border:1px solid var(--rule);border-radius:2px;}
.askbar button{background:var(--teal);color:#fff;border:0;border-radius:2px;padding:9px 20px;font-size:13.5px;}
.askbar button:disabled{background:var(--rule);}

.chart{margin-top:4px;}
.rtip{background:var(--ink);color:#EAF0F2;font-size:12px;padding:7px 10px;border-radius:3px;line-height:1.4;}
.foot{margin-top:28px;font-size:11.5px;color:var(--mut);max-width:96ch;line-height:1.5;}

@media (max-width:1100px){
  .two,.filters,.prog-list,.metrics,.sugg{grid-template-columns:1fr;}
  .rail{display:none;}
  .hero{flex-direction:column;align-items:flex-start;}
  .cohead{flex-direction:column;}
  .cohead-stats{text-align:left;gap:20px;flex-wrap:wrap;}
  .scorewrap{grid-template-columns:1fr;}
  .scorerow{grid-template-columns:150px 1fr 30px;}
}
@media (prefers-reduced-motion:reduce){.app *{transition:none!important;animation:none!important;}}
`;
