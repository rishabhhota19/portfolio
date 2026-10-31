import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { ChatMessage, Lead } from "@/lib/chat-types";

// Client for the Python agent (api/index.py). Locally AGENT_URL=http://127.0.0.1:8000;
// on Vercel the agent lives on the same domain, so the request's own origin is used.
function agentUrl(req: Request, path: "chat" | "summarize") {
  const base = process.env.AGENT_URL || new URL(req.url).origin;
  return `${base}/api/agent/${path}`;
}

function agentHeaders(req: Request) {
  return {
    "content-type": "application/json",
    "x-agent-secret": process.env.AGENT_SHARED_SECRET ?? "",
    cookie: req.headers.get("cookie") ?? "", // lets the call through Vercel's preview protection
  };
}

/** Streams the agent's answer, or returns null if the agent is unavailable. */
export async function askAgent(req: Request, conversationId: string, messages: ChatMessage[]) {
  try {
    const res = await fetch(agentUrl(req, "chat"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ conversation_id: conversationId, messages }),
      signal: req.signal,
    });
    return res.ok && res.body ? res.body : null;
  } catch (err) {
    console.error("[agent] chat call failed:", err);
    Sentry.captureException(err);
    return null;
  }
}

export type ChatSummary = {
  visitorName?: string;
  company?: string;
  role?: string;
  email?: string;
  intent?: string;
  topics?: string;
  summary?: string;
  followUp?: string;
  model: string;
};

/** Cheap fallback when the agent can't summarise: list what the visitor asked. */
export function plainSummary(messages: ChatMessage[], note = ""): ChatSummary {
  const asked = messages.filter((m) => m.role === "user").map((m) => m.content.slice(0, 80));
  return { summary: `${note}Visitor asked: ${asked.join("; ") || "nothing"}.`, topics: asked.slice(0, 6).join(", "), model: "none" };
}

export async function summarizeChat(req: Request, messages: ChatMessage[], lead?: Lead): Promise<ChatSummary> {
  try {
    const res = await fetch(agentUrl(req, "summarize"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ messages, lead: lead ?? null }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()) as ChatSummary;
    console.error("[agent] summarize failed:", res.status);
    Sentry.captureMessage(`Agent summarize failed (${res.status})`, "warning");
  } catch (err) {
    console.error("[agent] summarize call failed:", err);
    Sentry.captureException(err);
  }
  return plainSummary(messages);
}
