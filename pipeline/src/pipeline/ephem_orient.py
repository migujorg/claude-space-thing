"""Precise body orientation from NAIF binary PCKs -> app/public/data/orient/<name>.{json,bin} (OrientationHeader).

Binary PCK type 2 segments hold Chebyshev series for three Euler angles (phi, delta, w) of a body frame relative to
a reference frame. As SPICE (TISBOD with a binary PCK): reference -> PCK frame = R3(w) R1(delta) R3(phi). The records
are copied bit-for-bit for the build window, like the SPK products. The header adds the constant rotations the app
needs: reference -> J2000 (e.g. ECLIPJ2000) and body-fixed frame -> PCK frame (e.g. MOON_ME -> MOON_PA), both
computed by SPICE from the kernels (pxform), not typed in.

- Earth (399): ITRF93 from NAIF's high-precision Earth PCK (IERS-based EOP). Rotation before the file's "UTC epoch
  of last datum" is `measured`; after it the EOP are IERS/JPL predictions, `estimated`. Beyond the file's end the
  long-term predict PCK (EOP extrapolated: polar motion and nutation corrections held constant) is used,
  `estimated`.
- Moon (301): the DE440 lunar principal-axes frame (moon_pa_de440) rotated into the Mean Earth/Polar Axis frame
  MOON_ME_DE440_ME421 (moon_de440_250416.tf), the frame lunar maps use; `measured`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import spiceypy as sp
from jplephem.daf import DAF

from . import download
from .download import fetch, record, sha256_file
from .ephem_spk import Segment, read_pck
from .output import write_bin, write_json
from .paths import OUT, RAW
from .schema import BuildContext, SourceRecord

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
_LICENSE = "NAIF/JPL public data (U.S. Government work); see https://naif.jpl.nasa.gov/naif/rules.html"
_NAIF_CITE = ("Acton, C. H. (1996). Ancillary data services of NASA's Navigation and Ancillary Information Facility. "
              "Planetary and Space Science 44(1), 65-70. DOI:10.1016/0032-0633(95)00107-7")

SRC_EARTH_HP = "naif-earth-pck-high-prec"
SRC_EARTH_PRED = "naif-earth-pck-predict"
SRC_MOON_PA = "naif-moon-pa-de440"
SRC_MOON_FK = "naif-moon-fk-de440"
MOON_FK = "moon_de440_250416.tf"
MOON_PCK = "moon_pa_de440_200625.bpc"
# Chosen 2026-10-07: the high-precision kernel in the existing build; retain its raw copy
# because NAIF removes superseded daily files. Move name and digest together, deliberately.
EARTH_HP = "earth_000101_270102_261006.bpc"
EARTH_HP_SHA256 = "0a1081571316a22d437d583d2319b3c38eb387ababc8e7a66fd55c5dec1bfdac"
# Chosen 2026-10-07: the existing build's long-term prediction beyond the high-precision coverage.
EARTH_PRED = "earth_2026_260806_2126_predict.bpc"
EARTH_PRED_SHA256 = "9f565ab5aaccd33afe54f3a1b20cb8b136636c31a0bd4c0986fac722b931c280"

FRAME_NAMES = {1: "J2000", 17: "ECLIPJ2000"}


@dataclass
class OrientSeg:
    body: int
    seg: Segment        # records restricted to the window; seg.declared = coverage used
    label: str
    sources: list[str]
    method: str
    uncertainty: str | None = None


def _pinned_earth(name: str, digest: str) -> Path:
    """Check the raw bytes AND ledger before using a pin; never refetch a different cached file."""
    instruction = (f"Earth orientation pin {name} (sha256 {digest}). Restore the pinned raw file in "
                   f"{RAW / 'naif/pck'} and its _downloads.json ledger entry from a kept copy, or deliberately "
                   "update the name and SHA256 constants in pipeline.ephem_orient after running "
                   "python -m pipeline.ephem_orient inspect-earth-pins and recording why. NAIF removes "
                   "superseded high-precision files; a newer kernel is never substituted.")
    cached = RAW / "naif/pck" / name
    if cached.exists() and sha256_file(cached) != digest:
        raise ValueError(f"{instruction} Cached file sha256 mismatch.")
    try:
        path = fetch(f"{NAIF}/pck/{name}", "naif/pck")
    except (download.requests.RequestException, FileNotFoundError) as e:
        raise ValueError(f"{instruction} Pinned file unavailable: {e}") from e
    if path.name != name or sha256_file(path) != digest:
        raise ValueError(f"{instruction} Fetched file name or sha256 mismatch.")
    if record(path)["sha256"] != digest:
        raise ValueError(f"{instruction} Download ledger sha256 mismatch.")
    return path


def _comments(path: Path) -> str:
    with path.open("rb") as f:
        return DAF(f).comments()


def _datum_utc(name: str, comments: str) -> str:
    m = re.search(r"UTC Epoch of last datum:\s*(\d{4} \w{3} \d\d \d\d:\d\d:\d\d\.\d+) UTC", comments)
    if not m:
        raise ValueError(f"{name}: no 'UTC Epoch of last datum' in the comments")
    return m.group(1)


def inspect_earth_pins() -> dict:
    """List and fetch current candidates into temporary files; change no pins, raw ledger or products.

    Requires the current pin's retained raw file, the cached naif0012 LSK and a built manifest window.
    Print with `python -m pipeline.ephem_orient inspect-earth-pins`; any update is a separate code edit.
    """
    old = RAW / "naif/pck" / EARTH_HP
    if not old.exists() or sha256_file(old) != EARTH_HP_SHA256:
        raise ValueError(f"Restore the pinned raw file {old} (sha256 {EARTH_HP_SHA256}) to compare EOP epochs.")
    old_utc = _datum_utc(EARTH_HP, _comments(old))
    window = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["window"]
    listing = download.request("GET", f"{NAIF}/pck/", timeout=60).text
    listed, candidates = {}, {}
    with TemporaryDirectory(prefix="earth-pin-review-") as tmp:
        for role, pattern, key in (
            ("HP", r"earth_000101_\d{6}_\d{6}\.bpc", lambda n: n[-10:-4]),
            ("PRED", r"earth_\d{4}_\d{6}_\d{4}_predict\.bpc", lambda n: n.split("_")[2]),
        ):
            names = sorted(set(re.findall(pattern, listing)), key=key)
            if not names:
                raise ValueError(f"no file matching {pattern} in {NAIF}/pck/")
            listed[role] = names
            name = names[-1]
            path = Path(tmp) / name
            # Use the pipeline's retry and host limits, but keep the candidate outside the raw ledger.
            with download.request("GET", f"{NAIF}/pck/{name}", stream=True, timeout=120) as response:
                with path.open("wb") as f:
                    for chunk in response.iter_content(1 << 20):
                        f.write(chunk)
                length = response.headers.get("Content-Length")
                if length and path.stat().st_size != int(length):
                    raise ValueError(f"{name}: short candidate download")
            comments = _comments(path)
            candidates[role] = {"name": name, "sha256": sha256_file(path), "bytes": path.stat().st_size,
                                "lastDatumUtc": _datum_utc(name, comments)}
            if role == "HP":
                hp_segments = read_pck(path)
            else:
                predicts = re.search(r"\$\s+Predicts to\s+([^\n]+)", comments)
                candidates[role]["sourceEopPredictsTo"] = predicts.group(1).strip() if predicts else None
    lsk_path = RAW / "naif/lsk/naif0012.tls"
    sp.furnsh(str(lsk_path))
    try:
        old_et = sp.str2et(old_utc + " UTC")
        new_et = sp.str2et(candidates["HP"]["lastDatumUtc"] + " UTC")
        lo = max(window["startEt"], old_et, min(s.start for s in hp_segments))
        hi = min(window["endEt"], new_et, max(s.end for s in hp_segments))
        newly_measured = [sp.et2utc(e, "ISOC", 3) + "Z" for e in (lo, hi)] if lo < hi else None
        candidates["HP"]["coverageEndUtc"] = sp.et2utc(max(s.end for s in hp_segments), "ISOC", 3) + "Z"
    finally:
        sp.unload(str(lsk_path))
    return {"listedKernels": listed, "candidates": candidates, "pinnedMeasuredThroughUtc": old_utc,
            "newlyMeasuredWindowUtc": newly_measured,
            "nextStep": "Deliberately edit EARTH_HP/EARTH_PRED and their SHA256 constants together, explain "
                        "why in the comments/commit, retain the raw files and ledger, then rebuild bodies. "
                        "New kernels may also revise orientation on already measured dates."}


def _overlap(seg: Segment, a: float, b: float) -> Segment | None:
    """Records of seg overlapping [a, b], with the declared coverage clipped to [a, b]."""
    lo, hi = max(a, seg.start), min(b, seg.end)
    if lo >= hi:
        return None
    i0 = max(0, int(np.floor((lo - seg.init) / seg.intlen)))
    i1 = min(seg.n - 1, int(np.floor((hi - seg.init) / seg.intlen)))
    return Segment(seg.target, seg.center, seg.frame, seg.type, seg.init + i0 * seg.intlen, seg.intlen, seg.rsize,
                   seg.records[i0:i1 + 1].copy(), declared=(lo, hi))


def _pieces(path: Path, a: float, b: float) -> list[Segment]:
    out = [p for s in read_pck(path) if (p := _overlap(s, a, b)) is not None]
    out.sort(key=lambda s: s.start)
    covered = a
    for s in out:
        if s.start > covered + 1e-3:
            raise ValueError(f"{path.name}: gap in coverage at ET {covered}")
        covered = max(covered, s.end)
    if covered < b - 1e-3:
        raise ValueError(f"{path.name}: coverage ends at ET {covered}, before {b}")
    return out


def earth(ctx: BuildContext, t0: float, t1: float, lsk_path: Path) -> tuple[list[OrientSeg], dict]:
    hp_name, pr_name = EARTH_HP, EARTH_PRED
    hp = _pinned_earth(hp_name, EARTH_HP_SHA256)
    pr = _pinned_earth(pr_name, EARTH_PRED_SHA256)
    hp_c, pr_c = _comments(hp), _comments(pr)
    datum_utc = _datum_utc(hp_name, hp_c)
    sp.furnsh(str(lsk_path))
    try:
        last_datum = sp.str2et(datum_utc + " UTC")
    finally:
        sp.unload(str(lsk_path))
    hp_end = max(s.end for s in read_pck(hp))
    for rec, sid, title, name, c in ((record(hp), SRC_EARTH_HP, "NAIF high-precision Earth orientation PCK (ITRF93)",
                                      hp_name, hp_c),
                                     (record(pr), SRC_EARTH_PRED, "NAIF low-accuracy long-term predict Earth "
                                      "orientation PCK (ITRF93)", pr_name, pr_c)):
        ctx.add_source(SourceRecord(
            id=sid, title=title,
            citation=f"NAIF/JPL binary PCK {name} (ITRF93 relative to ECLIPJ2000; IAU 1976 precession, IAU 1980 "
                     "nutation, JPL Earth orientation parameters: https://eop.jpl.nasa.gov/). " + _NAIF_CITE,
            url=rec["url"], retrieved=rec["retrieved"], sha256=rec["sha256"], version=name, license=_LICENSE,
            notes=" ".join(ln.strip() for ln in c.splitlines() if re.search(r"Creation date|ET Start|ET Stop|last datum"
                                                                               r"|Last Data Point|Predicts to", ln))))
    segs: list[OrientSeg] = []
    hp_method = f"Chebyshev Euler angles copied unchanged from {hp_name} (records overlapping the window)."
    for s in _pieces(hp, t0, min(t1, hp_end)):
        for lo, hi, label, unc in ((s.start, min(s.end, last_datum), "measured",
                                    "NAIF: error < 0.1 microradian before the epoch of the last EOP datum "
                                    "(pck00011.tpc, 'Earth orientation')."),
                                   (max(s.start, last_datum), s.end, "estimated",
                                    "After the last EOP datum the EOP are predictions; NAIF: the error rises to "
                                    "several microradians (pck00011.tpc, 'Earth orientation').")):
            if lo < hi:
                p = _overlap(s, lo, hi)
                segs.append(OrientSeg(399, p, label, [SRC_EARTH_HP], hp_method + (
                    "" if label == "measured" else f" Epochs after the last EOP datum ({datum_utc} UTC): predicted."),
                    unc))
    if t1 > hp_end:
        for s in _pieces(pr, hp_end, t1):
            segs.append(OrientSeg(399, s, "estimated", [SRC_EARTH_PRED],
                                  f"Chebyshev Euler angles copied unchanged from {pr_name}, used after the end of "
                                  f"{hp_name}. Past its source EOP file the EOP are extrapolated (polar motion and "
                                  "nutation corrections held constant, UT1R extrapolated), per the file's comments.",
                                  "NAIF describes this file as a low-accuracy long-term prediction."))
    bodies = {"399": {"frame": "ITRF93", "pckFrame": "ITRF93", "bodyToPck": np.eye(3).reshape(-1).tolist()}}
    return segs, bodies


def moon(ctx: BuildContext, t0: float, t1: float) -> tuple[list[OrientSeg], dict]:
    pck = fetch(f"{NAIF}/pck/{MOON_PCK}", "naif/pck")
    fk = fetch(f"{NAIF}/fk/satellites/{MOON_FK}", "naif/fk-satellites")
    c = _comments(pck)
    rp, rf = record(pck), record(fk)
    cite = ("Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL Planetary and Lunar Ephemerides "
            "DE440 and DE441. The Astronomical Journal 161(3), 105. DOI:10.3847/1538-3881/abd414. ")
    ctx.add_source(SourceRecord(
        id=SRC_MOON_PA, title="NAIF lunar orientation PCK from DE440 (principal-axes frame MOON_PA_DE440)",
        citation=cite + f"Binary PCK {MOON_PCK} (N. Bachman, NAIF, 2021-06-25). " + _NAIF_CITE,
        url=rp["url"], retrieved=rp["retrieved"], sha256=rp["sha256"], version=MOON_PCK, license=_LICENSE,
        notes=" ".join(c.split())[:600]))
    ctx.add_source(SourceRecord(
        id=SRC_MOON_FK, title="NAIF lunar frames kernel for DE440 (MOON_PA_DE440, MOON_ME_DE440_ME421)",
        citation=cite + f"Frame kernel {MOON_FK} (NAIF). " + _NAIF_CITE,
        url=rf["url"], retrieved=rf["retrieved"], sha256=rf["sha256"], version=MOON_FK, license=_LICENSE))
    sp.furnsh(str(fk))
    try:
        me_to_pa = np.array(sp.pxform("MOON_ME_DE440_ME421", "MOON_PA_DE440", 0.0))
        _center, _cls, pa_class = sp.frinfo(sp.namfrm("MOON_PA_DE440"))
    finally:
        sp.unload(str(fk))
    segs = [OrientSeg(301, s, "measured", [SRC_MOON_PA, SRC_MOON_FK],
                      f"Chebyshev Euler angles of MOON_PA_DE440 copied unchanged from {MOON_PCK}; rotated into "
                      f"MOON_ME_DE440_ME421 with the constant rotation of {MOON_FK} (bodies['301'].bodyToPck).",
                      "DE440 lunar libration solution; see Park et al. (2021).")
            for s in _pieces(pck, t0, t1) if s.target == pa_class]
    bodies = {"301": {"frame": "MOON_ME_DE440_ME421", "pckFrame": "MOON_PA_DE440",
                      "bodyToPck": me_to_pa.reshape(-1).tolist()}}
    return segs, bodies


def write(ctx: BuildContext, name: str, segs: list[OrientSeg], bodies: dict, stage: str, notes: str) -> dict:
    references = {}
    offset, seg_json, blobs = 0, [], []
    for o in segs:
        s = o.seg
        ref = FRAME_NAMES[s.frame]
        if ref not in references:
            references[ref] = np.array(sp.pxform(ref, "J2000", 0.0)).reshape(-1).tolist()
        d = {"body": o.body, "frameClassId": s.target, "reference": ref, "type": 2, "initEt": s.init,
             "intLen": s.intlen, "rsize": s.rsize, "n": s.n, "offset": offset, "startEt": s.start, "endEt": s.end,
             "sources": o.sources, "label": o.label, "method": o.method}
        if o.uncertainty:
            d["uncertainty"] = o.uncertainty
        seg_json.append(d)
        blobs.append(np.ascontiguousarray(s.records, dtype="<f8").reshape(-1))
        offset += s.records.size
    header = {"bin": f"orient/{name}.bin", "references": references, "bodies": bodies, "segments": seg_json,
              "notes": notes}
    write_bin(ctx, f"orient/{name}.bin", np.concatenate(blobs), stage)
    write_json(ctx, f"orient/{name}.json", header, stage)
    return header


def body_to_j2000(header: dict, data: np.ndarray, body: int, et: float) -> np.ndarray | None:
    """Reference evaluation (Python) of an orientation product: body-fixed -> J2000, row-major 3x3."""
    from .ephem_spk import evaluate
    for d in reversed(header["segments"]):
        if d["body"] != body or not (d["startEt"] <= et <= d["endEt"]):
            continue
        recs = data[d["offset"]: d["offset"] + d["n"] * d["rsize"]].reshape(d["n"], d["rsize"])
        seg = Segment(d["frameClassId"], 0, 0, 2, d["initEt"], d["intLen"], d["rsize"], recs,
                      declared=(d["startEt"], d["endEt"]))
        phi, delta, w = evaluate(seg, et)[0][0]
        tipm = np.array(sp.eul2m(w, delta, phi, 3, 1, 3))           # reference -> PCK frame
        ref = np.array(header["references"][d["reference"]]).reshape(3, 3)
        b2p = np.array(header["bodies"][str(body)]["bodyToPck"]).reshape(3, 3)
        return ref @ tipm.T @ b2p
    return None


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Review current NAIF Earth kernels without changing the build.")
    parser.add_argument("command", choices=["inspect-earth-pins"])
    parser.parse_args()
    print(json.dumps(inspect_earth_pins(), indent=2))
