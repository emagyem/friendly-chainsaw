# Helixora

Helixora tells you which biotechs have to raise money, and when. Know who has to raise, before they do.

A biotech research terminal. It puts the three clocks a biotech investor watches on one screen: **when the trial reads out, when the cash runs out, and when the next raise dilutes shareholders.**

- **Scan**: upcoming catalysts across the universe, plus a runway-vs-catalyst chart that shows who may need to raise first
- **Screen**: filter by therapeutic area, phase, market cap, runway and catalyst timing
- **Company**: cash runway with a raise simulator, dilution estimator, risk-adjusted pipeline value (rNPV), catalyst timeline and a composite score. Click any figure to see where it came from.
- **Compare**: three companies on one set of definitions
- **Ask**: plain-English questions answered only from the terminal's own data

Built with React, Vite and Recharts.

## The Financing Pressure Score

Helixora's signature metric: one number from 0 to 100 for one question, *how likely is this company to need new money before its next major catalyst?* It is research, not a buy or sell signal.

| Component | Weight | Scored from |
|---|---|---|
| Runway-to-catalyst gap | 35% | Cash ÷ monthly burn, minus (months to next clinical/regulatory event + 6-month buffer) |
| Burn trend | 15% | Trailing-twelve-month burn vs a year earlier (SEC XBRL) |
| Raise-ready capacity | 20% | Shelf (S-3) and at-the-market sales agreements found in SEC filings |
| Debt due within 24 months | 10% | Current debt and scheduled maturities vs cash |
| Market access | 10% | Annual burn as a share of market value |
| Pipeline concentration | 10% | Number of clinical programs |

Bands: 0–39 Low, 40–69 Elevated, 70–100 High. The formula lives in `src/fps.js`, which both the site and the nightly data job use, and the site's Methodology page is generated from it. Change the weights there and add an entry to `FPS_CHANGELOG`.

Every weekday the data job appends each company's score to `public/data/fps-history.json`. The Methodology page turns that into the public track record: every company that reaches 70, and whether it filed an offering (424B4/424B5) within six months.

## Waitlist

The "Get the Financing Pressure Report by email" form posts to `/api/waitlist`, which stores sign-ups in a Cloudflare D1 database (see Deploy). If that endpoint doesn't exist (the old Netlify site), the form falls back to Netlify Forms.

## Where the data comes from

| What | Source | How |
|---|---|---|
| Cash, investments, debt, revenue, shares outstanding | [SEC EDGAR](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) XBRL company facts | Latest 10-Q / 10-K balance sheet |
| Monthly cash burn | SEC EDGAR | Trailing twelve-month operating cash flow ÷ 12 |
| Share count growth, offering history | SEC EDGAR | Cover-page share counts over 24 months; 424B4/424B5 prospectus filings |
| Pipeline: phase, enrollment, indication, endpoint, readout date | [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api) | Active interventional trials led by the company, grouped by drug |
| Market cap, enterprise value | Stock price × SEC share count | Alpha Vantage if a key is set, otherwise Yahoo Finance |
| Peak sales, mechanism, partners, PDUFA dates, thesis notes | **You**, in `config/assumptions.json` | No API knows these; the app labels any default as a placeholder |

A GitHub Action rebuilds `public/data/companies.json` every weekday morning. If that file doesn't exist yet, the app runs on a built-in fictional sample dataset and says so in the header.

## Project layout

```
config/companies.json          tickers to track
config/assumptions.json        your analyst inputs (all optional)
scripts/fetch-data.mjs         builds public/data/companies.json (no dependencies, Node 20+)
.github/workflows/refresh-data.yml   runs the script on a schedule and commits the result
netlify/functions/ask.mjs      serverless function for the Ask tab; holds the API key
netlify.toml                   Netlify build settings
src/App.jsx                    the terminal UI and all calculations
src/data.js                    loads the data file, falls back to sample data
src/sampleData.js              fictional sample dataset
```

## Setup

### 1. Turn on the nightly data refresh

1. In your GitHub repo, go to **Settings → Secrets and variables → Actions → Variables** and add `SEC_CONTACT_EMAIL` with your email. The SEC requires a contact on automated requests and blocks requests without one.
2. Optional: under **Secrets**, add `ALPHA_VANTAGE_KEY` ([free key](https://www.alphavantage.co/support/#api-key)) for a more reliable price feed.
3. Go to **Settings → Actions → General → Workflow permissions** and select **Read and write permissions**, so the workflow can commit the data file.
4. On the **Actions** tab, open **Refresh data** and click **Run workflow**. The log lists each company, plus any ticker it had to skip and why.

### 2. Deploy on Cloudflare Pages

The site, the Ask function (`functions/api/ask.js`) and the waitlist (`functions/api/waitlist.js`) all run on Cloudflare Pages' free plan.

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick this repo.
2. Build settings: framework preset **Vite** (or none), build command `npm run build`, output directory `dist`. Node 22 is picked up from `.nvmrc`.
3. **Settings → Variables and Secrets**: add `ANTHROPIC_API_KEY` as a **Secret**. Set a monthly spend limit on that key in the Anthropic Console.
4. **Storage & Databases → D1 → Create** a database (for example `helixora-waitlist`), then in the Pages project **Settings → Bindings → Add → D1 database** with variable name `WAITLIST`. Redeploy. The table is created on the first sign-up.
5. Each data-refresh commit triggers a new build automatically.

To read sign-ups: D1 → the database → **Console**, run `SELECT email, role, created_at FROM waitlist ORDER BY created_at DESC;`

Security and caching headers live in `public/_headers`. The `netlify/` folder, `netlify.toml` and `public/__forms.html` are only needed while the old Netlify site is still running.

### 3. Run locally

```bash
npm install
npm run dev

# Pull fresh data to your machine (optional)
SEC_USER_AGENT="Your Name you@example.com" npm run fetch-data
```

## Customizing

- **Track different companies**: edit the list in `config/companies.json`.
- **Add your research**: in `config/assumptions.json`, give programs real peak sales, mechanisms and company-guided readout dates; add PDUFA dates and conferences as catalysts; write a one-line thesis per company. The file's `_readme` lists every field.
- **If a company is skipped** with "no active trials found", its ClinicalTrials.gov sponsor name differs from its SEC name. Set `"sponsor"` for that ticker.

## Known limits

- Trial readout dates are *primary completion* dates from the registry, which are estimates. Topline data usually follows by weeks to months. Override them with company guidance in `assumptions.json`.
- Offering filings show when a company raised, not how much; add sizes in `assumptions.json` if you need them.
- XBRL tagging varies between companies. If a figure looks off, the popover links to the filing it came from.

Research and screening tool only; nothing here is investment advice.
