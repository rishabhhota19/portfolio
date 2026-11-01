import { after } from "next/server";
import { plainSummary, sessionUsage, summarizeChat } from "@/lib/server/agent";
import { ipHash, verifyChatToken } from "@/lib/server/request";
import { addChat } from "@/lib/server/session";
import { logSession } from "@/lib/server/sheets";
import { allow, firstTime, spendDailyBudget } from "@/lib/server/store";
import { endRequest, json } from "@/lib/server/validate";
import { whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 60;

const DAILY_BUDGET = Number(process.env.DAILY_LLM_BUDGET ?? 3000);

const REASON_LABEL = {
  closed_chat: "Closed chat",
  left_site: "Left site",
  tab_hidden: "Switched away",
  lead_submitted: "Lead submitted",
} as const;

/**
 * Called by the widget (fetch keepalive) when a chat is closed or the visitor leaves.
 * The transcript is summarised and only the summary goes into the visit's row in Google Sheets.
 */
export async function POST(req: Request) {
  const parsed = endRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, 400);
  const data = parsed.data;
  if (!data.messages.length) return json({ ok: true, skipped: "empty" }, 202);
  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL) return json({ ok: true, skipped: "no sheet configured" }, 202);

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
    const useLlm = verified && (await spendDailyBudget(DAILY_BUDGET));
    const s = useLlm
      ? await summarizeChat(req, sessionId, data.messages)
      : plainSummary(data.messages, verified ? "" : "Quick answers only. ");
    const [chat, usage] = await Promise.all([
      addChat(sessionId, data.conversationId, data.messages.length, s),
      sessionUsage(req, sessionId),
    ]);
    await logSession({
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
    });
  });

  return json({ ok: true }, 202);
}
