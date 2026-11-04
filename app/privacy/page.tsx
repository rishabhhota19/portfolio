import type { Metadata } from "next";
import { PageIntro } from "@/components/site/bits";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What this site records about visits and chats, why, and for how long.",
};

export default function PrivacyPage() {
  return (
    <>
      <PageIntro label="Privacy" title={<>What this site <em className="text-accent">records.</em></>}>
        Plain and short: what is kept about your visit, why, and for how long.
      </PageIntro>
      <div className="prose-journal mx-auto max-w-3xl px-5 sm:px-8">
        <h2>Every visit</h2>
        <p>
          To understand who reads this portfolio, each visit is logged once in Rishabh&apos;s private Google Sheet: the
          pages you open and for how long, which links you click (résumé, LinkedIn, GitHub, email), where you came from
          (for example LinkedIn or Google — the site only, never the full link), your approximate location (city, from
          your IP address), the network you are on (your company or internet provider, looked up from the IP via
          IPinfo), your device type, browser, screen size and language, and your IP address.
        </p>
        <p>
          Your IP address is deleted from the sheet after 90 days; a one-way hash of it is kept to recognise repeat
          visits and stop abuse. No cookies are used for this — the visit is tied to your browser tab and forgotten
          when you close it.
        </p>

        <h2>If you chat with the agent (Dumbledore)</h2>
        <p>
          Your messages go to the free AI services that power the agent: Cloudflare Workers AI turns each question into
          numbers to find the relevant parts of this site, and one model on Groq, Google Gemini, Cloudflare Workers AI or
          OpenRouter writes the answer. They are not stored by this site. While a chat is open, the agent keeps a short
          working memory of it (the topics you asked about and which pages answered them, not your messages) for up to
          two hours, so it can follow the conversation; it is deleted when the chat ends. Answers to common first
          questions are cached for a day, keyed by a one-way hash of the question, never the question itself. When the
          chat ends, only a short AI-written summary of what you asked is added to the visit&apos;s row, along with
          how many tokens the chat used.
        </p>

        <h2>If you share your details</h2>
        <p>
          The name, email, company, role, phone number (optional) and note you type into “Share your details” go into
          the same row, and Rishabh gets an email so he can reply. Nothing else about you is ever looked up.
        </p>

        <h2>Analytics and errors</h2>
        <p>
          The same visit details, chat summaries and shared details also go to Rishabh&apos;s private dashboard on this
          site (signed in, not public), kept on Cloudflare: daily counts for 40 days, the activity feed until newer
          events replace it, and shared details for up to 90 days. While a tab is open the site sends a small
          &ldquo;still here&rdquo; signal every 30 seconds to that Cloudflare service so the dashboard can show who is
          on the site right now; your network address is kept only as a salted hash, in memory, to limit how often it
          can send one.
        </p>
        <p>
          Cookieless page statistics come from Cloudflare Web Analytics and Umami; your browser&apos;s “Do Not Track”
          setting is respected by Umami. Errors are reported to Sentry without chat text or personal details. Hosting is
          on Vercel, with large images and videos served by Cloudflare; rate limits and token counts are kept briefly in
          Upstash Redis.
        </p>

        <h2>Questions or deletion</h2>
        <p>
          Email <a href={`mailto:${site.email}`}>{site.email}</a> and your rows will be deleted.
        </p>
      </div>
    </>
  );
}
