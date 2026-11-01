import "server-only";
import { redis } from "@/lib/server/store";

// The admin dashboard's own data. Events travel here straight from the site (visits, page views, agent
// turns, chat summaries, leads), in parallel with the Google Sheet, which is only a copy to read on the go.
//
//   ev            list, newest first, capped at 2,000      → the live activity feed
//   leads         list, newest first, capped at 200        → the leads table (never scrolls out with the feed)
//   st:<day>      hash of counters per UTC day (40 days)   → tiles, sparklines, top pages / sources / models
//   live          sorted set: visit id → last heartbeat    → who is on the site right now
//   lv:<visit>    hash: page, city, network… (10 minutes)  → what each of them is looking at
//   vs:<visit>    hash: first-seen flag, active seconds    → count a visit once, add only new time
//
// Every write is ONE Lua script, so one Upstash command (the free plan counts commands), and atomic.
// No chat text is ever stored here: turns carry level, model and tokens; chats only their AI summary.

const FEED = 2000;
const DAY_TTL = 40 * 86_400;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clip = (s: unknown, n = 80) => String(s ?? "").slice(0, n);

// Counters as flat [field, amount, field, amount, …] pairs for the scripts.
type Counts = Record<string, number>;
const pairs = (c: Counts) => Object.entries(c).filter(([, n]) => n).flatMap(([f, n]) => [clip(f), String(Math.round(n))]);

const PUSH = `
if ARGV[1] ~= '' then redis.call('LPUSH', KEYS[1], ARGV[1]) redis.call('LTRIM', KEYS[1], 0, ${FEED - 1}) end
if KEYS[3] then redis.call('LPUSH', KEYS[3], ARGV[1]) redis.call('LTRIM', KEYS[3], 0, 199) redis.call('EXPIRE', KEYS[3], 7776000) end
for i = 3, #ARGV, 2 do redis.call('HINCRBY', KEYS[2], ARGV[i], ARGV[i + 1]) end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1`;

// Visit reports arrive several times per visit (each time the tab is hidden): count the visit once, and add
// only the time that is new since the last report.
const VISIT = `
local first = redis.call('HSETNX', KEYS[3], 'seen', 1)
local before = tonumber(redis.call('HGET', KEYS[3], 'active') or '0')
local now = tonumber(ARGV[3])
if now > before then redis.call('HSET', KEYS[3], 'active', now) redis.call('HINCRBY', KEYS[2], 'active_s', now - before) end
redis.call('EXPIRE', KEYS[3], 172800)
if first == 1 then
  redis.call('LPUSH', KEYS[1], ARGV[1]) redis.call('LTRIM', KEYS[1], 0, ${FEED - 1})
  for i = 4, #ARGV, 2 do redis.call('HINCRBY', KEYS[2], ARGV[i], ARGV[i + 1]) end
end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return first`;

// Heartbeat: mark the visitor live, remember what they're looking at, count a page view when the page changed.
const LIVE = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - 600000)
local before = redis.call('HGET', KEYS[2], 'page')
for i = 5, #ARGV, 2 do redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1]) end
redis.call('HSETNX', KEYS[2], 'since', ARGV[1])
redis.call('HSET', KEYS[2], 'last', ARGV[1])
redis.call('EXPIRE', KEYS[2], 600)
if before ~= ARGV[3] then
  redis.call('HINCRBY', KEYS[3], 'pv', 1) redis.call('HINCRBY', KEYS[3], 'page:' .. ARGV[3], 1)
  redis.call('EXPIRE', KEYS[3], ARGV[4])
end
return 1`;

// Everything the dashboard shows, in one command: live visitors, the feed, and the last 7 days of counters.
const READ = `
local live = {}
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], tonumber(ARGV[1]) - 90000, '+inf')) do
  table.insert(live, redis.call('HGETALL', 'lv:' .. id))
