# Disk-resolved photometric laws (`spatialModel` in photometry.json)

A spatial law tells the renderer how a body's light is spread across its disk: centre, limb and terminator. The disk integral stays the measured `geometricAlbedoXYZS · Φ(α)`, because the renderer rescales the law (docs/architecture.md §4.3–4.4). Without a law the renderer uses Lambert. The laws below are **published fits**. None is fitted to the project's own validation images, which remain an independent test (docs/reports/validation.md). Code: `pipeline/src/pipeline/photometry/spatial.py`.

## Label criterion

A law is **measured** only if all three of these hold:

1. it was fitted to disk-resolved images of that body;
2. it is used only within the fitted range of phase angles;
3. it holds per channel.

No entry meets all three:

- the schema has one law for X, Y, Z and S together;
- OPAL's Minnaert exponents come from images at small phase angles but are applied at every phase angle (Saturn's Barkstrom B(α) from Pioneer 11 comes closest: disk-resolved and used within its phase range, but one law for all channels and a different epoch);
- the Hapke sets come from disk-integrated phase curves, so their spatial distribution is the model's rather than an observed one.

Every entry is therefore **estimated**, and its `method` states the assumptions. `validPhaseDeg` is not set: the law applies at every phase angle rather than falling back to Lambert. The phase coverage of each source's data is given in its method text.

**Phase dependence.** The schema's `PhaseDependent` parameters already take a table (`{alphaDeg, values}`, interpolated linearly), so a measured parameter table needs no schema change. It is used where a source measures it (Saturn's B(α)).

## Sources

| Bodies | Law | Source | Data behind the fit |
|---|---|---|---|
| Jupiter, Saturn, Uranus, Neptune | Minnaert, one k (Saturn: Barkstrom B(α), below) | Hubble OPAL cycle README: the Minnaert k per WFC3/UVIS filter with which the OPAL team removed the limb darkening of the maps the app shows (MAST HLSP doi:10.17909/T9G593; Simon et al. 2015). Same epoch as `surf_giants.py`: Jupiter 2025b, Saturn 2025b, Uranus 2025b, Neptune 2025c. | Disk-resolved HST images, phase ≤ 11° (Jupiter) and less for the others |
| Europa, Ganymede, Callisto | Hapke (1993) | Domingue & Verbiscer (1997), Icarus 128, 49 (DOI:10.1006/icar.1997.5730), 550 nm, mean of the leading and trailing hemispheres. Transcribed from the open-access reproduction in Belgacem (2019), PhD thesis, HAL tel-02421378, Tables 2.5–2.7. | Disk-integrated Voyager and telescopic phase curves |
| Pluto, Charon, Triton | Hapke (2012) | Verbiscer et al. (2022), PSJ 3, 95, Table 14 | Disk-integrated Earth-based, HST, Voyager 2 (Triton) and New Horizons LORRI/MVIC phase curves |
| Saturn, 30–150° | Barkstrom B(α) | Barkstrom law A(α), B(α) of Dones et al. (1993), Icarus 105, 184, Table V, as reproduced in Dyudina et al. (2016), ApJ (arXiv:1511.04415v3), Table 3 | Disk-resolved Pioneer 11 IPP reflectances, red 0.64 µm and blue 0.44 µm, belts and zones (Tomasko & Doose 1984) |
| Io | Hapke (1981/1984) | Simonelli & Veverka (1986), Icarus 68, quoted in Simonelli & Veverka (1987), NASA Reports of Planetary Geology and Geophysics Program 1986 (NTRS 19870014003), Fig. 1 | Disk-integrated Voyager violet-filter (~0.42 µm) phase curve |
| Mimas, Enceladus, Tethys, Dione, Rhea | Akimov (parameter-free) | Filacchione et al. (2022), Icarus 375, 114803 (arXiv:2111.15541), Sec. 4 Eqs. 4–6, after Shkuratov et al. (1999) | Cassini VIMS disk-resolved spectra, i, e ≤ 70°, 10° ≤ g ≤ 120° (the form is assumed there, not fitted) |
| Mars | Hapke (1993) | Vincendon (2013), PSS 76, 87 (arXiv:1208.4518v3): the mean BRDF of typical Martian terrains | OMEGA and CRISM, aerosols removed |

### Giant planets

