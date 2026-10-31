import { CHAT_TOKEN_HEADER, LIMITS } from "@/lib/chat-types";
import { askAgent } from "@/lib/server/agent";
import { isBot } from "@/lib/server/bot";
import { ipHash, issueChatToken } from "@/lib/server/request";
import { allow, spendDailyBudget } from "@/lib/server/store";
import { chatRequest, json } from "@/lib/server/validate";

export const maxDuration = 60;

const DAILY_BUDGET = Number(process.env.DAILY_LLM_BUDGET ?? 1000);

const offline = (message: string) => json({ error: "offline", message }, 503);

/**
 * Security gateway for the chat. Checks bots, input, rate limits and the daily budget,
 * then streams the answer from the Python agent (api/index.py) straight through.
 */
export async function POST(req: Request) {
  if (await isBot()) return json({ error: "forbidden", message: "Automated traffic isn't allowed." }, 403);

  const parsed = chatRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That message couldn't be read." }, 400);
  const { conversationId, messages } = parsed.data;

  if (!(await allow(`chat:ip:${ipHash(req)}`, 20, 600))) {
    return json({ error: "rate_limited", message: "You're sending messages quickly — give it a minute and try again." }, 429);
  }
  if (!(await allow(`chat:conv:${conversationId}`, LIMITS.maxSessionMessages, 86_400))) {
    return json({ error: "rate_limited", message: "That's the limit for one chat. Leave your details and Rishabh will take it from here." }, 429);
  }
  if (!(await spendDailyBudget(DAILY_BUDGET))) {
    return offline("I'm taking a short break. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  const answer = await askAgent(req, conversationId, messages);
  if (!answer) {
    return offline("I'm taking a short break. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  return new Response(answer, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      [CHAT_TOKEN_HEADER]: issueChatToken(conversationId),
    },
  });
}
