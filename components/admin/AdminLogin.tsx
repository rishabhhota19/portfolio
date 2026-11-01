"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function AdminLogin() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return router.refresh(); // the server now sees the session cookie and renders the dashboard
    const data = (await res?.json().catch(() => ({}))) as { message?: string } | undefined;
    setError(data?.message ?? "Couldn't sign in. Try again.");
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-16 max-w-sm space-y-4">
      <p className="label">Private</p>
      <h1 className="font-serif text-4xl">Dashboard</h1>
      <label className="block">
        <span className="label">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-sm border border-rule bg-surface px-3 py-2.5 outline-none focus:border-accent"
        />
      </label>
      {error ? <p role="alert" className="text-sm text-accent">{error}</p> : null}
      <button type="submit" disabled={busy || !password} className="w-full rounded-sm bg-ink py-2.5 text-paper disabled:opacity-50">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
