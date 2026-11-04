/* ------------------------------------------------------------------
   Drug-development models, shared by the website and the data refresh.

   readoutWindow   When trial data is likely to land, as a window, from the
                   registry's primary completion date, trial status, how
                   stale the record is, and any date slips Helixora has seen.
   designFlags     Warning signs in a trial's registered design.
   successOdds     Chance of approval from the current phase, using published
                   phase-transition rates by disease area, adjusted for drug
                   type, rare disease and biomarker selection.
   exclusivity     The earliest date generic or biosimilar competition can
                   start under US law, from the approval pathway.
   reviewOffice    The FDA office that most likely reviews the application.

   Every rule here is published on the site. They are version 1 and will be
   checked against what actually happens.
------------------------------------------------------------------- */

export const TRIALS_VERSION = "1.0";
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addMonths = (isoDate, m) => iso(Date.parse(isoDate + "T00:00:00Z") + m * 30.44 * DAY);
const monthsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / (30.44 * DAY);

/* --------------------------- readout timing --------------------------- */

// Topline results usually follow the last patient's last visit by a few weeks to a few months.
const LAG = { lo: 0.5, hi: 3.5 };

export function readoutWindow(p, todayIso = iso(Date.now())) {
  const t = p.trial || {};
  const reg = p.ro;
  if (!reg) return null;
  const why = [];
  if (p.roType === "COMPANY GUIDANCE") {
    return { lo: addMonths(reg, -1), hi: addMonths(reg, 1.5), mid: reg, reg, width: 2.5, basis: "Company guidance", why: ["Date guided by the company; the window allows for a month early or six weeks late."] };
  }
  let lo = LAG.lo, hi = LAG.hi;
  let anchor = reg;
  const status = t.status || p.status || "";
  if (p.roType === "ACTUAL") {
    why.push("The trial's primary completion date is recorded as actual, so data usually follows within a few months.");
  } else {
    if (status === "ACTIVE_NOT_RECRUITING") { hi += 3; why.push("Enrollment is closed, so the main remaining risk is a modest slip (+3 months on the late end)."); }
    else if (status === "RECRUITING" || status === "ENROLLING_BY_INVITATION") {
      const extra = (t.ph || p.ph) === "Phase III" ? 9 : 6;
      hi += extra; why.push(`Still enrolling, and enrolling trials often finish late (+${extra} months on the late end).`);
    } else if (status === "NOT_YET_RECRUITING") { lo += 3; hi += 12; why.push("Not yet enrolling, so the registry date is a plan, not a schedule (window widened by a year)."); }
    if (t.lastUpdate && monthsBetween(t.lastUpdate, todayIso) > 12) { hi += 6; why.push("The registry record hasn't been updated in over a year (+6 months)."); }
    const slips = p.slips || 0;
    if (slips > 0) { hi += 3 * Math.min(slips, 2); why.push(`The completion date has been pushed back ${slips} time${slips === 1 ? "" : "s"} since Helixora began tracking (+${3 * Math.min(slips, 2)} months).`); }
  }
  let L = addMonths(anchor, lo), H = addMonths(anchor, hi);
  if (H < todayIso) {
    // The expected window has passed with no update: data could come any time, or the trial may have stalled.
    L = todayIso; H = addMonths(todayIso, 6);
    why.push("The expected date has passed without an update, so the window restarts from today.");
  } else if (L < todayIso) L = todayIso;
  const mid = iso((Date.parse(L) + Date.parse(H)) / 2);
  const width = Math.round(monthsBetween(L, H) * 10) / 10;
  return { lo: L, hi: H, mid, reg, width, basis: p.roType === "ACTUAL" ? "Registry (actual completion)" : "Registry estimate", why };
}

export const windowConfidence = (w) => (!w ? null : w.width <= 4 ? "Tight" : w.width <= 9 ? "Moderate" : "Wide");

/* ---------------------------- design flags ---------------------------- */

const SOFT_ENDPOINT = /patient[- ]reported|quality of life|global impression|questionnaire|\bPRO\b|subjective|pain (score|intensity)|itch|well-being|satisfaction/i;
const CONTROL_ARMS = new Set(["PLACEBO_COMPARATOR", "ACTIVE_COMPARATOR", "SHAM_COMPARATOR", "NO_INTERVENTION"]);
const HALTED = new Set(["SUSPENDED", "TERMINATED", "WITHDRAWN"]);

