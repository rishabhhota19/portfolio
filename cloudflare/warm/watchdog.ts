// The quota watchdog: once a day, reads how much of each free plan the site has used and emails Rishabh only when
// something is on course to run out. Nothing here deletes anything: every store already expires or caps itself
// (Redis keys all have TTLs, the analytics Durable Object prunes itself, Vercel keeps logs 1 hour). What can break
// the site is a quota: Vercel Hobby pauses the project for 30 days past 4 CPU-hours a month; Upstash refuses
// commands past 500,000 a month; Cloudflare refuses Worker requests past 100,000 a day.
//
// Each source turns on when its secrets are set (wrangler secret put … --config cloudflare/warm/wrangler.jsonc):
//   Vercel      VERCEL_TOKEN (a read token from his personal account), VERCEL_TEAM_ID
//   Upstash     UPSTASH_EMAIL, UPSTASH_API_KEY (Console → Account → Management API); the database is found by
//               UPSTASH_ENDPOINT, the REST host the site uses
//   Cloudflare  CF_ANALYTICS_TOKEN (an API token with Account Analytics: Read), CF_ACCOUNT_ID
//   Email       SHEETS_WEBHOOK_URL, SHEETS_SECRET (the Apps Script that already mails him lead alerts)
// A source without its secrets is reported as "not set up", never as fine.
//
// Pace: a monthly quota is judged by where the month is heading (used so far ÷ share of the month gone), a daily one
// by today so far. WARN at 60% of the allowance, ACT at 85%. Silent on other days, except a short Monday summary so
// a silent watchdog is known to be alive.

export interface WatchEnv {
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  UPSTASH_EMAIL?: string;
  UPSTASH_API_KEY?: string;
  UPSTASH_ENDPOINT?: string;
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  SHEETS_WEBHOOK_URL?: string;
  SHEETS_SECRET?: string;
}

type Level = "ok" | "warn" | "act" | "unknown";
type Reading = { service: string; what: string; used: number; limit: number; unit: string; projected: number; level: Level; note?: string };

const WARN = 0.6;
const ACT = 0.85;

// The free allowances (checked 28 Nov 2026: vercel.com/docs/plans/hobby, upstash.com/pricing/redis,
// developers.cloudflare.com/workers/platform/limits).
const LIMITS = {
  vercelCpuHours: 4,
  vercelInvocations: 1_000_000,
  upstashCommands: 500_000,
  upstashStorageBytes: 256 * 1024 * 1024,
  workerRequestsPerDay: 100_000,
};

function level(projected: number, limit: number, used: number): Level {
  const share = Math.max(projected, used) / limit;
  return share >= ACT ? "act" : share >= WARN ? "warn" : "ok";
}

/** The share of the UTC month gone, so a monthly figure can be projected to the month's end. */
function monthGone(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max((now.getTime() - start) / (end - start), 1 / 31);
}

function reading(service: string, what: string, used: number, limit: number, unit: string, gone: number, note?: string): Reading {
  const projected = gone >= 1 ? used : used / gone;
  return { service, what, used, limit, unit, projected, level: level(projected, limit, used), note };
}

const missing = (service: string, what: string, needs: string): Reading =>
  ({ service, what, used: 0, limit: 0, unit: "", projected: 0, level: "unknown", note: `not set up: ${needs}` });

// ── Upstash ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function upstash(env: WatchEnv, gone: number): Promise<Reading[]> {
  if (!env.UPSTASH_EMAIL || !env.UPSTASH_API_KEY || !env.UPSTASH_ENDPOINT) {
    return [missing("Upstash Redis", "commands this month", "UPSTASH_EMAIL, UPSTASH_API_KEY")];
  }
  const auth = { authorization: `Basic ${btoa(`${env.UPSTASH_EMAIL}:${env.UPSTASH_API_KEY}`)}` };
  const list = await fetch("https://api.upstash.com/v2/redis/databases", { headers: auth });
  if (!list.ok) return [{ ...missing("Upstash Redis", "commands this month", ""), note: `Upstash API answered ${list.status}` }];
  const dbs = (await list.json()) as { database_id: string; endpoint: string }[];
  const db = dbs.find((d) => env.UPSTASH_ENDPOINT!.includes(d.endpoint));
  if (!db) return [{ ...missing("Upstash Redis", "commands this month", ""), note: `no database with endpoint ${env.UPSTASH_ENDPOINT}` }];
  const res = await fetch(`https://api.upstash.com/v2/redis/stats/${db.database_id}`, { headers: auth });
  if (!res.ok) return [{ ...missing("Upstash Redis", "commands this month", ""), note: `stats answered ${res.status}` }];
  const s = (await res.json()) as { total_monthly_requests?: number; daily_net_commands?: number; current_storage?: number };
  return [
    reading("Upstash Redis", "commands this month", s.total_monthly_requests ?? 0, LIMITS.upstashCommands, "commands", gone,
      `today ${s.daily_net_commands ?? 0}`),
    reading("Upstash Redis", "storage", s.current_storage ?? 0, LIMITS.upstashStorageBytes, "bytes", 1),
  ];
}

