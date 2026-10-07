"""Optical thickness of partly cloudy pixels: an observed population applied to cloud without its own retrieval.

The Earth cloud layer (surf_earth.py) knows, per texel, the share of samples with a cloud top but no standard
optical-thickness retrieval (cloudFraction − tauRetrievedFraction of `cloudTau`). A sample with a height and no
thickness counts as cloud. These two VIIRS GIBS layers cannot distinguish partly cloudy pixels from pixels
restored to clear sky by the optical algorithm or failed optical retrievals. VIIRS GIBS does not serve CLDPROP's
separate `_PCL` fields; GIBS does serve MODIS Aqua and Terra PCL optical-thickness layers (MYD06/MOD06), from
different instruments and observations. CSR = 1, 3 describes the MOD06 population behind this statistic;
CLDPROP v1.1 omits CSR = 3 (Platnick et al. 2017; 2021).

The published statistic used here is the global, area-weighted mean joint histogram of cloud optical thickness
and cloud-top pressure for partly cloudy pixels, from the MODIS C6.1 Level-3 COSP product (MCD06COSP_M3, Terra +
Aqua, July 2021) in Pincus et al. (2023), Earth Syst. Sci. Data 15, 2483, Fig. 7 (b: all phases, d: ice,
f: liquid; a, c, e: fully cloudy). The data files themselves need an Earthdata login, so the values are read from
the figure. It is embedded in the article's PDF as a lossless 2067 × 2518 RGB raster, and each histogram cell's
flat colour is inverted through the figure's own colour bar (linear, 0-0.062 cloud fraction, seven ticks). The
reading is exact up to the colour map's quantization: one colour step is 0.0002-0.0005 in cloud fraction, and
the palest steps (below FLOOR) cannot be told from an empty cell. Those cells count as 0; the statistics are also
given with every one of them at FLOOR (an upper bound).

The figure's geometry (axes frames, colour bar, tick rows) is fixed below and checked against the raster, so a
different PDF fails loudly instead of being misread.
"""

from __future__ import annotations

import re
import struct
import zlib
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from .download import fetch, record

PDF_URL = "https://essd.copernicus.org/articles/15/2483/2023/essd-15-2483-2023.pdf"
PDF_NAME = "Pincus2023_ESSD15_2483.pdf"
SRC_ID = "pincus2023-modis-cosp"
TITLE = "Pincus et al. (2023), MODIS C6.1 COSP Level-3 cloud histograms (Fig. 7, July 2021)"
CITATION = ("Pincus, R., Hubanks, P. A., Platnick, S., Meyer, K., Holz, R. E., Botambekov, D. & Wall, C. J. (2023). "
            "Updated observations of clouds by MODIS for global model assessment. Earth System Science Data 15, "
            "2483-2497. doi:10.5194/essd-15-2483-2023. Fig. 7: global (area-weighted) mean joint histograms of cloud "
            "optical thickness and cloud-top pressure from MCD06COSP_M3 (MODIS C6.1, Terra + Aqua), July 2021, for "
            "fully and partly cloudy pixels, all phases, ice and liquid.")

P17_URL = "https://modis-images.gsfc.nasa.gov/_docs/Platnick_2017.pdf"
P17_NAME = "Platnick2017_TGRS55_502.pdf"
P17_ID = "platnick2017-modis-c6"
P17_CITATION = ("Platnick, S., Meyer, K. G., King, M. D., Wind, G., Amarasinghe, N., Marchant, B., Arnold, G. T., Zhang, "
                "Z., Hubanks, P. A., Holz, R. E., Yang, P., Ridgway, W. L. & Riedi, J. (2017). The MODIS cloud optical "
                "and microphysical products: Collection 6 updates and examples from Terra and Aqua. IEEE Transactions "
                "on Geoscience and Remote Sensing 55, 502-525. doi:10.1109/TGRS.2016.2610522.")

# Platnick et al., MODIS C6/C6.1 Cloud Optical Properties User Guide, §1.1.2, p. 5: θ0 < 81.36°.
# https://atmosphere-imager.gsfc.nasa.gov/sites/default/files/ModAtmo/MODISCloudOpticalPropertyUserGuideFinal_v1.1_1.pdf
# Pincus et al. (2023) §2.1/Table 1 reports 81.3731° for COSP. Neither guide value filters this
# already-aggregated histogram; this MODIS guide value is not the VIIRS layer's day limit.
MODIS_COP_DAY_SZA_MAX_DEG = 81.36

