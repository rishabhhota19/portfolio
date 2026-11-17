"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type View = { name: string; company: string; email: string; topic: string; when: string };
type State =
  | { s: "loading" }
  | { s: "ready"; request: View }
  | { s: "working"; request: View }
  | { s: "approved"; request: View; meet: string }
  | { s: "declined"; request: View; mailed: boolean }
  | { s: "error"; message: string };

export function Decide() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const t = params.get("t") ?? "";
  const linked = params.get("a") === "decline" ? "decline" : "approve"; // the link he clicked: that button leads
  const [state, setState] = useState<State>({ s: "loading" });

  const call = async (a: "look" | "approve" | "decline") => {
    const res = await fetch("/api/book/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, a, t }) });
    return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; request?: View; meet?: string; mailed?: boolean; message?: string };
  };

  useEffect(() => {
    call("look").then((r) => setState(r.ok && r.request ? { s: "ready", request: r.request } : { s: "error", message: r.message ?? "This link isn't valid." }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (a: "approve" | "decline") => {
    if (state.s !== "ready") return;
    const request = state.request;
    setState({ s: "working", request });
    const r = await call(a);
    if (!r.ok) return setState({ s: "error", message: r.message ?? "That didn't work. Try again." });
    setState(a === "approve" ? { s: "approved", request, meet: r.meet ?? "" } : { s: "declined", request, mailed: !!r.mailed });
  };

  if (state.s === "loading") return <p className="text-muted">Loading the request…</p>;
  if (state.s === "error")
    return (
      <div className="panel p-7">
        <p className="label">Call request</p>
        <p className="mt-3 font-serif text-3xl leading-tight">{state.message}</p>
      </div>
    );

  const r = state.request;
  const first = r.name.split(" ")[0] || r.name;
  return (
    <div className="panel p-7 sm:p-9">
      <p className="label">Call request</p>
      <h1 className="mt-3 font-serif text-4xl leading-tight">
        {r.name}
        {r.company ? <span className="text-muted"> · {r.company}</span> : null}
      </h1>
      <p className="mt-3 text-lg">{r.when} · 30 min · Google Meet</p>
      <p className="mt-1 text-sm text-muted">{r.email}</p>
      <p className="mt-6 label">What they want to talk about</p>
      <p className="mt-2 whitespace-pre-line">{r.topic}</p>

      {state.s === "approved" ? (
        <div className="mt-8 rounded-2xl border border-accent/40 bg-accent/10 p-5" role="status">
          <p className="font-medium">Approved. Google has sent {first} the invite.</p>
          {state.meet ? (
            <a href={state.meet} target="_blank" rel="noreferrer" className="btn-ghost mt-3 w-fit !text-sm">
              Meet link ↗
            </a>
          ) : null}
        </div>
      ) : state.s === "declined" ? (
        <div className="mt-8 rounded-2xl border border-rule p-5" role="status">
          <p className="font-medium">Declined. The slot is free again.</p>
          <p className="mt-1 text-sm text-muted">
            {state.mailed ? `${first} got a short note from your Gmail asking to pick another time.` : `Couldn't email ${first}; you may want to write to ${r.email} yourself.`}
          </p>
        </div>
      ) : (
        <div className={`mt-8 flex flex-wrap gap-3 ${linked === "decline" ? "flex-row-reverse justify-end" : ""}`}>
          <button type="button" onClick={() => decide("approve")} disabled={state.s === "working"} className="btn-primary disabled:opacity-60">
            {state.s === "working" ? "Working…" : "Approve and send invite"}
          </button>
          <button type="button" onClick={() => decide("decline")} disabled={state.s === "working"} className="btn-ghost disabled:opacity-60">
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
