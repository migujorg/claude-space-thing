"""Downloads and SourceRecords of the synthetic stage (the COMPLETE reality level, NORTH_STAR 3.3).

Datasets (parsed): the NEO model realization (Granvik et al. 2018), the Kuiper-belt model realization (CFEPS L7), the
MPC elements and H of the known irregular moons, and the Centaur model members of the Kurlander et al. (2025) archive.
Papers (numbers transcribed into syn_tables/populations.json, PDFs kept with their sha256 so the transcription can be
checked): the completeness method (Hendler & Malhotra 2020) and the debiased size-frequency slopes below
completeness (Maeda et al. 2021; Yoshida & Terai 2017; Terai & Yoshida 2018; Heinze et al. 2019 as a cross-check),
the mean CFEPS colour (Petit et al. 2011) and the g -> V transformation (Jester et al. 2005); the irregular-moon
populations and completeness (Ashton et al. 2020, 2021, 2025; Sheppard et al. 2005, 2006, 2024); the Centaur
population (Kurlander et al. 2025; Murtagh et al. 2025; Nesvorny et al. 2019).
"""

from __future__ import annotations

import gzip
import json
import pickle
import re
import zipfile
from pathlib import Path

import numpy as np

from .photometry.common import Download
from .schema import BuildContext

TABLES = Path(__file__).parent / "syn_tables"
SUBDIR = "synthetic"
_ARXIV = "arXiv.org e-print (author manuscript); the published version is cited."

GRANVIK_BASE = "https://www.mv.helsinki.fi/home/mgranvik/data/Granvik+_2018_Icarus/"
GRANVIK = Download(
    id="granvik-2018-neo-model",
    url=GRANVIK_BASE + "Granvik+_2018_Icarus.dat.gz", subdir=SUBDIR, name="Granvik+_2018_Icarus.dat.gz",
    title="Granvik et al. (2018) NEO model: one realization of the debiased orbit and absolute-magnitude distribution "
          "(802,000 NEOs, 17 < H < 25)",
    citation="Granvik, M., Morbidelli, A., Jedicke, R., Bolin, B., Bottke, W. F., Beshore, E., Vokrouhlicky, D., "
             "Nesvorny, D. & Michel, P. (2018). Debiased orbit and absolute-magnitude distributions for near-Earth "
             "objects. Icarus 312, 181-207. DOI:10.1016/j.icarus.2018.04.018. Data file Granvik+_2018_Icarus.dat.gz "
             "(README version 1.1, 2025-05-13).",
    version="realization of 2019-03-29 (README v1.1)", license="Published with the article; cite Granvik et al. (2018)",
    notes="Columns (README): a [au], e, i [deg], node [deg], argument of perihelion [deg], mean anomaly [deg], H. The "
          "model constrains (a, e, i, H); the angles of the realization are used as given.",
)
GRANVIK_README = Download(
    id="granvik-2018-neo-model-readme", url=GRANVIK_BASE + "Granvik+_2018_Icarus.readme", subdir=SUBDIR,
    name="Granvik+_2018_Icarus.readme", title="README of the Granvik et al. (2018) NEO model realization",
    citation=GRANVIK.citation, version="1.1",
)
L7 = Download(
    id="cfeps-l7-synthetic-model",
    url="https://www.cfeps.net/L7Release/L7SyntheticModel-v09.txt.gz", subdir=SUBDIR,
    name="L7SyntheticModel-v09.txt.gz",
    title="CFEPS L7 synthetic model v0.9: debiased Kuiper-belt orbit and H_g distribution (classical and resonant "
          "populations, H_g <= 8.5)",
    citation="Petit, J.-M., Kavelaars, J. J., Gladman, B. J. et al. (2011). The Canada-France Ecliptic Plane Survey - "
             "Full data release: the orbital structure of the Kuiper belt. Astronomical Journal 142, 131. "
             "DOI:10.1088/0004-6256/142/4/131; Gladman, B., Lawler, S. M., Petit, J.-M. et al. (2012). The resonant "
             "trans-Neptunian populations. Astronomical Journal 144, 23. DOI:10.1088/0004-6256/144/1/23; Kavelaars, "
             "J. J., Jones, R. L., Gladman, B. J. et al. (2009). The Canada-France Ecliptic Plane Survey - L3 data "
             "release: the orbital structure of the Kuiper belt. Astronomical Journal 137, 4917. "
             "DOI:10.1088/0004-6256/137/6/4917. Model file from https://www.cfeps.net/?page_id=105.",
    version="v0.9", license="BSD-style (copyright 2007 J.M. Petit, J.J. Kavelaars and B.J. Gladman; header of the file)",
    notes="Header: epoch of elements JD 2453157.5, longitude of Neptune lambdaN = 5.489 (radians; checked against "
          "DE442s by the stage). Columns: a [au], e, i, node, peri, M [deg], H_g, then distance [au], component, "
          "sub-component and a flag. The page lists caveats (q > 100 au components absent; hot main classical belt "
          "not tuned to avoid nu8).",
)

