"""`smallbodies` stage -> app/public/data/smallbodies/ (every catalogued asteroid and comet).

Products (layouts in the headers; see docs/reports/small-bodies.md and schema.ts SmallBodyTableHeader):
  core.json / core.bin          one record per object: heliocentric ICRF state at the common epoch (float64),
                                H, G, diameter-from-H, class, orbit-quality codes, flags, per-attribute labels and
                                source indices. The header carries the force model the app's propagator must use.
  physical.json / physical.bin  one record per object with any measured physical attribute (row -> core row).
  comets.json / comets.bin      comet magnitude laws (M1/K1 total, M2/K2/PC nuclear), row -> core row.
  nongrav.json / nongrav.bin    non-gravitational model parameters, row -> core row (the propagator needs them).
  names.json / names.txt        one line per core row: spkid, primary designation, name, prefix, principal
                                provisional designation (tab-separated), for search.

Orbits: JPL SBDB, full precision (sb_sbdb). Every object's osculating elements are turned into a state at its own
epoch and integrated to the common epoch (the manifest window centre, rounded to 0h TDB) with the same Kepler-drift +
kick scheme the app uses (sb_dynamics / app/src/core/smallbody.ts). Exceptions, each flagged and labelled:
  - epoch before the planetary ephemeris (1849-12-26): two-body drift to its start first -> position `estimated`;
  - orbit model terms the propagator does not have (e.g. Bennu's thermal Yarkovsky model): the state at the
    common epoch is JPL Horizons' own (fetched) -> `derived`, source jpl-horizons-sb-states;
  - passage inside a planet or the Sun, or no convergence: position `unknown`.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import time
from collections import Counter

import numpy as np

from .. import ephem_horizons as hz
from .. import sb_catalog, sb_dynamics as dyn, sb_model, sb_physical, sb_physical_sources as ps, sb_sbdb, sb_verify
from ..download import record
from ..output import write_json
from ..paths import CACHE, OUT
from ..photometry import filters, solar
from ..schema import BuildContext, SourceRecord
from ..sb_table import LABEL_CODE, Field, write_table

DEPENDS: tuple[str, ...] = ("ephemeris",)
STAGE = "smallbodies"
DIR = "smallbodies"
DAY = 86400.0
J2000_JD = 2451545.0
NO_SRC = 255
NO_CODE = 255

M, D, E, U = LABEL_CODE["measured"], LABEL_CODE["derived"], LABEL_CODE["estimated"], LABEL_CODE["unknown"]

# Flag bits of core.flags (u16).
FLAGS = {
    "comet": 0, "numbered": 1, "neo": 2, "pha": 3, "nonGravitational": 4, "unsupportedModelTerms": 5,
    "preEphemerisTwoBody": 6, "positionLost": 7, "orbitFromMpc": 8, "twoBodyOrbitDetermination": 9,
    "oldPlanetaryEphemeris": 10, "horizonsState": 11, "mpcDisagrees": 12, "closeApproachInWindow": 13,
    "planetaryEphemeris": 14,
}

# SBDB objects that are themselves perturbers of the force model: integrating them against their own attracting mass is
# meaningless. spkid -> (Horizons major-body command for the state at the common epoch, perturber NAIF id). The app
# should take their position from the planetary ephemeris (flag planetaryEphemeris).
SELF_PERTURBERS = {20134340: ("999", 9)}   # 134340 Pluto: NAIF 999 (the Pluto system barycenter 9 is a perturber)

CAD_URL = "https://ssd-api.jpl.nasa.gov/cad.api"
CLOSE_APPROACH_AU = 0.05

CLASS_NAMES = {
    "IEO": "Atira (interior-Earth) NEO", "ATE": "Aten NEO", "APO": "Apollo NEO", "AMO": "Amor NEO",
    "MCA": "Mars-crosser", "IMB": "inner main belt", "MBA": "main belt", "OMB": "outer main belt",
    "TJN": "Jupiter Trojan", "CEN": "Centaur", "TNO": "trans-Neptunian object", "PAA": "parabolic asteroid",
    "HYA": "hyperbolic asteroid", "AST": "asteroid (other)", "JFc": "Jupiter-family comet (2 < Tj < 3)",
    "JFC": "Jupiter-family comet (P < 20 y)", "HTC": "Halley-type comet", "ETc": "Encke-type comet",
    "CTc": "Chiron-type comet", "COM": "comet (other)", "PAR": "parabolic comet", "HYP": "hyperbolic comet",
}

# Verification tolerances vs JPL Horizons (km): the build fails beyond them.
TOL_DEFAULT_KM = 10.0
TOL_LOW_Q_KM = 30.0         # q < 0.3 au (research note §4)
TOL_COMET_NG_KM = 60.0      # comets with fitted non-gravitational terms (multi-year propagation from old epochs)
TOL_ENCOUNTER_KM = 1000.0   # objects with a planetary flyby inside the window (see report)


def common_epoch(ctx: BuildContext) -> float:
    """Window centre rounded to the nearest 0h TDB (a JD ending in .5): the product's epoch and grid origin."""
    jd = J2000_JD + 0.5 * (ctx.start_et + ctx.end_et) / DAY
    return (round(jd - 0.5) + 0.5 - J2000_JD) * DAY


