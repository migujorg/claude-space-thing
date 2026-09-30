"""`bodies` stage -> app/public/data/bodies.json (Body[] per app/src/data/schema.ts).

Radii and IAU rotation models come from NAIF pck00011.tpc, GMs from gm_de440.tpc, both read through SPICE's
kernel-pool parser. `photometry` is not written here (the `light` stage produces photometry.json).

Ephemeris wiring: `ephemeris` names the product holding the body's own segment; `ephemerisFiles` lists every
product needed to chain it to the SSB, read from the headers the `ephemeris` stage wrote.
"""

from __future__ import annotations

import json

from ..ephem_kernels import PLANETARY, SRC_GM, SRC_PCK, gd, gi, gm, pck, pool
from ..output import write_json
from ..paths import OUT
from ..schema import BuildContext, sourced, unknown

DEPENDS: tuple[str, ...] = ("ephemeris",)

EPHEM_PRODUCTS = (f"ephem/{PLANETARY}", "ephem/centers")

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

ROTATION_METHOD = (
    "IAU WGCCRE rotational elements as encoded in pck00011.tpc. Evaluate as SPICE BODEUL/TISBOD: d = TDB days and "
    "T = Julian centuries past J2000; theta_i = sum_k nutPrecAngles[i][k] T^k (degree nutPrecAnglesDegree); "
    "RA = poly(poleRa, T) + sum a_i sin(theta_i); Dec = poly(poleDec, T) + sum d_i cos(theta_i); "
    "W = poly(pm, d) + sum w_i sin(theta_i); ICRF->body = R3(W) R1(90deg - Dec) R3(90deg + RA). Degrees throughout."
)

ROTATION_UNCERTAINTY = {
    399: "Low precision: NAIF states the IAU_EARTH prime meridian is in error by at least 150 arcsec (no nutation, "
         "UT1, or polar motion). A binary Earth PCK (ITRF93) is needed for high precision.",
    301: "Trigonometric approximation of the lunar Mean Earth/Polar Axis frame (IAU 2009 report); not the DE440 "
         "lunar libration solution.",
}


def run(ctx: BuildContext) -> None:
    pck_path, gm_path = pck(ctx), gm(ctx)
    owner = _segment_owners()

    out = []
    with pool(pck_path, gm_path):
        for naif, name, kind, parent in BODIES:
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
            body["gm"] = (sourced(g[0], "measured", [SRC_GM], unit="km^3/s^2",
                                  method=f"BODY{naif}_GM from gm_de440.tpc.")
                          if g else unknown(f"no BODY{naif}_GM in gm_de440.tpc"))
            rot = _rotation(naif)
            body["rotation"] = (sourced(rot, "measured", [SRC_PCK], unit="deg (pole terms per Julian century, pm terms per day)",
                                        method=ROTATION_METHOD, uncertainty=ROTATION_UNCERTAINTY.get(naif))
                                if rot is not None else unknown(f"no BODY{naif}_POLE_RA/DEC/PM in pck00011.tpc"))
            out.append(body)
    write_json(ctx, "bodies.json", out, "bodies")
    print(f"[bodies] {len(out)} bodies")


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


def _segment_owners() -> dict[int, tuple[str, int]]:
    """target -> (product, center) from the ephemeris headers."""
    owner: dict[int, tuple[str, int]] = {}
    for name in EPHEM_PRODUCTS:
        path = OUT / f"{name}.json"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing: run the ephemeris stage first")
        for s in json.loads(path.read_text())["segments"]:
            owner[s["target"]] = (name, s["center"])
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
