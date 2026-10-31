"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { OPEN_AGENT_EVENT, type OpenAgentDetail } from "./events";

// The panel (and its logic) only downloads the first time someone opens the agent.
const ChatPanel = dynamic(() => import("./ChatPanel").then((m) => m.ChatPanel), { ssr: false });

export type PendingQuestion = { text: string; id: number };

export function ChatLauncher() {
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingQuestion | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { question } = (e as CustomEvent<OpenAgentDetail>).detail ?? {};
      setLoaded(true);
      setOpen(true);
      if (question) setPending({ text: question, id: Date.now() });
    };
    window.addEventListener(OPEN_AGENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
  }, []);

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
          }}
          className="group fixed bottom-5 right-5 z-40 flex items-center gap-2.5 rounded-full border border-rule bg-ink py-3 pl-4 pr-5 text-sm text-paper shadow-[0_10px_40px_-12px_rgba(0,0,0,0.45)] transition-transform hover:-translate-y-0.5"
          aria-label="Open chat with Rishabh's AI agent"
        >
          <span className="pulse-dot inline-block size-2.5 rounded-full bg-accent" aria-hidden />
          Ask my agent
        </button>
      ) : null}
    </>
  );
}
