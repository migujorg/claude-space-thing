"""Loaders for the non-Gaia star datasets: Hipparcos (1997 and 2007), Pulkovo and CALSPEC spectrophotometry,
IAU star names, and the Bayer/Flamsteed cross index. Every file comes through `download.fetch`.

Fixed-width CDS tables are parsed from the byte positions in each catalogue's ReadMe (quoted in comments).
"""

from __future__ import annotations

import gzip
import html
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .download import fetch

CDS = "https://cdsarc.cds.unistra.fr/ftp/"
SUB = "stars"


def _col(lines: list[str], a: int, b: int, kind: str = "f"):
    """Bytes a..b (1-based, inclusive, as in CDS ReadMe files) of each line; blanks -> NaN / '' / 0."""
    vals = [ln[a - 1:b].strip() for ln in lines]
    if kind == "s":
        return np.array(vals, dtype=object)
    if kind == "i":
        return np.array([int(v) if v else 0 for v in vals], dtype=np.int64)
    return np.array([float(v) if v else np.nan for v in vals], dtype=np.float64)


def _read_lines(path: Path) -> list[str]:
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    return raw.decode("latin-1").splitlines()


# ------------------------------------------------------------------------------- Hipparcos 2007 (I/311)

@dataclass
class Hip2:
    hip: np.ndarray
    sn: np.ndarray          # solution type (new reduction)
    ra: np.ndarray          # deg, ICRS, epoch 1991.25
    dec: np.ndarray
    plx: np.ndarray         # mas
    pmra: np.ndarray        # mas/yr (mu_alpha*)
    pmdec: np.ndarray
    e_ra: np.ndarray        # mas
    e_dec: np.ndarray
    e_plx: np.ndarray
    e_pmra: np.ndarray
    e_pmdec: np.ndarray
    hpmag: np.ndarray
    bv: np.ndarray
    path: Path
    readme: Path

    EPOCH = 1991.25


def load_hip2() -> Hip2:
    readme = fetch(CDS + "I/311/ReadMe", f"{SUB}/hipparcos2007", "ReadMe")
    p = fetch(CDS + "I/311/hip2.dat.gz", f"{SUB}/hipparcos2007")
    L = _read_lines(p)
    # I/311 ReadMe, hip2.dat: HIP 1-6, Sn 8-10, RArad 16-28, DErad 30-42, Plx 44-50, pmRA 52-59, pmDE 61-68,
    # e_RArad 70-75, e_DErad 77-82, e_Plx 84-89, e_pmRA 91-96, e_pmDE 98-103, Hpmag 130-136, B-V 153-158
    return Hip2(
        hip=_col(L, 1, 6, "i"), sn=_col(L, 8, 10, "i"),
        ra=np.degrees(_col(L, 16, 28)), dec=np.degrees(_col(L, 30, 42)),
        plx=_col(L, 44, 50), pmra=_col(L, 52, 59), pmdec=_col(L, 61, 68),
        e_ra=_col(L, 70, 75), e_dec=_col(L, 77, 82), e_plx=_col(L, 84, 89),
        e_pmra=_col(L, 91, 96), e_pmdec=_col(L, 98, 103),
        hpmag=_col(L, 130, 136), bv=_col(L, 153, 158), path=p, readme=readme)


# ------------------------------------------------------------------------------- Hipparcos 1997 (I/239)

@dataclass
class HipMain:
    hip: np.ndarray
    vmag: np.ndarray        # Johnson V
    varflag: np.ndarray     # 0 none, 1..3 coarse variability flag
    r_vmag: np.ndarray      # G ground-based, H from Hp, T from Tycho
    bv: np.ndarray          # Johnson B-V
    vi: np.ndarray          # Cousins V-I
    r_bv: np.ndarray
    bt: np.ndarray
    vt: np.ndarray
    hpmag: np.ndarray
    ccdm: np.ndarray
    ncomp: np.ndarray
    multflag: np.ndarray
    rho: np.ndarray         # arcsec, separation between the components of a multiple entry
    dhp: np.ndarray         # mag, Hp difference between those components
    hd: np.ndarray
    sptype: np.ndarray
    combmag: np.ndarray     # '*' when Vmag, B-V refer to the combined light of a multiple entry
    path: Path
    readme: Path


