import Link from "next/link";
import { site } from "@/lib/content";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { BookCall, SparkleIcon } from "./cta";

export function Footer() {
  return (
    <footer className="relative z-10 mt-28 border-t border-rule">
      {/* Let's talk: the last call to action on every page. */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-8 border-b border-rule px-5 py-14 sm:px-8">
        <div>
          <p className="font-serif text-5xl leading-[1.02] sm:text-6xl">
            Let&apos;s <em className="text-accent">talk.</em>
          </p>
          <p className="mt-4 max-w-md text-muted">
            Hiring for an AI role, or need something built? A 30-minute call is the fastest way. Or ask Dumbledore first.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <BookCall from="footer" className="btn-lg" />
          <AskAgentButton className="btn-ghost btn-lg">
            <SparkleIcon /> Ask Dumbledore
          </AskAgentButton>
        </div>
      </div>
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="font-serif text-2xl">{site.name}</p>
          <p className="mt-2 max-w-sm text-sm text-muted">Sr. AI Researcher · {site.location}</p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span className="label mb-1">Contact</span>
          <a className="link-underline w-fit" href={`mailto:${site.email}`} data-umami-event="email_click">
            {site.email}
          </a>
          <a className="link-underline w-fit" href={site.linkedin} target="_blank" rel="noreferrer" data-umami-event="linkedin_click">
            LinkedIn ↗
          </a>
          {site.github ? (
            <a className="link-underline w-fit" href={site.github} target="_blank" rel="noreferrer" data-umami-event="github_click">
              GitHub ↗
            </a>
          ) : null}
          <a className="link-underline w-fit" href={site.resume} data-umami-event="resume_download" data-umami-event-from="footer">
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
          <Link href="/privacy" className="link-underline w-fit text-muted">
            Privacy
          </Link>
        </div>
      </div>
    </footer>
  );
}
