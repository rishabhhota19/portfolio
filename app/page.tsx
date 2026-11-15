import Link from "next/link";
import { SectionHead, StatusChip, Tag } from "@/components/site/bits";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { experience, featuredProjects, projectMeta, publications, site } from "@/lib/content";

const stats = [
  { value: "96%", label: "Accuracy, knee X-ray OA grading on AWS" },
  { value: "1 day", label: "Launch collateral via multi-agent system, down from 7–10" },
  { value: "IF 2.3", label: "LCSNet, published in Elsevier IBM" },
  { value: "3+ yrs", label: "Shipping research into production" },
];

const prompts = [
  "What's his strongest project?",
  "Has he built agentic AI in production?",
  "Tell me about his quantum attention research",
  "Would he fit a Forward Deployed Engineer role?",
];

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pb-20 pt-16 sm:px-8 sm:pb-24 sm:pt-24">
        <p className="label reveal flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="h-px w-8 bg-accent" aria-hidden />
          Sr. AI Researcher · Simplilearn · {site.location}
        </p>
        <h1
          className="reveal mt-6 max-w-5xl font-serif text-[3.1rem] leading-[0.98] [text-wrap:balance] sm:text-[5.2rem] lg:text-[6.4rem]"
          style={{ ["--i" as string]: 1 }}
        >
          I turn new AI research into <em className="text-accent">systems that ship.</em>
        </h1>
        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_27rem] lg:items-end lg:gap-16">
          <div className="reveal" style={{ ["--i" as string]: 2 }}>
            <p className="max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
              Agents and multi-agent orchestration, LLM fine-tuning and serving, medical-imaging models, and research on
              when quantum-inspired attention actually helps. Three-plus years taking ideas from paper to production.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-3">
              <a
                href={site.resume}
                data-umami-event="resume_download"
                data-umami-event-from="home"
                className="rounded-full border border-rule px-5 py-3 transition-colors duration-500 hover:border-accent hover:text-accent"
              >
                Download résumé
              </a>
              <Link href="/projects" className="link-underline py-3">
                See the work <span aria-hidden>→</span>
              </Link>
            </div>
          </div>

          {/* The agent, where a picture would be: one question bar that opens Dumbledore. */}
          <div className="reveal order-first lg:order-none" style={{ ["--i" as string]: 3 }}>
            <p className="label mb-3 flex items-center gap-2.5">
              <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
              Start with a question
            </p>
            <AskAgentButton
              aria-label="Ask Dumbledore, my AI agent"
              className="group flex w-full items-center gap-3 rounded-full border border-accent/45 bg-surface/70 py-2 pl-6 pr-2 text-left shadow-[var(--lift)] transition-colors duration-500 hover:border-accent"
            >
              <span className="flex-1 truncate text-muted transition-colors duration-500 group-hover:text-ink">
                Ask Dumbledore about Rishabh…
              </span>
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-transform duration-500 group-hover:translate-x-0.5" aria-hidden>
                →
              </span>
            </AskAgentButton>
            <ul className="mt-3 flex flex-wrap gap-2">
              {prompts.slice(0, 3).map((q) => (
                <li key={q}>
                  <AskAgentButton
                    question={q}
                    className="rounded-full border border-rule px-3.5 py-2 text-left text-sm text-muted transition-colors duration-500 hover:border-accent hover:text-accent"
                  >
                    {q}
                  </AskAgentButton>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Proof, in four numbers */}
      <section aria-label="Highlights" className="mx-auto max-w-6xl px-5 sm:px-8">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-10 border-y border-rule py-10 lg:grid-cols-4 lg:gap-x-12">
          {stats.map((s) => (
            <div key={s.value}>
              <dt className="font-serif text-5xl leading-none sm:text-6xl">{s.value}</dt>
              <dd className="mt-3 max-w-[15rem] text-sm leading-relaxed text-muted sm:text-base">{s.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Selected work */}
      <section className="mx-auto max-w-6xl px-5 pt-24 sm:px-8 sm:pt-32">
        <SectionHead index="1" title="Selected work" href="/projects" linkLabel="All projects" />
        <ol className="grid gap-4 lg:grid-cols-2">
          {featuredProjects.map((p, i) => (
            <li key={p.slug} className={i === 0 ? "lg:col-span-2" : ""}>
              <Link href={`/projects/${p.slug}`} className="panel group flex h-full flex-col p-7 sm:p-9">
                <div className="flex items-center justify-between gap-4">
                  <span className="label !text-accent">{String(i + 1).padStart(2, "0")}</span>
                  <span className="label text-right">{projectMeta(p)}</span>
                </div>
                <h3
                  className={`mt-8 font-serif leading-[1.05] transition-colors duration-500 group-hover:text-accent ${
                    i === 0 ? "max-w-3xl text-4xl sm:text-6xl" : "text-3xl sm:text-[2.6rem]"
                  }`}
                >
                  {p.title}
                </h3>
                <p className={`mt-4 text-muted ${i === 0 ? "max-w-2xl text-lg sm:text-xl" : "max-w-xl text-base sm:text-lg"}`}>{p.summary}</p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-8">
                  {p.tags.slice(0, 4).map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                  <span className="ml-auto text-xl text-muted transition-[transform,color] duration-500 group-hover:translate-x-1 group-hover:text-accent" aria-hidden>
                    →
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {/* Research */}
      <section className="mx-auto max-w-6xl px-5 pt-24 sm:px-8 sm:pt-32">
        <SectionHead index="2" title="Research" href="/publications" linkLabel="All publications" />
        <div className="grid gap-4 md:grid-cols-3">
          {publications.slice(0, 3).map((p) => (
            <article key={p.slug} className="panel flex flex-col p-7">
              <StatusChip status={p.status} />
              <h3 className="mt-6 font-serif text-2xl leading-snug sm:text-[1.7rem]">{p.title}</h3>
              <p className="mt-auto pt-6 text-sm text-muted">
                {p.venue}
                {p.date ? ` · ${p.date}` : ""}
              </p>
              {p.link ? (
                <a href={p.link} target="_blank" rel="noreferrer" data-umami-event="paper_click" data-umami-event-paper={p.slug} className="link-underline mt-3 w-fit text-sm text-accent">
                  Read the paper ↗
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {/* Experience */}
      <section className="mx-auto max-w-6xl px-5 pt-24 sm:px-8 sm:pt-32">
        <SectionHead index="3" title="Experience" href="/experience" linkLabel="Full timeline" />
        <ul className="divide-y divide-rule border-y border-rule">
          {experience.map((r) => (
            <li key={r.slug} className="grid gap-1 py-6 sm:grid-cols-[13rem_1fr_auto] sm:items-baseline sm:gap-6">
              <span className="label">
                {r.start} — {r.end}
              </span>
              <span className="font-serif text-2xl leading-tight sm:text-[1.9rem]">
                {r.title} <span className="font-sans text-base text-muted sm:text-lg">· {r.company}</span>
              </span>
              <span className="text-sm text-muted">{r.location}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Agent band */}
      <section className="mx-auto max-w-6xl px-5 pt-24 sm:px-8 sm:pt-32">
        <div className="relative overflow-hidden rounded-[2rem] border border-band-accent/25 bg-band px-7 py-12 text-band-ink sm:rounded-[2.75rem] sm:px-14 sm:py-16">
          <div
            className="pointer-events-none absolute -right-32 -top-40 size-[34rem] rounded-full opacity-60"
            style={{ background: "radial-gradient(closest-side, color-mix(in oklab, var(--band-accent) 22%, transparent), transparent)" }}
            aria-hidden
          />
          <p className="label relative !text-band-accent">04 · Dumbledore, the agent</p>
          <h2 className="relative mt-5 max-w-3xl font-serif text-5xl leading-[1.02] sm:text-7xl">
            Skip the scroll. <em className="text-band-accent">Just ask.</em>
          </h2>
          <p className="relative mt-6 max-w-xl text-lg leading-relaxed text-band-ink/70">
            Dumbledore, my AI agent, answers from my real projects, papers and experience using retrieval over this
            site&apos;s content, takes you to any page you ask for, and politely declines anything off-topic.
            The conversation disappears when you close it.
          </p>
          <ul className="relative mt-10 flex flex-wrap gap-2.5">
            {prompts.map((q) => (
              <li key={q}>
                <AskAgentButton
                  question={q}
                  className="group flex items-center gap-3 rounded-full border border-band-ink/20 px-5 py-3 text-left transition-colors duration-500 hover:border-band-accent hover:text-band-accent"
                >
                  {q}
                  <span className="text-band-accent transition-transform duration-500 group-hover:translate-x-0.5" aria-hidden>
                    →
                  </span>
                </AskAgentButton>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
