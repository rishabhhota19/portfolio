"use client";

import type { ReactNode } from "react";
import { openAgent } from "./events";

type Props = {
  question?: string;
  className?: string;
  children: ReactNode;
  /** For a button whose visible text is cut down (the header's on phones shows only the dot). */
  "aria-label"?: string;
};

export function AskAgentButton({ question, className, children, "aria-label": ariaLabel }: Props) {
  return (
    <button type="button" className={className} aria-label={ariaLabel} onClick={() => openAgent(question)}>
      {children}
    </button>
  );
}
