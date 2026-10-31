"use client";

import type { ReactNode } from "react";
import { openAgent } from "./events";

type Props = {
  question?: string;
  className?: string;
  children: ReactNode;
};

export function AskAgentButton({ question, className, children }: Props) {
  return (
    <button type="button" className={className} onClick={() => openAgent(question)}>
      {children}
    </button>
  );
}
