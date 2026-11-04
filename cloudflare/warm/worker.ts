// Keeps Dumbledore awake, on Cloudflare (free plan). An idle agent instance on Vercel shuts down after roughly 5–8
// minutes, and every deploy starts with none, so the next visitor's first question waited about 3 s for Python to start
// and load its index. Every 4 minutes this asks the agent's warm-up route (api/index.py), which starts an instance if
// none is running; a new instance loads everything as it starts.
//
// Cost: one Worker run (of 100,000 a day) and one Vercel function call (of about 1,000,000 a month) per ping, a few
// milliseconds when the agent is already awake. The warm-up never calls a model: no tokens, no quota.
// Deploy: npm run warm:deploy

interface Env {
  SITE_ORIGIN: string;
  WARM_KEY: string; // a secret (wrangler secret put WARM_KEY), the same value as the agent's WARM_KEY: it proves the cron is calling
}

export default {
  async scheduled(controller: { scheduledTime: number }, env: Env) {
    // A fresh URL each time: the CDN keeps the warm-up's reply for 3 minutes and would answer instead of the agent.
    // The key is what lets this call skip that cache (and keep Groq's prompt cache warm): without it the agent treats
    // the request as a visitor's, so nobody can burn function calls by inventing URLs.
    const minute = Math.floor(controller.scheduledTime / 60_000);
    const res = await fetch(`${env.SITE_ORIGIN}/api/agent/warm?src=cron&t=${minute}`, {
      headers: { "user-agent": "rishabh-warm (Cloudflare cron)", "x-warm-key": env.WARM_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`warm-up answered ${res.status}`); // shows as a failed run in the Worker's metrics
  },
};
