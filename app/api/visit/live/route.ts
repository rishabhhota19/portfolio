import * as events from "@/lib/server/events";
import { ipHash } from "@/lib/server/request";
import { allow } from "@/lib/server/store";
import { json, liveRequest } from "@/lib/server/validate";
import { networkOf, sourceOf, whereAndDevice } from "@/lib/server/visitor";

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|curl|wget|python-requests/i;

/**
 * Presence heartbeat for the admin dashboard's "on the site now": an open, visible tab pings every 30 s and on
 * each page change. One Redis command per ping, rate-limited, analytics only (no Sheet write, no LLM).
 */
export async function POST(req: Request) {
  if (BOT_UA.test(req.headers.get("user-agent") ?? "")) return json({ ok: true, skipped: "bot" }, 202);
  const parsed = liveRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, 400);
  const p = parsed.data;
  if (!(await allow(`live:s:${p.sessionId}`, 240, 3600)) || !(await allow(`live:ip:${ipHash(req)}`, 1200, 3600))) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }
  const where = whereAndDevice(req);
  await events.live({
    sessionId: p.sessionId,
    page: p.page,
    city: where.city,
    country: where.country,
    device: where.device,
    // The network (company / ISP) lookup and the source only on a tab's first ping: they don't change.
    ...(p.first ? { network: await networkOf(req), source: sourceOf(p.referrer, p.utm) } : {}),
  });
  return json({ ok: true }, 202);
}
