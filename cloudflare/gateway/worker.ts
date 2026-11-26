/**
 * The model gateway: Dumbledore's one door to the free models, an OpenAI-compatible API.
 *
 *   POST /v1/chat/completions   {"model": "dumbledore/<role>", "messages": [...], "stream"?, "tools"?, "max_tokens"?}
 *   GET  /v1/models             the roles
 *   GET  /health                "ok" (no key needed)
 *
 * The agent asks for a ROLE (writer-L1/L2/L3, planner, checker, summary), never a model. For each role the gateway
 * walks its pool, best first (routes.json, exported from agent/llm.py by `npm run gateway:routes`), and for each model:
 *   books its free budget (one Upstash call: paused? requests and tokens this minute and day, the provider's shared
 *   pool) → calls the provider → on an error or a broken contract, gives the budget back and tries the next model.
 * A 429 pauses that model for everyone (for as long as the provider says).
 *
 * Contracts, checked before the visitor sees a byte:
 *   - x-exclude-model: provider/model   not this one (a second opinion asks a different model).
 *   - x-only-model: <name>   this registry model alone (the contract eval measures each model on its own).
 *   - x-budget-share: 0.05–1   fill only this share of each model's free limits (CI sends 0.4: visitors keep the rest).
 *   - x-contract-first-line: <regex>   the reply's first line must match (the agent's action header). The stream is
 *     held until that line has arrived; a model that skips it is dropped for the next one.
 *   - tools in the request: a tool call written out as text instead of made is a broken reply, and the next model is
 *     asked. A stream with tools is held until its first line of text or its first real tool call arrives.
 *
 * CPU (free plan: 10 ms a request): the gateway parses the request once, reads the first line of a stream and the
 * chunk carrying the token count, and passes every other byte through untouched. Waiting on a model costs no CPU.
 */

import routes from "./routes.json";
import capabilities from "./capabilities.json";

type Model = {
  provider: string; model: string; rpm: number; rpd: number; tpm: number; tpd: number;
  context: number; neurons: number[]; reasoning: boolean; extra: Record<string, unknown>;
};
type Role = { max_tokens: number; effort: string; timeout: number; pool: string[] };
type Provider = { url: string; key: string; limits: { rpm?: number; rpd?: number; neurons_day?: number } };
type Routes = { providers: Record<string, Provider>; models: Record<string, Model>; roles: Record<string, Role> };
type Env = Record<string, string | undefined> & { GATEWAY_KEY?: string; UPSTASH_REDIS_REST_URL?: string; UPSTASH_REDIS_REST_TOKEN?: string };

const R = routes as unknown as Routes;
// What each model was measured to do (npm run gateway:contracts, evals/gateway_contract_eval.py): a model that failed
// to make a real tool call, or to write the reply's required first line, is not asked for that again. A model not
// measured yet is asked (the gateway still checks every reply itself).
const CAN = capabilities as unknown as Record<string, { tools?: boolean; first_line?: boolean }>;
const ROLE_PREFIX = "dumbledore/";
const REASONING_HEADROOM = 250; // hidden reasoning tokens on gpt-oss models (as llm.py)
const DAY = 90_000; // seconds a day counter lives (a little over a day: it is named by the UTC date anyway)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const error = (status: number, message: string) => json({ error: { message, type: "gateway" } }, status);

