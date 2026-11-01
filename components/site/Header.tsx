import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { AskAgentButton } from "@/components/chat/AskAgentButton";

export function Header() {
  return (
    <header className="relative z-20 border-b border-rule">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-4 sm:px-8">
        <Link href="/" className="group flex items-baseline gap-2 whitespace-nowrap" aria-label="Rishabh Hota — home">
          <span className="font-serif text-2xl leading-none">Rishabh Hota</span>
          <span className="label hidden xl:inline">AI/ML · Research → Systems</span>
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <AskAgentButton
            className="hidden items-center gap-2 whitespace-nowrap rounded-full border border-rule px-3 py-1.5 text-sm transition-colors hover:border-accent hover:text-accent lg:inline-flex"
          >
            <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
            Ask Dumbledore
          </AskAgentButton>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
