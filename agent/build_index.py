"""Builds the search data from the site content. Run after editing content/:

    npm run agent:index

1. chunks: every page split into ~900-character pieces (agent/data/chunks.json) — for FAISS and BM25.
2. with the shared embedding model (agent/embeddings.py), run locally — free, no quota, same vectors every time:
   the FAISS index of the chunks and the scope bank (agent/scope.py), in agent/data/embeddings/.
   Rebuilt only when the chunks, the examples or the model change (stamps.json).
"""

import asyncio
import hashlib
import json

import faiss
import numpy as np
from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import DATA_DIR
from .embeddings import ENGINES, FOLDER, MODEL
from .scope import IN_SCOPE, OUT_OF_SCOPE


def chunk_pages() -> list[dict]:
    docs = json.loads((DATA_DIR / "knowledge.json").read_text(encoding="utf-8"))["docs"]
    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)  # overlap: no fact cut in half
    return [
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


def main() -> None:
    chunks = chunk_pages()
    (DATA_DIR / "chunks.json").write_text(json.dumps(chunks, indent=1, ensure_ascii=False), encoding="utf-8")
    examples = IN_SCOPE + OUT_OF_SCOPE
    stamp = hashlib.sha1(json.dumps([MODEL, chunks, examples]).encode()).hexdigest()[:16]
    stamps = FOLDER / "stamps.json"
    if stamps.exists() and json.loads(stamps.read_text()).get("data") == stamp:
        print(f"Index and scope bank already up to date ({len(chunks)} chunks, {len(examples)} examples).")
        return

    local = ENGINES[0]
    vectors = asyncio.run(local.embed([c["text"] for c in chunks], timeout=60))
    index = faiss.IndexFlatIP(vectors.shape[1])  # inner product on unit vectors = cosine similarity
    index.add(vectors)
    faiss.write_index(index, str(FOLDER / "index.faiss"))
    labels = np.array([1] * len(IN_SCOPE) + [0] * len(OUT_OF_SCOPE), dtype="int8")
    np.savez(FOLDER / "scope.npz", vectors=asyncio.run(local.embed(examples, timeout=60)), labels=labels, texts=np.array(examples))
    stamps.write_text(json.dumps({"model": MODEL, "data": stamp}) + "\n")
    print(f"Indexed {len(chunks)} chunks + {len(examples)} scope examples with {MODEL} ({vectors.shape[1]}-dim) -> {FOLDER}")


if __name__ == "__main__":
    main()
