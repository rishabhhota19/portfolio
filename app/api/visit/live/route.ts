import * as events from "@/lib/server/events";
import { ipHash } from "@/lib/server/request";
import { allowNearby } from "@/lib/server/store";
import { json, liveRequest } from "@/lib/server/validate";
import { networkOf, sourceOf, whereAndDevice } from "@/lib/server/visitor";

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|curl|wget|python-requests/i;

/**
 * Presence heartbeat for the admin dashboard's "on the site now": an open, visible tab pings every 30 s and on
 * each page change. One Redis command per ping, rate limits included (lib/server/events.ts), analytics only.
 */
export async function POST(req: Request) {
  if (BOT_UA.test(req.headers.get("user-agent") ?? "")) return json({ ok: true, skipped: "bot" }, 202);
  if (!allowNearby(`live:${ipHash(req)}`, 240, 60)) return json({ ok: false, error: "rate_limited" }, 429);
  const parsed = liveRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, 400);
  const p = parsed.data;
  const where = whereAndDevice(req);
  const ok = await events.live({
    sessionId: p.sessionId,
    page: p.page,
    ipHash: ipHash(req),
    city: where.city,
    country: where.country,
    device: where.device,
    // The network (company / ISP) lookup and the source only on a tab's first ping: they don't change.
    ...(p.first ? { network: await networkOf(req), source: sourceOf(p.referrer, p.utm) } : {}),
  });
  return ok ? json({ ok: true }, 202) : json({ ok: false, error: "rate_limited" }, 429);
}
