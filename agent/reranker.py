"""The second vote on the first stage's order: a small cross-encoder reads the question and each passage together.

    question + the first stage's 8 chunks ─► cross-encoder/ms-marco-TinyBERT-L-2-v2 (int8 ONNX, 4 MB) scores each pair
                                           ─► its order is fused with the first stage's, 1:2 (rag.rerank) ─► top 6

Why a vote and not the decision: measured 19 Nov 2026 on 24 questions (10 about a whole section, 14 naming one page)
with eight cross-encoders in int8 — bge-reranker-base (the one Cloudflare hosts), MiniLM L-2/L-4/L-6, TinyBERT L-2,
Jina tiny and turbo, mxbai-xsmall. Deciding the order alone, every one ranked worse than the embedding model's own
order (MRR 0.81–0.93 against 1.000): small MS MARCO rerankers put the "new research, turned into a working demo"
service first on research questions. Fused with the first stage, the first stage counting double, none cost a rank 1
and the section questions stayed at 10/10: the cross-encoder breaks near-ties and cannot overrule a clear first stage.
TinyBERT does that for 4 MB and about 25 ms per question on one CPU core; the others cost 5–80× more for the same
result. evals/rerank_ab.py re-measures it against the first stage alone.

The model shares the embedding model's WordPiece vocabulary (bert-base-uncased), so agent/wordpiece.py tokenizes the
pairs with the tokenizer file already shipped. If the model cannot load or run, the first stage's order stands and this
server instance stops trying. Model: https://huggingface.co/cross-encoder/ms-marco-TinyBERT-L-2-v2 (Apache-2.0), int8
export https://huggingface.co/Xenova/ms-marco-TinyBERT-L-2-v2.
"""

import asyncio
from functools import lru_cache

import numpy as np

from .config import DATA_DIR
from .embeddings import FOLDER as TOKENIZER_FOLDER

MODEL = "cross-encoder/ms-marco-TinyBERT-L-2-v2"
FILE = DATA_DIR / "reranker" / "model_quantized.onnx"

_off = False  # the model failed once on this instance: the first stage's order stands from then on


async def order(question: str, texts: list[str]) -> list[int] | None:
    """The cross-encoder's order of these texts for the question (positions, best first), or None when it cannot run."""
    global _off
    if _off or not texts or not FILE.exists():
        return None
    try:
        scores = await asyncio.to_thread(_scores, question, tuple(texts))
    except Exception as err:
        _off = True
        print(f"[reranker] off for this instance ({type(err).__name__}: {err}); the first stage's order stands")
        return None
    return [int(i) for i in np.argsort(-scores, kind="stable")]


@lru_cache
def _session():
    """The model, loaded once per server instance, on one thread — a function has one vCPU."""
    import onnxruntime as ort  # imported on first use

    from .wordpiece import WordPiece

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    return WordPiece(TOKENIZER_FOLDER / "tokenizer.json"), ort.InferenceSession(str(FILE), options, providers=["CPUExecutionProvider"])


def _scores(question: str, texts: tuple[str, ...]) -> np.ndarray:
    tokenizer, session = _session()
    ids, mask, segments = tokenizer.pairs(question, list(texts))
    logits = session.run(None, {"input_ids": np.array(ids, dtype="int64"), "attention_mask": np.array(mask, dtype="int64"),
                                "token_type_ids": np.array(segments, dtype="int64")})[0]
    return logits.reshape(len(texts), -1)[:, 0]  # one relevance logit a pair
