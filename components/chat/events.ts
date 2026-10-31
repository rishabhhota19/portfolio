// Any page can open the agent (optionally with a question) without importing the chat bundle.
export const OPEN_AGENT_EVENT = "agent:open";

export type OpenAgentDetail = { question?: string };

export function openAgent(question?: string) {
  window.dispatchEvent(new CustomEvent<OpenAgentDetail>(OPEN_AGENT_EVENT, { detail: { question } }));
}
