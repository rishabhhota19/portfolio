"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import site from "@/content/site.json";
import { track } from "@/lib/analytics";

export type BookingChat = {
  sessionId?: string;
  conversationId: string;
  token: string | null;
  messages: { role: "user" | "assistant"; content: string }[];
};

type Props = {
  from: string; // where it was opened, for Umami: header, hero, footer, chat…
  topic?: string; // filled in already when Dumbledore opens it from a conversation
  chat?: () => BookingChat | undefined; // the conversation, read at the moment they book
  onBooked?: (when: string, name: string) => void;
  onCancel?: () => void;
  compact?: boolean; // inside the chat: narrower spacing, no big title
};

type Days = { day: string; slots: string[] }[];
type Load = { state: "loading" } | { state: "ready"; days: Days; minutes: number } | { state: "closed" };

const mailto = `mailto:${site.email}?subject=${encodeURIComponent("Call with Rishabh")}`;
const field =
  "w-full rounded-xl border border-rule bg-paper px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted/70 focus:border-accent";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const inIndia = () => ["Asia/Kolkata", "Asia/Calcutta"].includes(localZone());
const fmt = (iso: string, o: Intl.DateTimeFormatOptions, timeZone?: string) =>
  new Intl.DateTimeFormat("en-IN", { ...o, timeZone }).format(new Date(iso));
const time = (iso: string, timeZone?: string) => fmt(iso, { hour: "numeric", minute: "2-digit" }, timeZone).replace(" ", " ");
const dayKey = (iso: string) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * "Book a call": open times from his Google Calendar, then name, email and what it's about. That sends him a request
 * (the slot is held); when he approves, Google emails the visitor the invite and Meet link. Times show in the
 * visitor's own time zone.
 */
