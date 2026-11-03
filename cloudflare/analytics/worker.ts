// The admin dashboard's analytics, on Cloudflare (free plan): a Worker in front of one Durable Object (stats.ts).
//
//   POST /live      the browser's "still here" heartbeat, straight from the site's pages (no Vercel request)
//   POST /event     from the site's server (secret): visits, agent turns, chats, leads, and heartbeats that fell back
//   GET  /snapshot  from the site's server (secret): everything the dashboard shows
//   POST /import    one-time history import from Upstash (secret)
//
// Deploy: npm run analytics:deploy. Secrets (wrangler secret put): EVENTS_SECRET (= ANALYTICS_SECRET on Vercel) and
// IP_HASH_SALT (networks are only ever kept as salted hashes, in memory, for the rate limit).
import { BOT_UA, deviceType, sourceOf } from "../../lib/traffic";
import { Stats, type Counts, type Presence } from "./stats";

export { Stats };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : v == null ? "" : null);

const stats = (env: Env) => env.STATS.get(env.STATS.idFromName("site"));

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The secret header, compared in constant time. */
async function authorized(req: Request, env: Env) {
  if (!env.EVENTS_SECRET) return false;
  const [given, expected] = await Promise.all([sha256(req.headers.get("x-events-secret") ?? ""), sha256(env.EVENTS_SECRET)]);
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(expected));
}

/** Heartbeat from an open, visible tab on the site (every 30 s and on each page change). Sent as text/plain, so the
 * browser needs no CORS preflight: one request per ping. Every answer carries the CORS header; a missing one would
 * make the browser fall back to the Vercel route. */
async function live(req: Request, env: Env) {
  const cors = { "access-control-allow-origin": env.SITE_ORIGIN };
  const ua = req.headers.get("user-agent") ?? "";
  if (BOT_UA.test(ua)) return json({ ok: true, skipped: "bot" }, 202, cors);
  if (req.headers.get("origin") !== env.SITE_ORIGIN) return json({ ok: false }, 403, cors);
  const body = (await req.text().then((t) => (t.length <= 2000 ? JSON.parse(t) : null)).catch(() => null)) as Record<string, unknown> | null;
  const page = text(body?.page, 200);
  const referrer = text(body?.referrer, 300);
  const utm = text(body?.utm, 200);
  if (!body || typeof body.sessionId !== "string" || !UUID.test(body.sessionId) || !page?.startsWith("/") || referrer === null || utm === null
    || (body.first !== undefined && typeof body.first !== "boolean")) {
    return json({ ok: false }, 400, cors);
  }
  const cf = (req.cf ?? {}) as { city?: string; country?: string; asOrganization?: string };
  const result = await stats(env).live({
    sessionId: body.sessionId,
    page,
    ipHash: (await sha256(`${env.IP_HASH_SALT}:${req.headers.get("cf-connecting-ip") ?? ""}`)).slice(0, 16),
    city: cf.city,
    country: cf.country,
    device: deviceType(ua),
    // The network (company / ISP) and the source only on a tab's first ping: they don't change.
    ...(body.first ? { network: cf.asOrganization ?? "", source: sourceOf(referrer, utm) } : {}),
  });
  return result === -1 ? json({ ok: false, error: "rate_limited" }, 429, cors) : json({ ok: true }, 202, cors);
}

type EventBody =
  | { op: "push"; event: string; counts: Counts; lead?: boolean }
  | { op: "visit"; sessionId: string; activeSeconds: number; event: string; counts: Counts }
  | { op: "live"; presence: Presence };

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/live") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": env.SITE_ORIGIN, "access-control-max-age": "86400" } });
      if (req.method === "POST") return live(req, env);
    }
    if (!["/event", "/snapshot", "/import"].includes(pathname)) return json({ ok: false }, 404);
    if (!(await authorized(req, env))) return json({ ok: false }, 401);
    const stub = stats(env);
    if (pathname === "/snapshot") return json(await stub.snapshot(Number(new URL(req.url).searchParams.get("feed")) || 80));
    const body = (await req.json().catch(() => null)) as EventBody | null;
    if (!body) return json({ ok: false }, 400);
    if (pathname === "/import") return json(await stub.importBatch(body as Parameters<Stats["importBatch"]>[0]));
    if (body.op === "push") await stub.push(body.event, body.counts, body.lead);
    else if (body.op === "visit") await stub.visit(body.sessionId, body.activeSeconds, body.event, body.counts);
    else if (body.op === "live") return json({ ok: (await stub.live(body.presence)) !== -1 });
    else return json({ ok: false }, 400);
    return json({ ok: true });
  },
} satisfies ExportedHandler<Env>;
