"""The validation cases: which calibrated images, which camera, which regions of interest.

Every image is a calibrated archive product (I/F or radiance) from a public archive, fetched once into
data/raw/validation/<case>/ with its sha256 in the download ledger. Epochs are the image mid-times from the labels.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..photometry.common import Download
from . import sources as vs
from .roi import RoiSpec

RMS = "https://opus.pds-rings.seti.org/holdings"


@dataclass
class ImageSpec:
    band: str                        # photometry.filters key
    product: str                     # archive product id
    data_url: str
    label_url: str | None
    opus_id: str | None = None       # image mid-time comes from the label / FITS header


@dataclass
class FrameCase:
    id: str
    title: str
    summary: str
    target: int
    observer: str                    # Horizons CENTER, e.g. '@-82'
    observer_name: str
    instrument: str
    reader: str                      # 'cassini' | 'voyager' | 'lorri'
    pixel_rad: float                 # native pixel pitch (rad)
    pixel_note: str
    bin: int
    images: list[ImageSpec]
    calibration_sigma: float         # 1σ relative absolute calibration
    calibration_note: str
    doc_sources: list[Download]
    rois: list[RoiSpec]
    archive_citation: str
    reference_image: int = 0
    rings: bool = False
    shape: str = "body"              # spectral shape for the XYZS model: 'body' spectrum or 'flat'
    crop: tuple[int, int, int, int] | None = None     # native (x0, y0, x1, y1) before binning
    others: list[int] = field(default_factory=list)  # further bodies in the view (RoiSpec.target = 1, 2, ...)
    ratios: list[tuple[str, str]] = field(default_factory=list)   # (numerator ROI id, denominator ROI id)
    # (frame, primary NAIF id, companion NAIF ids): an image of the same camera whose primary fixes the roll (a ringed
    # planet) and whose companions (moons off the projected pole axis) fix the parity, used when the case's own images
    # cannot decide it (nearly spherical, featureless bodies)
    parity_reference: tuple[ImageSpec, int, tuple[int, ...]] | None = None
    # the frames of one short sequence share one roll (their circular mean; the spread is the roll uncertainty),
    # for bodies whose own roll is poorly determined (spheres at low phase)
    common_roll: bool = False
    fit_with_others: bool = False    # the pointing model includes the other bodies (fixes roll and parity)
    notes: list[str] = field(default_factory=list)

    def downloads(self) -> list[tuple[ImageSpec, Download, Download | None]]:
        out = []
        for im in self.images:
            sub = f"validation/{self.id}"
            d = Download(id=f"{self.id}-{im.product.lower()}", url=im.data_url, subdir=sub,
                         name=im.data_url.rsplit("/", 1)[-1],
                         title=f"{self.instrument} calibrated image {im.product} ({im.band})",
                         citation=self.archive_citation)
            lab = None
            if im.label_url:
                lab = Download(id=f"{self.id}-{im.product.lower()}-label", url=im.label_url, subdir=sub,
                               name=im.label_url.rsplit("/", 1)[-1],
                               title=f"PDS3 label of {im.product}", citation=self.archive_citation)
            out.append((im, d, lab))
        return out


# ---------------------------------------------------------------------------------------------- Saturn

_COISS_CITE = ("Cassini ISS calibrated images (CISSCAL 4.0beta, units I/F), PDS Ring-Moon Systems Node "
               "'calibrated' holdings of data set CO-S-ISSNA/ISSWA-2-EDR-V1.0 (Porco, C. C. et al. 2004, Cassini "
               "Imaging Science: instrument characteristics and anticipated scientific investigations at Saturn, "
               "Space Science Reviews 115, 363-497, DOI:10.1007/s11214-004-1456-7).")


def _coiss(vol: str, folder: str, product: str) -> tuple[str, str]:
    base = f"{RMS}/calibrated/COISS_2xxx/{vol}/data/{folder}/{product}_CALIB"
    return base + ".IMG", base + ".LBL"


_SAT_FOLDER = "1839950576_1840263036"
SATURN = FrameCase(
    id="saturn-cassini-wac-2016",
    title="Saturn and its rings, Cassini ISS wide-angle camera, 2016-04-25",
    summary="Saturn's northern hemisphere, the lit north face of the main rings and the planet's shadow across "
            "them, 2.97 million km from Saturn at phase 54.6° (sub-spacecraft latitude +28.7°, Sun +26.1°); "
            "RED, GRN and BL1 frames taken within 74 s.",
    target=699, observer="@-82", observer_name="Cassini", instrument="Cassini ISS WAC", reader="cassini",
    pixel_rad=12e-3 / 200.77, pixel_note="WAC focal length 200.77 mm, 12 µm pixels (cas_iss_v10.ti); "
                                         "distortion ≤ ~1 native pixel at the corners (CISSCAL guide §5.11)",
    bin=4,
    images=[
        ImageSpec("cassini.wac.RED", "W1840258828_1", *_coiss("COISS_2104", _SAT_FOLDER, "W1840258828_1"),
                  "co-iss-w1840258828"),
        ImageSpec("cassini.wac.GRN", "W1840258865_1", *_coiss("COISS_2104", _SAT_FOLDER, "W1840258865_1"),
                  "co-iss-w1840258865"),
        ImageSpec("cassini.wac.BL1", "W1840258902_1", *_coiss("COISS_2104", _SAT_FOLDER, "W1840258902_1"),
                  "co-iss-w1840258902"),
    ],
    calibration_sigma=0.10,
    calibration_note="CISSCAL User Guide §5.10.1: absolute correction factors from standard stars carry errors of "
                     "10-15 %; 'the uncertainty of stellar fluxes is on the order of 10%, so this is the uncertainty "
                     "we expect to achieve'. Taken as 10 % (1σ) per filter, fully correlated between filters.",
    doc_sources=[vs.CISSCAL_GUIDE, vs.CASSINI_IK],
    rois=[RoiSpec("disk-centre", "disk-centre", 5), RoiSpec("limb", "limb", 4), RoiSpec("terminator", "terminator", 4),
          RoiSpec("ring-c", "ring", 4, ring_range_km=(76000.0, 90000.0), note="C ring"),
          RoiSpec("ring-b", "ring", 4, ring_range_km=(100000.0, 115000.0), note="B ring"),
          RoiSpec("ring-a", "ring", 4, ring_range_km=(123000.0, 133000.0), note="A ring inside the Encke gap"),
          RoiSpec("sky-near", "sky-near", 5, clear=4), RoiSpec("sky-far", "sky-far", 5)],
    archive_citation=_COISS_CITE, rings=True,
    notes=["The rings' reflectance model in the app is 'estimated'; ring ROIs test it together with the τ profile."],
)

# ---------------------------------------------------------------------------------------------- Voyager 2

_VGISS_CITE = ("Voyager 2 ISS narrow-angle camera, calibrated and geometrically corrected (GEOMED) images, PDS "
               "Ring-Moon Systems Node volumes VGISS_7xxx (Uranus) / VGISS_8xxx (Neptune), data sets "
               "VG2-U/N-ISS-2/3/4/6-PROCESSED (instrument: Smith, B. A. et al. 1977, Voyager imaging experiment, "
               "Space Science Reviews 21, 103-127, DOI:10.1007/BF00200847).")
_VG_PIXEL = 4.4930e-4 * 3.141592653589793 / 180.0      # GEOMED HORIZONTAL_PIXEL_FOV = VERTICAL_PIXEL_FOV (deg)


def _vgiss(vol: str, folder: str, product: str) -> tuple[str, str]:
    base = f"{RMS}/volumes/{vol[:7]}xxx/{vol}/DATA/{folder}/{product}_GEOMED"
    return base + ".IMG", base + ".LBL"


_VG_CAL = ("VGISS User Tutorial §6.3: 'Absolute calibration is still probably no more accurate than 5-10%', "
           "and the labels' REFLECTANCE_SCALING_FACTOR is 'accurate to the advertised 5-10% level for the CALIB and "
           "GEOMED images'. Taken as 10 % (1σ), the upper end, fully correlated between filters.")
_VG_PIX_NOTE = ("GEOMED pixel 4.4930e-4° (label HORIZONTAL_PIXEL_FOV, 'quite precise for the GEOMED images'); "
                "geometry reliable to ~1 GEOMED pixel (VGISS tutorial §6.1). Filter curves: SVO Voyager/ISS-NAC.*, "
                "digitized from Smith et al. (1977) Fig. 6 (pre-launch, generic to both Voyagers).")
# Voyager 2 NAC parity: Saturn and its rings (which fix the roll) with Mimas, Tethys, Dione and Rhea in the same
# frame, 57 million km, 1981-06-27 (VGISS_6203). A mirrored solution reflects the moons across the projected pole.
_VG2_PARITY = (ImageSpec("voyager.nac.Green", "C4220129", *_vgiss("VGISS_6203", "C42201XX", "C4220129"),
                         "vg-iss-2-s-c4220129"), 699, (601, 603, 604, 605))
_DISK_ROIS = [RoiSpec("disk-centre", "disk-centre", 5), RoiSpec("limb", "limb", 3),
              RoiSpec("terminator", "terminator", 3),
              RoiSpec("disk-integrated", "disk-integrated", margin=6), RoiSpec("sky-near", "sky-near", 5, clear=5),
              RoiSpec("sky-far", "sky-far", 5)]

NEPTUNE = FrameCase(
    id="neptune-voyager2-1989",
    title="Neptune, Voyager 2 narrow-angle camera, 1989-08-15 (ten days before closest approach)",
    summary="The whole disk of Neptune from 14.5 million km at phase 15.1°, in the VIOLET, GREEN and ORANGE "
            "filters (04:33-05:07 UTC).",
    target=899, observer="@-32", observer_name="Voyager 2", instrument="Voyager 2 ISS NAC", reader="voyager",
    pixel_rad=_VG_PIXEL, pixel_note=_VG_PIX_NOTE, bin=4,
    images=[ImageSpec("voyager.nac.Violet", "C1109146", *_vgiss("VGISS_8206", "C11091XX", "C1109146"),
                      "vg-iss-2-n-c1109146"),
            ImageSpec("voyager.nac.Green", "C1109140", *_vgiss("VGISS_8206", "C11091XX", "C1109140"),
                      "vg-iss-2-n-c1109140"),
            ImageSpec("voyager.nac.Orange", "C1109104", *_vgiss("VGISS_8206", "C11091XX", "C1109104"),
                      "vg-iss-2-n-c1109104")],
    reference_image=1,
    calibration_sigma=0.10, calibration_note=_VG_CAL,
    doc_sources=[vs.VGISS_TUTORIAL, vs.VGISS_PROCESSING], parity_reference=_VG2_PARITY, common_roll=True,
    rois=_DISK_ROIS, archive_citation=_VGISS_CITE,
    notes=["A second ORANGE frame of the same sequence (C1109153, 30.72 s) reads ~5 % brighter at the 99th "
           "percentile and has a +0.02 sky offset; the 15.36 s frame (sky ≈ 0) is used.",
           "Neptune's clouds (the Great Dark Spot, bright companions) move between frames; ROI means average over "
           "them, and the renderer has no time-matched cloud map for Neptune: the ROIs test the disk-integrated "
           "albedo and the limb-darkening law.",
           "The pointing fit's roll is weakly constrained on this nearly featureless disk. The recorded "
           "validation-fit-repro starting-point probe (2026-10-07) shifted the optimizer's x start and simplex "
           "x coordinates by 0.001 output pixel at each refinement: common roll moved +0.1835 degrees, Green "
           "centre moved (+0.060, +0.010) pixels, and maximum finite reference I/F difference was 0.02225524 "
           "with 198 finite-mask changes. Probe-minus-unperturbed expectations in the unperturbed build's "
           "2-sigma tolerance units, in X/Y/Z/S order: disk-centre [0.001113690, 0.0006406582, 0.0003535027, "
           "0.0002490441]; limb [-0.004216226, -0.002484336, -0.005605099, -0.003632766]; terminator "
           "[-0.02169443, -0.02453043, -0.01479793, -0.02117054] (rectangle moved from [201,146,204,149] "
           "to [201,147,204,150]); disk-integrated [0.0002161755, 0.0001308588, 0.0001121974, "
           "0.00007234042]. Sky-near upper-limit changes were [0.0001820, 0.0001879, 0.0001960, "
           "0.0004463] in cd/m2 (X/Y/Z) and scotopic cd/m2 (S); upper limits have no symmetric tolerance. "
           "Sky-far was unknown in both probe builds, so no tolerance-unit sensitivity was measured there. "
           "This diagnostic is not a roll covariance or a fitted uncertainty; the production optimizer, "
           "start, regions and tolerance rule are unchanged."],
)

URANUS = FrameCase(
    id="uranus-voyager2-1986",
    title="Uranus, Voyager 2 narrow-angle camera, 1986-01-14",
    summary="The whole, nearly featureless disk of Uranus (south pole towards the Sun) from 13.0 million km at "
            "phase 13.8°, in the VIOLET, BLUE, ORANGE and GREEN filters (15:34-15:53 UTC).",
    target=799, observer="@-32", observer_name="Voyager 2", instrument="Voyager 2 ISS NAC", reader="voyager",
    pixel_rad=_VG_PIXEL, pixel_note=_VG_PIX_NOTE, bin=4,
    images=[ImageSpec("voyager.nac.Violet", "C2654450", *_vgiss("VGISS_7204", "C26544XX", "C2654450"),
                      "vg-iss-2-u-c2654450"),
            ImageSpec("voyager.nac.Blue", "C2654456", *_vgiss("VGISS_7204", "C26544XX", "C2654456"),
                      "vg-iss-2-u-c2654456"),
            ImageSpec("voyager.nac.Green", "C2654514", *_vgiss("VGISS_7204", "C26545XX", "C2654514"),
                      "vg-iss-2-u-c2654514"),
            ImageSpec("voyager.nac.Orange", "C2654502", *_vgiss("VGISS_7204", "C26545XX", "C2654502"),
                      "vg-iss-2-u-c2654502")],
    reference_image=2,
    calibration_sigma=0.10, calibration_note=_VG_CAL,
    doc_sources=[vs.VGISS_TUTORIAL], parity_reference=_VG2_PARITY, common_roll=True,
    rois=_DISK_ROIS, archive_citation=_VGISS_CITE,
)

# ---------------------------------------------------------------------------------------------- Pluto

PLUTO = FrameCase(
    id="pluto-nh-lorri-2015",
    title="Pluto, New Horizons LORRI, 2015-07-13 (one day before closest approach)",
    summary="The whole disk of Pluto, Sputnik Planitia near the centre, from 1.05 million km at phase 15.8°; "
            "LORRI panchromatic (350-850 nm), 5.2 km per pixel.",
    target=999, observer="@-98", observer_name="New Horizons", instrument="New Horizons LORRI (1×1)",
    reader="lorri", pixel_rad=4.963e-6,
    pixel_note="4.963 µrad per pixel from the FITS WCS CD matrix (Weaver et al. 2020: 4.96 µrad); distortion "
               "< 0.1 pixel (the header's SIP terms)",
    bin=4,
    images=[ImageSpec("lorri.Pan", "LOR_0299104109",
                      f"{RMS}/volumes/NHxxLO_xxxx/NHPELO_2001/data/20150713_029910/lor_0299104109_0x636_sci.fit",
                      None, "nh-lorri-lor_0299104109")],
    calibration_sigma=0.02,
    calibration_note="Weaver et al. (2020): absolute sensitivity accurate to ~2 % (1σ) for solar-type spectra; the "
                     "band I/F here uses the solar-spectrum keyword RSOLAR (SOC ICD §9.3.9; value of Weaver et al. "
                     "2020 Table 2, equal to this product's header), i.e. it is the "
                     "solar-weighted LORRI band average, and colour enters only through synthetic photometry with "
                     "the LORRI response (the spectral-model term), as Weaver et al. recommend for non-solar targets. "
                     "True exposure = EXPTIME + 0.6 ms (Spencer & Weaver 2020) for products archived before 2020.",
    doc_sources=[vs.NH_SOC_ICD, vs.WEAVER_2020, vs.LORRI_EXPTIME],
    rois=_DISK_ROIS,
    archive_citation="New Horizons LORRI calibrated (Level 2) images, data set NH-P-LORRI-3-PLUTO-V3.0 (PDS Small "
                     "Bodies Node), volume NHPELO_2001 as distributed by the PDS Ring-Moon Systems Node (instrument: "
                     "Cheng, A. F. et al. 2008, Space Science Reviews 140, 189-215, DOI:10.1007/s11214-007-9271-6).",
    notes=["Single band: the XYZS expectation takes the ROI's spectral shape from Pluto's disk-integrated spectrum "
           "(label 'estimated'), with the difference to a grey spectrum as its uncertainty; Pluto's regional colour "
           "differences (Cthulhu's red vs. Sputnik's white) are larger than that inside some ROIs.",
           "The renderer's Pluto surface comes from the New Horizons MVIC global colour maps; ROI texture (std) is "
           "counted in the noise term."],
)

# ---------------------------------------------------------------------------------------------- EPOXI Earth + Moon

_EPOXI_BASE = "https://pdssbn.astro.umd.edu/holdings/dif-e-hriv-3_4-epoxi-earth-v2.0/data/rad/2008/150/"


def _epoxi(n: int) -> str:
    return f"{_EPOXI_BASE}hv08052902_{n:07d}_001_r.fit"


EARTH_MOON = FrameCase(
    id="earth-moon-epoxi-2008",
    title="Earth and Moon together, EPOXI HRI-VIS, 2008-05-29 02:04 UTC",
    summary="The Earth (phase 75°) and the Moon beside it, 11 hours before the Moon crossed the Earth's disk as "
            "seen by the EPOXI (Deep Impact) spacecraft 49.5 million km away; five visible filters within 14 s.",
    target=399, observer="@-140", observer_name="EPOXI (Deep Impact flyby spacecraft)",
    instrument="EPOXI HRI-VIS (defocused, PSF FWHM ~9 px)", reader="epoxi", pixel_rad=2.0e-6,
    pixel_note="2.000 µrad per pixel (the archive index: pixel scale 99034.2 m at range 49 517 107 km); the "
               "telescope is out of focus (PSF FWHM ~9 pixels, EPOXI calibration pipeline summary): only "
               "disk-integrated and deep-interior ROIs are meaningful",
    bin=2,
    images=[ImageSpec("hriv.Violet", "HV08052902_1000117_001", _epoxi(1000117), None),
            ImageSpec("hriv.Blue", "HV08052902_1000115_001", _epoxi(1000115), None),
            ImageSpec("hriv.Green", "HV08052902_1000116_001", _epoxi(1000116), None),
            ImageSpec("hriv.Orange", "HV08052902_1000121_001", _epoxi(1000121), None),
            ImageSpec("hriv.Red", "HV08052902_1000119_001", _epoxi(1000119), None)],
    reference_image=2,
    calibration_sigma=0.05,
    calibration_note="EPOXI Calibration Pipeline Summary (2014): 'The uncertainty in conversion to absolute "
                     "radiometric units is estimated to be 5% for HRI-VIS except for the 950-nm filter'. Taken as "
                     "5 % (1σ), fully correlated between filters; the Moon/Earth ratios are free of it. The 350, 550 "
                     "and 650 nm filters have red leaks (same document).",
    doc_sources=[vs.EPOXI_CAL_SUMMARY],
    rois=[RoiSpec("earth-disk-integrated", "disk-integrated", target=0, margin=10),
          RoiSpec("moon-disk-integrated", "disk-integrated", target=1, margin=10),
          RoiSpec("earth-centre", "disk-centre", 5, target=0, margin=6),
          RoiSpec("sky-near", "sky-near", 5, clear=12), RoiSpec("sky-far", "sky-far", 5, clear=12)],
    archive_citation="EPOXI HRIV Earth observations - calibrated images, DIF-E-HRIV-3/4-EPOXI-EARTH-V2.0, NASA PDS "
                     "Small Bodies Node (McLaughlin, S. A., Carcich, B., Sackett, S. E., Klaasen, K. P. et al. 2012); "
                     "observations: Livengood, T. A. et al. (2011), Astrobiology 11, 907-930, "
                     "DOI:10.1089/ast.2011.0614.",
    others=[301], fit_with_others=True,
    ratios=[("moon-disk-integrated", "earth-disk-integrated")],
    notes=["The pointing is fitted to the Earth and the Moon together (each with its own amplitude); their places "
           "come from Horizons (EPOXI → Earth, EPOXI → Moon). The roll is then set from the Moon's observed position "
           "(its centroid brought onto its predicted place) and the Earth's position refitted; the parity is the one "
           "that then also explains the Earth's lit side.",
           "MULT2IOF normalises to the Earth's Sun distance; the Moon's differs by < 0.3 %, and the XYZS radiances "
           "use the same distance as the I/F, so they are unaffected.",
           "The renderer's Earth has the 2026-09-28 clouds, not those of 2008-05-29: the Earth ROIs test the "
           "cloud-statistical brightness; the Moon ROI and the Moon/Earth ratio are the sharper tests."],
)

# ---------------------------------------------------------------------------------------------- Jupiter system (LORRI)

_NHJU = f"{RMS}/volumes/NHxxLO_xxxx/NHJULO_2001/data"
_LORRI_JUP_CAL = ("As for Pluto: Weaver et al. (2020) give ~2 % (1σ) for the solar-spectrum keyword; this 2007 archive "
                  "carries the pre-flight keyword values (RSOLAR 266400 for 1×1), so the in-flight value of Weaver et "
                  "al. (2020) Table 2 (234900) is used, justified by their finding that LORRI's sensitivity did not "
                  "change at the ~1 % level over the mission; 2 % (1σ). Exposures of 3-16 ms: the +0.6 ms true-"
                  "exposure offset (Spencer & Weaver 2020, determined from 2007 Io images to ±0.01 ms) is applied.")
_LORRI_ARCHIVE = ("New Horizons LORRI calibrated (Level 2) images of the Jupiter encounter, PDS data set "
                  "NH-J-LORRI-3-JUPITER, volume NHJULO_2001 as distributed by the PDS Ring-Moon Systems Node "
                  "(instrument: Cheng, A. F. et al. 2008, Space Science Reviews 140, 189-215, "
                  "DOI:10.1007/s11214-007-9271-6).")
_LORRI_NOTES = ["Single band (350-850 nm): the XYZS expectation takes its spectral shape from the body's "
                "disk-integrated spectrum ('estimated'), with the difference to a grey spectrum as uncertainty."]


def _lorri_case(cid: str, naif: int, name: str, date: str, folder: str, product: str, summary: str,
                binning: int) -> FrameCase:
    return FrameCase(
        id=cid, title=f"{name}, New Horizons LORRI, {date}", summary=summary, target=naif, observer="@-98",
        observer_name="New Horizons", instrument="New Horizons LORRI (1×1)", reader="lorri", pixel_rad=4.963e-6,
        pixel_note="4.963 µrad per pixel (FITS WCS; Weaver et al. 2020: 4.96 µrad); distortion < 0.1 pixel",
        bin=binning,
        images=[ImageSpec("lorri.Pan", product.upper(), f"{_NHJU}/{folder}/{product}_0x630_sci.fit", None,
                          f"nh-lorri-{product}")],
        calibration_sigma=0.02, calibration_note=_LORRI_JUP_CAL,
        doc_sources=[vs.NH_SOC_ICD, vs.WEAVER_2020, vs.LORRI_EXPTIME], rois=_DISK_ROIS,
        archive_citation=_LORRI_ARCHIVE, notes=list(_LORRI_NOTES))


JUPITER_LORRI = _lorri_case(
    "jupiter-nh-lorri-2007", 599, "Jupiter", "2007-01-22", "20070122_003173", "lor_0031736039",
    "The whole disk of Jupiter from 60.4 million km at phase 9.8°, five weeks before the New Horizons flyby; "
    "300 km per pixel.", 4)
IO_LORRI = _lorri_case(
    "io-nh-lorri-2007", 501, "Io", "2007-02-27", "20070227_003484", "lor_0034844219",
    "Io from 2.69 million km at phase 35.7°, 13.4 km per pixel, two days before closest approach.", 2)
EUROPA_LORRI = _lorri_case(
    "europa-nh-lorri-2007", 502, "Europa", "2007-02-27", "20070227_003484", "lor_0034849319",
    "Europa from 3.20 million km at phase 28.3°, 15.9 km per pixel.", 2)
GANYMEDE_LORRI = _lorri_case(
    "ganymede-nh-lorri-2007", 503, "Ganymede", "2007-02-26", "20070226_003478", "lor_0034784234",
    "Ganymede from 4.96 million km at phase 29.0°, 24.6 km per pixel.", 2)
CALLISTO_LORRI = _lorri_case(
    "callisto-nh-lorri-2007", 504, "Callisto", "2007-02-27", "20070227_003485", "lor_0034858514",
    "Callisto from 4.75 million km at phase 46.4°, 23.6 km per pixel.", 2)

CASES: dict[str, FrameCase] = {c.id: c for c in (SATURN, NEPTUNE, URANUS, PLUTO, EARTH_MOON, JUPITER_LORRI,
                                                 IO_LORRI, EUROPA_LORRI, GANYMEDE_LORRI, CALLISTO_LORRI)}