_P = "papers"
HENDLER_MALHOTRA = Download(
    id="hendler-malhotra-2020", url="https://arxiv.org/pdf/2010.07822v1", subdir=_P, name="arXiv-2010.07822v1.pdf",
    title="Hendler & Malhotra (2020): observational completion limit H_lim(a) of minor planets",
    citation="Hendler, N. P. & Malhotra, R. (2020). Observational completion limit of minor planets from the asteroid "
             "belt to Jupiter Trojans. Planetary Science Journal 1, 75. DOI:10.3847/PSJ/abbe25 (arXiv:2010.07822).",
    notes=_ARXIV)
MAEDA = Download(
    id="maeda-2021-hsc", url="https://arxiv.org/pdf/2110.00178v1", subdir=_P, name="arXiv-2110.00178v1.pdf",
    title="Maeda et al. (2021): debiased absolute-magnitude distribution of small main-belt asteroids (Subaru/HSC)",
    citation="Maeda, N., Terai, T., Ohtsuki, K., Yoshida, F., Ishihara, K. & Deyama, T. (2021). Size distributions of "
             "bluish and reddish small main-belt asteroids obtained by Subaru/Hyper Suprime-Cam. Astronomical Journal "
             "162, 280. DOI:10.3847/1538-3881/ac2c6e (arXiv:2110.00178).", notes=_ARXIV)
HEINZE = Download(
    id="heinze-2019-decam", url="https://arxiv.org/pdf/1910.13015v1", subdir=_P, name="arXiv-1910.13015v1.pdf",
    title="Heinze et al. (2019): apparent-magnitude distribution of main-belt asteroids to R = 25.6 (DECam)",
    citation="Heinze, A. N., Trollo, J. & Metchev, S. (2019). The flux distribution and sky density of 25th magnitude "
             "main belt asteroids. Astronomical Journal 158, 232. DOI:10.3847/1538-3881/ab48fa (arXiv:1910.13015).",
    notes=_ARXIV)
YOSHIDA_TERAI = Download(
    id="yoshida-terai-2017-hsc", url="https://arxiv.org/pdf/1706.10017v1", subdir=_P, name="arXiv-1706.10017v1.pdf",
    title="Yoshida & Terai (2017): size distribution of small L4 Jupiter Trojans (Subaru/HSC)",
    citation="Yoshida, F. & Terai, T. (2017). Small Jupiter Trojans survey with Subaru/Hyper Suprime-Cam. "
             "Astronomical Journal 154, 71. DOI:10.3847/1538-3881/aa7d03 (arXiv:1706.10017).", notes=_ARXIV)
TERAI_YOSHIDA = Download(
    id="terai-yoshida-2018-hsc", url="https://arxiv.org/pdf/1805.09445v1", subdir=_P, name="arXiv-1805.09445v1.pdf",
    title="Terai & Yoshida (2018): size distribution of small Hilda asteroids (Subaru/HSC)",
    citation="Terai, T. & Yoshida, F. (2018). Size distribution of small Hilda asteroids. Astronomical Journal 156, "
             "30. DOI:10.3847/1538-3881/aac81b (arXiv:1805.09445).", notes=_ARXIV)
