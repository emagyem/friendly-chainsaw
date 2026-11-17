import { SAMPLE_COMPANIES } from "./sampleData.js";
import { fetchData } from "./native.js";

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
// Drug-industry companies (big pharma, generics, over-the-counter, ingredients, compounding),
// tracked for comparison and kept apart from the ranked coverage.
export let INDUSTRY = [];

export async function loadData() {
  try {
    const { json, offline } = await fetchData("companies.json");
    if (!Array.isArray(json.companies) || json.companies.length === 0) throw new Error("no companies in file");
    COMPANIES = json.companies;
    INDUSTRY = Array.isArray(json.industry) ? json.industry : Array.isArray(json.bigPharma) ? json.bigPharma : [];
    // offline: the phone app couldn't reach the server and is showing the copy it saved last time.
    META = { ...json.meta, live: true, offline };
    try { HISTORY = (await fetchData("fps-history.json")).json; } catch { /* no history yet */ }
  } catch (e) {
    COMPANIES = SAMPLE_COMPANIES;
    META = { live: false, reason: e.message };
  }
}
