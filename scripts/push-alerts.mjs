/* ------------------------------------------------------------------
   Push alerts for the phone app, run by GitHub Actions after each data
   refresh:   node scripts/push-alerts.mjs <previous companies.json> <new companies.json>

   For every company that changed, it builds one short alert:
     - it moved to a different Financing Pressure band
     - it filed a new stock-sale prospectus
     - it got a new accounting red flag (restatement, auditor change,
       exchange notice, late filing, control weakness, going-concern warning)
   then sends it to every phone watching that company.

   iPhones are reached through Apple (APNs), Android phones through
   Google (Firebase Cloud Messaging). Secrets, set in GitHub:
     PUSH_KEY             same value as in Cloudflare; lets this script read the device list
     APNS_KEY             the .p8 key from Apple Developer (Keys → Apple Push Notifications)
     APNS_KEY_ID, APPLE_TEAM_ID, and optional APNS_ENV=sandbox for test builds
     FCM_SERVICE_ACCOUNT  the Firebase service account JSON
   A platform whose secrets are missing is skipped. --dry prints the alerts without sending.
------------------------------------------------------------------- */

import { readFile } from "node:fs/promises";
import { connect } from "node:http2";
import { sign } from "node:crypto";
import { computeFPS } from "../src/fps.js";

const SITE = process.env.SITE_URL || "https://helixora.pages.dev";
const BUNDLE_ID = process.env.APP_ID || "com.helixora.app";
const DRY = process.argv.includes("--dry");
const MAX_PER_PHONE = 3;

/* ---- what changed ---- */

const urls = (xs) => new Set((xs || []).map((x) => x.url).filter(Boolean));
const money = (m) => (m == null ? "" : m >= 1000 ? `$${(m / 1000).toFixed(1)}B` : `$${Math.round(m)}M`);

export function changes(prevFile, nextFile, today = new Date()) {
  // Only news: a filing dated in the last ten days. Older ones turn up when a new check is added
  // to the site, and those aren't alerts.
  const recent = (d) => d && (today - new Date(d + "T00:00:00Z")) / 864e5 <= 10;
  const before = new Map((prevFile.companies || []).map((c) => [c.t, c]));
  const out = {};
  for (const c of nextFile.companies || []) {
    const p = before.get(c.t);
    if (!p) continue; // newly covered companies don't trigger alerts
    const lines = [];
    const a = computeFPS(p, today), b = computeFPS(c, today);
    if (a.band && b.band && a.band !== b.band) lines.push(`moved from ${a.band} to ${b.band} financing pressure (score ${b.score})`);
    const oldF = urls(p.financings);
    for (const f of (c.financings || []).filter((f) => f.url && !oldF.has(f.url) && recent(f.date)).slice(0, 1)) lines.push(`filed a stock-sale prospectus${f.amt ? ` for ${f.upTo ? "up to " : ""}${money(f.amt)}` : ""}`);
    const oldFlags = urls(p.flags);
    for (const f of (c.flags || []).filter((f) => !oldFlags.has(f.url) && recent(f.date)).slice(0, 1)) lines.push(f.label.charAt(0).toLowerCase() + f.label.slice(1));
    if (c.said?.runway?.kind === "doubt" && p.said && p.said?.runway?.kind !== "doubt" && recent(c.said.date)) lines.push("issued a going-concern warning in its latest report");
    if (c.said?.weakness && p.said && !p.said.weakness && recent(c.said.date)) lines.push("disclosed a material weakness in its financial controls");
    if (lines.length) out[c.t] = { title: `${c.n} (${c.t})`, body: `${lines[0].charAt(0).toUpperCase()}${lines[0].slice(1)}${lines.length > 1 ? `, and ${lines.length - 1} more update${lines.length > 2 ? "s" : ""}` : ""}.` };
  }
  return out;
}

/* ---- Apple ---- */

