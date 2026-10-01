# Titan's haze, methane and surface (atmospheres.json `606`) — transcriptions and digitizations

The Huygens probe measured Titan's haze from inside during its descent of 2005 January 14 (DISR: Descent Imager /
Spectral Radiometer). The primary papers that turned these measurements into the haze's optical properties are
paywalled: Tomasko et al. (2008, *Planet. Space Sci.* 56, 669–707, DOI 10.1016/j.pss.2007.11.019) and Doose et al.
(2016, *Icarus* 270, 355–375, DOI 10.1016/j.icarus.2015.09.039). No value below is taken from them directly; each comes
from an open publication that reproduces them, named with its route. Everything is fetched through the download
ledger (`pipeline/src/pipeline/photometry/atmo_sources.py`, `moons.py`, `albedo.py`).

| Quantity | Route (open) | File | Label |
|---|---|---|---|
| Haze extinction β(z, λ) | Tomasko et al. (2008) model as transcribed by Bazzon et al. (2014, A&A 572, A6, App. A.4; arXiv:1409.3421) | `tables/titan_disr_haze.json` (`bazzon_A4`) | estimated |
| Haze single-scattering albedo (below 80 km, above 200 km) | Doose et al. (2016) as plotted in Barnes et al. (2018, AJ 156, 247, Fig. 4; free to read) | `tables/titan_doose_2016_ssa.csv` | estimated |
| The altitude rule between them | Doose et al. as stated by Es-sayeh et al. (2023, PSJ 4, 44, §2.2; CC BY, HAL copy) | `tables/titan_disr_haze.json` (`doose_2016_ssa_rule`) | — (a check) |
| Haze phase functions (below and above 80 km) | Tomasko et al. (2008, Table 1), machine-readable in the reference data of Adamkovics et al. (2016, Icarus 270, 376; the authors' open radiative-transfer package) | `atmospheres/titan/Tomasko2007_phase_{0-80,80-200}km.TAB` | estimated |
| Methane absorption coefficient k(λ) | Karkoschka (1998, Icarus 133, 134), PDS GBAT_0001 `1995LOW.TAB` columns 2–3 | (as for the giant planets, `karkoschka-1998.md`) | estimated (the PDS label's "estimated") |
| Methane mole fraction x(z) | Huygens GCMS (Niemann et al. 2010, JGR 115, E12006), PDS hpgcms_0001, at the DTWG reconstructed altitudes (Kazeminejad et al. 2007, PSS 55, 1845), PDS hpdtwg_0001 | `atmospheres/titan/` | measured |
| Surface reflectance under the haze | the values García Muñoz et al. (2017, Nat. Astron. 1, 0114; arXiv:1704.07460, Methods) adopted from Karkoschka & Schröder's (2016) DISR maps | `tables/titan_disr_haze.json` (`garcia_munoz_2017_surface`) | estimated |
| Validation: Cassini ISS phase curves | García Muñoz et al. (2017, Fig. 1) | `tables/titan_garcia_munoz_2017_iss.csv` | (not an input) |

## Single-scattering albedo: Barnes et al. (2018), Fig. 4

Barnes et al. "assume values from Doose et al. (2016) for wavelengths shorter than 0.9 µm. As recommended by Doose
et al. (2016), we have one single-scattering albedo for below 80 km, another one for above 200 km, and we interpolate
linearly in between." Their Fig. 4 is vector graphics. `titan_digitize.py` converts page 3 of the PDF (the ledger's
copy, sha256 `edd61cbe…`; the publisher answers scripted clients with a bot check, so the copy was placed by hand,
which `Download` accepts by its digest) to SVG with poppler's `pdftocairo` and reads the two blue strokes:

- the stroke colours separate the curves (light blue: above 200 km; dark blue: below 80 km);
- the cubic Bézier segments are sampled every 1/8 segment and repeated vertices dropped (43 vertices);
- x is calibrated on the five major ticks (1–5 µm; residual 0.0004 µm), y on the six ticks of the left axis
  (0–1; residual 0.0001);
- both curves start at 499.8 nm; rows stop at 865 nm, before the figure's seam to other sources near 870 nm.

**Check.** Es-sayeh et al. (2023, §2.2) state Doose et al.'s relation ω(< 80 km) = (0.565 + ω(> 200 km))/1.5. The
digitized curves obey it to 0.0005 at every vertex (`tests/test_atmospheres.py`). The below-80-km curve reaches
1.0002 near 780 nm as drawn; the pipeline caps ω at 1.

**Below 500 nm** Doose et al. give nothing in the figure, and García Muñoz et al. (2017) call the DISR albedo "poorly
constrained shortwards of 490 nm". The pipeline continues the above-200-km curve along the line through its
500–600 nm vertices and derives the other from the rule. This extrapolation is where the model fails against
Titan's measured colour (docs/reports/atmospheres.md, "Titan").

## Phase functions: Tomasko et al. (2008) Table 1 via Adamkovics et al. (2016)

Adamkovics et al. (arXiv:1509.08835, §3.2) fit Legendre polynomials "to the phase functions tabulated" by Tomasko
et al. and ship the tables as reference data of their open package: two files, the haze below 80 km and above
80 km, columns at 355, 430, 491, 600, 713, 822, 935 nm … 5166 nm, rows 0–180° in 1° steps. Below 600 nm the two
regions are identical in the table; from 713 nm the below-80-km functions have the stronger backscatter. The rows
integrate to 1.001–1.011 over the sphere (log-linear in angle through the 0–10° peak); the pipeline renormalizes
each to 1. A secondary copy, so **estimated**.

## Methane

β_CH4(z, λ) = k(λ)·x(z)·n(z)/n_L: Karkoschka's (1998) cold-temperature coefficients (1 nm resolution; Karkoschka
1994: "one cold-temperature methane spectrum is sufficient to model methane absorptions for all jovian planets and
Titan"), the GCMS stage-2 mole fraction placed at the DTWG altitude of each sample (1 km bins; 4.90 % at the surface,
1.41 % at 146 km and held above), and the HASI density. Column 2.80 km-amagat. Niemann et al. (2010) later revised
the GCMS fractions to 5.65 % and 1.48 %; the PDS product is used as archived (noted in the product). atmospheres.json
stores 10 nm box averages of β and, on the methane component, k at 1 nm and x(z).

