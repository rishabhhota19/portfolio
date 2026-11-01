import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { Lead } from "@/lib/chat-types";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type LeadEmail = {
  lead: Lead;
  summary: string;
  topics: string;
  followUp: string;
  meta: { country: string; city: string; device: string; page: string };
};

/** Emails Rishabh a new recruiter lead via Resend's REST API. */
export async function sendLeadEmail({ lead, summary, topics, followUp, meta }: LeadEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_ALERT_EMAIL;
  if (!apiKey || !to) {
    console.info("[email] RESEND_API_KEY / LEAD_ALERT_EMAIL not set — lead email skipped:", lead.email);
    return false;
  }

  const rows: [string, string][] = [
    ["Name", lead.name],
    ["Email", lead.email],
    ["Phone", lead.phone || "—"],
    ["Company", lead.company || "—"],
    ["Hiring for", lead.role || "—"],
    ["Their note", lead.note || "—"],
    ["Chat summary", summary || "—"],
    ["Topics asked", topics || "—"],
    ["Suggested follow-up", followUp || "—"],
    ["From", [meta.city, meta.country].filter(Boolean).join(", ") || "—"],
    ["Device / page", `${meta.device} · ${meta.page}`],
  ];

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px">
      <h2 style="margin:0 0 12px">New recruiter lead from your portfolio</h2>
      <table cellpadding="8" style="border-collapse:collapse;width:100%">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="border-bottom:1px solid #eee;color:#666;white-space:nowrap;vertical-align:top">${k}</td><td style="border-bottom:1px solid #eee">${escape(v).replace(/\n/g, "<br>")}</td></tr>`,
          )
          .join("")}
      </table>
      <p style="color:#888;font-size:12px">Reply to this email to answer ${escape(lead.name)} directly.</p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Portfolio Agent <onboarding@resend.dev>",
        to: [to],
        reply_to: lead.email,
        subject: `New lead: ${lead.name}${lead.company ? ` (${lead.company})` : ""}${lead.role ? ` — ${lead.role}` : ""}`,
        html,
        text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[email] Resend error:", res.status, await res.text());
      Sentry.captureMessage(`Lead email failed (Resend ${res.status})`, "error");
    }
    return res.ok;
  } catch (err) {
    console.error("[email] send failed:", err);
    Sentry.captureException(err);
    return false;
  }
}
