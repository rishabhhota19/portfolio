"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { track } from "@/lib/analytics";
import { sessionId } from "@/lib/visit";
import starters from "@/content/starters.json";
import {
  CHAT_TOKEN_HEADER,
  LIMITS,
  type ChatMessage,
  type EndReason,
  type EndRequest,
  type Lead,
  type LeadRequest,
} from "@/lib/chat-types";
import type { PendingQuestion } from "./ChatLauncher";
import { LeadForm } from "./LeadForm";
import { Markdown } from "./Markdown";

type PageLink = { path: string; label: string };
type UiMessage = ChatMessage & { id: string; kind?: "starter" | "notice"; links?: PageLink[]; opened?: string };
type Status = "idle" | "waiting" | "streaming" | "offline";

// What the agent streams (one JSON object per line) — see api/index.py.
type AgentEvent =
  | { type: "text" | "replace"; text: string }
  | { type: "navigate"; path: string; label: string; focus?: boolean }
  | { type: "links"; links: PageLink[] }
  | { type: "usage"; tokens: number };

// Only this site's own pages: the agent can't send anyone elsewhere, and router.push never sees a javascript: URL.
const SITE_PATH = /^\/(?!\/)[a-z0-9\-/]*(#[a-z0-9\-]+)?$/i;

type Props = {
  open: boolean;
  onMinimize: () => void;
  pendingQuestion: PendingQuestion | null;
  onPendingHandled: () => void;
};

const newId = () => crypto.randomUUID();

// Temporary memory: everything below lives in React state only — no localStorage, no server copy.
// Closing the chat (×) or leaving the site wipes it; only a summary is logged via /api/chat/end.
export function ChatPanel({ open, onMinimize, pendingQuestion, onPendingHandled }: Props) {
  const router = useRouter();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState("");
  const [showLead, setShowLead] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  const [tokens, setTokens] = useState(0); // real tokens this chat has used, as the AI providers count them

  const conversation = useRef<{ id: string; startedAt: string } | null>(null);
  const token = useRef<string | null>(null);
  const loggedCount = useRef(0);
  const messagesRef = useRef<UiMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
      .map(({ role, content }) => ({ role, content }));

  const endPayload = useCallback((reason: EndReason): EndRequest => {
    const convo = currentConversation();
    return {
      sessionId: sessionId(),
      conversationId: convo.id,
      token: token.current,
      startedAt: convo.startedAt,
      endedAt: new Date().toISOString(),
      reason,
      page: window.location.pathname,
      messages: transcript(messagesRef.current)
        .slice(-LIMITS.maxLoggedMessages)
        .map((m) => ({ ...m, content: m.content.slice(0, LIMITS.maxLoggedChars) })),
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

  // Dumbledore taking the visitor somewhere. The chat lives in the layout, so it survives the navigation.
  const goTo = useCallback(
    (path: string, source: "agent" | "button", focus = true) => {
      if (!SITE_PATH.test(path)) return;
      track("agent_navigate", { path, source }); // our own page path, never visitor text
      if (path !== window.location.pathname) router.push(path);
      // Phones show the chat full-screen: step aside so the visitor sees the page they asked for.
      if (focus && window.matchMedia("(max-width: 639px)").matches) onMinimize();
    },
    [router, onMinimize],
  );

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim().slice(0, LIMITS.maxMessageChars);
      if (!text || status === "waiting" || status === "streaming") return;

      const userCount = messagesRef.current.filter((m) => m.role === "user").length;
      if (userCount >= LIMITS.maxSessionMessages) {
        append({ role: "assistant", kind: "notice", content: "That's the limit for one chat. Leave your details and Rishabh will pick it up from here." });
        setShowLead(true);
        return;
      }

      const history = [...transcript(messagesRef.current), { role: "user" as const, content: text }].slice(-LIMITS.maxHistory);
      append({ role: "user", content: text });
      track("chat_question", { page: window.location.pathname }); // never the question text
      setInput("");
      setStatus("waiting");
      const replyId = append({ role: "assistant", content: "" });

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId(), conversationId: currentConversation().id, messages: history, page: window.location.pathname }),
          signal: controller.signal,
        });
        const issued = res.headers.get(CHAT_TOKEN_HEADER);
        if (issued) token.current = issued;

        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          if (data.error === "offline") {
            setStatus("offline");
            track("chat_paused");
          }
          else setStatus("idle");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId
                ? { ...m, kind: "notice", content: data.message ?? "Something went wrong. Try again in a moment." }
                : m,
            ),
          );
          return;
        }

        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        let pending = ""; // a line that hasn't fully arrived yet
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
          else if (event.type === "links") updateMessage(replyId, { links: event.links.filter((l) => SITE_PATH.test(l.path)) });
          else if (event.type === "usage") setTokens((t) => t + (Number(event.tokens) || 0));
          else if (event.type === "navigate" && SITE_PATH.test(event.path)) {
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
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          updateMessage(replyId, { content: "Connection hiccup. Please try again." });
        }
        setStatus("idle");
      } finally {
        abortRef.current = null;
      }
    },
    [status, goTo],
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
    logEnd("closed_chat");
    setMessages([]);
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
      if (!res.ok) return false;
      loggedCount.current = transcript(messagesRef.current).length;
      setLeadSent(true);
      setShowLead(false);
      track("lead_submitted");
      append({
        role: "assistant",
        kind: "notice",
        content: `Thanks, ${lead.name.split(" ")[0] || "there"} — Rishabh has your details and will reach out at ${lead.email}.`,
      });
      return true;
    } catch {
      return false;
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(input);
  };

  const busy = status === "waiting" || status === "streaming";
  const showStarters = messages.length === 0 || status === "offline";

  return (
    <section
      role="dialog"
      aria-label="Chat with Dumbledore, Rishabh's AI agent"
      aria-modal="false"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === "Escape") onMinimize();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-paper sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(660px,calc(100dvh-2.5rem))] sm:w-[410px] sm:rounded-sm sm:border sm:border-rule sm:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)]"
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
            {status === "offline" ? "Resting · quick answers below" : "Answers from his real work · takes you to any page"}
          </p>
        </div>
        <button type="button" onClick={onMinimize} className="label rounded px-2 py-1 hover:text-ink" aria-label="Minimize chat (keeps this conversation)" title="Minimize — keeps the chat while you browse">
          —
        </button>
        <button type="button" onClick={endChat} className="label rounded px-2 py-1 hover:text-accent" aria-label="End chat and delete this conversation" title="End chat — deletes this conversation">
          ✕
        </button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        <div className="max-w-[88%] rounded-sm border border-rule bg-surface px-3.5 py-2.5 text-[0.93rem] leading-relaxed">
          Hello! I&apos;m Dumbledore, Rishabh&apos;s AI agent. Ask me about his projects, research or experience — I answer
          from his real work and say so when I don&apos;t know. I can also take you to any page: try &ldquo;take me to his
          projects&rdquo;.
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
            <span className="label ml-auto !text-[0.62rem]" title="Tokens the AI models used for this chat (free tiers)">
              This chat · {tokens.toLocaleString("en-IN")} tokens
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
            placeholder={status === "offline" ? "Dumbledore is resting — try the quick answers" : "Ask about his work, or “take me to…”"}
            disabled={status === "offline"}
            className="max-h-32 min-h-[2.6rem] flex-1 resize-none rounded-sm border border-rule bg-surface px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent disabled:opacity-60"
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
