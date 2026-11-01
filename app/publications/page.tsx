import type { Metadata } from "next";
import { PageIntro, StatusChip } from "@/components/site/bits";
import { publications } from "@/lib/content";

export const metadata: Metadata = {
  title: "Research",
  description: "Publications and papers under review: medical imaging, quantum-inspired attention, decision support.",
};

export default function PublicationsPage() {
  return (
    <>
      <PageIntro label="Research & publications" title={<>Papers, <em className="text-accent">reviewed and in review.</em></>}>
        Medical-imaging segmentation, quantum self-attention for Vision Transformers, and clinical decision support.
      </PageIntro>
      <ol className="mx-auto max-w-6xl divide-y divide-rule border-y border-rule px-5 sm:px-8">
        {publications.map((p, i) => (
          <li key={p.slug} id={p.slug} className="grid scroll-mt-24 gap-4 py-8 md:grid-cols-[4rem_1fr_14rem]">
            <span className="label pt-1">[{i + 1}]</span>
            <div>
              <h2 className="font-serif text-2xl leading-snug sm:text-[1.75rem]">{p.title}</h2>
              {p.authors ? <p className="mt-1 text-sm text-muted">{p.authors}</p> : null}
              <div className="prose-journal mt-4 max-w-2xl text-[0.98rem]" dangerouslySetInnerHTML={{ __html: p.html }} />
            </div>
            <div className="flex flex-col items-start gap-2 md:items-end md:text-right">
              <StatusChip status={p.status} />
              <p className="text-sm text-muted">
                <em className="font-serif text-base not-italic">{p.venue}</em>
                {p.date ? <span className="block">{p.date}</span> : null}
              </p>
              {p.link ? (
                <a href={p.link} target="_blank" rel="noreferrer" data-umami-event="paper_click" data-umami-event-paper={p.slug} className="label link-underline text-accent">
                  Read paper ↗
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
