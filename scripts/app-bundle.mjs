/* ------------------------------------------------------------------
   Run after "vite build" when building the phone app (npm run app:build).
   The app downloads fresh data from the live site every time it opens;
   the copy bundled here is only for the very first launch without a
   connection. Working files the site publishes (caches, backtest inputs)
   are left out to keep the download small.
------------------------------------------------------------------- */
import { readdir, rm } from "node:fs/promises";

const KEEP = new Set(["companies.json", "fps-history.json"]);
for (const f of await readdir("dist/data")) if (!KEEP.has(f)) await rm(`dist/data/${f}`, { recursive: true });
console.log("App bundle: kept", [...KEEP].join(", "));
