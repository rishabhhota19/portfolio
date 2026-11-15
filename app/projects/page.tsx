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
        {/* The first project leads at double width; the rest follow three to a row. */}
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => (
            <li key={p.slug} className={i === 0 ? "sm:col-span-2" : ""}>
              <Link href={`/projects/${p.slug}`} prefetch={false} className="panel group flex h-full flex-col p-7">
                <div className="flex items-center justify-between gap-3">
                  <span className="label !text-accent">{String(i + 1).padStart(2, "0")}</span>
                  {p.featured ? (
                    <span className="label rounded-full border border-accent/45 px-2.5 py-1 !text-[0.66rem] !text-accent">Featured</span>
                  ) : null}
                </div>
                <h2
                  className={`mt-7 font-serif leading-[1.08] transition-colors duration-500 group-hover:text-accent ${
                    i === 0 ? "max-w-xl text-4xl sm:text-5xl" : "text-[1.9rem]"
                  }`}
                >
                  {p.title}
                </h2>
                <p className={`mt-3 text-muted ${i === 0 ? "max-w-xl text-lg" : ""}`}>{p.summary}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-7">
                  {p.tags.slice(0, 3).map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
                <p className="label mt-5 flex items-center justify-between gap-3 border-t border-rule pt-4">
                  {projectMeta(p)}
                  <span className="text-base text-muted transition-[transform,color] duration-500 group-hover:translate-x-1 group-hover:text-accent" aria-hidden>
                    →
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
