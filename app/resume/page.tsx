import type { Metadata } from "next";
import { PageIntro } from "@/components/site/bits";
import { AskAgentButton } from "@/components/chat/AskAgentButton";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Résumé",
  description: "Download Rishabh Hota's résumé.",
};

export default function ResumePage() {
  return (
    <>
      <PageIntro label="Résumé" title={<>The one-page story, <em className="text-accent">in three pages.</em></>}>
        Prefer a conversation? Dumbledore, my AI agent, can answer anything on it.
      </PageIntro>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-wrap gap-3">
          <a
            href={site.resume}
            data-umami-event="resume_download"
            data-umami-event-from="resume page"
            download="Rishabh-Hota-Resume.pdf"
            className="rounded-full bg-ink px-5 py-3 text-paper transition-transform hover:-translate-y-0.5"
          >
            Download PDF
          </a>
          <AskAgentButton
            question="Give me a 30-second summary of Rishabh's résumé for an AI Engineer role."
            className="rounded-full border border-rule px-5 py-3 transition-colors hover:border-ink"
          >
            Ask for a 30-second summary
          </AskAgentButton>
        </div>
        <object
          data={site.resume}
          type="application/pdf"
          className="mt-8 hidden h-[80vh] w-full rounded-sm border border-rule md:block"
          aria-label="Résumé PDF preview"
        >
          <p className="p-6 text-muted">
            Your browser can&apos;t preview PDFs. <a href={site.resume} className="underline">Download it instead.</a>
          </p>
        </object>
      </div>
    </>
  );
}
