"""`sbphotometry` stage -> app/public/data/smallbodies/photometry.json: what the app needs to turn a small body's
magnitude parameters into light at the eye (app/src/gpu/smallbodies, docs/reports/small-bodies.md "GPU field").

Contents (every number from a downloaded file, or computed here from the built smallbodies/ products):
  - vSun: apparent V of the Sun at 1 AU (Willmer 2018, Table 3; the same value the planet photometry uses).
  - sunIrradianceXYZS1AU: the Sun's CIE X, Y, Z and scotopic illuminance at 1 AU, recomputed exactly as for the
    Gaia colours (TSIS-1 HSRS on the CIE grid) and checked against light.json.
  - hg: the IAU H-G phase function (Bowell et al. 1989, Eq. A4) - coefficients parsed from sbpy's implementation.
  - hg1g2: the H-G1-G2 basis functions (Muinonen et al. 2010) - spline nodes, values and end derivatives parsed from
    sbpy's implementation, plus the piecewise-cubic coefficients built with sbpy's own spline construction.
  - colour: the colour of an object relative to sunlight, c = geometricAlbedoXYZS / (p_V E_sun) per channel (for
    Gaia-derived spectra; p_V cancels), its distribution (bounds the "brightness only" rule), and population means
    per taxonomic class / complex / SBDB orbit class used as the estimated colour of objects without a spectrum.
  - rules: the label rules the GPU field applies (strict / best / complete).
Also writes app/tests/fixtures/smallbody_photometry.json: JPL Horizons APmag, r, Delta and phase angle for a few
asteroids (fetched, sha256-recorded) with our catalogue H, G, for the photometry unit test.
"""

from __future__ import annotations

import ast
import datetime as _dt
import io
import json
import math
import re
import tarfile
import time
from pathlib import Path

import numpy as np

from .. import cie
from ..download import fetch, record, sha256_file
from ..output import write_json
from ..paths import OUT
from ..photometry import solar
from ..photometry.albedo import WILLMER, sun_mag
from ..photometry.common import Download
from ..sb_table import LABEL_CODE, read_table
from ..schema import BuildContext, SourceRecord

DEPENDS: tuple[str, ...] = ("smallbodies", "light")
STAGE = "sbphotometry"
DIR = "smallbodies"

SBPY = Download(
    id="sbpy-0.6.0",
    url="https://files.pythonhosted.org/packages/5e/90/a8bb907907a34e0683441f6750a224849cc6b4841f3eb6ed3c2a319d1b23/"
        "sbpy-0.6.0.tar.gz",
    subdir="sbpy", name="sbpy-0.6.0.tar.gz",
    title="sbpy 0.6.0 source distribution: sbpy/photometry/iau.py (IAU H-G and H-G1-G2 disk-integrated phase functions)",
    citation="Mommert, M., Kelley, M. S. P., de Val-Borro, M., Li, J.-Y., Guzman, G., Sipocz, B., Durech, J., "
             "Granvik, M., Grundy, W., Moskovitz, N., Penttila, A. & Samarasinha, N. (2019). sbpy: A Python module for "
             "small-body planetary astronomy. Journal of Open Source Software 4(38), 1426. DOI:10.21105/joss.01426. "
             "Functions implemented: Bowell, E. et al. (1989), Application of photometric models to asteroids, in "
             "Asteroids II, 524-556, Eq. A4 (H-G); Muinonen, K., Belskaya, I. N., Cellino, A., Delbo, M., "
             "Levasseur-Regourd, A.-C., Penttila, A. & Tedesco, E. F. (2010). A three-parameter magnitude phase "
             "function for asteroids. Icarus 209, 542-555. DOI:10.1016/j.icarus.2010.04.003 (H-G1-G2 basis "
             "functions, cubic splines).",
    version="0.6.0", license="BSD-3-Clause",
    notes="Constants parsed from sbpy/photometry/iau.py inside the tarball (classes HG and HG12BaseClass); the "
          "tarball's sha256 equals the digest PyPI publishes for sbpy-0.6.0.tar.gz.",
)
SBPY_PYPI_SHA256 = "3b88a53688a26bc2b572e1f4543fdae4fe2f4fe6c305085432dcc7ff614c6cb7"

HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
# Asteroids for the photometry test: fitted G (Ceres, Vesta, Eros, Apophis) and the conventional G = 0.15 (two
# numbered main-belt asteroids picked by number, whatever their photometry).
TEST_SPKIDS = (20000001, 20000004, 20000433, 20099942, 20001000, 20010000)
TEST_EPOCHS_JD = (2460827.5, 2461313.5, 2461740.5)   # 2025-06-01, 2026-09-30, 2027-12-01 00:00 UT
FIXTURE = Path(__file__).resolve().parents[4] / "app" / "tests" / "fixtures" / "smallbody_photometry.json"
MIN_CLASS_SAMPLE = 20
M, D, E, U = LABEL_CODE["measured"], LABEL_CODE["derived"], LABEL_CODE["estimated"], LABEL_CODE["unknown"]


# ---------------------------------------------------------------------------------------------- sbpy constants
def sbpy_iau_source() -> str:
    path = SBPY.fetch()
    if sha256_file(path) != SBPY_PYPI_SHA256:
        raise ValueError(f"{path}: sha256 differs from the PyPI digest {SBPY_PYPI_SHA256}")
    with tarfile.open(path, "r:gz") as tf:
        member = tf.getmember("sbpy-0.6.0/sbpy/photometry/iau.py")
        return tf.extractfile(member).read().decode("utf-8")


def _num_list(node: ast.AST) -> list[float]:
    """A list literal, or np.deg2rad(<list literal>) (converted), of numbers."""
    if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "deg2rad":
        return [math.radians(v) for v in ast.literal_eval(node.args[0])]
    return [float(v) for v in ast.literal_eval(node)]


def hg1g2_nodes(src: str) -> dict[str, dict]:
    """_phi1v, _phi2v, _phi3v of class HG12BaseClass: (nodes [rad], values, [dy_left, dy_right])."""
    tree = ast.parse(src)
    cls = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef) and n.name == "HG12BaseClass")
    out = {}
    for st in cls.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and getattr(st.targets[0], "id", "") in (
                "_phi1v", "_phi2v", "_phi3v"):
            x, y, dy = (_num_list(e) for e in st.value.elts)
            out[st.targets[0].id[1:5]] = {"nodesRad": x, "values": y, "endDerivatives": dy}
    if sorted(out) != ["phi1", "phi2", "phi3"]:
        raise ValueError(f"sbpy iau.py: basis node tables not found (got {sorted(out)})")
    return out


def spline_coefficients(x: list[float], y: list[float], dy: list[float]) -> list[list[float]]:
    """Per-interval [A0, A1, A2, A3] of y = sum A_k (t - x_i)^k: sbpy's _spline construction (clamped cubic spline:
    C2 at the interior nodes, given first derivatives at both ends)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    n = y.size
    h = x[1:] - x[:-1]
    r = (y[1:] - y[:-1]) / h
    B = np.zeros((n - 2, n))
    C = np.empty(n - 2)
    for i in range(n - 2):
        k = i + 1
        B[i, i:i + 3] = [h[k], 2 * (h[k - 1] + h[k]), h[k - 1]]
        C[i] = 3 * (r[k - 1] * h[k] + r[k] * h[k - 1])
    C[0] -= dy[0] * B[0, 0]
    C[-1] -= dy[1] * B[-1, -1]
    dys = np.concatenate([[dy[0]], np.linalg.solve(B[:, 1:n - 1], C), [dy[1]]])
    a2 = (3 * r - 2 * dys[:-1] - dys[1:]) / h
    a3 = (-2 * r + dys[:-1] + dys[1:]) / h ** 2
    return [[float(y[i]), float(dys[i]), float(a2[i]), float(a3[i])] for i in range(n - 1)]


def eval_basis(b: dict, alpha: float) -> float:
    """sbpy's evaluation: linear extrapolation beyond the end nodes, cubic pieces between, clipped at 0."""
    x = b["nodesRad"]
    if alpha < x[0]:
        v = b["values"][0] + b["endDerivatives"][0] * (alpha - x[0])
    elif alpha >= x[-1]:
        v = b["values"][-1] + b["endDerivatives"][1] * (alpha - x[-1])
    else:
        i = max(k for k in range(len(x) - 1) if x[k] <= alpha)
        t = alpha - x[i]
        a = b["coefficients"][i]
        v = a[0] + t * (a[1] + t * (a[2] + t * a[3]))
    return max(v, 0.0)