// ── Vercel ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// /v1/billing/charges (FOCUS rows, one per day and line item). Its docs don't name the line items, so they are
// matched by words, and every line item seen is listed in the email until the names are confirmed.
async function vercel(env: WatchEnv, now: Date, gone: number): Promise<{ readings: Reading[]; items: string[] }> {
  if (!env.VERCEL_TOKEN) return { readings: [missing("Vercel", "CPU and invocations this month", "VERCEL_TOKEN")], items: [] };
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const to = new Date(now.getTime() + 86_400_000).toISOString();
  const team = env.VERCEL_TEAM_ID ? `&teamId=${env.VERCEL_TEAM_ID}` : "";
  const res = await fetch(`https://api.vercel.com/v1/billing/charges?from=${from}&to=${to}${team}`,
    { headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`, "accept-encoding": "identity" } });
  if (!res.ok) return { readings: [{ ...missing("Vercel", "CPU and invocations this month", ""), note: `billing API answered ${res.status}` }], items: [] };
  const totals = new Map<string, { qty: number; unit: string }>();
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { ServiceName?: string; SkuId?: string; ConsumedQuantity?: number | null; ConsumedUnit?: string; ChargeCategory?: string };
      if (r.ChargeCategory && r.ChargeCategory !== "Usage") continue;
      const name = `${r.ServiceName ?? ""} / ${r.SkuId ?? ""}`;
      const t = totals.get(name) ?? { qty: 0, unit: r.ConsumedUnit ?? "" };
      t.qty += Number(r.ConsumedQuantity ?? 0);
      totals.set(name, t);
    } catch { /* not a row */ }
  }
  const find = (pattern: RegExp) => [...totals.entries()].find(([n]) => pattern.test(n));
  const readings: Reading[] = [];
  const cpu = find(/active\s*cpu|cpu/i);
  if (cpu) {
    const hours = /second/i.test(cpu[1].unit) ? cpu[1].qty / 3600 : /minute/i.test(cpu[1].unit) ? cpu[1].qty / 60 : cpu[1].qty;
    readings.push(reading("Vercel", "Active CPU this month", hours, LIMITS.vercelCpuHours, "hours", gone, `${cpu[0]}, ${cpu[1].qty} ${cpu[1].unit}`));
  } else readings.push({ ...missing("Vercel", "Active CPU this month", ""), note: "no CPU line item found: see the line items listed below" });
  const calls = find(/invocation/i);
  if (calls) readings.push(reading("Vercel", "function invocations this month", calls[1].qty, LIMITS.vercelInvocations, "calls", gone, calls[0]));
  else readings.push({ ...missing("Vercel", "function invocations this month", ""), note: "no invocation line item found" });
  return { readings, items: [...totals.entries()].map(([n, t]) => `${n}: ${Math.round(t.qty * 100) / 100} ${t.unit}`) };
}

// ── Cloudflare ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function cloudflare(env: WatchEnv, now: Date): Promise<Reading[]> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return [missing("Cloudflare Workers", "requests today", "CF_ANALYTICS_TOKEN")];
  }
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
  const query = `query($a: String!, $today: Time!, $day: Time!) { viewer { accounts(filter: { accountTag: $a }) {
    today: workersInvocationsAdaptive(limit: 50, filter: { datetime_geq: $today }) { sum { requests } dimensions { scriptName } }
    gateway: workersInvocationsAdaptive(limit: 1, filter: { scriptName: "rishabh-gateway", datetime_geq: $day }) {
      sum { requests errors } quantiles { cpuTimeP50 cpuTimeP90 } } } } }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, today: since, day: yesterday } }),
  });
  const data = (await res.json()) as { data?: { viewer: { accounts: { today: { sum: { requests: number } }[];
    gateway: { sum: { requests: number; errors: number }; quantiles: { cpuTimeP50: number; cpuTimeP90: number } }[] }[] } };
    errors?: { message: string }[] };
  const account = data.data?.viewer.accounts[0];
  if (!account) return [{ ...missing("Cloudflare Workers", "requests today", ""), note: data.errors?.[0]?.message ?? `answered ${res.status}` }];
  const requests = account.today.reduce((n, r) => n + r.sum.requests, 0);
  const dayGone = Math.max((now.getTime() - Date.parse(since)) / 86_400_000, 1 / 24);
  const g = account.gateway[0];
  const gatewayNote = g ? `gateway last 24 h: ${g.sum.requests} requests, ${g.sum.errors} errors, CPU median ${(g.quantiles.cpuTimeP50 / 1000).toFixed(1)} ms, 90th ${(g.quantiles.cpuTimeP90 / 1000).toFixed(1)} ms` : undefined;
  return [reading("Cloudflare Workers", "requests today (all Workers)", requests, LIMITS.workerRequestsPerDay, "requests", dayGone, gatewayNote)];
}

