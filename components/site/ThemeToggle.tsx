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
  const label = theme === "dark" ? "Journal" : "Lightbox"; // the theme you'd switch to

  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {}
      }}
      className="label inline-flex items-center rounded-full border border-rule px-2.5 py-1.5 transition-colors hover:border-accent hover:text-accent"
      aria-label={`${label} theme (switch to ${next} mode)`}
      suppressHydrationWarning
    >
      {/* Phones have no room for the theme's name: a sun for the light theme, a moon for the dark one. */}
      <svg viewBox="0 0 16 16" className="size-3.5 sm:hidden" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" suppressHydrationWarning>
        {theme === "dark" ? (
          <path d="M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
        ) : (
          <path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" />
        )}
      </svg>
      <span className="hidden sm:inline" suppressHydrationWarning>
        {label}
      </span>
    </button>
  );
}