## Surface

García Muñoz et al. (2017, Methods) used surface albedos 0.023–0.151 at their filters' effective wavelengths
(306–938 nm), "from Karkoschka & Schröder (2016)" (Icarus 270, 260–271: the DISR eight-colour maps around the
landing site; Table 1 not accessible here). One landing-site spectrum, Lambertian, for the whole globe → estimated.

## Cassini ISS phase curves: García Muñoz et al. (2017), Fig. 1

Fifteen panels (NAC filter pairs, 300–940 nm) of A_gΦ(α) for 0–166°, from 5766 calibrated images of 2004–2015 with
aperture photometry inside 3500 km + 10 px of Titan's centre, normalized to the 2575 km solid radius. The paper
gives no table ("available from the corresponding author upon reasonable request"); the figure is vector graphics.
`titan_digitize.py` reads page 19 of the arXiv preprint (ledger copy of `arXiv-1704.07460v1.pdf`): the black
diamond markers' centres in each panel, each panel calibrated on its own major ticks (residuals ≤ 0.018° and
≤ 6e-5 in A_gΦ). It finds 90–100 % of the image counts the paper gives per filter (e.g. 16 of 16 UV2_CL2, 320 of 327
CL1_GRN, 1706 of 1902 CL1_CB3): markers that coincide in the drawing are one path. CISSCAL's absolute calibration is
~10 % (User Guide §5.10.1). The curves are used only to test the model and the renderer; the photometric phase
function of Titan's point light (photometry.json) still stops at 5.7° (`garcia-munoz-2017.md`).
