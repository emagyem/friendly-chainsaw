/* ------------------------------------------------------------------
   /api/devices: push alerts for the phone app.

   The app sends its push address (a random code from Apple or Google)
   and the tickers on its watchlist. Nothing else is stored: no name,
   no email, no location. Stored in the D1 database bound as WAITLIST,
   in a "devices" table created on first use.

   POST { action: "register", token, platform: "ios" | "android", tickers: [...] }
   POST { action: "remove", token }          the app turning alerts off

   For the alert sender only (scripts/push-alerts.mjs, run by GitHub
   Actions after each data refresh), with header
   "Authorization: Bearer <PUSH_KEY>":
   GET                                       every device and its tickers
   POST { action: "prune", tokens: [...] }   drop addresses Apple or Google rejected

   Setup: add a secret PUSH_KEY in the Cloudflare Pages project
   (Settings → Variables and Secrets), and the same value as the
   GitHub Actions secret PUSH_KEY.
------------------------------------------------------------------- */

import { json, sameOrigin } from "../../server/ask-core.js";
import { rateLimit } from "../../server/guard.js";

const TOKEN = /^[A-Za-z0-9:_\-.]{20,4096}$/;
const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

async function table(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS devices (token TEXT PRIMARY KEY, platform TEXT NOT NULL, tickers TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
}

function sender(request, env) {
  const key = (env.PUSH_KEY || "").trim();
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!key || got.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export async function onRequestGet({ request, env }) {
  if (!sender(request, env)) return json(403, { error: "Not allowed" });
  if (!env.WAITLIST) return json(503, { error: "Database not connected" });
  await table(env.WAITLIST);
  const { results } = await env.WAITLIST.prepare("SELECT token, platform, tickers FROM devices").all();
  return json(200, { devices: (results || []).map((r) => ({ ...r, tickers: JSON.parse(r.tickers || "[]") })) });
}

export async function onRequestPost({ request, env }) {
  if (!env.WAITLIST) return json(503, { error: "Alerts aren't available yet" });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const db = env.WAITLIST;
  await table(db);

  if (body?.action === "prune") {
    if (!sender(request, env)) return json(403, { error: "Not allowed" });
    const tokens = (Array.isArray(body.tokens) ? body.tokens : []).filter((t) => typeof t === "string").slice(0, 1000);
    for (const t of tokens) await db.prepare("DELETE FROM devices WHERE token = ?1").bind(t).run();
    return json(200, { ok: true, removed: tokens.length });
  }

  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  if (!(await rateLimit(env, request, "devices", 60, 3600))) return json(429, { error: "Too many requests; try again later" });
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!TOKEN.test(token)) return json(400, { error: "That isn't a valid push address" });

  if (body.action === "remove") {
    await db.prepare("DELETE FROM devices WHERE token = ?1").bind(token).run();
    return json(200, { ok: true });
  }
  if (body.action === "register") {
    const platform = body.platform === "ios" || body.platform === "android" ? body.platform : null;
    if (!platform) return json(400, { error: "Unknown platform" });
    const tickers = [...new Set((Array.isArray(body.tickers) ? body.tickers : []).map((t) => String(t).toUpperCase()).filter((t) => TICKER.test(t)))].slice(0, 300);
    await db.prepare("INSERT INTO devices (token, platform, tickers, updated_at) VALUES (?1, ?2, ?3, datetime('now')) ON CONFLICT(token) DO UPDATE SET platform = ?2, tickers = ?3, updated_at = datetime('now')")
      .bind(token, platform, JSON.stringify(tickers)).run();
    return json(200, { ok: true, watching: tickers.length });
  }
  return json(400, { error: "Unknown action" });
}