export function designFlags(p, todayIso = iso(Date.now())) {
  const t = p.trial;
  if (!t) return { flags: [], level: null };
  const flags = [];
  const tph = t.ph || p.ph;
  const late = tph === "Phase III";
  const add = (sev, label, detail) => flags.push({ sev, label, detail });
  if (t.ext) add("info", "Extension study", "This trial mainly tracks long-term safety in patients from earlier studies. Its completion is not a pivotal efficacy readout.");
  if (HALTED.has(t.status)) add("high", "Trial halted", `The registry lists the trial as ${t.status.toLowerCase()}.`);
  if (!t.ext) {
    if (late && t.n && t.n < 100 && !p.rare) add("med", "Small for a late-stage trial", `${t.n} patients planned or enrolled. Small late-stage trials can miss real but modest effects.`);
    if (late && t.alloc && t.alloc !== "RANDOMIZED") add("med", "Not randomized", "Without randomization, differences between groups can come from who was enrolled rather than the drug.");
    if ((tph === "Phase II" || late) && t.arms && t.arms.length && !t.arms.some((a) => CONTROL_ARMS.has(a))) add("med", "No control arm", "Every arm gets the drug, so results are compared with history or expectations rather than a placebo or standard treatment. Common, and sometimes unavoidable, in very rare diseases.");
    if (late && t.masking === "NONE") add("low", "Open label", "Patients and doctors know who gets the drug, which can sway subjective measures.");
    if (t.primary && SOFT_ENDPOINT.test(t.primary)) add("low", "Subjective primary endpoint", `The main measure relies on reported symptoms or scales: "${t.primary.slice(0, 90)}${t.primary.length > 90 ? "…" : ""}"`);
    if (tph !== "Phase I" && t.primaryCount >= 3) add("low", "Several primary endpoints", `${t.primaryCount} primary endpoints. Each extra one makes a chance win more likely unless the analysis corrects for it.`);
    if (late && t.sites != null && t.sites > 0 && t.sites < 5) add("low", "Few trial sites", `${t.sites} site${t.sites === 1 ? "" : "s"}. Results from very few centers can be harder to reproduce.`);
  }
  if (p.slips > 0) add("med", "Completion date pushed back", `Moved later ${p.slips} time${p.slips === 1 ? "" : "s"} since Helixora began tracking it.`);
  if (t.lastUpdate && monthsBetween(t.lastUpdate, todayIso) > 12 && !HALTED.has(t.status)) add("low", "Registry not updated in over a year", `Last updated ${t.lastUpdate}.`);
  if (p.roType === "ESTIMATED" && p.ro && monthsBetween(p.ro, todayIso) > 1) add("med", "Estimated completion date has passed", "The registry still shows an estimated date that is now in the past.");
  const pts = flags.reduce((s, f) => s + ({ high: 3, med: 2, low: 1, info: 0 }[f.sev] || 0), 0);
  return { flags, points: pts, level: pts === 0 ? "No flags" : pts <= 2 ? "Minor flags" : pts <= 4 ? "Some flags" : "Many flags" };
}

/* ---------------------------- success odds ----------------------------
   Phase-transition rates from BIO, Informa Pharma Intelligence and QLS,
   "Clinical Development Success Rates 2011–2020" (2021): Figure 2 (disease
   areas), Figure 10b (drug types), and the rare-disease and biomarker
   tables. Each entry: [I→II, II→III, III→filing, filing→approval]. */

export const ODDS_SOURCE = { title: "Clinical Development Success Rates 2011–2020 (BIO, Informa Pharma Intelligence, QLS, 2021)", url: "https://www.bio.org/clinical-development-success-rates-and-contributing-factors-2011-2020" };

