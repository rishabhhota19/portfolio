"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/projects", label: "Projects" },
  { href: "/publications", label: "Research" },
  { href: "/experience", label: "Experience" },
  { href: "/blog", label: "Writing" },
  { href: "/resume", label: "Résumé" },
];

export function NavLinks() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav aria-label="Main" className="order-last md:order-none md:ml-auto">
      <ul className="hidden items-center gap-6 md:flex">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className={`label link-underline pb-0.5 transition-colors hover:text-ink ${isActive(l.href) ? "text-ink" : ""}`}
              aria-current={isActive(l.href) ? "page" : undefined}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="label rounded border border-rule px-2.5 py-1.5 md:hidden"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <ul
          id="mobile-nav"
          className="absolute inset-x-0 top-full z-30 flex flex-col border-b border-rule bg-paper px-5 py-3 md:hidden"
        >
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                onClick={() => setOpen(false)}
                className={`block py-2.5 font-serif text-2xl ${isActive(l.href) ? "text-accent" : ""}`}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}
