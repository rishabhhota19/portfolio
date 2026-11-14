// Shared between the chat widget and the API routes.
export type ChatRole = "user" | "assistant";

export type ChatMessage = { role: ChatRole; content: string; starter?: boolean }; // starter: a quick answer the panel showed itself

export type EndReason = "closed_chat" | "left_site" | "tab_hidden" | "lead_submitted";

export type Lead = {
  name: string;
  email: string;
  company: string;
  role: string;
  phone: string; // optional — only if the visitor chooses to share it
  note: string;
};

export type ChatRequest = {
  sessionId: string; // the visit (one browser tab on the site) — token totals add up per visit
  conversationId: string;
  messages: ChatMessage[];
  page: string;
};

export type EndRequest = {
  sessionId: string;
  conversationId: string;
  token: string | null;
  startedAt: string;
  endedAt: string;
  reason: EndReason;
  page: string;
  count: number; // messages in the whole chat: the list below is cut to fit, so its length stops growing in a long chat
  messages: ChatMessage[];
};

export type LeadRequest = EndRequest & { lead: Lead };

/** What the browser reports about a visit (no personal data: the server adds location and network). */
export type VisitRequest = {
  sessionId: string;
  startedAt: string;
  activeSeconds: number; // time the tab was actually visible
  pages: string[];
  actions: string[]; // e.g. resume_download, linkedin_click, chat_open
  referrer: string;
  utm: string;
  screen: string;
  language: string;
  timezone: string;
};

export const LIMITS = {
  // A visitor's message. It was 500, which cut a pasted job description, the most useful thing a recruiter sends,
  // part-way through and without a word. 2,500 holds a full posting (about 600 tokens); the chat shows a counter
  // near the limit and says so when a paste was cut.
  maxMessageChars: 2500,
  maxAnswerChars: 3000, // an answer as sent back as history (the longest real answer is ~600 tokens)
  maxHistory: 12, // messages sent to the model per turn
  maxHistoryChars: 20_000, // all of them together
  maxSessionMessages: 30, // user messages per conversation
  maxLoggedMessages: 40,
  maxLoggedChars: 1000,
  maxLoggedTotalChars: 16_000,
} as const;

/** The first `max` characters of `text`, never ending on the first half of an emoji or other two-unit character. A
 * plain slice can leave one: the agent then rejects the string as broken, the chat reports a rest, and every later
 * question fails too, because that message rides along in the history. */
export function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The newest messages whose combined length fits `maxChars` (the oldest are dropped first). */
export function newestWithin<T extends { content: string }>(list: T[], maxChars: number): T[] {
  let total = 0;
  let start = list.length;
  while (start > 0 && total + list[start - 1].content.length <= maxChars) total += list[--start].content.length;
  return list.slice(start);
}

export const CHAT_TOKEN_HEADER = "x-chat-token";
