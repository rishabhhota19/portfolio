// Pure chunking shared by the runtime retriever and scripts/ingest.ts (no server-only imports).
export type SourceDoc = { id: string; kind: string; title: string; url: string; text: string };

export type Chunk = {
  id: string;
  docId: string;
  title: string;
  url: string;
  kind: string;
  text: string;
};

/** Paragraph-aware, overlapping chunks (~900 chars). Each chunk repeats its title so it stands alone. */
export function chunkDocs(docs: SourceDoc[], size = 900, overlap = 150): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of docs) {
    const paragraphs = doc.text.split(/\n(?=\S)/);
    let current = "";
    let part = 0;
    const push = () => {
      if (!current.trim()) return;
      chunks.push({
        id: `${doc.id}#${part++}`,
        docId: doc.id,
        title: doc.title,
        url: doc.url,
        kind: doc.kind,
        text: `${doc.title}\n${current.trim()}`,
      });
    };
    for (const p of paragraphs) {
      if (current.length + p.length > size && current) {
        push();
        current = current.slice(-overlap);
      }
      current += `${p}\n`;
    }
    push();
  }
  return chunks;
}