- **The k used:** OPAL's k varies with filter. Examples: Jupiter 0.85 at 395 nm, 0.95 at 467–502 nm, 0.999 at 631–658 nm; Neptune 0.88 / 0.80 / 0.50 at 467 / 547 / 657 nm. The renderer takes one k for all channels, so the pipeline interpolates k linearly in the filters' nominal wavelengths to the mean wavelength of the Y-channel signal (∫λ ȳ E☉ p dλ / ∫ȳ E☉ p dλ, about 560 nm). Methane-band filters and filters without a correction are left out.
- **Why this k:** rendering the OPAL map with the law that was divided out of it reproduces the HST view.
- **Values:** k = 0.972 (Jupiter), 0.719 (Saturn, at 0°), 0.788 (Uranus), 0.790 (Neptune).
- **Jupiter at larger phase:** Dyudina et al. (2016, Sec. 2.1.1) found that I/F ∝ μ0 (k = 1 at every phase) fits the Pioneer 10 and 11 red-filter reflectances of belts and zones reasonably well up to 150°, although their Cassini near-infrared images show limb brightening at slanted geometry that this form misses. This supports a phase-independent k near 1; OPAL's 0.972 is kept and the paper is cited in the method. No quantitative phase-dependent law was found.
- **Uranus and Neptune:** current products retain phase-independent OPAL k. Independent Neptune evidence exists in Irwin et al. (2022), JGR Planets 127, e2022JE007189, DOI:10.1029/2022JE007189, Sec. 3.11 and Fig. 20 (arXiv:2201.04516v2, pp.35–37): Voyager NAC measurements from 16–18 August 1989 give k = 0.83/0.78/0.74 (violet/green/orange) at 15–25°S and 0.75/0.67/0.65 at 45–55°S. These exclude the validation case’s 15 August frames by date. They establish filter and latitude dependence, not a complete phase-dependent law or a coefficient at every latitude; no new coefficient is adopted here.

### Saturn: Barkstrom B(α) from Pioneer 11

- **Transcription** (`photometry/tables/dones_1993_saturn_barkstrom.csv`): Table 3 of Dyudina et al. (2016), which reproduces Dones et al. (1993) Table V and matches Dyudina et al. (2005, arXiv:astro-ph/0406390) Table 2. The 180° column is Dyudina et al.'s linear extrapolation (Pioneer 11 did not look beyond 150°) and is marked `measured = 0` and not used.
- **Law:** the renderer's native Barkstrom kind, I/F ∝ (1/μ)(μμ0/(μ+μ0))^B, with B tabulated against phase angle. A is only the brightness scale, which the renderer takes from the disk-integrated albedo and phase curve. (An earlier version converted B to the closest Minnaert k per phase angle, with an rms of 0.05–0.18 in ln I/F.)
- **Wavelength:** B is interpolated linearly between the blue (440 nm) and red (640 nm) passbands to the Y-channel mean wavelength (562 nm).
- **Table used** (`B.alphaDeg` / `B.values`):

  | Phase angle | B |
  |---|---|
  | 0° | 1.439 |
  | 30° | 1.335 |
  | 60° | 1.339 |
  | 90° | 1.326 |
  | 120° | 1.297 |
  | 150° | 1.367 |
  | 180° | 1.367 (held, no data) |

- **The 0° value:** it is 2 × OPAL's k = 0.719. At zero phase μ0 = μ, and the Barkstrom law equals Minnaert's with B = 2k. OPAL is used there because at small phase its law is the one divided out of the map the app shows. Pioneer's own 0° value, 1.335, lies outside Pioneer's observed phase range.
- **Independence:** Pioneer 11 (1979), fitted in 1984/1993; none of the validation frames is involved.
- **Validation** (Cassini WAC, 2016; docs/reports/validation.md): the terminator row includes night-side light with ringshine's signature, which the app does not draw (`docs/rendering-m2.md` §6). The deficit does not establish that the exact Barkstrom law darkens too steeply. The current report gives the run's values; the law is kept because it is the published one, and nothing is fitted to the frame.
- **Season- and latitude-aware alternatives (searched 2026-09-30, none adopted).** Pioneer 11 saw Saturn near equinox in 1979, mostly its equatorial belts and zones. The validation frame looks from 28.7° N in northern summer. Candidates checked:

  | Source | What it gives | Why not adopted |
  |---|---|---|
  | Mendikoa et al. (2017), A&A; arXiv:1709.09664, CDS tables B1–B8 | Ground-based PlanetCam Minnaert k per latitude and filter, northern hemisphere, 2012–2016 | The season is right, but the phase angle is ≤ 6°, and small-phase k already fails at 54.6° (the OPAL experience) |
  | Pérez-Hoyos et al. (2016), Icarus 277 | Cassini ISS 2010–11 phase behaviour | A radiative-transfer particle phase function, not an I/F law; closed access (OpenAlex: no open copy) |
  | Wang et al. (2024) | Hemispheric reflectances at 102–120° only | No law |
  | Barstow et al. (2016); Sanz-Requena et al. (2019); Sromovsky et al. (2021); Sánchez-Lavega et al. (2024) | Cloud and haze retrievals | No disk law |

  A latitude-dependent law would also need a schema and renderer extension, since `spatialModel` holds one law per body.

### Saturn's mid-sized moons: Akimov

