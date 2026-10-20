/* ------------------------------------------------------------------
   POST /api/ask  — Netlify Function for the Ask tab.

   Holds the Anthropic API key on the server so it never ships to the
   browser. Set these in Netlify → Site configuration → Environment variables:
     ANTHROPIC_API_KEY   required
     ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5

   Abuse protection:
   - The browser sends only the question. The data the model sees is built
     here from the site's own published data file, so nobody can use this
     endpoint as a general-purpose AI service on your key.
   - Requests from other websites are refused.
   - Each visitor is rate-limited (see config at the bottom).
   - Answers are capped in length.
   Still set a monthly spend limit on the API key in the Anthropic Console.
------------------------------------------------------------------- */

import { computeFPS } from "../../src/fps.js";

const MAX_QUESTION = 400;
const MAX_TOKENS = 600;
const DATA_TTL_MS = 10 * 60 * 1000;

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

let cache = { at: 0, origin: null, facts: null, asOf: null };

// Build the compact dataset the model answers from, using the site's own published data.
async function loadFacts(origin) {
  if (cache.facts && cache.origin === origin && Date.now() - cache.at < DATA_TTL_MS) return cache;
  const res = await fetch(`${origin}/data/companies.json`);
  if (!res.ok) throw new Error(`data file returned ${res.status}`);
  const j = await res.json();
  const today = new Date();
  const days = (iso) => Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
  const facts = (j.companies || []).map((c) => {
    const f = computeFPS(c, today);
    return {
      ticker: c.t, name: c.n, area: c.area,
      market_cap_musd: c.mcap, enterprise_value_musd: c.ev, cash_musd: c.cash, debt_musd: c.debt,
      monthly_burn_musd: c.burn, cash_flow_positive: !!c.cashFlowPositive, runway_months: f.runway,
      revenue_ttm_musd: c.rev, shares_out_m: c.shares, share_count_change_24m_pct: c.dil24 ?? null,
      financing_pressure_score: f.score, financing_pressure_band: f.band,
      runway_to_catalyst_gap_months: f.gap, raise_capacity: c.raise?.capacity || null,
      next_major_catalyst: f.catalyst ? { date: f.catalyst.date, days_away: days(f.catalyst.date), event: f.catalyst.label } : null,
      price: c.quote?.price ?? null, price_change_pct: c.quote?.chgPct ?? null,
      programs: (c.pipeline || []).map((p) => ({ drug: p.d, indication: p.ind, phase: p.ph, expected_readout: p.ro })),
      catalysts: (c.catalysts || []).map((x) => ({ date: x.date, days_away: days(x.date), event: x.label })),
      financings: (c.financings || []).map(({ date, type }) => ({ date, type })),
      note: c.note || null,
    };
  });
  cache = { at: Date.now(), origin, facts, asOf: j.meta?.generatedAt || null };
  return cache;
}

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Use POST" }, { Allow: "POST" });

  // Only this site's own pages may call the endpoint from a browser.
  const origin = new URL(req.url).origin;
  const from = req.headers.get("origin");
  if (from && from !== origin) return json(403, { error: "Not allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(503, { error: "Ask is not configured" });

  let payload;
  try { payload = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (!question || question.length > MAX_QUESTION) {
    return json(400, { error: `Questions must be 1 to ${MAX_QUESTION} characters` });
  }

  let data;
  try { data = await loadFacts(origin); } catch (e) {
    console.error("Could not load site data", e);
    return json(502, { error: "Data is unavailable right now" });
  }

  const prompt = `You are the research assistant on Helixora, a biotech financing-risk research site. Answer only from the JSON dataset below. Never invent a company, number, or date that is not present. Cite the specific figures you used inline, in plain prose, e.g. "$412M cash against $21.5M monthly burn". If the data cannot answer the question, say exactly what is missing. If the question is not about the companies in the dataset, say you can only answer questions about them. Do not give buy or sell recommendations. Keep the answer under 180 words, no markdown headers, no bullet symbols other than plain hyphens. End with one line beginning "Worth checking:" naming the single assumption that most affects the conclusion.

DATA (all dollar figures in millions USD). Figures come from SEC EDGAR filings, ClinicalTrials.gov and previous-close market prices, refreshed ${data.asOf || "recently"}. Trial readout dates are registry estimates. The Financing Pressure Score (0-100) estimates how likely a company is to need new money before its next major catalyst.
${JSON.stringify(data.facts)}

QUESTION: ${question}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.error("Anthropic API error", r.status, body?.error?.type);
      return json(502, { error: "The model request failed" });
    }
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return json(200, { text });
  } catch (e) {
    console.error(e);
    return json(502, { error: "Could not reach the model" });
  }
}

export const config = {
  path: "/api/ask",
  method: "POST",
  // Each visitor (by IP) gets at most 6 questions a minute; extra requests receive HTTP 429.
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