IMAGE_SIZE = (2067, 2518)              # width, height of Fig. 7's raster
TAU_EDGES = [0.0, 0.3, 1.3, 3.6, 9.4, 23.0, 60.0, 150.0]
PC_EDGES_HPA = [0.0, 180.0, 310.0, 440.0, 560.0, 680.0, 800.0, 1100.0]   # panel rows, top to bottom
TAU_MIN = 0.01                         # lower end of the first bin for ln τ (the CLDPROP COT colour map's minimum)
# Inner pixel boxes (x0, y0) of the six 7 × 7 panels, PANEL_PX square; their frames are checked in `figure_cells`.
PANELS = {"fullTotal": (196, 15), "pclTotal": (993, 15), "fullIce": (196, 836), "pclIce": (993, 836),
          "fullLiquid": (196, 1658), "pclLiquid": (993, 1658)}
PANEL_PX = 739
BAR_ROWS = (612, 1799)                 # inner colour-bar rows, top (largest value) to bottom
BAR_COLS = (1850, 1906)
TICKS = {0.06: 648.0, 0.05: 840.0, 0.04: 1032.5, 0.03: 1225.0, 0.02: 1417.5, 0.01: 1609.5, 0.0: 1802.0}
FLOOR = 0.0008                         # cells paler than this are indistinguishable from empty
LOW_ROWS = (5, 6)                      # pc ≥ 680 hPa (cloud tops below ~3.2 km in the US standard atmosphere)

_STREAM = re.compile(rb"\d+\s+0\s+obj\s*(<<.*?>>)\s*stream\r?\n", re.S)


def fetch_pdf() -> Path:
    return fetch(PDF_URL, "papers", PDF_NAME, validate=lambda p: p.read_bytes()[:5] == b"%PDF-", timeout=300)


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def pdf_image(pdf: bytes, width: int, height: int) -> np.ndarray:
    """The 8-bit RGB image XObject of this size in a PDF (uncompressed object streams). A Flate stream with PNG
    predictors is exactly a PNG's IDAT, so it is wrapped as a PNG and decoded by PIL; no PDF library is needed."""
    pos = 0
    while (m := _STREAM.search(pdf, pos)) is not None:
        d = m.group(1)
        pos = m.start(1)                    # a match that ran across objects: look again from the next object
        if b"endobj" in d or not re.search(rb"/Subtype\s*/Image", d):
            continue
        if not (re.search(rb"/Width\s+%d\b" % width, d) and re.search(rb"/Height\s+%d\b" % height, d)):
            continue
        if b"/DeviceRGB" not in d or b"/FlateDecode" not in d or not re.search(rb"/BitsPerComponent\s+8\b", d):
            raise ValueError("image is not 8-bit RGB Flate")
        data = pdf[m.end():m.end() + int(re.search(rb"/Length\s+(\d+)\b", d).group(1))]
        pred = re.search(rb"/Predictor\s+(\d+)", d)
        if pred and int(pred.group(1)) >= 10:
            ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
            png = (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", data)
                   + _png_chunk(b"IEND", b""))
            return np.asarray(Image.open(BytesIO(png)).convert("RGB"))
        return np.frombuffer(zlib.decompress(data), np.uint8).reshape(height, width, 3).copy()
    raise ValueError(f"no {width}x{height} image in the PDF")


def _check_geometry(a: np.ndarray) -> None:
    """The frames and the colour bar's ticks are where PANELS, BAR_ROWS and TICKS say (dark lines)."""
    dark = a.astype(int).sum(-1) < 200
    for name, (x0, y0) in PANELS.items():
        x1, y1 = x0 + PANEL_PX, y0 + PANEL_PX
        frame = [dark[y0 - 2, x0:x1].mean(), dark[y1 + 1, x0:x1].mean(), dark[y0:y1, x0 - 2].mean(),
                 dark[y0:y1, x1 + 1].mean()]
        inner = dark[y0 + 3:y1 - 3, x0 + 3:x1 - 3].mean()
        if min(frame) < 0.9 or inner > 0.05:
            raise ValueError(f"Fig. 7 panel {name}: frame not where expected ({frame}, inner dark {inner:.3f})")
    for v, y in TICKS.items():
        if not dark[int(round(y)), BAR_COLS[1] + 16:BAR_COLS[1] + 26].all():
            raise ValueError(f"colour-bar tick {v} not at row {y}")


