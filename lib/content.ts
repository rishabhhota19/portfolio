import content from "./generated/content.json";

export type Site = typeof content.site;
export type Project = (typeof content.projects)[number];
export type Publication = (typeof content.publications)[number];
export type Role = (typeof content.experience)[number];
export type Post = (typeof content.blog)[number];
export type Service = (typeof content.services)[number];

export const site: Site = content.site;
export const projects: Project[] = content.projects;
export const publications: Publication[] = content.publications;
export const experience: Role[] = content.experience;
export const posts: Post[] = content.blog;
export const services: Service[] = content.services;
export const profile = content.profile;

export const featuredProjects = projects.filter((p) => p.featured);

/** Every page on the site (the admin dashboard counts any other path as "other"). "/3d" is Into the Agent, the 3D
 * descent, served from its own repo by the rewrites in next.config.ts. */
export const sitePaths = new Set([
  "/", "/3d", "/projects", "/publications", "/experience", "/services", "/blog", "/resume", "/privacy",
  ...projects.map((p) => `/projects/${p.slug}`),
  ...posts.map((p) => `/blog/${p.slug}`),
]);

/** "Simplilearn · Jun – Aug 2025", or just "Personal" when the résumé gives no date. */
export function projectMeta(p: Project) {
  return [p.org, p.period].filter(Boolean).join(" · ");
}

export function getProject(slug: string) {
  return projects.find((p) => p.slug === slug);
}

export function getPost(slug: string) {
  return posts.find((p) => p.slug === slug);
}
