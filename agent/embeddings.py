"""Embeddings with fallbacks: four engines, then keyword search — the chat never waits on one provider.

    question ─► EmbeddingGemma (Cloudflare) ─► Gemini ─► bge-m3 (Cloudflare) ─► bge-small (this function's CPU) ─► BM25

A vector only means something next to vectors from the SAME model, so each engine has its own copy of the search
index and the scope bank (agent/data/embeddings/<engine>/, built by `python -m agent.build_index`). Remote engines
use the chat models' budget and pause logic (usage.py, router.on_error): Gemini's 1,000 free requests a day are
counted in Redis, and a failing engine is skipped for a while, so visitors don't each wait for its timeout.
The last engine is an open-source model (BAAI/bge-small-en-v1.5, int8 ONNX from Hugging Face) run on the function's
own CPU: no key, no quota, ~4 ms a question. EMBEDDING_ENGINES=gemini,bge-small limits the list (outage drills).
"""

import asyncio
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from langchain_openai import OpenAIEmbeddings

from . import router, usage
from .config import DATA_DIR, env
from .llm import PROVIDERS, FreeModel


@dataclass(frozen=True)
class Engine:
    name: str  # its folder under agent/data/embeddings/
    model: str
    remote: FreeModel | None = None  # a hosted model: its free limits and pauses, like a chat model
    dims: int | None = None  # ask for shorter vectors (Gemini's are 3,072 by default)

    @property
    def folder(self) -> Path:
        return DATA_DIR / "embeddings" / self.name

    @property
    def ready(self) -> bool:
        """Built (its index exists) and usable (a key, or nothing needed)."""
        return (self.folder / "index.faiss").exists() and (self.remote is None or self.remote.available)

    async def embed(self, texts: list[str], timeout: float = 5) -> np.ndarray:
        if self.remote is None:
            return await asyncio.to_thread(_local, tuple(texts))
        base_url, key = PROVIDERS[self.remote.provider]
        client = OpenAIEmbeddings(
            model=self.model, api_key=env(key, "missing"), base_url=base_url.format(CF_ACCOUNT_ID=env("CF_ACCOUNT_ID")),
            dimensions=self.dims, check_embedding_ctx_length=False,  # not OpenAI models: skip OpenAI's token counting
            chunk_size=50, timeout=timeout, max_retries=0,  # slow or down → the next engine, straight away
        )
        return normalize(await client.aembed_documents(texts))


ENGINES = [
    # Best on this site's evals (cleanest on-topic vs off-topic split, multilingual). Free: a sliver of 10,000 neurons/day.
    Engine("embeddinggemma", "@cf/google/embeddinggemma-300m", FreeModel("cloudflare", "@cf/google/embeddinggemma-300m", 3000)),
    # Another provider, so a Cloudflare outage can't take every engine down. Free: 1,000 requests/day (we stop at 950).
    Engine("gemini", "gemini-embedding-001", FreeModel("gemini", "gemini-embedding-001", 90, 950), dims=768),
    # A second Cloudflare model: covers EmbeddingGemma (in beta) being changed or withdrawn.
    Engine("bge-m3", "@cf/baai/bge-m3", FreeModel("cloudflare", "@cf/baai/bge-m3", 3000)),
    # Open source, runs here: the engine that can't run out.
    Engine("bge-small", "Xenova/bge-small-en-v1.5"),
]
PRIMARY = ENGINES[0]  # the answer bank's vectors are built with it


def normalize(vectors) -> np.ndarray:
    """Unit-length vectors, so inner product = cosine similarity."""
    vectors = np.asarray(vectors, dtype="float32")
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


def usable() -> list[Engine]:
    only = [n.strip() for n in env("EMBEDDING_ENGINES").split(",") if n.strip()]
    return [e for e in ENGINES if e.ready and (not only or e.name in only)]


async def embed(texts: list[str]) -> tuple[Engine | None, np.ndarray | None]:
    """The first engine that answers, and its unit vectors; (None, None) if all are down (keyword search still works)."""
    for engine in usable():
        if engine.remote:
            booked, _ = await usage.reserve(engine.remote, 0, paced=False)
            if booked is None:
                continue  # paused after an error, or out of free requests for now
        try:
            return engine, await engine.embed(texts)
        except Exception as err:
            if engine.remote:
                await router.on_error(engine.remote, err)  # pauses it: the next visitors skip it at once
            print(f"[embeddings] {engine.name} failed ({type(err).__name__}): trying the next engine")
    return None, None


@lru_cache
def _session():
    """The local model, loaded once per server instance (0.2 s), on one thread — a function has one vCPU."""
    import onnxruntime as ort  # imported only if the remote engines are all down
    from tokenizers import Tokenizer

    folder = next(e for e in ENGINES if e.remote is None).folder
    tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
    tokenizer.enable_truncation(512)
    tokenizer.enable_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    return tokenizer, ort.InferenceSession(str(folder / "model_quantized.onnx"), options, providers=["CPUExecutionProvider"])


def _local(texts: tuple[str, ...]) -> np.ndarray:
    tokenizer, session = _session()
    encoded = tokenizer.encode_batch(list(texts))
    ids = np.array([e.ids for e in encoded], dtype="int64")
    mask = np.array([e.attention_mask for e in encoded], dtype="int64")
    hidden = session.run(None, {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)})[0]
    return normalize(hidden[:, 0])  # BGE models use the first ([CLS]) token as the sentence vector
