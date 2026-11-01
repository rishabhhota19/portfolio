import * as Sentry from "@sentry/nextjs";
import { initBotId } from "botid/client/core";

// Vercel BotID: invisible bot checks on the endpoints that spend LLM tokens or send email.
// (Not /api/visit: it's sent with sendBeacon while the page closes, which BotID can't sign.)
initBotId({
  protect: [
    { path: "/api/chat", method: "POST" },
    { path: "/api/lead", method: "POST" },
  ],
});

// Sentry: browser errors (off until NEXT_PUBLIC_SENTRY_DSN is set). No session replay, no personal data.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Privacy: never send user info, cookies, request/response bodies (chat text) or AI inputs/outputs.
  dataCollection: { userInfo: false, cookies: false, httpBodies: [], genAI: { inputs: false, outputs: false } },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
