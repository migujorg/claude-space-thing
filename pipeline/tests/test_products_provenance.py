"""Audit manifest-listed JSON, without opening binary catalogues or surface tiles.

Known failures are exact (product, JSON path, rule) entries, never path globs.
Each has a strict xfail: fixing it requires removing its entry. A second test
rejects every unlisted violation, including other violations at a known path.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date
import json
import re
from time import perf_counter

import pytest

from pipeline.paths import OUT
from pipeline.schema import LABEL_ORDER


@dataclass(frozen=True)
class Violation:
    product: str
    path: tuple[str | int, ...]
    rule: str

    def __str__(self):
        return f"{self.product} {_json_path(self.path)}: {self.rule}"


def _json_path(path):
    return "$" + "".join(f"[{json.dumps(p)}]" for p in path)


def _walk(value, path=()):
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from _walk(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, (*path, index))


def _metadata_rule(product, path, value, root):
    """Named binary/header classes, not inline Sourced values (§2.2).

    Exempt only the absent value field. Labels and source references are still
    checked, and traversal continues into every child. An added value always
    receives the full Sourced checks, even at these paths.
    """
    if "value" in value:
        return None
    provenance_keys = {"label", "sources", "method", "uncertainty"}
    if (product.startswith(("ephem/", "orient/")) and "bin" in root
            and len(path) == 2 and path[0] == "segments" and isinstance(path[1], int)
            and {"offset", "n", "rsize", "type"} <= value.keys()):
        return "binary-kernel-segment"
    if (product.startswith("stars/") and "fields" in root
            and len(path) == 3 and path[0] == "routes" and isinstance(path[2], int)
            and value.keys() <= provenance_keys):
        return "binary-catalogue-route"
    if (product.startswith("shapes/") and path == ("provenance",)
            and value.keys() <= provenance_keys):
        return "binary-shape-provenance"
    if (product.startswith("surfaces/") and "tilePath" in root
            and (path in (("brightness",), ("color",))
                 or len(path) == 4 and path[:2] == ("coverage", "regions")
                 and isinstance(path[2], int) and path[3] in ("brightness", "color"))
            and value.keys() <= provenance_keys):
        return "binary-surface-provenance"
    if (product == "sky/diffuse.json" and root.get("kind") == "skyMaps"
            and len(path) == 2 and path[0] == "layers"
            and value.get("scheme") == "HEALPix" and "bin" in value):
        return "binary-healpix-layer"
    if (product == "comets/list.json" and path == ()
            and {"window", "notable", "measured", "count", "showcase"} <= value.keys()):
        return "comet-list-header"
    return None


def _sourced_rules(value, source_ids, *, metadata=False):
    label = value["label"]
    if label not in LABEL_ORDER:
        yield "invalid-label"
    if "value" not in value:
        if not metadata:
            yield "missing-value"
    elif (value["value"] is None) != (label == "unknown"):
        yield "null-iff-unknown"
    sources = value.get("sources")
    if not isinstance(sources, list):
        yield "sources-must-be-list"
    else:
        if label != "unknown" and not sources:
            yield "non-unknown-needs-source"
        for sid in sources:
            if not isinstance(sid, str) or not sid.strip():
                yield "source-id-must-be-nonempty-string"
            elif sid not in source_ids:
                yield f"unregistered-source:{sid}"


def _source_rules(records):
    seen = set()
    for index, rec in enumerate(records):
        if not isinstance(rec, dict):
            yield (index,), "source-record-must-be-object"
            continue
        for key in ("id", "title", "citation", "url"):
            if not isinstance(rec.get(key), str) or not rec[key].strip():
                yield (index, key), "source-field-must-be-nonempty-string"
        sid = rec.get("id")
        if isinstance(sid, str):
            if sid in seen:
                yield (index, "id"), f"duplicate-source-id:{sid}"
            seen.add(sid)
        retrieved = rec.get("retrieved")
        if retrieved != "":
            try:
                if not isinstance(retrieved, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", retrieved):
                    raise ValueError
                date.fromisoformat(retrieved)
            except ValueError:
                yield (index, "retrieved"), "retrieved-must-be-iso-date-or-empty"
        if "sha256" in rec and (not isinstance(rec["sha256"], str)
                                 or not re.fullmatch(r"[0-9a-fA-F]{64}", rec["sha256"])):
            yield (index, "sha256"), "sha256-must-be-64-hex-digits"


def _product_violations(product, root, source_ids, counts):
    for path, value in _walk(root):
        if "label" in value and ("sources" in value or "value" in value):
            rule = _metadata_rule(product, path, value, root)
            counts[rule or "sourced"] += 1
            for issue in _sourced_rules(value, source_ids, metadata=rule is not None):
                yield Violation(product, path, issue)


# Inline physical payloads must use Sourced; unlike the metadata above, their
# values live in JSON. These entries identify existing writer bugs, not waivers.
# Populated only from the disk audit, with a reason and stable name per path.
def _known(product, path, name, reason):
    return pytest.param(Violation(product, path, "missing-value"), id=name,
                        marks=pytest.mark.xfail(strict=True, reason=reason))


# Catalogue row ids from the audited 2026-10-04 product. Enumerated, never
# discovered from the current build: a new row or changed schema must be reviewed.
KNOWN_COMET_ROWS = (
    "1", "7", "9", "11", "12", "15", "16", "24", "25", "29", "31", "33", "34",
    "44", "45", "46", "49", "50", "62", "74", "79", "82", "87", "88", "90",
    "93", "96", "98", "108", "110", "121", "127", "138", "511", "512", "518",
    "520", "528", "552", "1152", "1157", "1163", "1170", "1171", "1174",
    "1179", "1188", "1190", "1210", "1216",
)
COMET_ROW_REASON = ("stages/comets.py:280-282 emits inline per-comet composition ratios "
                    "beside label/sources without the required Sourced.value envelope")
COMET_MODEL_REASON = ("stages/comets.py:237-267 emits an inline physical model payload "
                      "beside label/sources without the required Sourced.value envelope")
KNOWN_FAILURES = (
    *(_known("comets/list.json", ("measured", row), f"comet-measured-row-{row}", COMET_ROW_REASON)
      for row in KNOWN_COMET_ROWS),
    _known("comets/model.json", ("waterFromMagnitude",), "comet-water-law", COMET_MODEL_REASON),
    _known("comets/model.json", ("composition",), "comet-population-composition", COMET_MODEL_REASON),
    _known("comets/model.json", ("gFactors",), "comet-g-factors", COMET_MODEL_REASON),
    _known("comets/model.json", ("bandRatiosToC2",), "comet-band-ratios", COMET_MODEL_REASON),
    _known("comets/model.json", ("haser",), "comet-haser-model", COMET_MODEL_REASON),
    _known("comets/model.json", ("oxygen",), "comet-oxygen-model", COMET_MODEL_REASON),
    _known("comets/model.json", ("coPlus",), "comet-co-plus-model", COMET_MODEL_REASON),
    _known("comets/model.json", ("solarWind",), "comet-solar-wind", COMET_MODEL_REASON),
    _known("comets/model.json", ("grains",), "comet-grain-model", COMET_MODEL_REASON),
    _known("surfaces/399/cloudTau.json", ("constants", "unmeasuredTau"), "earth-unmeasured-cloud-tau",
           "surf_earth.py:_unmeasured_tau returns an inline estimated population statistic "
           "beside label/sources without the required Sourced.value envelope"),
)


@pytest.fixture(scope="module")
def audit():
    manifest = OUT / "manifest.json"
    if not manifest.is_file():
        pytest.skip(f"built products unavailable: manifest.json absent at {manifest}")
    started = perf_counter()
    products = json.loads(manifest.read_text(encoding="utf-8"))["products"]
    records = json.loads((OUT / "sources.json").read_text(encoding="utf-8"))
    assert isinstance(records, list), "sources.json must contain a list of SourceRecord objects"
    violations = [Violation("sources.json", path, rule) for path, rule in _source_rules(records)]
    source_ids = {r["id"] for r in records if isinstance(r, dict) and isinstance(r.get("id"), str)}
    counts = Counter()
    json_products = {p for p in products if p.endswith(".json")}
    for product in sorted(json_products):
        root = json.loads((OUT / product).read_text(encoding="utf-8"))
        violations.extend(_product_violations(product, root, source_ids, counts))
    elapsed = perf_counter() - started
    print(f"\nProvenance audit: {len(json_products)} JSON products, {len(records)} source records, "
          f"{dict(sorted(counts.items()))}, {len(violations)} violations, {elapsed:.3f} s")
    for product, count in sorted(Counter(v.product for v in violations).items()):
        print(f"  {product}: {count} violations")
    return json_products | {"sources.json"}, set(violations)


def test_no_unlisted_product_provenance_violations(audit):
    _, violations = audit
    known = {entry.values[0] for entry in KNOWN_FAILURES}
    unexpected = violations - known
    assert not unexpected, "Unlisted provenance violations:\n" + "\n".join(sorted(map(str, unexpected)))


@pytest.mark.parametrize("violation", KNOWN_FAILURES)
def test_known_product_provenance_violation(audit, violation):
    products, violations = audit
    if violation.product not in products:
        pytest.skip(f"known violation's product is not in this build: {violation.product}")
    assert violation not in violations, str(violation)


@pytest.mark.parametrize("value, rule", [
    ({"value": 1, "label": "invented", "sources": ["s"]}, "invalid-label"),
    ({"label": "measured", "sources": ["s"]}, "missing-value"),
    ({"value": None, "label": "measured", "sources": ["s"]}, "null-iff-unknown"),
    ({"value": 1, "label": "unknown", "sources": []}, "null-iff-unknown"),
    ({"value": 1, "label": "measured", "sources": []}, "non-unknown-needs-source"),
    ({"value": 1, "label": "derived", "sources": ["absent"]}, "unregistered-source:absent"),
    ({"value": None, "label": "unknown", "sources": ["absent"]}, "unregistered-source:absent"),
    ({"value": 1, "label": "measured"}, "sources-must-be-list"),
    ({"value": 1, "label": "measured", "sources": "s"}, "sources-must-be-list"),
    ({"value": 1, "label": "measured", "sources": [{}]}, "source-id-must-be-nonempty-string"),
])
def test_audit_detects_invalid_sourced_values(value, rule):
    violations = list(_product_violations("example.json", {"nested": [value]}, {"s"}, Counter()))
    assert Violation("example.json", ("nested", 0), rule) in violations


def test_metadata_exclusion_keeps_source_checks_and_traversal():
    provenance = {"label": "measured", "sources": ["absent"], "method": "test"}
    root = {"tilePath": "tiles/{level}.bin", "brightness": provenance,
            "constants": {"nested": {"value": None, "label": "derived", "sources": ["s"]}}}
    assert set(_product_violations("surfaces/1/albedo.json", root, {"s"}, Counter())) == {
        Violation("surfaces/1/albedo.json", ("brightness",), "unregistered-source:absent"),
        Violation("surfaces/1/albedo.json", ("constants", "nested"), "null-iff-unknown"),
    }
    provenance["value"] = None
    assert Violation("surfaces/1/albedo.json", ("brightness",), "null-iff-unknown") in set(
        _product_violations("surfaces/1/albedo.json", root, {"s"}, Counter()))


def test_source_record_rules():
    valid = {"id": "s", "title": "Title", "citation": "Citation", "url": "https://example.test",
             "retrieved": "2024-02-29", "sha256": "aB" * 32}
    assert list(_source_rules([valid, {**valid, "id": "empty-date", "retrieved": ""}])) == []
    assert ((1, "id"), "duplicate-source-id:s") in list(_source_rules([valid, valid]))
    for key in ("id", "title", "citation", "url"):
        assert ((0, key), "source-field-must-be-nonempty-string") in list(_source_rules([{**valid, key: " "}]))
    for retrieved in (None, "2026-02-30", "20261004", "2026-10-04T00:00:00Z"):
        assert ((0, "retrieved"), "retrieved-must-be-iso-date-or-empty") in list(
            _source_rules([{**valid, "retrieved": retrieved}]))
    for sha in (None, "g" * 64, "a" * 63):
        assert ((0, "sha256"), "sha256-must-be-64-hex-digits") in list(_source_rules([{**valid, "sha256": sha}]))
