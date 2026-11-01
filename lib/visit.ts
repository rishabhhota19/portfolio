// One visit = one browser tab on the site: it survives page changes and reloads (sessionStorage),
// and ends when the tab closes. The browser reports only what it can see — pages, clicks, screen,
// language — and the server adds the city-level location and network. Never anything the visitor typed.
import type { VisitRequest } from "@/lib/chat-types";

type Saved = Omit<VisitRequest, "activeSeconds"> & { activeMs: number };

const KEY = "visit";
const MAX = 60; // pages / actions kept per visit

let visit: Saved | null = null;
let visibleSince: number | null = null; // null while the tab is hidden
let lastSent = "";

function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(visit));
  } catch {} // private mode: the visit still works for this page
}

function referrerHost() {
  try {
    const host = new URL(document.referrer).hostname;
    return host === location.hostname ? "" : host; // only the site, never the full URL (it can hold search terms)
  } catch {
    return "";
  }
}

function utmTags() {
  const q = new URLSearchParams(location.search);
  return ["utm_source", "utm_medium", "utm_campaign"].map((k) => q.get(k)).filter(Boolean).join(" / ").slice(0, 200);
}

export function currentVisit(): Saved {
  if (!visit) {
    try {
      visit = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    } catch {}
    visit ??= {
      sessionId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      pages: [],
      actions: [],
      referrer: referrerHost(),
      utm: utmTags(),
      screen: `${screen.width}×${screen.height}`,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      activeMs: 0,
    };
    visibleSince ??= document.visibilityState === "visible" ? Date.now() : null;
    save();
  }
  return visit;
}

export const sessionId = () => currentVisit().sessionId;

export function addPage(path: string) {
  const v = currentVisit();
  if (v.pages[v.pages.length - 1] !== path && v.pages.length < MAX) {
    v.pages.push(path);
    save();
  }
}

export function addAction(name: string) {
  const v = currentVisit();
  if (v.actions.length < MAX) {
    v.actions.push(name);
    save();
  }
}

/** Counts time only while the tab is visible, so a tab left open in the background isn't "time on site". */
export function setVisible(visible: boolean) {
  const v = currentVisit();
  if (!visible && visibleSince !== null) {
    v.activeMs += Date.now() - visibleSince;
    visibleSince = null;
    save();
  } else if (visible && visibleSince === null) {
    visibleSince = Date.now();
  }
}

let pinged = false;

/** Presence for the admin dashboard ("on the site now"): on each page change and every 30 s, only while visible. */
export function ping() {
  const v = currentVisit();
  const page = v.pages[v.pages.length - 1];
  if (!page || document.visibilityState !== "visible") return;
  const body = JSON.stringify({ sessionId: v.sessionId, page, first: !pinged, referrer: v.referrer, utm: v.utm });
  pinged = true;
  fetch("/api/visit/live", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
}

/** Reports the visit (called when the tab is hidden or closed). Skipped if nothing much changed. */
export function sendVisit() {
  const { activeMs, ...rest } = currentVisit();
  const activeSeconds = Math.round(activeMs / 1000);
  const changed = `${rest.pages.length}:${rest.actions.length}:${Math.floor(activeSeconds / 30)}`;
  if (changed === lastSent || rest.pages.length === 0) return;
  lastSent = changed;
  const body = JSON.stringify({ ...rest, activeSeconds } satisfies VisitRequest);
  // sendBeacon is built for this: the browser delivers it even while the page is closing.
  const sent = navigator.sendBeacon?.("/api/visit", new Blob([body], { type: "application/json" }));
  if (!sent) {
    fetch("/api/visit", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
}
