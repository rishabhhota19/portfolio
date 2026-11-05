"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { track } from "@/lib/analytics";
import { sessionId } from "@/lib/visit";
import site from "@/content/site.json";
import starters from "@/content/starters.json";
import {
  CHAT_TOKEN_HEADER,
  LIMITS,
  newestWithin,
  type ChatMessage,
  type EndReason,
  type EndRequest,
  type Lead,
  type LeadRequest,
} from "@/lib/chat-types";
import type { PendingQuestion } from "./ChatLauncher";
import { LeadForm } from "./LeadForm";
import { Markdown } from "./Markdown";
import { StreamedGreeting } from "./StreamedGreeting";

type PageLink = { path: string; label: string };
// retry: the question a failed turn can send again (shown as "Try again" on the last message)
type UiMessage = ChatMessage & { id: string; kind?: "starter" | "notice"; links?: PageLink[]; opened?: string; retry?: string };
type Status = "idle" | "waiting" | "streaming" | "offline";

// A command about where the visitor already is, with no page named (agent/pages.py MOVES).
type UiMove = "back" | "next" | "previous" | "top" | "bottom" | "down" | "up" | "written";

// "next" and "previous" walk the pages in the order the header shows them, from Home.
const PAGE_ORDER = site.sections.filter((s) => s.path === "/" || ("nav" in s && s.nav)).map((s) => s.path);

// What the agent streams (one JSON object per line) — see api/index.py.
type AgentEvent =
  | { type: "text" | "replace"; text: string }
  | { type: "navigate"; path: string; label: string; focus?: boolean }
  | { type: "ui"; move: UiMove }
  | { type: "links"; links: PageLink[] }
  | { type: "usage"; tokens: number };

