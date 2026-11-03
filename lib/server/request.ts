import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deviceType as deviceOf } from "@/lib/traffic";

const devSecret = randomBytes(32).toString("hex");

function secret(name: "CHAT_TOKEN_SECRET" | "IP_HASH_SALT") {
  const value = process.env[name];
  if (!value && process.env.VERCEL_ENV === "production") {
    console.warn(`[request] ${name} is not set — using a per-instance random value.`);
  }
  return value || devSecret;
}

export function clientIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Salted, truncated hash so raw IPs are never stored. */
export function ipHash(req: Request) {
  return createHash("sha256").update(`${secret("IP_HASH_SALT")}:${clientIp(req)}`).digest("hex").slice(0, 16);
}

/**
 * Token issued by /api/chat (which sits behind bot protection) for a conversation.
 * /api/chat/end and /api/lead require it before spending an LLM call on a summary.
 */
export function issueChatToken(conversationId: string) {
  return createHmac("sha256", secret("CHAT_TOKEN_SECRET")).update(conversationId).digest("base64url");
}

export function verifyChatToken(conversationId: string, token: string | null | undefined) {
  if (!token) return false;
  const expected = Buffer.from(issueChatToken(conversationId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Location (from Vercel's edge, city-level) and device (from the user agent) — nothing the visitor typed. */
export function requestMeta(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  const header = (name: string) => decodeURIComponent(req.headers.get(`x-vercel-ip-${name}`) ?? "");
  const deviceType = deviceOf(ua);
  const browser =
    /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os =
    /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Other";
  const [lat, lon] = [header("latitude"), header("longitude")];
  return {
    country: header("country"),
    region: header("country-region"),
    city: header("city"),
    location: lat && lon ? `${lat}, ${lon}` : "",
    timezone: header("timezone"),
    deviceType,
    os,
    browser,
    device: `${deviceType} · ${browser}`,
  };
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
