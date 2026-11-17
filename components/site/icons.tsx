import type { ReactNode } from "react";

/** Line icons in the site's hand: 24-unit grid, round joins, drawn in currentColor (the gold accent where used). */
function Icon({ children, className = "size-6" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

// One per service (content/services, by slug).
const SERVICE: Record<string, ReactNode> = {
  // agents: three nodes handing work along
  "agentic-systems": (
    <>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7.2 6h9.6M6.2 7.9l4.6 8.2M17.8 7.9l-4.6 8.2" />
    </>
  ),
  // retrieval: a stack of documents and a magnifier
  "rag-knowledge": (
    <>
      <path d="M5 4h8l3 3v5" />
      <path d="M13 4v3h3M5 4v15h6" />
      <path d="M8 9h4M8 12h3" />
      <circle cx="16.5" cy="16.5" r="3" />
      <path d="M18.7 18.7 21 21" />
    </>
  ),
  // fine-tuning and serving: a chip with sliders
  "fine-tuning-serving": (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
      <path d="M10 10v4M14 10v4" />
      <circle cx="10" cy="12.5" r="0.9" fill="currentColor" />
      <circle cx="14" cy="11" r="0.9" fill="currentColor" />
    </>
  ),
  // medical imaging: a scan frame around a knee joint
  "medical-imaging": (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M10 7v3.5c0 1-1 1.5-1 2.5s1 1.5 2 1.5M14 7v3.5c0 1 1 1.5 1 2.5s-1 1.5-2 1.5" />
      <path d="M10 17h4" />
    </>
  ),
  // research to prototype: a flask with a spark
  "research-to-prototype": (
    <>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M7.5 15h9" />
      <path d="M18 3.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" />
    </>
  ),
  // training: a board with a pointer
  training: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M7 12l3-3 2 2 4-4" />
      <path d="M9 20l3-4 3 4" />
    </>
  ),
  // strategy: a route with a flag at the end
  consulting: (
    <>
      <circle cx="5" cy="18" r="2" />
      <path d="M7 18h4a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6" />
      <path d="M17 3v8M17 3h4l-1.3 1.7L21 6.5h-4" />
    </>
  ),
};

export function ServiceIcon({ slug, className }: { slug: string; className?: string }) {
  return <Icon className={className}>{SERVICE[slug] ?? SERVICE["agentic-systems"]}</Icon>;
}

// The ways to reach him.
export const MailIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 6.5 12 13l8.5-6.5" />
  </Icon>
);

export const LinkedInIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M7.5 10.5V17M7.5 7.2v.1M11.5 17v-6.5M11.5 13.5c0-1.7 1.2-3 2.7-3s2.3 1 2.3 2.8V17" />
  </Icon>
);

export const GitHubIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.9-2.3c2.9-.3 6-1.4 6-6.4a5 5 0 0 0-1.4-3.5 4.6 4.6 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.3 12.3 0 0 0-6.4 0C6.1 1.5 5 1.8 5 1.8a4.6 4.6 0 0 0-.1 3.5 5 5 0 0 0-1.4 3.5c0 5 3.1 6.1 6 6.4a3 3 0 0 0-.9 2.3V21" />
  </Icon>
);

export const DocumentIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 15.5h6M9 9h2" />
  </Icon>
);
