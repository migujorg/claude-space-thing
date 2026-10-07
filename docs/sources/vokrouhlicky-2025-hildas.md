# Vokrouhlický et al. (2025): Hilda model input, inactive

Read against generator commit `aa04a34`. The research table
`pipeline/src/pipeline/syn_tables/hilda_2025.json` is loaded only by
`pipeline.syn_sources.hilda_model()` and its tests. The synthetic stage does
**not** consume or register it. Current product/inspector statements remain true.

Source: Vokrouhlický, Nesvorný, Brož, Bottke, Deienno, Fuls & Shelly,
*Orbital and absolute magnitude distribution of Hilda population*, AJ 169, 242
(2025), [arXiv:2503.04403v1](https://arxiv.org/pdf/2503.04403).
The retrieved author manuscript is explicitly v1, not claimed to be the final
publisher version. Read abstract, §§2–5 and Appendices B–D, including Tables
1–3; Appendix A's physical properties provide context, not new debiased
physical-attribute laws.

## What the model supports

CSS G96 January 2013–June 2022, separated into two camera phases, provides a
selection-calibrated fit to four approximate proper parameters `(a_p, e_p,
sin I_p, varpi_p)` plus visual absolute magnitude H. The fitted background is
a product of Eq. 4 marginals with uniform intrinsic proper perihelion
longitude. The fitted model includes Hilda, Schubart and Potomac families;
Francette, Guinevere and 2008 TG106 are too small for that fit and are omitted.
Family orbital templates are fixed from observed members, rather than
independently fitted debiased joint family distributions. Family magnitude
parameters and the background parameters are calibrated through the CSS
selection function. Independence of the marginals is an explicit model
assumption, with residual family/background leakage discussed in §5.3.

Table 1 covers a_p=3.95–4.05 au, e_p=0–0.32, sin I_p=0–0.35,
varpi_p=0–360°, and H=7.5–18. §3.2 expects reliable results only through about
H=17: very few CSS detections constrain 17.75–18. Table 2 reports background
magnitude segments only through 17. The table preserves both the fit grid and
this reliability limit; neither is permission to extrapolate to the present
H=18.25 synthetic floor.

The background normalization is 1,605 ± 36 at H=16; the combined three-family
normalization is 1,451 ± 65 there. Schubart is 738 ± 22; its mean cumulative
slopes are 1.00 ± 0.18 (12–14), 0.62 ± 0.04 (14–15), 0.63 ± 0.02 (15–16),
and 0.44 ± 0.02 (16–17). Other background coefficients and their formal errors
are in the input table. Slopes describe **log-cumulative** magnitude splines,
not independent differential power laws. Table 2's first mean slope is 0.47;
the prose rounds it to 0.46. The transcription uses the table.

§5.4 warns that these errors are formal and depend on model choice, not full
systematic uncertainties. In Appendix B the single adopted κ=κ′=1.47 replaces
orbit-dependent values (κ roughly 1–2.5). No individual synthetic orbit
covariance or perceptual position bound follows from that approximation.

## Mapping and missing information

Appendix B model parameters differ from Appendix C's numerical proper elements
in the public 6,393-row catalogue. The latter catalogue cannot be drawn as if
its a_p were the model's semimajor-axis extremum. In B.3 the eccentricity and
perihelion are recovered via B11 or approximate B12; the inclination and node
via B13 and a uniform proper node. Semimajor axis and longitude must be sampled
jointly on the numerically averaged Hamiltonian B8–B9 level curve, using the
canonical transforms B3–B7 and both longitude branches. They must not be
replaced by independent catalogue marginals. The model is in the solar-system
invariable frame, requiring Appendix D's rotation into ecliptic J2000 and
Jupiter's sourced elements in the same frame at the product epoch.

The paper describes smooth fixed family templates but **does not tabulate their
numerical orbital coefficients**. It also does not give all Hilda/Potomac
magnitude coefficients or explicit cubic-spline end conditions. Those fields
are null/unknown in the research input. Fig. 7's curves have preliminarily
guessed coefficients, explicitly unsuitable as the final fitted parameters.
Public HCM lists supply observed membership and Appendix C elements, not
those missing fitted coefficients. The paper does not supply debiased albedo,
colour or rotation distributions or a reliable faint population past its limit.

## Count review: activation stopped

Joining the published family lists to the 2026-10-03 SBDB product by number or
provisional designation (including the aliases in names.txt) gives, in
7.5 ≤ H < 16, **623 Hilda + 675 Schubart + 271 Potomac = 1,569** distinct
eligible asteroidal objects. All satisfy the current generator's Hilda-region
mask; no joined object in that magnitude interval is excluded by that mask.
The published combined fitted family normalization is **1,451 ± 65**: an excess
of **118**, or 1.82 times the formal quoted model error. This is not a calibrated
significance test. HCM membership differs from the fit's component assignment.
The paper itself discusses Hilda/Potomac template undershoot and members
assigned to background. The model's total normalization (3,056) and the broad
current-region known count (3,051) do not establish a total-population excess.

The task explicitly requires stopping at the table when known counts exceed
the model. Accordingly no fitted normalization is increased, no family
coefficient is reconstructed by tuning, and no draw or product-method claim is
activated. Root must decide whether to use the fitted component definition and
its leakage, obtain missing published model coefficients, or pursue another
source. Merely renormalizing the fitted families to these HCM counts would
change the published model.

Evidence/reproduction resides in the lane folder:
`compare_hilda_counts.py`, `hilda-count-review.json`, `counts-baseline.json`,
`retrievals.json`, and the downloaded files under `sources/`. The count report
pins core.bin SHA256
`6decd4d6b6694a4f293d28cd82012644058604b42acb85528ffb67b53cfdd38f`.
The current catalogue lacks one of the 1,066 Hilda-family identities;
Schubart and Potomac have all 1,882 and 506 joined identities respectively.
No classification of new discoveries into new families is invented.

## Retrieval record

All times UTC on 2026-10-07. Files were saved in the lane folder, not a raw
pipeline cache; the table includes paper/catalogue SHA256. The Zenodo metadata
was checked **before** downloading any catalogue/list; all are below 200 MB.

| URL | Time UTC | Bytes | Read |
|---|---|---:|---|
| https://arxiv.org/pdf/2503.04403 | 15:25:24.390569 | 4,668,546 | Sections/tables specified above |
| https://sirrah.troja.mff.cuni.cz/~mira/tmp/hildas/ | 15:25:54.894938 | 81 | Entire index, archive link only |
| https://zenodo.org/api/records/14959239 | 15:25:56.824863 | 8,205 | Entire metadata/file sizes; resolved version 14959240 |
| https://zenodo.org/api/records/14959240/files/astorb_astdys_wise_akari_sloan.dat_WITH_PROPER_ELMTS/content | 15:26:11.203256 | 7,978,464 | 6,393 rows, identifiers/H/proper-element column layout |
| https://zenodo.org/api/records/14959240/files/astorb_astdys_wise_akari_sloan.lbl/content | 15:26:17.289017 | 7,855 | Entire label/column definitions |
| https://zenodo.org/api/records/14959240/files/1345_Potomac_family.list_140_WO_INTERLOPERS/content | 15:27:08.184774 | 631,896 | All membership identifiers/H |
| https://zenodo.org/api/records/14959240/files/153_Hilda_family.list_090_WO_INTERLOPERS/content | 15:27:10.447834 | 1,330,776 | All membership identifiers/H |
| https://zenodo.org/api/records/14959240/files/1911_Schubart_family.list_060_WO_INTERLOPERS/content | 15:27:14.079334 | 2,349,136 | All membership identifiers/H |

The Zenodo record licenses the catalogue CC-BY-4.0. The source paper is an
author manuscript. A pipeline Download/SourceRecord must be registered when
and only when an activated stage uses these inputs; this preparatory table
must not make current products claim the new model.
