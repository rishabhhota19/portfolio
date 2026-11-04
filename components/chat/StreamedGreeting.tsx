"use client";

import { useEffect, useRef, useState } from "react";

const GREETING =
  "Hello! I'm Dumbledore, Rishabh's AI agent. Ask me about his projects, research or experience — I answer from his real work and say so when I don't know. I can also take you to any page: try “take me to his projects”.";
const WORDS = GREETING.split(" ");
const WORD_MS = 32; // about 1.3 s in all: as quick as a fast model, and it never waits on one (no call, no tokens)

/** Dumbledore's first message, arriving word by word like his answers, whenever a chat starts. It runs only while
 * the panel is open, and all at once for visitors who ask for reduced motion. Screen readers get the whole sentence. */
export function StreamedGreeting({ active, onDone }: { active: boolean; onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const position = useRef(0);
  const done = useRef(onDone);

  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!active || position.current >= WORDS.length) return;
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setInterval(
      () => {
        position.current = instant ? WORDS.length : position.current + 1;
        setShown(position.current);
        if (position.current >= WORDS.length) {
          window.clearInterval(timer);
          done.current();
        }
      },
      instant ? 0 : WORD_MS,
    );
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <>
      <span className="sr-only">{GREETING}</span>
      <span aria-hidden>
        {WORDS.slice(0, shown).join(" ")}
        {shown < WORDS.length ? <span className="caret">▍</span> : null}
      </span>
    </>
  );
}
