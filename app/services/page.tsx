import type { Metadata } from "next";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { PageIntro, Tag } from "@/components/site/bits";
import { services, site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Services",
  description: "Agentic systems, RAG, fine-tuning and serving, medical imaging, applied research, training and AI strategy: what Rishabh Hota builds, teaches and advises on.",
};

// Each service has an #anchor (its slug): the agent's "take me there" links land on it (agent/pages.py).
export default function ServicesPage() {
  return (
    <>
      <PageIntro label="Services" title={<>Building, training, consulting: <em className="text-accent">intelligence in the flow of work.</em></>}>
        A short call fixes the problem, the data and the done-condition. A working prototype lands within days, not a deck,
        and the shipped build comes with an eval suite, documentation and a handover, so it keeps working after he leaves.
      </PageIntro>
      <ol className="mx-auto max-w-6xl divide-y divide-rule border-y border-rule px-5 sm:px-8">
        {services.map((s, i) => (
          <li key={s.slug} id={s.slug} className="grid scroll-mt-24 gap-4 py-12 md:grid-cols-[4rem_1fr_14rem]">
            <span className="label pt-1 !text-accent">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <p className="label">{s.kicker}</p>
              <h2 className="mt-3 font-serif text-3xl leading-[1.1] sm:text-[2.5rem]">{s.title}</h2>
              <p className="mt-3 max-w-2xl text-lg text-muted">{s.summary}</p>
              <div className="prose-journal mt-4 max-w-2xl text-[0.98rem]" dangerouslySetInnerHTML={{ __html: s.html }} />
              {s.tags.length ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {s.tags.map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex flex-col items-start gap-2 md:items-end md:text-right">
              <AskAgentButton
                question={`What would it look like to hire him for this: ${s.title}?`}
                className="group inline-flex items-center gap-2 rounded-full border border-accent/45 px-4 py-2 text-sm transition-colors duration-500 hover:border-accent hover:text-accent"
              >
                <span className="pulse-dot inline-block size-2 rounded-full bg-accent" aria-hidden />
                Ask Dumbledore
              </AskAgentButton>
              <a
                href={`mailto:${site.email}?subject=${encodeURIComponent(`Build: ${s.title}`)}`}
                data-umami-event="email_click"
                data-umami-event-from="services"
                className="link-underline text-sm text-muted hover:text-accent"
              >
                Email about this ↗
              </a>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
