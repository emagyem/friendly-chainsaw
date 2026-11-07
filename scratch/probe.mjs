import { secText, sec } from "../scripts/fetch-data.mjs";
import { plain, cyberSection, scoreGovernance } from "../scripts/cyber.mjs";
const tk = await sec("https://www.sec.gov/files/company_tickers.json");
const cikBy = new Map(Object.values(tk).map((r) => [r.ticker, r.cik_str]));
for (const t of ["LLY", "TAK", "AGIO", "RNAC"]) {
  const cik = cikBy.get(t);
  const sub = await sec(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`);
  const r = sub.filings.recent; const i = r.form.findIndex((f) => f === "10-K" || f === "20-F");
  const text = plain(await secText(`https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i].replace(/-/g, "")}/${r.primaryDocument[i]}`));
  const sec1 = cyberSection(text, r.form[i]);
  const g = scoreGovernance(sec1);
  console.log("SEC", t, r.form[i], "len", sec1.length, "score", g.score, g.items.map((x) => x.key + ":" + x.got).join(" "));
  for (let k = 0; k < Math.min(sec1.length, 6000); k += 1500) console.log("TXT", t, sec1.slice(k, k + 1500));
}
