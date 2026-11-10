/* ------------------------------------------------------------------
   Logic for the Ask tab, served by functions/api/ask.js on
   Cloudflare Pages.

   The browser sends only a question. The data the model sees is built
   here from the site's own published data file, so the endpoint can't be
   used as a general-purpose AI service on the site's API key.
------------------------------------------------------------------- */

import { computeFPS } from "../src/fps.js";

export const MAX_QUESTION = 400;
const MAX_TOKENS = 600;
// Claude may think before answering; give it room so thinking can't use up the whole budget.
const CLAUDE_MAX_TOKENS = 2000;
const DATA_TTL_MS = 10 * 60 * 1000;
// Cloudflare Workers AI model used when no working Anthropic key is available.
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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
  const all = [...(dataFile.companies || []), ...(dataFile.industry || dataFile.bigPharma || [])];
  return all.map((c) => {
    const f = computeFPS(c, today);
    return {
      ticker: c.t, name: c.n, area: c.area, ...(c.group ? { industry_segment: c.group, operating_cash_flow_ttm_musd: c.ocf ?? null } : {}),
      market_cap_musd: c.mcap, enterprise_value_musd: c.ev, cash_musd: c.cash, debt_musd: c.debt,
      monthly_burn_musd: c.burn, cash_flow_positive: !!c.cashFlowPositive, runway_months: f.runway,
      revenue_ttm_musd: c.rev, shares_out_m: c.shares, share_count_change_24m_pct: c.dil24 ?? null,
      financing_pressure_score: f.score, financing_pressure_band: f.band,
      runway_to_catalyst_gap_months: f.gap, raise_capacity: c.raise?.capacity || null,
      next_major_catalyst: f.catalyst ? { date: f.catalyst.date, days_away: days(f.catalyst.date), event: f.catalyst.label } : null,
      price: c.quote?.price ?? null, price_change_pct: c.quote?.chgPct ?? null,
      programs: (c.pipeline || []).map((p) => ({ drug: p.d, indication: p.ind, phase: p.ph, expected_readout: p.ro })),
      catalysts: (c.catalysts || []).map((x) => ({ date: x.date, days_away: days(x.date), event: x.label })),
      financings: (c.financings || []).map(({ date, type, amt, dil, upTo }) => ({ date, type, amount_musd: amt ?? null, up_to: !!upTo, dilution_pct: dil ?? null })),
      short_interest: c.short ? { as_of: c.short.date, pct_of_shares: c.short.pct, days_to_cover: c.short.dtc, change_3m_pct: c.short.chg3m } : null,
      insider_trades_12m: c.insiders ? { bought_musd: c.insiders.bought, sold_by_choice_musd: c.insiders.sold, sold_10b5_1_plan_musd: c.insiders.planSold, sold_for_taxes_musd: c.insiders.taxSold, large_holders: c.insiders.holders || null } : null,
      note: c.note || null,
    };
  });
}

// A smaller, pre-sorted version of the facts for open models: they answer list
// questions ("who has under 12 months?") far more reliably when the data is short and already ordered.
export function compactFacts(facts) {
  return [...facts]
    .sort((a, b) => (a.runway_months ?? 999) - (b.runway_months ?? 999))
    .map((f) => ({
      ticker: f.ticker, name: f.name, area: f.area, ...(f.industry_segment ? { industry_segment: f.industry_segment, revenue_ttm_musd: f.revenue_ttm_musd } : {}),
      runway_months: f.runway_months, cash_musd: f.cash_musd, monthly_burn_musd: f.monthly_burn_musd,
      financing_pressure_score: f.financing_pressure_score, band: f.financing_pressure_band,
      raise_capacity: f.raise_capacity, market_cap_musd: f.market_cap_musd,
      next_major_catalyst: f.next_major_catalyst,
      programs: (f.programs || []).slice(0, 4).map((p) => `${p.drug} (${p.phase}, ${p.indication})`),
    }));
}

let cache = { at: 0, facts: null, asOf: null };

