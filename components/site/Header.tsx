import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  return (
    <header className="relative z-20">
      {/* Asking the agent and the way into 3D live in the strip above (AskBar): here, only who and where. */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-5 sm:gap-8 sm:px-8">
        <Link href="/" className="group flex items-baseline gap-2 whitespace-nowrap" aria-label="Rishabh Hota — home">
          <span className="font-serif text-[1.45rem] leading-none sm:text-[1.6rem]">Rishabh Hota</span>
        </Link>
        <NavLinks />
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
