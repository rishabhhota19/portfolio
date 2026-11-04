"use client";

import { usePathname } from "next/navigation";

/**
 * The way into "Into the Agent", the 3D descent: a button fixed to the top-left corner of every page, staying on
 * screen as the page scrolls. It's a plain link, not a client-side navigation: /3d isn't a page of this app but
 * the 3D site, served at this address by the rewrites in next.config.ts.
 */
export function ThreeDButton() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null; // the private dashboard keeps its corner

  return (
    <a
      href="/3d"
      data-umami-event="three_d_open"
      className="group fixed left-4 top-3.5 z-50 inline-flex items-center gap-2 rounded-full border border-rule bg-paper/85 p-2 text-sm shadow-[0_8px_30px_-14px_rgba(0,0,0,0.45)] backdrop-blur-[3px] transition-colors hover:border-accent hover:text-accent sm:left-6 sm:px-3 sm:py-2"
      aria-label="Into the Agent: the 3D version of this portfolio"
      title="Into the Agent: the 3D version"
    >
      <svg viewBox="0 0 16 16" className="size-4 transition-transform group-hover:-translate-y-px sm:size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Z" />
        <path d="M2 5l6 3.5L14 5M8 8.5v6" />
      </svg>
      <span className="label hidden !text-current sm:inline">3D</span>
    </a>
  );
}
