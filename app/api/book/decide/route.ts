import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { approve, decline, istLabel, pending } from "@/lib/server/calendar";
import { ipHash, verifyDecision } from "@/lib/server/request";
import { sendMail } from "@/lib/server/sheets";
import { allow, store } from "@/lib/server/store";
import { json } from "@/lib/server/validate";

export const maxDuration = 30;

const body = z.object({ id: z.string().regex(/^[a-v0-9]{5,64}$/), a: z.enum(["approve", "decline", "look"]), t: z.string().max(100) });

/**
 * Rishabh's answer to a call request, from the links in his email (app/book/decide). The link's signature is the
 * permission. "look" only reads the request, so the page can show who and when before he decides.
 */
export async function POST(req: Request) {
  if (!(await allow(`book:decide:ip:${ipHash(req)}`, 30, 3600))) return json({ ok: false, error: "rate_limited" }, 429);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);
  const { id, a, t } = parsed.data;
  // Looking needs either link; deciding needs that decision's own link.
  const allowed = a === "look" ? verifyDecision(id, "approve", t) || verifyDecision(id, "decline", t) : verifyDecision(id, a, t);
  if (!allowed) return json({ ok: false, error: "forbidden", message: "This link isn't valid." }, 403);

  const request = await pending(id);
  if (!request) return json({ ok: false, error: "gone", message: "This request was already decided, or it was removed from your calendar." }, 410);
  const when = istLabel(request.start);
  const view = { name: request.name, company: request.company, email: request.email, topic: request.topic, when };
  if (a === "look") return json({ ok: true, request: view });

  try {
    if (a === "approve") {
      const { meet } = await approve(request);
      return json({ ok: true, done: "approved", request: view, meet });
    }
    await decline(id);
    await store.set("book:slots", "", 1); // the slot is open again
    const first = request.name.split(" ")[0] || "there";
    const mailed = await sendMail({
      to: request.email,
      name: "Rishabh Hota",
      subject: `Your call request for ${when}`,
      body: [
        `Hi ${first},`,
        ``,
        `Thanks for asking for a call through my portfolio. I can't make ${when}, I'm afraid.`,
        `Reply to this email and we'll find another time, or pick a new slot on https://rishabh-hota.vercel.app.`,
        ``,
        `Rishabh`,
      ].join("\n"),
    });
    return json({ ok: true, done: "declined", request: view, mailed });
  } catch (err) {
    Sentry.captureException(err);
    return json({ ok: false, error: "unavailable", message: "Google Calendar didn't answer. Try the link again in a minute." }, 503);
  }
}
