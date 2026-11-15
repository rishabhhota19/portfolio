"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics";
import { warmAgent } from "@/lib/visit";
import { useEffect, useState } from "react";
import { OPEN_AGENT_EVENT, openAgent, type OpenAgentDetail } from "./events";

// The panel (and its logic) only downloads the first time someone opens the agent.
const ChatPanel = dynamic(() => import("./ChatPanel").then((m) => m.ChatPanel), { ssr: false });

export type PendingQuestion = { text: string; id: number };

export function ChatLauncher() {
  const pathname = usePathname();
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingQuestion | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { question, source } = (e as CustomEvent<OpenAgentDetail>).detail ?? {};
      setLoaded(true);
      setOpen(true);
      track("chat_open", { source: source ?? (question ? "suggested question" : "ask button") });
      if (question) setPending({ text: question, id: Date.now() });
    };
    window.addEventListener(OPEN_AGENT_EVENT, onOpen);
    // Arriving from the 3D page's "Ask Dumbledore" (/?chat=1): open the agent at once. The flag is taken off the
    // address so a reload, or the link shared on, doesn't open it again.
    if (new URLSearchParams(window.location.search).get("chat") === "1") {
      const url = new URL(window.location.href);
      url.searchParams.delete("chat");
      window.history.replaceState(null, "", url);
      openAgent(undefined, "into the agent");
    }
    return () => window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (open) warmAgent(); // someone who read for a while before opening the chat: wake the agent if it's been 3+ min
  }, [open]);

  if (pathname.startsWith("/admin")) return null; // the private dashboard has no visitor chat

  return (
    <>
      {loaded ? (
        <ChatPanel
          open={open}
          onMinimize={() => setOpen(false)}
          pendingQuestion={pending}
          onPendingHandled={() => setPending(null)}
        />
      ) : null}
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setLoaded(true);
            setOpen(true);
            track("chat_open", { source: "floating button" });
          }}
          className="group fixed bottom-4 right-4 z-40 flex items-center gap-2.5 rounded-full border border-accent/50 bg-paper/85 py-2.5 pl-3.5 pr-4 text-sm shadow-[var(--lift)] backdrop-blur-md transition-[transform,border-color] duration-500 hover:-translate-y-0.5 hover:border-accent sm:bottom-6 sm:right-6 sm:py-3 sm:pl-4 sm:pr-5"
          aria-label="Ask Dumbledore, my AI agent (opens a chat about Rishabh's work)"
        >
          <span className="pulse-dot inline-block size-2.5 rounded-full bg-accent" aria-hidden />
          {/* Phones: the short word, so the button never sits on top of a line of the page. */}
          <span className="sm:hidden">Ask</span>
          <span className="hidden sm:inline">Ask Dumbledore</span>
        </button>
      ) : null}
    </>
  );
}