export const AREA_RATES = {
  "All indications": [0.520, 0.289, 0.578, 0.906],
  Hematology: [0.696, 0.481, 0.768, 0.931],
  Metabolic: [0.618, 0.450, 0.636, 0.875],
  "Infectious disease": [0.578, 0.384, 0.640, 0.929],
  "Other (incl. renal, dermatology)": [0.636, 0.386, 0.600, 0.884],
  Ophthalmology: [0.716, 0.355, 0.512, 0.911],
  Autoimmune: [0.552, 0.314, 0.653, 0.941],
  Allergy: [0.564, 0.283, 0.647, 1.0],
  Gastroenterology: [0.467, 0.342, 0.571, 0.909],
  Respiratory: [0.559, 0.219, 0.645, 0.956],
  Psychiatry: [0.527, 0.268, 0.563, 0.912],
  Endocrine: [0.433, 0.266, 0.662, 0.863],
  Neurology: [0.477, 0.268, 0.531, 0.867],
  Oncology: [0.488, 0.246, 0.477, 0.920],
  Cardiovascular: [0.500, 0.210, 0.552, 0.825],
  Urology: [0.409, 0.150, 0.692, 0.846],
};
const MODALITY_RATES = {
  "CAR-T": [0.442, 0.588, 0.667, 1.0],
  "siRNA/RNAi": [0.700, 0.289, 0.667, 1.0],
  "Monoclonal antibody": [0.547, 0.341, 0.681, 0.954],
  "Gene therapy": [0.519, 0.386, 0.500, 1.0],
  "Small molecule": [0.526, 0.280, 0.569, 0.895],
  Antisense: [0.609, 0.200, 0.643, 0.667],
};
const RARE = [0.674, 0.446, 0.604, 0.936], NON_ONC = [0.539, 0.312, 0.613, 0.902];
const BIOMARKER = [0.524, 0.463, 0.682, 0.960];
const STEPS = ["Phase I to II", "Phase II to III", "Phase III to filing", "Filing to approval"];
const START = { "Phase I": 0, "Phase II": 1, "Phase III": 2, Filed: 3, Approved: 4 };

const AREA_WORDS = [
  ["Oncology", /cancer|tumou?r|carcinoma|melanoma|lymphoma|leukemia|myeloma|sarcoma|neoplasm|glioma/i],
  ["Hematology", /anemia|anaemia|hemophilia|sickle|thalass|fanconi|thrombocyt|hematolog/i],
  ["Neurology", /alzheimer|parkinson|amyotrophic|\bALS\b|muscular atrophy|duchenne|dystroph|myotonic|neuropath|epilep|huntington|ataxia|multiple sclerosis|migraine|myasthenia/i],
  ["Psychiatry", /depress|schizo|bipolar|anxiety|psychiatr/i],
  ["Cardiovascular", /cardio|heart|arrhythm|hypertension|danon|cholesterol|lipid|triglycer|atheroscl/i],
  ["Metabolic", /obes|weight|diabet|steatohepatitis|\bnash\b|\bmash\b|metabolic/i],
  ["Autoimmune", /dermatitis|psoriasis|lupus|arthritis|colitis|crohn|autoimmun|eczema|urticaria|hidradenitis/i],
  ["Respiratory", /asthma|copd|pulmonary|cystic fibrosis|bronch/i],
  ["Ophthalmology", /retin|macular|ocular|glaucoma|uveitis/i],
  ["Infectious disease", /infect|viral|virus|\bhiv\b|hepatitis b|covid|bacteri/i],
  ["Other (incl. renal, dermatology)", /nephr|kidney|renal|iga/i],
];
export function diseaseArea(p) {
  if (p.area && AREA_RATES[p.area]) return p.area;
  const txt = `${p.ind || ""}`;
  for (const [a, re] of AREA_WORDS) if (re.test(txt)) return a;
  return "All indications";
}
const MODALITY_WORDS = [
  ["CAR-T", /car-?t\b/i], ["siRNA/RNAi", /sirna|rnai/i], ["Gene therapy", /gene therapy|aav|lentivir/i],
  ["Antisense", /antisense|oligonucleotide/i], ["Monoclonal antibody", /antibody|mab\b/i],
  ["Small molecule", /small[- ]molecule|inhibitor|degrader/i],
];
export function modalityOf(p) {
  if (p.modality) return p.modality;
  for (const [m, re] of MODALITY_WORDS) if (re.test(p.moa || "")) return m;
  return null;
}

