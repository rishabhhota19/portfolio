import Link from "next/link";
import { AttentionGrid } from "@/components/site/AttentionGrid";
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
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <p className="label reveal">Sr. AI Researcher · Simplilearn · {site.location}</p>
          <h1
            className="reveal mt-4 font-serif text-[3.4rem] leading-[0.98] tracking-tight sm:text-[5.2rem]"
            style={{ ["--i" as string]: 1 }}
          >
            I turn new AI research into <em className="text-accent">systems that ship.</em>
          </h1>
          <p className="reveal mt-6 max-w-xl text-lg leading-relaxed text-muted" style={{ ["--i" as string]: 2 }}>
            Agents and multi-agent orchestration, LLM fine-tuning and serving, medical-imaging models, and research on
            when quantum-inspired attention actually helps. Three-plus years taking ideas from paper to production.
          </p>
          <div className="reveal mt-8 flex flex-wrap items-center gap-3" style={{ ["--i" as string]: 3 }}>
            <AskAgentButton className="group inline-flex items-center gap-2.5 rounded-full bg-ink px-5 py-3 text-paper transition-transform hover:-translate-y-0.5">
              <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
              Ask my agent anything
              <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>
                →
              </span>
            </AskAgentButton>
            <a
              href={site.resume}
              className="rounded-full border border-rule px-5 py-3 transition-colors hover:border-ink"
            >
              Download résumé
            </a>
            <Link href="/projects" className="link-underline px-2 py-3">
              See the work
            </Link>
          </div>
        </div>

        <figure className="reveal rounded-sm border border-rule bg-surface/70 p-5 backdrop-blur-[2px]" style={{ ["--i" as string]: 2 }}>
          <AttentionGrid />
          <figcaption className="mt-3 border-t border-rule pt-3 text-sm text-muted">
            <span className="label text-ink">Fig. 1</span> — Causal self-attention over the sentence above (illustrative).
            My research asks whether quantum-inspired attention earns its keep at a matched compute budget.
          </figcaption>
        </figure>
      </section>

      {/* Spec strip */}
      <section aria-label="Highlights" className="border-y border-rule bg-surface/50">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 px-5 sm:px-8 lg:grid-cols-4">
          {stats.map((s, i) => (
            <div
              key={s.value}
              className={`py-6 pr-4 ${i % 2 === 1 ? "pl-4 border-l border-rule" : ""} ${i >= 2 ? "border-t border-rule lg:border-t-0" : ""} ${i === 2 ? "lg:border-l lg:pl-4" : ""}`}
            >
              <dt className="font-serif text-3xl sm:text-4xl">{s.value}</dt>
              <dd className="mt-1 text-sm text-muted">{s.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Selected work */}
      <section className="mx-auto max-w-6xl px-5 pt-20 sm:px-8">
        <SectionHead index="1" title="Selected work" href="/projects" linkLabel="All projects" />
        <ol className="divide-y divide-rule border-b border-rule">
          {featuredProjects.map((p, i) => (
            <li key={p.slug}>
              <Link
                href={`/projects/${p.slug}`}
                className="group grid gap-3 py-7 sm:grid-cols-[4rem_1fr_auto] sm:items-baseline"
              >
                <span className="label">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="font-serif text-3xl leading-tight transition-colors group-hover:text-accent sm:text-[2.1rem]">
                    {p.title}
                  </h3>
                  <p className="mt-2 max-w-2xl text-muted">{p.summary}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {p.tags.slice(0, 4).map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </div>
                </div>
                <span className="label hidden whitespace-nowrap sm:block">
                  {projectMeta(p)}
                  <span className="ml-3 inline-block transition-transform group-hover:translate-x-1" aria-hidden>
                    →
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      {/* Research */}
      <section className="mx-auto max-w-6xl px-5 pt-20 sm:px-8">
        <SectionHead index="2" title="Research" href="/publications" linkLabel="All publications" />
        <div className="grid gap-px overflow-hidden rounded-sm border border-rule bg-rule md:grid-cols-3">
          {publications.slice(0, 3).map((p) => (
            <article key={p.slug} className="flex flex-col bg-paper p-6">
              <StatusChip status={p.status} />
              <h3 className="mt-4 font-serif text-2xl leading-snug">{p.title}</h3>
              <p className="mt-auto pt-4 text-sm text-muted">
                {p.venue}
                {p.date ? ` · ${p.date}` : ""}
              </p>
              {p.link ? (
                <a href={p.link} target="_blank" rel="noreferrer" className="label link-underline mt-3 w-fit text-accent">
                  Read paper ↗
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {/* Experience */}
      <section className="mx-auto max-w-6xl px-5 pt-20 sm:px-8">
        <SectionHead index="3" title="Experience" href="/experience" linkLabel="Full timeline" />
        <ul className="divide-y divide-rule">
          {experience.map((r) => (
            <li key={r.slug} className="grid gap-1 py-4 sm:grid-cols-[12rem_1fr_auto] sm:items-baseline">
              <span className="label">
                {r.start} — {r.end}
              </span>
              <span className="text-lg">
                {r.title} <span className="text-muted">· {r.company}</span>
              </span>
              <span className="text-sm text-muted">{r.location}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Agent band */}
      <section className="mx-auto max-w-6xl px-5 pt-24 sm:px-8">
        <div className="relative overflow-hidden rounded-sm border border-rule bg-band p-8 text-band-ink sm:p-12">
          <p className="label !text-band-ink/60">§4 — The agent</p>
          <h2 className="mt-3 max-w-2xl font-serif text-4xl leading-tight sm:text-6xl">
            Skip the scroll. <em className="text-band-accent">Just ask.</em>
          </h2>
          <p className="mt-4 max-w-xl text-band-ink/70">
            My agent answers from my real projects, papers and experience using retrieval over this site&apos;s content.
            The conversation disappears when you close it.
          </p>
          <ul className="mt-8 grid gap-2 sm:grid-cols-2">
            {prompts.map((q) => (
              <li key={q}>
                <AskAgentButton
                  question={q}
                  className="group flex w-full items-center gap-3 rounded-sm border border-band-ink/15 px-4 py-3 text-left font-mono text-sm transition-colors hover:border-band-accent hover:text-band-accent"
                >
                  <span className="text-band-accent" aria-hidden>
                    &gt;
                  </span>
                  {q}
                </AskAgentButton>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
