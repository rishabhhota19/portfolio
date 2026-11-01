import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// Minimal, safe renderer for model output: paragraphs, "- " lists, **bold**, `code` and links.
// Builds React nodes (no innerHTML). Site-relative links use <Link> so the chat survives navigation.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/[^)\s]+|\/[^)\s]*)\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    // Bold can wrap a link ("**[Page](/x)**"), so its inside is parsed too.
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{inline(part.slice(2, -2), key)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={key} className="rounded border border-rule px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, text, href] = link;
      const label = inline(text, key); // e.g. "[**Name**](/x)"
      return href.startsWith("/") ? (
        <Link key={key} href={href} className="text-accent underline underline-offset-2">
          {label}
        </Link>
      ) : (
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
          {label}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    const items = bullets;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1.5 space-y-1">
        {items.map((b, i) => (
          <li key={i} className="relative pl-4 before:absolute before:left-0 before:top-[0.7em] before:h-px before:w-2 before:bg-accent">
            {inline(b, `li-${blocks.length}-${i}`)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flush();
    if (!line.trim()) return;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(
      <p key={`p-${i}`} className={`my-1.5 ${heading ? "font-semibold" : ""}`}>
        {inline(heading ? heading[1] : line, `p-${i}`)}
      </p>,
    );
  });
  flush();

  return <>{blocks}</>;
}
