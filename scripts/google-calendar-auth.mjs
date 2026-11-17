// Connects "Book a call" to Rishabh's Google Calendar, once. Run:  npm run calendar:connect
//
// Before it (Google Cloud console, free):
//   1. APIs & Services → Library → "Google Calendar API" → Enable.
//   2. OAuth consent screen → External → add yourself as a test user, then "Publish app" (In production).
//      While it says "Testing", Google expires the token after 7 days and booking stops.
//   3. Credentials → Create credentials → OAuth client ID → "Desktop app". Copy its client ID and secret into
//      .env.local as GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET.
//
// This script opens Google's consent page in your browser; you allow it with your own account, and the refresh token
// it gets back is written to .env.local (never printed). Then add the three values to Vercel (Production).

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";

const ENV = ".env.local";
const env = Object.fromEntries(
  (existsSync(ENV) ? readFileSync(ENV, "utf8") : "")
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || env.GOOGLE_CALENDAR_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || env.GOOGLE_CALENDAR_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(`Put GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET in ${ENV} first (see the top of this file).`);
  process.exit(1);
}

// Free/busy (when he's busy, never what) and events (to add the calls and count the site's own bookings).
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("That didn't work. Close this tab and run the script again.");
    return finish(1);
  }
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const data = await r.json();
  if (!r.ok || !data.refresh_token) {
    res.writeHead(500).end("Google didn't return a refresh token. Close this tab and run the script again.");
    console.error("Token exchange failed:", r.status, data.error ?? "no refresh_token");
    return finish(1);
  }
  const lines = (existsSync(ENV) ? readFileSync(ENV, "utf8") : "").split(/\r?\n/).filter((l) => !l.startsWith("GOOGLE_CALENDAR_REFRESH_TOKEN="));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(ENV, [...lines, `GOOGLE_CALENDAR_REFRESH_TOKEN=${data.refresh_token}`, ""].join("\n"));
  res.writeHead(200, { "content-type": "text/html" }).end("<p style='font:18px system-ui'>Connected. You can close this tab.</p>");
  console.log(`Connected. GOOGLE_CALENDAR_REFRESH_TOKEN is in ${ENV}.`);
  finish(0);
});

function finish(code) {
  server.close();
  setTimeout(() => process.exit(code), 100);
}

server.listen(0, "127.0.0.1", () => {
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const consent = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  })}`;
  console.log("Opening Google's consent page. If it doesn't open, paste this into your browser:\n" + consent);
  exec(process.platform === "win32" ? `start "" "${consent}"` : `open "${consent}" || xdg-open "${consent}"`);
});
