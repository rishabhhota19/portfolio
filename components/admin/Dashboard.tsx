"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

// The private realtime dashboard. Polls /api/admin/data every 5 s while this tab is visible (one Redis command per
// poll); the model web loads only while its panel is open. Charts follow one rule set: thin single-hue bars with the
// value at the tip, 7-day sparklines in grey with today in the accent, status as icon + word, never colour alone.

type Point = { day: string; value: number };
type Row = [string, number];
type Ev = Record<string, unknown> & { t: number; type: string };
type ModelHealth = { model: string; available: boolean; paused: boolean; requests_today: string; tokens_today: string };
type Engine = { model: string; ready: boolean; paused: boolean; probe?: string };
type Data = {
  now: number;
  live: Record<string, string>[];
  tiles: Record<"visits" | "pv" | "q" | "leads" | "tokens", Point[]>;
  agent: { questions: number; avgMs: number; tokensIn: number; tokensOut: number; chats: number; avgActive: number; returning: number; visits: number };
  week: Record<"pages" | "sources" | "countries" | "networks" | "devices" | "models" | "levels" | "outcomes", Row[]>;
  feed: Ev[];
  leads: Ev[];
  health: { models?: Record<string, ModelHealth>; embeddings?: Record<string, Engine> } | null;
};

const POLL_MS = 10_000;
const IDLE_MS = 5 * 60_000; // left open and untouched: stop polling (each poll is one Upstash command)
const MODELS_MS = 120_000;
const fmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const n = (v: unknown) => fmt.format(Number(v) || 0);
const s = (v: unknown) => String(v ?? "");
const since = (t: number, now: number) => {
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86_400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86_400)}d`;
};
const count = (v: number, word: string) => `${n(v)} ${word}${v === 1 ? "" : "s"}`; // "1 visit", "3 visits"
const clock = (sec: number) => `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const shortModel = (m: string) => m.split("/").pop() ?? m;
const OUTCOME: Record<string, string> = {
  question: "answered", refused: "refused", cached: "from cache", bank: "answer bank", navigate: "navigated",
  greeting: "greeting", contact: "contact", identity: "about Dumbledore", thanks: "thanks",
  talk: "small talk", care: "care reply", not_on_site: "site doesn't say",
};