def load_hip_main() -> HipMain:
    readme = fetch(CDS + "I/239/ReadMe", f"{SUB}/hipparcos1997", "ReadMe")
    p = fetch(CDS + "I/239/hip_main.dat", f"{SUB}/hipparcos1997")
    L = [ln for ln in _read_lines(p) if ln.startswith("H|")]
    # I/239 ReadMe, hip_main.dat: HIP 9-14, Vmag 42-46, VarFlag 48, r_Vmag 50, BTmag 218-223, VTmag 231-236,
    # B-V 246-251, r_B-V 259, V-I 261-264, CombMag 273, Hpmag 275-281, CCDM 328-337, Ncomp 344-345, MultFlag 347,
    # rho 360-366, dHp 374-378, HD 391-396, SpType 436-447
    return HipMain(
        hip=_col(L, 9, 14, "i"), vmag=_col(L, 42, 46), varflag=_col(L, 48, 48, "i"), r_vmag=_col(L, 50, 50, "s"),
        bt=_col(L, 218, 223), vt=_col(L, 231, 236), bv=_col(L, 246, 251), r_bv=_col(L, 259, 259, "s"), vi=_col(L, 261, 264),
        combmag=_col(L, 273, 273, "s"), hpmag=_col(L, 275, 281), ccdm=_col(L, 328, 337, "s"),
        ncomp=_col(L, 344, 345, "i"), multflag=_col(L, 347, 347, "s"), rho=_col(L, 360, 366), dhp=_col(L, 374, 378),
        hd=_col(L, 391, 396, "i"), sptype=_col(L, 436, 447, "s"), path=p, readme=readme)


# --------------------------------------------------------------------- Pulkovo spectrophotometry (III/201)

@dataclass
class Pulkovo:
    hr: np.ndarray
    hd: np.ndarray          # leading HD number of the (possibly combined) entry
    hd_str: np.ndarray
    name: np.ndarray
    vmag: np.ndarray        # V from the Bright Star Catalogue (as listed by the catalogue)
    bv: np.ndarray
    sptype: np.ndarray
    combined: np.ndarray    # True for entries that are the combined light of two HR stars ("2890/1")
    wl: np.ndarray          # nm
    flux: np.ndarray        # (n, len(wl)) W m^-2 nm^-1, NaN where absent
    paths: list[Path]


def load_pulkovo() -> Pulkovo:
    """Stars with the combined 320-1080 nm spectrophotometry (table5.dat)."""
    readme = fetch(CDS + "III/201/ReadMe", f"{SUB}/pulkovo", "ReadMe")
    ps = fetch(CDS + "III/201/stars.dat", f"{SUB}/pulkovo")
    pt = fetch(CDS + "III/201/table5.dat", f"{SUB}/pulkovo")
    # table5.dat: blocks introduced by a line of HR numbers (up to 7), then rows "wavelength f1 .. f7" in nm and
    # W m^-2 m^-1 (= 1e-9 W m^-2 nm^-1) (III/201 ReadMe, "Note on table5.dat").
    # Block headers name stars by HR number, with combined entries written like "2890/1" (HR 2890 + 2891).
    spectra: dict[str, dict[float, float]] = {}
    cur: list[str] = []
    for ln in _read_lines(pt):
        if not ln.strip():
            continue
        parts = ln.split()
        if "." not in parts[0]:
            cur = parts
            for h in cur:
                spectra.setdefault(h, {})
            continue
        wl = float(parts[0])
        for h, v in zip(cur, parts[1:]):
            if v != ".":  # "." marks a missing sample
                spectra[h][wl] = float(v) * 1e-9
    L = _read_lines(ps)
    # stars.dat: HR 1-4, m_HR 5-6, HD 8-16, Name 17-27, SpType 55-67, Vmag 69-72, B-V 74-78, table 79
    keys = [(ln[0:4].strip() + ln[4:6].strip()) for ln in L]
    keep = np.array([k in spectra for k in keys])
    L = [ln for ln, k in zip(L, keep) if k]
    keys = [k for k, kk in zip(keys, keep) if kk]
    hr = _col(L, 1, 4, "i")
    combined = np.array(["/" in k for k in keys])
    hd_str = _col(L, 8, 16, "s")
    hd = np.array([int(re.match(r"\d+", s).group()) if re.match(r"\d+", s) else 0 for s in hd_str])
    wls = np.array(sorted({w for s in spectra.values() for w in s}))
    flux = np.full((len(hr), wls.size), np.nan)
    for i, h in enumerate(keys):
        for j, w in enumerate(wls):
            v = spectra[h].get(w)
            if v is not None and v > 0:
                flux[i, j] = v
    # Negative V (Sirius, Canopus, Arcturus) is written with its '-' sign in byte 65, inside the SpType field.
    vmag = _col(L, 69, 72) * np.array([-1.0 if len(ln) > 64 and ln[64] == "-" else 1.0 for ln in L])
    sptype = np.array([ln[54:64].strip() for ln in L], dtype=object)
    return Pulkovo(hr=hr, hd=hd, hd_str=hd_str, name=_col(L, 17, 27, "s"), vmag=vmag, bv=_col(L, 74, 78),
                   sptype=sptype, combined=combined, wl=wls, flux=flux, paths=[readme, ps, pt])


