import { after } from "next/server";
import { plainSummary, sessionUsage, summarizeChat } from "@/lib/server/agent";
import * as events from "@/lib/server/events";
import { ipHash, verifyChatToken } from "@/lib/server/request";
import { addChat } from "@/lib/server/session";
import { logSession } from "@/lib/server/sheets";
import { allow, allowNearby, firstTime, spendDailyBudget } from "@/lib/server/store";
import { endRequest, json } from "@/lib/server/validate";
import { whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 60;

const SUMMARY_BUDGET = Number(process.env.DAILY_SUMMARY_BUDGET ?? 400);
const SUMMARIES_PER_CHAT = 3; // later ends of the same chat get the plain summary

const REASON_LABEL = {
  closed_chat: "Closed chat",
  left_site: "Left site",
  tab_hidden: "Switched away",
  lead_submitted: "Lead submitted",
} as const;

/**
 * Called by the widget (fetch keepalive) when a chat is closed or the visitor leaves.
 * The transcript is summarised; only the summary is kept: in the admin dashboard and the visit's Sheet row.
 */
export async function POST(req: Request) {
  if (!allowNearby(`end:${ipHash(req)}`, 30, 60)) return json({ ok: false, error: "rate_limited" }, 429);
  const parsed = endRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, 400);
  const data = parsed.data;
  if (!data.messages.length) return json({ ok: true, skipped: "empty" }, 202);

  const ip = ipHash(req);
  // A valid token proves the conversation went through /api/chat (bot-protected); without one
  // (quick-answer chips only) we log a plain summary and limit it harder.
  const verified = verifyChatToken(data.conversationId, data.token);
  const limitOk = verified ? await allow(`end:ip:${ip}`, 20, 600) : await allow(`end:anon:${ip}`, 3, 3600);
  if (!limitOk) return json({ ok: false, error: "rate_limited" }, 429);

  // Each distinct transcript length is summarised once (closing after a tab switch with no new messages is a no-op).
  if (!(await firstTime(`end:${data.conversationId}:${data.messages.length}`, 86_400))) {
    return json({ ok: true, skipped: "duplicate" }, 202);
  }

  const sessionId = data.sessionId ?? data.conversationId;
  after(async () => {
    const useLlm =
      verified &&
      (await allow(`sum:conv:${data.conversationId}`, SUMMARIES_PER_CHAT, 86_400)) &&
      (await spendDailyBudget(SUMMARY_BUDGET, "budget-summary"));
    const s = useLlm
      ? await summarizeChat(req, sessionId, data.messages)
      : plainSummary(data.messages, verified ? "" : "Quick answers only. ");
    const [chat, usage, firstEnd] = await Promise.all([
      addChat(sessionId, data.conversationId, data.messages.length, s),
      sessionUsage(req, sessionId),
      firstTime(`chat1:${data.conversationId}`, 86_400), // a chat can end twice (tab switch, then close): count it once
    ]);
    await Promise.all([
      events.record(
        { type: "chat", sid: sessionId, messages: data.messages.length, intent: s.intent ?? "", topics: s.topics ?? "",
          summary: (s.summary ?? "").slice(0, 400), followUp: (s.followUp ?? "").slice(0, 200), reason: REASON_LABEL[data.reason] },
        { chats: firstEnd ? 1 : 0 },
      ),
      logSession({
        sessionId,
        startedAt: data.startedAt,
        lastSeen: data.endedAt,
        ...whereAndDevice(req),
        ...chat,
        ...usage,
        chatEndReason: REASON_LABEL[data.reason],
        visitorName: s.visitorName,
        email: s.email,
        company: s.company,
        role: s.role,
      }),
    ]);
  });

  return json({ ok: true }, 202);
}
