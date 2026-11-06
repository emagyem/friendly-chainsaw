import { SAMPLE_COMPANIES } from "./sampleData.js";

/* ------------------------------------------------------------------
   Data loading. The app reads public/data/companies.json, which the
   nightly GitHub Action rebuilds from SEC EDGAR, ClinicalTrials.gov and
   a stock price feed. If that file is missing or unreadable, the app
   falls back to the fictional sample dataset and says so on screen.

   COMPANIES and META are live ES module bindings: loadData() reassigns
   them before the first render, and every importer sees the new value.
------------------------------------------------------------------- */

export let COMPANIES = SAMPLE_COMPANIES;
export let META = { live: false };
export let HISTORY = { snapshots: [] };
// Companies bought by a larger drugmaker, kept at their last figures.
export let ACQUIRED = [];
// Large drugmakers tracked for comparison, kept apart from the ranked coverage.
export let BIG_PHARMA = [];

export async function loadData() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/companies.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.companies) || json.companies.length === 0) throw new Error("no companies in file");
    COMPANIES = json.companies;
    ACQUIRED = Array.isArray(json.acquired) ? json.acquired : [];
    BIG_PHARMA = Array.isArray(json.bigPharma) ? json.bigPharma : [];
    META = { ...json.meta, live: true };
    try {
      const h = await fetch(`${import.meta.env.BASE_URL}data/fps-history.json`, { cache: "no-cache" });
      if (h.ok) HISTORY = await h.json();
    } catch { /* no history yet */ }
  } catch (e) {
    COMPANIES = SAMPLE_COMPANIES;
    META = { live: false, reason: e.message };
  }
}
