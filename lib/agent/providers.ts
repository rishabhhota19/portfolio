import "server-only";

// Ordered list of free LLM endpoints. Every provider speaks the OpenAI Chat Completions format.
// When CF_ACCOUNT_ID + CF_GATEWAY_ID are set, Groq, Gemini and Workers AI are all routed through
// Cloudflare AI Gateway's /compat endpoint (logs, analytics, caching); otherwise each is called directly.
export type ProviderSpec = {
  id: string; // stable key used for cooldowns
  label: string; // shown in logs and the Google Sheet
  model: string;
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
  maxTokens: number;
};

const env = (name: string) => process.env[name]?.trim() || "";
const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

type Upstream = "groq" | "google-ai-studio" | "workers-ai";

const DIRECT_BASE: Record<Upstream, () => string> = {
  groq: () => "https://api.groq.com/openai/v1",
  "google-ai-studio": () => "https://generativelanguage.googleapis.com/v1beta/openai",
  "workers-ai": () => `https://api.cloudflare.com/client/v4/accounts/${env("CF_ACCOUNT_ID")}/ai/v1`,
};

function viaGateway() {
  return Boolean(env("CF_ACCOUNT_ID") && env("CF_GATEWAY_ID"));
}

function upstream(kind: Upstream, model: string, apiKey: string, maxTokens: number, extraBody?: Record<string, unknown>): ProviderSpec {
  const gateway = viaGateway();
  const headers: Record<string, string> = {};
  if (gateway) {
    if (env("CF_AIG_TOKEN")) headers["cf-aig-authorization"] = `Bearer ${env("CF_AIG_TOKEN")}`;
    headers["cf-aig-cache-ttl"] = "3600"; // identical requests (same question + history) served from cache
  }
  return {
    id: `${kind}:${model}`,
    label: `${kind}/${model}`,
    model: gateway ? `${kind}/${model}` : model,
    baseURL: gateway
      ? `https://gateway.ai.cloudflare.com/v1/${env("CF_ACCOUNT_ID")}/${env("CF_GATEWAY_ID")}/compat`
      : DIRECT_BASE[kind](),
    apiKey,
    headers,
    extraBody,
    maxTokens,
  };
}

function groq(model: string, maxTokens: number) {
  // gpt-oss models reason before answering; keep that short so answers stay fast and cheap.
  const extra = model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : undefined;
  return upstream("groq", model, env("GROQ_API_KEY"), model.startsWith("openai/gpt-oss") ? maxTokens + 400 : maxTokens, extra);
}

function gemini(maxTokens: number) {
  return upstream("google-ai-studio", env("GEMINI_MODEL") || "gemini-2.5-flash-lite", env("GOOGLE_GENERATIVE_AI_API_KEY"), maxTokens);
}

function workersAi(maxTokens: number) {
  return upstream("workers-ai", env("WORKERS_AI_MODEL") || "@cf/meta/llama-3.1-8b-instruct", env("CF_WORKERS_AI_TOKEN"), maxTokens);
}

function vercelGateway(maxTokens: number): ProviderSpec {
  const model = env("VERCEL_AI_GATEWAY_MODEL") || "google/gemini-2.5-flash-lite";
  return {
    id: `vercel:${model}`,
    label: `vercel-ai-gateway/${model}`,
    model,
    baseURL: "https://ai-gateway.vercel.sh/v1",
    apiKey: env("AI_GATEWAY_API_KEY"),
    headers: {},
    maxTokens,
  };
}

const groqPrimary = () => env("GROQ_PRIMARY_MODEL") || "openai/gpt-oss-120b";
const groqFallbacks = () => list(env("GROQ_FALLBACK_MODELS") || "llama-3.3-70b-versatile,llama-3.1-8b-instant");

function usable(p: ProviderSpec) {
  if (!p.apiKey) return false;
  if (p.id.startsWith("workers-ai") && !env("CF_ACCOUNT_ID")) return false;
  return true;
}

/** Best quality first: answers recruiters see. */
export function chatProviders(maxTokens = 450): ProviderSpec[] {
  return [
    groq(groqPrimary(), maxTokens),
    gemini(maxTokens),
    ...groqFallbacks().map((m) => groq(m, maxTokens)),
    workersAi(maxTokens),
    vercelGateway(maxTokens),
  ].filter(usable);
}

/** Cheapest first: background summaries for the Google Sheet, saving the best quota for chat. */
export function summaryProviders(maxTokens = 400): ProviderSpec[] {
  const fallbacks = groqFallbacks();
  const small = fallbacks[fallbacks.length - 1];
  return [
    ...(small ? [groq(small, maxTokens)] : []),
    gemini(maxTokens),
    workersAi(maxTokens),
    groq(groqPrimary(), maxTokens),
    vercelGateway(maxTokens),
  ].filter(usable);
}

/** Local development without any API keys (or LLM_MOCK=1) uses a scripted fake model. */
export function shouldMock() {
  if (env("LLM_MOCK") === "1") return true;
  return process.env.NODE_ENV !== "production" && chatProviders().length === 0;
}

/** Comma-separated provider ids (or prefixes like "groq") to fail on purpose — for testing fallbacks. */
export function forcedFailure(id: string) {
  const forced = list(env("FORCE_FAIL"));
  return forced.some((f) => id === f || id.startsWith(`${f}:`));
}
