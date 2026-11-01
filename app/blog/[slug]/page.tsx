import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArticleSkeleton } from "@/components/site/bits";
import { getPost, posts } from "@/lib/content";

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound(); // a real 404 for unknown slugs
  return { title: post.title, description: post.summary };
}

// Shell outside Suspense (prefetched, instant), the URL-specific post inside — see app/projects/[slug]/page.tsx.
export default function PostPage({ params }: PageProps<"/blog/[slug]">) {
  return (
    <article className="mx-auto max-w-3xl px-5 pt-12 sm:px-8 sm:pt-16">
      <Link href="/blog" className="label link-underline hover:text-ink">
        ← All writing
      </Link>
      <Suspense fallback={<ArticleSkeleton />}>
        <Post params={params} />
      </Suspense>
    </article>
  );
}

async function Post({ params }: Pick<PageProps<"/blog/[slug]">, "params">) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <>
      <p className="label reveal mt-10">{post.date}</p>
      <h1 className="reveal mt-3 font-serif text-5xl leading-[1.04] sm:text-6xl" style={{ ["--i" as string]: 1 }}>
        {post.title}
      </h1>
      <p className="reveal mt-5 text-xl text-muted" style={{ ["--i" as string]: 2 }}>
        {post.summary}
      </p>
      <div
        className="prose-journal reveal mt-10 border-t border-rule pt-8"
        style={{ ["--i" as string]: 3 }}
        dangerouslySetInnerHTML={{ __html: post.html }}
      />
    </>
  );
}
