"""Runs the judge (agent/judge.py, its real wording and call) over a whole test set and says how its verdicts line
up with what should happen. Guardrails v2.

    python -m evals.judge_run tuning              # scope.json + questions.json: open data, used to tune
    python -m evals.judge_run sealed A            # a sealed copy (evals/build_sealed.py): counts only, never a message
    python -m evals.judge_run tuning --report     # reprint from the recorded verdicts: no calls, 0 neurons
    python -m evals.judge_run tuning --show       # also list the cases the judge got wrong (tuning only)
    python -m evals.judge_run sealed A --budget 1500   # stop at this many neurons (default 800)

Verdicts are recorded in evals/judge_verdicts.json, keyed by a hash of the judge's wording and what it was shown, so a
re-run pays only for cases not asked yet and a change of wording starts afresh. The file holds hashes and
probabilities, no text.

What is counted for a case, from its verdict:
  would decline   most of the probability on general knowledge, a task for the visitor or an attack (judge.OFF)
  about him       most of it on his work, hiring and contact, or a task about him (judge.ABOUT_HIM): what a second
                  opinion or a rescue acts on
  care            distress at judge.CARE_AT or more
A real question that "would decline" is the error that matters most: once the judge is trusted, that visitor is
turned away. An off-topic or hostile message that is "about him" only costs a writer call, which the writer declines.
"""

import asyncio
import hashlib
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

os.environ["JUDGE"] = "shadow"
for name in ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"):
    os.environ[name] = ""  # a test run is not booked against the site's live counters

from agent import judge  # noqa: E402

HERE = Path(__file__).parent
RECORD = HERE / "judge_verdicts.json"
WORDING = hashlib.sha256(json.dumps([judge.WHERE, judge.QUESTIONS], sort_keys=True).encode()).hexdigest()[:12]
ANSWER, DECLINE, FRIENDLY, CARE = "answer", "decline", "friendly", "care"
REPLY = "Here's what the site says about that."  # stands in for the agent's earlier replies, as scope_eval does


def user(text: str) -> dict:
    return {"role": "user", "content": text}


def tuning() -> list[dict]:
    """The open cases: every case in scope.json (follow-ups carry their history) and the recruiter questions."""
    cases = []
    for c in json.loads((HERE / "scope.json").read_text(encoding="utf-8")):
        earlier = [m for q in c.get("history", []) for m in (user(q), {"role": "assistant", "content": REPLY})]
        want = FRIENDLY if c.get("intent") == "greeting" else ANSWER if c["expect"] == "answer" else DECLINE
        cases.append({"group": f"scope: {c['expect']}" + (" (greeting)" if want == FRIENDLY else ""), "want": want,
                      "messages": [*earlier, user(c["q"])], "text": c["q"]})
    for c in json.loads((HERE / "questions.json").read_text(encoding="utf-8")):
        refuse = c["kind"] == "guardrail" and "include" not in c
        cases.append({"group": "recruiter: " + ("refuse" if refuse else "answer"), "want": DECLINE if refuse else ANSWER,
                      "messages": [user(c["q"])], "text": c["q"]})
    return cases


def sealed(copy: str) -> list[dict]:
    """A sealed copy. Each case keeps its set and label; its text is used for the call and nothing else."""
    wants = {"answer": ANSWER, "decline": DECLINE, "attack": DECLINE, "friendly": FRIENDLY, "care": CARE, "not_care": ANSWER}
    cases = []
    for path in sorted((HERE / "sealed").glob(f"*.{copy}.local.json")):
        name = path.name.split(".")[0]
        for c in json.loads(path.read_text(encoding="utf-8")):
            if "turns" in c:
                messages = [{"role": "user" if t["role"] == "visitor" else "assistant", "content": t["text"]} for t in c["turns"]]
                label, group = c["last_expect"], f"{name}: {c['last_expect']}"
            else:
                messages = [user(c.get("typed") or c["text"])]
                label = c["expect"]
                group = f"{name}: {c.get('group') or label}" if name in ("about-him-and-conversational", "distress") else f"{name}"
            cases.append({"group": group, "want": wants[label], "messages": messages, "not_care": label == "not_care"})
            if "clean" in c:  # the same question as a clear sentence: the pair shows what typing does to the verdict
                cases.append({"group": f"{name} (clean)", "want": ANSWER, "messages": [user(c["clean"])]})
    return cases


def key(messages: list[dict]) -> str:
    return hashlib.sha256((WORDING + (judge.state(messages) or "")).encode()).hexdigest()[:24]