def hg_phi(hg: dict, alpha: float, g: float) -> float:
    """(1 - G) Phi_1 + G Phi_2 of the IAU H-G system as sbpy evaluates it."""
    t = math.tan(alpha / 2)
    s = math.sin(alpha)
    w = math.exp(-hg["W"] * t * t)
    s0, s1, s2 = hg["smallPhase"]
    out = []
    for i in (0, 1):
        ps = 1 - hg["C"][i] * s / (s0 + s1 * s - s2 * s * s)
        pl = math.exp(-hg["A"][i] * t ** hg["B"][i])
        out.append(w * ps + (1 - w) * pl)
    return (1 - g) * out[0] + g * out[1]


def hg_constants(src: str) -> dict:
    """Coefficients of HG._hgphi (Bowell et al. 1989 Eq. A4), checked against the expected expression shapes."""
    m = re.search(r"a, b, c = \[([-\d.e]+), ([-\d.e]+)\], \[([-\d.e]+), ([-\d.e]+)\], \[([-\d.e]+), ([-\d.e]+)\]", src)
    w = re.search(r"w = np\.exp\(-([\d.]+) \* tan_pha_half \* tan_pha_half\)", src)
    s = re.search(r"phiis = 1 - c\[i-1\]\*sin_pha/\(([\d.]+)\+([\d.]+)\*sin_pha -\s*\n?\s*([\d.]+)\*sin_pha\*sin_pha\)", src)
    ll = re.search(r"phiil = np\.exp\(-a\[i-1\] \* tan_pha_half\*\*b\[i-1\]\)", src)
    if not (m and w and s and ll):
        raise ValueError("sbpy iau.py: HG._hgphi does not have the expected form")
    v = [float(g) for g in m.groups()]
    return {"A": v[0:2], "B": v[2:4], "C": v[4:6], "W": float(w.group(1)),
            "smallPhase": [float(g) for g in s.groups()],
            "form": "Phi_i = W Phi_iS + (1 - W) Phi_iL, W = exp(-W tan^2(a/2)), Phi_iS = 1 - C_i sin a / (s0 + s1 sin a "
                    "- s2 sin^2 a) with smallPhase = [s0, s1, s2], Phi_iL = exp(-A_i tan(a/2)^B_i); "
                    "V = H + 5 log10(r Delta) - 2.5 log10((1 - G) Phi_1 + G Phi_2), r and Delta in au."}


# ---------------------------------------------------------------------------------------------- colours
def _col(data: np.ndarray, name: str) -> np.ndarray:
    return data[name]


