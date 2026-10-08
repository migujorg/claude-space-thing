"""Fixed disk-albedo reference integrals, built after photometry and surface calibration.

No raw downloads or output parameters. Both input stages enter the normal dependency
fingerprint; the renderer and this stage use exactly one TypeScript integrator.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from ..output import write_json
from ..paths import OUT
from ..photometry.albedo import pck_radii
from ..schema import BuildContext, sourced, worst

DEPENDS = ("light", "surfaces")
BRIDGE = "pipeline/src/pipeline/stages/albedo_reference.mjs"
CODE_INPUTS = ("app/src/render/spatial.ts", "app/src/render/surface.ts", BRIDGE)


def check_toolchain(repo: Path | None = None) -> None:
    if shutil.which("node") is None:
        raise RuntimeError("albedo_reference requires Node.js on PATH; no reference table was built.")
    repo = repo or Path(__file__).resolve().parents[4]
    result = subprocess.run(["node", "--input-type=module", "-e",
        "import {createRequire} from 'node:module';createRequire(process.cwd()+'/package.json')('esbuild');"],
        cwd=repo / "app", capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("albedo_reference requires the app's esbuild in app/node_modules; "
                           "prepare the app toolchain before building this stage. " + result.stderr.strip())


def reference_table(naif: int, entry: dict) -> dict | None:
    """Precompute the accepted exact-row integral; no calibration work belongs in a frame.

    The pure TypeScript physics implementation is also the app's reference. Node
    and esbuild are the existing app toolchain, not an observational input.
    """
    import hashlib
    from ..paths import OUT, CACHE
    model = entry.get("spatialModel", {}).get("value")
    view = entry["albedoMeasurementView"]["value"]
    if naif not in (599,699,799,899) or not model or view["kind"] != "latitude":
        return None
    check_toolchain()
    repo=Path(__file__).resolve().parents[4]
    code_files=[repo/p for p in CODE_INPUTS]
    source_hash=hashlib.sha256(b"".join(p.read_bytes() for p in code_files)).hexdigest()
    paths=[OUT/f"surfaces/{naif}/albedo/0/0/{i}.bin" for i in (0,1)]
    tiles=[str(p) if p.exists() else None for p in paths]
    request={"model":model,"view":view,"radii":list(pck_radii()[naif]),"tiles":tiles,
             "hasMap":any(p is not None for p in tiles)}
    cache_key=hashlib.sha256(json.dumps({"inputs":request,"source":source_hash,
        "algorithm":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "tiles":[hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None for p in paths]},sort_keys=True).encode()).hexdigest()
    cached=CACHE/"albedo-reference"/f"{naif}-{cache_key}.json"
    if cached.exists():return json.loads(cached.read_text())
    cached.parent.mkdir(parents=True,exist_ok=True)
    request["bundle"]=str(cached.parent/f"integrator-{source_hash}.mjs")

    request["sourceHash"]=source_hash
    print(f"[albedo_reference] {naif} dated reference: computing fixed calibration table",flush=True)
    result=subprocess.run(["node",str(repo/BRIDGE)],input=json.dumps(request),
                          cwd=repo/"app",capture_output=True,text=True,check=True)
    table=json.loads(result.stdout)
    cached.write_text(json.dumps(table)+"\n")
    return table



def hapke_table(entry: dict) -> dict | None:
    """Bare, geometry-independent phase integral; no map or calibration-view assumption."""
    import hashlib
    from ..paths import CACHE
    model = entry.get("spatialModel", {}).get("value")
    if not model or model["kind"] != "hapke":
        return None
    check_toolchain()
    repo = Path(__file__).resolve().parents[4]
    source_hash = hashlib.sha256(b"".join((repo / p).read_bytes() for p in CODE_INPUTS)).hexdigest()
    spatial_hash = hashlib.sha256((repo / CODE_INPUTS[0]).read_bytes()).hexdigest()
    request = {"kind": "hapke-phase", "model": model, "sourceHash": source_hash, "spatialHash": spatial_hash}
    key = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    cached = CACHE / "albedo-reference" / f"hapke-{key}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    cached.parent.mkdir(parents=True, exist_ok=True)
    request["bundle"] = str(cached.parent / f"integrator-{source_hash}.mjs")
    result = subprocess.run(["node", str(repo / BRIDGE)], input=json.dumps(request),
                            cwd=repo / "app", capture_output=True, text=True, check=True)
    table = json.loads(result.stdout)
    cached.write_text(json.dumps(table) + "\n")
    return table


def run(ctx: BuildContext) -> None:
    check_toolchain()
    photometry = json.loads((OUT / "photometry.json").read_text())
    product = {}
    phases = {}
    for key, entry in photometry.items():
        phase = hapke_table(entry)
        if phase is not None:
            law = entry["spatialModel"]
            phases[key] = sourced(phase, worst(law["label"], "derived"), law["sources"],
                method="Bare spherical Hapke integral, computed by the app's converged TypeScript integrator "
                       "at build time. Piecewise cubic interpolation of log(I / particle phase factor) "
                       "in log(pi/(pi-alpha)), checked at seven interlaced points per cell to 1e-7. "
                       "Numerical relative accuracy contract 1e-5 over 0 to 179.9 degrees; "
                       "the table extends to crescent width 1e-4 rad. No map/view assumption is introduced.")
            print(f"[albedo_reference] {key} bare Hapke: {len(phase['cells'])} cells", flush=True)
        table = reference_table(int(key), entry)
        if table is not None:
            header = OUT/f"surfaces/{key}/albedo.json"
            h = json.loads(header.read_text()) if header.exists() else {}
            sources = list(dict.fromkeys([*entry["albedoMeasurementView"]["sources"],
                                         *entry["spatialModel"]["sources"], *h.get("sources",[])]))
            product[key] = sourced(table,
                worst(entry["albedoMeasurementView"]["label"], entry["spatialModel"]["label"], h.get("color",{}).get("label","derived"),
                      h.get("provenance",{}).get("label","derived"), "derived"), sources,
                method="Fixed dated-view integral and its bare-sphere factor, precomputed with the pure TypeScript "
                       "normal-space quadrature. Binary16 map rows are evaluated exactly piecewise-linearly "
                       "at position latitude by the accepted exact-row, converged reference integral. Cubic interpolation in log crescent "
                       "width is checked at seven interlaced points to 1e-5; the numerical implementation hash "
                       "is recorded. Tables retain the law, radii, views and "
                       "exact zonal rows; mismatched frame inputs cannot reuse a table. "
                       "The law's crescent power is factored analytically; below delta=1e-8 the limiting "
                       "ratio is held (a numerical endpoint approximation).")
            print(f"[albedo_reference] {key} dated reference: {len(table['cells'])} cells, exact-row reference", flush=True)
    write_json(ctx, "albedo-reference.json", product, "albedo_reference")
    write_json(ctx, "verification/albedo-reference.json", {
        "method": "Build record: exact inputs and numerical tolerance of this run, not observational fixtures.",
        "products": {"albedo-reference.json": ctx.products["albedo-reference.json"]["sha256"]},
        "bodies": {key: {"sourceCodeSha256": entry["value"]["sourceCodeSha256"],
                         "relativeTolerance": entry["value"]["relativeTolerance"],
                         "radiiKm": entry["value"]["radiiKm"],
                         "view": entry["value"]["view"],
                         "mapTileSha256": entry["value"].get("mapTileSha256"),
                         "cells": len(entry["value"]["cells"])} for key, entry in product.items()},
    }, "albedo_reference")

    write_json(ctx, "hapke-phase.json", phases, "albedo_reference")
    write_json(ctx, "verification/hapke-phase.json", {
        "method": "Build record: bare Hapke table inputs and numerical tolerances, not observational fixtures.",
        "products": {"hapke-phase.json": ctx.products["hapke-phase.json"]["sha256"]},
        "bodies": {key: {"sourceCodeSha256": entry["value"]["sourceCodeSha256"],
                         "spatialCodeSha256": entry["value"]["spatialCodeSha256"],
                         "relativeTolerance": entry["value"]["relativeTolerance"],
                         "interpolationTolerance": entry["value"]["interpolationTolerance"],
                         "cells": len(entry["value"]["cells"])} for key, entry in phases.items()},
    }, "albedo_reference")