PETIT = Download(
    id="petit-2011-cfeps", url="https://arxiv.org/pdf/1108.4836v1", subdir=_P, name="arXiv-1108.4836v1.pdf",
    title="Petit et al. (2011): CFEPS full data release (mean g - r of the CFEPS sample)",
    citation=L7.citation.split("; Gladman")[0] + " (arXiv:1108.4836).", notes=_ARXIV)
JESTER = Download(
    id="jester-2005-sdss", url="https://arxiv.org/pdf/astro-ph/0506022v1", subdir=_P, name="arXiv-astro-ph-0506022v1.pdf",
    title="Jester et al. (2005): transformations between SDSS ugriz and UBVRcIc (Table 1)",
    citation="Jester, S., Schneider, D. P., Richards, G. T. et al. (2005). The SDSS view of the Palomar-Green bright "
             "quasar survey. Astronomical Journal 130, 873-895. DOI:10.1086/432466 (arXiv:astro-ph/0506022).",
    notes=_ARXIV)

# ---- irregular moons (docs/reports/synthetic-populations.md section 12) ----
_NATSATS = "https://www.minorplanetcenter.net/cgi-bin/natsats.cgi?sel1={code}&sel4=1&sel9=1"
NATSATS = {
    planet: Download(
        id=f"mpc-natsats-{planet}", url=_NATSATS.format(code=code), subdir=SUBDIR, name=f"mpc-natsats-{planet}.html",
        title=f"MPC Natural Satellites Ephemeris Service: one-line orbital elements and H of every outer irregular "
              f"satellite of {planet.capitalize()}",
        citation="Minor Planet Center, Natural Satellites Ephemeris Service (https://www.minorplanetcenter.net/iau/"
                 "NatSats/NaturalSatellites.html), one-line element format "
                 "(https://www.minorplanetcenter.net/iau/info/SatOrbitFormat.html).",
        version="snapshot of the retrieval date (the service is updated as orbits are refined)",
        notes="Planet-barycentric osculating elements (ecliptic and equinox J2000): epoch, time of pericentre, argument "
              "of pericentre, node, inclination, e, pericentre distance [au], central body, H (V band, as Ashton et "
              "al. 2025 Sec. 4.1 state), arc, observations. Selection 'all outer irregular satellites' of the planet.")
    for planet, code in (("jupiter", "1A"), ("saturn", "2A"), ("uranus", "3A"), ("neptune", "4A"))
}
ASHTON_2020 = Download(
    id="ashton-2020-jupiter", url="https://arxiv.org/pdf/2009.03382v1", subdir=_P, name="arXiv-2009.03382v1.pdf",
    title="Ashton et al. (2020): debiased population of km-scale retrograde jovian irregular moons (CFHT shift and stack)",
    citation="Ashton, E., Beaudoin, M. & Gladman, B. (2020). The population of kilometer-scale retrograde jovian "
             "irregular moons. Planetary Science Journal 1, 52. DOI:10.3847/PSJ/abad95 (arXiv:2009.03382).",
    license="CC BY 4.0 (published version)", notes=_ARXIV)
ASHTON_2021 = Download(
    id="ashton-2021-saturn", url="https://iopscience.iop.org/article/10.3847/PSJ/ac0979/pdf", subdir=_P,
    name="Ashton-2021-PSJ-2-158.pdf",
    title="Ashton et al. (2021): debiased size distribution and population of Saturn's irregular moons to D = 2.8 km",
    citation="Ashton, E., Gladman, B. & Beaudoin, M. (2021). Evidence for a recent collision in Saturn's irregular "
             "moon population. Planetary Science Journal 2, 158. DOI:10.3847/PSJ/ac0979.",
    license="CC BY 4.0", notes="Published version (open access; the publisher serves scripted clients a bot check).",
    browser_agent=True, sha256="79d364f5b1e0fc504e4fda3073e6daea7fb4bf2be802d48deb403dfe870f3b5a",
    retrieved="2026-10-01")
ASHTON_2025 = Download(
    id="ashton-2025-saturn", url="https://arxiv.org/pdf/2503.07081v2", subdir=_P, name="arXiv-2503.07081v2.pdf",
    title="Ashton et al. (2025): 64 new saturnian irregular moons; MPC H of irregular moons is V band",
    citation="Ashton, E., Gladman, B., Alexandersen, M. & Petit, J.-M. (2025). Retrograde predominance of small "
             "saturnian moons reiterates a recent retrograde collisional disruption. Planetary Science Journal 6, 283. "
             "DOI:10.3847/PSJ/ae1d62 (arXiv:2503.07081).", license="CC BY 4.0 (published version)", notes=_ARXIV)
