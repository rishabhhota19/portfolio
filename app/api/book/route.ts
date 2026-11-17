import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { plainSummary, summarizeChat } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import { addNotes, book, bookingReady, istLabel, openSlots, RULES, stillOpen } from "@/lib/server/calendar";
import * as events from "@/lib/server/events";
import { ipHash, verifyChatToken } from "@/lib/server/request";
import { logSession } from "@/lib/server/sheets";
import { allow, envNumber, firstTime, spendDailyBudget, store } from "@/lib/server/store";
import { bookRequest, json } from "@/lib/server/validate";
import { networkOf, whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 60;

const SUMMARY_BUDGET = envNumber("DAILY_SUMMARY_BUDGET", 400);
const SLOTS_KEY = "book:slots";
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

/** Books one slot: on his calendar with a Meet link, an invite to the visitor, a row in the Sheet (which emails him). */
export async function POST(req: Request) {
  if (await isBot()) return json({ ok: false, error: "forbidden" }, 403);
  if (!bookingReady()) return json({ ok: false, error: "unavailable" }, 503);

  const parsed = bookRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ ok: false, error: "bad_request", message: "Please check your name, email and what you'd like to talk about." }, 400);
  }
  const b = parsed.data;

  if (!(await allow(`book:ip:${ipHash(req)}`, 3, 86_400))) {
    return json({ ok: false, error: "rate_limited", message: "You've booked a few calls today already. Email him instead." }, 429);
  }
  // One booking per slot even if two people click at the same moment; the hold lasts the time it takes to book.
  if (!(await firstTime(`book:hold:${b.start}`, 120))) {
    return json({ ok: false, error: "taken", message: "Someone just took that time. Please pick another." }, 409);
  }

  let made: Awaited<ReturnType<typeof book>>;
  try {
    if (!(await stillOpen(b.start))) {
      await store.set(SLOTS_KEY, "", 1);
      return json({ ok: false, error: "taken", message: "That time isn't free any more. Please pick another." }, 409);
    }
    made = await book(b);
  } catch (err) {
    Sentry.captureException(err);
    return json({ ok: false, error: "unavailable", message: "Booking didn't go through. Please email him instead." }, 503);
  }
  await store.set(SLOTS_KEY, "", 1); // the next visitor sees this slot gone

  const when = istLabel(b.start);
  after(async () => {
    const chat = b.chat;
    const sessionId = chat?.sessionId ?? chat?.conversationId ?? crypto.randomUUID();
    // From inside a chat: a model summary of it goes into the event (signed chats only, within the daily budget).
    const s = chat?.messages.length
      ? verifyChatToken(chat.conversationId, chat.token) &&
        (await allow(`sum:conv:${chat.conversationId}`, 3, 86_400)) &&
        (await spendDailyBudget(SUMMARY_BUDGET, "budget-summary"))
        ? await summarizeChat(req, sessionId, chat.messages, { sharedDetails: true })
        : plainSummary(chat.messages)
      : null;
    const steps = await Promise.allSettled([
      s?.summary ? addNotes(made.id, b, `From the chat with Dumbledore:\n${s.summary}${s.followUp ? `\nFollow up: ${s.followUp}` : ""}`) : null,
      events.record(
        { type: "lead", sid: sessionId, name: b.name, email: b.email, company: b.company, role: "", note: `Booked a call, ${when}: ${b.topic}`.slice(0, 300), page: b.page },
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
            chatEndReason: "Call booked",
            leadShared: "Yes",
            visitorName: b.name,
            email: b.email,
            company: b.company || s?.company,
            recruiterNote: `Call booked for ${when}. Topic: ${b.topic}`,
          },
          { notify: true }, // the Sheet's script emails him
        ),
      ),
    ]);
    for (const r of steps) if (r.status === "rejected") console.error("[book] side step failed:", r.reason);
  });

  return json({ ok: true, when, meet: made.meet });
}
