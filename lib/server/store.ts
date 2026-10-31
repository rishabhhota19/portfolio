import "server-only";
import { Redis } from "@upstash/redis";

// Small key-value surface for rate limits, the daily LLM budget and provider cooldowns.
// Uses Upstash Redis when configured (Vercel Marketplace sets KV_REST_API_*; the Upstash console gives
// UPSTASH_REDIS_REST_*). Falls back to process memory for local development.
interface Store {
  incr(key: string, ttlSeconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}

  async incr(key: string, ttlSeconds: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }

  async get(key: string) {
    const v = await this.redis.get<string | number>(key);
    return v == null ? null : String(v);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
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

  async incr(key: string, ttlSeconds: number) {
    const hit = this.live(key);
    const n = (hit ? Number(hit.value) : 0) + 1;
    this.data.set(key, { value: String(n), expires: hit?.expires ?? Date.now() + ttlSeconds * 1000 });
    return n;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
}

function createStore(): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(new Redis({ url, token }));
  if (process.env.VERCEL_ENV === "production") {
    console.warn("[store] Upstash Redis is not configured — rate limits are per-instance only.");
  }
  return new MemoryStore();
}

const globalForStore = globalThis as unknown as { __portfolioStore?: Store };
export const store: Store = (globalForStore.__portfolioStore ??= createStore());

/** Fixed-window counter. Returns true while `key` is under `max` hits per `windowSeconds`. */
export async function allow(key: string, max: number, windowSeconds: number) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const n = await store.incr(`rl:${key}:${bucket}`, windowSeconds);
  return n <= max;
}

/** Counts one LLM call against today's global budget (UTC day). */
export async function spendDailyBudget(max: number) {
  const day = new Date().toISOString().slice(0, 10);
  const n = await store.incr(`budget:${day}`, 60 * 60 * 26);
  return n <= max;
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