// loadDataFile: async () => parsed contents of /data/companies.json
// ai: the Workers AI binding (env.AI), used when the Anthropic key is missing or rejected.
export async function answer({ question, apiKey, model, loadDataFile, ai }) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q || q.length > MAX_QUESTION) return json(400, { error: `Questions must be 1 to ${MAX_QUESTION} characters` });
  if (!apiKey && !ai) return json(503, { error: "Ask is not configured" });

  if (!cache.facts || Date.now() - cache.at > DATA_TTL_MS) {
    try {
      const file = await loadDataFile();
      cache = { at: Date.now(), facts: buildFacts(file), asOf: file.meta?.generatedAt || null };
    } catch (e) {
      console.error("Could not load site data", e);
      return json(502, { error: "Data is unavailable right now" });
    }
  }

  const prompt = `You are the research assistant on Helixora, a biotech financing-risk research site. Answer only from the JSON dataset below. Never invent a company, number, or date that is not present. Cite the specific figures you used inline, in plain prose, e.g. "$412M cash against $21.5M monthly burn". If the data cannot answer the question, say exactly what is missing. If the question is not about the companies in the dataset, say you can only answer questions about them. Do not give buy or sell recommendations. Companies with an industry_segment (big-pharma, generics, otc, api, orphan, compounding) are established drug-industry companies tracked for comparison: leave them out of lists about runway, financing pressure or who may need to raise money unless the question asks about them. Keep the answer under 180 words, no markdown headers, no bullet symbols other than plain hyphens. End with one line beginning "Worth checking:" naming the single assumption that most affects the conclusion.

DATA (all dollar figures in millions USD). Figures come from SEC EDGAR filings, ClinicalTrials.gov and previous-close market prices, refreshed ${cache.asOf || "recently"}. Trial readout dates are registry estimates. The Financing Pressure Score (0-100) estimates how likely a company is to need new money before its next major catalyst.
${JSON.stringify(cache.facts)}

QUESTION: ${q}`;

  let claudeError = null;
  if (apiKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: model || "claude-sonnet-5-5", max_tokens: CLAUDE_MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
      });
      const body = await r.json();
      if (r.ok) {
        const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) return json(200, { text, engine: "claude" });
        // An empty answer: say why (stop reason and block types), then fall back below.
        claudeError = { reason: "empty_answer", detail: `stop_reason=${body.stop_reason}; blocks=${(body.content || []).map((b) => b.type).join(",") || "none"}` };
        console.error("Claude returned no text", claudeError.detail);
      } else {
        console.error("Anthropic API error", r.status, body?.error?.type);
        // The error type (e.g. authentication_error) helps diagnose setup problems and reveals nothing secret.
        claudeError = { reason: body?.error?.type || `HTTP ${r.status}`, detail: (body?.error?.message || "").slice(0, 160) };
      }
    } catch (e) {
      console.error(e);
      claudeError = { reason: "network", detail: "Could not reach the model" };
    }
  }

  if (ai) {
    try {
      const short = `You are the research assistant on Helixora, a biotech financing-risk research site. Answer only from the data below; never invent a company, number or date. The companies are listed in order of runway_months, shortest first. When a question sets a threshold (for example "within 12 months" or "under 18 months of cash"), include exactly the companies whose runway_months meets it and no others, checking each number. Cite the figures you used, like "$69M cash against $16.8M monthly burn, 4.1 months". No buy or sell recommendations. Companies with an industry_segment (big-pharma, generics, otc, api, orphan, compounding) are established drug-industry companies tracked for comparison: leave them out of lists about runway, financing pressure or who may need to raise money unless the question asks about them. Under 180 words, plain prose or plain hyphen lists, no headers. End with one line starting "Worth checking:" naming the assumption that matters most.

DATA (dollar figures in millions USD, refreshed ${cache.asOf || "recently"}):
${JSON.stringify(compactFacts(cache.facts))}

QUESTION: ${q}`;
      const out = await ai.run(WORKERS_AI_MODEL, { messages: [{ role: "user", content: short }], max_tokens: MAX_TOKENS, temperature: 0.2 });
      const text = (typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "")).trim();
      if (text) return json(200, { text, engine: "workers-ai", ...(claudeError ? { claudeError: claudeError.reason, claudeDetail: claudeError.detail } : {}) });
    } catch (e) {
      console.error("Workers AI error", e);
      return json(502, { error: "The model request failed", reason: "workers_ai", detail: String(e?.message || e).slice(0, 160), claudeError: claudeError?.reason });
    }
  }
  return json(502, { error: "The model request failed", ...(claudeError || {}) });
}
