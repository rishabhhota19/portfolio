"use client";

import { usePathname } from "next/navigation";
import { useAgentOpen } from "@/components/chat/agent-state";
import { hideAgent, openAgent } from "@/components/chat/events";

/**
 * The strip that stays at the top of every page: "Don't scroll, ask the agent". One click opens Dumbledore beside
 * the site (wide screens) or over it (phones); while he is open the same strip puts him away. The way into the 3D
 * version sits at its left end: a plain link, not a client-side navigation, because /3d isn't a page of this app
 * but the 3D site, served at this address by the rewrites in next.config.ts.
 */
export function AskBar() {
  const pathname = usePathname();
  const open = useAgentOpen();
  if (pathname.startsWith("/admin")) return null; // the private dashboard has no visitor chat

  return (
    <div className="sticky top-0 z-30 border-b border-rule bg-paper/90 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:gap-3 sm:px-8">
        <a
          href="/3d"
          data-umami-event="three_d_open"
          className="group inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-rule px-3 text-sm transition-colors duration-500 hover:border-accent hover:text-accent"
          aria-label="Into the Agent: the 3D version of this portfolio"
          title="Into the Agent: the 3D version"
        >
          <svg viewBox="0 0 16 16" className="size-4 transition-transform duration-500 group-hover:-translate-y-px" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
            <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" />
            <path d="M2 5l6 3.5L14 5M8 8.5v6" />
          </svg>
          <span className="label !text-current">3D</span>
        </a>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => (open ? hideAgent() : openAgent(undefined, "ask bar"))}
          className="group flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-accent/45 pl-4 pr-1 text-left text-sm transition-colors duration-500 hover:border-accent"
        >
          <span className="pulse-dot inline-block size-2 shrink-0 rounded-full bg-accent" aria-hidden />
          {open ? (
            <span className="min-w-0 flex-1 truncate text-muted">Dumbledore is open beside the page.</span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              Don&apos;t scroll.{" "}
              <span className="text-muted">
                <span className="sm:hidden">Ask my agent.</span>
                <span className="hidden sm:inline">Ask Dumbledore, my AI agent, anything about Rishabh.</span>
              </span>
            </span>
          )}
          <span className="grid h-8 shrink-0 place-items-center rounded-full bg-accent px-3 text-accent-ink transition-transform duration-500 group-hover:translate-x-0.5">
            {open ? "Hide" : <span aria-hidden>→</span>}
          </span>
        </button>
      </div>
    </div>
  );
}