# --------------------------------------------------------- Sternberg spectrophotometry (III/208 + III/207)

@dataclass
class Sternberg:
    hr: np.ndarray          # HR as written ("0361/2" for a combined entry)
    combined: np.ndarray
    hd: np.ndarray
    name: np.ndarray
    vmag: np.ndarray        # V as listed by III/208
    wl: np.ndarray          # nm, 322.5-1082.5 in 5 nm steps (air, ground-based)
    flux: np.ndarray        # (n, len(wl)) W m^-2 nm^-1, spliced; NaN where absent
    blue: np.ndarray        # (n, 89) III/208 fluxes 322.5-762.5 nm, NaN = zero/absent
    red: np.ndarray         # (n, 98) III/207 fluxes 597.5-1082.5 nm (NaN if the star is not in III/207)
    overlap_ratio: np.ndarray   # median III/207 / III/208 in the overlap (NaN without III/207)
    overlap_rms: np.ndarray     # rms of that ratio about its median
    paths: list[Path]


def _sternberg_table(cat: str, n_e: int) -> tuple[list[str], np.ndarray, Path]:
    """catalog.dat of III/208 or III/207: fixed-width lines and the E columns (bytes 89.., 8 characters each,
    erg cm^-2 s^-1 cm^-1 -> x 1e-10 W m^-2 nm^-1; zero flux written with exponent E-12 / as 0.E+00 = absent)."""
    p = fetch(CDS + f"{cat}/catalog.dat.gz", f"{SUB}/sternberg", f"{cat.replace('/', '_')}_catalog.dat.gz")
    L = [ln for ln in _read_lines(p) if ln.strip()]
    return L, parse_sternberg_fluxes(L, n_e), p


def parse_sternberg_fluxes(L: list[str], n_e: int) -> np.ndarray:
    e = np.full((len(L), n_e), np.nan)
    for i, ln in enumerate(L):
        for j in range(n_e):
            s = ln[88 + 8 * j:96 + 8 * j].strip()
            if s:
                v = float(s)
                if v > 1e-9:        # "zero flux is expressed as E-12" (III/208), 0.E+00 (III/207)
                    e[i, j] = v * 1e-10
    return e


