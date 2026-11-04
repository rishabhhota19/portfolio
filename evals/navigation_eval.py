"""Navigation evals: does "take me to …" land on the right page, and do ordinary questions stay put? Rules only.

    python -m evals.navigation_eval

Three parts, so it keeps working as the site grows:
  1. coverage — every route in app/ is a section in content/site.json (the list the nav, sitemap and agent share),
     every content page lives under its section, and pages that share one (papers, roles) have #anchors to land on;
  2. generated — "take me to <name>" for every section and every page, built from the site itself;
  3. hand-written — evals/navigation.json: phrasing, mixed questions, and questions that must not navigate.
"""

import json
import re
import sys
from pathlib import Path

from agent.config import SITE
from agent.pages import KIND_OF_SECTION, PAGES, SECTIONS, navigation, move

ROOT = Path(__file__).parent.parent


def coverage() -> list[str]:
    problems = []
    for page in sorted((ROOT / "app").rglob("page.tsx")):
        parts = page.parent.relative_to(ROOT / "app").parts
        if parts and parts[0] == "api":
            continue
        if any(p.startswith("[") for p in parts):  # app/projects/[slug] → the pages of the "/projects" section
            base = "/" + "/".join(parts[: next(i for i, p in enumerate(parts) if p.startswith("["))])
            if base not in KIND_OF_SECTION:
                problems.append(f"{base}/[…] has pages but no section with a \"kind\" in content/site.json")
            continue
        path = "/" + "/".join(parts)
        if path in SITE.get("private", []):
            continue  # e.g. /admin: deliberately not a section, so the agent never takes anyone there
        if path not in SECTIONS:
            problems.append(f"route {path} is missing from content/site.json \"sections\" (the agent can't take anyone there)")
    for p in PAGES:
        section = next((s for s, k in KIND_OF_SECTION.items() if k == p["kind"]), None)
        if not p["path"].startswith(section or "/"):
            problems.append(f"{p['path']} isn't under its section {section}")
    for section in {p["path"].split("#")[0] for p in PAGES if "#" in p["path"]}:
        source = ROOT / "app" / section.strip("/") / "page.tsx"
        if source.exists() and "id={" not in source.read_text(encoding="utf-8"):
            problems.append(f"{source.relative_to(ROOT)} lists items the agent links to by #anchor, but renders no id={{…}}")
    return problems


def generated() -> list[dict]:
    return [{"q": f"take me to {label}", "path": path} for path, (label, _) in SECTIONS.items()] + \
           [{"q": f"take me to {p['label']}", "path": p["path"]} for p in PAGES]


def main() -> int:
    problems = coverage()
    for line in problems:
        print(f"FAIL  coverage: {line}")
    print(f"coverage: {len(SECTIONS)} sections, {len(PAGES)} pages — {'OK' if not problems else f'{len(problems)} problems'}\n")

    wrong = 0
    hand = json.loads((Path(__file__).parent / "navigation.json").read_text(encoding="utf-8"))
    for title, cases in (("generated", generated()), ("hand-written", hand)):
        bad = 0
        for c in cases:
            nav = navigation(c["q"])
            got = nav["path"] if nav else None
            ok = got == c["path"] and (nav is None or nav["pure"] == c.get("pure", nav["pure"])) and move(c["q"]) == c.get("move")
            bad += not ok
            if not ok or title == "hand-written":
                print(f"{'PASS' if ok else 'FAIL'}  {c['q']:<62} → {got}{'' if ok else '  (expected ' + str(c['path']) + ')'}")
        print(f"{title}: {len(cases) - bad}/{len(cases)} correct\n")
        wrong += bad
    total = len(generated()) + len(hand)
    print(f"navigation: {total - wrong}/{total} correct")
    return 1 if wrong or problems else 0


if __name__ == "__main__":
    sys.exit(main())