def run(ctx: BuildContext) -> None:
    t_stage = time.time()
    timing: dict[str, float] = {}

    def lap(name: str, t: float) -> float:
        timing[name] = round(time.time() - t, 1)
        print(f"[{STAGE}] {name}: {timing[name]} s")
        return time.time()

    t = time.time()
    common = common_epoch(ctx)
    snap = sb_sbdb.fetch_snapshot()
    src_ids = sb_sbdb.register(ctx, snap)
    phys_dl = {"neowise": ps.neowise_downloads(), "gaia": ps.gaia_downloads()}
    neowise_paths = [d.fetch() for d in phys_dl["neowise"]]
    gaia_paths = [d.fetch() for d in phys_dl["gaia"]]
    lcdb_path = ps.LCDB.fetch()
    mpc_path = ps.MPCORB.fetch()
    t = lap("downloads (cached)", t)

    cat = sb_catalog.load_orbits(snap.orbit_pages)
    sb_catalog.attach_nongrav(cat, snap.nongrav)
    limit = int(os.environ.get("SB_LIMIT", "0") or 0)
    if limit:
        # Development builds: every limit-th object plus the verification set (products marked as partial).
        keep = set(range(0, cat.n, max(1, cat.n // limit)))
        keep |= {sb_verify.find_row(cat, p) for _, p, _ in sb_verify.OBJECTS}
        cat = cat.subset(np.array(sorted(keep)))
        print(f"[{STAGE}] SB_LIMIT={limit}: partial build with {cat.n} objects")
    n = cat.n
    t = lap(f"parse {n} SBDB orbits", t)

    # ------------------------------------------------------------------ sources
    sources = _sources(ctx, snap, src_ids, phys_dl, lcdb_path, mpc_path)
    sidx = {s: i for i, s in enumerate(sources)}

    # ------------------------------------------------------------------ states at the common epoch
    ep_et = sb_catalog.epoch_et(cat)
    model = sb_model.build(ctx, float(np.nanmin(ep_et)) - 10 * DAY, ctx.end_et + 10 * DAY, common)
    states, st_el = sb_catalog.states_at_epoch(cat, model.mu_sun, model.obliquity)
    state_epoch = states.copy()
    t = lap("elements -> states", t)

    t0 = ep_et.copy()
    grid_start = common - math.floor((common - model.span[0]) / model.base_step) * model.base_step + model.base_step
    pre = ep_et < grid_start
    key = _cache_key(snap, cat, model, common)
    cached = CACHE / f"smallbodies_states_{key}.npz"
    if cached.exists():
        z = np.load(cached)
        states, status, stats = z["states"], z["status"], z["stats"]
        print(f"[{STAGE}] reusing propagated states from {cached.name} (same inputs and integrator source)")
    else:
        if pre.any():
            sub = states[pre].copy()
            dyn.drift_many(sub, ep_et[pre], np.full(pre.sum(), grid_start), model.mu_sun)
            states[pre] = sub
            t0[pre] = grid_start
        # Shuffle so the parallel loop's static chunks share the long (old-epoch) integrations evenly.
        perm = np.random.default_rng(0).permutation(n)
        s_perm = states[perm].copy()
        status_p, stats_p = sb_model.propagate(model, s_perm, t0[perm], common, common, cat.ng[perm], cat.has_ng[perm])
        states[perm] = s_perm
        status = np.empty(n, dtype=np.int8)
        status[perm] = status_p
        stats = np.empty_like(stats_p)
        stats[perm] = stats_p
        status[st_el != 0] = dyn.NO_CONVERGENCE
        for old in CACHE.glob("smallbodies_states_*.npz"):
            old.unlink()
        np.savez(cached, states=states, status=status, stats=stats)
    t = lap("propagate to the common epoch", t)

    # Objects whose orbit model has terms we do not integrate: JPL Horizons' state at the common epoch.
    unsupported = np.zeros(n, dtype=bool)
    for i in cat.ng_unsupported:
        unsupported[i] = True
    self_pert = np.isin(cat.spkid, list(SELF_PERTURBERS))
    hz_rows, hz_notes = _horizons_states(cat, np.nonzero(unsupported | self_pert)[0], common, states, status)
    t = lap(f"Horizons states for {len(hz_rows)} objects", t)
    cad_rows, cad_n = _close_approaches(ctx, cat)

    # ------------------------------------------------------------------ MPC U and cross-check
    mpc = ps.read_mpcorb(mpc_path)
    didx = sb_physical.designation_index(cat)
    mpc_u = np.full(n, NO_CODE, dtype=np.uint8)
    mpc_row = np.full(n, -1, dtype=np.int64)
    for k, (d, u) in enumerate(zip(mpc.desig, mpc.U)):
        i = didx.get(d)
        if i is None:
            continue
        mpc_row[i] = k
        if u.isdigit():
            mpc_u[i] = int(u)
    xcheck = _mpc_crosscheck(cat, mpc, mpc_row, state_epoch, model)
    t = lap("MPCORB U + cross-check", t)

    # ------------------------------------------------------------------ physical
    ph = sb_physical.build(cat, sb_physical.load_sbdb_phys(snap.phys_pages), ps.read_neowise(neowise_paths),
                           ps.read_lcdb(lcdb_path)[0], ps.read_gaia(gaia_paths),
                           {"sbdb": sidx["jpl-sbdb-physical"], "neowise": sidx["neowise-v2"], "lcdb": sidx["lcdb-2023-10"],
                            "gaia": sidx["gaia-dr3-sso-reflectance"], "stat": sidx["smallbodies-class-albedo"]})
    t = lap("physical attributes", t)

    # ------------------------------------------------------------------ core columns
    is_comet = np.array([str(k).startswith("c") for k in cat.s["kind"]])
    numbered = np.array([str(k).endswith("n") for k in cat.s["kind"]])
    classes = sorted(set(cat.s["class"]) - {None})
    cls_idx = np.array([classes.index(c) if c in classes else NO_CODE for c in cat.s["class"]], dtype=np.uint8)
    cond = np.array([int(c) if c is not None and str(c).isdigit() else NO_CODE for c in cat.s["condition_code"]],
                    dtype=np.uint8)
    flags = np.zeros(n, dtype=np.uint16)

    def setf(name: str, mask: np.ndarray) -> None:
        flags[mask] |= np.uint16(1 << FLAGS[name])

    lost = status != dyn.OK
    lost[hz_rows] = False
    setf("comet", is_comet)
    setf("numbered", numbered)
    setf("neo", cat.neo)
    setf("pha", cat.pha)
    setf("nonGravitational", cat.has_ng)
    setf("unsupportedModelTerms", unsupported)
    setf("preEphemerisTwoBody", pre)
    setf("positionLost", lost)
    setf("orbitFromMpc", np.array([str(s).startswith("MPC") for s in cat.s["source"]]))
    setf("twoBodyOrbitDetermination", cat.s["two_body"] == "T")
    setf("oldPlanetaryEphemeris", ~np.isin(cat.s["pe_used"], [sb_sbdb.CURRENT_PE, None]))
    setf("horizonsState", np.isin(np.arange(n), hz_rows))
    setf("mpcDisagrees", xcheck["disagree"])
    setf("closeApproachInWindow", np.isin(np.arange(n), cad_rows))
    setf("planetaryEphemeris", self_pert)

    pos_label = np.full(n, D, dtype=np.uint8)
    pos_label[pre] = E
    pos_label[lost] = U
    pos_src = np.full(n, sidx["jpl-sbdb-orbits"], dtype=np.uint8)
    pos_src[hz_rows] = sidx["jpl-horizons-sb-states"]
    states[lost] = np.nan

    H = cat.f["H"].copy()
    h_label = np.where(np.isfinite(H), M, U).astype(np.uint8)
    h_src = np.where(np.isfinite(H), sidx["jpl-sbdb-orbits"], NO_SRC).astype(np.uint8)
    G = cat.f["G"].copy()
    g_meas = np.isfinite(G)
    g_default = ~g_meas & np.isfinite(H) & ~is_comet
    G[g_default] = 0.15
    g_label = np.where(g_meas, M, np.where(g_default, E, U)).astype(np.uint8)
    g_src = np.where(g_meas, sidx["jpl-sbdb-orbits"], np.where(g_default, sidx["bowell-1989"], NO_SRC)).astype(np.uint8)

    c = ph.cols
    d_est = c["diameterEst"]
    d_est_label = c["diameterEstLabel"].copy()
    # A diameter from H and a *measured* albedo has no assumed input: derived.
    d_from_meas = np.isfinite(d_est) & (c["albedoLabel"] == M)
    d_est_label[d_from_meas] = D
    d_est_src = np.where(np.isfinite(d_est), np.where(d_from_meas, c["albedoSrc"], sidx["smallbodies-class-albedo"]),
                         NO_SRC).astype(np.uint8)

    has_phys = ((c["diameterLabel"] != U) | (c["albedoLabel"] != U) | (c["rotLabel"] != U) | (c["colorLabel"] != U)
                | (c["colorIndexLabel"] != U) | (c["taxonomyLabel"] != U))
    phys_rows = np.nonzero(has_phys)[0]
    phys_row = np.full(n, 0xFFFFFFFF, dtype=np.uint32)
    phys_row[phys_rows] = np.arange(phys_rows.size, dtype=np.uint32)

    core_fields = [
        Field("pos", "f64", 3, {"unit": "km", "label": "posLabel", "source": "orbitSrc",
                                "method": "Heliocentric ICRF position at epochEt: SBDB osculating elements -> state at the "
                                          "SBDB epoch (universal variables, ecliptic J2000 rotated by the IAU 1976 "
                                          "obliquity) -> integrated to epochEt with forceModel. NaN when posLabel is "
                                          "unknown."}),
        Field("vel", "f64", 3, {"unit": "km/s", "label": "posLabel", "source": "orbitSrc"}),
        Field("H", "f32", 1, {"unit": "mag", "label": "hLabel", "source": "hSrc",
                              "method": "Absolute magnitude from the SBDB (JPL/MPC H-G system); comets: no H (see "
                                        "comets table). Catalogue H carries H-dependent systematic offsets of a few "
                                        "tenths of a magnitude (Pravec et al. 2012, Icarus 221, 365)."}),
        Field("G", "f32", 1, {"label": "gLabel", "source": "gSrc",
                              "method": "Slope parameter of the H-G magnitude law: fitted value from the SBDB where "
                                        "given (measured); otherwise the conventional G = 0.15 (Bowell et al. 1989), "
                                        "labelled estimated."}),
        Field("diameterFromH", "f32", 1, {"unit": "km", "label": "diameterFromHLabel", "source": "diameterFromHSrc",
                                          "method": "Only where no diameter is measured: D = 1329 km / sqrt(p_V) * "
                                                    "10^(-H/5) (Pravec & Harris 2007, Eq. 3) with the object's measured "
                                                    "p_V (derived) or, lacking one, the median measured p_V of its SBDB "
                                                    "orbit class (estimated; table classAlbedo)."}),
        Field("physRow", "u32", 1, {"method": "Record in physical.bin, 0xFFFFFFFF if the object has no measured "
                                              "physical attribute."}),
        Field("flags", "u16", 1, {"method": "Bit field, see header flagBits."}),
        Field("orbitClass", "u8", 1, {"method": "Index into header orbitClasses (SBDB class code), 255 unknown."}),
        Field("conditionCode", "u8", 1, {"method": "JPL orbit condition code (MPC U scale 0 good .. 9 poor) from the "
                                                   "SBDB; 255 not given."}),
        Field("mpcU", "u8", 1, {"method": "MPC uncertainty parameter U from MPCORB.DAT (0..9); 255 when MPCORB has no "
                                          "numeric U for the object (or no entry). U = in-orbit longitude runoff per "
                                          "decade: U=0 < 1 arcsec, each step x e^1.49 (MPC UValue.html)."}),
        Field("posLabel", "u8"), Field("hLabel", "u8"), Field("gLabel", "u8"), Field("diameterFromHLabel", "u8"),
        Field("orbitSrc", "u8"), Field("hSrc", "u8"), Field("gSrc", "u8"), Field("diameterFromHSrc", "u8"),
    ]
    core_cols = {
        "pos": states[:, :3], "vel": states[:, 3:], "H": H.astype(np.float32), "G": G.astype(np.float32),
        "diameterFromH": d_est.astype(np.float32), "physRow": phys_row, "flags": flags, "orbitClass": cls_idx,
        "conditionCode": cond, "mpcU": mpc_u, "posLabel": pos_label, "hLabel": h_label, "gLabel": g_label,
        "diameterFromHLabel": d_est_label, "orbitSrc": pos_src, "hSrc": h_src, "gSrc": g_src,
        "diameterFromHSrc": d_est_src,
    }

    # ------------------------------------------------------------------ statistics for the header / report
    lab_names = ["measured", "derived", "estimated", "synthetic", "unknown"]

    def lab_counts(arr: np.ndarray) -> dict:
        cnt = Counter(arr.tolist())
        return {lab_names[k]: int(v) for k, v in sorted(cnt.items())}

    kinds = Counter(cat.s["kind"])
    stats = {
        "objects": n,
        "kinds": {"numberedAsteroids": kinds["an"], "unnumberedAsteroids": kinds["au"], "numberedComets": kinds["cn"],
                  "unnumberedComets": kinds["cu"]},
        "orbitClasses": dict(Counter(cat.s["class"]).most_common()),
        "neo": int(cat.neo.sum()), "pha": int(cat.pha.sum()),
        "labels": {"position": lab_counts(pos_label), "H": lab_counts(h_label), "G": lab_counts(g_label),
                   "diameter": lab_counts(c["diameterLabel"]), "albedo": lab_counts(c["albedoLabel"]),
                   "rotationPeriod": lab_counts(c["rotLabel"]), "geometricAlbedoXYZS": lab_counts(c["colorLabel"]),
                   "colorIndices": lab_counts(c["colorIndexLabel"]), "taxonomy": lab_counts(c["taxonomyLabel"]),
                   "diameterFromH": lab_counts(d_est_label)},
        "propagation": {"status": {k: int(v) for k, v in Counter(status.tolist()).items()},
                        "preEphemerisTwoBody": int(pre.sum()), "horizonsStates": len(hz_rows),
                        "substeps": int(stats[:, 0].sum()), "encounterSubsteps": int(stats[:, 2].sum()),
                        "maxLevel": int(stats[:, 1].max()), "epochIsStandard": int((cat.f["epoch"] == 2461200.5).sum()),
                        "closeApproachesInWindow": {"approaches": cad_n, "objects": len(cad_rows),
                                                    "maxDistanceAu": CLOSE_APPROACH_AU},
                        "lost": [str(cat.s["full_name"][i]).strip() for i in np.nonzero(lost)[0]],
                        "horizonsNotes": hz_notes},
        "mpcCrossCheck": {k: v for k, v in xcheck.items() if k != "disagree"},
        "physical": ph.stats, "physicalRecords": int(phys_rows.size),
        "sbdbPageDuplicates": cat.duplicates,
    }

    epoch_cal = hz.et_to_tdb_calendar(common)
    extra = {
        "epochEt": common, "epochTdb": epoch_cal, "window": {"startEt": ctx.start_et, "endEt": ctx.end_et},
        "forceModel": model.to_json(), "orbitClasses": [{"code": k, "name": CLASS_NAMES.get(k, k)} for k in classes],
        "flagBits": FLAGS, "classAlbedo": ph.class_albedo, "statistics": stats,
        "snapshot": snap.tag, "names": f"{DIR}/names.json", "physical": f"{DIR}/physical.json",
        "comets": f"{DIR}/comets.json", "nongrav": f"{DIR}/nongrav.json",
    }
    write_table(ctx, f"{DIR}/core", core_fields, core_cols, n, STAGE, source_table=sources, extra=extra, notes=(
        "Every asteroid and comet in the JPL SBDB snapshot, one record per object (row order = names.txt line order "
        "= SBDB spkid order). pos/vel are heliocentric (add the Sun's SSB position from the ephemeris). Propagate "
        "with app/src/core/smallbody.ts using forceModel; grid origin epochEt."))

    # ------------------------------------------------------------------ physical table
    pr = phys_rows
    phys_fields = [
        Field("row", "u32", 1, {"method": "core row"}),
        Field("diameter", "f32", 1, {"unit": "km", "label": "diameterLabel", "source": "diameterSrc", "method":
              "Measured effective diameter: SBDB compilation (thermal models, occultations, radar, spacecraft) or, "
              "where SBDB has none, NEOWISE V2.0 fits whose fit code has D (inverse-variance mean of the fits)."}),
        Field("diameterSigma", "f32", 1, {"unit": "km", "method": "1-sigma; NEOWISE: max(formal error of the mean, "
                                                                  "scatter of fits). NaN if not given."}),
        Field("albedo", "f32", 1, {"label": "albedoLabel", "source": "albedoSrc", "method":
              "Visible geometric albedo p_V: SBDB, else NEOWISE fits with V fitted (depends on the H used there)."}),
        Field("albedoSigma", "f32", 1, {"method": "1-sigma where given."}),
        Field("rotPeriod", "f32", 1, {"unit": "h", "label": "rotLabel", "source": "rotSrc", "method":
              "Synodic rotation period: LCDB summary (reliability U >= 2- measured; 1-..1+ or unrated estimated; "
              "U = 0 and period limits not used), else SBDB rot_per (measured, reliability not given)."}),
        Field("geometricAlbedoXYZS", "f32", 4, {"unit": "lux at 1 AU", "label": "colorLabel", "source": "colorSrc",
              "method": "docs/architecture.md 4.3: p(lambda) = p_V R(lambda)/R_V with R the Gaia DR3 reflectance "
                        "spectrum (bands 374-858 nm with flag 0, linear between band centres, flat beyond the outermost "
                        "band used), R_V its Bessell-V solar-weighted mean, times TSIS-1 HSRS sunlight, integrated "
                        "against the CIE 1931 2deg and 1951 scotopic observers. derived with a measured p_V and bands "
                        "418-814 nm unflagged (a flagged 374 or 858 nm edge band is bridged; that changes XYZS by at "
                        "most statistics.physical.gaia.edgeBandEffectMax); estimated with the class p_V or a gap "
                        "inside 418-814 nm.",
              "uncertainty": "Gaia reflectances carry per-band errors of ~1 %; p_V errors (often 10-30 %) scale all "
                             "four channels."}),
        Field("BV", "f32"), Field("UB", "f32"), Field("IR", "f32"),
        Field("diameterLabel", "u8"), Field("diameterSrc", "u8"), Field("albedoLabel", "u8"), Field("albedoSrc", "u8"),
        Field("rotLabel", "u8"), Field("rotSrc", "u8"),
        Field("rotQuality", "u8", 1, {"method": "LCDB U code index into header lcdbU ('' = not from LCDB)"}),
        Field("colorLabel", "u8"), Field("colorSrc", "u8"),
        Field("gaiaBands", "u8", 1, {"method": "Gaia bands (of 374..858 nm) used"}),
        Field("colorIndexLabel", "u8", 1, {"method": "label of BV, UB, IR (SBDB, measured)"}), Field("colorIndexSrc", "u8"),
        Field("taxonomyB", "u8", 1, {"method": "SMASSII/Bus class index into header taxonomyB (0 = none)"}),
        Field("taxonomyT", "u8", 1, {"method": "Tholen class index into header taxonomyT (0 = none)"}),
        Field("taxonomyLabel", "u8"), Field("taxonomySrc", "u8"),
    ]
    pc = {"row": pr.astype(np.uint32)}
    for f in phys_fields[1:]:
        if f.name == "geometricAlbedoXYZS":
            pc[f.name] = c[f.name][pr].astype(np.float32)
        elif f.type == "f32":
            key = {"diameter": "diameter", "diameterSigma": "diameterSigma", "albedo": "albedo",
                   "albedoSigma": "albedoSigma", "rotPeriod": "rotPeriod"}.get(f.name, f.name)
            pc[f.name] = c[key][pr].astype(np.float32)
        else:
            key = {"gaiaBands": "gaiaBandsUsed"}.get(f.name, f.name)
            v = c[key][pr].copy()
            if f.name.endswith("Src"):
                lab = c[f.name[:-3] + "Label"][pr]
                v = np.where(lab == U, NO_SRC, v)
            pc[f.name] = v.astype(np.uint8)
    write_table(ctx, f"{DIR}/physical", phys_fields, pc, int(pr.size), STAGE, source_table=sources, extra={
        "lcdbU": sb_physical.LCDB_U_CODES, "taxonomyB": ph.taxonomy_B, "taxonomyT": ph.taxonomy_T}, notes=(
        "Objects with at least one measured physical attribute (row -> core record). Unknown values are NaN / label "
        "unknown; source indices 255 = none."))

    # ------------------------------------------------------------------ comets table
    crow = np.nonzero(is_comet)[0]
    m1, k1, m2, k2, pcoef = (cat.f[k][crow].astype(np.float32) for k in ("M1", "K1", "M2", "K2", "PC"))
    tot = np.isfinite(m1) & np.isfinite(k1)
    nuc = np.isfinite(m2) & np.isfinite(k2)
    write_table(ctx, f"{DIR}/comets", [
        Field("row", "u32"),
        Field("M1", "f32", 1, {"unit": "mag", "label": "totalLabel", "source": "src", "method":
              "Total-magnitude law m1 = M1 + 5 log10(Delta) + K1 log10(r) (SBDB fitted parameters). A brightness "
              "predicted with it is estimated: comets depart from the law by 1-2 mag."}),
        Field("K1", "f32"),
        Field("M2", "f32", 1, {"unit": "mag", "label": "nuclearLabel", "source": "src", "method":
              "Nuclear-magnitude law m2 = M2 + 5 log10(Delta) + K2 log10(r) + PC * phase (SBDB)."}),
        Field("K2", "f32"), Field("PC", "f32", 1, {"unit": "mag/deg"}),
        Field("totalLabel", "u8"), Field("nuclearLabel", "u8"), Field("src", "u8"),
    ], {"row": crow.astype(np.uint32), "M1": m1, "K1": k1, "M2": m2, "K2": k2, "PC": pcoef,
        "totalLabel": np.where(tot, M, U).astype(np.uint8), "nuclearLabel": np.where(nuc, M, U).astype(np.uint8),
        "src": np.full(crow.size, sidx["jpl-sbdb-orbits"], dtype=np.uint8)},
        int(crow.size), STAGE, source_table=sources, notes="Every comet (row -> core record).")

    # ------------------------------------------------------------------ non-gravitational table
    ngr = np.nonzero(cat.has_ng)[0]
    ng = cat.ng[ngr]
    ng_fields = [Field("row", "u32")] + [Field(k, "f64", 1, {"unit": u}) for k, u in (
        ("A1", "km/s^2"), ("A2", "km/s^2"), ("A3", "km/s^2"), ("DT", "s"), ("ALN", ""), ("R0", "km"), ("NM", ""),
        ("NN", ""), ("NK", ""))] + [Field("label", "u8"), Field("src", "u8")]
    ng_cols = {"row": ngr.astype(np.uint32), "label": np.full(ngr.size, M, dtype=np.uint8),
               "src": np.full(ngr.size, sidx["jpl-sbdb-nongrav"], dtype=np.uint8)}
    for j, k in enumerate(("A1", "A2", "A3", "DT", "ALN", "R0", "NM", "NN", "NK")):
        ng_cols[k] = ng[:, j]
    write_table(ctx, f"{DIR}/nongrav", ng_fields, ng_cols, int(ngr.size), STAGE, source_table=sources, notes=(
        "Fitted non-gravitational parameters (SBDB model_pars, converted to km and s) of every object whose orbit "
        "has them; forceModel.nonGravitational gives the acceleration. Objects flagged unsupportedModelTerms have "
        "extra terms (e.g. AMRAT, RHO, S0, jet models) and their core state comes from Horizons."))

    # ------------------------------------------------------------------ names sidecar
    lines = []
    for i in range(n):
        fn = str(cat.s["full_name"][i] or "").strip()
        alt = fn[fn.index("(") + 1: fn.rindex(")")] if ("(" in fn and fn.endswith(")") and not is_comet[i]) else ""
        parts = [str(int(cat.spkid[i])), str(cat.s["pdes"][i] or ""), str(cat.s["name"][i] or ""),
                 str(cat.s["prefix"][i] or ""), alt]
        lines.append("\t".join(p.replace("\t", " ").replace("\n", " ") for p in parts))
    path = OUT / DIR / "names.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    from ..output import _register
    _register(ctx, f"{DIR}/names.txt", path, STAGE)
    write_json(ctx, f"{DIR}/names.json", {
        "file": f"{DIR}/names.txt", "count": n, "encoding": "utf-8", "separator": "\t", "lineSeparator": "\n",
        "columns": ["spkid", "designation", "name", "prefix", "principalProvisionalDesignation"],
        "sources": ["jpl-sbdb-orbits"],
        "notes": "Line i describes core record i. designation = SBDB primary designation (the number for numbered "
                 "asteroids; comets without their prefix); name = IAU name if any; prefix = comet prefix (P, C, D, "
                 "I, A); principalProvisionalDesignation from the SBDB full name of numbered asteroids."}, STAGE)
    t = lap("write products", t)

    # ------------------------------------------------------------------ verification against Horizons
    res = sb_verify.run(cat, model, common, ctx.start_et, ctx.end_et, states_common=states)
    ver = sb_verify.summary(res)
    fails = []
    for r, v in zip(res, ver):
        tol = _tolerance(cat, r)
        v["toleranceKm"] = tol
        v["flags"] = int(flags[r.row])
        if not r.same_solution:
            fails.append(f"{r.label}: SBDB orbit {r.orbit_id} != Horizons {r.horizons_soln}")
        elif not (r.max_err_km <= tol):
            fails.append(f"{r.label}: {r.max_err_km:.2f} km > {tol} km")
        print(f"[{STAGE}] verify {r.label:30s} max |dr| = {r.max_err_km:9.3f} km over {r.epochs.size} epochs "
              f"(tol {tol:g}) level<={r.max_substep_level} {r.horizons_soln}")
    t = lap("verification vs Horizons", t)
    timing["total"] = round(time.time() - t_stage, 1)
    report = {"generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"), "epochEt": common,
              "timing": timing, "statistics": stats, "verification": ver,
              "products": {k: v for k, v in ctx.products.items() if v["stage"] == STAGE}}
    (CACHE / "smallbodies_report.json").write_text(json.dumps(report, indent=1, default=float))
    print(f"[{STAGE}] {n} objects; positions: {stats['labels']['position']}; total {timing['total']} s")
    if fails:
        raise ValueError("small-body verification failed: " + "; ".join(fails))


def _cache_key(snap, cat, model, common: float) -> str:
    """Propagated states are cached in data/cache under a key covering every input that shapes them: the snapshot
    pages, the objects kept, the common epoch, the force model, and the integrator's source code."""
    import hashlib
    from pathlib import Path
    h = hashlib.sha256()
    h.update(sb_sbdb.combined_sha256(snap.orbit_pages).encode())
    h.update(sb_sbdb.combined_sha256([snap.nongrav[k] for k in sorted(snap.nongrav)]).encode())
    h.update(cat.spkid.tobytes())
    h.update(repr(common).encode())
    h.update(json.dumps(model.to_json(), sort_keys=True).encode())
    h.update(model.data[:1000].tobytes())
    for mod in (dyn, sb_model, sb_catalog):
        h.update(Path(mod.__file__).read_bytes())
    return h.hexdigest()[:16]


def _tolerance(cat: sb_catalog.Catalog, r: sb_verify.Result) -> float:
    if "flyby" in r.category:
        return TOL_ENCOUNTER_KM
    if str(cat.s["kind"][r.row]).startswith("c") and cat.has_ng[r.row]:
        return TOL_COMET_NG_KM
    if r.q_au < 0.3:
        return TOL_LOW_Q_KM
    return TOL_DEFAULT_KM


def _horizons_states(cat: sb_catalog.Catalog, rows: np.ndarray, common: float, states: np.ndarray,
                     status: np.ndarray) -> tuple[list[int], list[str]]:
    """Replace the state at the common epoch by Horizons' for objects whose orbit model we do not reproduce."""
    done, notes = [], []
    jd = J2000_JD + common / DAY
    for i in rows:
        cmd = SELF_PERTURBERS[int(cat.spkid[i])][0] if int(cat.spkid[i]) in SELF_PERTURBERS else \
            sb_verify.horizons_command(cat, int(i))
        params = hz.vector_params(cmd, "500@10", tlist=[f"{jd:.1f}"])
        params["OBJ_DATA"] = "'YES'"
        name = f"state_{int(cat.spkid[i])}_JD{jd:.1f}.txt"
        try:
            path, table = hz.fetch_vectors(params, "horizons/smallbodies", name)
        except ValueError as e:
            notes.append(f"{cat.s['full_name'][i].strip()}: Horizons gave no state ({str(e).splitlines()[0][:80]})")
            continue
        states[i] = table.states[0]
        status[i] = dyn.OK
        done.append(int(i))
        why = cat.ng_unsupported.get(int(i)) or ("the object is a perturber of the force model (planetary "
                                                  "ephemeris body)" if int(cat.spkid[i]) in SELF_PERTURBERS else "")
        notes.append(f"{cat.s['full_name'][i].strip()}: state from Horizons ({table.target_line}); {why}")
    return done, notes


def _close_approaches(ctx: BuildContext, cat: sb_catalog.Catalog) -> tuple[list[int], int]:
    """Rows of objects that JPL CNEOS lists with a planetary approach closer than CLOSE_APPROACH_AU inside the window
    (cad.api, all bodies). The GPU propagator needs encounter substeps for them."""
    from ..download import fetch
    lo, hi = hz.et_to_tdb_calendar(ctx.start_et)[:10], hz.et_to_tdb_calendar(ctx.end_et)[:10]
    params = {"date-min": lo, "date-max": hi, "dist-max": str(CLOSE_APPROACH_AU), "body": "ALL"}
    path = fetch(CAD_URL, "cneos", f"cad_{lo}_{hi}_{CLOSE_APPROACH_AU}au_all.json", params=params,
                 headers={"User-Agent": sb_sbdb.user_agent()})
    d = json.loads(path.read_text())
    rec = record(path)
    ctx.add_source(SourceRecord(
        id="jpl-cneos-cad", title=f"JPL CNEOS close-approach data: approaches to any planet within "
                                  f"{CLOSE_APPROACH_AU} au, {lo} to {hi}",
        citation="JPL Center for Near-Earth Object Studies (CNEOS), SBDB Close-Approach Data API "
                 "(https://ssd-api.jpl.nasa.gov/doc/cad.html).",
        url=rec["url"], retrieved=rec["retrieved"], sha256=rec["sha256"], license=sb_sbdb.LICENSE,
        notes="Used only to flag objects (core flag closeApproachInWindow); positions do not depend on it."))
    fi = d["fields"].index("des")
    pdes_idx = {str(p): i for i, p in enumerate(cat.s["pdes"])}
    rows = sorted({pdes_idx[r[fi]] for r in d.get("data", []) if r[fi] in pdes_idx})
    return rows, int(d.get("count", 0))


def _mpc_crosscheck(cat, mpc, mpc_row, state_epoch, model) -> dict:
    """Heliocentric positions from the MPC elements vs the JPL elements, both at the standard epoch 2026-06-09
    (JPL: 2461200.5 TDB; MPC K2669 = 2026-06-09.0 TT, 1.6 ms apart), for every object in both catalogues."""
    both = (mpc_row >= 0) & (cat.f["epoch"] == 2461200.5)
    rows = np.nonzero(both)[0]
    k = mpc_row[rows]
    same_epoch = mpc.epoch_packed[k] == "K2669"
    rows, k = rows[same_epoch], k[same_epoch]
    el = mpc.elems[k]
    Mdeg, peri, node, inc, e, nmot, a = el.T
    q = a * (1 - e) * sb_model.AU_KM
    Mr = np.remainder(np.radians(Mdeg) + np.pi, 2 * np.pi) - np.pi
    nrad = np.sqrt(model.mu_sun * (1 - e) ** 3 / q ** 3)
    s_mpc, st = dyn.elements_to_states(q, e, np.radians(inc), np.radians(node), np.radians(peri), Mr / nrad,
                                       model.mu_sun, model.obliquity)
    dr = np.linalg.norm(s_mpc[:, :3] - state_epoch[rows, :3], axis=1)
    disagree = np.zeros(cat.n, dtype=bool)
    # MPCORB prints angles to 1e-5 deg (~ 70 km at 3 au) and a to 1e-7 au: only far larger gaps are disagreements.
    bad = dr > 1.0e5
    disagree[rows[bad]] = True
    pct = {f"p{p}": float(np.percentile(dr, p)) for p in (50, 90, 99, 99.9)}
    return {"compared": int(rows.size), "km": pct, "over1e5km": int(bad.sum()),
            "over1e4km": int((dr > 1e4).sum()), "disagree": disagree}


def _sources(ctx, snap, src_ids, phys_dl, lcdb_path, mpc_path) -> list[str]:
    """Register every SourceRecord used by the small-body products; return the shared sourceTable order."""
    ids = [src_ids["orbits"], src_ids["phys"], src_ids.get("nongrav", "jpl-sbdb-nongrav")]
    nw = phys_dl["neowise"]
    recs = [record(d.fetch()) for d in nw]
    ctx.add_source(SourceRecord(
        id="neowise-v2", title=nw[0].title, citation=nw[0].citation,
        url=nw[0].url.rsplit("/", 1)[0] + "/", retrieved=recs[0]["retrieved"],
        sha256=sb_sbdb.combined_sha256([d.fetch() for d in nw]), version=nw[0].version, license=nw[0].license,
        notes="Files: " + ", ".join(d.name for d in nw) + "; sha256 = SHA-256 over the per-file sha256 values in "
              "that order. Diameter used only where Fit_code has D, p_V only where it has V (else 'assumed value')."))
    ids.append("neowise-v2")
    ids.append(ps.LCDB.register(ctx))
    gd = phys_dl["gaia"]
    grec = record(gd[0].fetch())
    ctx.add_source(SourceRecord(
        id="gaia-dr3-sso-reflectance", title=gd[0].title, citation=gd[0].citation, url=ps.GAIA_BASE,
        retrieved=grec["retrieved"], sha256=sb_sbdb.combined_sha256([d.fetch() for d in gd]), version=gd[0].version,
        license=gd[0].license, notes="SsoReflectanceSpectrum_00..19.csv.gz; sha256 over the per-file sha256 values."))
    ids.append("gaia-dr3-sso-reflectance")
    ids.append(ps.MPCORB.register(ctx))
    r = record(snap.orbit_pages[0])
    ctx.add_source(SourceRecord(
        id="smallbodies-class-albedo",
        title="Median measured geometric albedo per SBDB orbit class (population statistic, computed by the "
              "smallbodies stage)",
        citation="Computed from the measured albedos of jpl-sbdb-physical and neowise-v2 (median, 16th and 84th "
                 "percentiles per SBDB orbit class; classes with fewer than 20 measured albedos use the median of all "
                 "classes). Diameter from H: Pravec, P. & Harris, A. W. (2007). Binary asteroid population 1. Angular "
                 "momentum content. Icarus 190, 250-259, DOI:10.1016/j.icarus.2007.02.023, Eq. 3.",
        url="https://doi.org/10.1016/j.icarus.2007.02.023", retrieved=r["retrieved"],
        notes="Values in smallbodies/core.json classAlbedo. Caveat: the albedos measured so far are a biased sample "
              "(infrared surveys favour dark objects less than optical ones, and albedo varies with size), so a "
              "class median is only a population estimate."))
    ids.append("smallbodies-class-albedo")
    ctx.add_source(SourceRecord(
        id="jpl-horizons-sb-states", title="JPL Horizons heliocentric state vectors of small bodies at the common epoch",
        citation=hz.CITATION, url=hz.API_URL, retrieved=_dt.date.today().isoformat(),
        notes="Used only for objects whose SBDB orbit model has terms the propagator does not model (the Horizons "
              "query URL and sha256 of each answer are in data/raw/_downloads.json under horizons/smallbodies/)."))
    ids.append("jpl-horizons-sb-states")
    ctx.add_source(SourceRecord(
        id="bowell-1989", title="Conventional slope parameter G = 0.15 of the IAU H-G magnitude system",
        citation="Bowell, E., Hapke, B., Domingue, D., Lumme, K., Peltoniemi, J. & Harris, A. W. (1989). Application "
                 "of photometric models to asteroids. In Asteroids II (Binzel, Gehrels & Matthews, eds.), University "
                 "of Arizona Press, 524-556. (IAU Commission 20, 1985: H-G system; G = 0.15 adopted by the MPC and JPL "
                 "for objects without a fitted G.)",
        url="https://ui.adsabs.harvard.edu/abs/1989aste.conf..524B", retrieved=_dt.date.today().isoformat(),
        notes="An assumed population value: every G labelled estimated uses it."))
    ids.append("bowell-1989")
    ids += [solar.HSRS.id, "cie-1931-2deg-cmf", "cie-1951-scotopic", filters.FILTERS["V"].id, "naif-de442s",
            "naif-gm-de440", "naif-pck00011"]
    solar.HSRS.register(ctx)
    filters.register(ctx, ("V",))
    from .. import cie
    cie.register_sources(ctx)
    return ids
