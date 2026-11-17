import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { plainSummary, summarizeChat } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import { addNotes, bookingReady, istLabel, newEventId, openSlots, requestCall, RULES, stillOpen } from "@/lib/server/calendar";
import * as events from "@/lib/server/events";
import { decisionToken, ipHash, verifyChatToken } from "@/lib/server/request";
import { logSession, sendMail } from "@/lib/server/sheets";
import { allow, envNumber, firstTime, spendDailyBudget, store } from "@/lib/server/store";
import { bookRequest, json } from "@/lib/server/validate";
import { networkOf, whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 60;

const SUMMARY_BUDGET = envNumber("DAILY_SUMMARY_BUDGET", 400);
const SLOTS_KEY = "book:slots"; // also cleared by decide/route.ts
const rules = { minutes: RULES.minutes, timeZone: RULES.timeZone };

/** The open slots. Kept for a minute, so a busy page asks Google at most once a minute. */
export async function GET(req: Request) {
  if (!bookingReady()) return json({ ok: false, error: "unavailable" }, 503);
  if (!(await allow(`book:slots:ip:${ipHash(req)}`, 60, 3600))) return json({ ok: false, error: "rate_limited" }, 429);
  const kept = await store.get(SLOTS_KEY);
  if (kept) return json({ ok: true, rules, days: JSON.parse(kept) });
  try {
    const days = await openSlots();
    await store.set(SLOTS_KEY, JSON.stringify(days), 60);
    return json({ ok: true, rules, days });
  } catch (err) {
    Sentry.captureException(err);
    return json({ ok: false, error: "unavailable" }, 503);
  }
}

/**
 * A visitor asks for a call. The slot is held on his calendar as "pending" and he gets an email with Approve and
 * Decline links (app/book/decide). The visitor hears from Google only once he approves.
 */
export async function POST(req: Request) {
  if (await isBot()) return json({ ok: false, error: "forbidden" }, 403);
  if (!bookingReady()) return json({ ok: false, error: "unavailable" }, 503);

  const parsed = bookRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ ok: false, error: "bad_request", message: "Please check your name, email and what you'd like to talk about." }, 400);
  }
  const b = parsed.data;

  if (!(await allow(`book:ip:${ipHash(req)}`, 3, 86_400))) {
    return json({ ok: false, error: "rate_limited", message: "You've asked for a few calls today already. Email him instead." }, 429);
  }
  // One request per slot even if two people click at the same moment; the hold lasts the time it takes to book.
  if (!(await firstTime(`book:hold:${b.start}`, 120))) {
    return json({ ok: false, error: "taken", message: "Someone just took that time. Please pick another." }, 409);
  }

  const id = newEventId();
  const origin = new URL(req.url).origin;
  const link = (a: "approve" | "decline") => `${origin}/book/decide?${new URLSearchParams({ id, a, t: decisionToken(id, a) })}`;
  const links = { approve: link("approve"), decline: link("decline") };
  try {
    if (!(await stillOpen(b.start))) {
      await store.set(SLOTS_KEY, "", 1);
      return json({ ok: false, error: "taken", message: "That time isn't free any more. Please pick another." }, 409);
    }
    await requestCall(id, b, links);
  } catch (err) {
    Sentry.captureException(err);
    return json({ ok: false, error: "unavailable", message: "That didn't go through. Please email him instead." }, 503);
  }
  await store.set(SLOTS_KEY, "", 1); // the next visitor sees this slot gone

  const when = istLabel(b.start);
  after(async () => {
    const chat = b.chat;
    const sessionId = chat?.sessionId ?? chat?.conversationId ?? crypto.randomUUID();
    // From inside a chat: a model summary of it (signed chats only, within the daily budget).
    const s = chat?.messages.length
      ? verifyChatToken(chat.conversationId, chat.token) &&
        (await allow(`sum:conv:${chat.conversationId}`, 3, 86_400)) &&
        (await spendDailyBudget(SUMMARY_BUDGET, "budget-summary"))
        ? await summarizeChat(req, sessionId, chat.messages, { sharedDetails: true })
        : plainSummary(chat.messages)
      : null;
    const summary = s?.summary ? `${s.summary}${s.followUp ? `\nFollow up: ${s.followUp}` : ""}` : "";
    const who = b.company ? `${b.name} (${b.company})` : b.name;
    const mail = {
      subject: `Call request: ${who}, ${when}`,
      replyTo: b.email,
      body: [
        `${who} wants a ${RULES.minutes}-minute call on ${when}.`,
        ``,
        `Email: ${b.email}`,
        `What they want to talk about: ${b.topic}`,
        summary ? `\nFrom the chat with Dumbledore:\n${summary}` : "",
        ``,
        `APPROVE (Google sends them the invite with a Meet link):`,
        links.approve,
        ``,
        `DECLINE (frees the slot and emails them a polite note):`,
        links.decline,
        ``,
        `The slot is held on your calendar as a yellow "Pending" event until you decide.`,
      ].join("\n"),
    };
    // The Sheet's script sends it from his Gmail. A script not yet updated to send mail gets the row with notify
    // instead, so the request still reaches him (with the links in "Their note").
    const mailed = await sendMail(mail).catch(() => false);
    const steps = await Promise.allSettled([
      summary ? addNotes(id, b, summary, links) : null,
      events.record(
        { type: "lead", sid: sessionId, name: b.name, email: b.email, company: b.company, role: "", note: `Asked for a call, ${when}: ${b.topic}`.slice(0, 300), page: b.page },
        { leads: 1 },
      ),
      networkOf(req).then((network) =>
        logSession(
          {
            sessionId,
            lastSeen: new Date().toISOString(),
            ...whereAndDevice(req),
            network,
            ...(s ? { intent: s.intent, topics: s.topics, summary: s.summary, followUp: s.followUp } : {}),
            chatEndReason: "Call requested",
            leadShared: "Yes",
            visitorName: b.name,
            email: b.email,
            company: b.company || s?.company,
            recruiterNote: mailed
              ? `Call requested for ${when}. Topic: ${b.topic}`
              : `Call requested for ${when}. Topic: ${b.topic}\nApprove: ${links.approve}\nDecline: ${links.decline}`,
          },
          { notify: !mailed },
        ),
      ),
    ]);
    for (const r of steps) if (r.status === "rejected") console.error("[book] side step failed:", r.reason);
  });

  return json({ ok: true, when });
}
