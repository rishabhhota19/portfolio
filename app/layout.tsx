import type { Metadata, Viewport } from "next";
import { Comic_Neue } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { ChatLauncher } from "@/components/chat/ChatLauncher";
import { BookingDialog } from "@/components/booking/BookingDialog";
import { VisitTracker } from "@/components/site/VisitTracker";
import { SiteChrome } from "@/components/site/SiteChrome";
import { site } from "@/lib/content";

// The whole site is set in Comic Sans (Rishabh's call, 15 Nov 2026). Windows and macOS have it installed, so there
// it costs no download at all; Comic Neue, the free look-alike, is the web font for phones and Linux, which don't.
// It is not preloaded: a device that has Comic Sans never fetches it. The font stack is in app/globals.css.
const comic = Comic_Neue({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-comic",
  preload: false,
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
    { media: "(prefers-color-scheme: light)", color: "#f6f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
  ],
};

// Sets data-theme before first paint so there's no light/dark flash.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}if(location.pathname.indexOf('/agent-embed')===0){t='descent'}document.documentElement.dataset.theme=t}catch(e){}})()`;

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
      className={comic.variable}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd).replace(/</g, "\\u003c") }}
        />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only z-50 bg-accent px-3 py-2 text-accent-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        {/* The site's own column. Its width, not the window's, decides every page's layout (app/globals.css), so the
            pages still fit when the agent takes the left 40% of the screen. The agent itself sits outside it. */}
        <div className="site-shell flex min-h-dvh flex-col">
          <SiteChrome>
            <Header />
          </SiteChrome>
          <main id="main" className="relative z-10 flex-1">
            {children}
          </main>
          <SiteChrome>
            <Footer />
          </SiteChrome>
        </div>
        <SiteChrome>
          <ChatLauncher />
          <BookingDialog />
          <VisitTracker />
        </SiteChrome>
        {/* Analytics load when the browser is idle, so they never compete with the page itself. */}
        {beaconToken ? (
          <Script
            strategy="lazyOnload"
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: beaconToken })}
          />
        ) : null}
        {umamiId ? (
          <Script
            strategy="lazyOnload"
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
