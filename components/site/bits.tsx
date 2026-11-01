import Link from "next/link";
import type { ReactNode } from "react";

export function SectionHead({
  index,
  title,
  href,
  linkLabel,
}: {
  index: string;
  title: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mb-8 flex items-end justify-between gap-4 border-b border-rule pb-3">
      <h2 className="flex items-baseline gap-3">
        <span className="label">§{index}</span>
        <span className="font-serif text-3xl sm:text-4xl">{title}</span>
      </h2>
      {href ? (
        <Link href={href} className="label link-underline shrink-0 hover:text-ink">
          {linkLabel ?? "View all"} →
        </Link>
      ) : null}
    </div>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="label rounded-full border border-rule px-2 py-0.5 text-[0.66rem] normal-case tracking-normal">
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const published = status.toLowerCase() === "published";
  return (
    <span
      className={`label inline-flex w-fit items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[0.62rem] ${
        published ? "bg-accent text-accent-ink" : "border border-rule"
      }`}
    >
      {published ? "●" : "○"} {status}
    </span>
  );
}

// Placeholder while a project or post streams in (only seen on a slow connection).
export function ArticleSkeleton() {
  return (
    <div className="mt-10 max-w-2xl animate-pulse motion-reduce:animate-none" aria-hidden>
      <div className="h-3 w-40 rounded bg-rule" />
      <div className="mt-4 h-12 w-3/4 rounded bg-rule" />
      <div className="mt-5 h-5 w-full rounded bg-rule/70" />
      <div className="mt-2 h-5 w-5/6 rounded bg-rule/70" />
    </div>
  );
}

export function PageIntro({ label, title, children }: { label: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-10 pt-14 sm:px-8 sm:pt-20">
      <p className="label reveal">{label}</p>
      <h1 className="reveal mt-3 max-w-4xl font-serif text-5xl leading-[1.02] sm:text-7xl" style={{ ["--i" as string]: 1 }}>
        {title}
      </h1>
      {children ? (
        <div className="reveal mt-5 max-w-2xl text-lg text-muted" style={{ ["--i" as string]: 2 }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
