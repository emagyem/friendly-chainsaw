import { readFile } from "node:fs/promises";
const UA = process.env.SEC_USER_AGENT;
const d = JSON.parse(await readFile("public/data/companies.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = {};
for (const c of d.companies) {
  await sleep(130);
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.src.cik).padStart(10, "0")}.json`, { headers: { "User-Agent": UA } });
  if (!r.ok) continue;
  const f = (await r.json()).facts;
  const asOf = c.src.asOf; const hits = [];
  for (const ns of Object.keys(f)) for (const [tag, v] of Object.entries(f[ns])) {
    if (!/Cash|Securit|Investment|Marketable/i.test(tag) || /Proceeds|Payments|Increase|Purchase|Gain|Loss|Income|Interest|Unrealized|Amortized|Maturit|Sale|Restricted|Period|Tax/i.test(tag)) continue;
    const row = (v.units?.USD || []).filter((x) => !x.start && x.end === asOf).at(-1);
    if (row && row.val >= 5e6) hits.push(`${ns === "us-gaap" ? "" : ns + ":"}${tag}=${Math.round(row.val / 1e6)}`);
  }
  const used = new Set(c.src.cashParts || []);
  const extra = hits.filter((h) => !used.has(h.split("=")[0]));
  for (const h of extra) { const k = h.split("=")[0]; tally[k] = (tally[k] || 0) + 1; }
  console.log(`${c.t}\tcash=${Math.round(c.cash)}\tused=${[...used].join("+")}\tOTHER: ${extra.join(" ")}`);
}
console.log(JSON.stringify(Object.entries(tally).sort((a, b) => b[1] - a[1])));
