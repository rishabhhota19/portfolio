import { AIMessage, AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { agent } from "@/lib/agent/graph";
import { CHAT_TOKEN_HEADER, LIMITS } from "@/lib/chat-types";
import { isBot } from "@/lib/server/bot";
import { ipHash, issueChatToken } from "@/lib/server/request";
import { allow, spendDailyBudget } from "@/lib/server/store";
import { chatRequest, json } from "@/lib/server/validate";

export const maxDuration = 60;

const DAILY_BUDGET = Number(process.env.DAILY_LLM_BUDGET ?? 1000);

const offline = (message: string) => json({ error: "offline", message }, 503);

export async function POST(req: Request) {
  if (await isBot()) return json({ error: "forbidden", message: "Automated traffic isn't allowed." }, 403);

  const parsed = chatRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That message couldn't be read." }, 400);
  const { conversationId, messages } = parsed.data;

  const ip = ipHash(req);
  if (!(await allow(`chat:ip:${ip}`, 20, 600))) {
    return json({ error: "rate_limited", message: "You're sending messages quickly — give it a minute and try again." }, 429);
  }
  if (!(await allow(`chat:conv:${conversationId}`, LIMITS.maxSessionMessages, 86_400))) {
    return json({ error: "rate_limited", message: "That's the limit for one chat. Leave your details and Rishabh will take it from here." }, 429);
  }
  if (!(await spendDailyBudget(DAILY_BUDGET))) {
    return offline("I've hit today's free limit. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  const history = messages.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)));
  const stream = await agent.stream({ messages: history }, { streamMode: "messages", signal: req.signal });
  const iterator = stream[Symbol.asyncIterator]();

  const nextText = async (): Promise<string | null> => {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return null;
      const [message, meta] = step.value;
      if (meta?.langgraph_node === "respond" && AIMessageChunk.isInstance(message) && message.text) return message.text;
    }
  };

  // Wait for the first token before committing to a 200, so "every provider failed" can
  // still be answered with the offline response instead of an empty stream.
  let first: string | null;
  try {
    first = await nextText();
  } catch (err) {
    console.error("[chat] agent failed:", err);
    first = null;
  }
  if (first === null) {
    return offline("I'm taking a short break. The quick answers below still work — or share your details and Rishabh will reply.");
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
    },
    async pull(controller) {
      try {
        const text = await nextText();
        if (text === null) controller.close();
        else controller.enqueue(encoder.encode(text));
      } catch (err) {
        console.error("[chat] stream error:", err);
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      [CHAT_TOKEN_HEADER]: issueChatToken(conversationId),
    },
  });
}