const b64url = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function apnsJwt() {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: process.env.APNS_KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: process.env.APPLE_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: process.env.APNS_KEY.replace(/\\n/g, "\n"), dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

async function sendApple(items) {
  if (!process.env.APNS_KEY || !process.env.APNS_KEY_ID || !process.env.APPLE_TEAM_ID) { console.log(`Apple: secrets not set, skipped ${items.length} alerts`); return []; }
  const host = process.env.APNS_ENV === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const client = connect(host);
  const jwt = apnsJwt(), dead = [];
  let sent = 0;
  for (const { token, msg, ticker } of items) {
    const status = await new Promise((resolve) => {
      const req = client.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${jwt}`, "apns-topic": BUNDLE_ID, "apns-push-type": "alert", "apns-priority": "10" });
      let data = "";
      req.on("response", (h) => { req.on("data", (d) => (data += d)); req.on("end", () => resolve({ code: h[":status"], data })); });
      req.on("error", (e) => resolve({ code: 0, data: e.message }));
      req.end(JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: "default" }, ticker }));
    });
    if (status.code === 200) sent++;
    else if (status.code === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(status.data)) dead.push(token);
    else console.warn(`Apple: ${status.code} ${status.data}`);
  }
  client.close();
  console.log(`Apple: sent ${sent} of ${items.length}`);
  return dead;
}

/* ---- Google ---- */

async function fcmAccess(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), sa.private_key);
  const r = await fetch(sa.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(sig)}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google sign-in failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

async function sendGoogle(items) {
  if (!process.env.FCM_SERVICE_ACCOUNT) { console.log(`Google: secret not set, skipped ${items.length} alerts`); return []; }
  const sa = JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
  const access = await fcmAccess(sa), dead = [];
  let sent = 0;
  for (const { token, msg, ticker } of items) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token, notification: { title: msg.title, body: msg.body }, data: { ticker }, android: { priority: "high" } } }),
    });
    if (r.ok) { sent++; continue; }
    const t = await r.text();
    if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(t)) dead.push(token);
    else console.warn(`Google: ${r.status} ${t.slice(0, 200)}`);
  }
  console.log(`Google: sent ${sent} of ${items.length}`);
  return dead;
}

/* ---- main ---- */

async function main() {
  const [prevPath, nextPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let prev;
  try { prev = JSON.parse(await readFile(prevPath, "utf8")); } catch { console.log("No previous data to compare with; nothing to send."); return; }
  const next = JSON.parse(await readFile(nextPath, "utf8"));
  const alerts = changes(prev, next);
  console.log(`${Object.keys(alerts).length} companies changed`);
  for (const [t, m] of Object.entries(alerts)) console.log(`  ${m.title}: ${m.body}`);
  if (!Object.keys(alerts).length) return;

  const key = (process.env.PUSH_KEY || "").trim();
  if (!key) { console.log("PUSH_KEY not set; not sending."); return; }
  const r = await fetch(`${SITE}/api/devices`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) { console.warn(`Couldn't read the device list: HTTP ${r.status}`); return; }
  const { devices = [] } = await r.json();

  const queue = { ios: [], android: [] };
  for (const d of devices) {
    const hits = d.tickers.filter((t) => alerts[t]);
    for (const t of hits.slice(0, MAX_PER_PHONE)) queue[d.platform]?.push({ token: d.token, ticker: t, msg: alerts[t] });
    if (hits.length > MAX_PER_PHONE) queue[d.platform]?.push({ token: d.token, ticker: hits[MAX_PER_PHONE], msg: { title: "Helixora", body: `${hits.length - MAX_PER_PHONE} more companies on your watchlist changed today.` } });
  }
  console.log(`${devices.length} phones; ${queue.ios.length} alerts for iPhones, ${queue.android.length} for Android`);
  if (DRY) return;

  const dead = [...(await sendApple(queue.ios)), ...(await sendGoogle(queue.android))];
  if (dead.length) {
    await fetch(`${SITE}/api/devices`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "prune", tokens: dead }) });
    console.log(`Removed ${dead.length} push addresses that no longer work`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
