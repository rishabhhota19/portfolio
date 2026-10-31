// Compiles content/**/*.md into two bundles:
//   lib/generated/content.json   — rendered HTML + metadata for the static pages
//   lib/generated/knowledge.json — plain text for the agent (core profile + RAG documents)
// Runs automatically before `next dev` and `next build`.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

const root = process.cwd();
const contentDir = path.join(root, "content");
const outDir = path.join(root, "lib", "generated");

type Front = Record<string, unknown>;
type Entry = { slug: string; data: Front; html: string; text: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stripComments(md: string) {
  return md.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function toPlainText(md: string) {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_`]/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDate(value: unknown, withDay = false) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const month = MONTHS[d.getUTCMonth()];
  return withDay ? `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}` : `${month} ${d.getUTCFullYear()}`;
}

function readDir(dir: string): Entry[] {
  const full = path.join(contentDir, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(full, file), "utf8");
      const { data, content } = matter(raw);
      const body = stripComments(content);
      return {
        slug: file.replace(/\.md$/, ""),
        data,
        html: marked.parse(body, { async: false }) as string,
        text: toPlainText(body),
      };
    })
    .sort((a, b) => Number(a.data.order ?? 99) - Number(b.data.order ?? 99));
}

function readOne(file: string): Entry {
  const raw = fs.readFileSync(path.join(contentDir, file), "utf8");
  const { data, content } = matter(raw);
  const body = stripComments(content);
  return {
    slug: path.basename(file, ".md"),
    data,
    html: marked.parse(body, { async: false }) as string,
    text: toPlainText(body),
  };
}

// Page bundles don't need the agent-only fields.
const omit = (obj: object, ...keys: string[]) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

const str = (v: unknown) => (v == null ? "" : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

const site = JSON.parse(fs.readFileSync(path.join(contentDir, "site.json"), "utf8"));
const core = readOne("profile/core.md");
const skills = readOne("profile/skills.md");
const education = readOne("profile/education.md");

const experience = readDir("experience").map((e) => ({
  slug: e.slug,
  title: str(e.data.title),
  company: str(e.data.company),
  location: str(e.data.location),
  start: str(e.data.start),
  end: str(e.data.end),
  keywords: list(e.data.keywords),
  html: e.html,
  text: e.text,
}));

const projects = readDir("projects").map((p) => ({
  slug: p.slug,
  title: str(p.data.title),
  summary: str(p.data.summary),
  org: str(p.data.org),
  period: str(p.data.period),
  tags: list(p.data.tags),
  featured: Boolean(p.data.featured),
  keywords: list(p.data.keywords),
  html: p.html,
  text: p.text,
}));

const publications = readDir("publications").map((p) => ({
  slug: p.slug,
  title: str(p.data.title),
  venue: str(p.data.venue),
  status: str(p.data.status),
  date: formatDate(p.data.date),
  link: str(p.data.link),
  authors: str(p.data.authors),
  keywords: list(p.data.keywords),
  html: p.html,
  text: p.text,
}));

const blog = readDir("blog")
  .filter((b) => !b.data.draft)
  .map((b) => ({
    slug: b.slug,
    title: str(b.data.title),
    summary: str(b.data.summary),
    date: formatDate(b.data.date, true),
    sortKey: b.data.date ? new Date(String(b.data.date instanceof Date ? b.data.date.toISOString() : b.data.date)).getTime() : 0,
    keywords: list(b.data.keywords),
    html: b.html,
    text: b.text,
  }))
  .sort((a, b) => b.sortKey - a.sortKey);

const content = {
  site,
  profile: { skillsHtml: skills.html, educationHtml: education.html },
  experience: experience.map((e) => omit(e, "text", "keywords")),
  projects: projects.map((p) => omit(p, "text", "keywords")),
  publications: publications.map((p) => omit(p, "text", "keywords")),
  blog: blog.map((b) => omit(b, "text", "keywords", "sortKey")),
};

// Every document the agent can retrieve. `url` lets answers point recruiters at the right page.
const docs = [
  ...experience.map((e) => ({
    id: `experience:${e.slug}`,
    kind: "experience",
    title: `${e.title} at ${e.company} (${e.start} – ${e.end})`,
    url: "/experience",
    keywords: e.keywords,
    text: `${e.title} — ${e.company}, ${e.location}, ${e.start} – ${e.end}\n${e.text}`,
  })),
  ...projects.map((p) => ({
    id: `project:${p.slug}`,
    kind: "project",
    title: p.title,
    url: `/projects/${p.slug}`,
    keywords: [...p.keywords, ...p.tags],
    text: `Project: ${p.title} (${p.org}, ${p.period})\n${p.summary}\n${p.text}`,
  })),
  ...publications.map((p) => ({
    id: `publication:${p.slug}`,
    kind: "publication",
    title: p.title,
    url: "/publications",
    keywords: p.keywords,
    text: `Publication: ${p.title}\nVenue: ${p.venue}. Status: ${p.status}.${p.date ? ` Date: ${p.date}.` : ""}${p.link ? ` Link: ${p.link}` : ""}\n${p.text}`,
  })),
  ...blog.map((b) => ({
    id: `blog:${b.slug}`,
    kind: "blog",
    title: b.title,
    url: `/blog/${b.slug}`,
    keywords: b.keywords,
    text: `Blog post: ${b.title} (${b.date})\n${b.summary}\n${b.text}`,
  })),
  {
    id: "profile:skills",
    kind: "profile",
    title: "Skills and tools",
    url: "/experience",
    keywords: list(skills.data.keywords),
    text: skills.text,
  },
  {
    id: "profile:education",
    kind: "profile",
    title: "Education, certifications and achievements",
    url: "/experience",
    keywords: list(education.data.keywords),
    text: education.text,
  },
];

const knowledge = { site, core: core.text, docs };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "content.json"), JSON.stringify(content, null, 2));
fs.writeFileSync(path.join(outDir, "knowledge.json"), JSON.stringify(knowledge, null, 2));

const coreTokens = Math.round(core.text.length / 4);
console.log(
  `content: ${projects.length} projects, ${publications.length} publications, ${experience.length} roles, ${blog.length} posts; ` +
    `knowledge: ${docs.length} docs, core profile ≈ ${coreTokens} tokens`,
);
