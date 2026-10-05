"""DAMIT (Database of Asteroid Models from Inversion Techniques, Ďurech et al. 2010) → shapes/damit.*

Every model of the complete DAMIT export: the shape polyhedron (shape.txt), the spin state (spin.txt: λ, β, P, t0,
φ0, YORP term) and, where DAMIT provides it, the same rotation in the IAU form (IAUspin: α0, δ0, dW/dt, W0 at
J2000). Most models are convex hulls from lightcurve inversion (Kaasalainen & Torppa 2001; Kaasalainen et al.
2001); a few are non-convex (ADAM/SAGE, marked).

Storage (compact, one file): per model, int16 vertex coordinates (value × scale / 32767 = model units) and uint16
triangle indices, each padded to 4 bytes; an index table (BinaryTableHeader, `shapes/damit-index`) with one row per
model: SPK-ID, asteroid number, DAMIT ids, preferred flag, byte offsets and counts, scale, spin parameters, quality
flag, size calibration. Shapes are dimensionless unless `sizeCalibrated` (then km); the table gives each model's
volume-equivalent radius in model units so the renderer can scale to a measured diameter.
"""

from __future__ import annotations

import csv
import io
import pickle
import tarfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np

from . import shape_mesh as sm
from .download import fetch, record
from .output import write_bin
from .paths import CACHE
from .sb_table import Field, write_table
from .schema import BuildContext

EXPORT = "https://damit.cuni.cz/projects/damit/exports/complete/damit-20261004T000302Z.tar.gz"
SUBDIR = "shapes/damit"
SRC = "damit"
CACHE_FILE = CACHE / "shapes" / "damit-extract.pkl"


def _floats(s: str) -> list[float]:
    return [float(x) for x in s.split()]


def extract(tar_path: Path) -> dict:
    """One pass over the export: tables and, per model, shape/spin/IAUspin. Returns plain arrays."""
    tables, models = {}, {}
    with tarfile.open(tar_path, "r|gz") as t:
        for m in t:
            if not m.isfile():
                continue
            parts = m.name.split("/")
            if len(parts) == 3 and parts[1] == "tables":
                tables[parts[2]] = t.extractfile(m).read().decode("utf-8-sig")
                continue
            if len(parts) != 5 or not parts[3].startswith("model_"):
                continue
            leaf = parts[4]
            if leaf not in ("shape.txt", "spin.txt", "IAUspin", "IAUspin.txt"):
                continue
            mid = int(parts[3].removeprefix("model_"))
            rec = models.setdefault(mid, {"asteroid": int(parts[2].removeprefix("asteroid_"))})
            text = t.extractfile(m).read().decode()
            if leaf == "shape.txt":
                lines = [ln for ln in text.splitlines() if ln.strip()]
                nv, nf = (int(x) for x in lines[0].split()[:2])
                rec["v"] = np.array([_floats(ln)[:3] for ln in lines[1:1 + nv]], np.float32)
                rec["f"] = (np.array([[int(x) for x in ln.split()[:3]] for ln in lines[1 + nv:1 + nv + nf]],
                                     np.int64) - 1).astype(np.uint16)
            elif leaf == "spin.txt":
                rec["spin"] = text
            else:
                rec["iau"] = text
    return {"tables": tables, "models": models}


def _csv(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text)))


def _num(s: str, default=np.nan) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def load() -> tuple[dict, dict]:
    """(extracted export, ledger record). The 1.3 GB tar (mostly light curves and images) is deleted after one
    extraction pass; the extracted shapes/spins/tables are kept in data/cache (~0.2 GB) for re-runs."""
    if CACHE_FILE.exists():
        with CACHE_FILE.open("rb") as fh:
            data = pickle.load(fh)
        if data.get("url") == EXPORT:
            return data, data["record"]
    tar = fetch(EXPORT, SUBDIR, timeout=3600)
    rec = record(tar)
    data = extract(tar)
    data["url"], data["record"] = EXPORT, rec
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_FILE.open("wb") as fh:
        pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
    tar.unlink(missing_ok=True)
    return data, rec


