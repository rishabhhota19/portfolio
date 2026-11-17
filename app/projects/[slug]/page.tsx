import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArticleSkeleton, Tag } from "@/components/site/bits";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { BookCall, SparkleIcon } from "@/components/site/cta";
import { getProject, projectMeta, projects } from "@/lib/content";

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) notFound(); // unknown slugs get a real 404 (the page body itself streams inside Suspense)
  return { title: project.title, description: project.summary };
}

// The shell (the back link) is the same for every project, so links prefetch it and it shows at once — also when
// Dumbledore navigates here. The project itself depends on the URL, so it streams in behind Suspense.
export default function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  return (
    <article className="mx-auto max-w-6xl px-5 pt-12 sm:px-8 sm:pt-16">
      <Link href="/projects" className="label link-underline hover:text-ink">
        ← All projects
      </Link>
      <Suspense fallback={<ArticleSkeleton />}>
        <Project params={params} />
      </Suspense>
    </article>
  );
}

async function Project({ params }: Pick<PageProps<"/projects/[slug]">, "params">) {
  const { slug } = await params;
  const project = getProject(slug);
  if (!project) notFound();

  const index = projects.findIndex((p) => p.slug === slug);
  const next = projects[(index + 1) % projects.length];

  return (
    <>
      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_18rem]">
        <div>
          <p className="label reveal">
            {projectMeta(project)}
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
          <div className="panel p-6">
            <p className="label">Stack</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {project.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
            <AskAgentButton
              question={`Tell me more about the ${project.title} project — what did Rishabh build, and what was the impact?`}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-full border border-accent/50 px-4 py-3 text-sm transition-colors duration-500 hover:border-accent hover:text-accent"
            >
              <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
              Ask Dumbledore about this
            </AskAgentButton>
          </div>
        </aside>
      </div>
      {/* Every project ends with a way to act on it. */}
      <div className="panel mt-20 flex flex-wrap items-center justify-between gap-6 p-7 sm:p-10">
        <div>
          <p className="font-serif text-3xl leading-tight sm:text-4xl">Want this for your team?</p>
          <p className="mt-2 max-w-md text-muted">Talk it through with Rishabh, or ask Dumbledore how {project.title} was built.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <BookCall from={`project ${project.slug}`} />
          <AskAgentButton
            question={`How did Rishabh build ${project.title}, and could he build something like it for my team?`}
            className="btn-ghost"
          >
            <SparkleIcon /> Ask Dumbledore
          </AskAgentButton>
        </div>
      </div>
      <div className="mt-16 border-t border-rule pt-8">
        <span className="label">Next project</span>
        <Link href={`/projects/${next.slug}`} className="group mt-3 block font-serif text-4xl transition-colors duration-500 hover:text-accent sm:text-5xl">
          {next.title} <span className="inline-block transition-transform group-hover:translate-x-1">→</span>
        </Link>
      </div>
    </>
  );
}
