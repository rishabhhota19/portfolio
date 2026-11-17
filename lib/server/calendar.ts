import "server-only";

/**
 * Booking a call with Rishabh, straight into his Google Calendar.
 *
 * The site holds one OAuth refresh token for his own Google account (scripts/google-calendar-auth.mjs makes it), so it
 * can read when he is busy and add an event, with the visitor as a guest and a Google Meet link; Google emails them
 * the invite and puts it in their calendar. Nothing else on his calendar is read: free/busy says only when, never
 * what.
 *
 * His rules are RULES below: weekdays, 10 am to 9 pm India time, 30-minute calls with 15 minutes clear either side,
 * at least 3 hours' notice, up to 14 days ahead, at most 3 site bookings a day.
 */

export const RULES = {
  timeZone: "Asia/Kolkata",
  days: [1, 2, 3, 4, 5], // Monday–Friday (0 = Sunday)
  firstStart: 10 * 60, // 10:00, minutes after midnight India time
  lastEnd: 21 * 60, // no call runs past 9 pm
  minutes: 30, // each call
  step: 30, // a call can start on the hour or the half hour
  gap: 15, // clear minutes before and after, around any other event
  noticeHours: 3,
  daysAhead: 14,
  perDay: 3, // calls booked through the site, per day
};

const IST_MS = 5.5 * 3600_000; // India has no daylight saving: one fixed offset
const MIN = 60_000;
const API = "https://www.googleapis.com/calendar/v3";

const config = () => ({
  clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
  calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
});

/** Whether the site can book: the three Google values are set. Until then "Book a call" falls back to email. */
export const bookingReady = () => {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
};

let token: { value: string; until: number } | null = null;

async function accessToken() {
  if (token && token.until > Date.now() + MIN) return token.value;
  const c = config();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId!,
      client_secret: c.clientSecret!,
      refresh_token: c.refreshToken!,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`google token ${res.status}`); // the status only: the body can echo the client id
  const data = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: data.access_token, until: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function google<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`google calendar ${res.status} on ${path.split("?")[0].split("/").slice(0, 3).join("/")}`);
  return (await res.json()) as T;
}

type Span = { start: number; end: number };

/** When he is busy (any calendar event) and the calls already booked through the site, between two times. */
async function busy(from: number, to: number): Promise<{ busy: Span[]; booked: number[] }> {
  const { calendarId } = config();
  const range = { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() };
  const [fb, ours] = await Promise.all([
    google<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>("/freeBusy", {
      method: "POST",
      body: JSON.stringify({ ...range, timeZone: RULES.timeZone, items: [{ id: calendarId }] }),
    }),
    google<{ items?: { start: { dateTime?: string } }[] }>(
      `/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams({
        ...range,
        singleEvents: "true",
        maxResults: "100",
        privateExtendedProperty: "source=portfolio",
        fields: "items(start)",
      })}`,
    ),
  ]);
  const spans = Object.values(fb.calendars ?? {}).flatMap((c) => c.busy ?? []);
  return {
    busy: spans.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
    booked: (ours.items ?? []).flatMap((e) => (e.start.dateTime ? [Date.parse(e.start.dateTime)] : [])),
  };
}

/** The India-time calendar date of a moment, as YYYY-MM-DD. */
const istDay = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10);

function candidates(now: number): number[] {
  const out: number[] = [];
  const earliest = now + RULES.noticeHours * 3600_000;
  const todayMidnight = Date.parse(`${istDay(now)}T00:00:00Z`) - IST_MS; // 00:00 India time, as a UTC moment
  for (let d = 0; d <= RULES.daysAhead; d++) {
    const midnight = todayMidnight + d * 86_400_000;
    const weekday = new Date(midnight + IST_MS).getUTCDay();
    if (!RULES.days.includes(weekday)) continue;
    for (let m = RULES.firstStart; m + RULES.minutes <= RULES.lastEnd; m += RULES.step) {
      const start = midnight + m * MIN;
      if (start >= earliest) out.push(start);
    }
  }
  return out;
}

const clashes = (start: number, spans: Span[]) => {
  const from = start - RULES.gap * MIN;
  const to = start + (RULES.minutes + RULES.gap) * MIN;
  return spans.some((b) => b.start < to && b.end > from);
};

/** Open start times (ISO, UTC) from now to RULES.daysAhead, grouped by India-time day. */
export async function openSlots(now = Date.now()): Promise<{ day: string; slots: string[] }[]> {
  const all = candidates(now);
  if (!all.length) return [];
  const { busy: spans, booked } = await busy(all[0] - RULES.gap * MIN, all[all.length - 1] + (RULES.minutes + RULES.gap) * MIN);
  const perDay = new Map<string, number>();
  for (const t of booked) perDay.set(istDay(t), (perDay.get(istDay(t)) ?? 0) + 1);
  const days = new Map<string, string[]>();
  for (const start of all) {
    const day = istDay(start);
    if ((perDay.get(day) ?? 0) >= RULES.perDay || clashes(start, spans)) continue;
    days.set(day, [...(days.get(day) ?? []), new Date(start).toISOString()]);
  }
  return [...days].map(([day, slots]) => ({ day, slots }));
}

/** Is this exact start time still bookable? Checked again just before booking: someone may have taken it. */
export async function stillOpen(startIso: string, now = Date.now()) {
  const start = Date.parse(startIso);
  if (!candidates(now).includes(start)) return false;
  const day = istDay(start);
  const midnight = Date.parse(`${day}T00:00:00Z`) - IST_MS;
  const { busy: spans, booked } = await busy(midnight, midnight + 86_400_000);
  return booked.length < RULES.perDay && !clashes(start, spans);
}

export type Booking = { start: string; name: string; email: string; company: string; topic: string };

/** Puts the call on his calendar with a Meet link and the visitor as a guest; Google sends them the invite. */
export async function book(b: Booking, extra = ""): Promise<{ id: string; meet: string; link: string }> {
  const { calendarId } = config();
  const start = Date.parse(b.start);
  const who = b.company ? `${b.name} (${b.company})` : b.name;
  const event = await google<{ id: string; hangoutLink?: string; htmlLink: string }>(
    `/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: `Call: ${who} × Rishabh Hota`,
        description: description(b, extra),
        start: { dateTime: new Date(start).toISOString(), timeZone: RULES.timeZone },
        end: { dateTime: new Date(start + RULES.minutes * MIN).toISOString(), timeZone: RULES.timeZone },
        attendees: [{ email: b.email, displayName: b.name }],
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        extendedProperties: { private: { source: "portfolio" } },
        guestsCanInviteOthers: true,
        reminders: { useDefault: true },
      }),
    },
  );
  return { id: event.id, meet: event.hangoutLink ?? "", link: event.htmlLink };
}

/** Adds the chat summary once it is ready (after the visitor already has their confirmation). No new email goes out. */
export async function addNotes(id: string, b: Booking, notes: string) {
  const { calendarId } = config();
  await google(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}?sendUpdates=none`, {
    method: "PATCH",
    body: JSON.stringify({ description: description(b, notes) }),
  });
}

function description(b: Booking, extra: string) {
  return [
    `Booked on rishabh-hota.vercel.app`,
    ``,
    `Name: ${b.name}`,
    `Email: ${b.email}`,
    b.company ? `Company: ${b.company}` : "",
    ``,
    `What they want to talk about:`,
    b.topic,
    extra ? `\n${extra}` : "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

/** "Tue 18 Nov, 4:30 pm IST" */
export const istLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: RULES.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso)) + " IST";
