import { after } from "next/server";
import { plainSummary, summarizeChat } from "@/lib/agent/summarize";
import { isBot } from "@/lib/server/bot";
import { sendLeadEmail } from "@/lib/server/email";
import { ipHash, requestMeta } from "@/lib/server/request";
import { logConversation } from "@/lib/server/sheets";
import { allow, firstTime, spendDailyBudget } from "@/lib/server/store";
import { json, leadRequest } from "@/lib/server/validate";

export const maxDuration = 60;

const DAILY_BUDGET = Number(process.env.DAILY_LLM_BUDGET ?? 1000);

/** "Share your details" form: summary + details to Google Sheets, and an email to Rishabh. */
export async function POST(req: Request) {
  if (await isBot()) return json({ ok: false, error: "forbidden" }, 403);

  const parsed = leadRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ ok: false, error: "bad_request", message: "Please check your name and email." }, 400);
  }
  const data = parsed.data;

  if (!(await allow(`lead:ip:${ipHash(req)}`, 5, 3600))) {
    return json({ ok: false, error: "rate_limited", message: "Too many submissions — try again later." }, 429);
  }

  // Closing the chat afterwards with no new messages shouldn't re-summarise.
  await firstTime(`end:${data.conversationId}:${data.messages.length}`, 86_400);

  const meta = requestMeta(req);
  after(async () => {
    const s =
      data.messages.length && (await spendDailyBudget(DAILY_BUDGET))
        ? await summarizeChat(data.messages, data.lead)
        : plainSummary(data.messages);
    await Promise.all([
      logConversation({
        conversationId: data.conversationId,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        endReason: "Lead submitted",
        messages: data.messages.length,
        visitorName: data.lead.name,
        email: data.lead.email,
        company: data.lead.company || s.company,
        role: data.lead.role || s.role,
        intent: s.intent || "Hiring — exploring",
        topics: s.topics,
        summary: s.summary,
        followUp: s.followUp,
        leadShared: "Yes",
        recruiterNote: data.lead.note,
        country: meta.country,
        city: meta.city,
        device: meta.device,
        entryPage: data.page,
        model: s.model,
      }),
      sendLeadEmail({
        lead: data.lead,
        summary: s.summary,
        topics: s.topics,
        followUp: s.followUp,
        meta: { ...meta, page: data.page },
      }),
    ]);
  });

  return json({ ok: true });
}
