"""Filesystem layout shared by all stages.

Defaults live inside the repository. Each root can be moved with an environment variable holding an absolute path,
e.g. to put the downloads on a larger drive:
  PIPELINE_RAW    data/raw          downloaded files, never edited (tens of GB during a cold build)
  PIPELINE_CACHE  data/cache        intermediate products, safe to delete
  PIPELINE_OUT    app/public/data   products the app loads (the dev server serves this directory; move it only for
                                    tests or staging)
"""

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _root(env: str, default: Path) -> Path:
    v = os.environ.get(env, "").strip()
    return Path(v).expanduser().resolve() if v else default


RAW = _root("PIPELINE_RAW", REPO / "data" / "raw")
CACHE = _root("PIPELINE_CACHE", REPO / "data" / "cache")
OUT = _root("PIPELINE_OUT", REPO / "app" / "public" / "data")

for _p in (RAW, CACHE, OUT):
    _p.mkdir(parents=True, exist_ok=True)
