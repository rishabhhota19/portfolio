import "server-only";
import * as Sentry from "@sentry/nextjs";

// One row per visit in the "Sessions" tab of a Google Sheet, written through a small Apps Script web app
// (integrations/google-sheets/Code.gs). The script upserts by session ID and never overwrites a filled cell
// with an empty one, so the visit beacon, chat summaries and a lead submission all land in the same row.
export type SessionRow = {
  sessionId: string;
  // the visit
  startedAt?: string;
  lastSeen?: string;
  timeOnSite?: string;
  pageCount?: number;
  pages?: string;
  entryPage?: string;
  exitPage?: string;
  source?: string;
  referrer?: string;
  utm?: string;
  returning?: string;
  actions?: string;
  // where (city-level) and network
  ip?: string;
  ipHash?: string;
  city?: string;
  region?: string;
  country?: string;
  location?: string;
  timezone?: string;
  network?: string;
  // device
  device?: string;
  os?: string;
  browser?: string;
  screen?: string;
  language?: string;
  // the chat (empty if they didn't chat)
  chats?: number;
  messages?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensTotal?: number;
  llmCalls?: number;
  models?: string;
  switches?: number;
  avgLatency?: number;
  summaryTokens?: number;
  intent?: string;
  topics?: string;
  summary?: string;
  followUp?: string;
  chatEndReason?: string;
  // the lead (only what the visitor typed into "Share your details")
  leadShared?: "Yes";
  visitorName?: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  recruiterNote?: string;
};

/** notify: also have the script email the row to you (lead alerts when Resend isn't set up). */
export async function logSession(row: SessionRow, { notify = false } = {}) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.GOOGLE_SHEETS_SECRET;
  if (!url || !secret) {
    console.info("[sheets] GOOGLE_SHEETS_WEBHOOK_URL / GOOGLE_SHEETS_SECRET not set — row not logged:", row.sessionId);
    return false;
  }
  try {
    // Apps Script answers POSTs with a 302 to the result; fetch follows it.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret, row, notify }),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const ok = res.ok && text.includes('"ok":true');
    if (!ok) {
      console.error("[sheets] logging failed:", res.status, text.slice(0, 300));
      Sentry.captureMessage(`Google Sheets logging failed (${res.status})`, "warning");
    }
    return ok;
  } catch (err) {
    console.error("[sheets] logging error:", err);
    Sentry.captureException(err);
    return false;
  }
}
