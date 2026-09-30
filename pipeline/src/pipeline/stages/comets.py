"""Stage `comets`: what comets look like (coma, dust tail, ion tail) and which ones matter in the window.

Products
  comets/model.json   spectral components (XYZS and V per unit: dust continuum per unit Afrho geometry, gas emission
                      bands per erg cm^-2 s^-1), composition ratios (per comet where measured, population medians),
                      Haser enclosed-fraction tables, fluorescence efficiencies, dust-grain dynamics, dust phase
                      function, solar-wind speed. The app (render/comets) composes them at each comet's r, Delta, phase.
  comets/list.json    every comet with a total-magnitude law: predicted peak m1 from Earth in the catalogue window
                      (propagated with the smallbodies force model), and the comets brighter than NOTABLE_MAG at peak
                      (the app evaluates those every frame for extended rendering), with measured composition where
                      A'Hearn et al. (1995) observed them.
Report: docs/reports/comets.json (+ img/comets-window-magnitudes.svg). Test fixture: app/tests/fixtures/
comet_reference.json (our state of the showcase comet next to JPL Horizons' r, Delta, T-mag, PsAng, PsAMV).
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import re
import time
from pathlib import Path

import numpy as np

from .. import cie
from .. import comet_model as cm
from .. import comet_sources as cs
from .. import comet_window as cw
from .. import sb_model
from ..download import fetch, record, sha256_file
from ..paths import OUT
from ..output import write_json
from ..photometry import filters, solar
from ..schema import BuildContext

STAGE = "comets"
DEPENDS: tuple[str, ...] = ("light", "smallbodies", "sbphotometry")
DIR = "comets"
REPO = Path(__file__).resolve().parents[4]
REPORT = REPO / "docs" / "reports" / "comets.json"
FIGURE = REPO / "docs" / "reports" / "img" / "comets-window-magnitudes.svg"
FIXTURE = REPO / "app" / "tests" / "fixtures" / "comet_reference.json"
DAY = 86400.0
NOTABLE_MAG = 12.0            # predicted peak m1 from Earth: listed in the report and evaluated per frame by the app
SHOWCASE_MIN_ELONGATION = 30.0
HASER_SPECIES = ("C2", "CN", "C3", "OH")
HORIZONS_API = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_JD = 2451545.0


def _et_iso(et: float) -> str:
    return (_dt.datetime(2000, 1, 1, 12, tzinfo=_dt.timezone.utc) + _dt.timedelta(seconds=et - 69.184)).strftime("%Y-%m-%d")


def _designation(name_line: str) -> tuple[str, str, str]:
    """(designation, name, prefix) from a names.txt line 'spkid\\tdesignation\\tname\\tprefix\\t...'."""
    f = name_line.split("\t")
    return (f[1] if len(f) > 1 else "", f[2] if len(f) > 2 else "", f[3] if len(f) > 3 else "")


def _full(des: str, prefix: str) -> str:
    return des if (not prefix or des[:1].isdigit() and des.split("-")[0].endswith(prefix)) else f"{prefix}/{des}"


def match_measured(cat: dict, ratios: dict) -> dict[int, str]:
    """Catalogue index -> Lowell database key (numbered periodic comets by number; others by IAU designation)."""
    by_iau = {v["iau"]: k for k, v in ratios["comets"].items() if not v["periodic"]}
    out = {}
    for j, line in enumerate(cat["names"]):
        des, _, prefix = _designation(line)
        m = re.fullmatch(r"(\d+)([PDCI])", des)
        if m and f"{int(m.group(1))}P" in ratios["comets"]:
            out[j] = f"{int(m.group(1))}P"
        elif des in by_iau:
            out[j] = by_iau[des]
    return out


def horizons_fixture(best: dict, cat: dict, cur: dict) -> dict:
    """JPL Horizons observer quantities of the showcase comet at three epochs around its peak (sha256-recorded),
    next to our own geometry at the same instants (for app tests of magnitudes and tail directions)."""
    des, name, prefix = _designation(cat["names"][best["index"]])
    full = _full(des, prefix)
    i_peak = int(np.argmin(np.abs(cur["et"] - best["peakEt"])))
    idx = [max(0, i_peak - 12), i_peak, min(cur["et"].size - 1, i_peak + 14)]
    ets = [float(cur["et"][i]) for i in idx]
    # UT JD of our TDB epochs (TDB - UT ~ 69.184 s in 2025-2028, no leap second announced)
    jds = [J2000_JD + (et - 69.184) / DAY for et in ets]
    params = {"format": "text", "COMMAND": f"'DES={full};CAP;NOFRAG'", "OBJ_DATA": "'YES'", "MAKE_EPHEM": "'YES'",
              "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'500@399'", "TLIST": "'" + "','".join(f"{jd:.6f}" for jd in jds) + "'",
              "TLIST_TYPE": "'JD'", "TIME_TYPE": "'UT'", "QUANTITIES": "'1,9,19,20,24,27'", "CSV_FORMAT": "'YES'",
              "ANG_FORMAT": "'DEG'", "EXTRA_PREC": "'YES'"}
    path = fetch(HORIZONS_API, "comets/horizons", re.sub(r"[^A-Za-z0-9]+", "_", full) + "_observer.txt", params=params)
    text = path.read_text()
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        rows.append({"dateUt": f[0], "raDeg": float(f[3]), "decDeg": float(f[4]), "tMag": float(f[5]),
                     "rAu": float(f[7]), "rdotKmS": float(f[8]), "deltaAu": float(f[9]), "deldotKmS": float(f[10]),
                     "stoDeg": float(f[11]), "psAngDeg": float(f[12]), "psAmvDeg": float(f[13])})
    m1 = re.search(r"M1=\s*([-\d.]+)\s+M2=.*?k1=\s*([-\d.]+)", text)
    ours = []
    j = best["index"]
    epoch = float(cat["header"]["epochEt"])
    model = sb_model.build(None, min(min(ets), epoch) - 10 * DAY, max(max(ets), epoch) + 10 * DAY, epoch)
    for k, i in enumerate(idx):
        s = np.concatenate([cat["pos"][j], cat["vel"][j]])[None, :].copy()
        st, _ = sb_model.propagate(model, s, np.array([epoch]), ets[k], epoch, cat["ng"][j:j + 1], cat["hasNg"][j:j + 1])
        if int(st[0]) != 0:
            raise RuntimeError(f"{full}: propagation to the fixture epoch failed ({int(st[0])})")
        ours.append({"et": ets[k], "helioKm": [float(v) for v in s[0, :3]], "helioVelKmS": [float(v) for v in s[0, 3:]],
                     "earthHelioKm": [float(v) for v in cur["earth"][i]],
                     "m1": float(cur["m"][i, j]), "rAu": float(cur["r"][i, j]), "deltaAu": float(cur["d"][i, j])})
    rec = record(path)
    return {
        "generatedBy": "uv run python -m pipeline build --only comets",
        "comet": {"row": best["row"], "designation": full, "name": name, "M1": best["M1"], "K1": best["K1"]},
        "horizons": {"url": rec["url"], "sha256": rec["sha256"], "retrieved": rec["retrieved"],
                     "M1": float(m1.group(1)) if m1 else None, "K1": float(m1.group(2)) if m1 else None, "rows": rows},
        "ours": ours,
        "description": "Horizons (geocentric, light-time aberrated, ICRF): T-mag = M1 + 5 log Delta + K1 log r; PsAng = "
                       "position angle of the extended Sun-to-comet radius vector (anti-sunward, gas-tail indicator); "
                       "PsAMV = position angle of the negative heliocentric velocity (dust-tail indicator). ours: the "
                       "smallbodies state propagated by the comets stage (geometric, no light time) and DE442s Earth, "
                       "heliocentric ICRF km, at the same instants (TDB).",
    }


def magnitude_svg(cat: dict, cur: dict, notable: list[dict]) -> str:
    """m1(t) from Earth for the notable comets over the window (lower = brighter)."""
    W, H, L, R, T, B = 1160, 520, 60, 410, 20, 50
    et = cur["et"]
    t0, t1 = float(et[0]), float(et[-1])
    lo, hi = -2.0, 16.0
    x = lambda t: L + (t - t0) / (t1 - t0) * (W - L - R)
    y = lambda m: T + (m - lo) / (hi - lo) * (H - T - B)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" font-family="sans-serif" font-size="11">',
           f'<rect width="{W}" height="{H}" fill="white"/>']
    for m in range(int(lo), int(hi) + 1, 2):
        out.append(f'<line x1="{L}" x2="{W - R}" y1="{y(m):.1f}" y2="{y(m):.1f}" stroke="#ddd"/>'
                   f'<text x="{L - 6}" y="{y(m) + 4:.1f}" text-anchor="end">{m}</text>')
    yr0 = int(_et_iso(t0)[:4])
    for yr in range(yr0, yr0 + 4):
        for mo in (1, 7):
            et_m = (_dt.datetime(yr, mo, 1, tzinfo=_dt.timezone.utc) - _dt.datetime(2000, 1, 1, 12, tzinfo=_dt.timezone.utc)).total_seconds() + 69.184
            if t0 <= et_m <= t1:
                out.append(f'<line x1="{x(et_m):.1f}" x2="{x(et_m):.1f}" y1="{T}" y2="{H - B}" stroke="#eee"/>'
                           f'<text x="{x(et_m):.1f}" y="{H - B + 16}" text-anchor="middle">{yr}-{mo:02d}</text>')
    palette = ["#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#8c564b", "#e377c2", "#17becf", "#7f7f7f",
               "#bcbd22", "#393b79", "#637939", "#8c6d31", "#843c39", "#7b4173", "#3182bd", "#e6550d", "#31a354"]
    for k, n in enumerate(notable[:18]):
        j = n["index"]
        col = palette[k % len(palette)]
        pts = [(x(float(et[i])), y(min(hi, max(lo, float(cur["m"][i, j]))))) for i in range(0, et.size, 2)
               if np.isfinite(cur["m"][i, j])]
        out.append(f'<polyline fill="none" stroke="{col}" stroke-width="1.4" points="' +
                   " ".join(f"{a:.1f},{b:.1f}" for a, b in pts) + '"/>')
        out.append(f'<text x="{W - R + 8}" y="{T + 12 + 15 * k}" fill="{col}">{n["label"]} {n["peakMag"]:.1f} '
                   f'({_et_iso(n["peakEt"])}, elong {n["elongationDeg"]:.0f}°)</text>')
    out.append(f'<text x="{L}" y="{H - 10}">Predicted total magnitude m1 = M1 + 5 log Δ + K1 log r from Earth (SBDB '
               'M1/K1, estimated; comets depart by 1-2 mag). Curves clipped to [-2, 16].</text>')
    out.append(f'<text x="14" y="{(H - B + T) / 2}" transform="rotate(-90 14 {(H - B + T) / 2})" text-anchor="middle">m1 (mag)</text>')
    out.append("</svg>")
    return "\n".join(out)


def run(ctx: BuildContext) -> None:
    t_stage = time.time()
    src = cs.register(ctx)
    for s in (solar.HSRS, solar.IAU_B3):
        ctx.add_source(s.source())
    cie_ids = cie.register_sources(ctx)
    filt_ids = filters.register(ctx, keys=("B", "V", "R", "I"))
    tabs = cs.tables()

    # ---- measured composition and band strengths
    db = cs.read_lowell_db()
    ratios = cm.lowell_ratios(db)
    mcd = cs.read_mcdonald()
    band_ratio = cm.mcdonald_band_ratios(mcd["rows"])
    win = mcd["windows"]
    windows_nm = {"C2(0)": win["C2 (delta NU = 0)"], "C2(1)": win["C2 (delta NU = 1)"], "CN(0)": win["CN (delta NU = 0)"],
                  "C3": win["C3"], "CH": win["CH"]}
    windows_nm = {k: (v[0] / 10.0, v[1] / 10.0) for k, v in windows_nm.items()}
    comps = cm.components(tabs, band_ratio, windows_nm)
    gf = cs.read_gfactors()
    scales = cs.read_haser()
    haser = cm.haser_tables(scales, HASER_SPECIES)
    phase_a, phase_p = cs.read_dust_phase()
    wind = cs.read_omni_speed()

    # ---- the window
    sb = OUT / "smallbodies"
    cat = cw.load_comets(sb)
    w = cat["header"]["window"]
    cur = cw.window_curves(cat, w["startEt"], w["endEt"], ctx=ctx)
    peaks = cw.peaks(cat, cur)
    measured = match_measured(cat, ratios)
    gm_sun = float(cat["header"]["forceModel"]["sun"]["gm"])
    grains = cm.grains(tabs, gm_sun)

    notable = []
    for p in peaks:
        if p["peakMag"] > NOTABLE_MAG:
            break
        des, name, prefix = _designation(cat["names"][p["index"]])
        full = _full(des, prefix)
        notable.append({**p, "designation": full, "name": name, "label": f"{full} {name}".strip(),
                        "measured": measured.get(p["index"])})
    best = next(n for n in notable if n["elongationDeg"] >= SHOWCASE_MIN_ELONGATION and "-" not in n["designation"])

    ox_photons = cm.oxygen_photons_per_h2o(tabs)
    cop = cm.co_plus(tabs)
    gtab = cm.cn_gfactor_table(gf)
    wq = tabs["waterFromMagnitude"]
    lab_src = {
        "composition": [src["lowell"]], "bands": [src["mcdonald"], src["lowellTools"]],
        "water": [src["jorda-2008"]], "dustColour": [src["jewitt-2015-colors"], *filt_ids, *cie_ids, solar.HSRS.id],
        "oxygen": [src["bhardwaj-raghuram-2012"]], "grains": [src["agarwal-2007-dust"], src["moreno-jehin-2025"], solar.IAU_B3.id,
                                                              "naif-gm-de440"],
        "coPlus": [src["rousselot-2024-coplus"], src["cochran-2015-composition"]], "wind": [src["omni2-2024"]],
        "phase": [src["schleicher-2010-dust-phase"]], "haser": [src["lowellTools"], src["opitom-2024-12p"]],
    }
    sbphot = json.loads((OUT / "smallbodies" / "photometry.json").read_text())
    model = {
        "sun": {"vMag": sbphot["vSun"]["value"], "vMagSources": sbphot["vSun"]["sources"],
                "irradianceXYZS1Au": sbphot["sunIrradianceXYZS1AU"]["value"],
                "gmKm3S2": gm_sun, "gmSources": cat["header"]["forceModel"]["sun"]["sources"],
                "method": "V_sun and the solar XYZS at 1 au exactly as the small-body point sources use them (smallbodies/"
                          "photometry.json), so a comet drawn extended has the brightness it has as a point."},
        "description": "Physical model of comet comae and tails (docs/reports/comets.md). The app evaluates it at each "
                       "comet's heliocentric distance r, observer distance Delta and phase angle; the total brightness of "
                       "the coma is always the SBDB total-magnitude law (smallbodies/comets.json M1, K1).",
        "waterFromMagnitude": {"a": wq["a"], "b": wq["b"], "qH2OPerQOH": wq["qH2OPerQOH"], "rmsDex": wq["rmsDex"],
                               "rRangeAu": wq["rRangeAu"], "label": "estimated", "sources": lab_src["water"],
                               "method": "log10 Q(H2O) [s^-1] = a - b mH, mH = M1 + K1 log10 r; Q(OH) = Q(H2O) / qH2OPerQOH"},
        "composition": {
            "population": {k: v for k, v in ratios["population"].items()}, "label": "estimated",
            "sources": lab_src["composition"],
            "method": "log10 Q(X)/Q(OH) and log10 Afrho[cm]/Q(OH) (blue continuum, 484.5 nm): per-comet medians over "
                      "the Lowell observations (A'Hearn et al. 1995), population = median of the per-comet values. A "
                      "comet with its own measurements (list.json measured) uses them (label derived: measured ratios "
                      "applied at other times)."},
        "gFactors": {"C2": gtab["C2"], "C3": gtab["C3"], "CN": {"vKmS": gtab["vKmS"], "value": gtab["CN"]},
                     "unit": "erg s^-1 molecule^-1 at 1 au (scale r^-2)", "label": "measured", "sources": [src["lowellTools"]]},
        "bandRatiosToC2": {k: band_ratio[k] for k in ("C2(1)", "CH") if k in band_ratio} | {
            "label": "measured", "sources": [src["mcdonald"]],
            "method": "median F(band)/F(C2 Delta v=0) over McDonald observations with both bands at the same aperture "
                      "offset (Cochran et al. 1992; flux-calibrated IDS spectra)."},
        "bandRatioChecks": {k: band_ratio[k] for k in ("CN(0)", "C3") if k in band_ratio},
        "haser": {"velocityKmS": tabs["haserVelocity"]["kmS"], "species": haser, "scaling": "l_p, l_d ∝ r^2",
                  "sources": lab_src["haser"], "label": "estimated",
                  "method": "Enclosed fraction of daughters within projected radius rho vs log10(rho / l_d); total "
                            "daughters in the coma N = Q l_d / v. CH and C2 (Delta v = +1) follow C2; [O I] follows OH."},
        "oxygen": {"photonsPerH2O": ox_photons, "branching": tabs["oxygenRedDoublet"]["branching"],
                   "photonEnergyErg": {k: cm.photon_energy_erg(v) for k, v in tabs["oxygenRedDoublet"]["wavelengthsNm"].items()},
                   "label": "estimated", "sources": lab_src["oxygen"]},
        "coPlus": cop | {"label": "estimated", "sources": lab_src["coPlus"],
                         "method": "Ion tail: CO+ ions produced at Q(CO) = coPerH2O Q(H2O), each radiating gTotal r^-2 "
                                   "while carried anti-sunward at the solar-wind speed (column per unit length Q/v_sw)."},
        "solarWind": {"medianKmS": float(np.median(wind)), "p16KmS": float(np.percentile(wind, 16)),
                      "p84KmS": float(np.percentile(wind, 84)), "hours": int(wind.size), "label": "measured",
                      "sources": lab_src["wind"], "method": "median of the 2024 OMNI hourly flow speeds at 1 au"},
        "grains": grains | {"label": "estimated", "sources": lab_src["grains"]},
        "dustPhase": cm.dust_phase(phase_a, phase_p) | {"label": "measured", "sources": lab_src["phase"],
                                                        "method": "phase function normalised at 0 deg"},
        "components": comps | {"sources": lab_src["dustColour"] + lab_src["bands"] + lab_src["oxygen"] + lab_src["coPlus"]},
        "gasFractionMax": 0.9,
        "gasFractionNote": "If the modelled gas V flux exceeds this fraction of the M1/K1 total, the gas is scaled down to "
                           "it (the rest is dust).",
    }
    write_json(ctx, f"{DIR}/model.json", model, STAGE)

    meas_out = {}
    for j, key in measured.items():
        c = ratios["comets"][key]
        meas_out[str(int(cat["rows"][j]))] = {"key": key, **{k: c[k] for k in ("C2", "CN", "C3", "afrho") if k in c},
                                              "n": c["n"], "rRangeAu": c["rRangeAu"], "label": "derived",
                                              "sources": [src["lowell"]]}
    lst = {
        "window": w, "notableMag": NOTABLE_MAG, "count": len(peaks),
        "method": "Daily geocentric m1 over the window: core states propagated with the smallbodies force model "
                  "(non-gravitational terms where fitted), DE442s Earth, SBDB M1/K1. Estimated (1-2 mag scatter; "
                  "far worse for disintegrating comets and sungrazers).",
        "notable": [{k: n[k] for k in ("row", "designation", "name", "M1", "K1", "peakMag", "peakEt", "rAu", "deltaAu",
                                       "elongationDeg", "perihelionEt", "qAu")} | {"measured": n["measured"]}
                    for n in notable],
        "showcase": {"row": best["row"], "designation": best["designation"], "name": best["name"],
                     "rule": f"brightest notable comet with solar elongation >= {SHOWCASE_MIN_ELONGATION:g} deg at peak, "
                             "not a fragment"},
        "measured": meas_out,
        "label": "estimated", "sources": ["jpl-sbdb-orbits", "naif-de442s", *lab_src["composition"]],
    }
    write_json(ctx, f"{DIR}/list.json", lst, STAGE)

    fx = horizons_fixture(best, cat, cur)
    # The model itself travels with the fixture, so the app's comet tests do not need built data.
    fx["measured"] = meas_out.get(str(best["row"]))
    fx["model"] = model
    FIXTURE.write_text(json.dumps(fx, indent=None, separators=(",", ":")))
    FIGURE.write_text(magnitude_svg(cat, cur, notable))
    report = {
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "seconds": round(time.time() - t_stage, 1),
        "notable": [{k: n[k] for k in ("designation", "name", "peakMag", "rAu", "deltaAu", "elongationDeg", "qAu",
                                       "measured")} | {"peakDate": _et_iso(n["peakEt"]), "perihelionDate": _et_iso(n["perihelionEt"])}
                    for n in notable],
        "showcase": lst["showcase"],
        "horizonsCheck": [{"date": h["dateUt"], "horizonsTMag": h["tMag"], "oursM1": o["m1"], "horizonsR": h["rAu"],
                           "oursR": o["rAu"], "horizonsDelta": h["deltaAu"], "oursDelta": o["deltaAu"]}
                          for h, o in zip(fx["horizons"]["rows"], fx["ours"])],
        "bandRatiosToC2": band_ratio, "population": ratios["population"],
        "measuredComets": {k: v["key"] for k, v in meas_out.items()},
        "dustColour": {k: {kk: comps["dust"][k][kk] for kk in ("xyzs", "v", "normalizedGradientPer100nm")} for k in comps["dust"]},
        "grains": grains, "oxygenPhotonsPerH2O": ox_photons, "coPlus": cop, "solarWind": model["solarWind"],
        "products": {k: v for k, v in ctx.products.items() if v["stage"] == STAGE},
    }
    REPORT.write_text(json.dumps(report, indent=1, allow_nan=False))
    print(f"[comets] {len(peaks)} comets with M1/K1, {len(notable)} brighter than m1 = {NOTABLE_MAG:g} at peak; showcase "
          f"{best['designation']} {best['name']} (peak {best['peakMag']:.2f} on {_et_iso(best['peakEt'])}); "
          f"{time.time() - t_stage:.0f} s")
