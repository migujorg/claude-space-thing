"""Titan's atmosphere model against Titan's measured disk-integrated brightness (docs/reports/atmospheres.md,
"Titan"). The model is evaluated exactly, by the Monte Carlo reference of titan_rt.py (docs/reports/titan-mc.json,
`python -m pipeline.photometry.titan_rt`), so these comparisons test the model's inputs, not the renderer's
approximations (those are tested against the same reference in app/tests/render-titan.test.ts):

- Karkoschka's (1998) full-disk albedo spectrum at phase 5.7° (the 1 nm PDS table, as in photometry.json but
  without the zero-phase factor), per 10 nm sample and folded to X, Y, Z, S;
- García Muñoz et al.'s (2017) Cassini ISS phase curves (tables/titan_garcia_munoz_2017_iss.csv) in the five broad
  and medium NAC filters inside 360-830 nm, band-averaged with the SVO system responses; the two methane filters are
  listed too, but the model's 10 nm sampling (box-averaged absorption) cannot resolve their 5 nm passbands.

Nothing here feeds back into the model.
"""

from __future__ import annotations

import json
import math

import numpy as np

from ..paths import REPO
from . import albedo, atmo, filters
from .common import read_table_json
from .titan_digitize import read_iss

MC_JSON = REPO / "docs" / "reports" / "titan-mc.json"
RENDERER_JSON = REPO / "docs" / "reports" / "titan-renderer.json"
# GM2017 filter combinations → SVO NAC curves; True: broad/medium band (resolved by the 10 nm model).
ISS = {"BL1_CL2": ("cassini.nac.BL1", True), "CL1_GRN": ("cassini.nac.GRN", True),
       "CL1_CB1": ("cassini.nac.CB1", True), "RED_CL2": ("cassini.nac.RED", True),
       "CL1_CB2": ("cassini.nac.CB2", True), "CL1_MT1": ("cassini.nac.MT1", False),
       "CL1_MT2": ("cassini.nac.MT2", False)}
PHASE_BINS = [(0, 15), (15, 30), (30, 45), (45, 60), (60, 75), (75, 90), (90, 105), (105, 120), (120, 135),
              (135, 150), (150, 160), (160, 170)]


def mc() -> dict:
    with open(MC_JSON) as f:
        m = json.load(f)
    m["A"] = np.array([c["AgPhi"] for c in m["curves"]])          # [sample][α bin]
    m["sigma"] = np.array([c["sigma"] for c in m["curves"]])
    m["shell"] = np.array([c["shell"] for c in m["curves"]])
    m["alpha"] = np.array(m["alphaDeg"])
    m["wl"] = np.array([c["wavelengthNm"] for c in m["curves"]])
    return m


def mc_at(m: dict, alpha_deg: float) -> np.ndarray:
    """A_gΦ per sample at α, linear between bin centres (the first bin, centred at 6.0°, held below it)."""
    a = m["alpha"]
    return np.array([np.interp(alpha_deg, a, row) for row in m["A"]])


def karkoschka_57() -> tuple[np.ndarray, float]:
    """Titan's full-disk albedo at 5.7° on the 1 nm air grid 360-830 nm (Karkoschka 1998, PDS 1995LOW.TAB column 8,
    referenced to the pck00011 radius), and the phase angle."""
    d = np.loadtxt(albedo.KARKOSCHKA.fetch())
    k = read_table_json("karkoschka_disk_radii.json")
    area = (k["radius_km"]["606"] / albedo.mean_radius(606)) ** 2
    return np.interp(atmo.FINE, d[:, 1], d[:, 7] * area), float(k["phase_angle_deg_1995"]["606"])


def xyzs_of_fine(p: np.ndarray) -> np.ndarray:
    return atmo.channel_weights() @ p


def chromaticity(c: np.ndarray) -> tuple[float, float]:
    s = c[0] + c[1] + c[2]
    return float(c[0] / s), float(c[1] / s)


def spectrum_check(m: dict) -> dict:
    """Model at the first bin (centre 6.0°) vs Karkoschka at 5.7°: per sample (10 nm box averages) and per channel
    (the model folded with the atmosphere product's fold weights, as the renderer folds; the observation
    integrated at 1 nm)."""
    k98, a_obs = karkoschka_57()
    obs = atmo.sample_box(k98)
    mod = m["A"][:, 0]
    sig = m["sigma"][:, 0]
    W = atmo.fold_weights()
    c_mod = W @ mod
    c_obs = xyzs_of_fine(k98)
    return {"alpha_obs": a_obs, "alpha_mod": float(m["alpha"][0]), "wl": m["wl"].tolist(), "model": mod.tolist(),
            "model_sigma": sig.tolist(), "observed": obs.tolist(), "ratio": (mod / obs).tolist(),
            "xyzs_model": c_mod.tolist(), "xyzs_observed": c_obs.tolist(), "xyzs_ratio": (c_mod / c_obs).tolist(),
            "xy_model": chromaticity(c_mod), "xy_observed": chromaticity(c_obs)}


