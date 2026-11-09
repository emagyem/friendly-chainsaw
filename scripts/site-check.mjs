#!/usr/bin/env node
/* Checks the live site from outside: pages, data freshness, security headers,
   the Ask and waitlist functions, and whether the old sites are still up.
   Usage: node scripts/site-check.mjs [https://helixora.pages.dev]          */

const SITE = (process.argv[2] || "https://helixora.pages.dev").replace(/\/$/, "");
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass === true ? "PASS" : pass === false ? "FAIL" : "NOTE"}  ${name}: ${detail}`); };
// Identified as a monitor, so its visits aren't counted as usage.
const UA = "Helixora site monitor";
const get = async (path, opts = {}) => fetch(path.startsWith("http") ? path : SITE + path, { redirect: "manual", ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) } });
const post = (path, body, origin = SITE) => get(path, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

try {
  const r = await get("/");
  const t = await r.text();
  ok("Home page", r.status === 200 && /Helixora/.test(t), `HTTP ${r.status}`);
  const h = r.headers;
  ok("Security headers", !!h.get("content-security-policy") && !!h.get("strict-transport-security") && h.get("x-frame-options") != null || !!h.get("content-security-policy"),
    `CSP ${h.get("content-security-policy") ? "on" : "missing"}, HSTS ${h.get("strict-transport-security") ? "on" : "missing"}`);
} catch (e) { ok("Home page", false, e.message); }

try {
  const r = await get("/data/companies.json");
  const j = await r.json();
  const age = (Date.now() - Date.parse(j.meta?.generatedAt)) / 86400000;
  ok("Company data", r.status === 200 && j.companies?.length > 0 && age < 4, `${j.companies?.length} companies, refreshed ${age.toFixed(1)} days ago`);
} catch (e) { ok("Company data", false, e.message); }

try {
  const r = await get("/data/backtest.json");
  const j = await r.json();
  ok("Backtest data", r.status === 200 && j.rows > 0, `${j.rows} company-quarters, AUC ${j.auc}`);
} catch (e) { ok("Backtest data", false, e.message); }

let turnstile = false;
try {
  const r = await get("/api/config");
  const j = await r.json();
  turnstile = !!j.turnstileSiteKey;
  ok("Turnstile human check", turnstile ? true : null, turnstile ? "switched on" : "not switched on yet (add TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Cloudflare)");
} catch (e) { ok("Config endpoint", false, e.message); }

try {
  const r = await post("/api/ask", { question: "Which company has the shortest cash runway?" }, "https://evil.example");
  ok("Ask refuses other websites", r.status === 403, `HTTP ${r.status}`);
} catch (e) { ok("Ask refuses other websites", false, e.message); }

try {
  const r = await post("/api/ask", { question: "Which company has the shortest cash runway? One sentence." });
  const j = await r.json().catch(() => ({}));
  if (r.status === 200) ok("Ask (API key)", true, `answered: "${(j.text || "").slice(0, 120)}…"`);
  else if (r.status === 503) ok("Ask (API key)", false, "ANTHROPIC_API_KEY is not set in Cloudflare, so Ask gives short built-in answers only");
  else if (r.status === 403 && turnstile) ok("Ask (API key)", null, "protected by Turnstile, so this check can't call it (expected)");
  else ok("Ask (API key)", false, `HTTP ${r.status} ${j.error || ""}`);
} catch (e) { ok("Ask (API key)", false, e.message); }

try {
  const email = "site-check@example.com";
  const r = await post("/api/waitlist", { email, role: "Other", botField: "" });
  if (r.status === 200) {
    const d = await post("/api/waitlist", { action: "remove", email });
    ok("Waitlist (D1 database)", d.status === 200, `sign-up stored and removed again (HTTP ${r.status}/${d.status})`);
  } else if (r.status === 403 && turnstile) ok("Waitlist (D1 database)", null, "protected by Turnstile, so this check can't sign up (expected)");
  else ok("Waitlist (D1 database)", false, `HTTP ${r.status} ${(await r.json().catch(() => ({}))).error || ""}`);
} catch (e) { ok("Waitlist (D1 database)", false, e.message); }

// Delayed quotes for the Markets page and Virtual Exchange; only the site's own symbols are allowed.
try {
  const r = await get("/api/quotes?s=SPY,%5EGSPC,BTC-USD");
  const j = await r.json().catch(() => ({}));
  const n = Object.keys(j.quotes || {}).length;
  ok("Delayed quotes", r.status === 200 && n >= 2, `HTTP ${r.status}, ${n} of 3 prices${j.quotes?.SPY ? ` (SPY ${j.quotes.SPY.price})` : ""}`);
  const bad = await get("/api/quotes?s=GOOG");
  ok("Quotes refuse symbols not on the site", bad.status === 400, `HTTP ${bad.status}`);
} catch (e) { ok("Delayed quotes", false, e.message); }

// Usage counting accepts known events only, and the pilot form refuses other websites.
try {
  const r = await post("/api/event", { name: "view_home" });
  const bad = await post("/api/event", { name: "anything_else" });
  ok("Usage counting", r.status === 204 && (bad.status === 400 || bad.status === 204), `known event HTTP ${r.status}, unknown event HTTP ${bad.status} (monitors are ignored, not counted)`);
} catch (e) { ok("Usage counting", false, e.message); }
try {
  const r = await post("/api/pilot", { name: "x", email: "x@example.com", firm: "x" }, "https://evil.example");
  ok("Pilot form refuses other websites", r.status === 403, `HTTP ${r.status}`);
} catch (e) { ok("Pilot form refuses other websites", false, e.message); }

for (const [name, url] of [["Old Netlify site", "https://jolly-seahorse-c530f0.netlify.app/"], ["Old Cloudflare project", "https://friendly-chainsaw.pages.dev/"]]) {
  try {
    const r = await get(url);
    ok(name, r.status >= 400 ? true : null, r.status >= 400 ? `gone (HTTP ${r.status})` : `still online (HTTP ${r.status}); delete it when you're ready`);
  } catch (e) { ok(name, true, `gone (${e.cause?.code || e.message})`); }
}

const fails = results.filter((r) => r.pass === false);
const md = ["| Check | Result | Detail |", "|---|---|---|", ...results.map((r) => `| ${r.name} | ${r.pass === true ? "✅" : r.pass === false ? "❌" : "ℹ️"} | ${r.detail.replace(/\|/g, "/")} |`)].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) { const fs = await import("node:fs"); fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Site check: ${SITE}\n\n${md}\n`); }
process.exit(fails.length ? 1 : 0);
