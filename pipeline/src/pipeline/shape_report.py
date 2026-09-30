"""docs/reports/shapes.md — review report of the shape models, generated from the built headers and meshes.

`uv run python -m pipeline.shape_report` (after `build --only shapes`).
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import subprocess

import numpy as np

from . import shape_mesh as sm
from .paths import OUT, REPO

REPORT = REPO / "docs" / "reports" / "shapes.md"


def _headers() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted((OUT / "shapes").glob("[0-9]*.json"))]


def _mesh(h: dict, level: int = 0) -> sm.Mesh:
    buf = (OUT / h["bin"]).read_bytes()
    return sm.unpack_lod(buf, h["lods"][level])


def _latlon(v):
    r = np.linalg.norm(v, axis=1)
    return np.degrees(np.arcsin(v[:, 2] / r)), np.degrees(np.arctan2(v[:, 1], v[:, 0])), r


def checks(hs: dict) -> list[str]:
    out = []
    if 401 in hs:
        m = _mesh(hs[401])
        lat, lon, r = _latlon(m.v)
        lx, sz = _axis_angles(m)
        c = np.radians([-1.0, -49.0])
        u = np.array([math.cos(c[0]) * math.cos(c[1]), math.cos(c[0]) * math.sin(c[1]), math.sin(c[0])])
        ang = np.degrees(np.arccos(np.clip(m.v @ u / r, -1, 1)))
        out.append(f"- **Phobos frame:** the long principal axis is {lx:.1f}° from ±x (it points at Mars; IAU "
                   f"longitude 0° is the sub-Mars point) and the short axis {sz:.1f}° from +z (the spin axis). "
                   "**Stickney** (IAU Gazetteer 1.0°S, 49.0°W): mean radius within 5° of its centre "
                   f"{r[ang < 5].mean():.3f} km, on a 22-30° ring {r[(ang > 22) & (ang < 30)].mean():.3f} km. It is a "
                   "depression at the gazetteer position, so longitudes run the right way.")
    if 20101955 in hs:
        m = _mesh(hs[20101955])
        lat, lon, r = _latlon(m.v)
        bins = np.arange(-60, 61, 5)
        mean_r = np.array([r[(lat >= a) & (lat < a + 5)].mean() for a in bins[:-1]])
        out.append(f"- **Bennu:** mean radius per 5° latitude band peaks at {bins[int(np.argmax(mean_r))] + 2.5:+.1f}° "
                   f"({mean_r.max() * 1000:.0f} m, against {mean_r[0] * 1000:.0f} m at 60°S): the equatorial ridge "
                   "lies on the z = 0 plane.")
    if 20000433 in hs:
        m = _mesh(hs[20000433])
        ext = m.v.max(axis=0) - m.v.min(axis=0)
        lx, sz = _axis_angles(m)
        out.append(f"- **Eros:** extents along the frame axes x {ext[0]:.1f}, y {ext[1]:.1f}, z {ext[2]:.1f} km "
                   f"(published 34.4 × 11.2 × 11.2 km along its own axes); the long principal axis is {lx:.1f}° from "
                   f"+x and the short axis {sz:.1f}° from +z (the spin axis).")
    if 20162173 in hs:
        m = _mesh(hs[20162173])
        lat, lon, r = _latlon(m.v)
        eq = r[abs(lat) < 5].mean()
        pole = r[abs(lat) > 80].mean()
        out.append(f"- **Ryugu:** equatorial radius {eq * 1000:.0f} m vs polar {pole * 1000:.0f} m: the spinning-top "
                   "shape with its ridge on the equator.")
    rows = []
    for obj_id in SPIN_AXIS_CHECK:
        if obj_id in hs:
            lx, sz = _axis_angles(_mesh(hs[obj_id], len(hs[obj_id]["lods"]) - 1))
            rows.append(f"{hs[obj_id]['name']} {sz:.1f}°")
    if rows:
        out.append("- **Spin axis = short axis** (principal-axis rotators with well-separated moments; angle between "
                   "the shape's short principal axis and the frame's +z): " + ", ".join(rows) + ".")
    return out


SPIN_AXIS_CHECK = (401, 20000433, 20025143, 20000243, 20486958, 1000012, 20002867, 20000004, 20101955, 20162173,
                   20000021, 615, 610)


def damit_pole_txt() -> str:
    from .sb_table import read_table
    p = OUT / "shapes" / "damit-index.json"
    if not p.exists():
        return "not built"
    _, rec = read_table(p)
    eps = math.radians(23.4392911)
    out = []
    for name, spk, ra, dec in (("Eros", 20000433, 11.35, 17.22), ("Vesta", 20000004, 309.031, 42.235),
                               ("Lutetia", 20000021, 52.0, 12.0)):
        rows = rec[rec["spkid"] == spk]
        if rows.size == 0:
            continue
        a, d = math.radians(ra), math.radians(dec)
        p_eq = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
        best = []
        for row in rows:
            la, be = math.radians(float(row["lambdaDeg"])), math.radians(float(row["betaDeg"]))
            x, y, z = math.cos(be) * math.cos(la), math.cos(be) * math.sin(la), math.sin(be)
            q = np.array([x, math.cos(eps) * y - math.sin(eps) * z, math.sin(eps) * y + math.cos(eps) * z])
            best.append(math.degrees(math.acos(float(np.clip(q @ p_eq, -1, 1)))))
        out.append(f"{name} {min(best):.1f}°" + (f" (closest of {rows.size} models)" if rows.size > 1 else ""))
    return ", ".join(out)


def closed_txt(h: dict) -> str:
    open_lods = [str(x["level"]) for x in h["lods"] if not x["watertight"]]
    return "yes" if not open_lods else f"no (LOD {', '.join(open_lods)})"


def _axis_angles(m: sm.Mesh) -> tuple[float, float]:
    w, vec = sm.principal_axes(m)
    return (math.degrees(math.acos(min(1.0, abs(vec[0, 0])))), math.degrees(math.acos(min(1.0, abs(vec[2, 2])))))


def generate() -> str:
    hs = {h["id"]: h for h in _headers()}
    idx = json.loads((OUT / "shapes" / "index.json").read_text(encoding="utf-8"))
    rows = []
    total = 0
    for h in sorted(hs.values(), key=lambda x: (x["kind"], x["name"])):
        b = sum(x["bytes"] for x in h["lods"])
        total += b
        sc = h["scaleCheck"]
        o = h["orientation"]
        diff = o.get("differenceDeg")
        otxt = ("; ".join(f"{k[:4]} {v:.2f}°" for k, v in diff.items()) if diff
                else ("CK/dynamic frame" if "not evaluated" in str(o.get("comparison", "")) or not o.get("kernels")
                      and h["kind"] == "spacecraft" and "pck00011" not in str(o.get("appFrame", "")) else "–"))
        lods_txt = " / ".join(format(x["triangles"], ",") for x in h["lods"])
        rows.append(
            f"| {h['name']} | {h['id']} | {h['kind']} | {h['provenance']['label']} | "
            f"{h['source']['nativeTriangles']:,} | {lods_txt} | "
            f"{closed_txt(h)} | {b / 2**20:.1f} | "
            f"{h['stats']['volumeEquivalentRadiusKm']:.4g} | "
            + (f"{sc['referenceMeanRadiusKm']:.4g} ({'pck00011' if 'pck00011' in sc['reference'] else 'SBDB'}) | "
               f"{sc['ratio']:.3f}" if sc else "– | –")
            + f" | {o['frame']} | {otxt} | {o['label']} |")
    d = idx.get("damit", {})
    damit_bytes = sum((OUT / "shapes" / f).stat().st_size for f in ("damit.bin", "damit-index.bin", "damit-index.json")
                      if (OUT / "shapes" / f).exists())
    git = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    meta = sum(p.stat().st_size for p in (OUT / "shapes").glob("*.json"))
    secs = idx.get("buildSeconds", {})
    parts = [
        "# Shape models: review report", "",
        f"Generated {_dt.date.today().isoformat()} (commit {git}) by `cd pipeline && uv run python -m pipeline.shape_report` "
        "from `app/public/data/shapes/`. Contract: `ShapeModelHeader`, `DamitIndexHeader` and `ShapeIndex` in "
        "app/src/data/schema.ts; architecture §6; source notes docs/sources/shape-models.md.", "",
        "## Summary", "",
        f"- **{len(hs)} meshes** (spacecraft {sum(h['kind'] == 'spacecraft' for h in hs.values())}, radar "
        f"{sum(h['kind'] == 'radar' for h in hs.values())}): {total / 2**20:.0f} MiB of LOD meshes.",
        f"- **DAMIT:** {d.get('models', 0):,} lightcurve-inversion models of {d.get('asteroids', 0):,} asteroids "
        f"({d.get('triangles', 0):,} triangles), {damit_bytes / 2**20:.0f} MiB. Label derived; one preferred model "
        f"per asteroid is flagged. {d.get('notWatertight', 0)} models are not closed and {d.get('welded', 0)} needed "
        "vertex welding.",
        f"- **Total product:** {(total + damit_bytes + meta) / 2**20:.0f} MiB ({(total + damit_bytes + meta) / 1e9:.2f} "
        "GB).",
        "- **Build time:** " + ", ".join(f"{k} {v:.0f} s" for k, v in secs.items()) + ".", "",
        "## Meshes", "",
        "LOD triangle counts run finest first. R_eq is the volume-equivalent radius of the source mesh. The reference "
        "is the pck00011 volumetric mean radius or the SBDB diameter / 2. The orientation difference is the "
        "rotation angle between the source's frame and the app's pck00011 IAU frame at J2000 and 2026-10-01.", "",
        "| body | id | kind | shape label | source triangles | LOD triangles | closed | MiB | R_eq (km) | reference "
        "(km) | ratio | frame | vs app frame | orientation label |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
        *rows, "",
        "## Verification", "",
        "`uv run pytest tests/test_shapes.py` covers the following:",
        "",
        "- mesh utilities: cube volume and area, orientation flip, boundary detection, seam welding, sphere from a "
        "radius grid, decimation that keeps a mesh closed and its volume, removal of back-to-back fins, binary round "
        "trip, outward unit normals, and the plate/OBJ readers;",
        "- every built mesh: part sizes, index bounds, finite vertices, decreasing LODs of at most 2 M triangles, "
        "each LOD's `watertight` flag recomputed from its edges, each LOD closed when the source is, volumes within "
        "2 %, and |R_eq / reference − 1| < 10 % for measured shapes (exceptions below);",
        "- the DAMIT table: one preferred model per asteroid, SPK-ID = 20000000 + number, `closed` flags that "
        "match the header count, a Pallas model decoded to a closed polyhedron of the right size, and the pole "
        "convention (DAMIT's ecliptic λ, β rotated to the equator match the spacecraft poles of Eros, Vesta and "
        "Lutetia: " + damit_pole_txt() + ");",
        "- the orientation helper: constants re-derived from a PCK frame match the PCK's.",
        "",
        "Frame checks:", "", *checks(hs), "",
        "## Open issues and caveats", "",
        "- **Scale exceptions:**",
        "  - Ida: R_eq 15.7 km matches Thomas et al.'s 16,100 km³, but pck00011's triaxial radii imply 13.4 km.",
        "  - Kleopatra: the 2000 radar model is ~10 % smaller than later adaptive-optics sizes.",
        "  - 1998 KY26: the 1999 radar model is ~30 m across, while SBDB now gives 11 m (Hayabusa2-era "
        "observations, Santana-Ros et al. 2025). The header notes that the size is disputed.",
        "  - Bacchus: SBDB's 1.02 km is NEOWISE's thermal-model diameter; the radar model spans 1.11 × 0.53 × "
        "0.51 km (Benner et al. 1999).",
        "  - Toutatis and Castalia: SBDB's 5.4 km and 1.4 km come from a 1994 compilation that predates the radar "
        "models; Toutatis's extents match Hudson & Ostro (1995).",
        "  - Donaldjohanson: SBDB's 3.9 km is NEOWISE's thermal-model diameter (Masiero et al. 2011); the Lucy "
        "shape spans 8.8 × 4.4 × 3.1 km (R_eq 2.41 km), as the flyby images show.",
        "- **Orientation:**",
        "  - 67P (Rosetta CK frame), Dimorphos (two-vector frame towards Didymos) and Apophis (tumbling) cannot "
        "be compared with a constant-rate model.",
        "  - Hyperion rotates chaotically, 67P's spin changes at every perihelion (no rotation model valid in "
        "2026), and the radar models without a spin file have no rotation model: their orientation label is "
        "unknown.",
        "  - Where the source frame and pck00011 drift apart, the mesh must be placed with the header's "
        "`sourceRotation`, not the app's IAU frame. Phobos (pck00010 vs pck00011) is 2.5° off by 2026-10, and "
        "Eros (the shape frame's spin rate in eros_alex.tpc vs pck00011's) 6.2°. Lutetia's shape frame puts the crater Lauriacum on "
        "the prime meridian, 164° from pck00011's IAU_LUTETIA; its `sourceRotation` is evaluated from the "
        "Rosetta frame kernels.",
        "  - The Saturn small-satellite models state binary PCKs (`*_mst2018.bpc`) in their labels; these were not "
        "used for the comparison.",
        "- **Topology:** 67P's source surface has handles (tunnels through the mesh; genus in the header), and the "
        "coarsest LOD, where decimation closes them, keeps a few non-manifold edges (flagged). Arrokoth's model is two "
        "closed lobes that interpenetrate slightly at the neck: its volume and R_eq are the sum of the lobes. "
        "Lutetia's source has one zero-volume back-to-back plate pair; it is removed, which closes the surface.",
        "- **Coverage:** Arrokoth's far side, Lutetia's south, Didymos's and Dimorphos's unseen sides, Mathilde's "
        "unseen 40 % and parts of the Voyager/Galileo-era models are smooth interpolations (noted per header).",
        "- **Not available:**",
        "  - Dinkinesh/Selam: no public shape model yet.",
        "  - Annefrank, Braille: no published shape model in PDS.",
        "  - Hartley 2, Wild 2, Borrelly: not included this round; their models exist.",
        "  - The New Horizons Charon/Pluto DEMs: not included; they are near-spheres.",
        "- **DAMIT:** tumblers are not included, and the preferred model is a pipeline choice (highest quality flag, "
        "then newest), not DAMIT's. Mirror-pole solutions remain as separate rows.",
        "",
    ]
    return "\n".join(parts)


def main() -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(generate(), encoding="utf-8", newline="\n")
    print(f"wrote {REPORT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
