import type { Metadata } from "next";
import { Suspense } from "react";
import { Decide } from "./Decide";

export const metadata: Metadata = { title: "Call request", robots: { index: false, follow: false } };

/** Where the Approve and Decline links in Rishabh's email land. Nothing happens until he presses a button here, so
 * an email scanner that opens the link can't approve or decline anything. */
export default function DecidePage() {
  return (
    <section className="mx-auto max-w-xl px-5 py-16 sm:py-24">
      <Suspense fallback={<p className="text-muted">Loading the request…</p>}>
        <Decide />
      </Suspense>
    </section>
  );
}
