import * as Sentry from "@sentry/nextjs";

// Server errors (API routes, rendering). Off until NEXT_PUBLIC_SENTRY_DSN is set.
// See dataCollection below: chat text never reaches Sentry.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Privacy: never send user info, cookies, request/response bodies (chat text) or AI inputs/outputs.
  dataCollection: { userInfo: false, cookies: false, httpBodies: [], genAI: { inputs: false, outputs: false } },
});
