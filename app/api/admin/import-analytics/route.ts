import { createHash, timingSafeEqual } from "node:crypto";
import { redis } from "@/lib/server/store";
import { json } from "@/lib/server/validate";

export const maxDuration = 60;

// TEMPORARY: deleted right after it has run once. Copies the dashboard's history from Upstash into the analytics
// Worker (cloudflare/analytics/): 40 days of counters, the activity feed and the leads. Runs here because only the
// deployed site holds the Upstash credentials. Needs ANALYTICS_SECRET; the Worker ignores any run after the first.

const WORKER = (process.env.NEXT_PUBLIC_ANALYTICS_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.ANALYTICS_SECRET ?? "";
const digest = (s: string) => createHash("sha256").update(s).digest();
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const asText = (r: unknown) => (typeof r === "string" ? r : JSON.stringify(r)); // the client may hand back parsed JSON
const time = (row: string) => {
  try {
    return Number(JSON.parse(row).t) || Date.now();
  } catch {
    return Date.now();
  }
};

async function send(batch: object) {
  const res = await fetch(`${WORKER}/import`, {
    method: "POST",
    headers: { "x-events-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(batch),
    cache: "no-store",
  });
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
  if (!res.ok || !out.ok) throw new Error(`worker ${res.status} ${out.reason ?? ""}`);
}

export async function POST(req: Request) {
  if (!WORKER || !SECRET || !timingSafeEqual(digest(req.headers.get("x-events-secret") ?? ""), digest(SECRET))) {
    return json({ ok: false }, 401);
  }
  if (!redis) return json({ ok: false, error: "no upstash" }, 503);
  const db = redis;
  const now = Date.now();
  const names = Array.from({ length: 40 }, (_, i) => day(now - (39 - i) * 86_400_000));
  const flats = await Promise.all(names.map((d) => db.hgetall<Record<string, unknown>>(`st:${d}`)));
  const days = names.flatMap((d, i) => {
    const flat = flats[i];
    return flat && Object.keys(flat).length ? [{ day: d, stats: Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, Number(v)])) }] : [];
  });
  const feed = (await db.lrange("ev", 0, 1999)).map(asText).reverse(); // oldest first
  const leads = (await db.lrange("leads", 0, 199)).map(asText).reverse().map((row) => ({ json: row, at: time(row) }));
  try {
    // Each batch is placed before what the Worker already holds, so the newest batch goes first.
    const batches = [
      ...chunks(days, 10).map((d) => ({ days: d })),
      ...chunks(feed, 200).reverse().map((f) => ({ feed: f })),
      ...chunks(leads, 100).reverse().map((l) => ({ leads: l })),
    ];
    for (const batch of batches) await send(batch);
    await send({ done: true });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "failed" }, 502);
  }
  return json({ ok: true, days: days.length, feed: feed.length, leads: leads.length });
}
