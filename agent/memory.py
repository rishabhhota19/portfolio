"""Session memory: what Dumbledore keeps for one conversation, whichever model or server answers the next turn.

The browser still sends the transcript each turn and nothing of the chat is stored as text. Per conversation the
agent keeps a compact working memory in Redis (two hours, deleted at End chat):
  points   each point researched so far → the evidence ids and a one-line note, so the same requirement isn't
           searched twice and the writer can be reminded of it without re-sending the chunks
  summary  one line per earlier turn — compaction, not truncation: a job description pasted at turn 1 is still
           known at turn 20, while the model prompt keeps only the last few messages word for word
  tokens   the conversation's spend so far, for economy mode (graph.py)
It's plain JSON, so any model continues it, any Vercel instance reads it, and when Redis is unreachable the agent
answers from the transcript alone, as it did before memory existed.
"""

import json
import re
import time
from dataclasses import asdict, dataclass, field

from .usage import _client as redis_client

TTL = 7_200  # seconds a conversation's memory lives after its last turn
MAX_POINTS = 40
MAX_SUMMARY = 16  # earlier turns kept, one line each
MAX_NOTE = 160  # characters per evidence note
ECONOMY_TOKENS = 60_000  # a conversation past this spend runs in economy mode: no planner, shorter answers


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", text.casefold()).split())


@dataclass
class Memory:
    points: dict[str, dict] = field(default_factory=dict)  # point → {"ids": [chunk ids], "note": "…"}
    summary: list[str] = field(default_factory=list)
    turns: int = 0
    tokens: int = 0

    @property
    def economy(self) -> bool:
        return self.tokens >= ECONOMY_TOKENS

    def known(self, point: str) -> dict | None:
        """Evidence already found for this point, or one worded nearly the same."""
        key = _norm(point)
        for name, found in self.points.items():
            other = _norm(name)
            if other == key or (len(key) > 8 and len(other) > 8 and (key in other or other in key)):
                return found
        return None

    def notes(self, this_turn: list[str] = ()) -> str:
        """The block the writer sees: the earlier turns, then every point researched so far, this turn's first."""
        lines = []
        if self.summary:
            lines.append("Earlier in this chat:")
            lines += [f"- {line}" for line in self.summary[-MAX_SUMMARY:]]
        if self.points:
            lines.append("Points researched on his site (ids refer to CONTEXT):")
            ordered = [p for p in this_turn if p in self.points] + [p for p in self.points if p not in this_turn]
            for point in ordered[:MAX_POINTS]:
                found = self.points[point]
                ids = ", ".join(found.get("ids", [])) or "not on the site"
                lines.append(f"- {point}: {ids}" + (f" — {found['note']}" if found.get("note") else ""))
        return "\n".join(lines)

    def remember(self, question: str, points: dict[str, dict], tokens: int) -> None:
        """Folds a finished turn in: its points, one summary line, the spend. The oldest go first when full."""
        for point, found in points.items():
            self.points[point[:80]] = {"ids": list(found.get("ids", []))[:4], "note": (found.get("note") or "")[:MAX_NOTE]}
        while len(self.points) > MAX_POINTS:
            del self.points[next(iter(self.points))]
        self.turns += 1
        self.tokens += max(tokens, 0)
        asked = " ".join(question.split())[:140]
        self.summary.append(f'Turn {self.turns}: asked "{asked}"' + (f" → {', '.join(list(points)[:4])}" if points else ""))
        del self.summary[:-MAX_SUMMARY]


_local: dict[str, tuple[str, float]] = {}  # key → (json, expires at): this process only, when Redis isn't there


def _key(conversation_id: str) -> str | None:
    return f"mem:{conversation_id}" if re.fullmatch(r"[\w-]{8,64}", conversation_id or "") else None


def _parse(raw: str) -> Memory:
    try:
        data = json.loads(raw)
        return Memory(points=dict(data.get("points") or {}), summary=list(data.get("summary") or []),
                      turns=int(data.get("turns") or 0), tokens=int(data.get("tokens") or 0))
    except (ValueError, TypeError, AttributeError):
        return Memory()


async def load(conversation_id: str) -> Memory:
    key, redis = _key(conversation_id), redis_client()
    if not key:
        return Memory()
    if redis:
        try:
            raw = await redis.get(key)
            return _parse(raw) if raw else Memory()
        except Exception as err:
            print(f"[memory] redis read failed: {err}")
    raw, expires = _local.get(key, ("", 0.0))
    return _parse(raw) if raw and expires > time.time() else Memory()


async def save(conversation_id: str, memory: Memory) -> None:
    key, redis = _key(conversation_id), redis_client()
    if not key:
        return
    raw = json.dumps(asdict(memory), ensure_ascii=False)
    if redis:
        try:
            await redis.set(key, raw, ex=TTL)
            return
        except Exception as err:
            print(f"[memory] redis write failed: {err}")
    if len(_local) > 2000:
        _local.clear()
    _local[key] = (raw, time.time() + TTL)


async def forget(conversation_id: str) -> None:
    """End chat: the working memory goes with the conversation."""
    key, redis = _key(conversation_id), redis_client()
    if not key:
        return
    _local.pop(key, None)
    if redis:
        try:
            await redis.delete(key)
        except Exception as err:
            print(f"[memory] redis delete failed: {err}")
