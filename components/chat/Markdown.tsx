import Link from "next/link";
import { Fragment, type ReactNode } from "react";

// Minimal, safe renderer for model output: paragraphs, "- " lists, **bold**, `code`, links and bare URLs.
// Builds React nodes (no innerHTML). Site-relative links use <Link> so the chat survives navigation.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/[^)\s]+|\/[^)\s]*)\)|https?:\/\/[^\s)<]*[^\s)<.,;:!?])/g;

/** Set when the chat lives in the 3D page's frame: a site link must move the page hosting the chat, not load the site inside its window. */
type OnPage = ((href: string) => void) | undefined;

function inline(text: string, keyPrefix: string, onPage?: OnPage): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    // Bold can wrap a link ("**[Page](/x)**"), so its inside is parsed too.
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{inline(part.slice(2, -2), key, onPage)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={key} className="rounded border border-rule px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, text, href] = link;
      const label = inline(text, key, onPage); // e.g. "[**Name**](/x)"
      // One leading slash is a page of this site; "//evil.com" is another site (the server's guard strips it already)
      if (onPage && /^\/(?!\/)/.test(href))
        return (
          <a
            key={key}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              onPage(href);
            }}
            className="text-accent underline underline-offset-2"
          >
            {label}
          </a>
        );
      return /^\/(?!\/)/.test(href) ? (
        <Link key={key} href={href} className="text-accent underline underline-offset-2">
          {label}
        </Link>
      ) : (
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
          {label}
        </a>
      );
    }
    if (/^https?:\/\//.test(part))
      return (
        <a key={key} href={part} target="_blank" rel="noreferrer" className="break-all text-accent underline underline-offset-2">
          {part.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      );
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function Markdown({ text, onPage }: { text: string; onPage?: OnPage }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (!bullets.length) return;
    const items = bullets;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1.5 space-y-1">
        {items.map((b, i) => (
          <li key={i} className="relative pl-4 before:absolute before:left-0 before:top-[0.7em] before:h-px before:w-2 before:bg-accent">
            {inline(b, `li-${blocks.length}-${i}`, onPage)}
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
        {inline(heading ? heading[1] : line, `p-${i}`, onPage)}
      </p>,
    );
  });
  flush();

  return <>{blocks}</>;
}
