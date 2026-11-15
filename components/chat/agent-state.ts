"use client";

import { useSyncExternalStore } from "react";

// Whether Dumbledore is on screen is written on <html data-agent="open"> (components/chat/ChatLauncher.tsx), so the
// stylesheet can move the site aside (app/globals.css) and any component can read it without sharing React state.
function subscribeAgent(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-agent"] });
  return () => observer.disconnect();
}

export function useAgentOpen() {
  return useSyncExternalStore(subscribeAgent, () => document.documentElement.dataset.agent === "open", () => false);
}

// A screen wide enough for the agent and the site side by side (the stylesheet's 64rem, the same number).
const WIDE = "(min-width: 64rem)";
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useWideScreen() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
}

/** True where the agent covers the whole screen (phones and tablets), so it must step aside to show a page. */
export const agentCoversPage = () => !window.matchMedia(WIDE).matches;
