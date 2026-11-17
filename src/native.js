/* ------------------------------------------------------------------
   The phone app. The same React site runs inside the iOS and Android
   app (Capacitor); this file holds everything that differs there:

   - data and server calls go to the live site, since the app's own
     pages are served from the phone
   - the latest data is kept on the phone, so the app opens offline
   - push alerts for the companies on the watchlist
   - the phone's share sheet, and an in-app browser for the pages that
     need the website (Ask Helixora, sign-up forms)

   On the website none of this runs: IS_APP is false and every helper
   falls back to the browser.
------------------------------------------------------------------- */

import { Capacitor } from "@capacitor/core";

export const IS_APP = Capacitor.isNativePlatform();
export const PLATFORM = Capacitor.getPlatform(); // "ios" | "android" | "web"
export const SITE = "https://helixora.pages.dev";

// Where server calls and data files live.
export const apiUrl = (path) => (IS_APP ? SITE + path : path);
export const dataUrl = (file) => (IS_APP ? `${SITE}/data/${file}` : `${import.meta.env.BASE_URL}data/${file}`);

/* ---- offline copy ---- */

const CACHE_DIR = "CACHE";
async function fs() { return (await import("@capacitor/filesystem")).Filesystem; }

// Fetch a data file; in the app, save it on the phone and fall back to the saved copy when offline.
export async function fetchData(file) {
  try {
    const res = await fetch(dataUrl(file), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (IS_APP) {
      try { (await fs()).writeFile({ path: `helixora-${file}`, data: text, directory: CACHE_DIR, encoding: "utf8" }); } catch { /* saving is best-effort */ }
    }
    return { json: JSON.parse(text), offline: false };
  } catch (e) {
    if (!IS_APP) throw e;
    try {
      const saved = await (await fs()).readFile({ path: `helixora-${file}`, directory: CACHE_DIR, encoding: "utf8" });
      return { json: JSON.parse(saved.data), offline: true };
    } catch {
      // First launch with no connection: the copy bundled with the app.
      const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
      return { json: await res.json(), offline: true };
    }
  }
}

/* ---- sharing and the in-app browser ---- */

export async function shareCompany(c) {
  const url = `${SITE}/#company/${c.t}`;
  const text = `${c.n} (${c.t}) on Helixora: financing pressure, cash runway and next catalyst.`;
  if (IS_APP) { const { Share } = await import("@capacitor/share"); return Share.share({ title: `${c.n} on Helixora`, text, url, dialogTitle: "Share" }); }
  if (navigator.share) return navigator.share({ title: `${c.n} on Helixora`, text, url }).catch(() => {});
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return null; }
}

// Opens a page of the website: in the app, inside the in-app browser (Safari View Controller / Chrome Custom Tab).
export async function openSite(hash = "") {
  const url = `${SITE}/${hash}`;
  if (IS_APP) { const { Browser } = await import("@capacitor/browser"); return Browser.open({ url }); }
  window.location.hash = hash.replace(/^#/, "");
}

/* ---- push alerts ---- */

const ALERTS_KEY = "helixora-alerts";
export const alertsWanted = () => { try { return localStorage.getItem(ALERTS_KEY) === "on"; } catch { return false; } };
let pushToken = null;

async function sendDevice(body) {
  const r = await fetch(apiUrl("/api/devices"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

// Ask for permission, get this phone's push address, and tell the server which companies to watch.
// Returns "on", "denied" or an error message.
export async function enableAlerts(tickers, onOpen) {
  if (!IS_APP) return "Alerts are part of the phone app.";
  const { PushNotifications } = await import("@capacitor/push-notifications");
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return "denied";
  await PushNotifications.removeAllListeners();
  const token = await new Promise((resolve, reject) => {
    PushNotifications.addListener("registration", (t) => resolve(t.value));
    PushNotifications.addListener("registrationError", (e) => reject(new Error(e.error || "Registration failed")));
    PushNotifications.register();
    setTimeout(() => reject(new Error("The phone didn't return a push address. Check your connection and try again.")), 20000);
  });
  PushNotifications.addListener("pushNotificationActionPerformed", (a) => { const t = a.notification?.data?.ticker; if (t && onOpen) onOpen(t); });
  pushToken = token;
  await sendDevice({ action: "register", token, platform: PLATFORM, tickers });
  try { localStorage.setItem(ALERTS_KEY, "on"); } catch { /* ignore */ }
  return "on";
}

// Re-attach the tap handler and refresh the watchlist on the server when the app starts.
export async function resumeAlerts(tickers, onOpen) {
  if (!IS_APP || !alertsWanted()) return;
  try { await enableAlerts(tickers, onOpen); } catch { /* try again next time */ }
}

export async function syncWatchlist(tickers) {
  if (!IS_APP || !alertsWanted() || !pushToken) return;
  try { await sendDevice({ action: "register", token: pushToken, platform: PLATFORM, tickers }); } catch { /* next change or launch retries */ }
}

// Turn alerts off and delete this phone's address and watchlist from the server.
export async function disableAlerts() {
  try { localStorage.setItem(ALERTS_KEY, "off"); } catch { /* ignore */ }
  if (!IS_APP) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  if (pushToken) { try { await sendDevice({ action: "remove", token: pushToken }); } catch { /* the server also prunes dead addresses */ } }
  pushToken = null;
  await PushNotifications.removeAllListeners();
  try { await PushNotifications.unregister(); } catch { /* not all platforms support it */ }
}

/* ---- app chrome ---- */

// helixora://company/SRRK/accounting, helixora://report, ... → ["company", "SRRK", "accounting"]
export const parseAppLink = (url) => String(url || "").replace(/^helixora:\/\//i, "").replace(/^https:\/\/helixora\.pages\.dev\/#?/i, "").split(/[/?#]/).filter(Boolean).map(decodeURIComponent);

export async function initApp(onBack, onLink) {
  if (!IS_APP) return;
  document.documentElement.classList.add("in-app", `in-app-${PLATFORM}`);
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Light });
  } catch { /* not available on every platform */ }
  try {
    const { App } = await import("@capacitor/app");
    App.addListener("appUrlOpen", ({ url }) => onLink(parseAppLink(url)));
    App.addListener("backButton", ({ canGoBack }) => { if (!onBack()) { if (canGoBack) window.history.back(); else App.minimizeApp(); } });
  } catch { /* iOS has no back button */ }
  try { const { SplashScreen } = await import("@capacitor/splash-screen"); await SplashScreen.hide(); } catch { /* ignore */ }
}