def load_sternberg() -> Sternberg:
    """III/208 (866 stars, 322.5-762.5 nm) joined with III/207 (223 stars, 597.5-1082.5 nm) by HR number.

    Byte positions (both ReadMe files): HR 7-12, HD 13-20, Name 22-30, Vmag 50-53, E 89- (8 chars per value, 50 A
    steps). Where a star is in both, the spectrum is III/208 below 597.5 nm, the mean of both in the overlap and
    III/207 above it; the overlap ratio is kept so the caller can refuse inconsistent pairs.
    """
    paths = [fetch(CDS + f"{c}/ReadMe", f"{SUB}/sternberg", f"{c.replace('/', '_')}_ReadMe") for c in ("III/208", "III/207")]
    Lb, eb, pb = _sternberg_table("III/208", 89)
    Lr, er, pr = _sternberg_table("III/207", 98)
    paths += [pb, pr]
    wb = 322.5 + 5.0 * np.arange(89)
    wr = 597.5 + 5.0 * np.arange(98)
    wl = 322.5 + 5.0 * np.arange(153)             # 322.5 .. 1082.5
    hr_b = _col(Lb, 7, 12, "s")      # "0361/2" = combined light of HR 361 and 362
    hr_r = _col(Lr, 7, 12, "s")
    rmap = {h: i for i, h in enumerate(hr_r) if h}
    n = len(Lb)
    red = np.full((n, 98), np.nan)
    flux = np.full((n, wl.size), np.nan)
    ratio = np.full(n, np.nan)
    rms = np.full(n, np.nan)
    ov_b = slice(55, 89)                            # 597.5 .. 762.5 in III/208
    ov_r = slice(0, 34)                             # the same wavelengths in III/207
    for i in range(n):
        flux[i, :89] = eb[i]
        j = rmap.get(hr_b[i], -1) if hr_b[i] else -1
        if j < 0:
            continue
        red[i] = er[j]
        q = er[j, ov_r] / eb[i, ov_b]
        q = q[np.isfinite(q)]
        if q.size:
            ratio[i] = np.median(q)
            rms[i] = float(np.sqrt(np.mean((q / ratio[i] - 1) ** 2)))
        both = np.nanmean(np.stack([eb[i, ov_b], er[j, ov_r]]), axis=0)
        flux[i, 55:89] = both
        flux[i, 89:] = er[j, 34:]
    hd_s = _col(Lb, 13, 20, "s")
    hd = np.array([int(re.match(r"\d+", s).group()) if re.match(r"\d+", s) else 0 for s in hd_s])
    return Sternberg(hr=hr_b, combined=np.array(["/" in h for h in hr_b]), hd=hd, name=_col(Lb, 22, 30, "s"),
                     vmag=_col(Lb, 50, 53), wl=wl, flux=flux, blue=eb, red=red, overlap_ratio=ratio,
                     overlap_rms=rms, paths=paths)


# ------------------------------------------------------------------------------------- CALSPEC (HST)

CALSPEC_PAGE = ("https://www.stsci.edu/hst/instrumentation/reference-data-for-calibration-and-tools/"
                "astronomical-catalogs/calspec")
CALSPEC_DIR = "https://archive.stsci.edu/hlsps/reference-atlases/cdbs/current_calspec/"


@dataclass
class CalspecStar:
    name: str
    vmag: float
    file: str
    path: Path
    wl: np.ndarray          # nm (vacuum)
    flux: np.ndarray        # W m^-2 nm^-1
    measured: np.ndarray    # bool: sample is an observation (not a model segment)
    hip: int
    gaia: int
    sesame: Path


def load_calspec(v_max: float) -> tuple[list[CalspecStar], Path]:
    """CALSPEC stars brighter than v_max with an observed (STIS) spectrum, resolved to HIP / Gaia DR3 ids."""
    from astropy.io import fits
    page = fetch(CALSPEC_PAGE, f"{SUB}/calspec", "calspec.html")
    t = page.read_text(errors="replace")
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if len(cells) < 7:
            continue
        try:
            v = float(cells[2])
        except ValueError:
            continue
        stis = cells[6].rstrip("*").strip()
        if v > v_max or "stis" not in stis or cells[4] in ("sun", "sun_reference"):
            continue
        fname = f"{cells[4]}{stis}.fits"
        fp = fetch(CALSPEC_DIR + fname, f"{SUB}/calspec")
        with fits.open(fp) as h:
            d = h[1].data
            wl = np.asarray(d["WAVELENGTH"], dtype=np.float64) / 10.0          # Angstrom -> nm
            fl = np.asarray(d["FLUX"], dtype=np.float64) * 1e-2                 # erg s^-1 cm^-2 A^-1 -> W m^-2 nm^-1
            measured = np.asarray(d["TOTEXP"]) > 0
        hip, gaia, sp = _sesame_ids(cells[0], cells[4])
        out.append(CalspecStar(name=cells[0], vmag=v, file=fname, path=fp, wl=wl, flux=fl, measured=measured,
                               hip=hip, gaia=gaia, sesame=sp))
    return out, page


