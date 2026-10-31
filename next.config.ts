import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
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

export default withBotId(nextConfig);