def iss_check(m: dict) -> dict:
    """Per filter: the model band-averaged at each measurement's phase angle; the median ratio measured / model per
    phase bin, and over all phases."""
    data = read_iss()
    out = {}
    for name, (key, broad) in ISS.items():
        al, v = data[name]
        mod_curve = np.array([filters.band_average(key, m["wl"], m["A"][:, j]) for j in range(m["alpha"].size)])
        mod = np.interp(al, m["alpha"], mod_curve)
        r = v / mod
        bins = []
        for lo, hi in PHASE_BINS:
            s = (al >= lo) & (al < hi)
            if s.sum():
                bins.append({"lo": lo, "hi": hi, "n": int(s.sum()), "median_ratio": float(np.median(r[s])),
                             "measured_median": float(np.median(v[s])), "model_median": float(np.median(mod[s]))})
        out[name] = {"filter": key, "broad": broad, "lambda_eff_nm": filters.effective_wavelength(key),
                     "n": int(al.size), "median_ratio": float(np.median(r)), "bins": bins,
                     "within_20pct": float(np.mean(np.abs(r - 1) <= 0.2))}
    return out


def renderer_check(m: dict) -> dict | None:
    """The renderer (its CPU twin's disk integrals, docs/reports/titan-renderer.json, written by app/tests/
    render-titan.test.ts with TITAN_REPORT=1): against the Monte Carlo solution per sample and phase (its
    approximation error), and against the observations as for the model: Karkoschka at 5.7° per sample and folded (each
    sample its own bin, and the app's 12 bins), and the ISS measurements (the renderer linear in α between its
    phase angles)."""
    if not RENDERER_JSON.exists():
        return None
    with open(RENDERER_JSON) as f:
        r = json.load(f)
    phases = np.array(r["phasesDeg"])
    per = np.array(r["perSample"]["A"])                     # [phase][sample]
    ref = np.array([mc_at(m, a) for a in phases])
    ratio = per / ref
    k98, _ = karkoschka_57()
    obs = atmo.sample_box(k98)
    W = atmo.fold_weights()
    c_obs = xyzs_of_fine(k98)
    c_per = W @ per[0]
    app_w = np.array(r["appBins"]["weights"])               # [channel][bin]
    c_app = app_w @ np.array(r["appBins"]["A"][0])
    data = read_iss()
    iss = {}
    wl = np.array(r["perSample"]["wavelengthsNm"])
    for name, (key, broad) in ISS.items():
        al, v = data[name]
        curve = np.array([filters.band_average(key, wl, row) for row in per])
        rat = v / np.interp(al, phases, curve)
        bins = []
        for lo, hi in PHASE_BINS:
            s = (al >= lo) & (al < hi)
            if s.sum():
                bins.append({"lo": lo, "hi": hi, "n": int(s.sum()), "median_ratio": float(np.median(rat[s]))})
        iss[name] = {"broad": broad, "median_ratio": float(np.median(rat)), "bins": bins,
                     "within_20pct": float(np.mean(np.abs(rat - 1) <= 0.2))}
    return {"phases": phases.tolist(), "ratio_to_mc": ratio.tolist(), "wl": r["perSample"]["wavelengthsNm"],
            "spectrum_ratio": (per[0] / obs).tolist(), "xyzs_per_sample": c_per.tolist(),
            "xyzs_app_bins": c_app.tolist(), "xyzs_observed": c_obs.tolist(),
            "xyzs_ratio_per_sample": (c_per / c_obs).tolist(), "xyzs_ratio_app_bins": (c_app / c_obs).tolist(),
            "xy_per_sample": chromaticity(c_per), "xy_app_bins": chromaticity(c_app), "xy_observed": chromaticity(c_obs),
            "iss": iss}


def results() -> dict:
    m = mc()
    return {"mc": {"photons": m["photonsPerSample"], "samples": int(m["wl"].size)}, "spectrum": spectrum_check(m),
            "iss": iss_check(m), "renderer": renderer_check(m)}


def main() -> None:
    r = results()
    s = r["spectrum"]
    print("sample  model(6°)  K98(5.7°)  ratio")
    for w, a, o, q in zip(s["wl"], s["model"], s["observed"], s["ratio"]):
        print(f"{w:5.0f}  {a:.4f}  {o:.4f}  {q:.3f}")
    print("XYZS ratio", [round(x, 3) for x in s["xyzs_ratio"]], "xy model", [round(x, 4) for x in s["xy_model"]],
          "observed", [round(x, 4) for x in s["xy_observed"]])
    for name, f in r["iss"].items():
        print(f"{name} ({f['lambda_eff_nm']:.0f} nm, n {f['n']}): median measured/model {f['median_ratio']:.3f}, "
              f"{100 * f['within_20pct']:.0f} % within ±20 %")
        print("   " + "  ".join(f"{b['lo']}-{b['hi']}:{b['median_ratio']:.2f}({b['n']})" for b in f["bins"]))
    rr = r["renderer"]
    if rr:
        q = np.array(rr["ratio_to_mc"])
        for a, row in zip(rr["phases"], q):
            print(f"renderer / MC at {a:5.1f}°: {row.min():.3f}-{row.max():.3f} (median {np.median(row):.3f})")
        print("renderer XYZS / K98: per sample", [round(x, 3) for x in rr["xyzs_ratio_per_sample"]], "app bins",
              [round(x, 3) for x in rr["xyzs_ratio_app_bins"]], "xy", [round(x, 4) for x in rr["xy_app_bins"]],
              "observed", [round(x, 4) for x in rr["xy_observed"]])
        for name, f in rr["iss"].items():
            print(f"  {name}: median measured/renderer {f['median_ratio']:.3f}, {100 * f['within_20pct']:.0f} % within "
                  "±20 %: " + "  ".join(f"{b['lo']}-{b['hi']}:{b['median_ratio']:.2f}" for b in f["bins"]))
    _ = math


if __name__ == "__main__":
    main()
