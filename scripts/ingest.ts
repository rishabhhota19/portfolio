// RAG ingestion: chunks lib/generated/knowledge.json and upserts it into Upstash Vector.
// The index must be created with a built-in embedding model (e.g. BAAI/bge-small-en-v1.5),
// so we send raw text and Upstash embeds it — no separate embedding API needed.
//
//   npm run ingest                 # rebuild content, then sync the index
//   ... ingest.ts --if-configured  # (prebuild on Vercel) skip quietly when Vector isn't set up yet
//
// Needs UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN (in .env.local or the environment).
import fs from "node:fs";
import path from "node:path";
import { Index } from "@upstash/vector";
import { chunkDocs, type SourceDoc } from "../lib/agent/chunk";

const optional = process.argv.includes("--if-configured");
const url = process.env.UPSTASH_VECTOR_REST_URL;
const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
if (!url || !token) {
  if (optional) {
    console.log("ingest: Upstash Vector not configured — skipping (the agent uses lexical search).");
    process.exit(0);
  }
  console.error("Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN first (see .env.example).");
  process.exit(1);
}

const knowledge = JSON.parse(fs.readFileSync(path.join(process.cwd(), "lib/generated/knowledge.json"), "utf8")) as {
  docs: SourceDoc[];
};

async function main() {
  const index = new Index({ url: url!, token: token! });
  const chunks = chunkDocs(knowledge.docs).map((c) => ({
    id: c.id,
    data: c.text,
    metadata: { docId: c.docId, title: c.title, url: c.url, kind: c.kind },
  }));

  // Upsert first (same IDs overwrite), then delete stale chunks — the live site never sees an empty index.
  for (let i = 0; i < chunks.length; i += 50) {
    await index.upsert(chunks.slice(i, i + 50));
  }

  const keep = new Set(chunks.map((c) => c.id));
  const stale: string[] = [];
  let cursor: string = "0";
  do {
    const page: Awaited<ReturnType<typeof index.range>> = await index.range({ cursor, limit: 100 });
    for (const v of page.vectors) if (!keep.has(String(v.id))) stale.push(String(v.id));
    cursor = page.nextCursor;
  } while (cursor && cursor !== "0");
  if (stale.length) await index.delete(stale);

  const info = await index.info();
  console.log(
    `ingest: upserted ${chunks.length} chunks from ${knowledge.docs.length} docs, removed ${stale.length} stale; index holds ${info.vectorCount} vectors.`,
  );

  const probe = await index.query({ data: "What is his strongest agentic AI project?", topK: 3 });
  console.log(`ingest: probe → ${probe.map((h) => `${String(h.id)} (${h.score.toFixed(2)})`).join(", ")}`);
}

main().catch((err) => {
  console.error("ingest failed:", err);
  // Never block a deploy on indexing; the retriever falls back to lexical search.
  process.exit(optional ? 0 : 1);
});
