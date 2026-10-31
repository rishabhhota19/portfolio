"""Builds the FAISS index from the site content. Run after editing content/:

    npm run agent:index
"""

import json

import faiss
from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import DATA_DIR
from .rag import embedder, normalize


def main() -> None:
    docs = json.loads((DATA_DIR / "knowledge.json").read_text(encoding="utf-8"))["docs"]

    # 1. Split each page into ~900-character chunks (overlapping, so no fact is cut in half).
    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)
    chunks = [
        {
            "id": f"{doc['id']}#{i}",
            "title": doc["title"],
            "url": doc["url"],
            "text": f"{doc['title']}\n{piece}",  # title on every chunk so it makes sense alone
            "keywords": doc.get("keywords", []),
        }
        for doc in docs
        for i, piece in enumerate(splitter.split_text(doc["text"]))
    ]

    # 2. Embed every chunk and store the vectors in a FAISS inner-product index.
    vectors = normalize(embedder().embed_documents([c["text"] for c in chunks]))
    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)

    faiss.write_index(index, str(DATA_DIR / "index.faiss"))
    (DATA_DIR / "chunks.json").write_text(json.dumps(chunks, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Indexed {len(chunks)} chunks from {len(docs)} pages ({vectors.shape[1]}-dim vectors) -> agent/data/")


if __name__ == "__main__":
    main()
