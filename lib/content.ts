import content from "./generated/content.json";

export type Site = typeof content.site;
export type Project = (typeof content.projects)[number];
export type Publication = (typeof content.publications)[number];
export type Role = (typeof content.experience)[number];
export type Post = (typeof content.blog)[number];

export const site: Site = content.site;
export const projects: Project[] = content.projects;
export const publications: Publication[] = content.publications;
export const experience: Role[] = content.experience;
export const posts: Post[] = content.blog;
export const profile = content.profile;

export const featuredProjects = projects.filter((p) => p.featured);

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
