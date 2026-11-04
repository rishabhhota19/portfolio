import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { ChatMessage, Lead } from "@/lib/chat-types";
import { ipHash } from "@/lib/server/request";
import type { SessionRow } from "@/lib/server/sheets";

// Client for the Python agent (api/index.py). Locally AGENT_URL=http://127.0.0.1:8000;
// on Vercel the agent lives on the same domain, so the request's own origin is used.
function agentUrl(req: Request, path: string) {
  const base = process.env.AGENT_URL || new URL(req.url).origin;
  return `${base}/api/agent/${path}`;
}

function agentHeaders(req: Request) {
  return {
    "content-type": "application/json",
    "x-agent-secret": process.env.AGENT_SHARED_SECRET ?? "",
    "x-caller": ipHash(req), // hashed network: the agent's fair shares and outage detection count networks, not requests
    cookie: req.headers.get("cookie") ?? "", // lets the call through Vercel's preview protection
  };
}

/** Streams the agent's answer, or returns null if the agent is unavailable. */
export async function askAgent(req: Request, conversationId: string, sessionId: string, messages: ChatMessage[]) {
  try {
    const res = await fetch(agentUrl(req, "chat"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ conversation_id: conversationId, session_id: sessionId, messages }),
      signal: req.signal,
    });
    return res.ok && res.body ? res.body : null;
  } catch (err) {
    console.error("[agent] chat call failed:", err);
    Sentry.captureException(err);
    return null;
  }
}

/** The model web's budgets today and the embedding lineup (admin dashboard). Costs ~70 Redis commands: on demand only. */
export async function agentHealth(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(agentUrl(req, "health"), { headers: agentHeaders(req), signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type AgentMeta = { intent: string; why: string; level: string; model: string; tokens_in: number; tokens_out: number; ms: number };

/** Takes the agent's "meta" line (which model answered, the level: admin-only) out of the answer stream and hands
 * it over when the stream ends — or when the visitor cancels. Every other line passes through as it arrives. */
export function splitMeta(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  let pending = "";
  let meta: AgentMeta | null = null;
  let finish!: () => void;
  const ended = new Promise<AgentMeta | null>((resolve) => (finish = () => resolve(meta)));
  signal.addEventListener("abort", () => finish());
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const keep = (line: string) => {
    if (!/"type":\s*"meta"/.test(line)) return true;
    try {
      meta = JSON.parse(line) as AgentMeta;
    } catch {}
    return false;
  };
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop() ?? "";
        const out = lines.filter(keep).map((l) => `${l}\n`).join("");
        if (out) controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        if (pending && keep(pending)) controller.enqueue(encoder.encode(pending));
        finish();
      },
    }),
  );
  return { stream, meta: ended };
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

/** The summary is a model's JSON: every field becomes a short string (a list is joined), so nothing later can trip on it. */
function cleanSummary(raw: unknown, messages: ChatMessage[]): ChatSummary {
  if (!raw || typeof raw !== "object") return plainSummary(messages);
  const text = (v: unknown) =>
    (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "").slice(0, 1000);
  const s = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, text(v)])) as ChatSummary;
  return s.summary ? s : plainSummary(messages);
}

/** conversationId tells the agent the chat is over, so it deletes that conversation's working memory. */
export async function summarizeChat(req: Request, sessionId: string, messages: ChatMessage[], lead?: Lead, conversationId = ""): Promise<ChatSummary> {
  try {
    const res = await fetch(agentUrl(req, "summarize"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ messages, lead: lead ?? null, session_id: sessionId, conversation_id: conversationId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return cleanSummary(await res.json(), messages);
    console.error("[agent] summarize failed:", res.status);
    Sentry.captureMessage(`Agent summarize failed (${res.status})`, "warning");
  } catch (err) {
    console.error("[agent] summarize call failed:", err);
    Sentry.captureException(err);
  }
  return plainSummary(messages);
}

type Usage = Pick<SessionRow, "tokensIn" | "tokensOut" | "tokensTotal" | "llmCalls" | "models" | "switches" | "avgLatency" | "summaryTokens">;

/** The visit's real token totals (counted by the Python agent). Empty if the visitor didn't use the LLM. */
export async function sessionUsage(req: Request, sessionId: string): Promise<Usage> {
  try {
    const res = await fetch(agentUrl(req, `session/${sessionId}`), { headers: agentHeaders(req), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return {};
    const usage = (await res.json()) as Usage;
    return usage.llmCalls || usage.summaryTokens ? usage : {};
  } catch {
    return {};
  }
}
