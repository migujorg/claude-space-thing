"""Stage `nightglow`: the Earth's own light at night, airglow and aurora (docs/reports/nightglow.md).

Products
  nightglow/airglow.json          AirglowModel: PALACE v1.0 (Noll et al. 2025) emission classes with their spectra
                                  integrated against the CIE observers (luminance per rayleigh, and its share per 10 nm
                                  sample for attenuation by the lower atmosphere), vertical layers, the 12 x 12
                                  month x local-time climatology with solar-cycle slopes, and the 10.7 cm solar radio
                                  flux (centred 27-day means) for every day of the window.
  nightglow/aurora.json           AuroraModel: OVATION Prime 2010 precipitation (binary below) driven by the OMNI 2
                                  solar-wind coupling (hourly, measured part of the window) or its median
                                  (climatology), the IGRF-14 AACGM-like coordinate grid, and the emission model
                                  (columns per unit energy flux and vertical profiles vs mean energy).
  nightglow/aurora-ovation.bin    float32 [season 4][quantity 2][coupling node][MLT 96][MLAT 80]
  nightglow/aurora-magnetic.bin   float32 [lat 180][lon 360][3]: AACGM-like latitude (deg), cos and sin of longitude
  nightglow/aurora-emission.bin   float32 [energy node][altitude][4]: XYZS emission per km per (erg cm^-2 s^-1)
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import time
from pathlib import Path

import numpy as np

from .. import cie
from .. import nightglow_airglow as ag
from .. import nightglow_aurora as na
from .. import us76_upper
from ..download import record
from ..output import write_bin, write_json
from ..photometry.common import Download, vacuum_to_air
from ..schema import BuildContext, SourceRecord, sourced

STAGE = "nightglow"
DEPENDS: tuple[str, ...] = ()
DIR = "nightglow"
SUB = "nightglow"
OVATION_BASE = "https://raw.githubusercontent.com/lkilcommons/OvationPyme/master/ovationpyme/data/premodel/"
COUPLING_NODES = [float(x) for x in np.concatenate([np.arange(0.0, 7184.0, na.DF_AVE / 16.0), [8000.0, 9500.0, 11500.0,
                                                                                                    14000.0, 18000.0,
                                                                                                    24000.0]])]
ENERGY_NODES_KEV = [float(x) for x in np.geomspace(0.2, 30.0, 22)]
AURORA_ALT_KM = [float(x) for x in np.arange(86.0, 600.0, 2.0)]
MAG_ALT_KM = 110.0
SAMPLE_NM = list(range(360, 831, 10))      # atmospheres.json spectral samples (bins of 10 nm)

PALACE = Download(
    id="palace-v1.0", url="https://zenodo.org/api/records/14064023/files/PALACE.zip/content", subdir=SUB,
    name="PALACE_v1.0.zip", title="PALACE v1.0: Paranal Airglow Line And Continuum Emission model (code and data)",
    citation="Noll, S., Schmidt, C., Hannawald, P., Kausch, W. & Kimeswenger, S. (2024), Paranal Airglow Line And "
             "Continuum Emission (PALACE) model: data and code of v1.0, Zenodo, DOI:10.5281/zenodo.14064022.",
    version="1.0 (10/2024)", license="data CC-BY-4.0, code GNU GPLv3",
    notes="The model files palace_lines.fits, palace_cont.fits and palace_var.fits are read from the zip; the code "
          "is not run (its scaling, Eq. 1 of the paper, is reimplemented and checked in tests).")
PALACE_PAPER = Download(
    id="noll-2025-palace", url="https://gmd.copernicus.org/articles/18/4353/2025/gmd-18-4353-2025.pdf", subdir=SUB,
    name="Noll2025_GMD18_4353.pdf", title="PALACE v1.0: Paranal Airglow Line And Continuum Emission model",
    citation="Noll, S., Schmidt, C., Hannawald, P., Kausch, W. & Kimeswenger, S. (2025), PALACE v1.0: Paranal Airglow "
             "Line And Continuum Emission model, Geosci. Model Dev. 18, 4353-4398, DOI:10.5194/gmd-18-4353-2025.",
    license="CC BY 4.0")
DRAO = Download(
    id="drao-f107-daily", url="https://www.spaceweather.gc.ca/solar_flux_data/daily_flux_values/fluxtable.txt",
    subdir=SUB, name="drao_fluxtable.txt", title="10.7 cm solar radio flux, daily values (DRAO Penticton)",
    citation="National Research Council Canada / Natural Resources Canada, Dominion Radio Astrophysical Observatory: "
             "10.7 cm solar flux, observed, adjusted and URSI-D values, three measurements per day (fluxtable.txt).",
    notes="Updated daily; the copy in data/raw is kept (delete it to refresh).")
SWPC_PRED = Download(
    id="noaa-swpc-predicted-cycle", url="https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json",
    subdir="sky/solar_cycle", name="predicted-solar-cycle.json",
    title="Predicted solar cycle: smoothed sunspot number and F10.7 by month",
    citation="NOAA Space Weather Prediction Center, Solar Cycle Progression (predicted-solar-cycle.json).",
    notes="Updated monthly; the copy in data/raw is kept (delete it to refresh).")
SWPC_OVATION = Download(
    id="noaa-swpc-ovation-nowcast", url="https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", subdir=SUB,
    name="ovation_aurora_latest.json", title="NOAA SWPC aurora 30-minute forecast (OVATION Prime, real-time solar wind)",
    citation="NOAA Space Weather Prediction Center, Aurora - 30 Minute Forecast, ovation_aurora_latest.json (viewing "
             "probability on a 1 deg geographic grid; Machol et al. 2012, Space Weather 10, S03005, "
             "DOI:10.1029/2011SW000746).",
    notes="Used only as a check of the oval's location (docs/reports/nightglow.md); its values are a probability of "
          "seeing aurora, not an energy flux, and carry no mean energy.")
OMNI = {y: Download(
    id=f"omni2-{y}", url=f"https://spdf.gsfc.nasa.gov/pub/data/omni/low_res_omni/omni2_{y}.dat", subdir=SUB,
    name=f"omni2_{y}.dat", title=f"NASA OMNI 2 hourly near-Earth solar-wind data, {y}",
    citation="King, J. H. & Papitashvili, N. E. (2005), Solar wind spatial scales in and comparisons of hourly Wind "
             "and ACE plasma and magnetic field data, J. Geophys. Res. 110, A02104, DOI:10.1029/2004JA010649. OMNI 2 "
             "data from NASA/GSFC Space Physics Data Facility (https://omniweb.gsfc.nasa.gov/).",
    notes="Words 16-17 (By, Bz GSM), 25 (flow speed), 39 (Kp); the file of the current year grows (delete to refresh).")
    for y in (2025, 2026)}
IGRF = Download(
    id="igrf-14", url="https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt", subdir=SUB,
    name="igrf14coeffs.txt", title="International Geomagnetic Reference Field, 14th generation (coefficients)",
    citation="IAGA Division V Working Group V-MOD, International Geomagnetic Reference Field, 14th generation "
             "(IGRF-14): Schmidt semi-normalised spherical harmonic coefficients 1900-2025 (degree 13 from 2000) with "
             "secular variation for 2025-2030; coefficient file distributed by NOAA NCEI.")
FANG = Download(
    id="fang-2008", url="https://acd-ext.gsfc.nasa.gov/People/Jackman/Fang_2008.pdf", subdir=SUB, name="Fang2008_JGR113_A09311.pdf",
    title="Electron impact ionization: A new parameterization for 100 eV to 1 MeV electrons",
    citation="Fang, X., Randall, C. E., Lummerzheim, D., Solomon, S. C., Mills, M. J., Marsh, D. R., Jackman, C. H., "
             "Wang, W. & Lu, G. (2008), J. Geophys. Res. 113, A09311, DOI:10.1029/2008JA013384.",
    notes="Eqs. 2, 4, 6, 7 and Table 1 transcribed in nightglow_tables/aurora.json (fang2008).")
ITIKAWA = Download(
    id="itikawa-2006-n2", url="https://srd.nist.gov/JPCRD/jpcrd697.pdf", subdir=SUB, name="Itikawa2006_JPCRD35_31.pdf",
    title="Cross sections for electron collisions with nitrogen molecules",
    citation="Itikawa, Y. (2006), J. Phys. Chem. Ref. Data 35, 31-53, DOI:10.1063/1.1937426.",
    notes="Table 16 (total ionisation at 100 eV) and Sect. 9.2 / Table 19 (391.4 nm emission) transcribed in "
          "nightglow_tables/aurora.json (n2plus).")
LAHER = Download(
    id="laher-n2plus-1n", url="https://web.ipac.caltech.edu/staff/laher/fluordir/N2+_B-X.out", subdir=SUB,
    name="Laher_N2plus_B-X.out", title="N2+ B-X (first negative) band system: Franck-Condon factors and Einstein coefficients",
    citation="Laher, R. R. (1999), spectroscopic tables (IPAC), computed as in Gilmore, F. R., Laher, R. R. & Espy, "
             "P. J. (1992), Franck-Condon factors, r-centroids, electronic transition moments, and Einstein coefficients "
             "for many nitrogen and oxygen band systems, J. Phys. Chem. Ref. Data 21, 1005-1107, DOI:10.1063/1.555910.")
GABRIELSE = Download(
    id="gabrielse-2021", url="https://www.frontiersin.org/journals/physics/articles/10.3389/fphy.2021.744298/pdf",
    subdir=SUB, name="Gabrielse2021_FrontPhys9_744298.pdf",
    title="Estimating precipitating energy flux, average energy, and Hall auroral conductance from THEMIS all-sky-imagers",
    citation="Gabrielse, C., Nishimura, T., Chen, M., Hecht, J. H., Kaeppler, S. R., Gillies, D. M., Reimer, A. S., "
             "Lyons, L. R., Deng, Y., Donovan, E. & Evans, J. S. (2021), Frontiers in Physics 9, 744298, "
             "DOI:10.3389/fphy.2021.744298.", license="CC BY 4.0",
    notes="Fig. 2B (B3C transport results, Maxwellian) read for fO = 1 (nightglow_tables/aurora.json gabrielse2021).")
WHITER = Download(
    id="whiter-2023", url="https://angeo.copernicus.org/articles/41/1/2023/angeo-41-1-2023.pdf", subdir=SUB,
    name="Whiter2023_AnnGeo41_1.pdf", title="The altitude of green OI 557.7 nm and blue N2+ 427.8 nm aurora",
    citation="Whiter, D. K., Partamies, N., Gustavsson, B. & Kauristie, K. (2023), Ann. Geophys. 41, 1-12, "
             "DOI:10.5194/angeo-41-1-2023.", license="CC BY 4.0")
ATKINSON = Download(
    id="atkinson-2004-iupac", url="https://acp.copernicus.org/articles/4/1461/2004/acp-4-1461-2004.pdf", subdir=SUB,
    name="Atkinson2004_ACP4_1461.pdf",
    title="Evaluated kinetic and photochemical data for atmospheric chemistry: Volume I (IUPAC)",
    citation="Atkinson, R., Baulch, D. L., Cox, R. A., Crowley, J. N., Hampson, R. F., Hynes, R. G., Jenkin, M. E., "
             "Rossi, M. J. & Troe, J. (2004), Atmos. Chem. Phys. 4, 1461-1738, DOI:10.5194/acp-4-1461-2004.",
    license="CC BY")
NIST_OI = Download(
    id="nist-asd-oi-1d", subdir=SUB, name="NIST_ASD_OI_629-640nm.tsv",
    url="https://physics.nist.gov/cgi-bin/ASD/lines1.pl?spectra=O+I&limits_type=0&low_w=629&upp_w=640&unit=1&de=0"
        "&format=3&line_out=0&remove_js=on&en_unit=0&output=0&page_size=15&show_obs_wl=1&show_calc_wl=1&order_out=0"
        "&show_av=2&tsb_value=0&A_out=0&intens_out=on&allowed_out=1&forbid_out=1&conf_out=on&term_out=on"
        "&enrg_out=on&J_out=on",
    title="NIST Atomic Spectra Database: O I lines 629-640 nm (1D2 -> 3P transition probabilities)",
    citation="Kramida, A., Ralchenko, Yu., Reader, J. & NIST ASD Team, NIST Atomic Spectra Database, "
             "https://physics.nist.gov/asd, DOI:10.18434/T4W30F.")
WUEST = Download(
    id="wuest-2023", url="https://acp.copernicus.org/articles/23/1599/2023/acp-23-1599-2023.pdf", subdir=SUB,
    name="Wuest2023_ACP23_1599.pdf", title="Hydroxyl airglow observations for investigating atmospheric dynamics: "
                                          "results and challenges",
    citation="Wuest, S., Bittner, M., Espy, P. J., French, W. J. R. & Mulligan, F. J. (2023), Atmos. Chem. Phys. 23, "
             "1599-1618, DOI:10.5194/acp-23-1599-2023 (quoting Baker, D. J. & Stair, A. T. (1988), Physica Scripta "
             "37, 611, DOI:10.1088/0031-8949/37/4/021: OH layer peak 86.8 +- 2.6 km, FWHM 8.6 +- 3.1 km).",
    license="CC BY 4.0")
LEDNYTSKYY = Download(
    id="lednytskyy-2015", url="https://amt.copernicus.org/articles/8/1021/2015/amt-8-1021-2015.pdf", subdir=SUB,
    name="Lednytskyy2015_AMT8_1021.pdf", title="Atomic oxygen retrievals in the MLT region from SCIAMACHY nightglow "
                                               "limb measurements",
    citation="Lednyts'kyy, O., von Savigny, C., Eichmann, K.-U. & Mlynczak, M. G. (2015), Atmos. Meas. Tech. 8, "
             "1021-1041, DOI:10.5194/amt-8-1021-2015.", license="CC BY 3.0",
    notes="Fig. 4b (green-line limb emission rate) is the limb check of the airglow model (tests, report).")
US76 = Download(
    id="us-standard-atmosphere-1976",
    url="https://ntrs.nasa.gov/api/citations/19770009539/downloads/19770009539.pdf",
    subdir="atmospheres", name="US_Standard_Atmosphere_1976_NTRS19770009539.pdf",
    title="U.S. Standard Atmosphere, 1976 (defining tables, main tables, mid-latitude ozone model)",
    citation="U.S. Standard Atmosphere, 1976. NOAA, NASA, USAF. NOAA-S/T 76-1562 (NASA-TM-X-74335), U.S. Government "
             "Printing Office, Washington D.C., 1976. NTRS 19770009539.",
    license="U.S. Government work",
    notes="Above 86 km: the defining relations as ported in pipeline/src/pipeline/us76_upper.py (after ussa1976 0.3.4, "
          "Y. Nollet, MIT licence), checked against Table VIII (pdf pp. 225-230).")


def log(msg: str) -> None:
    print(f"  [nightglow] {msg}", flush=True)


def _utc_date(et: float) -> _dt.date:
    return (_dt.datetime(2000, 1, 1, 12) + _dt.timedelta(seconds=et - 69.184)).date()


def _sample_bins() -> list[tuple[float, float]]:
    return [(max(360.0, s - 5.0), min(830.5, s + 5.0)) for s in SAMPLE_NM]


def _xyzs_by_sample_lines(wl_vac_nm: np.ndarray, intensity_r: np.ndarray) -> np.ndarray:
    wl = vacuum_to_air(np.asarray(wl_vac_nm, float))
    out = np.zeros((len(SAMPLE_NM), 4))
    for k, (lo, hi) in enumerate(_sample_bins()):
        m = (wl >= lo) & (wl < hi)
        if m.any():
            out[k] = ag.line_xyzs(np.asarray(wl_vac_nm)[m], np.asarray(intensity_r)[m])
    return out


def _xyzs_by_sample_cont(lam_um: np.ndarray, flux: np.ndarray) -> np.ndarray:
    out = np.zeros((len(SAMPLE_NM), 4))
    wl_air = vacuum_to_air(lam_um * 1e3)
    for k, (lo, hi) in enumerate(_sample_bins()):
        f = np.where((wl_air >= lo) & (wl_air < hi), flux, 0.0)
        if f.any():
            out[k] = ag.continuum_xyzs(lam_um, f)
    return out


# ============================================================================================ airglow

def build_airglow(ctx: BuildContext, cie_ids: list[str]) -> tuple[dict, dict]:
    src = {k: d.register(ctx) for k, d in (("palace", PALACE), ("paper", PALACE_PAPER), ("drao", DRAO),
                                           ("swpc", SWPC_PRED), ("wuest", WUEST), ("lednytskyy", LEDNYTSKYY))}
    p = ag.read_palace(PALACE.fetch())
    spectra = ag.class_spectra(p)
    lam = p.lines["lam"] * 1e3
    inten = p.lines["I"].astype(float)
    var = np.array([x.decode() if isinstance(x, bytes) else str(x) for x in p.lines["varID"]])
    cont_ids = {p.cont_meta[f"VARID{i}"]: i for i in range(1, int(p.cont_meta["NCONT"]) + 1)}
    tot = np.sum([c.xyzs_ref for c in spectra.values()], axis=0)
    classes, skipped = [], []
    for cid, c in spectra.items():
        if c.layer_km < 0:
            skipped.append({"id": cid, "reason": "no emission layer (PALACE gives none: hydrogen fluorescence in the "
                                                 "geocorona)", "zenithY": float(c.xyzs_ref[1])})
            continue
        m = var == cid
        by = _xyzs_by_sample_lines(lam[m], inten[m]) if m.any() else np.zeros((len(SAMPLE_NM), 4))
        if cid in cont_ids:
            i = cont_ids[cid]
            by = by + _xyzs_by_sample_cont(p.cont["lam"].astype(float), p.cont[f"fcont{i}"].astype(float))
        if c.total_r > 0:
            by = by / c.total_r
        clim = ag.climatology(p, cid)
        classes.append({
            "id": cid, "chem": c.chem, "name": ag.NAMES.get(cid, ag._oh_name(cid) if cid.startswith("OH") else cid),
            "layerKm": c.layer_km, "referenceR": round(c.total_r, 4), "visibleR": round(c.visible_r, 4),
            "xyzsPerR": [float(v) for v in c.xyzs_per_r],
            "xyzsPerRBySample": [[float(v) for v in row] for row in by],
            "zenithXYZSReference": [float(v) for v in c.xyzs_ref],
            "shareOfZenithY": float(c.xyzs_ref[1] / tot[1]), "shareOfZenithS": float(c.xyzs_ref[3] / tot[3]),
            "brightestVisibleLines": [{"nmAir": a, "R": b} for a, b in c.lines_vis],
            "f0": clim["f0"], "sce": clim["sce"], "sigma": clim["sigma"]})
    heights = sorted({c["layerKm"] for c in classes})
    layers = [{"id": f"h{int(h)}", **ag.layer_profile(h), "classes": [c["id"] for c in classes if c["layerKm"] == h]}
              for h in heights]
    # solar radio flux over the window (+- 13 days for the centred means)
    start, end = _utc_date(ctx.start_et), _utc_date(ctx.end_et)
    daily = ag.read_drao_fluxtable(DRAO.fetch())
    pred = ag.read_swpc_predicted_f107(SWPC_PRED.fetch())
    srf = ag.srf_series(daily, pred, start, end)
    labels = sorted({s["label"] for s in srf["labelSegments"]})
    zen = {c["id"]: c["zenithXYZSReference"][1] for c in classes}
    t = ag.tables()
    model = {
        "kind": "airglowModel", "version": 1,
        "description": "Nightglow of the Earth's upper atmosphere from PALACE v1.0 (Cerro Paranal climatology from 10 "
                       "years of X-shooter spectra) applied to the whole night side (docs/reports/nightglow.md).",
        "units": {"xyzsPerR": "luminance (X, Y, Z cd/m^2; S scotopic cd/m^2) of a column emission rate of 1 rayleigh "
                              "of the class's spectrum, i.e. radiance 1e10/(4 pi) photons m^-2 s^-1 sr^-1 per R",
                  "referenceR": "zenith column emission rate above the atmosphere (R), annual nocturnal mean at 100 sfu",
                  "layers": "Gaussian volume emission rate in altitude above the reference ellipsoid (km)"},
        "classes": classes, "layers": layers, "omitted": skipped,
        "samplesNm": SAMPLE_NM,
        "climatology": {
            "monthCentreDoy": ag.month_centre_doy(p), "ltBinCentresHours": ag.LT_BIN_CENTRES_H,
            "localTime": "local mean solar time at the emission point: UT + east longitude / 15 h (PALACE uses the "
                         "mean solar time at Paranal, 70.4 W)",
            "nightWeight": ag.night_weights(p), "srf0": ag.SRF0,
            "scaling": "I = referenceR * f0[month][lt] * (1 + 0.01 * sce[month][lt] * (srf - srf0)) (PALACE Eq. 1); "
                       "between bin centres (months by day of year, local-time bins) linear interpolation",
            "domain": f"night: solar zenith angle at the ground point under the emission > {ag.NIGHT_MIN_SZA_DEG:g} deg "
                      "(PALACE's nighttime limit, when the Sun is below the horizon up to about 200 km); elsewhere "
                      "the airglow is unknown and not drawn"},
        "solarRadioFlux": sourced(
            srf, "derived" if labels == ["derived"] else "estimated", [src["drao"], src["swpc"]], unit="sfu",
            method="Centred 27-day mean of the daily 10.7 cm flux observed at DRAO Penticton (20 UT measurement), as "
                   "PALACE's climatology uses; days whose window reaches beyond the last observation "
                   f"({srf['lastObservedDay']}) take the NOAA SWPC predicted monthly F10.7 for the missing days "
                   "(label per day in labelSegments: derived = all 27 days observed, estimated = predictions used)."),
        "label": "estimated",
        "sources": [src["palace"], src["paper"], src["wuest"], *cie_ids],
        "method": "Line and continuum intensities, layer heights and the 12 x 12 month x local-time climatology of "
                  "PALACE v1.0 (measured at Cerro Paranal, 24.6 S) applied at every latitude (assumption: no latitude "
                  "dependence, same calendar month in both hemispheres). Spectra integrated against the CIE 1931 and "
                  "1951 observers. Vertical profiles: Gaussian at PALACE's reference heights, FWHM "
                  f"{ag.MESOPAUSE_FWHM_KM:g} km below 150 km (the mean OH layer of Baker & Stair 1988, applied to all "
                  f"mesopause emissions: assumption) and sigma {ag.THERMOSPHERE_SIGMA_KM:g} km for the thermospheric "
                  "O and N lines (PALACE Sect. 4.5).",
        "uncertainty": "PALACE residual variability (sigma tables) 20-50 % for mesopause emissions, up to 100 % for "
                       "the red lines; latitude dependence not modelled (the red lines in particular are enhanced near "
                       "Paranal by the equatorial ionisation anomaly); layer thickness +-36 % (Baker & Stair spread).",
        "limbCheck": t["limbCheck"],
    }
    diag = {"zenithXYZS": tot.tolist(), "zenithYByClass": zen, "srfLabels": labels,
            "limbRatioMesopause": ag.gaussian_column_limb_ratio(6371.0 + 97.0, layers[0]["sigmaKm"])}
    return model, diag


# ============================================================================================ aurora

def _op_models() -> tuple[dict, list[str]]:
    paths, models = [], {}
    for s in na.SEASONS:
        for a in na.ATYPES:
            files = []
            for name in (f"{s}_{a}.txt", f"{s}_{a}_n.txt", f"{s}_prob_b_{a}.txt"):
                d = Download(id=f"op2010-{name}", url=OVATION_BASE + name, subdir=f"{SUB}/ovation_premodel", name=name,
                             title="", citation="")
                files.append(d.fetch())
            paths += files
            models[(s, a)] = na.read_op_files(*files)
    return models, [str(p) for p in paths]


def build_aurora(ctx: BuildContext, cie_ids: list[str]) -> tuple[dict, dict, dict[str, np.ndarray]]:
    t0 = time.time()
    tabs = na.tables()
    src = {k: d.register(ctx) for k, d in (("fang", FANG), ("itikawa", ITIKAWA), ("laher", LAHER),
                                           ("gabrielse", GABRIELSE), ("whiter", WHITER), ("atkinson", ATKINSON),
                                           ("nist", NIST_OI), ("igrf", IGRF), ("us76", US76), ("swpcOvation", SWPC_OVATION))}
    for y, d in OMNI.items():
        src[f"omni{y}"] = d.register(ctx)
    # --- OVATION Prime 2010 coefficients (one source record for the 36 files)
    models, paths = _op_models()
    recs = [record(Path(p)) for p in paths]
    h = hashlib.sha256("".join(r["sha256"] for r in recs).encode()).hexdigest()
    src["op2010"] = ctx.add_source(SourceRecord(
        id="ovation-prime-2010", title="OVATION Prime 2010 auroral precipitation model: seasonal regression coefficients",
        citation=tabs["op2010"]["_source"], url=OVATION_BASE, retrieved=recs[0]["retrieved"], sha256=h,
        version="OP2010 (IDL release coefficients)", license="coefficients: NOAA NCEI release; OvationPyme code LGPL-3.0",
        notes="36 files {season}_{type}.txt, {season}_{type}_n.txt, {season}_prob_b_{type}.txt for winter/spring/summer/"
              "fall and diff/mono/wave; sha256 here is the sha256 of the concatenated per-file sha256s (each file is in "
              "the download ledger)."))
    grids = np.stack([na.op_grid(models, dF) for dF in COUPLING_NODES], axis=0)   # (node, season, q, mlt, mlat)
    ov = np.transpose(grids, (1, 2, 0, 3, 4)).astype(np.float32)                  # (season, q, node, mlt, mlat)
    ov[:, 1] *= 1e-8                                                             # number flux in 1e8 cm^-2 s^-1
    log(f"OVATION grids: {ov.shape}, max energy flux {ov[:, 0].max():.2f} erg cm^-2 s^-1 ({time.time() - t0:.0f} s)")
    mlat_bins, mlt_bins = na.op_mlat_mlt()
    # --- solar wind coupling over the window
    t, by, bz, v, kp = [], [], [], [], []
    for y in sorted(OMNI):
        o = na.read_omni2(OMNI[y].fetch())
        t += o["t"]; by.append(o["by"]); bz.append(o["bz"]); v.append(o["v"]); kp.append(o["kp"])
    by, bz, v, kp = (np.concatenate(a) for a in (by, bz, v, kp))
    ec = na.newell_coupling(by, bz, v)
    dphi = na.op_weighted_coupling(ec)
    t0w = _dt.datetime.combine(_utc_date(ctx.start_et), _dt.time(0), tzinfo=_dt.timezone.utc)
    t1w = _dt.datetime.combine(_utc_date(ctx.end_et), _dt.time(0), tzinfo=_dt.timezone.utc)
    tt = np.array([x.timestamp() for x in t])
    keep = (tt >= t0w.timestamp()) & (tt <= t1w.timestamp())
    first = int(np.flatnonzero(keep)[0])
    vals = dphi[keep]
    last_valid = int(np.flatnonzero(np.isfinite(vals))[-1])
    vals = vals[:last_valid + 1]
    hourly_start = t[first]
    year_ago = np.isfinite(vals) & (tt[keep][:last_valid + 1] >= tt[keep][last_valid] - 365.25 * 86400)
    clim = float(np.median(vals[year_ago]))
    gaps = int(np.sum(~np.isfinite(vals)))
    log(f"coupling: {vals.size} hours from {hourly_start:%Y-%m-%d %H} UT to {t[first + last_valid]:%Y-%m-%d %H} UT, "
        f"{gaps} gaps; median of the last 365 days {clim:.0f} (OP2010 mean {na.DF_AVE:g})")
    # --- magnetic coordinates
    t1 = time.time()
    year = 2000.0 + ((ctx.start_et + ctx.end_et) / 2.0 / 86400.0 + 0.5) / 365.25
    g, hh, nmax = na.read_igrf(IGRF.fetch(), year)
    lat = np.arange(-89.5, 90.0, 1.0)
    lon = np.arange(-179.5, 180.0, 1.0)
    mlat, mlon = na.aacgm_grid(g, hh, nmax, lat, lon, alt_km=MAG_ALT_KM)
    mag = np.stack([mlat, np.cos(np.radians(mlon)), np.sin(np.radians(mlon))], axis=-1).astype(np.float32)
    ax = na.dipole_axis(g, hh)
    D = na.dipole_frame(g, hh)
    log(f"magnetic grid {mag.shape} at {MAG_ALT_KM:g} km, epoch {year:.2f} ({time.time() - t1:.0f} s); dipole pole "
        f"{np.degrees(np.arcsin(ax[2])):.2f} N {np.degrees(np.arctan2(ax[1], ax[0])):.2f} E")
    # --- emission model
    z = np.array(AURORA_ALT_KM)
    et = na.emission_table(np.array(ENERGY_NODES_KEV), z)
    lines = {
        "N2p4278": [(wl, rel) for wl, rel in na.n2plus_bands()],
        "OI5577": None, "OI6300": None}
    o1d = tabs["o1d"]
    line_xyzs = {
        "N2p4278": sum(rel * ag.line_xyzs(np.array([wl]), np.array([1.0])) for wl, rel in lines["N2p4278"]),
        "OI5577": ag.line_xyzs_air(tabs["oi5577"]["line_air_nm"], 1.0),
        "OI6300": ag.line_xyzs_air(o1d["lines_air_nm"]["630"], 1.0) + ag.line_xyzs_air(o1d["lines_air_nm"]["636"],
                                                                                   o1d["A636_s"] / o1d["A630_s"]),
    }
    emis = np.zeros((len(ENERGY_NODES_KEV), z.size, 4))
    for k in ("N2p4278", "OI5577", "OI6300"):
        emis += (et.column_r_per_erg[k][:, None, None] * et.profile_per_km[k][:, :, None]) * line_xyzs[k][None, None, :]
    whiter = tabs["whiter2023"]["meanPeakKm"]
    diag = {"peaks": {k: v.tolist() for k, v in et.peak_km.items()}, "columns": {k: v.tolist() for k, v in et.column_r_per_erg.items()},
            "whiter": whiter, "coupling": {"median": clim, "hours": int(vals.size), "gaps": gaps}}
    lab_src = [src["fang"], src["itikawa"], src["laher"], src["gabrielse"], src["atkinson"], src["nist"], src["us76"], *cie_ids]
    model = {
        "kind": "auroraModel", "version": 1,
        "description": "Electron aurora from OVATION Prime 2010 precipitation, placed with IGRF-14 magnetic coordinates "
                       "and turned into light with a Maxwellian energy-deposition model (docs/reports/nightglow.md).",
        "ovation": sourced({
            "file": f"{DIR}/aurora-ovation.bin", "dtype": "float32", "layout": "[season][quantity][couplingNode][mlt][mlat]",
            "seasons": list(na.SEASONS), "quantities": ["energyFlux erg cm^-2 s^-1", "numberFlux 1e8 cm^-2 s^-1"],
            "couplingNodes": COUPLING_NODES, "mlatDeg": [float(x) for x in mlat_bins], "mltHours": [float(x) for x in mlt_bins],
            "seasonWeights": "OP2010: doy in [79,171): summer = 1-(171-doy)/92, spring = 1-summer; [171,263): fall = "
                             "1-(263-doy)/92, summer = 1-fall; [263,354): winter = 1-(354-doy)/91, fall = 1-winter; "
                             "else (doy-365 if doy >= 354): spring = 1-(79-doy)/90, winter = 1-spring. Northern hemisphere "
                             "doy, southern 365 - doy (the grids are the two hemispheres averaged).",
            "types": "diffuse + monoenergetic + broadband electrons (ions not included)"},
            "estimated", [src["op2010"]],
            method="OVATION Prime 2010 evaluated as its IDL code does (regression b1 + b2 dPhi/dt times the type "
                   "probability, the code's caps on extreme bins, the northern dawn-wedge interpolation, hemispheres "
                   "averaged) at each coupling node; linear interpolation between nodes and in season weight is exact "
                   "for the regressions and approximate for the probability (piecewise in dPhi/dt bins of 276)."),
        "coupling": sourced({
            "unit": "Newell dPhi_MP/dt, (km/s)^(4/3) nT^(2/3), OP2010 4-hour weighted",
            "hourlyStart": hourly_start.isoformat().replace("+00:00", "Z"), "stepHours": 1,
            "values": [None if not np.isfinite(x) else round(float(x), 1) for x in vals],
            "measuredUntil": t[first + last_valid].isoformat().replace("+00:00", "Z"),
            "climatology": {"value": round(clim, 1), "label": "estimated",
                            "method": "median of the measured hourly series over the 365 days before measuredUntil; used "
                                      "at Best estimate for times without measured solar wind (and for gaps)"}},
            "derived", [src[f"omni{y}"] for y in sorted(OMNI)],
            method="Newell et al. (2007) coupling from hourly OMNI 2 By, Bz (GSM) and flow speed (bow-shock-shifted "
                   "measurements), then the OP2010 average of the 4 preceding hours with weights 1, 0.65, 0.65^2, "
                   "0.65^3 (at least 2 hours measured). Value k applies at hourlyStart + k hours."),
        "magneticCoordinates": sourced({
            "file": f"{DIR}/aurora-magnetic.bin", "dtype": "float32", "layout": "[lat 180][lon 360][mlat deg, cos mlon, sin mlon]",
            "latDeg": [-89.5, 1.0, 180], "lonDeg": [-179.5, 1.0, 360], "altitudeKm": MAG_ALT_KM, "epochYear": round(year, 3),
            "dipoleFrameRows": D.tolist(),
            "mlt": "MLT = 12 + (mlon - lon_d(Sun)) / 15 h, lon_d(Sun) = longitude of the Sun's direction in the dipole "
                   "frame (dipoleFrameRows: x, y, z axes in Earth-fixed coordinates)",
            "undefined": "NaN where |lat| < 20 deg or the field line closes below the reference radius"},
            "derived", [src["igrf"]],
            method="IGRF-14 at the window's mid-epoch; field lines traced (RK4, step 2 % of r) from 110 km to the centred "
                   "dipole's equatorial plane, or beyond 5 R_E continued as dipole lines; AACGM latitude = "
                   "acos(sqrt(6371.2 km / r_apex)) (Baker & Wing 1989), longitude = dipole longitude of the apex. "
                   "Spherical Earth of radius 6371.2 km for the start points; the aurora is placed in vertical columns "
                   "above these 110 km points (field-line tilt neglected)."),
        "emission": sourced({
            "file": f"{DIR}/aurora-emission.bin", "dtype": "float32", "layout": "[energyNode][altitude][X, Y, Z, S]",
            "unit": "cd/m^2 (X, Y, Z), scotopic cd/m^2 (S) per km of path per (erg cm^-2 s^-1) of energy flux",
            "averageEnergyNodesKeV": ENERGY_NODES_KEV, "altitudesKm": AURORA_ALT_KM,
            "lines": {k: {"columnRPerErg": [round(float(x), 3) for x in et.column_r_per_erg[k]],
                          "peakKm": [float(x) for x in et.peak_km[k]],
                          "xyzsPerR": [float(x) for x in line_xyzs[k]]} for k in line_xyzs},
            "n2plusBands": [{"nmVac": round(wl, 3), "photonsRelative4278": round(rel, 5)} for wl, rel in lines["N2p4278"]],
            "checks": {"whiter2023MeanPeakKm": whiter}},
            "estimated", lab_src,
            method="Maxwellian electrons with characteristic energy E0 = <E>/2 and unit energy flux: ionisation rate of "
                   "Fang et al. (2008) in the US Standard Atmosphere 1976 (35 eV per ion pair). N2+ 1N (0,v'') bands: N2 "
                   "share of ionisation (equal cross sections per particle, assumption) x Q_emis(391.4)/Q_ion(N2) "
                   "(Itikawa 2006) x A(0,v'')/A(0,0) (Gilmore et al. 1992). 557.7 and 630.0 nm columns: B3C ratios to "
                   "427.8 nm for Maxwellian precipitation at fO = 1 (Gabrielse et al. 2021 Fig. 2B), held at the end "
                   "values outside 0.104-9.81 keV; 636.4 nm = 630.0 nm x A(636.4)/A(630.0). Profiles: blue and green "
                   "follow the N2 ionisation; red the ionisation times the O(1D) survival A/(A + k_N2[N2] + k_O2[O2]).",
            uncertainty="Order of 30-50 % in absolute brightness (cross-section ratio at 100 eV applied to all secondaries, "
                        "standard atmosphere, ratio curves read from a figure); red line within a factor 2 (O quenching and "
                        "the O(1D) sources are not modelled explicitly)."),
        "label": "estimated",
        "nowcastCheck": {"source": src["swpcOvation"], "use": "comparison only (report)"},
    }
    bins = {"ovation": ov, "magnetic": mag, "emission": emis.astype(np.float32)}
    return model, diag, bins


def run(ctx: BuildContext) -> None:
    t0 = time.time()
    cie_ids = cie.register_sources(ctx)
    us76_upper.profile(np.array([100.0]))      # fail early if the port breaks
    air, adiag = build_airglow(ctx, cie_ids)
    write_json(ctx, f"{DIR}/airglow.json", air, STAGE)
    log(f"airglow: {len(air['classes'])} classes on {len(air['layers'])} layers; zenith Y at reference "
        f"{adiag['zenithXYZS'][1]:.3e} cd/m^2; srf labels {adiag['srfLabels']}")
    aur, bdiag, bins = build_aurora(ctx, cie_ids)
    write_bin(ctx, f"{DIR}/aurora-ovation.bin", bins["ovation"], STAGE)
    write_bin(ctx, f"{DIR}/aurora-magnetic.bin", bins["magnetic"], STAGE)
    write_bin(ctx, f"{DIR}/aurora-emission.bin", bins["emission"], STAGE)
    write_json(ctx, f"{DIR}/aurora.json", aur, STAGE)
    log(f"aurora: peaks at <E> nodes (km) 427.8 {bdiag['peaks']['N2p4278'][::5]}, measured mean (Whiter 2023) "
        f"{bdiag['whiter']}; done in {time.time() - t0:.0f} s")
