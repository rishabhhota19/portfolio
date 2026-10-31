// Shared between the chat widget and the API routes.
export type ChatRole = "user" | "assistant";

export type ChatMessage = { role: ChatRole; content: string };

export type EndReason = "closed_chat" | "left_site" | "tab_hidden" | "lead_submitted";

export type Lead = {
  name: string;
  email: string;
  company: string;
  role: string;
  note: string;
};

export type ChatRequest = {
  conversationId: string;
  messages: ChatMessage[];
  page: string;
};

export type EndRequest = {
  conversationId: string;
  token: string | null;
  startedAt: string;
  endedAt: string;
  reason: EndReason;
  page: string;
  messages: ChatMessage[];
};

export type LeadRequest = EndRequest & { lead: Lead };

export const LIMITS = {
  maxMessageChars: 500,
  maxHistory: 12, // messages sent to the model per turn
  maxSessionMessages: 30, // user messages per conversation
  maxLoggedMessages: 40,
  maxLoggedChars: 1000,
} as const;

export const CHAT_TOKEN_HEADER = "x-chat-token";
