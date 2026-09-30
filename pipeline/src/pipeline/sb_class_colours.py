"""Estimated colours of small bodies without a measured spectrum, from the light stage's smallbody-class-colors.json
(docs/sources/smallbody-class-colors.md: Bus-DeMeo class mean spectra -> colour per unit p_V, p_V statistics, alias
tables and a population entry for unclassified objects).

Interface followed (that document, "Interface for the smallbodies stage"):
  1. class: the SsODNet best taxonomy class, else the SBDB SMASSII (Bus) class, else the Tholen class; a Bus-DeMeo
     name is used directly, other names through `aliases` (Bus, Tholen, Mahlke tables; a multi-letter Tholen label
     by its first letter); anything else -> `population`.
  2. p_V: the object's measured p_V, else the class pV.median, else (class p_V unknown, or `population`) the stage's
     orbit-class median (core classAlbedo).
  3. geometricAlbedoXYZS = p_V * xyzsPerUnitPV, label estimated, source smallbody-class-colors.
Every asteroid gets a class index (core.colorClass, header colorClasses) so its estimated colour is known even when
it has no physical record; physical records without a Gaia colour get the colour itself (colorLabel estimated).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .paths import OUT

PRODUCT = "smallbody-class-colors.json"
SOURCE_ID = "smallbody-class-colors"
POPULATION = "population"
NO_CLASS = 255


def load(path: Path | None = None) -> dict:
    p = path or OUT / PRODUCT
    if not p.exists():
        raise FileNotFoundError(f"{p} missing: build the light stage first (it writes {PRODUCT})")
    return json.loads(p.read_text())


def _strip(name: str) -> str:
    return name.strip().rstrip(":").strip()


def resolve(cc: dict, scheme: str, name: str) -> str | None:
    """Bus-DeMeo class for a label of a taxonomic scheme ('Bus-DeMeo', 'Bus', 'Tholen', 'Mahlke', 'SMASSII'), or
    None when no rule applies."""
    classes = cc["classes"]
    al = cc["aliases"]
    n = _strip(name)
    if not n:
        return None
    if n in classes:
        return n
    s = scheme.lower()
    if s in ("bus", "smassii", "bus-demeo"):
        m = al["bus"].get(n)
    elif s == "tholen":
        m = al["tholen"].get(n) or al["tholen"].get(n[:1].upper())
    elif s == "mahlke":
        m = al["mahlke"].get(n)
    else:
        m = None
    return m if m in classes else None


@dataclass
class ClassColours:
    names: list[str]                 # colorClasses order: the Bus-DeMeo classes, then 'population'
    index: np.ndarray                # per object: index into names, NO_CLASS for comets
    method: np.ndarray               # per object: 0 SsODNet, 1 SMASSII, 2 Tholen, 3 population, 255 comet
    header: dict


def assign(cc: dict, n: int, is_comet: np.ndarray, bft_idx: np.ndarray, bft_names: list[str], bus_idx: np.ndarray,
           bus_names: list[str], tholen_idx: np.ndarray, tholen_names: list[str]) -> ClassColours:
    names = list(cc["classes"]) + [POPULATION]
    pos = {k: i for i, k in enumerate(names)}
    bft_map = []
    for e in bft_names:
        parts = e.split("|") if e else []
        bft_map.append(resolve(cc, parts[0], parts[1]) if len(parts) >= 2 else None)
    bus_map = [resolve(cc, "Bus", s) if s else None for s in bus_names]
    tho_map = [resolve(cc, "Tholen", s) if s else None for s in tholen_names]
    index = np.full(n, pos[POPULATION], dtype=np.uint8)
    method = np.full(n, 3, dtype=np.uint8)
    for i in range(n):
        if is_comet[i]:
            index[i], method[i] = NO_CLASS, 255
            continue
        for m, (k, table) in enumerate(((bft_idx[i], bft_map), (bus_idx[i], bus_map), (tholen_idx[i], tho_map))):
            cls = table[k] if k else None
            if cls:
                index[i], method[i] = pos[cls], m
                break
    header = {
        "method": "Estimated colour of an asteroid without a measured spectrum: geometricAlbedoXYZS = p_V * "
                  "xyzsPerUnitPV of its class (colorClasses[colorClass]); p_V = its measured p_V, else the class "
                  "pVMedian, else (null, or 'population') the median of its SBDB orbit class (classAlbedo). Class: "
                  "the SsODNet best taxonomy class, else the SBDB SMASSII class, else the Tholen class, mapped to "
                  "Bus-DeMeo through the aliases of smallbody-class-colors.json; unclassified -> 'population'. "
                  "Label estimated. 255 = comet (no class colour).",
        "sources": [SOURCE_ID],
        "classes": [{"name": k,
                     "xyzsPerUnitPV": (cc["classes"][k]["colour"]["value"]["xyzsPerUnitPV"] if k != POPULATION
                                       else cc["population"]["colour"]["value"]["xyzsPerUnitPV"]),
                     "pVMedian": (cc["classes"][k]["pV"]["value"] or {}).get("median") if k != POPULATION else None}
                    for k in names],
        "counts": {"ssodnet": int((method == 0).sum()), "smassii": int((method == 1).sum()),
                   "tholen": int((method == 2).sum()), "population": int((method == 3).sum())},
    }
    return ClassColours(names, index, method, header)


def fill_physical(c: dict, rows: np.ndarray, colours: ClassColours, pv_orbit_class: np.ndarray, measured_pv: np.ndarray,
                  label_estimated: int, label_unknown: int, src_index: int) -> int:
    """Give physical records `rows` without a colour the class colour (in place in the physical columns c)."""
    filled = 0
    for i in rows:
        if c["colorLabel"][i] != label_unknown:
            continue
        k = colours.index[i]
        if k == NO_CLASS:
            continue
        entry = colours.header["classes"][k]
        pv = measured_pv[i] if np.isfinite(measured_pv[i]) else (entry["pVMedian"] if entry["pVMedian"] else pv_orbit_class[i])
        c["geometricAlbedoXYZS"][i] = pv * np.asarray(entry["xyzsPerUnitPV"])
        c["colorLabel"][i] = label_estimated
        c["colorSrc"][i] = src_index
        filled += 1
    return filled
