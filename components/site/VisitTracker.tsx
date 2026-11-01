"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { addAction, addPage, ping, sendVisit, setVisible } from "@/lib/visit";

/** Records this visit's pages and clicks (the same data-umami-event links Umami counts), sends a presence ping
 * for the admin dashboard on each page change and every 30 s while visible, and reports the visit when the tab
 * is hidden or closed. Renders nothing. */
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
    const heartbeat = window.setInterval(ping, 30_000);
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(heartbeat);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
