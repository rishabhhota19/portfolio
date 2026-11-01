import { cookies } from "next/headers";
import { COOKIE, validSession } from "@/lib/server/admin";
import { agentHealth } from "@/lib/server/agent";
import { snapshot } from "@/lib/server/events";
import { json } from "@/lib/server/validate";

type Counts = Record<string, number>;

/** Top entries of one kind of counter ("page:/projects" → ["/projects", 12]), across the given days. */
function top(days: Counts[], prefix: string, n = 8): [string, number][] {
  const sum = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries(d)) if (k.startsWith(prefix)) sum.set(k.slice(prefix.length), (sum.get(k.slice(prefix.length)) ?? 0) + v);
  return [...sum].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * Everything the dashboard shows. Owner only (signed cookie). The live part is one Redis command; the model web
 * (`?models=1`) is ~70, so the dashboard asks for it only while that panel is open.
 */
export async function GET(req: Request) {
  if (!validSession((await cookies()).get(COOKIE)?.value)) return json({ ok: false, error: "signed_out" }, 401);
  const wantModels = new URL(req.url).searchParams.get("models") === "1";
  const [snap, health] = await Promise.all([snapshot(), wantModels ? agentHealth(req) : null]).catch((err: unknown) => {
    console.error("[admin] data read failed:", err); // Upstash down or over its free cap: the dashboard shows "Reconnecting"
    return [null, null] as const;
  });
  if (!snap) return json({ ok: false, error: "store_unavailable" }, 503);

  const stats = snap.days.map((d) => d.stats);
  const series = (field: string) => snap.days.map((d) => ({ day: d.day, value: d.stats[field] ?? 0 }));
  const today = stats[stats.length - 1] ?? {};
  const week = (field: string) => stats.reduce((sum, s) => sum + (s[field] ?? 0), 0);

  return json({
    ok: true,
    now: snap.now,
    live: snap.live,
    tiles: {
      visits: series("visits"),
      pv: series("pv"),
      q: series("q"),
      leads: series("leads"),
      tokens: snap.days.map((d) => ({ day: d.day, value: (d.stats.tin ?? 0) + (d.stats.tout ?? 0) })),
    },
    agent: {
      questions: week("q"),
      avgMs: week("q") ? Math.round(week("ms") / week("q")) : 0,
      tokensIn: week("tin"),
      tokensOut: week("tout"),
      chats: week("chats"),
      avgActive: week("visits") ? Math.round(week("active_s") / week("visits")) : 0,
      returning: week("returning"),
      visits: week("visits"),
      todayQuestions: today.q ?? 0,
    },
    week: {
      pages: top(stats, "page:"),
      sources: top(stats, "src:"),
      countries: top(stats, "country:"),
      networks: top(stats, "net:"),
      devices: top(stats, "device:"),
      models: top(stats, "model:"),
      levels: top(stats, "level:"),
      outcomes: top(stats, "intent:"),
    },
    feed: snap.events,
    leads: snap.leads,
    health,
  });
}
