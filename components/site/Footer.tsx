import Link from "next/link";
import { site } from "@/lib/content";

export function Footer() {
  return (
    <footer className="relative z-10 mt-24 border-t border-rule">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="font-serif text-3xl leading-tight">
            Let&apos;s build something <em className="text-accent">that ships.</em>
          </p>
          <p className="mt-3 max-w-sm text-sm text-muted">
            Recruiting for an AI, GenAI or research-engineering role? Ask my agent, or write to me directly.
          </p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="label mb-1">Contact</span>
          <a className="link-underline w-fit" href={`mailto:${site.email}`}>
            {site.email}
          </a>
          <a className="link-underline w-fit" href={site.linkedin} target="_blank" rel="noreferrer">
            LinkedIn ↗
          </a>
          {site.github ? (
            <a className="link-underline w-fit" href={site.github} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          ) : null}
          <a className="link-underline w-fit" href={site.resume}>
            Résumé (PDF)
          </a>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="label mb-1">Colophon</span>
          <p className="text-muted">
            {site.location}. Built with Next.js, LangGraph and RAG on a ₹0/month stack.
          </p>
          <Link href="/blog/how-my-portfolio-agent-works" className="link-underline w-fit">
            How the agent works →
          </Link>
        </div>
      </div>
    </footer>
  );
}
