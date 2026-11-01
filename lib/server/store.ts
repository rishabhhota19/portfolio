import "server-only";
import { Redis } from "@upstash/redis";

// Small key-value surface for rate limits, the daily LLM budget and provider cooldowns.
// Uses Upstash Redis when configured (Vercel Marketplace sets KV_REST_API_*; the Upstash console gives
// UPSTASH_REDIS_REST_*). Falls back to process memory for local development.
interface Store {
  incr(key: string, ttlSeconds: number, by?: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  push(key: string, value: string, ttlSeconds: number): Promise<void>; // append to a list
  peek(key: string, count: number): Promise<string[]>; // read up to `count` from the front of a list
  remove(key: string, items: string[]): Promise<void>; // take those items out (after they were handled)
}

// Counter and list writes as one script each: one Upstash command, and the expiry can never be lost between two calls.
const INCR = "local n = redis.call('INCRBY', KEYS[1], ARGV[2]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";
const PUSH = "redis.call('RPUSH', KEYS[1], ARGV[1]) redis.call('EXPIRE', KEYS[1], ARGV[2]) return 1";
const REMOVE = "for i = 1, #ARGV do redis.call('LREM', KEYS[1], 1, ARGV[i]) end return 1";

class RedisStore implements Store {
  constructor(private redis: Redis) {}

  async incr(key: string, ttlSeconds: number, by = 1) {
    return Number(await this.redis.eval(INCR, [key], [String(Math.max(1, Math.ceil(ttlSeconds))), String(by)]));
  }

  async get(key: string) {
    // The Upstash client turns stored JSON back into objects; callers expect the string they saved
    // (String() would give "[object Object]" — that broke a visit's second chat summary and its lead).
    const v = await this.redis.get<unknown>(key);
    return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
  }

  async push(key: string, value: string, ttlSeconds: number) {
    await this.redis.eval(PUSH, [key], [value, String(Math.max(1, Math.ceil(ttlSeconds)))]);
  }

  async peek(key: string, count: number) {
    const items = await this.redis.lrange<unknown>(key, 0, count - 1);
    return items.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  }

  async remove(key: string, items: string[]) {
    if (items.length) await this.redis.eval(REMOVE, [key], items);
  }
}

class MemoryStore implements Store {
  private data = new Map<string, { value: string; expires: number }>();

  private live(key: string) {
    const hit = this.data.get(key);
    if (hit && hit.expires < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return hit;
  }

  async incr(key: string, ttlSeconds: number, by = 1) {
    const hit = this.live(key);
    const n = (hit ? Number(hit.value) : 0) + by;
    this.data.set(key, { value: String(n), expires: hit?.expires ?? Date.now() + ttlSeconds * 1000 });
    return n;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  private lists = new Map<string, string[]>();

  async push(key: string, value: string) {
    this.lists.set(key, [...(this.lists.get(key) ?? []), value]);
  }

  async peek(key: string, count: number) {
    return (this.lists.get(key) ?? []).slice(0, count);
  }

  async remove(key: string, items: string[]) {
    const left = [...(this.lists.get(key) ?? [])];
    for (const item of items) {
      const i = left.indexOf(item);
      if (i >= 0) left.splice(i, 1);
    }
    this.lists.set(key, left);
  }
}

/**
 * Upstash first; if it errors (an outage, or the free tier's monthly cap), process memory, so chat and leads keep working
 * with per-instance limits instead of failing. The model providers' own free quotas still cap spending at zero.
 */
class FallbackStore implements Store {
  private memory = new MemoryStore();
  private warned = false;
  constructor(private primary: Store) {}

  private async use<T>(op: (s: Store) => Promise<T>): Promise<T> {
    try {
      return await op(this.primary);
    } catch (err) {
      if (!this.warned) console.error("[store] Upstash failed, using memory:", err);
      this.warned = true;
      return op(this.memory);
    }
  }

  incr(key: string, ttlSeconds: number, by = 1) { return this.use((s) => s.incr(key, ttlSeconds, by)); }
  get(key: string) { return this.use((s) => s.get(key)); }
  set(key: string, value: string, ttlSeconds: number) { return this.use((s) => s.set(key, value, ttlSeconds)); }
  push(key: string, value: string, ttlSeconds: number) { return this.use((s) => s.push(key, value, ttlSeconds)); }
  peek(key: string, count: number) { return this.use((s) => s.peek(key, count)); }
  remove(key: string, items: string[]) { return this.use((s) => s.remove(key, items)); }
}

function createRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new Redis({ url, token });
  if (process.env.VERCEL_ENV === "production") {
    console.warn("[store] Upstash Redis is not configured — rate limits are per-instance only.");
  }
  return null;
}

const globalForStore = globalThis as unknown as { __portfolioRedis?: Redis | null; __portfolioStore?: Store };
/** The shared Upstash client, or null locally (then everything falls back to process memory). */
export const redis: Redis | null = (globalForStore.__portfolioRedis ??= createRedis());
export const store: Store = (globalForStore.__portfolioStore ??= redis ? new FallbackStore(new RedisStore(redis)) : new MemoryStore());

const nearby = new Map<string, { n: number; until: number }>();

/** The same limit kept in this server instance's memory, checked before Redis: a flood from one network is turned
 * away without spending Upstash commands (the free plan counts every one, even a rejection). */
export function allowNearby(key: string, max: number, windowSeconds: number) {
  const now = Date.now();
  const hit = nearby.get(key);
  if (!hit || hit.until <= now) {
    if (nearby.size > 10_000) nearby.clear();
    nearby.set(key, { n: 1, until: now + windowSeconds * 1000 });
    return true;
  }
  return ++hit.n <= max;
}

/** Fixed-window counter. Returns true while `key` is under `max` hits per `windowSeconds`. */
export async function allow(key: string, max: number, windowSeconds: number) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const n = await store.incr(`rl:${key}:${bucket}`, windowSeconds);
  return n <= max;
}

/** A whole number from the environment; blank, missing or invalid means `fallback` (Number("") would be 0). */
export function envNumber(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type Budget = "budget" | "budget-summary"; // chat answers and chat summaries are counted separately
const budgetKey = (name: Budget) => `${name}:${new Date().toISOString().slice(0, 10)}`; // per UTC day

/** Counts one LLM call against today's global budget. */
export async function spendDailyBudget(max: number, name: Budget = "budget") {
  return (await store.incr(budgetKey(name), 60 * 60 * 26)) <= max;
}

/** Gives the call back when the reply needed no model (a greeting, a cached answer, a refusal, a page jump). */
export async function refundDailyBudget(name: Budget = "budget") {
  await store.incr(budgetKey(name), 60 * 60 * 26, -1);
}

export async function setCooldown(provider: string, seconds: number) {
  await store.set(`cooldown:${provider}`, "1", seconds);
}

export async function isCoolingDown(provider: string) {
  return (await store.get(`cooldown:${provider}`)) !== null;
}

/** True the first time a given key is seen within `ttlSeconds` (used to dedupe logging). */
export async function firstTime(key: string, ttlSeconds: number) {
  return (await store.incr(`once:${key}`, ttlSeconds)) === 1;
}
