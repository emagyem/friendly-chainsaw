/* ------------------------------------------------------------------
   POST /api/correction: a company (or anyone) reports that something on
   Helixora is wrong (a figure, a date, a classification). Stored in the same
   Cloudflare D1 database as the waitlist (binding WAITLIST), in a
   "corrections" table created on first use.

   To review: D1 → your database → Console, and run
     SELECT * FROM corrections ORDER BY created_at DESC;
------------------------------------------------------------------- */

import { json, sameOrigin } from "../../server/ask-core.js";
import { humanCheck, rateLimit } from "../../server/guard.js";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
const TOPICS = new Set(["financing", "data", "other"]);

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  if (!env.WAITLIST) return json(503, { error: "Corrections can't be received right now" });
  if (!(await rateLimit(env, request, "correction", 5, 3600))) return json(429, { error: "Too many reports; try again later" });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  if (body?.botField) return json(200, { ok: true });
  if (!(await humanCheck(env, request, body?.turnstileToken))) return json(403, { error: "Human check failed; reload the page and try again" });

  const ticker = String(body?.ticker || "").toUpperCase().replace(/[^A-Z.-]/g, "").slice(0, 8);
  const topic = TOPICS.has(body?.topic) ? body.topic : "other";
  const message = String(body?.message || "").trim().slice(0, 2000);
  const email = String(body?.email || "").trim().toLowerCase();
  if (message.length < 10) return json(400, { error: "Tell us what's wrong in a sentence or two" });
  if (email && (email.length > 254 || !EMAIL.test(email))) return json(400, { error: "Enter a valid email address, or leave it blank" });

  try {
    await env.WAITLIST.prepare(
      "CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT, topic TEXT, message TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    ).run();
    await env.WAITLIST.prepare("INSERT INTO corrections (ticker, topic, message, email) VALUES (?1, ?2, ?3, ?4)")
      .bind(ticker || null, topic, message, email || null).run();
  } catch (e) {
    console.error("correction insert failed", e);
    return json(500, { error: "Couldn't save that; try again" });
  }
  return json(200, { ok: true });
}
