import type { Metadata } from "next";
import { PageIntro } from "@/components/site/bits";
import { experience, profile } from "@/lib/content";

export const metadata: Metadata = {
  title: "Experience",
  description: "Roles, skills, education and certifications of Rishabh Hota.",
};

export default function ExperiencePage() {
  return (
    <>
      <PageIntro label="Experience" title={<>From DICOM files to <em className="text-accent">agent fleets.</em></>}>
        Three-plus years across healthcare AI and ed-tech, from research prototypes to production pipelines.
      </PageIntro>

      <section className="mx-auto max-w-6xl px-5 sm:px-8">
        <ol className="relative border-l border-rule">
          {experience.map((r, i) => (
            <li key={r.slug} id={r.slug} className="relative grid scroll-mt-24 gap-3 pb-12 pl-8 md:grid-cols-[13rem_1fr] md:gap-10">
              <span
                className={`absolute -left-[5px] top-2 size-[9px] rounded-full border border-accent ${i === 0 ? "bg-accent pulse-dot" : "bg-paper"}`}
                aria-hidden
              />
              <div>
                <p className="label">
                  {r.start} — {r.end}
                </p>
                <p className="mt-1 text-sm text-muted">{r.location}</p>
              </div>
              <div>
                <h2 className="font-serif text-3xl leading-tight">{r.title}</h2>
                <p className="mt-1 text-lg text-muted">{r.company}</p>
                <div className="prose-journal mt-4 max-w-2xl text-[0.98rem]" dangerouslySetInnerHTML={{ __html: r.html }} />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto mt-10 grid max-w-6xl gap-12 border-t border-rule px-5 pt-12 sm:px-8 lg:grid-cols-2">
        <div>
          <p className="label">Skills & tools</p>
          <div className="prose-journal mt-2 text-[0.95rem]" dangerouslySetInnerHTML={{ __html: profile.skillsHtml }} />
        </div>
        <div>
          <p className="label">Education & recognition</p>
          <div className="prose-journal mt-2 text-[0.95rem]" dangerouslySetInnerHTML={{ __html: profile.educationHtml }} />
        </div>
      </section>
    </>
  );
}