SHEPPARD_2005 = Download(
    id="sheppard-2005-uranus", url="https://arxiv.org/pdf/astro-ph/0410059v1", subdir=_P,
    name="arXiv-astro-ph-0410059v1.pdf",
    title="Sheppard, Jewitt & Kleyna (2005): survey for irregular satellites of Uranus, limits to completeness",
    citation="Sheppard, S. S., Jewitt, D. & Kleyna, J. (2005). An ultradeep survey for irregular satellites of "
             "Uranus: limits to completeness. Astronomical Journal 129, 518-525. DOI:10.1086/426329 "
             "(arXiv:astro-ph/0410059).", notes=_ARXIV)
SHEPPARD_2006 = Download(
    id="sheppard-2006-neptune", url="https://arxiv.org/pdf/astro-ph/0604552v1", subdir=_P,
    name="arXiv-astro-ph-0604552v1.pdf",
    title="Sheppard, Jewitt & Kleyna (2006): survey for irregular satellites of Neptune, limits to completeness",
    citation="Sheppard, S. S., Jewitt, D. & Kleyna, J. (2006). A survey for \"normal\" irregular satellites around "
             "Neptune: limits to completeness. Astronomical Journal 132, 171-176. DOI:10.1086/504799 "
             "(arXiv:astro-ph/0604552).", notes=_ARXIV)
SHEPPARD_2024 = Download(
    id="sheppard-2024-uranus-neptune", url="https://arxiv.org/pdf/2410.00108v1", subdir=_P,
    name="arXiv-2410.00108v1.pdf",
    title="Sheppard et al. (2024): new moons of Uranus and Neptune; completeness of their outer satellites",
    citation="Sheppard, S. S., Tholen, D. J., Brozovic, M., Jacobson, R. A., Trujillo, C. A., Lykawka, P. S. & "
             "Alexandersen, M. (2024). New moons of Uranus and Neptune from ultradeep pencil-beam surveys. "
             "Astronomical Journal 168, 258. DOI:10.3847/1538-3881/ad7fed (arXiv:2410.00108).",
    license="CC BY 4.0 (published version)", notes=_ARXIV)

# ---- Centaurs ----
KURLANDER_ARCHIVE = Download(
    id="kurlander-2025-archive",
    url="https://zenodo.org/api/records/14201491/files/Survey-Debiasing-1.0.1.zip/content", subdir=SUBDIR,
    name="Survey-Debiasing-1.0.1.zip",
    title="Methods and datasets of Kurlander et al. (2025): the literature Centaur model (Nesvorny et al. 2019 orbits, "
          "Lawler et al. 2018 H distribution), members with 21 < m < 23.5",
    citation="Kurlander, J., Bernardinelli, P., Holman, M., Juric, M., Heinze, A. & Payne, M. (2024). Methods and "
             "Datasets from A Well-Characterized Survey for Centaurs in Pan-STARRS1 (v1.0.1, 2024-11-22) [Data set]. "
             "Zenodo. DOI:10.5281/zenodo.14201491. For: Kurlander, J. A., Holman, "
             "M. J., Bernardinelli, P. H., Juric, M., Heinze, A. N. & Payne, M. J. (2025). A well-characterized "
             "survey for Centaurs in Pan-STARRS1. Astronomical Journal 169, 73. DOI:10.3847/1538-3881/ad9a58.",
    version="1.0.1", license="MIT (LICENSE in the archive)",
    notes="Read: literature_states_keps_and_H.pkl only (numpy arrays; unpickled with a loader that accepts nothing but "
          "numpy array reconstruction). The notebook gives the model size n_literature_obs = 26116868.")
