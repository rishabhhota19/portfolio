import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-28 text-center sm:px-8">
      <p className="label">Error 404 · p &lt; 0.05</p>
      <h1 className="mt-4 font-serif text-6xl leading-none">
        This page <em className="text-accent">failed to replicate.</em>
      </h1>
      <p className="mt-5 text-muted">It may have moved, or it never existed.</p>
      <Link href="/" className="mt-8 inline-block rounded-full bg-ink px-5 py-3 text-paper">
        Back to the homepage
      </Link>
    </div>
  );
}
