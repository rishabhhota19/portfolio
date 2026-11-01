"""Builds the FAISS index from the site content. Run after editing content/:

    npm run agent:index
"""

import json

import faiss
import numpy as np
from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import DATA_DIR
from .rag import embedder, normalize
from .scope import IN_SCOPE, OUT_OF_SCOPE


def embed_all(texts: list[str]) -> np.ndarray:
    return normalize(np.array(embedder().embed_documents(texts)))


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

    # Nothing changed since the last build? Skip the embedding API calls.
    saved = DATA_DIR / "chunks.json"
    model = DATA_DIR / "embedding_model.txt"  # a new embedding model means every vector must be rebuilt
    same_model = model.exists() and model.read_text().strip() == embedder().model
    if same_model and saved.exists() and (DATA_DIR / "index.faiss").exists() and json.loads(saved.read_text(encoding="utf-8")) == chunks:
        print(f"Index already up to date ({len(chunks)} chunks).")
        return

    # 2. Embed every chunk and store the vectors in a FAISS inner-product index.
    vectors = embed_all([c["text"] for c in chunks])
    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)

    faiss.write_index(index, str(DATA_DIR / "index.faiss"))
    (DATA_DIR / "chunks.json").write_text(json.dumps(chunks, indent=1, ensure_ascii=False), encoding="utf-8")
    model.write_text(embedder().model + "\n")
    print(f"Indexed {len(chunks)} chunks from {len(docs)} pages ({vectors.shape[1]}-dim vectors) -> agent/data/")


def build_scope() -> None:
    """Embeds the scope-check example banks (agent/scope.py) into agent/data/scope.npz, if they changed."""
    texts = IN_SCOPE + OUT_OF_SCOPE
    path = DATA_DIR / "scope.npz"
    if path.exists() and list(np.load(path)["texts"]) == texts and str(np.load(path)["model"]) == embedder().model:
        print(f"Scope bank already up to date ({len(texts)} examples).")
        return
    labels = np.array([1] * len(IN_SCOPE) + [0] * len(OUT_OF_SCOPE), dtype="int8")
    np.savez(path, vectors=embed_all(texts), labels=labels, texts=np.array(texts), model=embedder().model)
    print(f"Embedded the scope bank: {len(IN_SCOPE)} in-scope + {len(OUT_OF_SCOPE)} off-topic examples -> {path.name}")


if __name__ == "__main__":
    main()
    build_scope()
