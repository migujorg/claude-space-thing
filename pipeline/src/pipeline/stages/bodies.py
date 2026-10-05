"""`bodies` stage -> app/public/data/bodies.json (Body[] per app/src/data/schema.ts) and orient/{earth,moon}.

Bodies: the Sun, planets, the Moon and Pluto, plus every moon in the ephemeris stage's satellite products.
- names: SPICE's own name table plus NAIF's satellite name/ID kernels (*_nameid.tf); else the name in the
  satellite kernel's "Bodies on the File" table;
- radii and IAU rotation models: NAIF pck00011.tpc where it has them, else `unknown` (no shape or synchronous
  rotation is assumed);
- GM: gm_de440.tpc, else a GM published in the satellite kernel's comments, else `unknown`. A GM of 0 in either
  place means "integrated as massless" and is reported as unknown;
- ephemeris wiring: `ephemeris` names the product holding the body's own segment, `ephemerisFiles` every product
  needed to chain it to the SSB (read from the ephemeris headers);
- `orientation`: the precise-orientation product for bodies that have one (Earth: ITRF93; Moon: DE440 ME frame).
`photometry` is not written here (the `light` stage produces photometry.json).

Build record `verification/orientation.json`: SPICE's own body-fixed -> J2000 matrices (pxform) from the very
kernel files this run copied orient/earth and orient/moon from, at epochs spread over every segment, with the
sha256 of those kernels and of the products. NAIF reissues the Earth kernel as measurements arrive, so SPICE values
are a reference for one kernel revision only: a test of "another implementation reads this product as SPICE reads
its kernels" compares with this record, never with values computed from another revision.
"""

from __future__ import annotations

import json
import re

import numpy as np
import spiceypy as sp
from spiceypy.utils.exceptions import NotFoundError

from .. import ephem_orient as orient
from .. import ephem_satellites as sat
from ..ephem_kernels import PLANETARY, SRC_GM, SRC_PCK, gd, gi, gm, lsk, pck, pool
from ..output import write_json
from ..paths import OUT, RAW
from ..schema import BuildContext, sourced, unknown
from .ephemeris import MARGIN_S

DEPENDS: tuple[str, ...] = ("ephemeris",)

# (NAIF id, name, kind, UI parent). Kinds follow schema.ts BodyKind; Pluto is a dwarf planet (IAU 2006 B5/B6).
BODIES = [
    (10, "Sun", "star", None),
    (199, "Mercury", "planet", None),
    (299, "Venus", "planet", None),
    (399, "Earth", "planet", None),
    (301, "Moon", "moon", 399),
    (499, "Mars", "planet", None),
    (599, "Jupiter", "planet", None),
    (699, "Saturn", "planet", None),
    (799, "Uranus", "planet", None),
    (899, "Neptune", "planet", None),
    (999, "Pluto", "dwarf-planet", None),
]
PLANET_CENTERS = {499, 599, 699, 799, 899, 999}

ROTATION_METHOD = (
    "IAU WGCCRE rotational elements as encoded in pck00011.tpc. Evaluate as SPICE BODEUL/TISBOD: d = TDB days and "
    "T = Julian centuries past J2000; theta_i = sum_k nutPrecAngles[i][k] T^k (degree nutPrecAnglesDegree); "
    "RA = poly(poleRa, T) + sum a_i sin(theta_i); Dec = poly(poleDec, T) + sum d_i cos(theta_i); "
    "W = poly(pm, d) + sum w_i sin(theta_i); ICRF->body = R3(W) R1(90deg - Dec) R3(90deg + RA). Degrees throughout."
)

ROTATION_UNCERTAINTY = {
    399: "Low precision: NAIF states the IAU_EARTH prime meridian is in error by at least 150 arcsec (no nutation, "
         "UT1, or polar motion); measured vs ITRF93: ~300 arcsec in 2025-26. Use orient/earth (ITRF93) where it covers.",
    301: "Trigonometric approximation of the lunar Mean Earth/Polar Axis frame (IAU 2009 report); not the DE440 "
         "lunar libration solution. Use orient/moon (DE440, ME frame) where it covers.",
}
ORIENTATION = {399: "orient/earth", 301: "orient/moon"}
VERIFICATION = "verification/orientation.json"
RECORD_SAMPLES = 16   # epochs per product segment in the build record, evenly spread strictly inside it


