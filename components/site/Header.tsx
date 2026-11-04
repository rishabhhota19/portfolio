import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { ThreeDButton } from "./ThreeDButton";
import { AskAgentButton } from "@/components/chat/AskAgentButton";

export function Header() {
  return (
    <header className="relative z-20 border-b border-rule">
      <ThreeDButton />
      {/* The left padding leaves the top-left corner to the floating 3D button (icon-only on phones). */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 py-4 pl-[3.6rem] pr-4 sm:gap-6 sm:pl-[6.5rem] sm:pr-8">
        <Link href="/" className="group flex items-baseline gap-2 whitespace-nowrap" aria-label="Rishabh Hota — home">
          <span className="font-serif text-[1.4rem] leading-none sm:text-2xl">Rishabh Hota</span>
          <span className="label hidden xl:inline">AI/ML · Research → Systems</span>
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          {/* Top right on every page, every screen size: "Ask" on phones, the full name from tablets up. */}
          <AskAgentButton
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-rule px-2.5 py-1.5 text-sm transition-colors hover:border-accent hover:text-accent sm:px-3"
            aria-label="Ask Dumbledore, my AI agent"
          >
            <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
            <span className="sm:hidden">Ask</span>
            <span className="hidden sm:inline">Ask Dumbledore</span>
          </AskAgentButton>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
