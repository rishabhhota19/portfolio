import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Serif, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ChatLauncher } from "@/components/chat/ChatLauncher";
import { VisitTracker } from "@/components/site/VisitTracker";
import { site } from "@/lib/content";

const display = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-display",
});

const body = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
});

const label = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-label",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} — ${site.role}`,
    template: `%s — ${site.name}`,
  },
  description: site.tagline,
  openGraph: {
    title: `${site.name} — ${site.role}`,
    description: site.tagline,
    url: site.url,
    siteName: site.name,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0e13" },
  ],
};

// Sets data-theme before first paint so there's no light/dark flash.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})()`;

// Analytics (both cookieless, each off until its env var is set):
// Cloudflare Web Analytics for traffic, Umami for custom events (chat opened, lead submitted, …).
const beaconToken = process.env.NEXT_PUBLIC_CF_BEACON_TOKEN;
const umamiId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

// Tells Google who this site is about (schema.org Person), from the résumé.
const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: site.name,
  jobTitle: "Senior AI Researcher",
  worksFor: { "@type": "Organization", name: "Simplilearn" },
  alumniOf: { "@type": "CollegeOrUniversity", name: "B.M.S. College of Engineering" },
  address: { "@type": "PostalAddress", addressLocality: "Bengaluru", addressCountry: "IN" },
  url: site.url,
  sameAs: [site.linkedin, site.github].filter(Boolean),
  knowsAbout: ["Agentic AI", "LangGraph", "Retrieval-augmented generation", "LLM fine-tuning", "Computer vision", "Medical imaging", "Quantum machine learning"],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${body.variable} ${label.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd).replace(/</g, "\\u003c") }}
        />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 bg-accent px-3 py-2 text-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <Header />
        <main id="main" className="relative z-10 flex-1">
          {children}
        </main>
        <Footer />
        <ChatLauncher />
        <VisitTracker />
        {beaconToken ? (
          <script
            defer
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: beaconToken })}
          />
        ) : null}
        {umamiId ? (
          <script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id={umamiId}
            data-domains={new URL(site.url).hostname}
            data-do-not-track="true"
          />
        ) : null}
      </body>
    </html>
  );
}
