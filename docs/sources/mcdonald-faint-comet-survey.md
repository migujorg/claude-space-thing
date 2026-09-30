# mcdonald-faint-comet-survey: McDonald Observatory faint comet survey: band fluxes of CN, C3, CH, C2 (Cochran et al. 1992)

- **URL:** https://pdssbn.astro.umd.edu/holdings/pds4-gbo-mcdonald:faint_comet_survey-v1.0/data/fluxmc.tab (cached as `data/raw/comets/mcdonald/fluxmc.tab`, 233 275 bytes, sha256 7b721b90773b7ad5ef0bb35721d6fe51c82a90cf5e5d801e3c04353d0b0b2e9e; `data/raw/comets/mcdonald/fluxmc.xml`, 21 136 bytes, sha256 82123a4d271ea88d40cb1d0731ac2ca6a89b9be5b10c57ce433157be20e5c573; `data/raw/comets/mcdonald/description.txt`, 10 170 bytes, sha256 02633bda8b5e896d8b9572f2c86fd4b4771f81578c4266d4c40ece8692e603a5; retrieved 2026-09-30).
- **Recorded sha256:** 9022d2f92060a61d73c1e1407a9a40bdeb6d3e5c88b4910c527765c2e79afd47 (SHA-256 over the per-file sha256 values, one per line, file order).
- **Citation:** Cochran, A. L., Barker, E. S., Ramseyer, T. F. & Storrs, A. D. (1992). The McDonald Observatory faint comet survey: gas production in 17 comets. Icarus 98, 151-162. DOI:10.1016/0019-1035(92)90088-2. Data: Cochran, A. L., Barker, E. S., Ramseyer, T. F. & Storrs, A. D., McDonald Observatory Faint Comet Spectro-Photometric Survey (PDS4 Format), Tholen, D. (ed.), urn:nasa:pds:gbo-mcdonald:faint_comet_survey::1.0, NASA Planetary Data System, 2019.
- **Licence:** NASA Planetary Data System (public).

## Contents

152 observations of 17 comets (1981–1990), flux-calibrated Intensified Dissector Scanner spectra with a colour-corrected solar spectrum removed: log band flux (erg cm⁻² s⁻¹) of CN (Δv = 0, 3830–3905 Å), C3 (3975–4150 Å), CH (4280–4340 Å), C2 Δv = +1 (4460–4770 Å), C2 Δv = 0 (4860–5185 Å) and NH2 (0,10,0) (5675–5760 Å), each at its aperture offset from the photocentre; description.txt lists the band windows and the fluorescence efficiencies used by Cochran et al. (1992).

## How it is used

`comet_model.mcdonald_band_ratios`: the median flux ratios F(band)/F(C2 Δv = 0) over observations whose two apertures sample the same place in the coma (offsets within 5 %): C2 Δv = +1 0.50 (n = 771), CH 0.032 (n = 248) — measured band strengths that place the light of C2 Δv = +1 and CH relative to C2 Δv = 0 in the gas spectrum. The band windows define where each band's light falls in wavelength. The C2 ratio agrees with the ratio of the dataset's own fluorescence efficiencies (0.54) within 7 % (pipeline test).

## Caveats

- The NH2 column holds positive logarithms, inconsistent with its stated unit (erg cm⁻² s⁻¹); it is not used.
- The offsets of one exposure differ by band (atmospheric dispersion); only observations far enough from the photocentre that the relative difference is below 5 % are compared.
