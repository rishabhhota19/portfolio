"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics";
import { warmAgent } from "@/lib/visit";
import { useEffect, useState } from "react";
import { AgentTabs } from "./AgentTabs";
import { HIDE_AGENT_EVENT, OPEN_AGENT_EVENT, openAgent, type OpenAgentDetail } from "./events";

// The panel (and its logic) only downloads the first time someone opens the agent.
const ChatPanel = dynamic(() => import("./ChatPanel").then((m) => m.ChatPanel), { ssr: false });

export type PendingQuestion = { text: string; id: number };

/**
 * Where Dumbledore lives on the written site. There is no chat popup: opened (from the ask bar, or any "ask" button
 * on a page), he takes the left 40% of a wide screen and the site keeps the right 60%, both in use at once. Phones
 * and tablets have no room for that, so he covers the page and Agent · Site tabs switch between the two.
 */
export function ChatLauncher() {
  const pathname = usePathname();
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [inChat, setInChat] = useState(false); // a chat is under way (opened, not ended): the tabs stay on a phone
  const [pending, setPending] = useState<PendingQuestion | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { question, source } = (e as CustomEvent<OpenAgentDetail>).detail ?? {};
      setLoaded(true);
      setOpen(true);
      setInChat(true);
      track("chat_open", { source: source ?? (question ? "suggested question" : "ask button") });
      if (question) setPending({ text: question, id: Date.now() });
    };
    const onHide = () => setOpen(false);
    window.addEventListener(OPEN_AGENT_EVENT, onOpen);
    window.addEventListener(HIDE_AGENT_EVENT, onHide);
    // Arriving from the 3D page's "Ask Dumbledore" (/?chat=1): open the agent at once. The flag is taken off the
    // address so a reload, or the link shared on, doesn't open it again.
    if (new URLSearchParams(window.location.search).get("chat") === "1") {
      const url = new URL(window.location.href);
      url.searchParams.delete("chat");
      window.history.replaceState(null, "", url);
      openAgent(undefined, "into the agent");
    }
    return () => {
      window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
      window.removeEventListener(HIDE_AGENT_EVENT, onHide);
    };
  }, []);

  // The stylesheet moves the site aside while he is on screen, and the ask bar reads the same mark (agent-state.ts).
  const admin = pathname.startsWith("/admin"); // the private dashboard has no visitor chat
  const shown = open && !admin;
  useEffect(() => {
    if (shown) document.documentElement.dataset.agent = "open";
    else delete document.documentElement.dataset.agent;
    return () => {
      delete document.documentElement.dataset.agent;
    };
  }, [shown]);

  useEffect(() => {
    if (open) warmAgent(); // someone who read for a while before opening the chat: wake the agent if it's been 3+ min
  }, [open]);

  if (admin) return null;

  return (
    <>
      {loaded ? (
        <ChatPanel
          open={open}
          onMinimize={() => setOpen(false)}
          onEnd={() => setInChat(false)}
          pendingQuestion={pending}
          onPendingHandled={() => setPending(null)}
        />
      ) : null}
      {/* On a phone or tablet, with a chat under way and the site showing: the way back to it. */}
      {inChat && !open ? (
        <AgentTabs
          view="site"
          onPick={(view) => {
            if (view === "agent") openAgent(undefined, "agent tab");
          }}
          className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 shadow-[var(--lift)] vp-lg:hidden"
        />
      ) : null}
    </>
  );
}
