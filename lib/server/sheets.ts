import "server-only";
import * as Sentry from "@sentry/nextjs";

// One row per conversation in a Google Sheet, written through a small Apps Script web app
// (integrations/google-sheets/Code.gs). The script upserts by conversation ID, so a later
// summary (e.g. after the chat closes) updates the row a lead submission created earlier.
export type ConversationRow = {
  conversationId: string;
  startedAt: string;
  endedAt: string;
  endReason: string;
  messages: number;
  visitorName: string;
  email: string;
  company: string;
  role: string;
  intent: string;
  topics: string;
  summary: string;
  followUp: string;
  leadShared: "Yes" | "";
  recruiterNote: string;
  country: string;
  city: string;
  device: string;
  entryPage: string;
  model: string;
};

/** notify: also have the script email the row to you (lead alerts when Resend isn't set up). */
export async function logConversation(row: ConversationRow, { notify = false } = {}) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.GOOGLE_SHEETS_SECRET;
  if (!url || !secret) {
    console.info("[sheets] GOOGLE_SHEETS_WEBHOOK_URL / GOOGLE_SHEETS_SECRET not set — row not logged:", row);
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
