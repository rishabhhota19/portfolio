import { captureException, captureRouterTransitionStart, init } from "@sentry/nextjs";

// The browser's Sentry, in a chunk of its own: instrumentation-client.ts says when it loads. Importing this module is
// what starts it, and the import happens once however many places ask.
// Sentry: browser errors (off until NEXT_PUBLIC_SENTRY_DSN is set). No session replay, no personal data.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Privacy: never send user info, cookies, request/response bodies (chat text) or AI inputs/outputs.
  dataCollection: { userInfo: false, cookies: false, httpBodies: [], genAI: { inputs: false, outputs: false } },
});

export { captureException, captureRouterTransitionStart };