def _bar(a: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Colour-bar colours per row and their values (least-squares line through the seven ticks)."""
    ys = np.arange(BAR_ROWS[0], BAR_ROWS[1])
    tv, tr = np.array(list(TICKS)), np.array(list(TICKS.values()))
    slope, icept = np.polyfit(tr, tv, 1)
    cols = a[BAR_ROWS[0]:BAR_ROWS[1], BAR_COLS[0]:BAR_COLS[1]].astype(float).mean(axis=1)
    return cols, slope * ys + icept


def figure_cells(a: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
    """Per panel: value (cloud fraction), resolution (±) and a below-floor flag of each 7 × 7 cell [pc row, τ bin].
    A cell's colour is its most frequent RGB (labels such as "(b)" sit in some cells); its value is the mean
    value of the colour-bar rows nearest in colour, and the resolution half their span plus the RGB rounding."""
    _check_geometry(a)
    bar, vals = _bar(a)
    step = PANEL_PX / 7
    out = {}
    for name, (x0, y0) in PANELS.items():
        v, r = np.zeros((7, 7)), np.zeros((7, 7))
        for j in range(7):
            for i in range(7):
                c = a[int(y0 + j * step) + 4:int(y0 + (j + 1) * step) - 4,
                      int(x0 + i * step) + 4:int(x0 + (i + 1) * step) - 4].reshape(-1, 3).astype(np.int64)
                keys, counts = np.unique((c[:, 0] << 16) | (c[:, 1] << 8) | c[:, 2], return_counts=True)
                k = keys[np.argmax(counts)]
                rgb = np.array([k >> 16, (k >> 8) & 255, k & 255], float)
                d = np.linalg.norm(bar - rgb, axis=1)
                near = vals[d <= d.min() + 1.0]       # rows within one RGB unit of the closest
                v[j, i], r[j, i] = near.mean(), (near.max() - near.min()) / 2 + abs(vals[1] - vals[0])
        out[name] = {"value": v, "resolution": r, "belowFloor": v < FLOOR}
    return out


def _bin_ln() -> tuple[np.ndarray, np.ndarray]:
    """Mean and variance of ln τ in each τ bin, taking τ log-uniform within the bin (first bin from TAU_MIN)."""
    lo = np.log(np.maximum(TAU_EDGES[:-1], TAU_MIN))
    hi = np.log(TAU_EDGES[1:])
    return (lo + hi) / 2, (hi - lo) ** 2 / 12


def tau_distribution(h: np.ndarray) -> dict:
    """Bin probabilities and ln τ moments of a (pc × τ) histogram summed over pc."""
    p = h.sum(axis=0)
    total = float(p.sum())
    p = p / total
    m, var = _bin_ln()
    mu = float((p * m).sum())
    sd = float(np.sqrt((p * (var + m * m)).sum() - mu * mu))
    return {"cloudFraction": round(total, 5), "binProbability": [round(float(x), 4) for x in p],
            "meanLnTau": round(mu, 3), "sdLnTau": round(sd, 3), "geometricMeanTau": round(float(np.exp(mu)), 3)}


def statistics(cells: dict[str, dict[str, np.ndarray]]) -> dict:
    """The renderer's table: partly-cloudy τ distributions (all heights, low, mid/high), the ice share, and the same
    for the fully cloudy pixels for comparison; each with the below-floor cells at 0 and, as a bound, at FLOOR."""
    def h(name: str, floor: bool) -> np.ndarray:
        c = cells[name]
        return np.where(c["belowFloor"], FLOOR if floor else 0.0, c["value"])

    out = {}
    for floor in (False, True):
        pcl, ice = h("pclTotal", floor), h("pclIce", floor)
        low = np.zeros_like(pcl)
        low[list(LOW_ROWS)] = pcl[list(LOW_ROWS)]
        high = pcl - low
        key = "floorCellsAtFloor" if floor else "floorCellsZero"
        out[key] = {"partlyCloudyAllHeights": tau_distribution(pcl),
                    "partlyCloudyLow": tau_distribution(low),
                    "partlyCloudyMidHigh": tau_distribution(high),
                    "partlyCloudyIceShare": round(float(ice.sum() / pcl.sum()), 3),
                    "partlyCloudyLowShare": round(float(low.sum() / pcl.sum()), 3),
                    "fullyCloudyAllHeights": tau_distribution(h("fullTotal", floor))}
    return out


def table(ctx) -> tuple[dict, str]:
    """(header table, source id): fetch the article, read Fig. 7, register the source."""
    from . import surf_layers as sl
    path = fetch_pdf()
    a = pdf_image(path.read_bytes(), *IMAGE_SIZE)
    cells = figure_cells(a)
    sid = sl.register_dataset(ctx, SRC_ID, TITLE, CITATION, PDF_URL, {path.name: record(path)},
                              license="CC BY 4.0",
                              notes="Values read from Fig. 7 (embedded lossless raster) through its colour bar "
                                    "(pipeline/src/pipeline/cloud_pcl.py).")
    p17 = fetch(P17_URL, "papers", P17_NAME, validate=lambda p: p.read_bytes()[:5] == b"%PDF-", timeout=300)
    sid17 = sl.register_dataset(ctx, P17_ID, "Platnick et al. (2017), MODIS C6 cloud optical products", P17_CITATION,
                                P17_URL, {p17.name: record(p17)},
                                notes="Used for the failure rate of partly cloudy retrievals (Sect. V-C).")
    m, _ = _bin_ln()
    stats = statistics(cells)
    return {
        "label": "estimated",
        "sources": [sid, sid17],
        "what": "Optical thickness of MODIS partly cloudy pixels (clear-sky restoral CSR = 1, 3: cloud edges and "
                "250 m-heterogeneous pixels): global area-weighted means of July 2021 (MODIS C6.1 MCD06COSP_M3, "
                "Terra + Aqua), read from Pincus et al. (2023) Fig. 7. GIBS serves MODIS Aqua/Terra PCL thickness, "
                "but not the separate CLDPROP _PCL fields for the VIIRS inputs of this layer. CLDPROP v1.1 omits "
                "CSR = 3. The distribution is derived from an observed population histogram; assigning it to "
                "samples without their own retrieval is an assumption, hence 'estimated'. A mixture of the "
                "retrieved cloud and this assumed population is also estimated.",
        "tauBinEdges": TAU_EDGES,
        "tauBinLnCentre": [round(float(x), 3) for x in m],
        "cloudTopPressureEdgesHpa": PC_EDGES_HPA,
        "lowCloudTopPressureHpa": PC_EDGES_HPA[LOW_ROWS[0]],
        "statistics": stats,
        "histograms": {k: {"value": np.round(v["value"], 5).tolist(), "resolution": np.round(v["resolution"], 5).tolist(),
                           "belowFloor": v["belowFloor"].tolist()} for k, v in cells.items()},
        "digitization": f"Each cell's flat colour inverted through the figure's colour bar (seven ticks, linear); "
                        f"cells paler than {FLOOR} cloud fraction cannot be told from empty and count as 0 "
                        "(statistics.floorCellsAtFloor puts them all at that floor, an upper bound). Rows are "
                        "cloud-top pressure bands (top to bottom), columns τ bins.",
        "caveats": ["The failed retrievals among partly cloudy pixels (about 34 % of global over-ocean liquid PCL "
                    "attempts with the 2.1 µm pair; Platnick et al. 2017, citing Cho et al. 2015) are not in the "
                    "histogram, nor are failed overcast retrievals or pixels restored to clear; the same "
                    "distribution is assumed for them.",
                    "One month (July 2021), global, MODIS rather than VIIRS (the continuity algorithm is designed to "
                    "match); no regional dependence.",
                    f"The heritage MODIS optical guide states SZA < {MODIS_COP_DAY_SZA_MAX_DEG}° "
                    "(MODIS C6/C6.1 Cloud Optical Properties User Guide §1.1.2, p. 5); Pincus et al. (2023) "
                    "§2.1/Table 1 reports 81.3731° for COSP. The histogram is transcribed as published; "
                    "the VIIRS CLDPROP layer's separate day limit does not refilter it.",
                    "A partly cloudy pixel's τ is retrieved as if the pixel were overcast, so it is the plane-parallel "
                    "τ that reproduces the pixel's mean reflectance: the right quantity to spread over the whole "
                    "sample."],
    }, sid