def run(ctx: BuildContext) -> None:
    pck_path, gm_path = pck(ctx), gm(ctx)
    # Order matters: a planet centre is owned by ephem/centers (tiny, loaded first), not by its sat-* duplicate.
    products = [f"ephem/{PLANETARY}", "ephem/centers"] + sorted(f"ephem/{p.stem}" for p in (OUT / "ephem").glob("sat-*.json"))
    owner = _segment_owners(products)
    t0, t1 = ctx.start_et - MARGIN_S, ctx.end_et + MARGIN_S

    # Names and GMs published in the satellite kernels, keyed by body; plus which kernel serves each moon.
    kernel_names: dict[int, str] = {}
    kernel_gms: dict[int, tuple[float, str]] = {}
    for k in sat.KERNELS:
        path = sat.kernel_path(k, t0, t1)
        if not path.exists():
            raise FileNotFoundError(f"{path} missing: run the ephemeris stage first")
        names, gms = sat.kernel_tables(path)
        for i, n in names.items():
            kernel_names.setdefault(i, n)
        for i, g in gms.items():
            kernel_gms.setdefault(i, (g, k.source_id))
    moons = sorted(t for t, (f, _c) in owner.items() if f.startswith("ephem/sat-"))

    fks = sat.nameid_fks()
    out = []
    with pool(pck_path, gm_path, *fks):
        for naif, name, kind, parent in BODIES:
            out.append(_body(naif, name, kind, parent, owner, kernel_gms))
        for naif in moons:
            center = owner[naif][1]
            parent = 100 * center + 99 if center < 10 else center
            out.append(_body(naif, _name(naif, kernel_names), "moon", parent, owner, kernel_gms))

    # Precise orientation products (orient/ belongs to this stage).
    esegs, ebodies = orient.earth(ctx, t0, t1, lsk())
    orient.write(ctx, "earth", esegs, ebodies, "bodies", notes=(
        "Earth (399) body-fixed frame ITRF93 from NAIF's binary Earth PCKs; Euler angles relative to ECLIPJ2000. "
        "measured before the last EOP datum, estimated (predictions) after."))
    msegs, mbodies = orient.moon(ctx, t0, t1)
    orient.write(ctx, "moon", msegs, mbodies, "bodies", notes=(
        "Moon (301) Mean Earth/Polar Axis frame MOON_ME_DE440_ME421 = DE440 principal axes (moon_pa_de440) rotated "
        "by the constant rotation of moon_de440_250416.tf."))
    write_json(ctx, VERIFICATION, orientation_record(ctx), "bodies", indent=None)
    for f in (OUT / "orient").iterdir():
        if f"orient/{f.name}" not in ctx.products:
            f.unlink()

    write_json(ctx, "bodies.json", out, "bodies")
    known = {k: sum(1 for b in out if b[k]["label"] != "unknown") for k in ("radii", "gm", "rotation")}
    print(f"[bodies] {len(out)} bodies ({len(moons)} moons besides the Moon); known: {known}")


def orientation_record(ctx: BuildContext) -> dict:
    """SPICE pxform(frame, 'J2000', et) on the kernels the orientation products were just copied from (the files
    named by the stage's SourceRecords), at RECORD_SAMPLES epochs inside every product segment."""
    order = (orient.SRC_EARTH_PRED, orient.SRC_EARTH_HP, orient.SRC_MOON_PA, orient.SRC_MOON_FK)
    kernels = []
    for sid in order:   # the high-precision Earth file after the predict file: it takes priority, as in orient/earth
        src = ctx.sources[sid]
        path = RAW / "naif" / ("fk-satellites" if src.version.endswith(".tf") else "pck") / src.version
        kernels.append((sid, src, path))
    bodies = []
    with pool(*(k[2] for k in kernels)):
        for product in dict.fromkeys(ORIENTATION.values()):
            header = json.loads((OUT / f"{product}.json").read_text(encoding="utf-8"))
            for body, info in header["bodies"].items():
                cases = []
                for n, seg in enumerate(header["segments"]):
                    if seg["body"] != int(body):
                        continue
                    for k in range(RECORD_SAMPLES):
                        et = seg["startEt"] + (seg["endEt"] - seg["startEt"]) * (k + 0.5) / RECORD_SAMPLES
                        m = np.array(sp.pxform(info["frame"], "J2000", et)).reshape(-1)
                        cases.append({"et": et, "segment": n, "label": seg["label"], "sources": seg["sources"],
                                      "bodyToJ2000": [float(x) for x in m]})
                bodies.append({"id": int(body), "frame": info["frame"], "product": product, "cases": cases})
    names = [f"{p}.{ext}" for p in dict.fromkeys(ORIENTATION.values()) for ext in ("json", "bin")]
    return {
        "description": "Build record of the bodies stage: SPICE's evaluation (spiceypy.pxform(frame, 'J2000', et), "
                       "row-major body-fixed -> J2000) of the kernel files this run copied the orientation products "
                       "from. Read by tests that compare another evaluator of those products with SPICE on this "
                       "same build.",
        "stage": "bodies", "window": {"startEt": ctx.start_et, "endEt": ctx.end_et},
        "products": {k: ctx.products[k]["sha256"] for k in names},
        "spiceVersion": sp.tkvrsn("TOOLKIT"),
        "kernels": [{"source": sid, "file": src.version, "sha256": src.sha256} for sid, src, _ in kernels],
        "samplesPerSegment": RECORD_SAMPLES, "bodies": bodies,
    }


