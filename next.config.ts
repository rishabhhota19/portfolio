import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withSentryConfig } from "@sentry/nextjs/config";

// Security headers on every page. The CSP lists exactly what the site loads: its own code (pages are prerendered, so
// Next's inline bootstrap needs 'unsafe-inline' — nonces would need every page rendered per request — and BotID's
// challenge needs 'unsafe-eval'), Cloudflare + Umami analytics, Sentry, the media host (lib/media.ts) and the
// dashboard's analytics Worker. Framing, plugins, <base> hijacking, foreign form targets and every other network
// origin are blocked.
const origin = (url?: string) => (url ? ` ${new URL(url).origin}` : "");
const media = origin(process.env.NEXT_PUBLIC_MEDIA_BASE);
const analytics = origin(process.env.NEXT_PUBLIC_ANALYTICS_URL); // the dashboard's heartbeats (cloudflare/analytics/)
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://cloud.umami.is",
  `connect-src 'self' https://*.ingest.us.sentry.io https://cloudflareinsights.com https://*.umami.is https://*.umami.dev${media}${analytics}`,
  `img-src 'self' data: blob:${media}`,
  `media-src 'self'${media}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

// /3d is "Into the Agent", the 3D descent: its own repo (github.com/rishabhhota19/into-the-agent) and its own Vercel
// project, served at this site's address by the rewrites below (Vercel proxies them at the edge, so no function
// runs). Its files are relative to the page, so /assets and /models are proxied too. The 3D page loads less than the
// site does (no inline scripts, Google Fonts, three.js reading textures from blob: URLs, the same analytics), so its
// paths get its own CSP: the same policy as into-the-agent/vercel.json, kept in step by hand.
const INTO_THE_AGENT = process.env.INTO_THE_AGENT_URL ?? "https://into-the-agent.vercel.app";
const landingCsp = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com https://cloud.umami.is",
  `connect-src 'self' blob: https://cloudflareinsights.com https://*.umami.is https://*.umami.dev${analytics}`,
  "img-src 'self' data: blob:",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "worker-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");
const landingPaths = { "/3d": "/", "/assets/:path*": "/assets/:path*", "/models/:path*": "/models/:path*" }; // here → there
const landingHeaders = securityHeaders.map((h) => (h.key === "Content-Security-Policy" ? { ...h, value: landingCsp } : h));

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    // Later rules win for the same header, so the 3D paths end up with the 3D page's CSP.
    return [{ source: "/:path*", headers: securityHeaders }, ...Object.keys(landingPaths).map((source) => ({ source, headers: landingHeaders }))];
  },
  async rewrites() {
    return {
      // Before the file system: none of these paths is a page or file of this app.
      beforeFiles: Object.entries(landingPaths).map(([source, there]) => ({ source, destination: `${INTO_THE_AGENT}${there}` })),
      // On Vercel, /api/agent/* is served by the Python function in api/index.py.
      // (Locally the gateway calls the Python server directly via AGENT_URL.)
      afterFiles: process.env.VERCEL ? [{ source: "/api/agent/:path*", destination: "/api/" }] : [],
      fallback: [],
    };
  },
  turbopack: {
    root: __dirname, // a stray package-lock.json in the home folder otherwise confuses root detection
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Sentry uploads source maps (readable stack traces) only when SENTRY_AUTH_TOKEN/ORG/PROJECT are set.
export default withSentryConfig(withBotId(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
});
