import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

// Reports errors thrown in route handlers and while rendering pages.
export const onRequestError = Sentry.captureRequestError;
