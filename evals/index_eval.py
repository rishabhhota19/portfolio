"""Is the agent's vector search (agent/rag.py, one NumPy matrix product) the same as the FAISS index it replaced?

    python -m evals.index_eval            # needs faiss-cpu (requirements-dev.txt); no API calls

Every question in the eval files is embedded with the local model and searched both ways: the same chunks must come
back in the same order with the same scores. Also checks that index.npy holds one unit vector for each chunk.
"""

import json
import sys
from pathlib import Path

import faiss
import numpy as np

from agent import embeddings, rag

HERE = Path(__file__).parent
K = 8  # what rag.search asks for


def questions() -> list[str]:
    found = []
    for name in ("scope.json", "questions.json", "advocacy.json", "showing.json", "navigation.json"):
        path = HERE / name
        if path.exists():
            found += [case["q"] for case in json.loads(path.read_text(encoding="utf-8")) if isinstance(case, dict) and case.get("q")]
    return sorted(set(found))


def main() -> int:
    vectors = rag.index()
    chunks, _ = rag.load()
    norms = np.linalg.norm(vectors, axis=1)
    shaped = vectors.shape[0] == len(chunks) and vectors.dtype == np.float32 and bool(np.allclose(norms, 1.0, atol=1e-4))
    print(f"{'ok  ' if shaped else 'FAIL'} index.npy: {vectors.shape[0]} unit vectors of {vectors.shape[1]} numbers for {len(chunks)} chunks")

    reference = faiss.IndexFlatIP(vectors.shape[1])  # inner product on unit vectors = cosine similarity
    reference.add(vectors)
    asked = questions()
    different = []
    for start in range(0, len(asked), 32):
        batch = asked[start:start + 32]
        for question, vector in zip(batch, embeddings._local(tuple(batch))):
            scores, ids = reference.search(vector.reshape(1, -1).astype("float32"), K)
            ours, closeness = rag.nearest(vector, K)
            if ours != [int(i) for i in ids[0]] or not np.allclose(closeness, scores[0], atol=1e-5):
                different.append(question)
    print(f"{'ok  ' if not different else 'FAIL'} {len(asked)} eval questions: {len(different)} got different chunks, order or scores from FAISS")
    for question in different[:5]:
        print(f"     {question[:90]!r}")
    print(f"\nvector search: {'the same as FAISS' if shaped and not different else 'DIFFERENT'}")
    return 0 if shaped and not different else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.exit(main())