// ── the daily run ───────────────────────────────────────────────────────────────────────────────────────────────────
const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-IN") : (Math.round(n * 100) / 100).toString());

function line(r: Reading): string {
  if (r.level === "unknown") return `?  ${r.service}: ${r.what} — ${r.note}`;
  const mark = { ok: "OK", warn: "WARN", act: "ACT NOW" }[r.level];
  const pct = Math.round((Math.max(r.projected, r.used) / r.limit) * 100);
  return `${mark.padEnd(7)} ${r.service}: ${r.what} ${fmt(r.used)} of ${fmt(r.limit)} ${r.unit}, heading for ${pct}%${r.note ? ` (${r.note})` : ""}`;
}

export async function watch(env: WatchEnv, now = new Date()): Promise<{ readings: Reading[]; mailed: boolean; body: string }> {
  const gone = monthGone(now);
  const settled = await Promise.allSettled([upstash(env, gone), vercel(env, now, gone), cloudflare(env, now)]);
  const readings: Reading[] = [];
  let items: string[] = [];
  const names = ["Upstash Redis", "Vercel", "Cloudflare Workers"];
  settled.forEach((s, i) => {
    if (s.status === "rejected") readings.push({ ...missing(names[i], "usage", ""), note: `failed: ${String(s.reason).slice(0, 120)}` });
    else if (Array.isArray(s.value)) readings.push(...s.value);
    else { readings.push(...s.value.readings); items = s.value.items; }
  });
  const worst = readings.some((r) => r.level === "act") ? "act" : readings.some((r) => r.level === "warn") ? "warn" : "ok";
  const monday = now.getUTCDay() === 1;
  const calibrating = items.length > 0 && !readings.some((r) => r.service === "Vercel" && r.level !== "unknown");
  const unknown = readings.filter((r) => r.level === "unknown").length;
  const body = [
    worst === "act" ? "Something is close to its free limit. Act now:" : worst === "warn" ? "Something is heading past 60% of its free limit:"
      : unknown ? `Fine where measured; ${unknown} reading${unknown > 1 ? "s" : ""} not available (see "?").` : "All free quotas are fine.",
    "",
    ...readings.map(line),
    ...(calibrating || monday ? ["", "Vercel line items this month:", ...items.map((i) => `  ${i}`)] : []),
    "",
    "Sent by the quota watchdog (cloudflare/warm/watchdog.ts), daily at 09:07 IST; it mails only on WARN or ACT, and on Mondays.",
  ].join("\n");
  const send = worst !== "ok" || monday || calibrating;
  let mailed = false;
  if (send && env.SHEETS_WEBHOOK_URL && env.SHEETS_SECRET) {
    const subject = worst === "act" ? "Portfolio: a free quota is nearly used up" : worst === "warn" ? "Portfolio: a free quota is past 60% pace" : "Portfolio: weekly quota summary";
    const res = await fetch(env.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.SHEETS_SECRET, mail: { subject, body } }),
    });
    mailed = res.ok && ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
  }
  return { readings, mailed, body };
}
