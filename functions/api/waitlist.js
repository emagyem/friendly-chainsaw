/* ------------------------------------------------------------------
   POST /api/waitlist on Cloudflare Pages: stores waitlist sign-ups in a
   Cloudflare D1 database (free tier).

   Setup, once: create a D1 database (Storage & Databases → D1), then in
   the Pages project → Settings → Bindings, add a D1 binding with the
   variable name WAITLIST pointing at it. The table is created on first use.

   To see sign-ups: D1 → your database → Console, and run
     SELECT email, role, created_at FROM waitlist ORDER BY created_at DESC;
------------------------------------------------------------------- */

import { json, makeLimiter, sameOrigin } from "../../server/ask-core.js";

const ROLES = new Set(["", "Fund analyst or PM", "Family office", "Independent investor", "Biotech operator", "Other"]);
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
const allow = makeLimiter(5, 10 * 60 * 1000);

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  if (!env.WAITLIST) return json(503, { error: "Sign-ups aren't open yet" });

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!allow(ip)) return json(429, { error: "Too many attempts; try again later" });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }

  // Honeypot: real visitors never see this field. Pretend success so bots learn nothing.
  if (body?.botField) return json(200, { ok: true });

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!email || email.length > 254 || !EMAIL.test(email)) return json(400, { error: "Enter a valid email address" });
  if (!ROLES.has(role)) return json(400, { error: "Unknown role" });

  try {
    await env.WAITLIST.prepare(
      "CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, role TEXT, country TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    ).run();
    await env.WAITLIST.prepare("INSERT OR IGNORE INTO waitlist (email, role, country) VALUES (?1, ?2, ?3)")
      .bind(email, role || null, request.cf?.country || null).run();
    return json(200, { ok: true });
  } catch (e) {
    console.error("Waitlist write failed", e);
    return json(500, { error: "Couldn't save your sign-up; try again" });
  }
}

export function onRequest() {
  return json(405, { error: "Use POST" }, { Allow: "POST" });
}
