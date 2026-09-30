"""Build one shape product (shapes/<id>.json + shapes/<id>.bin) from a ShapeSource (shape_catalog.py)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import shape_mesh as sm
from . import shape_orient as so
from .download import fetch, record
from .output import write_bin, write_json
from .schema import BuildContext
from .shape_catalog import ShapeSource
from .surf_fetch import discard
from .surf_layers import register_dataset

STAGE = "shapes"
MIN_LOD_TRIANGLES = 1000
MAX_LODS = 4
BIG_SOURCE_BYTES = 50_000_000          # source files larger than this are deleted after conversion


# ---------------------------------------------------------------------------------------------- inputs


def sbdb(query: str) -> dict:
    """SBDB object record (SPK-ID, full name, physical parameters) via the SBDB API, cached in data/raw."""
    safe = query.replace(" ", "_").replace("/", "_")
    p = fetch("https://ssd-api.jpl.nasa.gov/sbdb.api", "shapes/sbdb", f"{safe}.json",
              params={"sstr": query, "phys-par": "1"},
              validate=lambda q: q.read_bytes()[:1] == b"{")
    return json.loads(p.read_text()), p


def load_mesh(src: ShapeSource) -> tuple[sm.Mesh, dict, list[Path]]:
    path = fetch(src.url, f"shapes/{src.key}", timeout=1800)
    info: dict = {}
    if src.fmt == "dsk":
        mesh, info = sm.read_dsk(path)
    elif src.fmt == "plate":
        mesh = sm.read_plate_table(path)
    elif src.fmt in ("obj", "tab-obj"):
        mesh = sm.read_obj(path)
    elif src.fmt in ("grid-latlon", "grid-lonlat"):
        rows = np.array([[float(x) for x in ln.split()[:3]] for ln in path.read_text().splitlines() if ln.strip()])
        lat, lon = (rows[:, 0], rows[:, 1]) if src.fmt == "grid-latlon" else (rows[:, 1], rows[:, 0])
        if src.lon_west:
            lon = -lon                       # to east longitude
        mesh = sm.from_radius_grid(lat, lon, rows[:, 2])
    else:
        raise ValueError(f"{src.key}: unknown format {src.fmt}")
    return mesh, info, [path]


def parse_spin(csv_path: Path, xml_path: Path) -> list[dict]:
    """Radar spin-state CSV (no header row) zipped with the field names, units and descriptions of its PDS4
    label."""
    import re
    lab = xml_path.read_text()
    fields = []
    for blk in re.findall(r"<Field_Delimited>(.*?)</Field_Delimited>", lab, re.S):
        g = lambda t: (re.search(rf"<{t}>([^<]*)</{t}>", blk) or [None, None])[1]  # noqa: E731
        fields.append({"name": g("name"), "unit": g("unit"), "description": g("description")})
    rows = [ln for ln in csv_path.read_text().splitlines() if ln.strip()]
    vals = [v.strip() for v in rows[0].split(",")]
    if len(vals) != len(fields):
        raise ValueError(f"{csv_path.name}: {len(vals)} values but {len(fields)} label fields")
    out = []
    for f, v in zip(fields, vals):
        try:
            val: float | str = float(v)
        except ValueError:
            val = v
        out.append({**{k: x for k, x in f.items() if x}, "value": val})
    return out


def reference_radius(src: ShapeSource, radii: dict, sb: dict | None) -> dict | None:
    if src.naif is not None and src.naif in radii:
        a, b, c = radii[src.naif]
        return {"referenceMeanRadiusKm": round(float(np.cbrt(a * b * c)), 5),
                "reference": f"pck00011 BODY{src.naif}_RADII {a:g} × {b:g} × {c:g} km, volumetric mean (abc)^(1/3) "
                             "(IAU WGCCRE 2015; for small bodies these radii come from shape work by the same "
                             "teams, so the check is of scale and units rather than independent)"}
    if sb:
        for p in sb.get("phys_par", []):
            if p.get("name") == "diameter" and p.get("value"):
                return {"referenceMeanRadiusKm": round(float(p["value"]) / 2, 5),
                        "reference": f"JPL SBDB diameter {p['value']} km ({p.get('ref') or 'no reference'})"}
    return None


# ---------------------------------------------------------------------------------------------- build


def lod_targets(nf: int, finest: int) -> list[int]:
    out = [min(nf, finest)]
    while len(out) < MAX_LODS and out[-1] // 4 >= MIN_LOD_TRIANGLES:
        out.append(out[-1] // 4)
    return out


def topology_notes(integrity: dict, lods: list[dict], removed: int = 0) -> list[str]:
    out = []
    if removed > 0:
        out.append(f"{removed} source plate(s) removed: degenerate, repeated, or zero-volume back-to-back pairs "
                   "(which would otherwise leave the surface open).")
    if integrity.get("components", 1) > 1:
        out.append(f"The source consists of {integrity['components']} separate closed surfaces (lobes that touch "
                   "or interpenetrate); volume and R_eq are their sum.")
    if integrity.get("genus", 0) > 0:
        out.append(f"The source surface has {integrity['genus']} handle(s) (tunnels through the mesh).")
    if not integrity["watertight"]:
        out.append(f"The source mesh is not closed ({integrity['boundaryEdges']} boundary, "
                   f"{integrity['nonManifoldEdges']} non-manifold, {integrity['inconsistentEdges']} inconsistently "
                   "oriented edges); volumes are approximate.")
    for lod in lods:
        if lod["method"] == "quadric" and not lod["watertight"]:
            d = lod["defectEdges"]
            why = (" where decimation closed a handle narrower than the level's resolution"
                   if integrity.get("genus", 0) > 0 else "")
            out.append(f"LOD {lod['level']} is not closed ({d['boundaryEdges']} boundary, {d['nonManifoldEdges']} "
                       f"non-manifold edges){why}.")
    return out


def build_one(ctx: BuildContext, src: ShapeSource, radii: dict, pck11: Path, keep_raw: bool = False) -> dict:
    mesh, info, paths = load_mesh(src)
    native = {"vertices": mesh.nv, "triangles": mesh.nf}
    m = sm.orient_outward(sm.weld(mesh))
    integrity = sm.edge_report(m)
    sb, sb_path = (sbdb(src.sbdb) if src.sbdb else (None, None))
    obj_id = src.id_override or (int(sb["object"]["spkid"]) if sb else src.naif)
    if obj_id is None:
        raise ValueError(f"{src.key}: no id")

    lods, blobs, off = [], [], 0
    prev = m
    for level, target in enumerate(lod_targets(m.nf, src.finest)):
        tries = 0
        if target < prev.nf:
            lm, tries = sm.decimate_closed(prev, target)
        else:
            lm = prev
        buf, desc = sm.pack_lod(lm)
        rep = sm.edge_report(lm)
        lods.append({"level": level, "triangles": lm.nf, "vertices": lm.nv, "offset": off, "bytes": len(buf),
                     **desc, "method": "quadric" if tries else "source",
                     "watertight": rep["watertight"],
                     **({} if rep["watertight"] else {"defectEdges": {k: rep[k] for k in (
                         "boundaryEdges", "nonManifoldEdges", "inconsistentEdges")}}),
                     "decimationAttempts": tries,
                     "volumeRatioToSource": round(sm.signed_volume(lm) / sm.signed_volume(m), 6)})
        blobs.append(buf)
        off += len(buf)
        prev = lm
    blob = b"".join(blobs)
    rel = f"shapes/{obj_id}"
    write_bin(ctx, f"{rel}.bin", blob, STAGE)

    vol = sm.signed_volume(m)
    req = sm.equivalent_radius(vol)
    ref = reference_radius(src, radii, sb)
    scale = None
    if ref:
        scale = {**ref, "volumeEquivalentRadiusKm": round(req, 5),
                 "ratio": round(req / ref["referenceMeanRadiusKm"], 4)}

    # orientation
    kpaths = [fetch(u, f"shapes/{src.key}/kernels") for u in src.kernels]
    orient = so.compare_isolated(kpaths, src.frame, pck11, src.naif, src.compare_epochs) if (
        src.kind == "spacecraft") else {"frame": src.frame}
    if src.frame_note:
        orient["note"] = src.frame_note
    if info.get("segments"):
        orient["dskSegments"] = info["segments"]
    if src.rotation:
        orient["labelRotation"] = src.rotation
    if src.spin_url:
        sp_path = fetch(src.spin_url, f"shapes/{src.key}")
        lab_path = fetch(src.spin_url.rsplit(".", 1)[0] + ".xml", f"shapes/{src.key}")
        orient["spinState"] = {"file": sp_path.name, "fields": parse_spin(sp_path, lab_path),
                               "frame": "ecliptic J2000 pole; rotational phase at the zero epoch (UTC) as defined "
                                        "in the source label"}
        paths += [sp_path, lab_path]
    orient["label"] = orientation_label(src, orient)

    files = {p.name: record(p) for p in paths}
    for k in kpaths:
        files[k.name] = record(k)
    if sb_path:
        files[sb_path.name] = record(sb_path)
    sid = register_dataset(ctx, f"shape-{src.key}", f"{src.name} shape model", src.citation, src.url, files,
                           license="public (NASA/ESA/JAXA planetary data archives)",
                           notes=f"Native {native['triangles']} triangles; {src.method}.")
    header = {
        "id": obj_id, "name": src.name, "naifId": src.naif,
        "sbdb": ({"spkid": int(sb["object"]["spkid"]), "fullname": sb["object"]["fullname"]} if sb else None),
        "kind": src.kind, "bin": f"{rel}.bin", "units": "km",
        "frame": {"name": src.frame, "origin": "as in the source (centre of mass or of figure)",
                  "axes": "body-fixed, right-handed; +z north (spin) pole unless noted"},
        "orientation": orient,
        "provenance": {"label": src.label, "sources": [sid], "method": src.method,
                       **({"uncertainty": UNCERTAINTY[src.label]} if src.label in UNCERTAINTY else {})},
        "source": {"file": Path(src.url).name, "nativeVertices": native["vertices"],
                   "nativeTriangles": native["triangles"], "weldedVertices": m.nv, "weldedTriangles": m.nf,
                   "integrity": integrity},
        "stats": {"volumeKm3": round(vol, 6), "areaKm2": round(sm.area(m), 6),
                  "volumeEquivalentRadiusKm": round(req, 6),
                  "centroidKm": [round(float(x), 6) for x in sm.centroid(m)],
                  "boundsKm": [[round(float(x), 5) for x in m.v.min(axis=0)],
                               [round(float(x), 5) for x in m.v.max(axis=0)]]},
        "scaleCheck": scale,
        "lods": lods,
        "layout": ("Per LOD, at `offset` in the .bin: positions float32 xyz (km), normals int16 snorm xyz "
                   "(÷ 32767), indices uint16/uint32 (3 per triangle, counter-clockwise seen from outside); part "
                   "offsets are relative to the LOD offset, each part padded to 4 bytes. LOD 0 is the finest; each "
                   "further LOD has ~1/4 of the triangles (quadric-error decimation, Garland & Heckbert 1997)."),
        "notes": list(src.notes) + topology_notes(integrity, lods, native["triangles"] - m.nf),
    }
    write_json(ctx, f"{rel}.json", header, STAGE)
    if not keep_raw:
        for p in paths:
            if p.stat().st_size > BIG_SOURCE_BYTES:
                discard(p)
    print(f"[shapes] {src.name}: {m.nf} → {[x['triangles'] for x in lods]} triangles, {len(blob) / 2**20:.1f} MiB, "
          f"R_eq {req:.4f} km" + (f" (ratio {scale['ratio']:.3f})" if scale else ""), flush=True)
    return header


UNCERTAINTY = {
    "estimated": "hand-fitted to a few low-resolution limb views; errors of ~10 % of the radius are possible",
}


def orientation_label(src: ShapeSource, orient: dict) -> str:
    """measured: the frame is defined by the mission's measured rotation model (or the spin state of the radar
    fit); unknown: no rotation model valid today (Hyperion's chaotic rotation, 67P's perihelion-to-perihelion spin
    changes, radar models without spin state)."""
    if src.key in ("hyperion", "67p") or (src.kind == "radar" and not src.spin_url and src.key != "toutatis"):
        return "unknown"
    return "measured"


def summarize(headers: list[dict]) -> dict:
    return {str(h["id"]): {"name": h["name"], "file": f"shapes/{h['id']}.json", "kind": h["kind"],
                           "label": h["provenance"]["label"], "trianglesFinest": h["lods"][0]["triangles"],
                           "lods": len(h["lods"]),
                           "bytes": sum(x["bytes"] for x in h["lods"]),
                           "volumeEquivalentRadiusKm": h["stats"]["volumeEquivalentRadiusKm"],
                           "scaleRatio": (h["scaleCheck"] or {}).get("ratio"),
                           "orientationLabel": h["orientation"]["label"]}
            for h in sorted(headers, key=lambda x: x["id"])}


def angle_note(h: dict) -> str | None:
    d = h["orientation"].get("differenceDeg")
    if not d:
        return None
    return ", ".join(f"{k[:10]}: {v:.3f}°" for k, v in d.items() if isinstance(v, float) and not math.isnan(v))