export function BookingCard({ from, topic = "", chat, onBooked, onCancel, compact = false }: Props) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState<{ when: string; email: string } | null>(null);

  const fetchSlots = () =>
    fetch("/api/book", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { days: Days; rules: { minutes: number } }) => setLoad({ state: "ready", days: d.days, minutes: d.rules.minutes }))
      .catch(() => setLoad({ state: "closed" }));

  useEffect(() => {
    fetchSlots();
    track("book_open", { from });
  }, [from]);

  // Regrouped by the visitor's own calendar day: 10 am in India can be the evening before in New York.
  const days = useMemo(() => {
    if (load.state !== "ready") return [];
    const map = new Map<string, string[]>();
    for (const s of load.days.flatMap((d) => d.slots)) map.set(dayKey(s), [...(map.get(dayKey(s)) ?? []), s]);
    return [...map.values()];
  }, [load]);
  const chosen = days.find((d) => dayKey(d[0]) === day) ?? days[0];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!slot) return setProblem("Pick a time first.");
    const data = new FormData(e.currentTarget);
    const body = {
      start: slot,
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      company: String(data.get("company") ?? "").trim(),
      topic: String(data.get("topic") ?? "").trim(),
      page: window.location.pathname,
      from,
      chat: chat?.(),
    };
    setSending(true);
    setProblem("");
    try {
      const res = await fetch("/api/book", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const said = (await res.json().catch(() => ({}))) as { ok?: boolean; when?: string; meet?: string; message?: string; error?: string };
      if (!res.ok || !said.ok) {
        setProblem(said.message ?? "That didn't go through. Please email him instead.");
        if (said.error === "taken") {
          setSlot("");
          fetchSlots();
        }
        return;
      }
      track("book_done", { from });
      const when = `${fmt(slot, { weekday: "long", day: "numeric", month: "long" })}, ${time(slot)}`;
      setDone({ when, email: body.email });
      onBooked?.(when, body.name);
    } catch {
      setProblem("That didn't go through. Please email him instead.");
    } finally {
      setSending(false);
    }
  }

  const shell = `rounded-3xl border border-rule bg-surface ${compact ? "p-4" : "p-5 sm:p-7"}`;

  if (done) {
    return (
      <div className={shell} role="status">
        <p className="label !text-accent">Request sent</p>
        <p className={`mt-2 font-serif leading-tight ${compact ? "text-xl" : "text-3xl"}`}>Rishabh will confirm your time.</p>
        <p className="mt-3 text-sm">
          <span className="font-medium">{done.when}</span> · {load.state === "ready" ? load.minutes : 30} min · Google Meet
        </p>
        <p className="mt-1.5 text-sm text-muted">
          The time is held for you. Once he approves, Google sends the invite and Meet link to {done.email}, usually
          within a day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={shell} aria-label="Book a call with Rishabh">
      {compact ? (
        <p className="font-serif text-xl leading-tight">Book a call with Rishabh</p>
      ) : (
        <>
          <p className="label">30 minutes · Google Meet</p>
          <p className="mt-2 font-serif text-3xl leading-tight sm:text-4xl">Book a call with Rishabh</p>
        </>
      )}
      <p className="mt-1.5 text-xs text-muted">
        Times in your time zone{inIndia() ? "" : ` (${localZone().replace(/_/g, " ")})`}. He&apos;s in India: weekdays, 10 am to 9 pm IST.
      </p>

      {load.state === "loading" ? (
        <div className="mt-5 grid grid-cols-3 gap-2" aria-label="Loading open times">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="h-10 animate-pulse rounded-xl bg-rule/50" />
          ))}
        </div>
      ) : load.state === "closed" || !days.length ? (
        <div className="mt-5 rounded-2xl border border-dashed border-rule p-4 text-sm">
          {load.state === "closed" ? "Booking isn't open right now." : "No open times in the next two weeks."}{" "}
          <a className="text-accent underline" href={mailto}>
            Email him
          </a>{" "}
          and he&apos;ll find a time.
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(3.4rem,1fr))] gap-1.5" role="tablist" aria-label="Day">
            {days.map((d) => {
              const on = d === chosen;
              return (
                <button
                  key={d[0]}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    setDay(dayKey(d[0]));
                    setSlot("");
                  }}
                  className={`flex flex-col items-center rounded-2xl border px-1 py-2 transition-colors duration-300 ${
                    on ? "border-accent bg-accent text-accent-ink" : "border-rule hover:border-accent"
                  }`}
                >
                  <span className="text-[0.65rem] uppercase tracking-wider opacity-80">{fmt(d[0], { weekday: "short" })}</span>
                  <span className="font-serif text-xl leading-none">{fmt(d[0], { day: "numeric" })}</span>
                  <span className="text-[0.65rem] opacity-80">{fmt(d[0], { month: "short" })}</span>
                </button>
              );
            })}
          </div>
          <div className={`mt-3 grid gap-1.5 ${compact ? "grid-cols-3" : "grid-cols-3 sm:grid-cols-4"}`} role="radiogroup" aria-label="Time">
            {chosen.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={slot === s}
                onClick={() => setSlot(s)}
                className={`rounded-xl border px-2 py-2 text-sm transition-colors duration-300 ${
                  slot === s ? "border-accent bg-accent/15 text-accent" : "border-rule hover:border-accent"
                }`}
              >
                {time(s)}
                {inIndia() ? null : <span className="block text-[0.62rem] text-muted">{time(s, "Asia/Kolkata")} IST</span>}
              </button>
            ))}
          </div>

          {slot ? (
            <div className="mt-5 space-y-2.5">
              <div className="grid gap-2 sm:grid-cols-2">
                <input name="name" required maxLength={80} placeholder="Your name" className={field} autoComplete="name" />
                <input
                  name="email"
                  required
                  type="email"
                  maxLength={120}
                  pattern="[^@\s]+@[^@\s]+\.[^@\s]+"
                  title="An email address like name@company.com"
                  placeholder="Email for the invite"
                  className={field}
                  autoComplete="email"
                />
              </div>
              <input name="company" maxLength={80} placeholder="Company (optional)" className={field} autoComplete="organization" />
              <textarea
                name="topic"
                required
                minLength={3}
                maxLength={600}
                rows={compact ? 2 : 3}
                defaultValue={topic}
                placeholder="What would you like to talk about? A role, a project, an idea…"
                className={field}
              />
            </div>
          ) : null}
        </>
      )}

      {problem ? <p className="mt-3 text-xs text-accent" role="alert">{problem}</p> : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {onCancel ? (
          <button type="button" onClick={onCancel} className="label px-3 py-2 hover:text-ink">
            Cancel
          </button>
        ) : null}
        {slot ? (
          <button type="submit" disabled={sending} className="btn-primary !text-sm disabled:opacity-60">
            {sending ? "Sending…" : `Request ${fmt(slot, { weekday: "short", day: "numeric", month: "short" })}, ${time(slot)}`}
          </button>
        ) : null}
      </div>
    </form>
  );
}
