// Secrets (wrangler secret put), added to the Env that `wrangler types` generates from wrangler.jsonc.
interface Env {
  EVENTS_SECRET: string;
  IP_HASH_SALT: string;
}
