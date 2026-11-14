import { after } from "next/server";
import { plainSummary, sessionUsage, summarizeChat } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import { sendLeadEmail } from "@/lib/server/email";
import * as events from "@/lib/server/events";
import { ipHash, requestMeta, verifyChatToken } from "@/lib/server/request";
import { addChat, firstLog } from "@/lib/server/session";
import { logSession } from "@/lib/server/sheets";
import { allow, envNumber, spendDailyBudget } from "@/lib/server/store";
import { json, leadRequest } from "@/lib/server/validate";
import { networkOf, whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 60;

const SUMMARY_BUDGET = envNumber("DAILY_SUMMARY_BUDGET", 400);
const SUMMARIES_PER_CHAT = 3;

const settled = <T,>(r: PromiseSettledResult<T>, fallback: T): T => {
  if (r.status === "fulfilled") return r.value;
  console.error("[lead] side step failed:", r.reason);
  return fallback;
};

/** "Share your details" form: details + chat summary into the visit's row in Google Sheets, and an email
 * to Rishabh (via Resend if configured, otherwise the Sheet's Apps Script sends it). */
export async function POST(req: Request) {
  if (await isBot()) return json({ ok: false, error: "forbidden" }, 403);

  // No email or sheet configured yet → say so, so the visitor emails directly instead of losing the lead.
  if (!process.env.RESEND_API_KEY && !process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
    return json({ ok: false, error: "unavailable" }, 503);
  }

  const parsed = leadRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ ok: false, error: "bad_request", message: "Please check your name, email and phone." }, 400);
  }
  const data = parsed.data;

  if (!(await allow(`lead:ip:${ipHash(req)}`, 5, 3600))) {
    return json({ ok: false, error: "rate_limited", message: "Too many submissions — try again later." }, 429);
  }

  // Closing the chat or switching tabs afterwards with no new messages shouldn't re-summarise.
  const total = Math.max(data.count ?? 0, data.messages.length); // the whole chat's count (see firstLog)
  await firstLog(data.conversationId, total, false);

  const sessionId = data.sessionId ?? data.conversationId;
  const meta = requestMeta(req);
  after(async () => {
    const s =
      data.messages.length &&
      // The lead is always kept; the model summary only for a chat that went through /api/chat (signed token).
      verifyChatToken(data.conversationId, data.token) &&
      (await allow(`sum:conv:${data.conversationId}`, SUMMARIES_PER_CHAT, 86_400)) &&
      (await spendDailyBudget(SUMMARY_BUDGET, "budget-summary"))
        ? // The chat only: the model is told that the form was filled in, never what was typed into it.
          await summarizeChat(req, sessionId, data.messages, { sharedDetails: true })
        : plainSummary(data.messages);
    // allSettled: the lead's dashboard record, Sheet row and email never fail because a side step (notes, usage) did.
    const [chatR, usageR, networkR] = await Promise.allSettled([
      addChat(sessionId, data.conversationId, total, { ...s, intent: s.intent || "Hiring — exploring" }),
      sessionUsage(req, sessionId),
      networkOf(req),
    ]);
    const chat = settled(chatR, {
      chats: 1, messages: total, intent: s.intent ?? "", topics: s.topics ?? "", summary: s.summary ?? "", followUp: s.followUp ?? "",
    });
    const usage = settled(usageR, {});
    const network = settled(networkR, "");
    const sent = await Promise.allSettled([
      events.record(
        { type: "lead", sid: sessionId, name: data.lead.name, email: data.lead.email, company: data.lead.company || s.company || "",
          role: data.lead.role || s.role || "", note: (data.lead.note ?? "").slice(0, 300), page: data.page },
        { leads: 1 },
      ),
      logSession(
        {
          sessionId,
          startedAt: data.startedAt,
          lastSeen: data.endedAt,
          ...whereAndDevice(req),
          network,
          ...chat,
          ...usage,
          chatEndReason: "Lead submitted",
          leadShared: "Yes",
          visitorName: data.lead.name,
          email: data.lead.email,
          phone: data.lead.phone,
          company: data.lead.company || s.company,
          role: data.lead.role || s.role,
          recruiterNote: data.lead.note,
        },
        { notify: !process.env.RESEND_API_KEY },
      ),
      sendLeadEmail({
        lead: data.lead,
        summary: s.summary ?? "",
        topics: s.topics ?? "",
        followUp: s.followUp ?? "",
        meta: { ...meta, page: data.page },
      }),
    ]);
    for (const r of sent) if (r.status === "rejected") console.error("[lead] delivery step failed:", r.reason);
  });

  return json({ ok: true });
}
