/* ------------------------------------------------------------------
   POST /api/pilot: a fund, bank or company asks for a pilot or a plan.
   Stored in the D1 database bound as WAITLIST, table "pilots" (created on
   first use). To read them: D1 → your database → Console →
     SELECT * FROM pilots ORDER BY created_at DESC;
------------------------------------------------------------------- */

import { json, sameOrigin } from "../../server/ask-core.js";
import { humanCheck, rateLimit } from "../../server/guard.js";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
const PLANS = new Set(["institutional-pilot", "institutional", "professional", "data", "other"]);
const ROLES = new Set(["Hedge or crossover fund", "Long-only or mutual fund", "Venture capital", "Investment bank", "Biotech company", "Consultant or advisor", "Individual investor", "Other"]);
const clean = (v, n) => String(v || "").split("").map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch)).join("").trim().slice(0, n);

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  if (!env.WAITLIST) return json(503, { error: "Requests can't be received right now" });
  if (!(await rateLimit(env, request, "pilot", 5, 3600))) return json(429, { error: "Too many requests; try again later" });

  let b;
  try { b = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  if (b?.botField) return json(200, { ok: true });
  if (!(await humanCheck(env, request, b?.turnstileToken))) return json(403, { error: "Human check failed; reload the page and try again" });

  const email = clean(b?.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return json(400, { error: "Enter a valid work email" });
  const name = clean(b?.name, 120), firm = clean(b?.firm, 160), note = clean(b?.note, 2000);
  const role = ROLES.has(b?.role) ? b.role : "Other";
  const plan = PLANS.has(b?.plan) ? b.plan : "other";
  if (!name || !firm) return json(400, { error: "Add your name and firm" });

  try {
    await env.WAITLIST.prepare(
      "CREATE TABLE IF NOT EXISTS pilots (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, firm TEXT NOT NULL, role TEXT, plan TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    ).run();
    await env.WAITLIST.prepare("INSERT INTO pilots (name, email, firm, role, plan, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(name, email, firm, role, plan, note || null).run();
  } catch (e) {
    console.error("pilot insert failed", e);
    return json(500, { error: "Couldn't save that; try again" });
  }
  return json(200, { ok: true });
}
