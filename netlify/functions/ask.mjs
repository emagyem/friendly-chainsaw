/* ------------------------------------------------------------------
   POST /api/ask on Netlify. Kept while the site moves to Cloudflare;
   the logic is shared with functions/api/ask.js in server/ask-core.js.
------------------------------------------------------------------- */

import { answer, json, sameOrigin } from "../../server/ask-core.js";

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "Use POST" }, { Allow: "POST" });
  if (!sameOrigin(req)) return json(403, { error: "Not allowed" });

  let payload;
  try { payload = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }

  const origin = new URL(req.url).origin;
  return answer({
    question: payload?.question,
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    loadDataFile: async () => {
      const res = await fetch(`${origin}/data/companies.json`);
      if (!res.ok) throw new Error(`data file returned ${res.status}`);
      return res.json();
    },
  });
}

export const config = {
  path: "/api/ask",
  method: "POST",
  // Each visitor (by IP) gets at most 6 questions a minute; extra requests receive HTTP 429.
  rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
