"""Settings. Locally, keys are read from the repo's .env.local (the same file Next.js uses)."""

import os
import re
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def _load_env_local() -> None:
    path = Path(__file__).parent.parent / ".env.local"
    if os.environ.get("VERCEL") or not path.exists():
        return  # on Vercel, env vars come from the dashboard
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if match:
            value = re.sub(r"\s+#.*$", "", match.group(2)).strip().strip("'\"")  # drop comments and quotes
            if value:
                os.environ.setdefault(match.group(1), value)


_load_env_local()


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default
