/* GET /api/config: public settings the browser needs at run time.
   TURNSTILE_SITE_KEY is a public key (set it as a plain variable). */
import { json } from "../../server/ask-core.js";

export function onRequestGet({ env }) {
  return json(200, { turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
}
