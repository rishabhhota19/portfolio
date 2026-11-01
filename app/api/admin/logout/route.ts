import { cookies } from "next/headers";
import { COOKIE, cookieOptions } from "@/lib/server/admin";
import { json } from "@/lib/server/validate";

export async function POST() {
  (await cookies()).set(COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return json({ ok: true });
}
