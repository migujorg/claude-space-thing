# Pluto's haze (New Horizons) (`gladstone-2016`, `cheng-2017`)

Transcribed: `pipeline/src/pipeline/photometry/tables/pluto_haze.json`. Code: `photometry/atmo_bodies.py`.

- **Gladstone, G. R., et al. (2016).** The atmosphere of Pluto as observed by New Horizons. *Science* 351, aad8866, DOI [10.1126/science.aad8866](https://doi.org/10.1126/science.aad8866); text arXiv:1604.05356v1, "Hazes" (p. 8–9): hazes to > 200 km with brightness scale heights ~50 km, ~30 km at 100–200 km; I/F ≈ 0.2–0.3 (MVIC red 540–700 nm, LORRI) and up to 0.7–0.8 (MVIC blue 400–550 nm) at phase 165–169°; I/F ~ 0.02 at 38°, ~0.003 at 20°; Mie estimate with tholin-like n = 1.69, k = 0.018 at 607.6 nm, radii ≥ 0.2 µm, P(165°) ≈ 5 (P at PHASE angle 165°), τ_LOS ≈ 0.16, vertical scattering optical depth ≈ 0.013, Q_S ≈ 2.7.
- **Cheng, A. F., et al. (2017).** Haze in Pluto's atmosphere. *Icarus* 290, 112–133, DOI [10.1016/j.icarus.2017.02.024](https://doi.org/10.1016/j.icarus.2017.02.024); text arXiv:1702.07771v2, Table 4 (p. 22): haze I/F at the peak above the surface and at 45 km, at phase 20°, 67°, 148°, 167° (LORRI, 607.6 nm).

**Use:** `atmospheres.json` Pluto:
- `haze` component (label **estimated**): column τ_sca = 0.013 at 607.6 nm divided by the Mie ω; profile e^(−z/50 km) below 100 km and a 30 km scale height above; colour λ^−4.1 from the MVIC blue/red I/F ratio (3.2–5.2 over the quoted ranges), assuming a wavelength-independent phase function; SSA and phase function from Mie spheres of radius 0.2 µm with n = 1.69 + 0.018i, at all wavelengths.
- `hazeMeasurements` (label **measured**): Cheng et al.'s Table 4.

**Checks:** our Mie gives P = 4.85 at phase 165° (scattering angle 15°) and Q_sca = 2.82, matching Gladstone et al.'s ≈ 5 and ≈ 2.7. Cheng's measured I/F ratio 167°/20° at 45 km is 37.5 vs the sphere model's P ratio 28 — the real haze is more forward-scattering (Cheng et al.: aggregates, like Titan's).
