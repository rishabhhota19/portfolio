"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { addAction, addPage, ping, sendVisit, setVisible } from "@/lib/visit";

const IDLE_MS = 3 * 60_000; // no scroll, key or pointer movement for this long: stop the presence pings

/** Records this visit's pages and clicks (the same data-umami-event links Umami counts), sends a presence ping
 * for the admin dashboard on each page change and every 30 s while visible and in use, and reports the visit when
 * the tab is hidden or closed. Renders nothing. */
export function VisitTracker() {
  const path = usePathname();

  useEffect(() => {
    if (path.startsWith("/admin")) return; // the owner checking the dashboard isn't a visitor
    addPage(path);
    ping();
  }, [path]);

  useEffect(() => {
    if (window.location.pathname.startsWith("/admin")) return;
    const onClick = (e: MouseEvent) => {
      const name = (e.target as Element | null)?.closest?.("[data-umami-event]")?.getAttribute("data-umami-event");
      if (name) addAction(name);
    };
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setVisible(visible);
      if (visible) ping();
      else sendVisit();
    };
    const onPageHide = () => {
      setVisible(false);
      sendVisit();
    };
    let lastInput = Date.now();
    const onInput = () => {
      const wasIdle = Date.now() - lastInput > IDLE_MS;
      lastInput = Date.now();
      if (wasIdle) ping(); // back after a pause: show up as live again straight away
    };
    const inputs = ["pointermove", "keydown", "scroll", "touchstart"] as const;
    const heartbeat = window.setInterval(() => Date.now() - lastInput < IDLE_MS && ping(), 30_000);
    for (const name of inputs) window.addEventListener(name, onInput, { passive: true });
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(heartbeat);
      for (const name of inputs) window.removeEventListener(name, onInput);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
