import "server-only";
import knowledge from "@/lib/generated/knowledge.json";
import { chunkDocs, type Chunk } from "./chunk";

export type { Chunk };

export type KnowledgeDoc = (typeof knowledge.docs)[number];

export const coreProfile: string = knowledge.core;
export const docs: KnowledgeDoc[] = knowledge.docs;

let cachedChunks: Chunk[] | null = null;
export function allChunks() {
  return (cachedChunks ??= chunkDocs(docs));
}

const STOP = new Set(
  "a an and are about can could did do does for from give has have he him his how i in is it me of on or rishabh rishabh's tell than that the their them this to was what when where which who why with would you your".split(
    " ",
  ),
);

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\- ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

/**
 * Lexical fallback retriever (BM25-flavoured) used when Upstash Vector isn't configured
 * or is unreachable, so the agent always has grounded context.
 */
export function lexicalSearch(query: string, k = 4): Chunk[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const chunks = allChunks();
  const keywordsByDoc = new Map(docs.map((d) => [d.id, d.keywords.join(" ").toLowerCase()]));
  const df = new Map<string, number>();
  const tokenized = chunks.map((c) => {
    const toks = tokenize(c.text);
    new Set(toks).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1));
    return toks;
  });
  const N = chunks.length;
  const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / N;

  return chunks
    .map((chunk, i) => {
      const toks = tokenized[i];
      const keywords = keywordsByDoc.get(chunk.docId) ?? "";
      let score = 0;
      for (const term of terms) {
        const tf = toks.filter((t) => t === term).length;
        const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (toks.length / avgLen)));
        if (keywords.includes(term)) score += 1.5; // curated keywords boost
      }
      return { chunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.chunk);
}
