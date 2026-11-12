import { readFile } from "node:fs/promises";
import { readPeriodic } from "../scripts/periodic.mjs";
import { toText } from "../scripts/guidance.mjs";
const UA = process.env.SEC_USER_AGENT;
const d = JSON.parse(await readFile("public/data/companies.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { n: 0, dated: 0, floor: 0, doubt: 0, none: 0, atmUsed: 0, atmNone: 0, other: 0, events: 0 };
for (const c of d.companies) {
  const f = c.src?.filing; if (!f?.url) { console.log(c.t, "no filing"); continue; }
  await sleep(200);
  const r = await fetch(f.url, { headers: { "User-Agent": UA } });
  const html = r.ok ? await r.text() : null;
  const p = readPeriodic(html, f.date);
  if (p && !p.runway) { const c2 = toText(html).split(/(?<=[.;])\s+(?=[A-Z(])/).filter((x) => /\b(sufficient|runway|fund our)\b/i.test(x) && /\bcash\b/i.test(x) && /(months|20\d\d|year)/.test(x)).slice(0, 2); for (const x of c2) console.log("    MISS " + x.length + " " + x.slice(0, 330)); }
  tally.n++;
  if (!p) { console.log(c.t, "UNREAD", r.status); continue; }
  tally[p.runway?.kind || "none"]++; if (p.atm?.used) tally.atmUsed++; else if (p.atm) tally.atmNone++; tally.other += p.other.length; tally.events += p.events.length;
  const rw = Math.round(c.cash / c.burn);
  console.log(`${c.t}\t${f.form} ${f.date}\tcalc ${rw}mo\tRUNWAY ${p.runway ? p.runway.kind + " | " + p.runway.say + " | " + p.runway.until : "-"}`);
  if (p.runway) console.log("    > " + p.runway.text.slice(0, 230));
  if (p.atm) console.log("    ATM " + (p.atm.used ? `$${p.atm.amt}M ${p.atm.shares} sh ${p.atm.months || "?"}mo` : "none sold") + " > " + p.atm.text.slice(0, 200));
  for (const o of p.other) console.log(`    ${o.kind.toUpperCase()} $${o.amt}M > ${o.text.slice(0, 200)}`);
  for (const e of p.events) console.log(`    EVENT ${e.kind} ${e.date} > ${e.text.slice(0, 200)}`);
}
console.log(JSON.stringify(tally));