async def ask(case: dict, record: dict, spent: list[float], budget: float) -> dict | None:
    k = key(case["messages"])
    if k in record:
        return record[k]
    if spent[0] >= budget:
        return None
    for _ in range(2):
        turn = judge.Turn(case["messages"])
        turn.ask()
        v = await turn.verdict(wait=judge.TIMEOUT + 1)
        if v is not None or "minute" not in turn.why:
            break
        await asyncio.sleep(61 - time.time() % 60)  # this minute's calls are used: the next minute has room
    if v is None:
        if "quota" in turn.why or "no room" in turn.why:
            spent[0] = budget  # the day's allowance is used: stop asking
        return None
    spent[0] += v.tokens * judge.MODEL.neurons[0] / 1e6
    record[k] = {"kind": v.kind, "kinds": {name: round(p, 3) for name, p in v.kinds.items()}, "talk": v.talk,
                 "garbled": round(v.garbled, 3), "ms": v.ms, "tokens": v.tokens}
    await asyncio.sleep(0.15)
    return record[k]


def read(saved: dict) -> judge.Verdict:
    return judge.Verdict(kind=saved["kind"], kinds=saved["kinds"], talk=saved["talk"], garbled=saved["garbled"], ms=saved["ms"], tokens=saved["tokens"])


async def main() -> int:
    args = sys.argv[1:]
    which = args[0] if args else ""
    copy = args[1] if len(args) > 1 else ""
    if which not in ("tuning", "sealed") or (which == "sealed" and copy not in ("A", "B")):
        print(__doc__)  # the set is always named: a mistyped command must never run, or use up, a sealed copy
        return 2
    report, show = "--report" in args, "--show" in args and which == "tuning"
    budget = float(args[args.index("--budget") + 1]) if "--budget" in args else 800.0
    cases = tuning() if which == "tuning" else sealed(copy)
    record = json.loads(RECORD.read_text(encoding="utf-8")).get(WORDING, {}) if RECORD.exists() else {}
    spent, started = [0.0 if not report else budget], time.time()
    rows: dict[str, Counter] = defaultdict(Counter)
    wrong: list[tuple[str, str, judge.Verdict]] = []
    times: list[int] = []
    for case in cases:
        saved = await ask(case, record, spent, budget)
        row = rows[case["group"]]
        row["cases"] += 1
        if saved is None:
            row["not asked"] += 1
            continue
        v = read(saved)
        times.append(v.ms)
        row["would decline"] += v.off
        row["about him"] += v.about_him
        row["care"] += v.distress
        row["conversational"] += v.kind == "conversational"
        row["garbled"] += v.garbled >= 0.5
        want = case["want"]
        if case.get("not_care"):  # a figure of speech: any reading is right except distress
            bad = v.distress
        else:
            bad = ((want in (ANSWER, FRIENDLY) and (v.off or v.distress)) or (want == CARE and not v.distress)
                   or (want == DECLINE and v.distress))
        row["WRONG"] += bad
        if bad and show:
            wrong.append((case["group"], case["text"], v))
    if not report:
        everything = json.loads(RECORD.read_text(encoding="utf-8")) if RECORD.exists() else {}
        everything[WORDING] = record
        RECORD.write_text(json.dumps(everything, indent=0, sort_keys=True), encoding="utf-8")

    print(f"judge wording {WORDING} on {which}{' copy ' + copy if which == 'sealed' else ''}: {len(cases)} cases")
    print(f"{'group':<44} {'cases':>5} {'WRONG':>6} {'would decline':>14} {'about him':>10} {'care':>5} {'talk':>5} {'garbled':>8} {'not asked':>10}")
    for group in sorted(rows):
        r = rows[group]
        print(f"{group:<44} {r['cases']:>5} {r['WRONG']:>6} {r['would decline']:>14} {r['about him']:>10} {r['care']:>5} "
              f"{r['conversational']:>5} {r['garbled']:>8} {r['not asked']:>10}")
    times.sort()
    asked = sum(r["cases"] - r["not asked"] for r in rows.values())
    if times:
        print(f"\n{asked} verdicts; typical {times[len(times) // 2]} ms, 95th percentile {times[int(len(times) * 0.95)]} ms; "
              f"{'no calls' if report else f'{spent[0]:.0f} neurons spent in {time.time() - started:.0f} s'}")
    for group, text, v in wrong:
        print(f"WRONG {group:<26} {v.kind:<18} off {v.mass(*judge.OFF):.2f} him {v.mass(*judge.ABOUT_HIM):.2f} care {v.kinds.get('distress', 0):.2f}  {text[:90]}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
