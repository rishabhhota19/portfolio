"use client";

import { useEffect, useState } from "react";
import { ChatPanel, tellHost } from "./ChatPanel";
import type { PendingQuestion } from "./ChatLauncher";

/** What the page that hosts the chat may tell it (checked to come from this site's own origin). */
type HostMessage = { source: "into-the-agent"; type: "ask"; question?: string } | { source: "into-the-agent"; type: "page"; path: string };

/**
 * Dumbledore for the 3D page (/agent-embed, shown in an iframe at /3d): the same chat as everywhere else on the site,
 * so the bot check, the limits and the agent are untouched, filling a small window the 3D page draws. It tells that
 * page where Dumbledore wants to go (ChatPanel → tellHost) and the page warps there; the page tells it which chamber
 * the visitor is in, and may hand it a question to ask.
 */
export function EmbeddedAgent() {
  const [page, setPage] = useState("/3d");
  const [pending, setPending] = useState<PendingQuestion | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark"; // the descent is dark; the chat matches it
    const onMessage = (e: MessageEvent<HostMessage>) => {
      if (e.origin !== window.location.origin || e.data?.source !== "into-the-agent") return;
      if (e.data.type === "ask") setPending({ text: e.data.question ?? "", id: Date.now() });
      else if (e.data.type === "page" && /^\/[a-z0-9\-/#]*$/i.test(e.data.path)) setPage(e.data.path);
    };
    window.addEventListener("message", onMessage);
    tellHost({ source: "dumbledore", type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <ChatPanel
      embedded
      open
      pagePath={page}
      onMinimize={() => tellHost({ source: "dumbledore", type: "minimize" })}
      pendingQuestion={pending?.text ? pending : null}
      onPendingHandled={() => setPending(null)}
    />
  );
}