def colour_tables(core_h: dict, core: np.ndarray, phys_h: dict, phys: np.ndarray, sun: np.ndarray) -> dict:
    """Colour relative to sunlight per object with a Gaia spectrum, and population means per class."""
    rows = phys["row"].astype(np.int64)
    xyzs = phys["geometricAlbedoXYZS"].astype(np.float64)
    clab = phys["colorLabel"]
    alab = phys["albedoLabel"]
    classes = [c["code"] for c in core_h["orbitClasses"]]
    ocls = core["orbitClass"][rows]
    pv_class = np.array([core_h["classAlbedo"].get(classes[k] if k < len(classes) else "", core_h["classAlbedo"]["*"])
                         ["median"] for k in ocls])
    pv = np.where(alab == M, phys["albedo"].astype(np.float64), pv_class)
    has = (clab != U) & np.all(np.isfinite(xyzs), axis=1)
    c = np.full((phys.size, 4), np.nan)
    c[has] = xyzs[has] / (pv[has, None] * sun[None, :])
    # Spectral shape measured without bridging a gap inside 418-814 nm: colorLabel derived, or (albedo not measured,
    # which alone makes colorLabel estimated) all 12 Gaia bands 374-858 nm used.
    shape_ok = has & ((clab == D) | ((alab != M) & (phys["gaiaBands"] == 12)))

    def summary(sel: np.ndarray) -> dict:
        v = c[sel]
        return {"cXYZS": [float(x) for x in v.mean(axis=0)], "sd": [float(x) for x in v.std(axis=0, ddof=1)],
                "n": int(sel.sum())}

    tax_names = phys_h["taxonomySsodnet"]
    tb = phys["taxonomyBft"]
    tclass = np.array(["" if k == 0 else tax_names[k].split("|")[1].rstrip(":") for k in tb], dtype=object)
    by_class, by_complex = {}, {}
    for k in sorted(set(tclass[shape_ok]) - {""}):
        sel = shape_ok & (tclass == k)
        if sel.sum() >= MIN_CLASS_SAMPLE:
            by_class[k] = summary(sel)
    comp = np.array([t[:1].upper() for t in tclass], dtype=object)
    for k in sorted(set(comp[shape_ok]) - {""}):
        sel = shape_ok & (comp == k)
        if sel.sum() >= MIN_CLASS_SAMPLE:
            by_complex[k] = summary(sel)
    by_orbit = {}
    for k in sorted(set(ocls[shape_ok])):
        sel = shape_ok & (ocls == k)
        if sel.sum() >= MIN_CLASS_SAMPLE and k < len(classes):
            by_orbit[classes[k]] = summary(sel)
    cy = c[shape_ok, 1]
    return {
        "definition": "c_k = geometricAlbedoXYZS_k / (p_V * sunIrradianceXYZS1AU_k), k = X, Y, Z, S, with p_V the "
                      "albedo the Gaia colour was scaled by (physical.albedo where measured, else core classAlbedo "
                      "median of the object's SBDB orbit class). p_V cancels: c is the spectrum's colour relative to "
                      "sunlight, normalised to the Bessell-V solar-weighted reflectance. An object of apparent V "
                      "magnitude m delivers E_k = sunIrradianceXYZS1AU_k * c_k * 10^(-0.4 (m - vSun)).",
        "shapeDerivedRule": "The spectral shape is derived (measured Gaia DR3 reflectance, no gap inside 418-814 nm "
                            "bridged) when physical.colorLabel is derived, or when physical.albedoLabel is not measured "
                            "and physical.gaiaBands = 12. Otherwise it is estimated.",
        "shapeDerived": int(shape_ok.sum()),
        "withSpectrum": int(has.sum()),
        "yOverV": {"note": "c_Y is the ratio of CIE Y to the V-band flux relative to sunlight: the error made by "
                           "drawing a measured V magnitude with the Sun's colour (the strict 'brightness only' rule).",
                   "p0.1": float(np.percentile(cy, 0.1)), "p1": float(np.percentile(cy, 1)),
                   "p50": float(np.percentile(cy, 50)), "p99": float(np.percentile(cy, 99)),
                   "p99.9": float(np.percentile(cy, 99.9)), "min": float(cy.min()), "max": float(cy.max())},
        "populationMeans": {
            "method": "Mean c over objects whose spectral shape is derived, grouped by the SsODNet best taxonomic "
                      "class (physical.taxonomyBft, 'scheme|class|technique', trailing ':' dropped), by its complex "
                      "(first letter), and by SBDB orbit class; groups with fewer than "
                      f"{MIN_CLASS_SAMPLE} objects are omitted. Lookup for an object without a derived shape: its "
                      "class, else its complex, else its orbit class, else all objects. Label estimated (a "
                      "population statistic stands in for the object's own spectrum).",
            "taxonomicClass": by_class, "taxonomicComplex": by_complex, "orbitClass": by_orbit,
            "all": summary(shape_ok)},
    }


# ---------------------------------------------------------------------------------------------- Horizons fixture
def horizons_observer(spkid: int) -> Path:
    params = {"format": "text", "COMMAND": f"'DES={spkid};'", "OBJ_DATA": "'YES'", "MAKE_EPHEM": "'YES'",
              "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@399'",
              "TLIST": "'" + "','".join(f"{jd}" for jd in TEST_EPOCHS_JD) + "'", "TLIST_TYPE": "'JD'",
              "TIME_TYPE": "'UT'", "QUANTITIES": "'9,19,20,24'", "CSV_FORMAT": "'YES'", "ANG_FORMAT": "'DEG'"}
    return fetch(HORIZONS_API, "horizons/smallbodies_photometry", f"observer_{spkid}.txt", params=params)


def parse_observer(text: str) -> dict:
    head = text.split("$$SOE", 1)[0]
    hm = re.search(r"\bH=\s*([-\d.]+)", head)
    gm = re.search(r"\bG=\s*([-\d.]+)", head)
    tgt = re.search(r"Target body name:\s*(.+?)\s{2,}", head)
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        # date, (solar presence), (lunar presence), APmag, S-brt, r, rdot, delta, deldot, S-T-O
        rows.append({"dateUt": f[0], "apmag": float(f[3]), "rAu": float(f[5]), "deltaAu": float(f[7]),
                     "phaseDeg": float(f[9])})
    return {"target": tgt.group(1) if tgt else "", "horizonsH": float(hm.group(1)) if hm else None,
            "horizonsG": float(gm.group(1)) if gm else None, "rows": rows}


