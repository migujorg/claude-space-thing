# ssodnet-ssobft: SsODNet best-estimate flat table (ssoBFT)

- **URL:** https://ssp.imcce.fr/data/ssoBFT-latest_Asteroid.parquet (856 MB Parquet, 1,563,708 asteroids, 266 columns; the file used is dated 2026-09-22, built from the ssoCards of 2026-09-15). IMCCE updates it weekly.
- **Used by:** the `smallbodies` stage (`sb_physical_sources.read_ssobft`, `sb_physical._ssobft`) → `smallbodies/physical.bin` phase-function, spin-pole and SsODNet-taxonomy columns.
- **Citation:** Berthier, J., Carry, B., Mahlke, M. & Normand, J. (2023). SsODNet: Solar system Open Database Network. A&A 671, A151. DOI:10.1051/0004-6361/202244878. The H-G1-G2 system: Muinonen, K. et al. (2010), Icarus 209, 542. ATLAS phase curves: Mahlke, Carry & Denneau (2021), Icarus 354, 114094. Taxonomy: Mahlke, Carry & Mattei (2022), A&A 665, A26 and the Bus / Bus-DeMeo / Tholen schemes. Spins: a compilation that includes DAMIT (Ďurech et al. 2010) and the Gaia DR3 inversions (Ďurech & Hanuš 2023).
- **Licence:** free use with citation of Berthier et al. (2023).

## What is read

Only the `phase_functions.*`, `spins.*` and `taxonomy.*` columns, read with pyarrow. The flat table lists each value's error, filter, facility and technique, but not its bibcode. The per-value references are in the object's SsODNet ssoCard, and the product records the facility and technique instead.

| Attribute | Selection | Objects | Label |
|---|---|---|---|
| H, G1, G2 (+ errors, fitted phase-angle range, N) | One fit per object. The band closest to V comes first: V (fits to MPC-archive photometry, "MPCATOBS"), then Gaia G, ATLAS orange/cyan, ZTF r/g. Fits violating G1 ≥ 0, G2 ≥ 0, G1 + G2 ≤ 1 are not used (24). | 216,178 (V: 175,637) | measured |
| Spin pole (RA, Dec) and period of that solution | Spacecraft, radar, KOALA/ADAM/SAGE, occultation- or thermal-constrained, and lightcurve-inversion solutions before plain lightcurves. The statistical amplitude-magnitude (A-M) poles come last. | 79,591 (A-M: 65,185; LCI: 9,920) | measured; the technique is kept per object |
| Taxonomy (scheme, class, technique) | SsODNet's best class | 171,110 (Phot 164,487; Spec 6,623) | measured (classification); a spectrum inferred from a class would be estimated |

The phase function applies only over the phase-angle range it was fitted to (`phaseMinDeg..phaseMaxDeg`, median 1.5°–24.6°), as docs/architecture.md §4.3 requires. The catalogue H and G in `core` stay the SBDB values, because H-G1-G2 is a different system from H-G.
