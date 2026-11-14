import "server-only";
import * as Sentry from "@sentry/nextjs";
import starters from "@/content/starters.json";
import type { ChatMessage } from "@/lib/chat-types";
import { ipHash } from "@/lib/server/request";
import type { SessionRow } from "@/lib/server/sheets";

// Client for the Python agent (api/index.py). Locally AGENT_URL=http://127.0.0.1:8000;
// on Vercel the agent lives on the same domain, so the request's own origin is used.
function agentUrl(req: Request, path: string) {
  const base = process.env.AGENT_URL || new URL(req.url).origin;
  return `${base}/api/agent/${path}`;
}

if (process.env.VERCEL && !process.env.AGENT_SHARED_SECRET) {
  // The agent refuses every call without it: say so loudly instead of looking like a quiet outage.
  console.error("[agent] AGENT_SHARED_SECRET is not set: every call to the agent will be refused");
}

function agentHeaders(req: Request) {
  return {
    "content-type": "application/json",
    "x-agent-secret": process.env.AGENT_SHARED_SECRET ?? "",
    "x-caller": ipHash(req), // hashed network: the agent's fair shares and outage detection count networks, not requests
    cookie: req.headers.get("cookie") ?? "", // lets the call through Vercel's preview protection
  };
}

const CHAT_TIMEOUT_MS = 50_000; // Vercel stops the route at 60 s; a hung call must not hold the visitor's placeholder until then

/** Streams the agent's answer, or returns null if the agent is unavailable (logged, with a Sentry event: a wrong
 * secret or a crashed agent must never look like a quiet outage). */
export async function askAgent(req: Request, conversationId: string, sessionId: string, messages: ChatMessage[]) {
  try {
    const res = await fetch(agentUrl(req, "chat"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ conversation_id: conversationId, session_id: sessionId, messages }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
    });
    if (!res.ok || !res.body) {
      console.error(`[agent] chat answered ${res.status}`);
      Sentry.captureMessage(`Agent chat answered ${res.status}`, "warning");
      return null;
    }
    return res.body;
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

/** What `splitMeta` hands over when the visitor cancelled before the meta line arrived: the model ran all the same. */
export const ABORTED = Symbol("aborted");

/** Takes the agent's "meta" line (which model answered, the level: admin-only) out of the answer stream and hands
 * it over when the stream ends — or ABORTED when the visitor cancels first. Every other line passes through as it
 * arrives. */
export function splitMeta(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  let pending = "";
  let meta: AgentMeta | null = null;
  let aborted = false;
  let finish!: () => void;
  const ended = new Promise<AgentMeta | typeof ABORTED | null>((resolve) => (finish = () => resolve(meta ?? (aborted ? ABORTED : null))));
  signal.addEventListener("abort", () => {
    aborted = true;
    finish();
  });
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

const QUICK_QUESTIONS = new Set(starters.map((s) => s.q));

/** The summary when no model writes one: a tab switch, quick answers only, the summary budget spent, the agent down.
 * It never repeats what the visitor typed, because the privacy page promises that only an AI-written summary of a
 * chat is kept. It counts their messages and names the site's own quick questions they picked: matched against our
 * list, not taken on the browser's word, so no typed text gets through as a "quick question". */
export function plainSummary(messages: ChatMessage[], note = ""): ChatSummary {
  const asked = messages.filter((m) => m.role === "user").map((m) => m.content);
  const picked = [...new Set(asked.filter((q) => QUICK_QUESTIONS.has(q)))];
  const typed = asked.length - asked.filter((q) => QUICK_QUESTIONS.has(q)).length;
  const did = [
    typed ? `typed ${typed} ${typed === 1 ? "message" : "messages"}` : "",
    picked.length ? `picked ${picked.map((q) => `“${q}”`).join(", ")}` : "",
  ].filter(Boolean);
  return {
    summary: `${note}Visitor ${did.join(" and ") || "sent nothing"}.${typed ? " No AI summary for this one, so their own words are not kept." : ""}`,
    topics: picked.join(", "),
    model: "none",
  };
}

/** The summary is a model's JSON: every field becomes a short string (a list is joined), so nothing later can trip on it. */
function cleanSummary(raw: unknown, messages: ChatMessage[]): ChatSummary {
  if (!raw || typeof raw !== "object") return plainSummary(messages);
  const text = (v: unknown) =>
    (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "").slice(0, 1000);
  const s = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, text(v)])) as ChatSummary;
  return s.summary ? s : plainSummary(messages);
}

/** A model's summary of the chat, and only of the chat: what a visitor types into "Share your details" never goes to
 * a model (the lead route puts it in the row itself). `sharedDetails` tells the model only that the form was filled
 * in, so it can still judge how serious the visitor is. `conversationId` tells the agent the chat is over, so it
 * deletes that conversation's working memory. */
export async function summarizeChat(
  req: Request,
  sessionId: string,
  messages: ChatMessage[],
  { conversationId = "", sharedDetails = false }: { conversationId?: string; sharedDetails?: boolean } = {},
): Promise<ChatSummary> {
  try {
    const res = await fetch(agentUrl(req, "summarize"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ messages, shared_details: sharedDetails, session_id: sessionId, conversation_id: conversationId }),
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

/** The chat is over and no model is summarising it (the summary budget is spent, or a lead already logged this point
 * of it): the agent deletes its working memory of the conversation all the same, as the privacy page says it does. */
export async function forgetChat(req: Request, conversationId: string): Promise<void> {
  try {
    const res = await fetch(agentUrl(req, "forget"), {
      method: "POST",
      headers: agentHeaders(req),
      body: JSON.stringify({ conversation_id: conversationId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error("[agent] forget failed:", res.status); // the memory then goes on its own after two hours
  } catch (err) {
    console.error("[agent] forget call failed:", err);
  }
}

type Usage = Pick<SessionRow,"tokensIn" | "tokensOut" | "tokensTotal" | "llmCalls" | "models" | "switches" | "avgLatency" | "summaryTokens">;

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
