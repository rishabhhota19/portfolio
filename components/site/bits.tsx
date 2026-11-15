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
    <div className="mb-10 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <h2 className="flex items-baseline gap-3 sm:gap-4">
        <span className="label !text-accent">{index.padStart(2, "0")}</span>
        <span className="font-serif text-[2rem] leading-none sm:text-[3.4rem]">{title}</span>
      </h2>
      {href ? (
        <Link
          href={href}
          className="shrink-0 rounded-full border border-rule px-3.5 py-2 text-sm transition-colors duration-500 hover:border-accent hover:text-accent"
        >
          {linkLabel ?? "View all"} <span aria-hidden>→</span>
        </Link>
      ) : null}
    </div>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-rule px-2.5 py-1 text-[0.78rem] leading-none text-muted">
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const published = status.toLowerCase() === "published";
  return (
    <span
      className={`label inline-flex w-fit items-center gap-2 rounded-full border px-2.5 py-1 !text-[0.66rem] ${
        published ? "border-accent/50 !text-accent" : "border-rule"
      }`}
    >
      <span className={`size-1.5 rounded-full ${published ? "bg-accent" : "border border-muted"}`} aria-hidden />
      {status}
    </span>
  );
}

// Placeholder while a project or post streams in (only seen on a slow connection).
export function ArticleSkeleton() {
  return (
    <div className="mt-10 max-w-2xl animate-pulse motion-reduce:animate-none" aria-hidden>
      <div className="h-3 w-40 rounded-full bg-rule" />
      <div className="mt-4 h-12 w-3/4 rounded-xl bg-rule" />
      <div className="mt-5 h-5 w-full rounded-full bg-rule/70" />
      <div className="mt-2 h-5 w-5/6 rounded-full bg-rule/70" />
    </div>
  );
}

export function PageIntro({ label, title, children }: { label: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-12 pt-16 sm:px-8 sm:pb-16 sm:pt-24">
      <p className="label reveal flex items-center gap-3">
        <span className="h-px w-8 bg-accent" aria-hidden />
        {label}
      </p>
      <h1 className="reveal mt-5 max-w-5xl font-serif text-5xl leading-[1.04] [text-wrap:balance] sm:text-7xl lg:text-[5rem]" style={{ ["--i" as string]: 1 }}>
        {title}
      </h1>
      {children ? (
        <div className="reveal mt-6 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl" style={{ ["--i" as string]: 2 }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
