"""Filesystem layout shared by all stages."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RAW = REPO / "data" / "raw"          # downloaded files, never edited
CACHE = REPO / "data" / "cache"      # intermediate products, safe to delete
OUT = REPO / "app" / "public" / "data"  # products the app loads

for _p in (RAW, CACHE, OUT):
    _p.mkdir(parents=True, exist_ok=True)