def build(ctx: BuildContext) -> dict:
    data, rec = load()
    tables = data["tables"]
    asteroids = {int(r["id"]): r for r in _csv(tables["asteroids.csv"])}
    mrows = {int(r["id"]): r for r in _csv(tables["asteroid_models.csv"])}
    refs = {int(r["id"]): r for r in _csv(tables["references.csv"])}
    model_refs: dict[int, list[int]] = {}
    for r in _csv(tables["asteroid_models_references.csv"]):
        model_refs.setdefault(int(r["asteroid_model_id"]), []).append(int(r["reference_id"]))

    ids = sorted(k for k, v in data["models"].items() if "v" in v and k in mrows)
    # preferred model per asteroid: highest quality flag (0-5, missing = -1), then newest version, then highest id
    best: dict[int, tuple] = {}
    for k in ids:
        r = mrows[k]
        key = (_num(r["quality_flag"], -1.0), r.get("version") or "", k)
        a = int(r["asteroid_id"])
        if a not in best or key > best[a]:
            best[a] = key
    parts, cols = [], {c: [] for c in (
        "spkid", "number", "damitAsteroidId", "damitModelId", "preferred", "dataOffset", "vertexCount",
        "triangleCount", "scale", "equivalentRadius", "sizeCalibrated", "nonconvex", "qualityFlag", "lambdaDeg",
        "betaDeg", "periodHours", "jd0", "phi0Deg", "yorpRadPerDay2", "poleRaDeg", "poleDecDeg", "w0Deg",
        "wDotDegPerDay", "equivDiameterKm", "referenceIndex", "closed")}
    ref_list: list[int] = []
    off = 0
    stats = {"notWatertight": 0, "welded": 0, "skippedNoNumber": 0, "flipped": 0, "spinFileDiffersFromTable": 0}
    for k in ids:
        r = mrows[k]
        a = asteroids.get(int(r["asteroid_id"]), {})
        num = int(a["number"]) if (a.get("number") or "").strip() else 0
        if not num:
            stats["skippedNoNumber"] += 1                    # 2012 TC4, 2008 TC3: no SPK-ID mapping by number
            continue
        mdl = data["models"][k]
        mesh = sm.Mesh(mdl["v"].astype(np.float64), mdl["f"].astype(np.int64))
        w = sm.weld(mesh)
        if w.nf != mesh.nf or w.nv != mesh.nv:
            stats["welded"] += 1
        vol = sm.signed_volume(w)
        if vol < 0:
            stats["flipped"] += 1
        w = sm.orient_outward(w)
        closed = sm.edge_report(w)["watertight"]
        if not closed:
            stats["notWatertight"] += 1
            print(f"[shapes] DAMIT model {k} (asteroid {num}) is not closed")
        scale = float(np.abs(w.v).max())
        q = np.clip(np.round(w.v / scale * 32767), -32767, 32767).astype("<i2").tobytes()
        q += b"\0" * ((-len(q)) % 4)
        idx = w.f.astype("<u2").tobytes()
        idx += b"\0" * ((-len(idx)) % 4)
        parts += [q, idx]
        spin = [ln.split() for ln in mdl.get("spin", "").splitlines() if ln.strip()]
        if spin and any(abs(float(a) - _num(r[c])) > 1e-6 * max(1.0, abs(float(a)))
                        for a, c in zip(spin[0][:3], ("lambda", "beta", "period"))):
            stats["spinFileDiffersFromTable"] += 1
        iau = [ln.split() for ln in mdl.get("iau", "").splitlines() if ln.strip()]
        cols["spkid"].append(20000000 + num)
        cols["number"].append(num)
        cols["damitAsteroidId"].append(int(r["asteroid_id"]))
        cols["damitModelId"].append(k)
        cols["preferred"].append(1 if best[int(r["asteroid_id"])][2] == k else 0)
        cols["dataOffset"].append(off)
        cols["vertexCount"].append(w.nv)
        cols["triangleCount"].append(w.nf)
        cols["scale"].append(scale)
        cols["equivalentRadius"].append(sm.equivalent_radius(abs(vol)))
        cols["sizeCalibrated"].append(1 if r["calibrated_size"] == "1" else 0)
        cols["nonconvex"].append(1 if r["nonconvex"] == "1" else 0)
        cols["closed"].append(1 if closed else 0)
        cols["qualityFlag"].append(_num(r["quality_flag"]))
        cols["lambdaDeg"].append(_num(r["lambda"]))
        cols["betaDeg"].append(_num(r["beta"]))
        cols["periodHours"].append(_num(r["period"]))
        cols["jd0"].append(_num(r["jd0"]))
        cols["phi0Deg"].append(_num(r["phi0"]))
        cols["yorpRadPerDay2"].append(_num(r["yorp"], 0.0))
        if len(iau) >= 2:
            cols["poleRaDeg"].append(float(iau[0][0]))
            cols["poleDecDeg"].append(float(iau[0][1]))
            cols["wDotDegPerDay"].append(float(iau[0][2]))
            if abs(float(iau[1][0]) - 2451545.0) > 1e-6:
                raise ValueError(f"DAMIT model {k}: IAUspin epoch {iau[1][0]} is not J2000")
            cols["w0Deg"].append(float(iau[1][1]))
        else:
            for c in ("poleRaDeg", "poleDecDeg", "wDotDegPerDay", "w0Deg"):
                cols[c].append(np.nan)
        cols["equivDiameterKm"].append(_num(r["equiv_diameter"]))
        ri = []
        for rid in model_refs.get(k, [])[:3]:
            if rid not in ref_list:
                ref_list.append(rid)
            ri.append(ref_list.index(rid))
        cols["referenceIndex"].append(ri + [65535] * (3 - len(ri)))
        off += len(q) + len(idx)
    blob = b"".join(parts)
    n = len(cols["spkid"])
    write_bin(ctx, "shapes/damit.bin", blob, "shapes")
    fields = [
        Field("spkid", "u32", doc={"what": "JPL SBDB SPK-ID = 20000000 + asteroid number (the small-body catalog key)"}),
        Field("number", "u32"), Field("damitAsteroidId", "u32"), Field("damitModelId", "u32"),
        Field("dataOffset", "u32", doc={"what": "byte offset in shapes/damit.bin: int16 xyz × vertexCount (padded to "
                                                "4 bytes), then uint16 triangle indices × 3·triangleCount (padded)"}),
        Field("scale", "f32", doc={"what": "model coordinate = int16 / 32767 × scale (model units: km if "
                                           "sizeCalibrated, else dimensionless)"}),
        Field("equivalentRadius", "f32", doc={"what": "volume-equivalent radius of the polyhedron in model units; "
                                                      "multiply coordinates by D/2 / equivalentRadius to scale to a "
                                                      "measured diameter D"}),
        Field("qualityFlag", "f32", doc={"what": "DAMIT reliability flag, 0 lowest to 5 highest; NaN = not given"}),
        Field("lambdaDeg", "f32", doc={"what": "ecliptic longitude of the spin axis (J2000)"}),
        Field("betaDeg", "f32", doc={"what": "ecliptic latitude of the spin axis (J2000)"}),
        Field("periodHours", "f64", doc={"what": "sidereal rotation period"}),
        Field("jd0", "f64", doc={"what": "epoch t0 (JD, TDB as used by DAMIT)"}),
        Field("phi0Deg", "f32", doc={"what": "rotation angle at t0"}),
        Field("yorpRadPerDay2", "f32", doc={"what": "linear change of the rotation rate (0 = none)"}),
        Field("poleRaDeg", "f32", doc={"what": "IAU form (DAMIT IAUspin): pole right ascension, ICRF; NaN if DAMIT "
                                               "gives none"}),
        Field("poleDecDeg", "f32"), Field("w0Deg", "f32", doc={"what": "prime meridian (+x axis) at J2000.0"}),
        Field("wDotDegPerDay", "f32"),
        Field("equivDiameterKm", "f32", doc={"what": "DAMIT equivalent diameter where the model was scaled "
                                                     "(occultations, thermal); NaN otherwise"}),
        Field("vertexCount", "u16"), Field("triangleCount", "u16"),
        Field("referenceIndex", "u16", 3, doc={"what": "indices into `references` (up to three per model, as "
                                                       "listed by DAMIT); 65535 = none"}),
        Field("preferred", "u8", doc={"what": "1 for one model per asteroid: highest quality flag, then newest "
                                              "version, then highest DAMIT id (a pipeline choice, not DAMIT's)"}),
        Field("sizeCalibrated", "u8"), Field("nonconvex", "u8"),
        Field("closed", "u8", doc={"what": "1 when the polyhedron is closed (every edge shared by two consistently "
                                           "oriented triangles) after welding"}),
    ]
    columns = {c: np.asarray(v) for c, v in cols.items()}
    from .schema import SourceRecord
    export_name = Path(urlsplit(EXPORT).path).name.removesuffix(".tar.gz")
    export_date = datetime.strptime(export_name.removeprefix("damit-"), "%Y%m%dT%H%M%SZ").date().isoformat()
    src_id = ctx.add_source(SourceRecord(
        id=SRC, title="DAMIT - Database of Asteroid Models from Inversion Techniques, complete export",
        citation="Ďurech, J., Sidorin, V. & Kaasalainen, M. (2010). DAMIT: a database of asteroid models. A&A 513, "
                 f"A46. doi:10.1051/0004-6361/200912693. Export {export_name} (per-model references in "
                 "shapes/damit-index.json).",
        url=EXPORT, retrieved=rec["retrieved"], sha256=rec["sha256"], version=f"{export_date} export",
        license="CC BY 4.0",
        notes=f"{rec['bytes'] / 1e9:.2f} GB tar (models, light curves, images); only shape.txt, spin.txt, IAUspin "
              "and the tables are read; the tar is deleted after extraction."))
    header = write_table(
        ctx, "shapes/damit-index", fields, columns, n, "shapes", source_table=[src_id],
        notes="One row per DAMIT model (tumblers excluded). Mesh data in shapes/damit.bin (see dataOffset).",
        extra={
            "kind": "damit-models",
            "meshBin": "shapes/damit.bin",
            "provenance": {
                "label": "derived", "sources": [src_id],
                "method": "Convex (or, where flagged, non-convex) shapes and spin states from inversion of "
                          "disk-integrated photometry (dense and sparse light curves, Gaia DR3 photometry). The "
                          "light curves are measured; the shape is the solution of an inverse problem with an "
                          "assumed light-scattering law (Lambert + Lommel-Seeliger) and, for convex models, the "
                          "convexity constraint.",
                "uncertainty": "the global elongation and pole are constrained by the data; concavities (craters, "
                               "necks of contact binaries) are not (a convex hull by construction); pole ambiguity "
                               "(λ vs λ + 180°) is common and shows as separate models. Most shapes are "
                               "dimensionless: size must come from a measured diameter."},
            "rotation": ("DAMIT convention: r_ecl = Rz(λ) Ry(90° − β) Rz(φ0 + 2π(t − t0)/P + ½υ(t − t0)²) r_ast, "
                         "ecliptic J2000, Rz/Ry anticlockwise rotations, P in days for t in JD. IAU form (where "
                         "given): W = W0 + dW/dt·(JD − 2451545.0), prime meridian = +x axis."),
            "references": [{"author": refs[i]["author_short"], "year": refs[i]["year"], "title": refs[i]["title"],
                            "journal": " ".join(x for x in (refs[i]["journal"], refs[i]["volume"], refs[i]["page"])
                                                if x),
                            "bibcode": refs[i]["bibcode"], "url": refs[i]["url"]} for i in ref_list],
            "stats": {**stats, "models": n, "asteroids": int(np.unique(columns["spkid"]).size),
                      "bytes": len(blob), "triangles": int(columns["triangleCount"].astype(np.int64).sum())},
        })
    return header