def _sesame_ids(name: str, prefix: str) -> tuple[int, int, Path]:
    """Resolve a CALSPEC star with CDS Sesame (SIMBAD); return (HIP, Gaia DR3 source_id), 0 when absent.

    The page's star-name cell sometimes has footnote digits glued on ('HD11198011'), so HD/BD stars are named
    from the unambiguous file prefix ('hd111980' -> 'HD 111980', 'bd02d3375' / 'bd_17d4708' -> 'BD+02 3375').
    Other names are sent as written; if that finds nothing, again with SIMBAD's '* ' star prefix ('MU COL').
    """
    import urllib.parse
    m_hd = re.match(r"^hd0*(\d+)$", prefix)
    m_bd = re.match(r"^bd_?(\d+)d(\d+)$", prefix)
    if m_hd:
        tries = [f"HD {m_hd.group(1)}"]
    elif m_bd:
        tries = [f"BD+{m_bd.group(1)} {m_bd.group(2)}"]
    else:
        tries = [name, "* " + name]
    for q in tries:
        safe = re.sub(r"[^A-Za-z0-9]+", "_", q.replace("* ", "star ")).strip("_")
        p = fetch("https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/S?" + urllib.parse.quote(q), f"{SUB}/sesame",
                  f"{safe}.txt")
        txt = p.read_text(errors="replace")
        hip = re.search(r"^%I HIP (\d+)", txt, re.M)
        gaia = re.search(r"^%I Gaia DR3 (\d+)", txt, re.M)
        if hip or gaia:
            break
    return (int(hip.group(1)) if hip else 0), (int(gaia.group(1)) if gaia else 0), p


# ------------------------------------------------------------------------------------------ names

@dataclass
class IauName:
    name: str
    designation: str
    bayer_ascii: str
    bayer: str
    con: str
    component: str
    hip: int
    hd: int
    vmag: float
    date: str


def load_iau_csn() -> tuple[list[IauName], Path]:
    p = fetch("https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt", f"{SUB}/names", "IAU-CSN.txt")
    out = []
    for ln in p.read_text(encoding="utf-8").splitlines():
        if not ln.strip() or ln[0] in "#$":
            continue
        # Columns (file header): Name/ASCII 0-17, Name/Diacritics 18-35, Designation 36-48, ID 49-54,
        # ID(Greek) 55-60, Con 61-64, # (component, may be blank) 65-69 -- fixed width in characters; then
        # whitespace-separated WDS_J, mag, bnd, HIP, HD, RA, Dec, Date, [Notes].
        f = [ln[0:18], ln[18:36], ln[36:49], ln[49:55], ln[55:61], ln[61:65], ln[65:70]]
        f = [x.strip() for x in f]
        rest = ln[70:].split()
        if len(rest) < 8:
            raise ValueError(f"unparsed IAU-CSN line: {ln!r}")
        wds, mag, bnd, hip, hd, ra, dec, date = rest[:8]
        out.append(IauName(name=f[1], designation=f[2], bayer_ascii=f[3], bayer=f[4], con=f[5],
                           component=f[6] if f[6] != "_" else "", hip=int(hip) if hip != "_" else 0,
                           hd=int(hd) if hd != "_" else 0, vmag=float(mag) if mag != "_" else np.nan, date=date))
    return out, p


@dataclass
class CrossIndex:
    hip: np.ndarray
    hd: np.ndarray
    hr: np.ndarray
    fl: np.ndarray          # Flamsteed number, 0 if none
    bayer: np.ndarray       # e.g. 'alf', 'bet', 'mu.1' style as in the catalogue
    cst: np.ndarray
    paths: list[Path]


def load_cross_index() -> CrossIndex:
    """Kostjuk (2002) HD-DM-GC-HR-HIP-Bayer-Flamsteed Cross Index (IV/27A), catalog + addendum."""
    readme = fetch(CDS + "IV/27A/ReadMe", f"{SUB}/names/iv27a", "ReadMe")
    paths = [readme]
    L = []
    for f in ("catalog.dat", "addendum.dat"):
        p = fetch(CDS + "IV/27A/" + f, f"{SUB}/names/iv27a")
        paths.append(p)
        L += [ln for ln in _read_lines(p) if ln.strip()]
    # IV/27A ReadMe, catalog.dat: HD 1-6, HR 27-30, HIP 32-37, Fl 65-67, Bayer 69-73, Cst 75-77
    return CrossIndex(hd=_col(L, 1, 6, "i"), hr=_col(L, 27, 30, "i"), hip=_col(L, 32, 37, "i"),
                      fl=_col(L, 65, 67, "i"), bayer=_col(L, 69, 73, "s"), cst=_col(L, 75, 77, "s"), paths=paths)
