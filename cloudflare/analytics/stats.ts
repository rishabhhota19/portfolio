import { DurableObject } from "cloudflare:workers";

// The admin dashboard's data, in ONE Durable Object (SQLite, free plan). It does what the Upstash Lua scripts in
// lib/server/events.ts did, with the same rules:
//
//   days     one row per UTC day: its counters as JSON (40 days)   → tiles, sparklines, top pages / sources / models
//   feed     the activity feed, newest last, capped at 2,000      → the live activity feed
//   leads    newest last, capped at 200, 90 days                  → the leads table
//   visits   visit id → active seconds reported (2 days)          → count a visit once, add only new time
//   live     visit id → page, city, network… (10 minutes)         → who is on the site right now
//
// The object leaves memory after a few idle seconds, so everything that must survive is in SQLite; memory only
// caches it. Writes stay far under the free 100,000 rows a day: one row per event, one per heartbeat (its tab's
// presence) and one per page view (the day's counters).
// No chat text is ever stored: turns carry level, model and tokens; chats only their AI summary.

export type Counts = Record<string, number>;
export type Presence = { sessionId: string; page: string; ipHash: string; city?: string; country?: string; device?: string; network?: string; source?: string };
type Row = Record<string, SqlStorageValue>;

const FEED = 2000;
const LEADS = 200;
const KEEP_DAYS = 40;
const FIELDS = 600; // a day's counters take at most 600 different fields (made-up pages or sources can't grow it)
const PATHS_EVERY = 3_600_000; // the site's page list is refetched hourly

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clip = (s: unknown, n = 80) => String(s ?? "").slice(0, n);
const parse = (rows: Row[]) => rows.flatMap((r) => { try { return [JSON.parse(String(r.json))]; } catch { return []; } });

