import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/site/bits";
import { posts } from "@/lib/content";

export const metadata: Metadata = {
  title: "Writing",
  description: "Notes on agents, RAG, LLM systems and research by Rishabh Hota.",
};

export default function BlogPage() {
  return (
    <>
      <PageIntro label="Writing" title={<>Field notes from <em className="text-accent">the lab bench.</em></>}>
        Short write-ups on agents, retrieval, and making research run in production.
      </PageIntro>
      <ul className="mx-auto max-w-6xl divide-y divide-rule border-y border-rule px-5 sm:px-8">
        {posts.map((p) => (
          <li key={p.slug}>
            <Link href={`/blog/${p.slug}`} className="group grid gap-2 py-8 md:grid-cols-[10rem_1fr]">
              <span className="label pt-1.5">{p.date}</span>
              <div>
                <h2 className="font-serif text-3xl leading-tight transition-colors group-hover:text-accent">{p.title}</h2>
                <p className="mt-2 max-w-2xl text-muted">{p.summary}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