// Each adjustment is applied at half strength (square root of the ratio), because the
// published factors overlap: many rare-disease drugs are also biomarker-selected, for example.
export function successOdds(p) {
  const s = START[p.ph];
  if (s == null) return null;
  const area = diseaseArea(p);
  const mod = MODALITY_RATES[modalityOf(p)] ? modalityOf(p) : null;
  const base = AREA_RATES[area];
  const all = AREA_RATES["All indications"];
  const factors = [];
  if (mod) factors.push({ label: mod, ratio: MODALITY_RATES[mod].map((r, i) => r / all[i]) });
  if (p.rare && area !== "Oncology") factors.push({ label: "Rare disease", ratio: RARE.map((r, i) => r / NON_ONC[i]) });
  if (p.biomarker) factors.push({ label: "Patients selected by biomarker", ratio: BIOMARKER.map((r, i) => r / all[i]) });
  const steps = [];
  let loa = 1, baseLoa = 1, avgLoa = 1;
  for (let i = s; i < 4; i++) {
    const adj = Math.min(0.97, factors.reduce((v, f) => v * Math.sqrt(f.ratio[i]), base[i]));
    steps.push({ label: STEPS[i], base: base[i], adj });
    loa *= adj; baseLoa *= base[i]; avgLoa *= all[i];
  }
  return { area, modality: mod, factors: factors.map((f) => f.label), steps, loa, baseLoa, avgLoa };
}

/* ----------------------------- exclusivity ----------------------------- */

const BLA_TYPES = new Set(["Monoclonal antibody", "Gene therapy", "CAR-T"]);
export function pathwayOf(p) {
  if (p.pathway) return p.pathway;
  const m = modalityOf(p);
  if (BLA_TYPES.has(m) || /fusion protein|antibody/i.test(p.moa || "")) return "BLA";
  if (m === "Small molecule" || m === "siRNA/RNAi" || m === "Antisense") return "NDA";
  return null;
}

// Statutory exclusivity from approval: 12 years for a new biologic (BLA reference product),
// 5 years for a new chemical entity (NDA), 7 years orphan exclusivity for a designated rare indication.
export function exclusivity(p, expectedApproval) {
  const path = pathwayOf(p);
  if (!path || !expectedApproval) return null;
  const yrs = path === "BLA" ? 12 : 5;
  const orphan = p.orphan ?? (p.rare ? "likely" : false);
  const span = Math.max(yrs, orphan ? 7 : 0);
  const until = iso(Date.parse(expectedApproval + "T00:00:00Z") + span * 365.25 * DAY);
  return { path, yrs, orphan, span, from: expectedApproval, until, patent: p.patentExpiry || null };
}

/* ------------------------------ FDA office ------------------------------ */

export function reviewOffice(p) {
  const m = modalityOf(p);
  if (m === "Gene therapy" || m === "CAR-T") return "Office of Therapeutic Products (CBER)";
  const a = diseaseArea(p);
  return {
    Neurology: "Office of Neuroscience", Psychiatry: "Office of Neuroscience",
    Oncology: "Office of Oncologic Diseases",
    Hematology: "Office of Cardiology, Hematology, Endocrinology and Nephrology",
    Cardiovascular: "Office of Cardiology, Hematology, Endocrinology and Nephrology",
    Metabolic: "Office of Cardiology, Hematology, Endocrinology and Nephrology",
    Endocrine: "Office of Cardiology, Hematology, Endocrinology and Nephrology",
    "Other (incl. renal, dermatology)": "Office of Cardiology, Hematology, Endocrinology and Nephrology",
    Autoimmune: "Office of Immunology and Inflammation", Respiratory: "Office of Immunology and Inflammation", Allergy: "Office of Immunology and Inflammation",
    "Infectious disease": "Office of Infectious Diseases",
    Ophthalmology: "Office of Specialty Medicine", Gastroenterology: "Office of Immunology and Inflammation",
  }[a] || null;
}

// The FDA office names in the letters changed over the years; group old and new names together.
export const OFFICE_GROUPS = [
  ["Office of Neuroscience", /neuroscience|neurology|psychiatry|anesthes/i],
  ["Office of Oncologic Diseases", /oncolog|hematology and oncology/i],
  ["Office of Cardiology, Hematology, Endocrinology and Nephrology", /cardio|nephrolog|renal|metabolism|endocrin|hematology products|nonmalignant hematology|diabetes|lipid/i],
  ["Office of Immunology and Inflammation", /immunolog|dermatolog|rheumatolog|pulmonary|allergy|gastroenterolog|inflammation/i],
  ["Office of Infectious Diseases", /infectious|antimicrobial|antiviral/i],
  ["Office of Specialty Medicine", /specialty|ophthalm|imaging|medical imaging/i],
  ["Office of Therapeutic Products (CBER)", /biologics evaluation|therapeutic products|tissues and advanced/i],
];