// ── the free budget, in Upstash Redis ──────────────────────────────────────────────────────────────────────────────
// One script books everything a call needs, or nothing: the model is not paused, and its requests and tokens this
// minute and day, and its provider's shared pool, all have room. Counters are named by minute / UTC day.
const BOOK = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'paused' end
local function over(key, limit, add) return tonumber(limit) > 0 and (tonumber(redis.call('GET', key) or '0') + tonumber(add)) > tonumber(limit) end
if over(KEYS[2], ARGV[1], 1) or over(KEYS[4], ARGV[3], ARGV[5]) or over(KEYS[6], ARGV[6], 1) then return 'minute' end
if over(KEYS[3], ARGV[2], 1) or over(KEYS[5], ARGV[4], ARGV[5]) or over(KEYS[7], ARGV[7], 1) or over(KEYS[8], ARGV[8], ARGV[9]) then return 'day' end
local function add(key, n, ttl) redis.call('INCRBY', key, n) redis.call('EXPIRE', key, ttl) end
add(KEYS[2], 1, 70) add(KEYS[3], 1, ${DAY}) add(KEYS[4], ARGV[5], 70) add(KEYS[5], ARGV[5], ${DAY})
add(KEYS[6], 1, 70) add(KEYS[7], 1, ${DAY}) add(KEYS[8], ARGV[9], ${DAY})
return 'ok'`;

type Booking = { keys: string[]; tokens: number; neurons: number } | null;

async function redis(env: Env, command: unknown[]): Promise<unknown> {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(command),
  });
  return res.ok ? ((await res.json()) as { result: unknown }).result : null;
}

async function book(env: Env, name: string, m: Model, tokens: number, maxOut: number, share = 1): Promise<{ ok: boolean; why: string; booking: Booking }> {
  const p = R.providers[m.provider].limits;
  // share < 1 (x-budget-share, sent by CI): this call may fill only that share of each limit. The counters are the
  // visitors' own, so CI stops at its share while visitors can still use all of it.
  const cap = (limit: number | undefined) => (limit ? Math.max(1, Math.floor(limit * share)) : 0);
  const minute = Math.floor(Date.now() / 60_000);
  const day = new Date().toISOString().slice(0, 10);
  const neurons = Math.round((tokens * (m.neurons[0] ?? 0) + maxOut * (m.neurons[1] ?? 0)) / 1e6);
  const keys = [
    `gw:paused:${name}`, `gw:rpm:${name}:${minute}`, `gw:rpd:${name}:${day}`, `gw:tpm:${name}:${minute}`, `gw:tpd:${name}:${day}`,
    `gw:prpm:${m.provider}:${minute}`, `gw:prpd:${m.provider}:${day}`, `gw:neurons:${m.provider}:${day}`,
  ];
  const args = [cap(m.rpm), cap(m.rpd), cap(m.tpm), cap(m.tpd), tokens, cap(p.rpm), cap(p.rpd), cap(p.neurons_day), neurons];
  const result = await redis(env, ["EVAL", BOOK, keys.length, ...keys, ...args]);
  if (result === null) return { ok: true, why: "unbooked", booking: null }; // no Redis (local dev): call, uncounted
  return { ok: result === "ok", why: String(result), booking: result === "ok" ? { keys, tokens, neurons } : null };
}

/** Corrects a booking to what was really used (after = 0: the call failed before answering, give it all back). */
async function settle(env: Env, b: Booking, tokensUsed: number | null, refund = false): Promise<void> {
  if (!b) return;
  const [, rpm, rpd, tpm, tpd, prpm, prpd, neurons] = b.keys;
  const commands: unknown[][] = [];
  if (refund) {
    for (const k of [rpm, rpd, prpm, prpd]) commands.push(["DECRBY", k, 1]);
    for (const k of [tpm, tpd]) commands.push(["DECRBY", k, b.tokens]);
    commands.push(["DECRBY", neurons, b.neurons]);
  } else if (tokensUsed !== null) {
    for (const k of [tpm, tpd]) commands.push(["INCRBY", k, tokensUsed - b.tokens]);
  }
  if (commands.length && env.UPSTASH_REDIS_REST_URL) {
    await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      body: JSON.stringify(commands),
    });
  }
}

async function pause(env: Env, name: string, seconds: number): Promise<void> {
  await redis(env, ["SET", `gw:paused:${name}`, "1", "EX", Math.max(1, Math.min(3600, Math.round(seconds)))]);
}

/** How long a failed call says to leave the model alone (0: just skip it for this request). */
function pauseFor(status: number, text: string, retryAfter: string | null): number {
  if (status === 429) {
    if (/per day|daily|perday/i.test(text)) return 3600;
    const wait = retryAfter ? Number(retryAfter) : NaN;
    return Number.isFinite(wait) ? wait + 1 : 60;
  }
  if (status === 401 || status === 403 || status === 404) return 300; // a key or model problem: every caller would fail
  return 0;
}

// ── contracts ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** A tool call written out as text instead of made: the reply names one of the request's own tools as a call. */
function toolCallAsText(content: string, tools: { function?: { name?: string } }[]): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/<\|?tool_call|<\|python_tag\|>|"tool_calls"\s*:/.test(text)) return true;
  return tools.some((t) => {
    const name = t.function?.name;
    if (!name) return false;
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*(${n}\\s*\\(|\\{\\s*"name"\\s*:\\s*"${n}")`).test(text);
  });
}

