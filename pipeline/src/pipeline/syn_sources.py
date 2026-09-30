"""Downloads and SourceRecords of the synthetic stage (the COMPLETE reality level, NORTH_STAR 3.3).

Datasets (parsed): the NEO model realization (Granvik et al. 2018) and the Kuiper-belt model realization (CFEPS L7).
Papers (numbers transcribed into syn_tables/populations.json, PDFs kept with their sha256 so the transcription can be
checked): the completeness method (Hendler & Malhotra 2020) and the debiased size-frequency slopes below
completeness (Maeda et al. 2021; Yoshida & Terai 2017; Terai & Yoshida 2018; Heinze et al. 2019 as a cross-check),
the mean CFEPS colour (Petit et al. 2011) and the g -> V transformation (Jester et al. 2005).
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

from .photometry.common import Download
from .schema import BuildContext, SourceRecord

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

PAPERS = (HENDLER_MALHOTRA, MAEDA, HEINZE, YOSHIDA_TERAI, TERAI_YOSHIDA, PETIT, JESTER)
DATASETS = (GRANVIK, GRANVIK_README, L7)


def register(ctx: BuildContext) -> dict[str, str]:
    """Fetch every download and add its SourceRecord; returns {download id: source id}."""
    out = {}
    for d in (*DATASETS, *PAPERS):
        out[d.id] = ctx.add_source(d.source())
    return out


def tables() -> dict:
    return json.loads((TABLES / "populations.json").read_text())


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
