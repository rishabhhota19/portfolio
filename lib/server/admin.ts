import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// The private /admin dashboard: one owner, one password (ADMIN_PASSWORD, in Vercel's env), and a signed,
// HttpOnly session cookie — nothing is stored server-side. ADMIN_SESSION_SECRET signs the cookie; changing it
// signs every browser out. The login route adds BotID and rate limits on top.

export const COOKIE = "__Host-admin"; // __Host-: HTTPS only, this exact site, path "/"
const WEEK = 7 * 86_400;

const secret = () => process.env.ADMIN_SESSION_SECRET ?? "";
const mac = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");
const digest = (s: string) => createHash("sha256").update(s).digest();
const sameText = (a: string, b: string) => timingSafeEqual(digest(a), digest(b)); // constant time, any lengths

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD) && secret().length >= 32;

export const passwordMatches = (password: string) => adminConfigured() && sameText(password, process.env.ADMIN_PASSWORD ?? "");

/** "<expiry>.<signature>" — the browser can read when it expires but can't forge or extend it. */
export function newSession() {
  const expires = String(Math.floor(Date.now() / 1000) + WEEK);
  return { value: `${expires}.${mac(expires)}`, maxAge: WEEK };
}

export function validSession(value: string | undefined) {
  if (!value || !adminConfigured()) return false;
  const [expires, signature = ""] = value.split(".");
  return Number(expires) > Date.now() / 1000 && sameText(signature, mac(expires));
}

export const cookieOptions = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
