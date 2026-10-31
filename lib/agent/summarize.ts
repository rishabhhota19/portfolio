import "server-only";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatMessage, Lead } from "@/lib/chat-types";
import { availableModels, coolDown } from "./models";
import { SUMMARY_PROMPT } from "./prompt";
import { forcedFailure, shouldMock, summaryProviders } from "./providers";

export type ChatSummary = {
  visitorName: string;
  company: string;
  role: string;
  email: string;
  intent: string;
  topics: string;
  summary: string;
  followUp: string;
  model: string;
};

const EMPTY: Omit<ChatSummary, "model"> = {
  visitorName: "",
  company: "",
  role: "",
  email: "",
  intent: "",
  topics: "",
  summary: "",
  followUp: "",
};

function transcriptText(messages: ChatMessage[], lead?: Lead) {
  const lines = messages.map((m) => `${m.role === "user" ? "Visitor" : "Agent"}: ${m.content}`);
  if (lead) {
    lines.push(
      `(Visitor submitted the contact form — name: ${lead.name}; email: ${lead.email}; company: ${lead.company || "-"}; hiring for: ${lead.role || "-"}; note: ${lead.note || "-"})`,
    );
  }
  return lines.join("\n");
}

function parse(raw: string): Omit<ChatSummary, "model"> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const data = JSON.parse(match[0]) as Record<string, unknown>;
      const pick = (k: keyof typeof EMPTY) => (typeof data[k] === "string" ? (data[k] as string).trim() : "");
      return {
        visitorName: pick("visitorName"),
        company: pick("company"),
        role: pick("role"),
        email: pick("email"),
        intent: pick("intent"),
        topics: pick("topics"),
        summary: pick("summary"),
        followUp: pick("followUp"),
      };
    } catch {}
  }
  return { ...EMPTY, summary: raw.trim().slice(0, 600) };
}

/** Cheap fallback when no LLM is available: list what the visitor asked. */
export function plainSummary(messages: ChatMessage[], note = ""): ChatSummary {
  const asked = messages.filter((m) => m.role === "user").map((m) => m.content.slice(0, 80));
  return {
    ...EMPTY,
    topics: asked.slice(0, 6).join(", "),
    summary: `${note}Visitor asked: ${asked.map((q) => `"${q}"`).join("; ") || "nothing"}.`,
    model: "none",
  };
}

/**
 * Turns a finished chat into the few fields Rishabh sees in his Google Sheet.
 * The transcript itself is never stored — only this summary.
 */
export async function summarizeChat(messages: ChatMessage[], lead?: Lead): Promise<ChatSummary> {
  if (!messages.length && !lead) return { ...EMPTY, model: "none" };
  if (shouldMock()) return plainSummary(messages, "(mock) ");

  const prompt = [new SystemMessage(SUMMARY_PROMPT), new HumanMessage(transcriptText(messages, lead))];
  for (const { id, label, model } of await availableModels(summaryProviders(), 0)) {
    if (forcedFailure(id)) continue;
    try {
      const res = await model.invoke(prompt);
      const parsed = parse(res.text);
      if (parsed.summary) return { ...parsed, model: label };
    } catch (err) {
      await coolDown(id, err);
    }
  }
  return plainSummary(messages, "(no model available) ");
}
