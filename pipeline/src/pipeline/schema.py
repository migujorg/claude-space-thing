"""Python mirror of app/src/data/schema.ts. Keep the two in sync."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal

Label = Literal["measured", "derived", "estimated", "synthetic", "unknown"]
LABEL_ORDER: tuple[Label, ...] = ("measured", "derived", "estimated", "synthetic", "unknown")


def worst(*labels: Label) -> Label:
    """Provenance propagation: a computed value is only as grounded as its least grounded input."""
    return max(labels, key=LABEL_ORDER.index)


def sourced(value: Any, label: Label, sources: list[str], *, unit: str | None = None,
            method: str | None = None, uncertainty: str | None = None) -> dict:
    if (value is None) != (label == "unknown"):
        raise ValueError("value must be None exactly when label is 'unknown'")
    d: dict[str, Any] = {"value": value, "label": label, "sources": list(sources)}
    if unit is not None:
        d["unit"] = unit
    if method is not None:
        d["method"] = method
    if uncertainty is not None:
        d["uncertainty"] = uncertainty
    return d


def unknown(reason: str | None = None) -> dict:
    return sourced(None, "unknown", [], method=reason)


@dataclass
class SourceRecord:
    id: str
    title: str
    citation: str
    url: str
    retrieved: str
    sha256: str | None = None
    version: str | None = None
    license: str | None = None
    notes: str | None = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class BuildContext:
    """Shared state passed through stages: registered sources, products written, validity window, the build's
    parameters (pipeline/config.py) and the stages this build runs."""
    start_et: float
    end_et: float
    sources: dict[str, SourceRecord] = field(default_factory=dict)
    products: dict[str, dict] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)
    plan: tuple[str, ...] = ()

    def add_source(self, rec: SourceRecord) -> str:
        self.sources[rec.id] = rec
        return rec.id

    def param(self, key: str) -> Any:
        """A build parameter (config.PARAMS); without a resolved config: its environment variable, else default."""
        from .config import value
        return value(self.params, key)