// Only this site's own pages: the agent can't send anyone elsewhere, and router.push never sees a javascript: URL.
const SITE_PATH = /^\/(?!\/)[a-z0-9\-/]*(#[a-z0-9\-]+)?$/i;

type Props = {
  open: boolean;
  onMinimize: () => void;
  pendingQuestion: PendingQuestion | null;
  onPendingHandled: () => void;
  /** Inside the 3D page (components/chat/EmbeddedAgent.tsx): the panel fills its frame, and instead of changing this
   * page it tells the page that hosts it where Dumbledore wants to go. */
  embedded?: boolean;
  /** The page the visitor is really on, when this chat is embedded in it (logged with each turn, never shown). */
  pagePath?: string;
};

/** What the embedded chat tells the page that hosts it (same origin only). */
export type EmbeddedChatMessage =
  | { source: "dumbledore"; type: "navigate"; path: string; focus?: boolean }
  | { source: "dumbledore"; type: "ui"; move: UiMove }
  | { source: "dumbledore"; type: "minimize" }
  | { source: "dumbledore"; type: "ready" };

export function tellHost(message: EmbeddedChatMessage) {
  if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
}

const newId = () => crypto.randomUUID();

// Temporary memory: everything below lives in React state only — no localStorage, no server copy.
// Closing the chat (×) or leaving the site wipes it; only a summary is logged via /api/chat/end.
export function ChatPanel({ open, onMinimize, pendingQuestion, onPendingHandled, embedded = false, pagePath }: Props) {
  const router = useRouter();
  const currentPage = () => pagePath ?? window.location.pathname;
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState("");
  const [showLead, setShowLead] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  const [tokens, setTokens] = useState(0); // tokens this chat counted against the free limits (cached prompt tokens are free)
  const [announce, setAnnounce] = useState(""); // what a screen reader hears: each finished answer once, not every streamed line
  const [chatRun, setChatRun] = useState(0); // counts chats in this tab, so each new one streams the greeting again
  const [greeted, setGreeted] = useState(false);

  const conversation = useRef<{ id: string; startedAt: string } | null>(null);
  const token = useRef<string | null>(null);
  const loggedCount = useRef(0);
  const messagesRef = useRef<UiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // A conversation starts with its first message, not when the panel opens.
  const currentConversation = () => {
    conversation.current ??= { id: newId(), startedAt: new Date().toISOString() };
    return conversation.current;
  };

  const transcript = (list: UiMessage[]): ChatMessage[] =>
    list
      .filter((m) => m.kind !== "notice" && m.content.trim())
      .map(({ role, content, kind }) => ({
        role,
        content: content.slice(0, role === "user" ? LIMITS.maxMessageChars : LIMITS.maxAnswerChars),
        ...(kind === "starter" ? { starter: true } : {}),
      }));

  const endPayload = useCallback((reason: EndReason): EndRequest => {
    const convo = currentConversation();
    return {
      sessionId: sessionId(),
      conversationId: convo.id,
      token: token.current,
      startedAt: convo.startedAt,
      endedAt: new Date().toISOString(),
      reason,
      page: currentPage(),
      messages: newestWithin(
        transcript(messagesRef.current)
          .slice(-LIMITS.maxLoggedMessages)
          .map((m) => ({ ...m, content: m.content.slice(0, LIMITS.maxLoggedChars) })),
        LIMITS.maxLoggedTotalChars,
      ),
    };
  }, []);

  // Sends the transcript for summarising. keepalive lets it finish while the page unloads.
  const logEnd = useCallback(
    (reason: EndReason) => {
      const count = transcript(messagesRef.current).length;
      if (count === 0 || count === loggedCount.current) return;
      loggedCount.current = count;
      try {
        fetch("/api/chat/end", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(endPayload(reason)),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    },
    [endPayload],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") logEnd("tab_hidden");
    };
    const onPageHide = () => logEnd("left_site");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [logEnd]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, showLead]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const append = (m: Omit<UiMessage, "id">) => {
    const msg = { ...m, id: newId() };
    setMessages((prev) => [...prev, msg]);
    return msg.id;
  };

  const updateMessage = (id: string, patch: Partial<UiMessage>) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // A 503 (budget spent, agent restarting, every model paused) rests the chat for a moment, not until End chat:
  // the input comes back on its own, and the failed turn offers "Try again" meanwhile.
  const rest = (seconds: number) => {
    if (restTimer.current) clearTimeout(restTimer.current);
    setStatus("offline");
    restTimer.current = setTimeout(() => {
      restTimer.current = null;
      setStatus("idle");
    }, seconds * 1000);
  };
  const wake = () => {
    if (restTimer.current) clearTimeout(restTimer.current);
    restTimer.current = null;
  };
  useEffect(() => wake, []);

  // Dumbledore taking the visitor somewhere. The chat lives in the layout, so it survives the navigation.
  // Embedded in the 3D page, the page that hosts the chat does the travelling (it warps to the matching chamber).
  const goTo = useCallback(
    (path: string, source: "agent" | "button", focus = true) => {
      if (!SITE_PATH.test(path)) return;
      track("agent_navigate", { path, source }); // our own page path, never visitor text
      if (embedded) return tellHost({ source: "dumbledore", type: "navigate", path, focus });
      if (path !== window.location.pathname) router.push(path);
      // Phones show the chat full-screen: step aside so the visitor sees the page they asked for.
      if (focus && window.matchMedia("(max-width: 639px)").matches) onMinimize();
    },
    [router, onMinimize, embedded],
  );

  // How many pages of this site the visitor has seen: "go back" must never send them off the site.
  const pathname = usePathname();
  const pagesSeen = useRef(0);
  useEffect(() => {
    pagesSeen.current += 1;
  }, [pathname]);

  // Dumbledore doing what was asked where the visitor already is. Embedded, the 3D page does it, in chambers.
  const moveUi = useCallback(
    (what: UiMove) => {
      track("agent_move", { what });
      if (embedded) return tellHost({ source: "dumbledore", type: "ui", move: what });
      if (what === "written") return goTo("/", "agent");
      if (what === "next" || what === "previous") {
        const at = PAGE_ORDER.indexOf(`/${window.location.pathname.split("/")[1] ?? ""}`);
        const step = what === "next" ? 1 : -1;
        return goTo(PAGE_ORDER[(at + step + PAGE_ORDER.length) % PAGE_ORDER.length], "agent");
      }
      if (what === "back") {
        if (pagesSeen.current < 2) return goTo("/", "agent");
        router.back();
      } else {
        const page = window.innerHeight * 0.8;
        const top = what === "top" ? 0 : what === "bottom" ? document.documentElement.scrollHeight : window.scrollY + (what === "down" ? page : -page);
        window.scrollTo({ top, behavior: "smooth" });
      }
      if (window.matchMedia("(max-width: 639px)").matches) onMinimize(); // the chat covers a phone: step aside
    },
    [embedded, goTo, router, onMinimize],
  );

  const ask = useCallback(
    // retryOf: a failed reply's id — the same question goes again and that reply is reused, so nothing shows twice.
    async (raw: string, retryOf?: string) => {
      const text = raw.trim().slice(0, LIMITS.maxMessageChars);
      if (!text || status === "waiting" || status === "streaming") return;

      const userCount = messagesRef.current.filter((m) => m.role === "user").length;
      if (!retryOf && userCount >= LIMITS.maxSessionMessages) {
        append({ role: "assistant", kind: "notice", content: "That's the limit for one chat. Leave your details and Rishabh will pick it up from here." });
        setShowLead(true);
        return;
      }

      // On a retry the question is already the last message in the transcript.
      const asked = retryOf ? transcript(messagesRef.current) : [...transcript(messagesRef.current), { role: "user" as const, content: text }];
      const history = newestWithin(asked.slice(-LIMITS.maxHistory), LIMITS.maxHistoryChars);
      if (retryOf) {
        track("chat_retry");
        updateMessage(retryOf, { kind: undefined, content: "", retry: undefined });
      } else {
        append({ role: "user", content: text });
        track("chat_question", { page: currentPage() }); // never the question text
      }
      setInput("");
      wake(); // a retry while resting: this answer decides the status now
      setStatus("waiting");
      const replyId = retryOf ?? append({ role: "assistant", content: "" });

      const controller = new AbortController();
      abortRef.current = controller;
      let full = ""; // the answer so far: a connection that drops part-way keeps it
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId(), conversationId: currentConversation().id, messages: history, page: currentPage() }),
          signal: controller.signal,
        });
        const issued = res.headers.get(CHAT_TOKEN_HEADER);
        if (issued) token.current = issued;

        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; retryAfter?: number };
          const paused = data.error === "offline";
          if (paused) {
            track("chat_paused");
            rest(Math.min(Math.max(Number(data.retryAfter) || 30, 10), 600)); // the route says how long; 30 s otherwise
          } else setStatus("idle");
          const message = data.message ?? "Something went wrong. Try again in a moment.";
          setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, kind: "notice", content: message, retry: paused ? text : undefined } : m)));
          setAnnounce(message);
          return;
        }

        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = ""; // a line that hasn't fully arrived yet
        let navigated = false; // this turn already took the visitor somewhere
        const handle = (line: string) => {
          if (!line.trim()) return;
          let event: AgentEvent;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "text") full += event.text;
          else if (event.type === "replace") full = event.text; // the output guard changed what was shown
          else if (event.type === "links") {
            // The pages the answer was about arrive after the answer. Dumbledore goes to the first one by itself, no
            // button to click (unless this turn navigated already); the others stay as "take me there" buttons.
            const [first, ...rest] = event.links.filter((l) => SITE_PATH.test(l.path));
            if (first && !navigated) {
              navigated = true;
              updateMessage(replyId, { opened: first.label, links: rest });
              goTo(first.path, "agent", false); // the answer stays in view; on a phone the visitor steps out to the page
            } else updateMessage(replyId, { links: [first, ...rest].filter(Boolean) });
          } else if (event.type === "usage") setTokens((t) => t + (Number(event.tokens) || 0));
          else if (event.type === "ui") {
            navigated = true;
            moveUi(event.move);
          } else if (event.type === "navigate" && SITE_PATH.test(event.path)) {
            navigated = true;
            updateMessage(replyId, { opened: event.label });
            goTo(event.path, "agent", event.focus);
          }
          updateMessage(replyId, { content: full });
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const lines = (pending + decoder.decode(value, { stream: true })).split("\n");
          pending = lines.pop() ?? "";
          lines.forEach(handle);
        }
        handle(pending);
        if (!full.trim()) updateMessage(replyId, { content: "I couldn't come up with an answer for that — try rephrasing?" });
        setAnnounce(full.replace(/[*_`]|\[([^\]]+)\]\([^)]*\)/g, "$1").trim() || "No answer came back; try rephrasing."); // plain words, no markdown
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          // Keep what arrived: a dropped connection shouldn't take the half answer with it.
          const content = full.trim() ? `${full}\n\n_The connection dropped before the end — try again?_` : "Connection hiccup. Please try again.";
          updateMessage(replyId, { content, retry: text });
          setAnnounce("The connection dropped. You can try again.");
        }
        setStatus("idle");
      } finally {
        abortRef.current = null;
      }
    },
    [status, goTo, moveUi],
  );

  // Questions from "Ask the agent" buttons elsewhere on the site. The id guard makes this
  // run once per click even when the effect re-runs (React dev double-invokes effects).
  const handledQuestion = useRef<number | null>(null);
  useEffect(() => {
    if (pendingQuestion && open && handledQuestion.current !== pendingQuestion.id) {
      handledQuestion.current = pendingQuestion.id;
      ask(pendingQuestion.text);
      onPendingHandled();
    }
  }, [pendingQuestion, open, ask, onPendingHandled]);

  const pickStarter = (q: string, a: string) => {
    track("chat_quick_answer", { question: q }); // our own canned question, not visitor text
    append({ role: "user", content: q, kind: "starter" });
    append({ role: "assistant", content: a, kind: "starter" });
  };

  const endChat = () => {
    track("chat_ended", { messages: messagesRef.current.length });
    abortRef.current?.abort();
    wake();
    logEnd("closed_chat");
    setMessages([]);
    setChatRun((n) => n + 1); // a new chat greets the visitor again
    setGreeted(false);
    setStatus("idle");
    setShowLead(false);
    setLeadSent(false);
    setInput("");
    setTokens(0);
    token.current = null;
    loggedCount.current = 0;
    conversation.current = null;
    onMinimize();
  };

  const submitLead = async (lead: Lead) => {
    const body: LeadRequest = { ...endPayload("lead_submitted"), lead };
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => null)) as { message?: string } | null;
        return said?.message ?? "Couldn't send that — please email rishabhhota19@gmail.com directly.";
      }
      loggedCount.current = transcript(messagesRef.current).length;
      setLeadSent(true);
      setShowLead(false);
      track("lead_submitted");
      append({
        role: "assistant",
        kind: "notice",
        content: `Thanks, ${lead.name.split(" ")[0] || "there"} — Rishabh has your details and will reach out at ${lead.email}.`,
      });
      return null;
    } catch {
      return "Couldn't send that — please email rishabhhota19@gmail.com directly.";
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  const busy = status === "waiting" || status === "streaming";
  const showStarters = greeted && (messages.length === 0 || status === "offline"); // they follow the greeting

  return (
    <section
      role="dialog"
      aria-label="Chat with Dumbledore, Rishabh's AI agent"
      aria-modal="false"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === "Escape") onMinimize();
      }}
      className={
        embedded
          ? "fixed inset-0 z-50 flex flex-col bg-paper" // the host page draws the frame
          : "fixed inset-0 z-50 flex flex-col bg-paper sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(660px,calc(100dvh-2.5rem))] sm:w-[410px] sm:rounded-sm sm:border sm:border-rule sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)]"
      }
    >
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-rule px-4 py-3">
        <span className="grid size-9 place-items-center rounded-full bg-ink font-serif text-lg text-paper" aria-hidden>
          D
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">
            Dumbledore <span className="font-normal text-muted">· Rishabh&apos;s AI agent</span>
          </p>
          <p className="label flex items-center gap-1.5 !text-[0.62rem]">
            <span
              className={`inline-block size-1.5 rounded-full ${status === "offline" ? "bg-muted" : "bg-accent pulse-dot"}`}
              aria-hidden
            />
            {status === "offline" ? "Resting a moment · quick answers below" : "Answers from his real work · takes you to any page"}
          </p>
        </div>
        <button type="button" onClick={onMinimize} className="label rounded px-2 py-1 hover:text-ink" aria-label="Minimize chat (keeps this conversation)" title="Minimize — keeps the chat while you browse">
          —
        </button>
        <button type="button" onClick={endChat} className="label rounded px-2 py-1 hover:text-accent" aria-label="End chat and delete this conversation" title="End chat — deletes this conversation">
          ✕
        </button>
      </header>

      {/* Messages. One hidden status line announces each finished answer; a live region on the list would re-read
          every streamed line. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <div className="max-w-[88%] rounded-sm border border-rule bg-surface px-3.5 py-2.5 text-[0.93rem] leading-relaxed">
          <StreamedGreeting key={chatRun} active={open} onDone={() => setGreeted(true)} />
        </div>

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-auto w-fit max-w-[85%] rounded-sm bg-ink px-3.5 py-2.5 text-[0.93rem] leading-relaxed text-paper">
              {m.content}
            </div>
          ) : (
            <div
              key={m.id}
              className={`max-w-[92%] text-[0.93rem] leading-relaxed [overflow-wrap:anywhere] ${
                m.kind === "notice" ? "rounded-sm border border-dashed border-rule px-3.5 py-2.5 text-muted" : "px-0.5"
              }`}
            >
              {m.content ? (
                <Markdown text={m.content} />
              ) : (
                <span className="label inline-flex items-center gap-2">
                  Retrieving from his work<span className="caret">▍</span>
                </span>
              )}
              {m.opened ? <p className="label mt-1 !text-[0.62rem]">↗ Opened {m.opened}</p> : null}
              {m.retry && m.id === messages[messages.length - 1]?.id ? (
                <button
                  type="button"
                  onClick={() => ask(m.retry ?? "", m.id)}
                  disabled={busy}
                  className="mt-2 rounded-full border border-accent/50 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent hover:text-paper disabled:opacity-40"
                >
                  Try again
                </button>
              ) : null}
              {m.links?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.links.map((l) => (
                    <button
                      key={l.path}
                      type="button"
                      onClick={() => goTo(l.path, "button")}
                      title={l.label}
                      className="max-w-full truncate rounded-full border border-accent/50 px-2.5 py-1 text-left text-xs text-accent transition-colors hover:bg-accent hover:text-paper"
                    >
                      Take me to {l.label} →
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}

        {showStarters ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {starters.map((s) => (
              <button
                key={s.q}
                type="button"
                onClick={() => pickStarter(s.q, s.a)}
                className="rounded-full border border-rule px-3 py-1.5 text-left text-xs transition-colors hover:border-accent hover:text-accent"
              >
                {s.q}
              </button>
            ))}
          </div>
        ) : null}

        {showLead ? <LeadForm onSubmit={submitLead} onCancel={() => setShowLead(false)} /> : null}
      </div>

      {/* Composer */}
      <div className="border-t border-rule px-3 pb-3 pt-2.5">
        <div className="mb-2 flex items-center justify-between gap-2 empty:hidden">
          {!leadSent && !showLead ? (
            <button
              type="button"
              onClick={() => setShowLead(true)}
              className="label rounded-full border border-rule px-2.5 py-1 !text-[0.64rem] transition-colors hover:border-accent hover:text-accent"
            >
              ✉ Share your details
            </button>
          ) : null}
          {tokens > 0 ? (
            <span
              className="label ml-auto !text-[0.62rem]"
              title="Tokens this chat counted against the AI models' free limits. Prompt tokens a model served from its cache are free and not included."
            >
              This chat · {tokens.toLocaleString("en-IN")} tokens of free quota
            </span>
          ) : null}
        </div>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <label htmlFor="agent-input" className="sr-only">
            Ask Dumbledore about Rishabh
          </label>
          <textarea
            id="agent-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, LIMITS.maxMessageChars))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder={status === "offline" ? "Dumbledore is resting a moment — try again shortly" : "Ask about his work, or “take me to…”"}
            disabled={status === "offline"}
            className="max-h-32 min-h-[2.6rem] flex-1 resize-none rounded-sm border border-rule bg-surface px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted placeholder-shown:overflow-hidden placeholder-shown:text-ellipsis placeholder-shown:whitespace-nowrap focus:border-accent disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim() || status === "offline"}
            className="h-[2.6rem] rounded-sm bg-ink px-4 text-sm text-paper transition-opacity disabled:opacity-40"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>
        <p className="mt-2 text-[0.68rem] leading-snug text-muted">
          This chat lives only in this tab; ending it or leaving the site deletes it. A short summary is kept so Rishabh can
          follow up.
        </p>
      </div>
    </section>
  );
}
