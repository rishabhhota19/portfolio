import "server-only";
import { ChatOpenAI } from "@langchain/openai";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { isCoolingDown, setCooldown } from "@/lib/server/store";
import type { ProviderSpec } from "./providers";

export type Candidate = { id: string; label: string; model: BaseChatModel };

/** One OpenAI-compatible LangChain chat model per provider. maxRetries 0 → fail over instantly. */
export function toModel(p: ProviderSpec, temperature = 0.3): Candidate {
  return {
    id: p.id,
    label: p.label,
    model: new ChatOpenAI({
      model: p.model,
      apiKey: p.apiKey,
      configuration: { baseURL: p.baseURL, defaultHeaders: p.headers },
      maxRetries: 0,
      maxTokens: p.maxTokens,
      temperature,
      timeout: 25_000,
      streamUsage: false, // not every OpenAI-compatible upstream accepts stream_options
      modelKwargs: p.extraBody,
    }),
  };
}

/** Providers not currently cooling down, in priority order. */
export async function availableModels(specs: ProviderSpec[], temperature?: number) {
  const cooling = await Promise.all(specs.map((s) => isCoolingDown(s.id).catch(() => false)));
  return specs.filter((_, i) => !cooling[i]).map((s) => toModel(s, temperature));
}

export function mockModel(answer: string): Candidate {
  return { id: "mock", label: "mock (no LLM keys)", model: new FakeListChatModel({ responses: [answer], sleep: 6 }) };
}

/** Puts a failing provider on cooldown so the next requests skip straight to a healthy one. */
export async function coolDown(id: string, err: unknown) {
  const e = err as { status?: number; headers?: Headers; retryAfterMs?: number; name?: string; message?: string };
  const retryAfter = Number(e.headers?.get?.("retry-after")) || (e.retryAfterMs ? e.retryAfterMs / 1000 : 0);
  let seconds = 60; // network errors, timeouts, 5xx
  if (e.status === 429 || e.name === "RateLimitCapacityError") {
    seconds = Math.min(Math.max(retryAfter || 300, 30), 6 * 3600);
  } else if (e.status === 401 || e.status === 403 || e.status === 404) {
    seconds = 3600; // misconfigured key or model — don't hammer it
  } else if (e.status === 400) {
    seconds = 600;
  }
  console.warn(`[agent] ${id} failed (${e.status ?? e.name ?? "error"}: ${e.message?.slice(0, 120)}) — cooling down ${seconds}s`);
  await setCooldown(id, seconds).catch(() => {});
}