def photometry_fixture(core: np.ndarray, spkid_rows: dict[int, int], label_enc: list[str]) -> dict:
    objs = []
    for spk in TEST_SPKIDS:
        path = horizons_observer(spk)
        time.sleep(1.0)  # sequential and polite
        rec = record(path)
        p = parse_observer(path.read_text())
        row = spkid_rows[spk]
        objs.append({"spkid": spk, "coreRow": row, "H": float(core["H"][row]), "G": float(core["G"][row]),
                     "gLabel": label_enc[int(core["gLabel"][row])], "horizonsUrl": rec["url"],
                     "horizonsSha256": rec["sha256"], **p})
    return {"generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
            "observer": "geocentre (500@399), apparent (light-time corrected) geometry, airless",
            "quantities": "APmag (9), r (19), Delta (20), Sun-Target-Observer phase angle (24)",
            "objects": objs}


def _spkid_rows(names_path: Path, wanted: tuple[int, ...]) -> dict[int, int]:
    out = {}
    with names_path.open(encoding="utf-8") as f:
        for i, line in enumerate(f):
            spk = int(line.split("\t", 1)[0])
            if spk in wanted:
                out[spk] = i
    missing = set(wanted) - set(out)
    if missing:
        raise KeyError(f"spkids not in the catalogue: {sorted(missing)}")
    return out


