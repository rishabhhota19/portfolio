import type { MetadataRoute } from "next";
import { posts, projects, site } from "@/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["", "/projects", "/publications", "/experience", "/blog", "/resume"];
  return [
    ...pages.map((p) => ({ url: `${site.url}${p}` })),
    ...projects.map((p) => ({ url: `${site.url}/projects/${p.slug}` })),
    ...posts.map((p) => ({ url: `${site.url}/blog/${p.slug}` })),
  ];
}