export function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [health, setHealth] = useState<Data["health"]>(null);
  const [updated, setUpdated] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const [idle, setIdle] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

  const load = useCallback(
    async (models = false) => {
      try {
        const res = await fetch(`/api/admin/data${models ? "?models=1" : ""}`, { cache: "no-store" });
        if (res.status === 401) return router.refresh(); // signed out (or the session expired): show the sign-in
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as Data;
        if (models) setHealth(next.health);
        setData(next);
        setUpdated(Date.now());
        setFailed(false);
      } catch {
        setFailed(true);
      }
    },
    [router],
  );

  useEffect(() => {
    let timer = 0;
    let lastInput = Date.now();
    let paused = false;
    const tick = () => {
      paused = Date.now() - lastInput > IDLE_MS;
      setIdle(paused);
      if (document.visibilityState === "visible" && !paused) void load();
      timer = window.setTimeout(tick, POLL_MS);
    };
    const onInput = () => {
      lastInput = Date.now();
      if (!paused) return;
      paused = false;
      setIdle(false);
      void load();
    };
    timer = window.setTimeout(tick, 0);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => document.visibilityState === "visible" && !paused && void load();
    const inputs = ["pointermove", "keydown", "scroll", "touchstart"] as const;
    for (const name of inputs) window.addEventListener(name, onInput, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(clockTimer);
      for (const name of inputs) window.removeEventListener(name, onInput);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!modelsOpen) return;
    const first = window.setTimeout(() => void load(true), 0);
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(true), MODELS_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [modelsOpen, load]);

  const signOut = async () => {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    router.refresh();
  };

  if (!data) return <p className="label">{failed ? "Couldn't load the dashboard — retrying…" : "Loading…"}</p>;
  const today = (series: Point[]) => series[series.length - 1]?.value ?? 0;
  const a = data.agent;

  return (
    <div className="space-y-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label flex items-center gap-2">
            <span className={`inline-block size-2 rounded-full ${failed || idle ? "bg-muted" : "pulse-dot bg-accent"}`} aria-hidden />
            {failed ? "Reconnecting" : idle ? "Paused (move the mouse to resume)" : "Live"} · updated {since(updated, now)} ago
          </p>
          <h1 className="mt-2 font-serif text-5xl">Dashboard</h1>
        </div>
        <button type="button" onClick={signOut} className="label rounded-full border border-rule px-3 py-1.5 hover:border-accent hover:text-accent">
          Sign out
        </button>
      </header>

      {/* Headline numbers: one hero (who's here now), then today's tiles with the week behind them */}
      <section aria-label="Today" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-sm border border-rule bg-surface p-4 lg:col-span-1">
          <p className="label">On the site now</p>
          <p className="mt-2 text-6xl font-semibold tabular-nums">{data.live.length}</p>
        </div>
        <Tile label="Visits today" series={data.tiles.visits} value={today(data.tiles.visits)} />
        <Tile label="Page views today" series={data.tiles.pv} value={today(data.tiles.pv)} />
        <Tile label="Questions today" series={data.tiles.q} value={today(data.tiles.q)} />
        <Tile label="Leads today" series={data.tiles.leads} value={today(data.tiles.leads)} />
        <Tile label="Tokens today" series={data.tiles.tokens} value={today(data.tiles.tokens)} />
      </section>

      <Section title="On the site now" note="Visible tabs that pinged in the last 90 seconds.">
        {data.live.length ? (
          <Table head={["Page", "Where", "Network", "Device", "Source", "On site"]}>
            {data.live.map((v) => (
              <tr key={v.sid} className="border-t border-rule">
                <td className="py-2 pr-4 font-mono text-xs">{v.page}</td>
                <td className="py-2 pr-4">{[v.city, v.country].filter(Boolean).join(", ") || "—"}</td>
                <td className="py-2 pr-4">{v.net || "—"}</td>
                <td className="py-2 pr-4">{v.device || "—"}</td>
                <td className="py-2 pr-4">{v.src || "—"}</td>
                <td className="py-2 tabular-nums">{clock(Math.round((now - Number(v.since)) / 1000))}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-muted">Nobody on the site right now.</p>
        )}
      </Section>

      <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr]">
        <Section title="Activity" note="Newest first. Questions show how they were handled, never what was asked.">
          <ol className="divide-y divide-rule">
            {data.feed.length ? data.feed.slice(0, 40).map((e, i) => <FeedItem key={`${e.t}-${i}`} e={e} now={now} />) : <li className="py-2 text-muted">No activity yet.</li>}
          </ol>
        </Section>
        <Section title="Leads" note="From “Share your details”. Also emailed to you and in the Sheet.">
          {data.leads.length ? (
            <ul className="divide-y divide-rule">
              {data.leads.map((l, i) => (
                <li key={`${l.t}-${i}`} className="py-3">
                  <p className="font-medium">
                    {s(l.name)} <span className="font-normal text-muted">· {s(l.company) || "—"}</span>
                  </p>
                  <p className="text-sm text-muted">
                    {s(l.role) || "Role not given"} ·{" "}
                    <a className="text-accent underline underline-offset-2" href={`mailto:${s(l.email)}`}>
                      {s(l.email)}
                    </a>{" "}
                    · {since(l.t, now)} ago
                  </p>
                  {l.note ? <p className="mt-1 text-sm">{s(l.note)}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No leads yet.</p>
          )}
        </Section>
      </div>

      <Section title="Last 7 days" note={`${count(a.visits, "visit")} · ${n(a.returning)} returning · average ${clock(a.avgActive)} on the site · ${count(a.chats, "chat")}`}>
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <BarList title="Top pages" rows={data.week.pages} mono />
          <BarList title="Sources" rows={data.week.sources} />
          <BarList title="Countries" rows={data.week.countries} />
          <BarList title="Networks (company or ISP)" rows={data.week.networks} />
          <BarList title="Devices" rows={data.week.devices} />
        </div>
      </Section>

      <Section title="Dumbledore, the agent" note={`${count(a.questions, "question")} in 7 days · ${a.avgMs ? `${(a.avgMs / 1000).toFixed(1)} s average answer` : "no answers yet"} · ${n(a.tokensIn)} tokens in, ${n(a.tokensOut)} out`}>
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          <BarList title="How questions were handled" rows={data.week.outcomes.map(([k, v]) => [OUTCOME[k] ?? k, v])} />
          <BarList title="Difficulty level" rows={data.week.levels} />
          <BarList title="Models that answered" rows={data.week.models.map(([k, v]) => [shortModel(k), v])} mono />
        </div>
        <details className="mt-8 rounded-sm border border-rule bg-surface p-4" onToggle={(e) => setModelsOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer font-medium">Model web — today&apos;s budgets and the embedding lineup</summary>
          {health ? <ModelWeb health={health} /> : <p className="label mt-3">Loading…</p>}
        </details>
      </Section>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="font-serif text-2xl">{title}</h2>
      {note ? <p className="mt-1 text-sm text-muted">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="label pb-2 pr-4 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Stat tile: today's value, and the week as a grey sparkline with today's point in the accent. */
function Tile({ label, value, series }: { label: string; value: number; series: Point[] }) {
  const w = 120;
  const h = 32;
  const max = Math.max(1, ...series.map((p) => p.value));
  const pts = series.map((p, i) => [4 + (i * (w - 8)) / Math.max(1, series.length - 1), h - 4 - (p.value / max) * (h - 8)] as const);
  const last = pts[pts.length - 1];
  return (
    <div className="rounded-sm border border-rule bg-surface p-4">
      <p className="label">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{n(value)}</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-8 w-full" role="img" aria-label={`Last 7 days: ${series.map((p) => `${weekday(p.day)} ${p.value}`).join(", ")}`}>
        <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
        {pts.map(([x, y], i) => (
          <circle key={series[i].day} cx={x} cy={y} r="10" fill="transparent">
            <title>{`${weekday(series[i].day)}: ${series[i].value.toLocaleString("en-IN")}`}</title>
          </circle>
        ))}
        {last ? <circle cx={last[0]} cy={last[1]} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" /> : null}
      </svg>
    </div>
  );
}

/** Horizontal bars in one hue, value at the tip; the label carries identity, so no legend is needed. */
function BarList({ title, rows, mono }: { title: string; rows: Row[]; mono?: boolean }) {
  const max = Math.max(1, ...rows.map(([, v]) => v));
  return (
    <div>
      <h3 className="label mb-3">{title}</h3>
      {rows.length ? (
        <ul className="space-y-2.5">
          {rows.map(([label, value]) => (
            <li key={label} title={`${label}: ${value.toLocaleString("en-IN")}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`}>{label || "—"}</span>
                <span className="tabular-nums text-muted">{value.toLocaleString("en-IN")}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-r bg-accent" style={{ width: `${Math.max(2, (value / max) * 100)}%` }} aria-hidden />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing yet.</p>
      )}
    </div>
  );
}

function FeedItem({ e, now }: { e: Ev; now: number }) {
  let kind = "";
  let text = "";
  if (e.type === "visit") {
    kind = "Visit";
    text = [s(e.entry), s(e.src) && `from ${s(e.src)}`, [s(e.city), s(e.country)].filter(Boolean).join(", "), s(e.net), e.returning ? "returning" : ""].filter(Boolean).join(" · ");
  } else if (e.type === "turn") {
    kind = "Question";
    const outcome = OUTCOME[s(e.intent)] ?? s(e.intent);
    const model = s(e.model);
    text = [s(e.page), outcome + (e.intent === "refused" && e.why ? ` (${s(e.why).split(":")[0]})` : ""), s(e.level), model && !["router", "cache", "bank"].includes(model) ? shortModel(model) : "", Number(e.tin) + Number(e.tout) ? `${n(Number(e.tin) + Number(e.tout))} tokens` : "", e.ms ? `${(Number(e.ms) / 1000).toFixed(1)} s` : ""].filter(Boolean).join(" · ");
  } else if (e.type === "chat") {
    kind = "Chat ended";
    text = [`${s(e.messages)} messages`, s(e.intent), s(e.summary)].filter(Boolean).join(" · ");
  } else if (e.type === "lead") {
    kind = "Lead";
    text = [s(e.name), s(e.company), s(e.role)].filter(Boolean).join(" · ");
  } else {
    kind = e.type;
  }
  return (
    <li className="flex gap-3 py-2 text-sm">
      <span className={`label w-20 shrink-0 pt-0.5 ${e.type === "lead" ? "!text-accent" : ""}`}>{kind}</span>
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <span className="label shrink-0 pt-0.5 tabular-nums">{since(e.t, now)}</span>
    </li>
  );
}

function ModelWeb({ health }: { health: NonNullable<Data["health"]> }) {
  const status = (m: { available?: boolean; ready?: boolean; paused: boolean }) =>
    m.available === false || m.ready === false ? "— not set up" : m.paused ? "⏸ resting" : "✓ ready";
  return (
    <div className="mt-4 space-y-6">
      <Table head={["Model", "Status", "Requests today", "Tokens today"]}>
        {Object.entries(health.models ?? {}).map(([key, m]) => (
          <tr key={key} className="border-t border-rule">
            <td className="py-2 pr-4 font-mono text-xs">{shortModel(m.model)}</td>
            <td className="py-2 pr-4">{status(m)}</td>
            <td className="py-2 pr-4 tabular-nums">{m.requests_today}</td>
            <td className="py-2 tabular-nums">{m.tokens_today}</td>
          </tr>
        ))}
      </Table>
      {health.embeddings ? (
        <Table head={["Embedding engine", "Model", "Status", "Check"]}>
          {Object.entries(health.embeddings).map(([name, e]) => (
            <tr key={name} className="border-t border-rule">
              <td className="py-2 pr-4">{name}</td>
              <td className="py-2 pr-4 font-mono text-xs">{shortModel(e.model)}</td>
              <td className="py-2 pr-4">{status(e)}</td>
              <td className="py-2">{e.probe ?? "—"}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </div>
  );
}