end
local days = {}
for i = 4, #KEYS do table.insert(days, redis.call('HGETALL', KEYS[i])) end
return {live, redis.call('LRANGE', KEYS[2], 0, tonumber(ARGV[2]) - 1), days, redis.call('LRANGE', KEYS[3], 0, 19)}`;

// ── Memory fallback (local development without Redis): same behaviour, one process ──

const mem = { feed: [] as string[], leads: [] as string[], stats: new Map<string, Counts>(), live: new Map<string, Record<string, string>>(), visits: new Map<string, number>() };
const bump = (d: string, c: Counts) => {
  const s = mem.stats.get(d) ?? {};
  for (const [f, n] of Object.entries(c)) s[f] = (s[f] ?? 0) + n;
  mem.stats.set(d, s);
};

async function run(script: string, keys: string[], args: string[], fallback: () => void) {
  if (!redis) return fallback();
  try {
    await redis.eval(script, keys, args);
  } catch (err) {
    console.error("[events] write failed:", err); // the dashboard is best-effort: never break the visitor's request
  }
}

// ── Writers ─────────────────────────────────────────────────────────────────

/** Any event for the feed, plus counters for today. A lead also goes into its own list. */
export async function record(event: Record<string, unknown> | null, counts: Counts) {
  const json = event ? JSON.stringify({ t: Date.now(), ...event }) : "";
  const d = day();
  const isLead = event?.type === "lead";
  await run(PUSH, ["ev", `st:${d}`, ...(isLead ? ["leads"] : [])], [json, String(DAY_TTL), ...pairs(counts)], () => {
    if (json) mem.feed = [json, ...mem.feed].slice(0, FEED);
    if (isLead) mem.leads = [json, ...mem.leads].slice(0, 200);
    bump(d, counts);
  });
}

type Turn = { sessionId: string; page: string; intent: string; why: string; level: string; model: string; tokens_in: number; tokens_out: number; ms: number };

/** One question answered by the agent: which gate or model handled it, how hard, how many tokens, how fast. */
export async function turn(t: Turn) {
  await record(
    { type: "turn", sid: t.sessionId, page: t.page, intent: t.intent, why: t.why, level: t.level, model: t.model, tin: t.tokens_in, tout: t.tokens_out, ms: t.ms },
    { q: 1, tin: t.tokens_in, tout: t.tokens_out, ms: t.ms, [`intent:${t.intent || "?"}`]: 1, [`model:${t.model || "?"}`]: 1, ...(t.level ? { [`level:${t.level}`]: 1 } : {}) },
  );
}

type Visit = { sessionId: string; activeSeconds: number; entry: string; source: string; city: string; country: string; device: string; network: string; returning: boolean };

/** A visit report (sent each time the tab is hidden): the first one counts the visit; each adds new active time. */
export async function visit(v: Visit) {
  const event = JSON.stringify({ t: Date.now(), type: "visit", sid: v.sessionId, entry: v.entry, src: v.source, city: v.city, country: v.country, device: v.device, net: v.network, returning: v.returning });
  const firsts: Counts = { visits: 1, returning: v.returning ? 1 : 0, [`src:${v.source}`]: 1, [`country:${v.country || "?"}`]: 1, [`device:${v.device || "?"}`]: 1, ...(v.network ? { [`net:${v.network}`]: 1 } : {}) };
  const d = day();
  await run(VISIT, ["ev", `st:${d}`, `vs:${v.sessionId}`], [event, String(DAY_TTL), String(v.activeSeconds), ...pairs(firsts)], () => {
    const before = mem.visits.get(v.sessionId);
    if (before === undefined) {
      mem.feed = [event, ...mem.feed].slice(0, FEED);
      bump(d, firsts);
    }
    if (v.activeSeconds > (before ?? 0)) bump(d, { active_s: v.activeSeconds - (before ?? 0) });
    mem.visits.set(v.sessionId, Math.max(before ?? 0, v.activeSeconds));
  });
}

type Presence = { sessionId: string; page: string; city?: string; country?: string; device?: string; network?: string; source?: string };

/** Heartbeat from an open, visible tab (every 30 s and on each page change). */
export async function live(p: Presence) {
  const now = Date.now();
  const fields = Object.entries({ page: p.page, city: p.city, country: p.country, device: p.device, net: p.network, src: p.source, sid: p.sessionId.slice(0, 8) })
    .filter(([, v]) => v)
    .flatMap(([k, v]) => [k, clip(v)]);
  const d = day(now);
  await run(LIVE, ["live", `lv:${p.sessionId}`, `st:${d}`], [String(now), p.sessionId, clip(p.page, 200), String(DAY_TTL), ...fields], () => {
    const before = mem.live.get(p.sessionId);
    if (before?.page !== p.page) bump(d, { pv: 1, [`page:${p.page}`]: 1 });
    const entry: Record<string, string> = { ...before, since: before?.since ?? String(now), last: String(now) };
    for (let i = 0; i < fields.length; i += 2) entry[fields[i]] = fields[i + 1];
    mem.live.set(p.sessionId, entry);
  });
}

// ── Reader (admin only) ─────────────────────────────────────────────────────

export type Snapshot = {
  now: number;
  live: Record<string, string>[];
  events: Record<string, unknown>[];
  days: { day: string; stats: Counts }[]; // oldest → today
  leads: Record<string, unknown>[];
};

const toObject = (flat: string[]) => Object.fromEntries(flat.flatMap((_, i) => (i % 2 ? [] : [[flat[i], flat[i + 1]]])));
const toCounts = (flat: string[]): Counts => Object.fromEntries(Object.entries(toObject(flat)).map(([k, v]) => [k, Number(v)]));

export async function snapshot(feed = 80): Promise<Snapshot> {
  const now = Date.now();
  const dayNames = Array.from({ length: 7 }, (_, i) => day(now - (6 - i) * 86_400_000));
  const parse = (rows: string[]) => rows.flatMap((r) => { try { return [JSON.parse(r)]; } catch { return []; } });
  if (!redis) {
    return {
      now,
      live: [...mem.live.values()].filter((v) => now - Number(v.last) < 90_000),
      events: parse(mem.feed.slice(0, feed)),
      days: dayNames.map((d) => ({ day: d, stats: mem.stats.get(d) ?? {} })),
      leads: parse(mem.leads.slice(0, 20)),
    };
  }
  const keys = ["live", "ev", "leads", ...dayNames.map((d) => `st:${d}`)];
  const [live, rows, days, leads] = (await redis.eval(READ, keys, [String(now), String(feed)])) as [string[][], unknown[], string[][], unknown[]];
  // The Upstash client may hand back already-parsed JSON (see store.ts): accept both.
  const events = (list: unknown[]) => list.flatMap((r) => (typeof r === "string" ? parse([r]) : r && typeof r === "object" ? [r as Record<string, unknown>] : []));
  return {
    now,
    live: live.map(toObject),
    events: events(rows),
    days: dayNames.map((d, i) => ({ day: d, stats: toCounts(days[i] ?? []) })),
    leads: events(leads ?? []),
  };
}