KURLANDER = Download(
    id="kurlander-2025-centaurs", url="https://arxiv.org/pdf/2412.01687v1", subdir=_P, name="arXiv-2412.01687v1.pdf",
    title="Kurlander et al. (2025): debiased Centaur population from Pan-STARRS1 (21,400 with H_r < 13.7)",
    citation=KURLANDER_ARCHIVE.citation.split("For: ")[1] + " (arXiv:2412.01687).",
    license="CC BY 4.0 (published version)", notes=_ARXIV)
MURTAGH = Download(
    id="murtagh-2025-lsst-centaurs", url="https://arxiv.org/pdf/2506.02779v1", subdir=_P, name="arXiv-2506.02779v1.pdf",
    title="Murtagh et al. (2025): LSST Centaur model (colours of the model Centaurs, randomized angles)",
    citation="Murtagh, J., Schwamb, M. E., Merritt, S. R., Bernardinelli, P. H., Kurlander, J. A., Cornwall, S., "
             "Juric, M., Fedorets, G. et al. (2025). Predictions of the LSST solar system yield: discovery rates and "
             "characterizations of Centaurs. Astronomical Journal 170, 98. DOI:10.3847/1538-3881/ade1db "
             "(arXiv:2506.02779).", license="CC BY 4.0 (published version)", notes=_ARXIV)
NESVORNY_2019 = Download(
    id="nesvorny-2019-ossos-centaurs", url="https://arxiv.org/pdf/1907.10723v1", subdir=_P,
    name="arXiv-1907.10723v1.pdf",
    title="Nesvorny et al. (2019): OSSOS Centaurs and the dynamical model (21,000 +- 8,000 with D > 10 km)",
    citation="Nesvorny, D., Vokrouhlicky, D., Stern, A. S., Davidsson, B., Bannister, M. T., Volk, K., Chen, Y.-T., "
             "Gladman, B. J. et al. (2019). OSSOS. XIX. Testing early solar system dynamical models using OSSOS "
             "Centaur detections. Astronomical Journal 158, 132. DOI:10.3847/1538-3881/ab3651 (arXiv:1907.10723).",
    notes=_ARXIV)

MOON_PAPERS = (ASHTON_2020, ASHTON_2021, ASHTON_2025, SHEPPARD_2005, SHEPPARD_2006, SHEPPARD_2024)
CENTAUR_PAPERS = (KURLANDER, MURTAGH, NESVORNY_2019)
PAPERS = (HENDLER_MALHOTRA, MAEDA, HEINZE, YOSHIDA_TERAI, TERAI_YOSHIDA, PETIT, JESTER, *MOON_PAPERS, *CENTAUR_PAPERS)
DATASETS = (GRANVIK, GRANVIK_README, L7, *NATSATS.values(), KURLANDER_ARCHIVE)


def register(ctx: BuildContext) -> dict[str, str]:
    """Fetch every download and add its SourceRecord; returns {download id: source id}."""
    from .photometry.moons import GRAV       # irregular-moon albedos (transcribed by the light stage)
    out = {}
    for d in (*DATASETS, *PAPERS, GRAV):
        out[d.id] = ctx.add_source(d.source())
    return out


def tables() -> dict:
    return json.loads((TABLES / "populations.json").read_text(encoding="utf-8"))


def read_granvik() -> np.ndarray:
    """(N, 7): a [au], e, i, node, peri, M [deg], H."""
    with gzip.open(GRANVIK.fetch(), "rt") as f:
        return np.loadtxt(f, dtype=np.float64, ndmin=2)


def read_l7() -> tuple[dict, np.ndarray, np.ndarray]:
    """(header {epochJd, lambdaN}, (N, 7) a, e, i, node, peri, M [deg], H_g, (N,) component labels)."""
    rows, comp, hdr = [], [], {}
    with gzip.open(L7.fetch(), "rt") as f:
        for line in f:
            s = line.strip()
            if s.startswith("#"):
                if "Epoch of elements" in s:
                    hdr["epochJd"] = float(s.split("=")[1])
                elif "lambdaN" in s:
                    hdr["lambdaN"] = float(s.split("=")[1])
                continue
            p = s.split()
            if len(p) < 10:
                continue
            rows.append([float(x) for x in p[:7]])
            comp.append(f"{p[8]} {p[9]}")
    if set(hdr) != {"epochJd", "lambdaN"}:
        raise ValueError(f"{L7.name}: header without epoch / lambdaN ({hdr})")
    return hdr, np.array(rows), np.array(comp)


