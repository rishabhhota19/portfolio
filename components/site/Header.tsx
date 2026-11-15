import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { ThreeDButton } from "./ThreeDButton";
import { AskAgentButton } from "@/components/chat/AskAgentButton";

export function Header() {
  return (
    <header className="relative z-20">
      <ThreeDButton />
      {/* The left padding leaves the top-left corner to the floating 3D button (icon-only on phones). */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 py-5 pl-[3.6rem] pr-4 max-sm:gap-2 sm:gap-8 sm:pl-[6.5rem] sm:pr-8">
        <Link href="/" className="group flex items-baseline gap-2 whitespace-nowrap" aria-label="Rishabh Hota — home">
          <span className="font-serif text-[1.2rem] leading-none sm:text-[1.6rem]">Rishabh Hota</span>
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          {/* Top right on every page, every screen size: the full name from tablets up, "Ask" on phones, the dot alone on the narrowest. */}
          <AskAgentButton
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/45 px-2.5 py-2 text-sm transition-colors duration-500 hover:border-accent hover:text-accent sm:px-4"
            aria-label="Ask Dumbledore, my AI agent"
          >
            <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
            <span className="max-[359px]:hidden sm:hidden">Ask</span>
            <span className="hidden sm:inline">Ask Dumbledore</span>
          </AskAgentButton>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
