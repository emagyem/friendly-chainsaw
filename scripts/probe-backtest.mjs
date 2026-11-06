// Temporary: checks which historical data sources are reachable and what they contain.
const UA = process.env.SEC_USER_AGENT;
const B = { "User-Agent": "Mozilla/5.0 (Helixora research)" };
for (const u of ["https://aact.ctti-clinicaltrials.org/archive/download", "https://aact.ctti-clinicaltrials.org/pipe_files", "https://aact.ctti-clinicaltrials.org/download", "https://aact.ctti-clinicaltrials.org/archive"]) {
  try {
    const r = await fetch(u, { headers: B }); const t = await r.text();
    const links = [...new Set([...t.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /zip|digitalocean|download|snapshot|\d{8}/i.test(h)))];
    console.log(`\n## ${u} ${r.status} links=${links.length}\n` + links.slice(0, 40).join("\n") + (links.length > 40 ? `\n... ${links.length - 40} more\n` + links.slice(-15).join("\n") : ""));
  } catch (e) { console.log(u, e.message); }
}
// Public float (a free, filed market-value figure) for a dead company
const f = await (await fetch("https://data.sec.gov/api/xbrl/companyfacts/CIK0001301501.json", { headers: { "User-Agent": UA } })).json();
const pf = f.facts?.dei?.EntityPublicFloat?.units?.USD || [];
console.log("\n## Achaogen public float rows", pf.length, JSON.stringify(pf.slice(-4)));
const sub = await (await fetch("https://data.sec.gov/submissions/CIK0001301501.json", { headers: { "User-Agent": UA } })).json();
const r = sub.filings.recent; const forms = {};
r.form.forEach((x) => { forms[x] = (forms[x] || 0) + 1; });
console.log("## Achaogen forms", JSON.stringify(forms), "older files:", JSON.stringify(sub.filings.files));
