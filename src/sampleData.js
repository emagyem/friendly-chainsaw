/* ------------------------------------------------------------------
   Sample dataset. Companies and figures are fictional.
   The app falls back to this when public/data/companies.json is missing,
   e.g. before the first nightly data refresh has run.
------------------------------------------------------------------- */

const C = (t, n, area, mcap, ev, cash, debt, burn, rev, shares, own, emp, partners, patentYrs, diff, mkt, pipeline, catalysts, financings, note) =>
  ({ t, n, area, mcap, ev, cash, debt, burn, rev, shares, own, emp, partners, patentYrs, diff, mkt, pipeline, catalysts, financings, note });

export const SAMPLE_COMPANIES = [
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
