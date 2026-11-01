import { after } from "next/server";
import { sessionUsage } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import { ipHash } from "@/lib/server/request";
import { logSession } from "@/lib/server/sheets";
import { allow } from "@/lib/server/store";
import { json, visitRequest } from "@/lib/server/validate";
import { countActions, networkOf, returning, sourceOf, whereAndDevice } from "@/lib/server/visitor";

export const maxDuration = 30;

/**
 * The visit beacon: the browser reports pages and clicks when the tab is hidden or closed.
 * Every real visit gets one row in the Sessions sheet (updated in place), whether or not they chat.
 */
export async function POST(req: Request) {
  if (await isBot({ strict: true })) return json({ ok: true, skipped: "bot" }, 202);

  const parsed = visitRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, 400);
  const v = parsed.data;
  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL) return json({ ok: true, skipped: "no sheet configured" }, 202);

  if (!(await allow(`visit:ip:${ipHash(req)}`, 120, 3600)) || !(await allow(`visit:s:${v.sessionId}`, 40, 3600))) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }

  after(async () => {
    const [network, isReturning, usage] = await Promise.all([
      networkOf(req),
      returning(req, v.sessionId),
      sessionUsage(req, v.sessionId),
    ]);
    const where = whereAndDevice(req);
    await logSession({
      sessionId: v.sessionId,
      startedAt: v.startedAt,
      lastSeen: new Date().toISOString(),
      timeOnSite: `${Math.floor(v.activeSeconds / 60)}m ${v.activeSeconds % 60}s`,
      pageCount: v.pages.length,
      pages: v.pages.join(" → "),
      entryPage: v.pages[0] ?? "",
      exitPage: v.pages[v.pages.length - 1] ?? "",
      source: sourceOf(v.referrer, v.utm),
      referrer: v.referrer,
      utm: v.utm,
      returning: isReturning,
      actions: countActions(v.actions),
      ...where,
      timezone: where.timezone || v.timezone,
      network,
      screen: v.screen,
      language: v.language,
      ...usage,
    });
  });

  return json({ ok: true }, 202);
}
