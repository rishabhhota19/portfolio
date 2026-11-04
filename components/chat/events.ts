// Any page can open the agent (optionally with a question) without importing the chat bundle.
export const OPEN_AGENT_EVENT = "agent:open";

export type OpenAgentDetail = { question?: string; source?: string };

/** `source` names what opened the chat, for Umami; a suggested question or the ask button when left out. */
export function openAgent(question?: string, source?: string) {
  window.dispatchEvent(new CustomEvent<OpenAgentDetail>(OPEN_AGENT_EVENT, { detail: { question, source } }));
}
