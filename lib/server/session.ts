import "server-only";
import type { ChatSummary } from "@/lib/server/agent";
import { firstTime, store } from "@/lib/server/store";

// What happened during a visit. A visitor can end a chat and start another, so each chat's summary is
// remembered for the visit (a day) and the Sessions row shows them all.

/** Is this point of the chat being logged for the first time? A transcript of a given length is logged once as a
 * pause (a tab switch: the plain summary) and once as an end (End chat, leaving the site, a lead: the model's
 * summary). Closing a tab sends both, the pause first, and the end must still get through: when one key covered both,
 * a chat that ended that way never got its summary and its working memory was never deleted. An end marks the pause
 * as well, so a tab switch after it can't put the plain summary back over the model's. */
export async function firstLog(conversationId: string, messages: number, pause: boolean) {
  const end = `end:${conversationId}:${messages}`;
  if (pause) return firstTime(`${end}:pause`, 86_400);
  const [first] = await Promise.all([firstTime(end, 86_400), firstTime(`${end}:pause`, 86_400)]);
  return first;
}

type ChatNote = { id: string; messages: number; intent: string; topics: string; summary: string; followUp: string };

export async function addChat(sessionId: string, conversationId: string, messages: number, s: ChatSummary) {
  const key = `chats:${sessionId}`;
  let chats: ChatNote[] = [];
  try {
    chats = JSON.parse((await store.get(key)) ?? "[]");
  } catch {} // a damaged note starts the visit's list again instead of failing every later chat
  const note = {
    id: conversationId,
    messages,
    intent: s.intent ?? "",
    topics: s.topics ?? "",
    summary: s.summary ?? "",
    followUp: s.followUp ?? "",
  };
  const i = chats.findIndex((c) => c.id === conversationId);
  if (i >= 0) chats[i] = note;
  else chats.push(note);
  await store.set(key, JSON.stringify(chats), 86_400);

  const latest = chats[chats.length - 1];
  const numbered = (pick: (c: ChatNote) => string) =>
    chats.length === 1 ? pick(latest) : chats.map((c, n) => `${n + 1}) ${pick(c)}`).join("\n");
  const topics = new Set(chats.flatMap((c) => String(c.topics ?? "").split(",").map((t) => t.trim()).filter(Boolean)));
  return {
    chats: chats.length,
    messages: chats.reduce((sum, c) => sum + c.messages, 0),
    intent: latest.intent,
    topics: [...topics].slice(0, 10).join(", "),
    summary: numbered((c) => c.summary),
    followUp: latest.followUp,
  };
}
