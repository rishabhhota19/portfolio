import type { Metadata } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { AdminLogin } from "@/components/admin/AdminLogin";
import { Dashboard } from "@/components/admin/Dashboard";
import { COOKIE, adminConfigured, validSession } from "@/lib/server/admin";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

// Private: not in the nav, the sitemap or the agent's site map. The shell is static; who you are (the cookie)
// is read inside Suspense, as Cache Components require.
export default function AdminPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <Suspense fallback={<p className="label">Checking access…</p>}>
        <Gate />
      </Suspense>
    </div>
  );
}

async function Gate() {
  await connection(); // per request, never prerendered (the session check reads the clock and the cookie)
  if (!adminConfigured()) {
    return <p className="text-muted">The dashboard isn&apos;t set up yet: add ADMIN_PASSWORD and ADMIN_SESSION_SECRET.</p>;
  }
  const signedIn = validSession((await cookies()).get(COOKIE)?.value);
  return signedIn ? <Dashboard /> : <AdminLogin />;
}
