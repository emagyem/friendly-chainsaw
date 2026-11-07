import { secText, sec } from "../scripts/fetch-data.mjs";
import { plain } from "../scripts/cyber.mjs";
const tk = await sec("https://www.sec.gov/files/company_tickers.json");
const cikBy = new Map(Object.values(tk).map((r) => [r.ticker, r.cik_str]));
for (const t of ["TAK", "HLN"]) {
  const cik = cikBy.get(t);
  const sub = await sec(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`);
  const r = sub.filings.recent; const i = r.form.findIndex((f) => f === "20-F");
  const text = plain(await secText(`https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`));
  let n = 0;
  for (const m of text.matchAll(/.{0,80}(16\s*\.?\s*K|cyber\s?security\s*\.|cyber security\s*\.).{0,160}/gi)) { if (n++ < 10) console.log("HIT", t, JSON.stringify(m[0])); }
}