# ---------------------------------------------------------------------------------------------- irregular moons
_PLANET_CODE = {"05": 5, "06": 6, "07": 7, "08": 8}
_CENTURY = {"I": 1800, "J": 1900, "K": 2000}


def satellite_key(packed: str) -> str:
    """MPC packed natural-satellite designation -> 'J59' (numbered: planet letter + number) or 'S/2003 J 16'."""
    d = packed.strip()
    m = re.fullmatch(r"([JSUN])(\d{3})S", d)
    if m:
        return f"{m.group(1)}{int(m.group(2))}"
    m = re.fullmatch(r"S([IJK])(\d\d)([JSUN])(\d\d)(\d)", d)
    if m:
        return f"S/{_CENTURY[m.group(1)] + int(m.group(2))} {m.group(3)} {int(m.group(4)) + 100 * int(m.group(5))}"
    return d


def parse_natsats(text: str) -> list[dict]:
    """One-line elements of the MPC Natural Satellites Ephemeris Service (SatOrbitFormat.html columns): key, name,
    planet NAIF id, H, e, q [au], a [au], i, node, peri [deg] (planet-barycentric, ecliptic J2000)."""
    out = []
    for line in re.sub(r"<[^>]+>", "", text).splitlines():
        if len(line) < 92 or line[83:85] not in _PLANET_CODE or not line[86:91].strip():
            continue
        e, q = float(line[63:72]), float(line[73:82])
        out.append({"key": satellite_key(line[0:12]), "name": line[145:].strip(), "planet": _PLANET_CODE[line[83:85]],
                    "H": float(line[86:91]), "e": e, "q": q, "a": q / (1.0 - e), "i": float(line[53:62]),
                    "node": float(line[43:52]), "peri": float(line[33:42]), "epoch": line[13:18],
                    "arcDays": int(line[92:98]) if line[92:98].strip() else None})
    return out


def read_natsats(planet: str) -> list[dict]:
    rows = parse_natsats(NATSATS[planet].fetch().read_text(encoding="utf-8", errors="replace"))
    if not rows:
        raise ValueError(f"{NATSATS[planet].name}: no satellite elements")
    return rows


# ---------------------------------------------------------------------------------------------- Centaurs
class _ArrayUnpickler(pickle.Unpickler):
    """Accepts numpy array reconstruction only: the archive's pickle holds plain arrays, and nothing else may run."""
    def find_class(self, module, name):
        if (module, name) == ("numpy", "ndarray"):
            return np.ndarray
        if (module, name) == ("numpy", "dtype"):
            return np.dtype
        if name == "_reconstruct" and module in ("numpy.core.multiarray", "numpy._core.multiarray"):
            try:
                from numpy._core.multiarray import _reconstruct
            except ImportError:      # numpy < 2
                from numpy.core.multiarray import _reconstruct
            return _reconstruct
        raise pickle.UnpicklingError(f"refusing {module}.{name} in a data archive")


def read_centaur_archive() -> dict[str, np.ndarray]:
    """The literature Centaur model members of the Kurlander et al. (2025) archive: a [au], e, i [deg], H_r and the
    distance modulus d = m - H_r at which each was selected (21 < m < 23.5)."""
    with zipfile.ZipFile(KURLANDER_ARCHIVE.fetch()) as z, \
            z.open("Survey-Debiasing-1.0.1/literature_states_keps_and_H.pkl") as f:
        states, keps, H = _ArrayUnpickler(f).load()
    keps = np.asarray(keps, dtype=np.float64)
    states = np.asarray(states, dtype=np.float64)
    H = np.asarray(H, dtype=np.float64)
    if keps.shape[0] != 6 or states.shape[1] != 7 or not (keps.shape[1] == states.shape[0] == H.size):
        raise ValueError(f"{KURLANDER_ARCHIVE.name}: unexpected array shapes {keps.shape} {states.shape} {H.shape}")
    return {"a": keps[0], "e": keps[1], "i": keps[2], "H": H, "m": states[:, 6], "d": states[:, 6] - H}
