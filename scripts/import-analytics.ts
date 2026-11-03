// One-time, after the switch to the analytics Worker (cloudflare/analytics/): copies the dashboard's history from
// Upstash into it, so the dashboard keeps its last 40 days of counters, the activity feed and the leads.
// Safe to run twice: the Worker remembers a finished import and ignores later ones.
//
// Run: npx tsx --env-file=.env.local scripts/import-analytics.ts
import { Redis } from "@upstash/redis";

const url = (process.env.NEXT_PUBLIC_ANALYTICS_URL ?? "").replace(/\/+$/, "");
const secret = process.env.ANALYTICS_SECRET ?? "";
if (!url || !secret) throw new Error("Set NEXT_PUBLIC_ANALYTICS_URL and ANALYTICS_SECRET (in .env.local).");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
  automaticDeserialization: false, // feed rows stay the exact JSON strings they were stored as
});

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const time = (json: string) => {
  try {
    return Number(JSON.parse(json).t) || Date.now();
  } catch {
    return Date.now();
  }
};

async function send(batch: object) {
  const res = await fetch(`${url}/import`, {
    method: "POST",
    headers: { "x-events-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
  if (!res.ok || !out.ok) throw new Error(`Import stopped: ${res.status} ${out.reason ?? ""}`);
}

const now = Date.now();
const days: { day: string; stats: Record<string, number> }[] = [];
for (let i = 39; i >= 0; i--) {
  const d = day(now - i * 86_400_000);
  const flat = (await redis.hgetall<Record<string, string>>(`st:${d}`)) ?? {};
  if (Object.keys(flat).length) days.push({ day: d, stats: Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, Number(v)])) });
}
const feed = ((await redis.lrange("ev", 0, 1999)) as string[]).reverse(); // oldest first
const leads = ((await redis.lrange("leads", 0, 199)) as string[]).reverse().map((json) => ({ json, at: time(json) }));

// Each batch is placed before what the Worker already holds, so the newest batch goes first.
const batches: object[] = [
  ...chunks(days, 10).map((d) => ({ days: d })),
  ...chunks(feed, 200).reverse().map((f) => ({ feed: f })),
  ...chunks(leads, 100).reverse().map((l) => ({ leads: l })),
];
for (const batch of batches) await send(batch);
await send({ done: true });
console.log(`Imported ${days.length} days of counters, ${feed.length} feed events and ${leads.length} leads.`);