- **Law:** the Akimov disk function of Shkuratov et al. (1999), which has no free parameters:
  - D = cos(g/2) · cos[π/(π−g) · (γ − g/2)] · (cos β)^(g/(π−g)) / cos γ;
  - photometric longitude γ = arctan[(cos i − cos e cos g)/(cos e sin g)];
  - photometric latitude β = arccos(cos e / cos γ);
  - D = 1 at g = 0.
- **Source:** Filacchione et al. (2022) reduce all Cassini VIMS pixels of Mimas, Enceladus, Tethys, Dione and Rhea with i, e ≤ 70° and 10° ≤ g ≤ 120° to equigonal albedo with this D. Only their phase function is fitted.
- **Use:** `{kind: "akimov"}`, label estimated, used at all phase angles (no `validPhaseDeg`), like the other laws. The disk-integrated brightness still comes from the moons' albedo and phase curve (photometry.json, from the same paper).

### Io

- **Transcription** (`photometry/tables/simonelli_veverka_io_hapke.csv`): w = 0.68, h = 0.24, g = −0.14, θ̄ = 25°, from the Voyager violet-filter fit of Simonelli & Veverka (1986) as quoted in the Fig. 1 caption of their 1987 report (NASA NTRS, open access). The orange-filter fit is described as similar but not printed.
- **Conventions:** a single-term Henyey–Greenstein function with asymmetry g < 0 is the renderer's backward lobe alone (b = |g|, c = 1). The Hapke (1981) opposition amplitude is B0 = exp(−w²/2) = 0.794, with width h. The H function is Hapke's (1981); K = 1.
- **Caveat:** Io is much brighter in the visible than at 0.42 µm, so the violet-filter law probably underestimates the multiple scattering and the limb brightening in the Y channel.

### Europa, Ganymede and Callisto

- **Transcription** (`photometry/tables/domingue_verbiscer_1997_hapke.csv`): all 12 rows (two hemispheres × 470 and 550 nm).
- **Printing error corrected:** the thesis prints the two Europa trailing rows with h and B0 swapped (h 0.45/0.50, B0 0.0016). They are stored in the right columns, as the thesis's own text supports (no hemispherical difference in the opposition effect, B0 ≈ 0.5). Column `swapped` marks them.
- **Phase-function convention:** c follows Hapke's (1993, Eq. 6.18a) convention, with the backward lobe weighted (1+c)/2; the renderer uses the same convention. The thesis's own summary of the paper supports this reading:
  - Ganymede's two hemispheres are backscattering at 550 nm, which needs (1+c)/2 > ½ for c = 0.427;
  - Callisto's leading hemisphere at 470 nm is "close to isotropic", i.e. asymmetry −bc ≈ 0 for b = 0.729, c = 0.024.
- **Model:** H function of Hapke (1981/1993), K = 1, no coherent-backscatter term, as in the fit.
- **Why not the thesis's own fits:** the thesis's disk-resolved regional fits (Belgacem et al. 2020 for Europa; thesis Chapter 5) include exactly the New Horizons LORRI frames of the validation set (LOR_0034849319, LOR_0034784234, LOR_0034858514; thesis Appendix D). They are not used, so the validation stays independent.

### Pluto, Charon and Triton

- **Transcription:** Table 14, all ten rows (`photometry/tables/verbiscer_2022_table14.csv`).
- **Porosity factor K:** the fits use the Helfenstein & Shepard (2011) form, in which K follows from the SHOE width. K is computed from hS through Table 16 note b: hS = −0.3102 f^(1/3) ln(1 − 1.209 f^(2/3)) and K = −ln(1 − 1.209 f^(2/3)) / (1.209 f^(2/3)). The results fall within Table 16's K ranges: Pluto 1.135, Triton 2.236, Charon 1.504.
- **Model differences:**
  - the renderer evaluates Hapke's isotropic multiple-scattering approximation, whereas the fits used the anisotropic one;
  - θ̄p is the paper's "photometric roughness".
- **Possible overlap:** the Pluto phase curve includes New Horizons approach photometry (Hillier et al. 2021). It may contain the disk-integrated brightness of the validation frame, but not its disk-resolved distribution.

### Mars

Vincendon's c = 0.6 is the backward fraction (1 + c_Hapke)/2 of Johnson et al. (2006a), so c_Hapke = 0.2. The law describes the surface under the atmosphere, which the renderer adds on top.

## Not covered (Lambert, with the reason)

- **Mercury:** the MESSENGER MDIS fits (Domingue et al. 2016, Hapke and Kaasalainen–Shkuratov) are behind a publisher bot check and were not found on arXiv (searched by author and title). The MDIS SIS (`MSGRMDS_2001/DOCUMENT/MDIS_CDR_RDRSIS`) names the models but gives no parameter values, and NASA NTRS has no copy.
- **Titan, Iapetus, the Uranian moons, Phobos, Deimos and the rest:** no disk-resolved law was used.
- **Earth** is drawn from its layers (render/earth.ts).
- **The Moon** has its per-texel Hapke maps (surfaces/301/hapke).
