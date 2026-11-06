// Temporary: checks SEC endpoints for the backtest.
const H = { "User-Agent": process.env.SEC_USER_AGENT };
const j = async (u) => { const r = await fetch(u, { headers: H }); return r.ok ? r.json() : { status: r.status }; };
const fr = await j("https://data.sec.gov/api/xbrl/frames/us-gaap/ResearchAndDevelopmentExpense/USD/CY2015Q1.json");
console.log("## R&D frame CY2015Q1 rows", fr.data?.length, JSON.stringify(fr.data?.slice(0, 2)));
const fr2 = await j("https://data.sec.gov/api/xbrl/frames/us-gaap/ResearchAndDevelopmentExpense/USD/CY2015.json");
console.log("## R&D frame CY2015 rows", fr2.data?.length);
const q = (s) => `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(s)}&forms=424B5&dateRange=custom&startdt=2016-01-01&enddt=2016-12-31`;
for (const s of ['"sales agreement"', '"at the market offering"', '"equity distribution agreement"']) {
  const r = await j(q(s));
  console.log(`## efts ${s}`, r.status || "", "total", JSON.stringify(r.hits?.total), "sample", JSON.stringify(r.hits?.hits?.[0]?._source ? { ciks: r.hits.hits[0]._source.ciks, date: r.hits.hits[0]._source.file_date, form: r.hits.hits[0]._source.form, adsh: r.hits.hits[0]._source.adsh, names: r.hits.hits[0]._source.display_names } : null));
}
const r = await j("https://efts.sec.gov/LATEST/search-index?q=%22sales%20agreement%22&forms=424B5&dateRange=custom&startdt=2016-01-01&enddt=2016-12-31&from=100");
console.log("## efts paging from=100", r.hits?.hits?.length, Object.keys(r.hits?.hits?.[0]?._source || {}).join(","));
