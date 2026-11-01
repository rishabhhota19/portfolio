"""Embeddings: ONE open-source model served two ways, so every route shares ONE set of vectors.

    question ─► BAAI/bge-small-en-v1.5 on this function's CPU (int8 ONNX from Hugging Face: ~3 ms, no key, no quota)
             ─► the same model on Cloudflare Workers AI, if the local copy can't run
             ─► keyword search (BM25) only, if both are down

Vectors only compare within one model, so serving one model from two places means one index, one scope bank and one
answer bank behind every route (agent/data/embeddings/, built by `python -m agent.build_index`). Both routes use the
model's own pooling (the [CLS] token). Chosen on this site's evals: the same retrieval as EmbeddingGemma (14/14), scope
separation AUC 0.93 vs 0.94, about 100x faster than a network call, and it can't run into a daily limit.
EMBEDDING_ROUTES=cloudflare limits the routes (outage drills).
"""

import asyncio
from dataclasses import dataclass
from functools import lru_cache

import httpx
import numpy as np

from . import router, usage
from .config import DATA_DIR, env
from .llm import FreeModel

MODEL = "BAAI/bge-small-en-v1.5"
FOLDER = DATA_DIR / "embeddings"  # model files, index.faiss, scope.npz, stamps.json


@dataclass(frozen=True)
class Engine:
    """One way to run the model."""

    name: str
    model: str
    remote: FreeModel | None = None  # hosted: its free limits and pauses, like a chat model; None = runs here

    @property
    def ready(self) -> bool:
        built = (FOLDER / "index.faiss").exists()
        return built and ((FOLDER / "model_quantized.onnx").exists() if self.remote is None else self.remote.available)

    async def embed(self, texts: list[str], timeout: float = 5) -> np.ndarray:
        if self.remote is None:
            return await asyncio.to_thread(_local, tuple(texts))
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(
                f"https://api.cloudflare.com/client/v4/accounts/{env('CF_ACCOUNT_ID')}/ai/run/{self.model}",
                headers={"Authorization": f"Bearer {env('CF_WORKERS_AI_TOKEN')}"},
                json={"text": texts, "pooling": "cls"},  # Cloudflare's default is mean pooling: not the same vectors
            )
        res.raise_for_status()
        return normalize(res.json()["result"]["data"])


ENGINES = [
    Engine("local", MODEL),
    # Workers AI: 3,000 requests/min; ~1,841 neurons per million tokens, booked against the shared 10,000/day.
    Engine("cloudflare", "@cf/baai/bge-small-en-v1.5", FreeModel("cloudflare", "@cf/baai/bge-small-en-v1.5", 3000, neurons=(1_841, 0))),
]


def normalize(vectors) -> np.ndarray:
    """Unit-length vectors, so inner product = cosine similarity."""
    vectors = np.asarray(vectors, dtype="float32")
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


def usable() -> list[Engine]:
    only = [n.strip() for n in env("EMBEDDING_ROUTES").split(",") if n.strip()]
    return [e for e in ENGINES if e.ready and (not only or e.name in only)]


async def embed(texts: list[str]) -> tuple[Engine | None, np.ndarray | None]:
    """The route that answered and the unit vectors; (None, None) if every route is down (keyword search still works)."""
    for engine in usable():
        if engine.remote:
            neurons = engine.remote.neurons_for(sum(len(t) for t in texts) // 4 + 1, 0)
            booked, _ = await usage.reserve(engine.remote, 0, neurons, paced=False)
            if booked is None:
                continue  # paused after an error, or the shared neuron pool is used up for now
        elif (await usage.get(f"embeddings-{engine.name}"))["paused"]:
            continue
        try:
            return engine, await engine.embed(texts)
        except Exception as err:
            if engine.remote:
                await router.on_error(engine.remote, err)  # pauses it: the next visitors skip it at once
            else:  # e.g. the runtime failed to load: don't retry it on every question
                await usage.pause(f"paused:embeddings-{engine.name}", 300)
            print(f"[embeddings] {engine.name} failed ({type(err).__name__}): trying the next route")
    return None, None


@lru_cache
def _session():
    """The local model, loaded once per server instance (~0.2 s), on one thread — a function has one vCPU."""
    import onnxruntime as ort  # imported on first use
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(FOLDER / "tokenizer.json"))
    tokenizer.enable_truncation(512)
    tokenizer.enable_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    return tokenizer, ort.InferenceSession(str(FOLDER / "model_quantized.onnx"), options, providers=["CPUExecutionProvider"])


def _local(texts: tuple[str, ...]) -> np.ndarray:
    tokenizer, session = _session()
    encoded = tokenizer.encode_batch(list(texts))
    ids = np.array([e.ids for e in encoded], dtype="int64")
    mask = np.array([e.attention_mask for e in encoded], dtype="int64")
    hidden = session.run(None, {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)})[0]
    return normalize(hidden[:, 0])  # BGE models use the first ([CLS]) token as the sentence vector
