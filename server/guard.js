/* ------------------------------------------------------------------
   Abuse protection shared by the /api functions.

   rateLimit: counts requests per visitor in the D1 database bound as
   WAITLIST, so the limit holds across every Cloudflare server. Visitors
   are stored only as a one-way hash of their IP address and the date,
   and rows expire within a day. Without the database it falls back to
   a per-server count in memory.

   humanCheck: verifies a Cloudflare Turnstile token when the
   TURNSTILE_SECRET_KEY secret is set. Without it, the check is skipped,
   so the site keeps working before Turnstile is set up.
------------------------------------------------------------------- */

import { makeLimiter } from "./ask-core.js";

const memory = new Map();

async function visitorKey(request, route) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${route}|${day}|${ip}`));
  return route + ":" + [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function rateLimit(env, request, route, max, windowSec) {
  const key = await visitorKey(request, route);
  const db = env.WAITLIST;
  if (!db) {
    if (!memory.has(route)) memory.set(route, makeLimiter(max, windowSec * 1000));
    return memory.get(route)(key);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)").run();
    const row = await db.prepare(
      `INSERT INTO rate_limits (k, n, reset) VALUES (?1, 1, ?2)
       ON CONFLICT(k) DO UPDATE SET
         n = CASE WHEN reset <= ?3 THEN 1 ELSE n + 1 END,
         reset = CASE WHEN reset <= ?3 THEN ?2 ELSE reset END
       RETURNING n`
    ).bind(key, now + windowSec, now).first();
    if (Math.random() < 0.02) await db.prepare("DELETE FROM rate_limits WHERE reset < ?1").bind(now - 86400).run();
    return (row?.n ?? 1) <= max;
  } catch (e) {
    console.error("Rate limit check failed", e);
    return true; // never lock real visitors out because the counter failed
  }
}

export async function humanCheck(env, request, token) {
  const secret = (env.TURNSTILE_SECRET_KEY || "").trim(); // pasted keys often carry a trailing line break
  if (!secret) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const out = await r.json();
    return out.success === true;
  } catch (e) {
    console.error("Turnstile check failed", e);
    return false;
  }
}
