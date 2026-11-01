import "server-only";
import * as Sentry from "@sentry/nextjs";
import { store } from "@/lib/server/store";

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

type Item = { row: SessionRow; notify: boolean };
const RETRY = "sheet:retry"; // writes that failed (Sheet busy or down), sent again as one batch

async function send(items: Item[]) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL!;
  try {
    // Apps Script answers POSTs with a 302 to the result; fetch follows it.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: process.env.GOOGLE_SHEETS_SECRET, items }),
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.ok && text.includes('"ok":true')) return true;
    console.error("[sheets] logging failed:", res.status, text.slice(0, 300));
  } catch (err) {
    console.error("[sheets] logging error:", err);
  }
  return false;
}

/**
 * Upserts a visit's row. If the Sheet is busy (Apps Script runs one write at a time and at most 30 at once),
 * the row is queued and sent with the next successful write — so a burst of visitors loses nothing.
 * notify: also have the script email the row to you (lead alerts when Resend isn't set up).
 */
export async function logSession(row: SessionRow, { notify = false } = {}) {
  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL || !process.env.GOOGLE_SHEETS_SECRET) {
    console.info("[sheets] GOOGLE_SHEETS_WEBHOOK_URL / GOOGLE_SHEETS_SECRET not set — row not logged:", row.sessionId);
    return false;
  }
  if (!(await send([{ row, notify }]))) {
    await store.push(RETRY, JSON.stringify({ row, notify }), 2 * 86_400);
    Sentry.captureMessage("Google Sheets write failed — queued for retry", "warning");
    return false;
  }
  const backlog = await store.popMany(RETRY, 50); // the Sheet is answering again: send what failed earlier
  if (backlog.length && !(await send(backlog.map((item) => JSON.parse(item) as Item)))) {
    for (const item of backlog) await store.push(RETRY, item, 2 * 86_400);
  }
  return true;
}
