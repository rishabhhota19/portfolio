import { cookies } from "next/headers";
import { z } from "zod";
import { COOKIE, adminConfigured, cookieOptions, newSession, passwordMatches } from "@/lib/server/admin";
import { isBot } from "@/lib/server/bot";
import { ipHash } from "@/lib/server/request";
import { allow } from "@/lib/server/store";
import { json } from "@/lib/server/validate";

const body = z.object({ password: z.string().min(1).max(200) });

/** Signs the owner in to /admin. BotID + 5 tries per 15 minutes per network. (No overall limit: anyone could use
 * one to lock the owner out. A 24-character password behind BotID and a per-network limit can't be guessed.) */
export async function POST(req: Request) {
  if (await isBot()) return json({ ok: false, error: "forbidden" }, 403);
  if (!adminConfigured()) return json({ ok: false, error: "not_configured" }, 503);
  if (!(await allow(`admin:login:${ipHash(req)}`, 5, 900))) {
    return json({ ok: false, error: "rate_limited", message: "Too many tries. Wait 15 minutes." }, 429);
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !passwordMatches(parsed.data.password)) {
    return json({ ok: false, error: "wrong_password", message: "That password isn't right." }, 401);
  }
  const session = newSession();
  (await cookies()).set(COOKIE, session.value, { ...cookieOptions, maxAge: session.maxAge });
  return json({ ok: true });
}
