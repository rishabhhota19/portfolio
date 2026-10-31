import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Tag } from "@/components/site/bits";
import { projectMeta, projects } from "@/lib/content";

export const metadata: Metadata = {
  title: "Projects",
  description: "Agents, LLM systems, medical-imaging pipelines and research prototypes built by Rishabh Hota.",
};

export default function ProjectsPage() {
  return (
    <>
      <PageIntro label="Index of work" title={<>Projects, <em className="text-accent">shipped and in progress.</em></>}>
        Multi-agent automation, MCP copilots, medical-imaging pipelines on AWS, and the odd teddy bear.
      </PageIntro>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <ul className="grid gap-px overflow-hidden rounded-sm border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => (
            <li key={p.slug} className="bg-paper">
              <Link
                href={`/projects/${p.slug}`}
                prefetch={false}
                className="group flex h-full flex-col p-6 transition-colors hover:bg-surface"
              >
                <div className="flex items-center justify-between">
                  <span className="label">{String(i + 1).padStart(2, "0")}</span>
                  {p.featured ? <span className="label text-accent">Featured</span> : null}
                </div>
                <h2 className="mt-5 font-serif text-[1.7rem] leading-tight transition-colors group-hover:text-accent">
                  {p.title}
                </h2>
                <p className="mt-2 text-sm text-muted">{p.summary}</p>
                <div className="mt-auto flex flex-wrap gap-1.5 pt-5">
                  {p.tags.slice(0, 3).map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
                <p className="label mt-4">
                  {projectMeta(p)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