def _body(naif: int, name: str, kind: str, parent: int | None, owner, kernel_gms) -> dict:
    body: dict = {"id": naif, "name": name, "kind": kind}
    if parent is not None:
        body["parent"] = parent
    files = _chain_files(naif, owner)
    body["ephemeris"] = files[0]
    body["ephemerisFiles"] = files
    radii = gd(f"BODY{naif}_RADII")
    body["radii"] = (sourced(radii, "measured", [SRC_PCK], unit="km",
                             method=f"BODY{naif}_RADII from pck00011.tpc (triaxial a, b, c).")
                     if radii and len(radii) == 3 else unknown(f"no BODY{naif}_RADII in pck00011.tpc"))
    g = gd(f"BODY{naif}_GM")
    if g and g[0] > 0:
        body["gm"] = sourced(g[0], "measured", [SRC_GM], unit="km^3/s^2", method=f"BODY{naif}_GM from gm_de440.tpc.")
    elif naif in kernel_gms:
        v, src = kernel_gms[naif]
        body["gm"] = sourced(v, "measured", [src], unit="km^3/s^2",
                             method=f"GM of {naif} published in the comments of the satellite kernel ({src}): the "
                                    "value used in the JPL ephemeris integration.")
    else:
        body["gm"] = unknown("no GM in gm_de440.tpc or the satellite kernel" +
                             (" (gm_de440.tpc lists 0: integrated as massless, not a measured mass)" if g else ""))
    rot = _rotation(naif)
    body["rotation"] = (sourced(rot, "measured", [SRC_PCK], unit="deg (pole terms per Julian century, pm terms per day)",
                                method=ROTATION_METHOD, uncertainty=ROTATION_UNCERTAINTY.get(naif))
                        if rot is not None else unknown(f"no BODY{naif}_POLE_RA/DEC/PM in pck00011.tpc"))
    if naif in ORIENTATION:
        body["orientation"] = ORIENTATION[naif]
    return body


def _name(naif: int, kernel_names: dict[int, str]) -> str:
    """NAIF name, written as JPL writes it: 'IO' -> 'Io', 'S/2003_J_2' -> 'S/2003 J 2'."""
    try:
        n = sp.bodc2n(naif)
    except NotFoundError:
        n = kernel_names.get(naif)
        if n is None:
            raise ValueError(f"no name for NAIF id {naif} in SPICE, the name/ID kernels or the satellite kernel")
    n = n.replace("_", " ")
    return n.title() if re.fullmatch(r"[A-Z][A-Z '\-]*", n) else n


def _rotation(naif: int) -> dict | None:
    ra, dec, pm = gd(f"BODY{naif}_POLE_RA"), gd(f"BODY{naif}_POLE_DEC"), gd(f"BODY{naif}_PM")
    if ra is None or dec is None or pm is None:
        return None
    rot: dict = {"poleRa": ra, "poleDec": dec, "pm": pm}
    terms = {k: gd(f"BODY{naif}_NUT_PREC_{s}") for k, s in (("nutPrecRa", "RA"), ("nutPrecDec", "DEC"),
                                                               ("nutPrecPm", "PM"))}
    if any(v is not None for v in terms.values()):
        # SPICE: the phase angles belong to the system barycenter (id // 100 for planets and satellites).
        system = naif // 100
        angles = gd(f"BODY{system}_NUT_PREC_ANGLES")
        degree = gi(f"BODY{system}_MAX_PHASE_DEGREE") or 1
        if angles is None or len(angles) % (degree + 1):
            raise ValueError(f"BODY{system}_NUT_PREC_ANGLES missing or not a multiple of {degree + 1}")
        n_angles = len(angles) // (degree + 1)
        for k, v in terms.items():
            if v is not None:
                if len(v) > n_angles:
                    raise ValueError(f"BODY{naif} {k}: {len(v)} terms but only {n_angles} angles")
                rot[k] = v
        rot["nutPrecAngles"] = angles
        rot["nutPrecAnglesDegree"] = degree
    return rot


def _segment_owners(products: list[str]) -> dict[int, tuple[str, int]]:
    """target -> (product, center) from the ephemeris headers; the first product listing a target owns it.

    Only planet centres may appear twice (ephem/centers and their sat-* file, identical records).
    """
    owner: dict[int, tuple[str, int]] = {}
    for name in products:
        path = OUT / f"{name}.json"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing: run the ephemeris stage first")
        for s in json.loads(path.read_text(encoding="utf-8"))["segments"]:
            t = s["target"]
            if t in owner and owner[t][0] != name:
                if t not in PLANET_CENTERS or owner[t][1] != s["center"]:
                    raise ValueError(f"target {t} in both {owner[t][0]} and {name}")
                continue
            owner[t] = (name, s["center"])
    return owner


def _chain_files(naif: int, owner: dict[int, tuple[str, int]]) -> list[str]:
    files: list[str] = []
    node = naif
    while node != 0:
        if node not in owner:
            raise ValueError(f"no ephemeris segment chains {naif} to the SSB (missing {node})")
        f, node = owner[node]
        if f not in files:
            files.append(f)
    return files
