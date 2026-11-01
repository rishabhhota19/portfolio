import type { MetadataRoute } from "next";
import { posts, projects, site } from "@/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...site.sections.map((s) => ({ url: `${site.url}${s.path === "/" ? "" : s.path}` })), // content/site.json
    ...projects.map((p) => ({ url: `${site.url}/projects/${p.slug}` })),
    ...posts.map((p) => ({ url: `${site.url}/blog/${p.slug}` })),
  ];
}
