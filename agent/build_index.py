"""Builds the search data from the site content. Run after editing content/:

    npm run agent:index

1. chunks: every page split into ~900-character pieces (agent/data/chunks.json) — shared by all engines and BM25.
2. per embedding engine (agent/embeddings.py), in agent/data/embeddings/<engine>/: a FAISS index of the chunks and
   the scope bank (agent/scope.py) with that engine's thresholds. Each part has a stamp and is rebuilt only when its
   inputs change. An engine that can't be built right now (no key, out of quota) keeps what still matches the
   chunks; vectors that don't match are deleted, which switches the engine off until a later build succeeds.
"""

import asyncio
import hashlib
import json
import shutil

import faiss
import numpy as np
from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import DATA_DIR
from .embeddings import ENGINES, PRIMARY, Engine
from .scope import IN_SCOPE, OUT_OF_SCOPE, calibrate

LABELS = np.array([1] * len(IN_SCOPE) + [0] * len(OUT_OF_SCOPE), dtype="int8")
CALIBRATION = ("margin", "about_margin", "relevant", "spread", "relevant_pct")


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


def stamp(*parts) -> str:
    return hashlib.sha1(json.dumps(parts).encode()).hexdigest()[:16]


def build(engine: Engine, chunks: list[dict], reference: dict | None) -> None:
    folder = engine.folder
    stamps_file = folder / "stamps.json"
    old = json.loads(stamps_file.read_text()) if stamps_file.exists() else {}
    texts = IN_SCOPE + OUT_OF_SCOPE
    want = {"index": stamp(engine.model, chunks),
            "scope": stamp(engine.model, chunks, texts, reference and [reference[k] for k in CALIBRATION])}
    if old == want:
        print(f"{engine.name}: up to date")
        return
    try:
        if old.get("index") != want["index"]:
            vectors = asyncio.run(engine.embed([c["text"] for c in chunks], timeout=60))
            index = faiss.IndexFlatIP(vectors.shape[1])
            index.add(vectors)
            folder.mkdir(parents=True, exist_ok=True)
            faiss.write_index(index, str(folder / "index.faiss"))
            old["index"] = want["index"]
        if old.get("scope") != want["scope"] and (engine == PRIMARY or reference):
            bank = asyncio.run(engine.embed(texts, timeout=60))
            relevance = faiss.read_index(str(folder / "index.faiss")).search(bank, 1)[0][:, 0]  # nearest chunk
            thresholds = calibrate(bank, LABELS, relevance, None if engine == PRIMARY else reference)
            np.savez(folder / "scope.npz", vectors=bank, labels=LABELS, texts=np.array(texts), **thresholds)
            old["scope"] = want["scope"]
            print(f"{engine.name}: scope margin {thresholds['margin']:.3f} / about him {thresholds['about_margin']:.3f} "
                  f"/ relevant {thresholds['relevant']:.2f}")
        print(f"{engine.name}: built ({len(chunks)} chunks)")
    except Exception as err:
        print(f"{engine.name}: can't build now ({type(err).__name__}: {str(err)[:80]})")
        if old.get("index") != want["index"]:  # its vectors don't match today's chunks: never serve them
            for name in ("index.faiss", "scope.npz"):
                (folder / name).unlink(missing_ok=True)
            old = {}
            print(f"{engine.name}: switched off until a build succeeds")
    if old:
        stamps_file.write_text(json.dumps(old) + "\n")
    else:
        stamps_file.unlink(missing_ok=True)


def reference_calibration() -> dict | None:
    """The primary engine's scope calibration — the others' thresholds are scaled from it."""
    path = PRIMARY.folder / "scope.npz"
    if not path.exists():
        return None
    with np.load(path) as data:
        return {k: float(data[k]) for k in CALIBRATION}


def main() -> None:
    chunks = chunk_pages()
    (DATA_DIR / "chunks.json").write_text(json.dumps(chunks, indent=1, ensure_ascii=False), encoding="utf-8")
    build(PRIMARY, chunks, None)
    reference = reference_calibration()
    for engine in ENGINES[1:]:
        build(engine, chunks, reference)
    known = {e.name for e in ENGINES}
    for folder in (DATA_DIR / "embeddings").iterdir():  # an engine removed from the list: drop its data
        if folder.is_dir() and folder.name not in known:
            shutil.rmtree(folder)


if __name__ == "__main__":
    main()
