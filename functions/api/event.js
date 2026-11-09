/* ------------------------------------------------------------------
   POST /api/event {name}: add one to today's count for a page view or a
   key action. Stores only daily totals (date, event name, count) in the
   D1 table "events": no cookies, IP addresses, device IDs or anything
   else that identifies a visitor. Only known event names are accepted.

   Read the totals in Cloudflare: D1 → your database → Console, e.g.
     SELECT day, name, n FROM events ORDER BY day DESC, n DESC;
     SELECT name, SUM(n) FROM events WHERE day >= date('now','-30 days') GROUP BY name ORDER BY 2 DESC;
------------------------------------------------------------------- */

import { json, sameOrigin } from "../../server/ask-core.js";

const VIEWS = ["home", "report", "screen", "research", "company", "compare", "catalysts", "outlook", "ask", "pro", "industry", "marketdata", "trade", "calc", "about", "privacy"];
const ACTIONS = ["ask_question", "waitlist_signup", "pilot_request_institutional-pilot", "pilot_request_professional", "pilot_request_data", "pilot_request_other", "csv_download", "vse_start", "vse_trade", "calc_retire", "calc_budget", "calc_mortgage", "calc_tax", "correction_sent", "watch_add"];
const ALLOWED = new Set([...VIEWS.map((v) => `view_${v}`), ...ACTIONS]);
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|node-fetch|go-http/i;

// A light per-instance brake so one visitor can't inflate counts much; nothing is stored.
const recent = new Map();
const none = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { error: "Not allowed" });
  if (BOT.test(request.headers.get("user-agent") || "")) return none();
  let name = "";
  try { name = String((await request.json())?.name || ""); } catch { return json(400, { error: "Body must be JSON" }); }
  if (!ALLOWED.has(name)) return json(400, { error: "Unknown event" });
  const who = request.headers.get("cf-connecting-ip") || "";
  const key = `${who}|${name}`, now = Date.now();
  if (now - (recent.get(key) || 0) < 3000) return none();
  recent.set(key, now);
  if (recent.size > 20000) recent.clear();
  if (!env.WAITLIST) return none();
  try {
    await env.WAITLIST.prepare("CREATE TABLE IF NOT EXISTS events (day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name))").run();
    await env.WAITLIST.prepare("INSERT INTO events (day, name, n) VALUES (date('now'), ?1, 1) ON CONFLICT(day, name) DO UPDATE SET n = n + 1").bind(name).run();
  } catch (e) { console.error("event count failed", e); }
  return none();
}