// ── one call ───────────────────────────────────────────────────────────────────────────────────────────────────────
type ChatRequest = {
  model: string; messages: unknown[]; stream?: boolean; tools?: { function?: { name?: string } }[];
  max_tokens?: number; [k: string]: unknown;
};

function upstreamBody(req: ChatRequest, m: Model, role: Role, stream: boolean): Record<string, unknown> {
  const { model: _role, ...rest } = req;
  const maxTokens = Math.min(req.max_tokens ?? role.max_tokens, role.max_tokens) + (m.reasoning ? REASONING_HEADROOM : 0);
  return {
    ...rest,
    ...m.extra,
    model: m.model,
    max_tokens: maxTokens,
    stream,
    ...(m.reasoning ? { reasoning_effort: role.effort } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function providerUrl(env: Env, provider: Provider): string {
  return provider.url.replace("{CF_ACCOUNT_ID}", env.CF_ACCOUNT_ID ?? "").replace(/\/$/, "") + "/chat/completions";
}

async function handle(req: ChatRequest, env: Env, ctx: ExecutionContext, contract: RegExp | null, exclude: string, only: string, share = 1): Promise<Response> {
  const roleName = req.model?.startsWith(ROLE_PREFIX) ? req.model.slice(ROLE_PREFIX.length) : "";
  const role = R.roles[roleName];
  if (!role) return error(400, `Unknown role "${req.model}". Ask for one of: ${Object.keys(R.roles).map((r) => ROLE_PREFIX + r).join(", ")}`);
  const tools = Array.isArray(req.tools) && req.tools.length ? req.tools : null;
  const stream = Boolean(req.stream);
  const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
  const tried: string[] = [];

  const pool = only ? (R.models[only] ? [only] : []) : role.pool; // only: the contract eval measures one model
  for (const name of pool) {
    const m = R.models[name];
    const provider = m && R.providers[m.provider];
    const key = provider && env[provider.key];
    if (!m || !provider || !key) continue; // no key for this provider here
    if (exclude && `${m.provider}/${m.model}` === exclude) continue; // a second opinion: a different model
    if (!only && tools && CAN[name]?.tools === false) continue; // measured: it does not make real tool calls
    if (!only && contract && CAN[name]?.first_line === false) continue; // measured: it skips the required first line
    if (promptTokens + role.max_tokens > m.context) continue; // the prompt would not fit this model
    const booked = await book(env, name, m, promptTokens + role.max_tokens, role.max_tokens, share);
    if (!booked.ok) continue;
    tried.push(name);
    const failed = async (why: string, pauseSeconds = 0) => {
      ctx.waitUntil(settle(env, booked.booking, null, true));
      if (pauseSeconds) ctx.waitUntil(pause(env, name, pauseSeconds));
      console.log(`[gateway] ${roleName} ${name}: ${why}`);
    };

    let res: Response;
    try {
      res = await fetch(providerUrl(env, provider), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(upstreamBody(req, m, role, stream)),
        signal: AbortSignal.timeout(role.timeout * 1000),
      });
    } catch (err) {
      await failed(`unreachable (${(err as Error).name})`);
      continue;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 400);
      await failed(`HTTP ${res.status}`, pauseFor(res.status, text, res.headers.get("retry-after")));
      continue;
    }
    const meta = { "x-dumbledore-model": `${m.provider}/${m.model}`, "x-dumbledore-tried": tried.join(","), "x-dumbledore-role": roleName };

    if (!stream) {
      const data = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: unknown[] } }[]; usage?: { total_tokens?: number } };
      const message = data.choices?.[0]?.message ?? {};
      const content = message.content ?? "";
      const called = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!called && !content.trim()) { await failed("empty reply"); continue; }
      if (tools && !called && toolCallAsText(content, tools)) { await failed("tool call written as text"); continue; }
      if (contract && !called && !contract.test(content.split("\n", 1)[0] ?? "")) { await failed("first line broke the contract"); continue; }
      ctx.waitUntil(settle(env, booked.booking, data.usage?.total_tokens ?? null));
      return json({ ...data, model: req.model }, 200, meta);
    }

    // A stream: hold it until the first line of content is in (and checked), then pass every byte through.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const held: Uint8Array[] = [];
    let text = "";
    let content = "";
    let calling = false; // a real tool call has started: there is no text to check
    let done = false;
    while (!calling && !content.includes("\n") && content.length < 400) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done || !chunk.value) { done = true; break; }
      held.push(chunk.value);
      text += decoder.decode(chunk.value, { stream: true });
      const lines = text.split("\n");
      text = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        // Most chunks before the first line are hidden reasoning (no text, no tool call): skip them unparsed. CPU is
        // the free plan's limit (10 ms), and parsing every reasoning chunk cost more than everything else together.
        if (!/"content"\s*:\s*"[^"]/.test(line) && !line.includes('"tool_calls"')) continue;
        try {
          const delta = (JSON.parse(line.slice(5)) as { choices?: { delta?: { content?: string; tool_calls?: unknown[] } }[] }).choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) calling = true;
        } catch { /* a partial or provider-specific line: not content */ }
      }
    }
    if (!calling && !content.trim() && done) { await failed("empty stream"); continue; }
    if (!calling && tools && toolCallAsText(content, tools)) {
      reader.cancel().catch(() => {});
      await failed("tool call written as text");
      continue;
    }
    if (!calling && contract && !contract.test(content.split("\n", 1)[0] ?? "")) {
      reader.cancel().catch(() => {});
      await failed("first line broke the contract");
      continue;
    }

    // Through: what was held, then the rest piped natively. A JavaScript loop over every chunk (reasoning models
    // send hundreds) was most of the CPU: median 11 ms against the free plan's 10 (27 Nov). Piped, the copy costs the
    // Worker no CPU; the price is that a stream's real token count is not read, so its booking stays at the estimate
    // made up front (prompt + max_tokens): it can only over-count, never overspend a free quota.
    const { readable, writable } = new IdentityTransformStream();
    ctx.waitUntil((async () => {
      const writer = writable.getWriter();
      for (const c of held) await writer.write(c);
      writer.releaseLock();
      reader.releaseLock();
      if (done) await writable.close();
      else await res.body!.pipeTo(writable).catch(() => { /* the provider broke off: the agent sees the stream end */ });
    })());
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...meta } });
  }
  return error(503, `Every model for ${roleName} is busy or out of free budget right now.${tried.length ? ` Tried: ${tried.join(", ")}` : ""}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const auth = request.headers.get("authorization") ?? "";
    if (!env.GATEWAY_KEY || auth !== `Bearer ${env.GATEWAY_KEY}`) return error(401, "unauthorized");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json({ object: "list", data: Object.keys(R.roles).map((r) => ({ id: ROLE_PREFIX + r, object: "model", owned_by: "dumbledore" })) });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") return error(404, "not found");
    let body: ChatRequest;
    try {
      body = (await request.json()) as ChatRequest;
    } catch {
      return error(400, "the body must be JSON");
    }
    const firstLine = request.headers.get("x-contract-first-line");
    let contract: RegExp | null = null;
    if (firstLine) {
      try { contract = new RegExp(firstLine); } catch { return error(400, "x-contract-first-line is not a valid regex"); }
    }
    const share = Math.min(1, Math.max(0.05, Number(request.headers.get("x-budget-share") ?? 1) || 1));
    return handle(body, env, ctx, contract, request.headers.get("x-exclude-model") ?? "", request.headers.get("x-only-model") ?? "", share);
  },
} satisfies ExportedHandler<Env>;
