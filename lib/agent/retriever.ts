import "server-only";
import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { Index } from "@upstash/vector";
import { lexicalSearch } from "./knowledge";

type ChunkMeta = { docId: string; title: string; url: string; kind: string };

const MIN_SCORE = Number(process.env.RAG_MIN_SCORE ?? 0.72);

/**
 * RAG retriever over the site's own content.
 * Primary: Upstash Vector semantic search (the index embeds text itself — see scripts/ingest.ts).
 * Fallback: an in-process lexical search, used when Vector isn't configured, errors, or finds
 * nothing above MIN_SCORE — so the agent always answers from grounded context.
 */
export class PortfolioRetriever extends BaseRetriever {
  lc_namespace = ["portfolio", "retrievers"];

  private index: Index<ChunkMeta> | null;
  private k: number;

  constructor(k = 5) {
    super();
    this.k = k;
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
    this.index = url && token ? new Index<ChunkMeta>({ url, token }) : null;
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    if (!query.trim()) return [];

    if (this.index) {
      try {
        const hits = await this.index.query({ data: query, topK: this.k, includeMetadata: true, includeData: true });
        const relevant = hits.filter((h) => h.score >= MIN_SCORE && h.data && h.metadata);
        if (relevant.length) {
          return relevant.map(
            (h) =>
              new Document({
                id: String(h.id),
                pageContent: h.data as string,
                metadata: { ...h.metadata, score: Number(h.score.toFixed(3)), source: "vector" },
              }),
          );
        }
      } catch (err) {
        console.warn("[rag] vector search failed — falling back to lexical search:", err);
      }
    }

    return lexicalSearch(query, this.k - 1).map(
      (c) =>
        new Document({
          id: c.id,
          pageContent: c.text,
          metadata: { docId: c.docId, title: c.title, url: c.url, kind: c.kind, source: "lexical" },
        }),
    );
  }
}

export const retriever = new PortfolioRetriever();
