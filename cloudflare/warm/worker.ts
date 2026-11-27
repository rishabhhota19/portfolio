// Two scheduled jobs on Cloudflare (free plan), in one Worker:
//
// 1. Every 4 minutes: keeps Dumbledore awake. An idle agent instance on Vercel shuts down after roughly 5–8 minutes,
//    and every deploy starts with none, so the next visitor's first question waited about 3 s for Python to start and
//    load its index. This asks the agent's warm-up route (api/index.py), which starts an instance if none is running.
//    Cost: one Worker run (of 100,000 a day) and one Vercel function call (of about 1,000,000 a month) per ping, a few
//    milliseconds when the agent is already awake. The warm-up never calls a model: no tokens, no quota.
//
// 2. Daily at 03:37 UTC (09:07 IST): the quota watchdog (watchdog.ts) — reads Vercel, Upstash and Cloudflare usage
//    and emails Rishabh only when a free quota is on course to run out (and a short summary on Mondays).
//
// Deploy: npm run warm:deploy

import { watch, type WatchEnv } from "./watchdog";

interface Env extends WatchEnv {
  SITE_ORIGIN: string;
  WARM_KEY: string; // a secret (wrangler secret put WARM_KEY), the same value as the agent's WARM_KEY: it proves the cron is calling
}

const DAILY = "37 3 * * *";

export default {
  async scheduled(controller: { scheduledTime: number; cron: string }, env: Env) {
    if (controller.cron === DAILY) {
      const { readings, mailed } = await watch(env, new Date(controller.scheduledTime));
      console.log(`[watchdog] ${readings.map((r) => `${r.service}/${r.what}: ${r.level}`).join("; ")}; mailed ${mailed}`);
      return;
    }
    // A fresh URL each time: the CDN keeps the warm-up's reply for 3 minutes and would answer instead of the agent.
    // The key is what lets this call skip that cache (and keep Groq's prompt cache warm): without it the agent treats
    // the request as a visitor's, so nobody can burn function calls by inventing URLs.
    const minute = Math.floor(controller.scheduledTime / 60_000);
    const res = await fetch(`${env.SITE_ORIGIN}/api/agent/warm?src=cron&t=${minute}`, {
      headers: { "user-agent": "rishabh-warm (Cloudflare cron)", "x-warm-key": env.WARM_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`warm-up answered ${res.status}`); // shows as a failed run in the Worker's metrics
  },

  // A check on demand (no email unless something is past 60%, or it's Monday): GET /watchdog with the warm key.
  // The Worker has no public route (workers_dev is off), so this answers only through `wrangler dev` or a route he adds.
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname !== "/watchdog" || !env.WARM_KEY || request.headers.get("x-warm-key") !== env.WARM_KEY) {
      return new Response("not found", { status: 404 });
    }
    const { body, mailed } = await watch(env);
    return new Response(`${body}\n\nmailed: ${mailed}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
