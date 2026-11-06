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

Bands: 0–39 Low, 40–69 Elevated, 70–100 High. The formula lives in `src/fps.js`, which both the site and the nightly data job use, and the site's About us page is generated from it. Change the weights there and add an entry to `FPS_CHANGELOG`.

Every weekday the data job appends each company's score to `public/data/fps-history.json`. The About us page turns that into the public track record: every company that reaches 70, and whether it filed an offering (424B4/424B5) within six months.

## Waitlist

The "Get the Financing Pressure Report by email" form posts to `/api/waitlist`, which stores sign-ups in a Cloudflare D1 database (see Deploy).

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
config/companies.json          tickers Helixora covers (set by the coverage screen)
config/universe.json           coverage rules, turnover policy and change log
config/programs.json           corrections to the automatic program labels
config/assumptions.json        your analyst inputs and drug-name aliases (all optional)
scripts/fetch-data.mjs         builds everything in public/data/ (no dependencies, Node 20+)
scripts/universe.mjs           the monthly coverage screen
scripts/backtest.mjs           historical backtest of the score (results on the Research page)
.github/workflows/refresh-data.yml   runs fetch-data every weekday and commits the result
.github/workflows/universe.yml       runs the coverage screen on the 3rd of each month
.github/workflows/backtest.yml       reruns the backtest on the 5th of each month (about 30 minutes)
functions/api/ask.js           Cloudflare function for the Ask tab; holds the API key
functions/api/waitlist.js      Cloudflare function that stores (and removes) waitlist sign-ups in D1
functions/api/config.js        public settings for the browser (the Turnstile site key)
server/guard.js                rate limits and the Turnstile human check
server/ask-core.js             shared logic behind the Ask tab
src/App.jsx                    the site: pages, navigation and styles
src/fps.js                     the Financing Pressure Score
src/trials.js                  readout windows, success odds, exclusivity, program labels
src/quant.js                   runway and equity simulations, financing model, burn forecast
src/research.js                offering studies used on the Research page
src/data.js                    loads the data files, falls back to sample data
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

Security and caching headers live in `public/_headers`.

### Backtest

`scripts/backtest.mjs` runs today's Financing Pressure Score on every past balance sheet of every cash-burning drug or biotech company (industry codes 2834, 2836, 8731; under $50M of trailing revenue) that filed with the SEC since 2012, including companies that later went bankrupt, were sold or delisted. Each company-quarter uses only figures filed by that date. A "raise" is a 424B4/424B5 offering filing or a 15%+ jump in shares outstanding within the next 12 months. Results go to `public/data/backtest.json` and the Research page.

What it can't test yet: catalyst timing (past expected trial dates aren't available in bulk from ClinicalTrials.gov or AACT, so every company gets the 18-month assumption) and pipeline concentration. Market access uses the public float from each 10-K, because free price history doesn't exist for delisted stocks.

### Security

Already handled in the code:

- Security headers for every page in `public/_headers` (content security policy, HTTPS only, no embedding in other sites).
- `/api/ask` and `/api/waitlist` refuse requests from other websites and limit each visitor (Ask: 6 a minute and 60 a day; waitlist: 5 per 10 minutes). Limits are counted in the D1 database, so they hold across Cloudflare's servers; visitors are stored only as a one-way hash of IP address and date, kept under a day (`server/guard.js`).
- Cloudflare Turnstile human check on Ask, the waitlist and email removal. It turns on when you add the keys below, and stays off until then.
- The Privacy page (`/#privacy`) explains what is collected and lets anyone delete their waitlist email.
- CodeQL scans the code on every push and weekly (`.github/workflows/codeql.yml`); Dependabot proposes security updates.

To turn on Turnstile: Cloudflare → **Turnstile** → **Add widget**, hostname `helixora.pages.dev`, mode **Managed**. Then in the Pages project → **Settings → Variables and Secrets**, add `TURNSTILE_SITE_KEY` (type Text) and `TURNSTILE_SECRET_KEY` (type Secret), and redeploy.

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

## Trials and FDA models

`src/trials.js` holds the drug-development models, shared by the site and the data refresh:

- **Readout windows**: from each trial's ClinicalTrials.gov status, staleness and recorded date slips (`public/data/trial-history.json`). The window's midpoint feeds the Financing Pressure Score.
- **Trial design flags**: size, randomization, blinding, control arm, endpoint type, sites and date changes.
- **Success odds**: published phase-transition rates by disease area (BIO/Informa/QLS 2021), adjusted at half strength for drug type, rare disease and biomarker selection.
- **FDA**: base rates plus a summary of every published complete response letter (openFDA), by office and reason.
- **Read-through**: rival Phase II/III trials in the same diseases, with China-based trials flagged.
- **Exclusivity**: the statutory floor from the approval pathway (12 years BLA, 5 years NCE, 7 years orphan).

How each program is classified lives in `config/programs.json`; edit it to correct a disease area, drug type or rare-disease flag.

## Quant models and prediction log

`src/quant.js`: a Monte Carlo cash survival simulation (burn trend and volatility from past filings, no new financing), a Monte Carlo range of equity values (program success at Helixora's odds, uncertain peak sales and timing) with the peak sales the market price implies, and a logistic financing-risk model tested by leaving each company out. The refresh writes `public/data/predictions.json`, a daily record of published predictions with model versions, never edited after the day it was written.

## More models

- **Trial-duration survival curves** (Kaplan-Meier, about 16,000 industry Phase II/III trials since 2012, still-running trials censored): each registry plan is compared with how long similar trials took; unusually quick plans widen the readout window. Stored in `meta.durations`.
- **Readout scenarios**: approval odds after the current phase succeeds (Bayes' rule on the phase rates) and the value at stake.
- **Valuation scenarios**: bear, base and bull cases and a one-at-a-time sensitivity chart.
- **Burn forecast** (Holt's exponential smoothing) and the likely size and dilution of the next raise.
- **Anomaly alerts**: robust z-scores for burn and price moves, plus new offerings, trial slips and score band changes (same score version only).

## Coverage

Helixora covers 38 companies: 30 chosen by published rules (`config/universe.json`: listed, burning cash, clinical stage, drug-developer industry code, $100M–$5B market value, at least $1M a day traded, an active company-sponsored Phase II or III trial; the 30 with the soonest Phase II/III completions) plus the original 8. `scripts/universe.mjs` re-runs the screen monthly and publishes `public/data/universe.json`; changing coverage stays a manual, approved edit to `config/companies.json`.
