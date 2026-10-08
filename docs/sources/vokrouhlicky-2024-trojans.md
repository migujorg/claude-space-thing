# Vokrouhlický et al. (2024): Trojan model inputs, inactive

The [author manuscript, arXiv:2401.15537v1](https://arxiv.org/abs/2401.15537),
*Orbital and absolute magnitude distribution of Jupiter Trojans*, is audited
in `pipeline/src/pipeline/syn_tables/trojan_2024.json`. No draw uses its fitted
parameters. Only its citation is registered in `sources.json` so the existing
synthetic population and inspector can explain why this model is not used.
The current catalogue extrapolation, faint slope, seed, conditioning and
resonant-angle templates stay unchanged.

## Draw requirements: given / not given

| Required input | Given? | Evidence and consequence |
|---|---|---|
| Separate L4/L5 background orbital shape | Given | Eqs. 5–8 and Table 3 supply all eight orbital coefficients per cloud with formal errors. Fig. 10 parameters are preliminary fits to the **biased** catalogue and are not replacements. |
| Coupled stable domain and its normalization volume | Not given numerically | §3.1.1 and Figs. 12–14 describe 100 Myr clone integrations and show boundaries; §4.2 excludes unstable bins. The actual A/B/C mask is not tabulated. Treating the Table 2 box as entirely stable or digitizing a chosen boundary changes the model. |
| Background magnitude knots, slopes, normalization | Partly given | Table 3 gives six mean cumulative slopes and Nback(<14.5)=3,951 ±44 (L4), 2,664 ±39 (L5). It does not give the cubic-spline end conditions. Continuity including the first derivative (§3.1.2) does not specify them. Hr=14.5 is inside a segment, so even endpoint counts cannot be uniquely anchored without interpolation. |
| Family orbital template coefficients | Given | Table 1 supplies the ten Eq. 10–12 parameters for seven families; Thronium uses the explicitly stated C boxcar [1.5,1.53] instead. These masks were fixed from observed family distributions, not refitted during the debiasing. |
| Real-valued family densities on the draw domain | Not fully specified | Eqs. 10–11 print signed A−Aref and B−Bref powers, without absolute values or a domain cutoff, although Table 1 includes fractional powers and interior offsets. Eq. 12 also has fractional powers below Cref for Eurybates/Hektor. Neither an absolute-value repair nor one-sided truncation is inferred here. |
| Every family's H range, knots and fitted mean slopes | Not given | §3.1.2 describes four segments for Eurybates/Arkesilaos and three for smaller families. §5.2 gives typical H1≈12.2–13.3 and H2≈14.7–15, with individual limits only depicted in Fig. 23. Complete numerical family fits are not tabulated. |
| Normalization per fitted family and total per cloud | Partly given | §5.2 quotes Eurybates 385 ±20 and Deiphobus 210 ±10 at H<14.5 and their last slope changes. Six other fitted normalizations are not tabulated. Table 1/Appendix A HCM membership is observed membership, not bias-corrected fitted component normalization. Background Nback cannot stand in for the total. |
| Proper-model coordinates to osculating elements | Approximate mapping given | Eqs. 1–4 and §4.1/Eqs. 19–22 map A/B with uniform free angles and C with a uniform shifted/scaled polar angle to heliocentric elements. a and lambda must be solved **jointly** on the C isoline. Uniform sigma or independent a/longitude is a different model. |
| Mapping at the product epoch and exact axes/units | Partly given; unresolved | Paper initializes at MJD 60000 (2023-02-25); product uses 2026-10-04 TDB. Sourced same-frame Jupiter elements and mass ratio at the target epoch would be needed. The model discusses MPC heliocentric elements and the ecliptic, but does not explicitly name its reference equinox/rotation or the angular/unit convention of the 0.2783 coefficient in Eq. 19. Exact transport to the product epoch is not provided as a fitted realization. These are clarification/integration requirements, not evidence that the supplied approximate mapping is absent. |
| Supported magnitude range | Given with limits | Nominal H=7–15; L5 beyond about 14 is explicitly unreliable. Table 2's H=7–17 is the selection grid, not fit support. L4 extension to 15.5 is cautionary and inconsistent with nominal local slope at 15. No extension to the current H_V=17.65 floor is justified by this source alone. |

**Stop before any draw or catalogue/model count comparison.** The numerical
stability mask, complete family H fits and real-density/spline conventions are
missing. A background-only sampler, reconstructed family fit, rectangular
stability domain or ratio-rescaled catalogue would not implement the published
model. Model coefficients must never be selected by validation scenes or by
their agreement with the current catalogue.

## Scope, errors and supplied values

Read §§2–5, Tables 1–3 and Appendices A–B in full, including the preparatory
observed-population paragraph at the end of §1. The fit uses CSS G96 observations
from January 2013 to June 2022, split at the May 2016 camera upgrade. Selection
probabilities are averaged over the three complementary angular variables.
The model distinguishes five L4 and three L5 families from separate backgrounds.
Appendix A's numerical proper elements/HCM families are a separate product;
they are not the quasi-proper A/B/C fit variables, and membership cannot supply
the missing fitted normalizations. The published author index contains paper,
figures and observed proper-element/family files; it is not a fitted-model
release. No observed Trojan catalogue was downloaded for this continuation.

Table 3's caption says seven segments but lists six intervals and six gamma
rows; §§3.1.2/5.2 explicitly say six. The transcription preserves those six
segments. The slopes are mean slopes of **log cumulative** counts, not dN/dH
slopes. Tests check whole-segment ratios and telescoping relative increments;
they do not impose an unpublished spline or obtain absolute knot counts from
an interior normalization anchor. Errors are formal, with strongly correlated
orbital parameters. Combining medians with independent error draws would not
recover the posterior or a full count uncertainty.

§5.2 reports that overlapping/diffuse L5 masks and sparse faint observations
make the faint solution less reliable: flattening beyond about H=14 is described
as an artifact not to be trusted. Their inclination comparison uses H<13.5
and an independent H<12 check, not an assertion of reliable faint L5 structure.
The L4 extension's local slope at H=15 is 0.30 ±0.01 versus nominal 0.38 ±0.01;
at 15.5 it is 0.24 ±0.02. It is not adopted here. The abstract's background
ratio 1.45 ±0.05 for H<15 and conclusion's 1.43 ±0.05 at H=15 are separately
reported statements, neither a total normalization including families.

No debiased albedo, colour, rotation law, individual synthetic orbit covariance,
or arbitrary-orbit discovery veto is provided. Missing coefficients remain
null/unknown; nothing is fitted to figures, catalogue counts or rendered views.
The approximate mapping is described, but no production mapping is implemented.

## Retrieval and read evidence

Reused the existing lane download; no network request or raw-cache mutation was
made in this continuation. The original record in lane `retrievals.json` gives:

| Input | Retrieval UTC | Bytes | SHA256 |
|---|---|---:|---|
| https://arxiv.org/pdf/2401.15537 | 2026-10-07T15:25:24.517932+00:00 | 6,513,233 | `06f6b55c6edc1ca40c0f4a7ba2c508c576e3ea0404bfba97e53c4ff258186814` |
| https://sirrah.troja.mff.cuni.cz/~mira/tmp/trojans/ | 2026-10-07T15:25:58.356071+00:00 | 509 | `ebbf595cb15f7019017872ef1428968f5ddd1799dfbc9a55acad6ad832f5cfb9` |

The PDF hash was recomputed in this continuation. Poppler renders of pages 15,
19 and 25 were visually inspected for Table 1, Eqs. 10–12, mapping Eq. 19 and
Table 3; the paper's text was read for the remaining model/scope statements.
The retained manuscript says submitted to AJ, so this record cites its verified
arXiv version without guessing a published DOI. The exact mathematical
ambiguities refer to this version; a later clarification would require a new
audit before activation.
