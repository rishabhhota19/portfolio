"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Last-resort error page (if even the root layout fails). Reports the error to Sentry.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", textAlign: "center", background: "#f4f1ea", color: "#15140f" }}>
        <h1 style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>Something went wrong.</h1>
        <p style={{ color: "#6b665c" }}>Please try again — or email rishabhhota19@gmail.com.</p>
        <button type="button" onClick={retry} style={{ marginTop: "1.5rem", padding: "0.6rem 1.2rem", borderRadius: 999, border: "none", background: "#15140f", color: "#f4f1ea", cursor: "pointer" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
