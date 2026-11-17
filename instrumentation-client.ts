import { initBotId } from "botid/client/core";

// Vercel BotID: invisible bot checks on the endpoints that spend LLM tokens, send email, or sign in.
// (Not /api/visit: it's sent with sendBeacon while the page closes, which BotID can't sign.)
initBotId({
  protect: [
    { path: "/api/chat", method: "POST" },
    { path: "/api/lead", method: "POST" },
    { path: "/api/book", method: "POST" },
    { path: "/api/admin/login", method: "POST" },
  ],
});

// Sentry is about a quarter of the site's first-load JavaScript and draws nothing, so it waits: it loads when the
// visitor first scrolls, taps or types, once the browser has a free moment, or at once if something goes wrong.
// Errors from before it arrives are held here and sent when it does.
type SentryClient = typeof import("./lib/sentry-client");

let sentry: SentryClient | undefined;
let requested = false;
const held: unknown[] = [];

function loadSentry() {
  if (requested) return;
  requested = true;
  import("./lib/sentry-client")
    .then((client) => {
      sentry = client;
      // Its own handlers take over from here.
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      for (const error of held.splice(0)) {
        client.captureException(error, { mechanism: { handled: false, type: "auto.browser.held_until_sentry_loaded" } });
      }
    })
    .catch(() => {
      requested = false; // the chunk didn't arrive: the next error tries again
    });
}

function hold(error: unknown) {
  held.push(error);
  loadSentry();
}
function onError(event: ErrorEvent) {
  hold(event.error ?? event.message);
}
function onRejection(event: PromiseRejectionEvent) {
  hold(event.reason);
}
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

function loadWhenIdle() {
  if ("requestIdleCallback" in window) window.requestIdleCallback(loadSentry, { timeout: 2000 });
  else setTimeout(loadSentry, 200); // not in Safari
}
for (const name of ["pointerdown", "keydown", "scroll"]) {
  window.addEventListener(name, loadWhenIdle, { once: true, passive: true, capture: true });
}

export function onRouterTransitionStart(href: string, navigationType: string) {
  sentry?.captureRouterTransitionStart(href, navigationType);
}
