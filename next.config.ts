import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withSentryConfig } from "@sentry/nextjs/config";

// Security headers on every page. The CSP lists exactly what the site loads: its own code (pages are prerendered, so
// Next's inline bootstrap needs 'unsafe-inline' — nonces would need every page rendered per request — and BotID's
// challenge needs 'unsafe-eval'), Cloudflare + Umami analytics, Sentry, and the media host (lib/media.ts). Framing,
// plugins, <base> hijacking, foreign form targets and every other network origin are blocked.
const media = process.env.NEXT_PUBLIC_MEDIA_BASE ? ` ${new URL(process.env.NEXT_PUBLIC_MEDIA_BASE).origin}` : "";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://cloud.umami.is",
  `connect-src 'self' https://*.ingest.us.sentry.io https://cloudflareinsights.com https://*.umami.is https://*.umami.dev${media}`,
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

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // On Vercel, /api/agent/* is served by the Python function in api/index.py.
  // (Locally the gateway calls the Python server directly via AGENT_URL.)
  async rewrites() {
    return process.env.VERCEL ? [{ source: "/api/agent/:path*", destination: "/api/" }] : [];
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