export class Stats extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private present = new Map<string, Record<string, string>>(); // the live table, cached
  private pings = new Map<string, number>(); // network + minute → pings (memory only: a soft limit)
  private today?: { day: string; counts: Counts };
  private paths?: { set: Set<string>; at: number };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, counts TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, active INTEGER NOT NULL, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS live (id TEXT PRIMARY KEY, data TEXT NOT NULL, last INTEGER NOT NULL)");
    for (const r of this.sql.exec("SELECT id, data FROM live WHERE last > ?", Date.now() - 600_000)) {
      this.present.set(String(r.id), JSON.parse(String(r.data)));
    }
  }

  // ── counters ──────────────────────────────────────────────────────────────

  private dayRow(d: string) {
    if (this.today?.day !== d) {
      const found = this.sql.exec("SELECT counts FROM days WHERE day = ?", d).toArray()[0];
      this.today = { day: d, counts: found ? JSON.parse(String(found.counts)) : {} };
      if (!found) this.cleanUp(); // the first event of a new day
    }
    return this.today;
  }

  private count(d: string, counts: Counts) {
    const add = Object.entries(counts).filter(([, n]) => n);
    if (!add.length) return;
    const row = this.dayRow(d);
    let size = Object.keys(row.counts).length;
    for (const [f, n] of add) {
      const field = clip(f);
      if (!(field in row.counts)) {
        if (size >= FIELDS) continue;
        size++;
      }
      row.counts[field] = (row.counts[field] ?? 0) + Math.round(n);
    }
    this.sql.exec("INSERT INTO days (day, counts) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET counts = excluded.counts", d, JSON.stringify(row.counts));
  }

  private cleanUp() {
    const now = Date.now();
    this.sql.exec("DELETE FROM days WHERE day < ?", day(now - KEEP_DAYS * 86_400_000));
    this.sql.exec("DELETE FROM visits WHERE at < ?", now - 2 * 86_400_000);
    this.sql.exec("DELETE FROM leads WHERE at < ?", now - 90 * 86_400_000);
    this.sql.exec("DELETE FROM live WHERE last < ?", now - 600_000);
  }

  // ── writers (called by the Worker) ────────────────────────────────────────

  /** Any event for the feed, plus counters for today. A lead also goes into its own list. */
  push(event: string, counts: Counts, lead = false) {
    if (event) {
      this.sql.exec("INSERT INTO feed (json) VALUES (?)", event);
      this.sql.exec("DELETE FROM feed WHERE id <= (SELECT MAX(id) FROM feed) - ?", FEED);
      if (lead) {
        this.sql.exec("INSERT INTO leads (json, at) VALUES (?, ?)", event, Date.now());
        this.sql.exec("DELETE FROM leads WHERE id <= (SELECT MAX(id) FROM leads) - ?", LEADS);
      }
    }
    this.count(day(), counts);
  }

  /** A visit report (sent each time the tab is hidden): the first one counts the visit; each adds new active time. */
  visit(sessionId: string, activeSeconds: number, event: string, firsts: Counts) {
    const before = this.sql.exec("SELECT active FROM visits WHERE id = ?", sessionId).toArray()[0];
    const had = before ? Number(before.active) : 0;
    const added = Math.max(0, Math.round(activeSeconds) - had);
    if (!before || added) {
      this.sql.exec("INSERT INTO visits (id, active, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET active = excluded.active, at = excluded.at",
        sessionId, had + added, Date.now());
    }
    if (!before) this.push(event, { ...firsts, active_s: added });
    else if (added) this.count(day(), { active_s: added });
    return !before;
  }

  /** Heartbeat: mark the visitor live, remember what they're looking at, count a page view when the page changed.
   * The same tab on the same page at most every 10 s (returns 0); at most 300 pings a minute from one network
   * (returns -1 → 429). */
  async live(p: Presence): Promise<number> {
    const now = Date.now();
    let stale = false;
    for (const [id, v] of this.present) {
      if (now - Number(v.last) > 600_000) stale = this.present.delete(id);
    }
    if (stale) this.sql.exec("DELETE FROM live WHERE last < ?", now - 600_000);
    const page = (await this.sitePaths()).has(p.page) ? p.page : "other"; // a 404 or a made-up path
    const before = this.present.get(p.sessionId);
    if (before?.page === page && now - Number(before.last) < 10_000) return 0;
    const key = `${p.ipHash}:${Math.floor(now / 60_000)}`;
    const n = (this.pings.get(key) ?? 0) + 1;
    if (this.pings.size > 5000) this.pings.clear();
    this.pings.set(key, n);
    if (n > 300) return -1;
    const fields = Object.fromEntries(
      Object.entries({ page, city: p.city, country: p.country, device: p.device, net: p.network, src: p.source, sid: p.sessionId.slice(0, 8) })
        .filter(([, v]) => v)
        .map(([k, v]) => [k, clip(v)]),
    );
    const entry = { ...before, ...fields, since: before?.since ?? String(now), last: String(now) };
    this.present.set(p.sessionId, entry);
    this.sql.exec("INSERT INTO live (id, data, last) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, last = excluded.last",
      p.sessionId, JSON.stringify(entry), now);
    if (before?.page !== page) this.count(day(now), { pv: 1, [`page:${page}`]: 1 });
    return 1;
  }

  /** The site's pages, from the site itself (app/site-paths.json): new projects or posts count by name at once. */
  private async sitePaths(): Promise<Set<string>> {
    if (!this.paths) {
      const saved = this.sql.exec("SELECT value FROM meta WHERE key = 'paths'").toArray()[0];
      const { list = ["/"], at = 0 } = saved ? (JSON.parse(String(saved.value)) as { list?: string[]; at?: number }) : {};
      this.paths = { set: new Set(list), at };
    }
    if (Date.now() - this.paths.at < PATHS_EVERY) return this.paths.set;
    try {
      const res = await fetch(`${this.env.SITE_ORIGIN}/site-paths.json`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(String(res.status));
      const list = ((await res.json()) as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 500);
      this.paths = { set: new Set(list), at: Date.now() };
      this.sql.exec("INSERT INTO meta (key, value) VALUES ('paths', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ list, at: this.paths.at }));
    } catch {
      this.paths.at = Date.now() - PATHS_EVERY + 60_000; // keep the last known list; try again in a minute
    }
    return this.paths.set;
  }

  // ── reader (admin only) ───────────────────────────────────────────────────

  /** Everything the dashboard shows, in the shape of lib/server/events.ts `Snapshot`. */
  snapshot(feed = 80) {
    const now = Date.now();
    const names = Array.from({ length: 7 }, (_, i) => day(now - (6 - i) * 86_400_000));
    const stored = new Map(this.sql.exec("SELECT day, counts FROM days WHERE day >= ?", names[0]).toArray().map((r) => [String(r.day), JSON.parse(String(r.counts)) as Counts]));
    return {
      now,
      live: [...this.present.values()].filter((v) => now - Number(v.last) < 90_000),
      events: parse(this.sql.exec("SELECT json FROM feed ORDER BY id DESC LIMIT ?", Math.min(feed, FEED)).toArray()),
      days: names.map((d) => ({ day: d, stats: stored.get(d) ?? {} })),
      leads: parse(this.sql.exec("SELECT json FROM leads ORDER BY id DESC LIMIT 20").toArray()),
    };
  }

  // ── one-time history import from Upstash (scripts/import-analytics.ts) ────

  /** Adds a batch of old days, feed events and leads (each list oldest first). Runs once: a finished import is
   * remembered, and further calls change nothing. */
  importBatch(batch: { days?: { day: string; stats: Counts }[]; feed?: string[]; leads?: { json: string; at: number }[]; done?: boolean }) {
    if (this.sql.exec("SELECT value FROM meta WHERE key = 'imported'").toArray().length) return { ok: false, reason: "already imported" };
    for (const { day: d, stats } of batch.days ?? []) {
      this.today = undefined;
      this.count(d, stats); // adds to anything counted since the switch
    }
    this.today = undefined;
    const feed = batch.feed ?? [];
    const leads = batch.leads ?? [];
    // Old events go before the ones that arrived since the switch: ids below the current smallest.
    let next = Number(this.sql.exec("SELECT MIN(id) AS id FROM feed").toArray()[0]?.id ?? 1) - feed.length;
    for (const json of feed) this.sql.exec("INSERT INTO feed (id, json) VALUES (?, ?)", next++, json);
    let nextLead = Number(this.sql.exec("SELECT MIN(id) AS id FROM leads").toArray()[0]?.id ?? 1) - leads.length;
    for (const { json, at } of leads) this.sql.exec("INSERT INTO leads (id, json, at) VALUES (?, ?, ?)", nextLead++, json, at);
    if (batch.done) this.sql.exec("INSERT INTO meta (key, value) VALUES ('imported', ?)", new Date().toISOString());
    return { ok: true };
  }
}
