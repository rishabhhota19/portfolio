import "server-only";
import { END, MessagesValue, START, StateGraph, StateSchema, type GraphNode } from "@langchain/langgraph";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { LIMITS } from "@/lib/chat-types";
import { availableModels, coolDown, mockModel, type Candidate } from "./models";
import { systemPrompt } from "./prompt";
import { chatProviders, forcedFailure, shouldMock } from "./providers";
import { retriever } from "./retriever";

const ContextChunk = z.object({ title: z.string(), url: z.string(), text: z.string() });
export type ContextChunk = z.infer<typeof ContextChunk>;

const AgentState = new StateSchema({
  messages: MessagesValue,
  context: z.array(ContextChunk).default([]),
  provider: z.string().default(""),
});

/** Node 1 — RAG: search the site's content for the latest question (plus the previous one, for follow-ups). */
const retrieve: GraphNode<typeof AgentState> = async (state, config) => {
  const query = state.messages
    .filter((m) => m.getType() === "human")
    .slice(-2)
    .map((m) => m.text)
    .join("\n");
  const docs = await retriever.invoke(query, config);
  return {
    context: docs.map((d) => ({
      title: String(d.metadata.title ?? ""),
      url: String(d.metadata.url ?? ""),
      text: d.pageContent,
    })),
  };
};

function mockAnswer(context: ContextChunk[]) {
  const top = context[0];
  if (!top) return "**Mock mode** (no LLM keys set). I couldn't find anything specific for that — try asking about his projects or research.";
  const firstLine = top.text.split("\n").find((l, i) => i > 0 && l.trim().length > 30) ?? top.text;
  return `**Mock mode** (no LLM keys set) — RAG found [${top.title}](${top.url}):\n- ${firstLine.replace(/^[-•]\s*/, "").slice(0, 220)}\n\nAdd \`GROQ_API_KEY\` to \`.env.local\` for real answers.`;
}

/**
 * Node 2 — answer, walking the free-provider chain. Tokens reach the client through
 * LangGraph's "messages" stream mode because `config` is passed to the model.
 * A provider that fails before its first token is cooled down and the next one answers.
 */
const respond: GraphNode<typeof AgentState> = async (state, config) => {
  const prompt = [new SystemMessage(systemPrompt(state.context)), ...state.messages.slice(-LIMITS.maxHistory)];
  const candidates: Candidate[] = shouldMock() ? [mockModel(mockAnswer(state.context))] : await availableModels(chatProviders());

  for (const { id, label, model } of candidates) {
    if (forcedFailure(id)) {
      console.warn(`[agent] FORCE_FAIL skipping ${id}`);
      continue;
    }
    let text = "";
    let messageId: string | undefined;
    try {
      const stream = await model.stream(prompt, config); // resolves after the first chunk (or throws)
      try {
        for await (const chunk of stream) {
          text += chunk.text;
          messageId ??= chunk.id;
        }
      } catch (err) {
        if (!text) throw err;
        console.error(`[agent] ${id} failed mid-answer; keeping partial reply`, err);
      }
      if (!text.trim()) throw new Error("empty response");
      return { messages: [new AIMessage({ content: text, id: messageId })], provider: label };
    } catch (err) {
      if (config.signal?.aborted) break;
      await coolDown(id, err);
    }
  }
  return { provider: "none" };
};

export const agent = new StateGraph(AgentState)
  .addNode("retrieve", retrieve)
  .addNode("respond", respond)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "respond")
  .addEdge("respond", END)
  .compile();
