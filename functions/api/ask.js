/* ------------------------------------------------------------------
   POST /api/ask on Cloudflare Pages.

   Needs one secret, set in Cloudflare → Workers & Pages → (project)
   → Settings → Variables and Secrets:
     ANTHROPIC_API_KEY   (type: Secret) optional: Claude answers when it works
     ANTHROPIC_MODEL     optional, defaults to claude-sonnet-5-5
   Without a working key, Ask uses Cloudflare Workers AI through the AI
   binding declared in wrangler.toml (no key needed; free daily allowance).
     TURNSTILE_SECRET_KEY  optional (Secret): turns on the human check
   Also set a monthly spend limit on the key in the Anthropic Console.
------------------------------------------------------------------- */

import { answer, json, sameOrigin } from "../../server/ask-core.js";
import { humanCheck, rateLimit } from "../../server/guard.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  // Up to 6 questions a minute and 60 a day per visitor, across all servers.
  if (!(await rateLimit(env, request, "ask-min", 6, 60)) || !(await rateLimit(env, request, "ask-day", 60, 86400)))
    return json(429, { error: "Too many questions; wait a minute" });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  if (!(await humanCheck(env, request, payload?.turnstileToken))) return json(403, { error: "Human check failed; reload the page and try again" });

  return answer({
    question: payload?.question,
    apiKey: (env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, ""), // pasted keys often carry a line break or quotes
    model: (env.ANTHROPIC_MODEL || "").trim() || undefined,
    ai: env.AI,
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
