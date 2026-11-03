// How a visit is classified, shared by the Next.js routes and the analytics Worker (cloudflare/analytics/), so both
// count the same way. No imports: the Worker bundles this file as it is.

/** User agents that are never counted as visitors. */
export const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|curl|wget|python-requests/i;

export const deviceType = (ua: string) => (/iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop");

const SOURCES: [RegExp, string][] = [
  [/linkedin|lnkd\.in/, "LinkedIn"],
  [/google\./, "Google"],
  [/bing\.|duckduckgo|yahoo\./, "Search (other)"],
  [/chatgpt|openai|perplexity|claude\.ai|gemini\.google/, "AI assistant"],
  [/github/, "GitHub"],
  [/naukri|indeed|wellfound|instahyre/, "Job board"],
  [/^t\.co$|twitter|x\.com/, "X / Twitter"],
  [/mail\.|outlook/, "Email"],
];

/** Where the visit came from: a campaign tag if the link had one, else the referring site, else "Direct". */
export function sourceOf(referrer: string, utm: string) {
  if (utm) return `Campaign: ${utm.split(" / ")[0]}`;
  if (!referrer) return "Direct";
  return SOURCES.find(([pattern]) => pattern.test(referrer))?.[1] ?? referrer;
}
