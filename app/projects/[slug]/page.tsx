import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Tag } from "@/components/site/bits";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { getProject, projects } from "@/lib/content";

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) return {};
  return { title: project.title, description: project.summary };
}

export default async function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) notFound();

  const index = projects.findIndex((p) => p.slug === slug);
  const next = projects[(index + 1) % projects.length];

  return (
    <article className="mx-auto max-w-6xl px-5 pt-12 sm:px-8 sm:pt-16">
      <Link href="/projects" className="label link-underline hover:text-ink">
        ← All projects
      </Link>
      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_18rem]">
        <div>
          <p className="label reveal">
            {project.org} · {project.period}
          </p>
          <h1 className="reveal mt-3 font-serif text-5xl leading-[1.02] sm:text-6xl" style={{ ["--i" as string]: 1 }}>
            {project.title}
          </h1>
          <p className="reveal mt-5 max-w-2xl text-xl text-muted" style={{ ["--i" as string]: 2 }}>
            {project.summary}
          </p>
          <div
            className="prose-journal reveal mt-10 max-w-2xl"
            style={{ ["--i" as string]: 3 }}
            dangerouslySetInnerHTML={{ __html: project.html }}
          />
        </div>
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="rounded-sm border border-rule bg-surface/60 p-5">
            <p className="label">Stack</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {project.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
            <AskAgentButton
              question={`Tell me more about the ${project.title} project — what was Rishabh's role and what was hard about it?`}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm text-paper transition-transform hover:-translate-y-0.5"
            >
              <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
              Ask the agent about this
            </AskAgentButton>
          </div>
        </aside>
      </div>
      <div className="mt-20 border-t border-rule pt-6">
        <span className="label">Next project</span>
        <Link href={`/projects/${next.slug}`} className="group mt-2 block font-serif text-3xl transition-colors hover:text-accent">
          {next.title} <span className="inline-block transition-transform group-hover:translate-x-1">→</span>
        </Link>
      </div>
    </article>
  );
}