# ---------------------------------------------------------------------------------------------- stage
def run(ctx: BuildContext) -> None:
    core_h, core = read_table(OUT / DIR / "core.json")
    phys_h, phys = read_table(OUT / DIR / "physical.json")
    light = json.loads((OUT / "light.json").read_text())

    src = sbpy_iau_source()
    basis = hg1g2_nodes(src)
    for b in basis.values():
        b["coefficients"] = spline_coefficients(b["nodesRad"], b["values"], b["endDerivatives"])
    hg = hg_constants(src)
    # Spot checks against Muinonen et al. (2010) Eqs. 17-18: Phi1 = 1 - 6a/pi, Phi2 = 1 - 9a/(5 pi) below 7.5 deg.
    a = math.radians(3.0)
    if abs(eval_basis(basis["phi1"], a) - (1 - 6 * a / math.pi)) > 1e-7 or \
            abs(eval_basis(basis["phi2"], a) - (1 - 9 * a / (5 * math.pi))) > 1e-7:
        raise ValueError("H-G1-G2 basis: linear part disagrees with Muinonen et al. (2010) Eqs. 17-18")

    sun = cie.xyzs(solar.spectrum().grid)
    ref = np.array(light["sun"]["irradianceXYZS_1AU"]["value"])
    if np.max(np.abs(sun / ref - 1)) > 1e-9:
        raise ValueError(f"solar XYZS {sun} differs from light.json {ref}")
    colour = colour_tables(core_h, core, phys_h, phys, sun)

    sid = {"sbpy": SBPY.register(ctx), "willmer": WILLMER.register(ctx)}
    ctx.add_source(SourceRecord(
        id="jpl-horizons-sb-photometry",
        title="JPL Horizons observer tables (APmag, r, Delta, phase angle) for the small-body photometry test",
        citation="Giorgini, J. D. et al. (1996). JPL's On-Line Solar System Data Service. Bulletin of the American "
                 "Astronomical Society 28(3), 1158. JPL Horizons system, https://ssd.jpl.nasa.gov/horizons/.",
        url=HORIZONS_API, retrieved=_dt.date.today().isoformat(),
        notes="Test fixture only (app/tests/fixtures/smallbody_photometry.json); query URLs and sha256 per object in "
              "the fixture and in data/raw/_downloads.json under horizons/smallbodies_photometry/."))

    v_sun = sun_mag("V")
    product = {
        "vSun": {"value": v_sun, "label": "measured", "sources": [sid["willmer"]], "unit": "mag (Vega)",
                 "method": "Apparent V magnitude of the Sun at 1 AU, Willmer (2018) Table 3."},
        "sunIrradianceXYZS1AU": {"value": [float(x) for x in sun], "label": "derived",
                                 "sources": light["sun"]["irradianceXYZS_1AU"]["sources"], "unit": "lux",
                                 "method": "As light.json sun.irradianceXYZS_1AU (recomputed and checked equal)."},
        "hg": {**hg, "sources": [sid["sbpy"], "bowell-1989"],
               "note": "JPL Horizons' APmag evaluates the two-exponential approximation of this law; the two differ "
                       "by up to 0.02 mag at phase angles below ~10 deg and < 0.006 mag beyond 15 deg (see "
                       "app/tests/smallbody-photometry.test.ts)."},
        "hg1g2": {**basis, "sources": [sid["sbpy"]],
                  "form": "Phi = G1 Phi1 + G2 Phi2 + (1 - G1 - G2) Phi3; each basis function is linear beyond its end "
                          "nodes (slope endDerivatives), cubic between nodes (coefficients[i] = [A0..A3] in powers of "
                          "(a - nodesRad[i])), and clipped at 0 (sbpy); phase angle a in radians; "
                          "V = H + 5 log10(r Delta) - 2.5 log10 Phi."},
        "colour": colour,
        "comets": {"method": "Total visual magnitude m1 = M1 + 5 log10(Delta) + K1 log10(r) (comets.M1, K1); where M1 "
                             "is unknown, the nuclear law m2 = M2 + 5 log10(Delta) + K2 log10(r) + PC * phase[deg]. "
                             "The magnitude is taken as V and drawn with the Sun's colour (c = 1): a comet's coma is "
                             "dust-scattered sunlight plus gas emission, whose colour is not catalogued. Label "
                             "estimated (the laws are fits that comets depart from by 1-2 mag; colour assumed); a coma "
                             "is extended but is drawn as a point.",
                   "label": "estimated"},
        "rules": {
            "brightness": "V from H and a phase function. Phase function: the SsODNet H-G1-G2 fit in the V band "
                          "(physical.phaseFilter = 'V': MPC-archive V photometry) with its own fitted H (phaseH) - "
                          "measured inside its fitted phase-angle range, estimated outside it (extrapolated); else "
                          "H-G with the SBDB H and G - measured where the SBDB fitted G, estimated with the "
                          "conventional G = 0.15. (Fits in other bands are not used: their H is not in V.)",
            "strict": "Drawn only if the position label and the brightness label (worst of H and phase function at "
                      "the current phase angle) are measured or derived. Colour: the object's own Gaia colour where "
                      "its spectral shape is derived; otherwise 'brightness only': the measured V is drawn with the "
                      "Sun's colour (c = 1), i.e. neutral - Y is then off by the object's c_Y (colour.yOverV bounds "
                      "it), X, Z, S by its unknown colour. Comets are not drawn (estimated brightness).",
            "best": "Also estimated inputs: G = 0.15, H-G1-G2 outside its fitted range, estimated positions, the "
                    "estimated colour (Gaia spectrum with a bridged gap, else the population mean of colour."
                    "populationMeans), and comet magnitude laws.",
            "complete": "As best (no synthetic small bodies yet).",
            "lightTime": "Position back-dated by the light time tau = Delta / c to first order: x(t - tau) = x(t) - "
                         "v(t) tau (SSB velocity), with Delta from the geometric position.",
        },
    }
    write_json(ctx, f"{DIR}/photometry.json", product, STAGE)

    names = OUT / DIR / "names.txt"
    rows = _spkid_rows(names, TEST_SPKIDS)
    fx = photometry_fixture(core, rows, core_h["labelEncoding"])
    fx["vSun"] = v_sun
    # Reference values of the phase functions as sbpy defines them (for an exact check of the app's implementation).
    fx["hgChecks"] = [{"alphaDeg": a, "G": g, "phi": hg_phi(hg, math.radians(a), g)}
                      for a in (0.0, 0.5, 3.0, 7.5, 15.0, 30.0, 60.0, 100.0, 150.0) for g in (-0.1, 0.15, 0.46)]
    fx["hg1g2Checks"] = [{"alphaDeg": a, "G1": g1, "G2": g2, "phi": g1 * eval_basis(basis["phi1"], math.radians(a))
                          + g2 * eval_basis(basis["phi2"], math.radians(a))
                          + (1 - g1 - g2) * eval_basis(basis["phi3"], math.radians(a))}
                         for a in (0.0, 0.2, 1.0, 5.0, 7.5, 10.0, 25.0, 45.0, 90.0, 140.0, 160.0)
                         for g1, g2 in ((0.62, 0.14), (0.25, 0.4), (0.9, 0.05))]
    FIXTURE.write_text(json.dumps(fx, indent=1))
    print(f"[{STAGE}] photometry.json: {colour['shapeDerived']} derived colour shapes, "
          f"{len(colour['populationMeans']['taxonomicClass'])} taxonomic classes; c_Y p1..p99 = "
          f"{colour['yOverV']['p1']:.4f}..{colour['yOverV']['p99']:.4f}; fixture {FIXTURE.name}")
