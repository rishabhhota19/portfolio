import { sitePaths } from "@/lib/content";

/** The site's pages, prerendered at build. The analytics Worker (cloudflare/analytics/) counts these by name and any
 * other path as "other", so new projects and posts show up on the dashboard without redeploying it. */
export function GET() {
  return Response.json([...sitePaths]);
}
