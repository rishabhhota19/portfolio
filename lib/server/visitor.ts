import "server-only";
import { clientIp, ipHash, requestMeta } from "@/lib/server/request";
import { store } from "@/lib/server/store";

// What we can tell about a visitor without asking: where they are (city-level), their device, their network
// (a company or an ISP), whether they've been here before and where they came from.
// Name, email and phone only ever come from the "Share your details" form.

/** Location, device and IP columns for the Sessions sheet. The raw IP is blanked there after 90 days. */
export function whereAndDevice(req: Request) {
  const m = requestMeta(req);
  return {
    ip: clientIp(req),
    ipHash: ipHash(req),
    city: m.city,
    region: m.region,
    country: m.country,
    location: m.location,
    timezone: m.timezone,
    device: m.deviceType,
    os: m.os,
    browser: m.browser,
  };
}

/** The organisation that owns the visitor's IP: a company network ("Microsoft Corporation") or an ISP. */
export async function networkOf(req: Request) {
  const ip = clientIp(req);
  if (ip === "unknown" || /^(127\.|10\.|192\.168\.|::1|::ffff:127\.)/.test(ip)) return "";
  const key = `net:${ipHash(req)}`; // cached a day per visitor, so IPinfo's free tier is plenty
  const cached = await store.get(key);
  if (cached !== null) return cached;
  try {
    const token = process.env.IPINFO_TOKEN; // optional: without it IPinfo allows ~1,000 lookups a day
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${token}` : ""}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return "";
    const { org = "" } = (await res.json()) as { org?: string };
    const name = org.replace(/^AS\d+\s+/, ""); // "AS8075 Microsoft Corporation" → "Microsoft Corporation"
    await store.set(key, name, 86_400);
    return name;
  } catch {
    return "";
  }
}

/** "Yes" if the same network address was seen on an earlier visit in the last 90 days. */
export async function returning(req: Request, sessionId: string) {
  const key = `seen:${ipHash(req)}`;
  const firstVisit = await store.get(key);
  if (firstVisit === null) {
    await store.set(key, sessionId, 90 * 86_400);
    return "No";
  }
  return firstVisit === sessionId ? "No" : "Yes";
}

const SOURCES: [RegExp, string][] = [
  [/linkedin|lnkd\.in/, "LinkedIn"],
  [/google\./, "Google"],
  [/bing\.|duckduckgo|yahoo\./, "Search (other)"],
  [/chatgpt|openai|perplexity|claude\.ai|gemini\.google/, "AI assistant"],
  [/github/, "GitHub"],
  [/naukri|indeed|wellfound|instahyre/, "Job board"],
  [/^t\.co$|twitter|x\.com/, "X / Twitter"],
  [/mail\.|outlook/, "Email"],
];

/** Where the visit came from: a campaign tag if the link had one, else the referring site, else "Direct". */
export function sourceOf(referrer: string, utm: string) {
  if (utm) return `Campaign: ${utm.split(" / ")[0]}`;
  if (!referrer) return "Direct";
  return SOURCES.find(([pattern]) => pattern.test(referrer))?.[1] ?? referrer;
}

/** ["chat_open", "chat_question", "chat_question"] → "chat_open, chat_question ×2" */
export function countActions(actions: string[]) {
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts].map(([a, n]) => (n > 1 ? `${a} ×${n}` : a)).join(", ");
}
