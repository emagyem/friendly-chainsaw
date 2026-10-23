/* ------------------------------------------------------------------
   POST /api/ask on Cloudflare Pages.

   Needs one secret, set in Cloudflare → Workers & Pages → (project)
   → Settings → Variables and Secrets:
     ANTHROPIC_API_KEY   (type: Secret)
     ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5
   Also set a monthly spend limit on the key in the Anthropic Console.
------------------------------------------------------------------- */

import { answer, json, makeLimiter, sameOrigin } from "../../server/ask-core.js";

// Up to 6 questions a minute per visitor, per running instance.
const allow = makeLimiter(6, 60 * 1000);

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!allow(ip)) return json(429, { error: "Too many questions; wait a minute" });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }

  return answer({
    question: payload?.question,
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
    // Read the published data file straight from this deployment's static files.
    loadDataFile: async () => {
      const res = await env.ASSETS.fetch(new URL("/data/companies.json", request.url));
      if (!res.ok) throw new Error(`data file returned ${res.status}`);
      return res.json();
    },
  });
}

export function onRequest() {
  return json(405, { error: "Use POST" }, { Allow: "POST" });
}
