"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const getTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light");
  const next = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {}
      }}
      className="label rounded-full border border-rule px-2.5 py-1.5 transition-colors hover:border-accent hover:text-accent"
      aria-label={`Switch to ${next} mode`}
      title={next === "dark" ? "Lightbox mode" : "Journal mode"}
    >
      <span suppressHydrationWarning>{theme === "dark" ? "Journal" : "Lightbox"}</span>
    </button>
  );
}
