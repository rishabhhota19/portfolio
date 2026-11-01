"use client";

import { useState, type FormEvent } from "react";

export type LeadDetails = {
  name: string;
  email: string;
  company: string;
  role: string;
  phone: string;
  note: string;
};

type Props = {
  onSubmit: (lead: LeadDetails) => Promise<boolean>;
  onCancel: () => void;
};

const field =
  "w-full rounded-sm border border-rule bg-paper px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted/70 focus:border-accent";

export function LeadForm({ onSubmit, onCancel }: Props) {
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");

  async function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const lead: LeadDetails = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      company: String(data.get("company") ?? "").trim(),
      role: String(data.get("role") ?? "").trim(),
      phone: String(data.get("phone") ?? "").trim(),
      note: String(data.get("note") ?? "").trim(),
    };
    setState("sending");
    const ok = await onSubmit(lead);
    if (!ok) setState("error");
  }

  return (
    <form onSubmit={handle} className="space-y-2.5 rounded-sm border border-rule bg-surface p-4">
      <p className="font-serif text-xl leading-tight">Share your details</p>
      <p className="text-xs text-muted">Rishabh gets an email with your note and a short summary of this chat.</p>
      <div className="grid grid-cols-2 gap-2">
        <input name="name" required maxLength={80} placeholder="Your name" className={field} autoComplete="name" />
        <input name="email" required type="email" maxLength={120} placeholder="Work email" className={field} autoComplete="email" />
        <input name="company" maxLength={80} placeholder="Company" className={field} autoComplete="organization" />
        <input name="role" maxLength={80} placeholder="Role you're hiring for" className={field} />
        <input
          name="phone"
          type="tel"
          maxLength={30}
          placeholder="Phone (optional)"
          className={`${field} col-span-2`}
          autoComplete="tel"
        />
      </div>
      <textarea name="note" maxLength={600} rows={2} placeholder="Anything he should know? (optional)" className={field} />
      {state === "error" ? (
        <p className="text-xs text-accent">Couldn&apos;t send that — please email rishabhhota19@gmail.com directly.</p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="label px-3 py-2 hover:text-ink">
          Cancel
        </button>
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-full bg-ink px-4 py-2 text-sm text-paper disabled:opacity-60"
        >
          {state === "sending" ? "Sending…" : "Send to Rishabh"}
        </button>
      </div>
    </form>
  );
}
