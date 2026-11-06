// Temporary: checks which historical data sources are reachable and what they contain.
const UA = process.env.SEC_USER_AGENT;
const show = async (label, url, headers = {}, n = 600) => {
  try {
    const r = await fetch(url, { headers, redirect: "follow" });
    const len = r.headers.get("content-length");
    const ct = r.headers.get("content-type");
    let body = "";
    if (!/zip|octet/.test(ct || "")) body = (await r.text()).slice(0, n).replace(/\s+/g, " ");
    console.log(`\n## ${label}\n${r.status} ${ct} len=${len}\n${body}`);
  } catch (e) { console.log(`\n## ${label}\nERROR ${e.message}`); }
};
const sec = { "User-Agent": UA };
await show("submissions.zip HEAD", "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip", sec);
await show("companyfacts.zip HEAD", "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip", sec);
await show("browse SIC 2836 (incl. inactive?)", "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=2836&owner=include&count=40&output=atom", sec, 1500);
// A biotech that went bankrupt (Achaogen, CIK 1301501) and one acquired (Achillion, CIK 1070336)
await show("submissions dead co Achaogen", "https://data.sec.gov/submissions/CIK0001301501.json", sec, 900);
await show("companyfacts dead co Achaogen", "https://data.sec.gov/api/xbrl/companyfacts/CIK0001301501.json", sec, 300);
await show("XBRL frames cash 2015Q4", "https://data.sec.gov/api/xbrl/frames/us-gaap/CashAndCashEquivalentsAtCarryingValue/USD/CY2015Q4I.json", sec, 400);
for (const u of [
  "https://clinicaltrials.gov/api/int/studies/NCT02283294/history",
  "https://clinicaltrials.gov/api/v2/studies/NCT02283294/history",
  "https://clinicaltrials.gov/api/int/studies/NCT02283294?history=true",
  "https://clinicaltrials.gov/api/int/studies/NCT02283294/history/5",
]) await show("CT.gov history " + u, u, { "User-Agent": "Mozilla/5.0 Helixora research" }, 1500);
await show("AACT site", "https://aact.ctti-clinicaltrials.org/downloads", {}, 1500);
for (const t of ["AKAO", "ACHN", "CLVS", "ACRX"]) await show("Yahoo dead ticker " + t, `https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=10y&interval=1mo`, { "User-Agent": "Mozilla/5.0" }, 300);
await show("Stooq dead ticker", "https://stooq.com/q/d/l/?s=akao.us&i=m", {}, 300);
