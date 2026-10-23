/* ------------------------------------------------------------------
   Shared logic for the Ask tab, used by both hosts:
     functions/api/ask.js          Cloudflare Pages
     netlify/functions/ask.mjs     Netlify (kept during the move)

   The browser sends only a question. The data the model sees is built
   here from the site's own published data file, so the endpoint can't be
   used as a general-purpose AI service on the site's API key.
------------------------------------------------------------------- */

import { computeFPS } from "../src/fps.js";

export const MAX_QUESTION = 400;
const MAX_TOKENS = 600;
const DATA_TTL_MS = 10 * 60 * 1000;

export const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

// Best-effort per-visitor limit, kept in the memory of each running instance.
export function makeLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

// Refuse browser requests that come from another website.
export function sameOrigin(request) {
  const from = request.headers.get("origin");
  return !from || from === new URL(request.url).origin;
}

export function buildFacts(dataFile, today = new Date()) {
  const days = (iso) => Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
  return (dataFile.companies || []).map((c) => {
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
}

let cache = { at: 0, facts: null, asOf: null };

// loadDataFile: async () => parsed contents of /data/companies.json
export async function answer({ question, apiKey, model, loadDataFile }) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q || q.length > MAX_QUESTION) return json(400, { error: `Questions must be 1 to ${MAX_QUESTION} characters` });
  if (!apiKey) return json(503, { error: "Ask is not configured" });

  if (!cache.facts || Date.now() - cache.at > DATA_TTL_MS) {
    try {
      const file = await loadDataFile();
      cache = { at: Date.now(), facts: buildFacts(file), asOf: file.meta?.generatedAt || null };
    } catch (e) {
      console.error("Could not load site data", e);
      return json(502, { error: "Data is unavailable right now" });
    }
  }

  const prompt = `You are the research assistant on Helixora, a biotech financing-risk research site. Answer only from the JSON dataset below. Never invent a company, number, or date that is not present. Cite the specific figures you used inline, in plain prose, e.g. "$412M cash against $21.5M monthly burn". If the data cannot answer the question, say exactly what is missing. If the question is not about the companies in the dataset, say you can only answer questions about them. Do not give buy or sell recommendations. Keep the answer under 180 words, no markdown headers, no bullet symbols other than plain hyphens. End with one line beginning "Worth checking:" naming the single assumption that most affects the conclusion.

DATA (all dollar figures in millions USD). Figures come from SEC EDGAR filings, ClinicalTrials.gov and previous-close market prices, refreshed ${cache.asOf || "recently"}. Trial readout dates are registry estimates. The Financing Pressure Score (0-100) estimates how likely a company is to need new money before its next major catalyst.
${JSON.stringify(cache.facts)}

QUESTION: ${q}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model || "claude-sonnet-5-5", max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
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
