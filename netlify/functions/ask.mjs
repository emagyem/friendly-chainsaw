/* ------------------------------------------------------------------
   POST /api/ask  — Netlify Function for the Ask tab.

   Holds the Anthropic API key on the server so it never ships to the
   browser. Set these in Netlify → Site configuration → Environment variables:
     ANTHROPIC_API_KEY   required
     ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5

   Anyone who finds the deployed site can call this endpoint, so set a
   monthly spend limit on the API key in the Anthropic Console.
------------------------------------------------------------------- */

const MAX_QUESTION = 500;
const MAX_DATA_CHARS = 250_000;

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Use POST" }, { Allow: "POST" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(503, { error: "ANTHROPIC_API_KEY is not configured" });

  let payload;
  try { payload = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const { question, data, live, asOf } = payload || {};
  if (typeof question !== "string" || !question.trim() || question.length > MAX_QUESTION) {
    return json(400, { error: `question must be 1-${MAX_QUESTION} characters` });
  }
  const dataJson = JSON.stringify(data ?? []);
  if (!Array.isArray(data) || dataJson.length > MAX_DATA_CHARS) {
    return json(400, { error: "data must be the terminal's company array" });
  }

  const provenance = live
    ? `Figures come from SEC EDGAR filings, ClinicalTrials.gov and a stock price feed, refreshed ${asOf || "recently"}. Trial readout dates are registry estimates. Any input listed in a company's placeholder_inputs is a default, not research; say so if your answer depends on one.`
    : "This is a fictional sample dataset for a prototype.";

  const prompt = `You are the research assistant inside a biotech investment research terminal. Answer only from the JSON dataset below. Never invent a company, number, or date that is not present. Cite the specific figures you used inline, in plain prose, e.g. "$412M cash against $21.5M monthly burn". If the data cannot answer the question, say exactly what is missing. Do not give buy or sell recommendations. Keep the answer under 180 words, no markdown headers, no bullet symbols other than plain hyphens. End with one line beginning "Worth checking:" naming the single assumption that most affects the conclusion.

DATA (all dollar figures in millions USD). ${provenance}
${dataJson}

QUESTION: ${question.trim()}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const body = await r.json();
    if (!r.ok) {
      console.error("Anthropic API error", r.status, body?.error);
      return json(502, { error: "The model request failed" });
    }
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return json(200, { text });
  } catch (e) {
    console.error(e);
    return json(502, { error: "Could not reach the model" });
  }
}

// Serve this function at /api/ask (the path the app calls).
export const config = { path: "/api/ask" };
