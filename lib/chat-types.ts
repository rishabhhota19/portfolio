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
  maxMessageChars: 500,
  maxAnswerChars: 3000, // an answer as sent back as history (the longest real answer is ~600 tokens)
  maxHistory: 12, // messages sent to the model per turn
  maxHistoryChars: 20_000, // all of them together
  maxSessionMessages: 30, // user messages per conversation
  maxLoggedMessages: 40,
  maxLoggedChars: 1000,
  maxLoggedTotalChars: 16_000,
} as const;

/** The newest messages whose combined length fits `maxChars` (the oldest are dropped first). */
export function newestWithin<T extends { content: string }>(list: T[], maxChars: number): T[] {
  let total = 0;
  let start = list.length;
  while (start > 0 && total + list[start - 1].content.length <= maxChars) total += list[--start].content.length;
  return list.slice(start);
}

export const CHAT_TOKEN_HEADER = "x-chat-token";
