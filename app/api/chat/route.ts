import { after } from "next/server";
import { CHAT_TOKEN_HEADER, LIMITS } from "@/lib/chat-types";
import { askAgent, splitMeta } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import * as events from "@/lib/server/events";
import { ipHash, issueChatToken } from "@/lib/server/request";
import { allow, envNumber, refundDailyBudget, spendDailyBudget } from "@/lib/server/store";
import { chatRequest, json } from "@/lib/server/validate";

export const maxDuration = 60;

const DAILY_BUDGET = envNumber("DAILY_LLM_BUDGET", 3000);

const offline = (message: string) => json({ error: "offline", message }, 503);

/**
 * Security gateway for the chat. Checks bots, input, rate limits and the daily budget,
 * then streams the answer from the Python agent (api/index.py) straight through — minus its admin-only "meta"
 * line, which goes to the admin dashboard once the answer is done.
 */
export async function POST(req: Request) {
  if (await isBot()) return json({ error: "forbidden", message: "Automated traffic isn't allowed." }, 403);

  const parsed = chatRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That message couldn't be read." }, 400);
  const { conversationId, messages } = parsed.data;
  const sessionId = parsed.data.sessionId ?? conversationId; // older tabs don't send a visit id yet

  // Per visitor first; the per-network limit is looser because colleagues in one office share an IP.
  if (!(await allow(`chat:visit:${sessionId}`, 20, 600)) || !(await allow(`chat:ip:${ipHash(req)}`, 60, 600))) {
    return json({ error: "rate_limited", message: "You're sending messages quickly — give it a minute and try again." }, 429);
  }
  if (!(await allow(`chat:conv:${conversationId}`, LIMITS.maxSessionMessages, 86_400))) {
    return json({ error: "rate_limited", message: "That's the limit for one chat. Leave your details and Rishabh will take it from here." }, 429);
  }
  if (!(await spendDailyBudget(DAILY_BUDGET))) {
    return offline("I'm taking a short break. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  const answer = await askAgent(req, conversationId, sessionId, messages);
  if (!answer) {
    await refundDailyBudget();
    return offline("I'm taking a short break. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  const { stream, meta } = splitMeta(answer, req.signal);
  after(async () => {
    const m = await meta;
    if (!m || !(m.tokens_in + m.tokens_out)) await refundDailyBudget(); // greeting, cache, refusal, page jump: no model
    if (m) await events.turn({ ...m, sessionId, page: parsed.data.page });
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8", // agent events, one JSON object per line
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      [CHAT_TOKEN_HEADER]: issueChatToken(conversationId),
    },
  });
}
