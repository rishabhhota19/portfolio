"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { addAction, addPage, sendVisit, setVisible } from "@/lib/visit";

/** Records this visit's pages and clicks (the same data-umami-event links Umami counts) and reports
 * the visit when the tab is hidden or closed. Renders nothing. */
export function VisitTracker() {
  const path = usePathname();

  useEffect(() => {
    addPage(path);
  }, [path]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const name = (e.target as Element | null)?.closest?.("[data-umami-event]")?.getAttribute("data-umami-event");
      if (name) addAction(name);
    };
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setVisible(visible);
      if (!visible) sendVisit();
    };
    const onPageHide = () => {
      setVisible(false);
      sendVisit();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
