/* ------------------------------------------------------------------
   Lets the iOS and Android app call the /api functions. The app's pages
   are served from the phone itself, so its requests come from these
   origins rather than from helixora.pages.dev. Browsers on other
   websites are still refused by each function's sameOrigin check.
------------------------------------------------------------------- */

import { APP_ORIGINS } from "../../server/ask-core.js";

export async function onRequest({ request, next }) {
  const origin = request.headers.get("origin");
  const app = origin && APP_ORIGINS.includes(origin);
  if (request.method === "OPTIONS") {
    if (!app) return new Response(null, { status: 204 });
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    } });
  }
  const res = await next();
  if (!app) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.append("Vary", "Origin");
  return out;
}
