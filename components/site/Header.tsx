"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import site from "@/content/site.json";
import { useAgentOpen } from "@/components/chat/agent-state";
import { hideAgent, openAgent } from "@/components/chat/events";
import { ThemeToggle } from "./ThemeToggle";
import { BookCall, CubeIcon, SparkleIcon } from "./cta";

// One list of sections for the nav, the sitemap and the agent's navigation: content/site.json.
const links = site.sections.filter((s) => "nav" in s && s.nav).map((s) => ({ href: s.path, label: s.label }));
// The header has room for every link once the site's column is 64rem; from 48rem it shows these, the rest are in the
// hero and the footer (Writing) or a click away (Résumé is in the hero and the footer too).
const tablet = new Set(["/projects", "/publications", "/services", "/experience"]);

/**
 * The site's header, on every page: who (the RH mark and name), where (the sections and the 3D tour), and the two
 * calls to action, "Ask Dumbledore" and "Book a call". It sticks to the top, goes up out of the way while you read
 * down and comes back the moment you scroll up. On phones the sections and both buttons are in a full-screen menu.
 */
export function Header() {
  const pathname = usePathname();
  const agentOpen = useAgentOpen();
  const [menu, setMenu] = useState(false);
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const chat = !pathname.startsWith("/admin"); // the private dashboard has no visitor chat

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - last.current) < 6) return;
      setHidden(y > 120 && y > last.current);
      last.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    document.documentElement.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.style.overflow = "";
    };
  }, [menu]);

  const ask = () => {
    setMenu(false);
    if (agentOpen) hideAgent();
    else openAgent(undefined, "header");
  };

  return (
    <>
    <header
      data-hidden={hidden && !menu}
      className="site-header sticky top-0 z-30 border-b border-rule bg-paper/85 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-8 md:gap-4">
        <Link href="/" className="flex shrink-0 items-center gap-3" aria-label={`${site.name}, home`}>
          <span className="grid size-10 place-items-center rounded-xl bg-accent text-[0.95rem] font-bold text-accent-ink" aria-hidden>
            RH
          </span>
          <span className="font-serif text-xl leading-none md:hidden lg:inline">{site.name}</span>
        </Link>

        <nav aria-label="Main" className="mx-auto hidden md:block">
          <ul className="flex items-center gap-0.5 rounded-full border border-rule bg-surface/60 p-1">
            {links.map((l) => (
              <li key={l.href} className={tablet.has(l.href) ? "" : "hidden lg:block"}>
                <Link
                  href={l.href}
                  aria-current={isActive(l.href) ? "page" : undefined}
                  className={`block whitespace-nowrap rounded-full px-2.5 py-2 text-[0.9rem] transition-colors duration-300 ${
                    isActive(l.href) ? "bg-accent/15 text-accent" : "text-muted hover:text-ink"
                  }`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              {/* A plain link: /3d is the 3D site, served at this address by the rewrites in next.config.ts. */}
              <a
                href="/3d"
                data-umami-event="three_d_open"
                data-umami-event-from="header"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-2 text-[0.9rem] text-muted transition-colors duration-300 hover:text-ink"
              >
                <CubeIcon className="size-4 text-accent" />
                3D tour
                <span className="size-1.5 rounded-full bg-accent" aria-label="new" />
              </a>
            </li>
          </ul>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 md:ml-0 md:gap-2">
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          {chat ? (
            <button
              type="button"
              onClick={ask}
              aria-expanded={agentOpen}
              data-umami-event="ask_open"
              data-umami-event-from="header"
              className="btn-ghost !border-transparent !px-3 lg:!px-4"
              aria-label={agentOpen ? "Close Dumbledore" : "Ask Dumbledore, my AI agent"}
            >
              <SparkleIcon className="size-[1.15em]" />
              <span className="hidden lg:inline">{agentOpen ? "Close Dumbledore" : "Ask Dumbledore"}</span>
            </button>
          ) : null}
          <BookCall from="header" className="hidden !px-4 md:inline-flex" />
          <button
            type="button"
            className="grid size-11 place-items-center rounded-full border border-rule md:hidden"
            aria-expanded={menu}
            aria-controls="mobile-menu"
            aria-label={menu ? "Close menu" : "Open menu"}
            onClick={() => setMenu((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="size-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menu ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h10" />}
            </svg>
          </button>
        </div>
      </div>
    </header>

      {/* Outside the header: its blur and slide would otherwise pin this "fixed" layer inside the header bar. */}
      {menu ? (
        <div id="mobile-menu" className="fixed inset-x-0 bottom-0 top-[4.3rem] z-30 flex flex-col bg-paper md:hidden">
          <nav aria-label="Main" className="flex-1 overflow-y-auto px-6 py-4">
            <ul>
              {links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    onClick={() => setMenu(false)}
                    className={`block py-2.5 font-serif text-3xl ${isActive(l.href) ? "text-accent" : ""}`}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <a href="/3d" data-umami-event="three_d_open" data-umami-event-from="menu" className="flex items-center gap-3 py-2.5 font-serif text-3xl">
                  3D tour
                  <span className="rounded-full bg-accent px-2.5 py-0.5 font-sans text-xs font-bold text-accent-ink">New</span>
                </a>
              </li>
            </ul>
            <div className="mt-6 flex items-center gap-3 text-muted">
              <ThemeToggle />
              <span className="text-sm">Theme</span>
            </div>
          </nav>
          <div className="flex flex-col gap-2.5 border-t border-rule px-6 pb-8 pt-4">
            <BookCall from="menu" className="btn-lg w-full">Book a 15-min call</BookCall>
            {chat ? (
              <button type="button" onClick={ask} className="btn-ghost btn-lg w-full !border-accent !text-accent">
                <SparkleIcon />
                Ask Dumbledore
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
