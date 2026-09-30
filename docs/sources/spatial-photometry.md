# Disk-resolved photometric laws (`spatialModel` in photometry.json)

A spatial law tells the renderer how a body's light is spread across its disk: centre, limb and terminator. The disk integral stays the measured `geometricAlbedoXYZS · Φ(α)`, because the renderer rescales the law (docs/architecture.md §4.3–4.4). Without a law the renderer uses Lambert. The laws below are **published fits**. None is fitted to the project's own validation images, which remain an independent test (docs/reports/validation.md). Code: `pipeline/src/pipeline/photometry/spatial.py`.

## Label criterion

A law is **measured** only if all three of these hold:

1. it was fitted to disk-resolved images of that body;
2. it is used only within the fitted range of phase angles;
3. it holds per channel.

No entry meets all three:

- the schema has one law for X, Y, Z and S together;
- OPAL's Minnaert exponents are applied at every phase angle;
- the Hapke sets come from disk-integrated phase curves, so their spatial distribution is the model's rather than an observed one.

Every entry is therefore **estimated**, and its `method` states the assumptions. `validPhaseDeg` is not set: the law applies at every phase angle rather than falling back to Lambert. The phase coverage of each source's data is given in its method text.

## Sources

| Bodies | Law | Source | Data behind the fit |
|---|---|---|---|
| Jupiter, Saturn, Uranus, Neptune | Minnaert, one k | Hubble OPAL cycle README: the Minnaert k per WFC3/UVIS filter with which the OPAL team removed the limb darkening of the maps the app shows (MAST HLSP doi:10.17909/T9G593; Simon et al. 2015). Same epoch as `surf_giants.py`: Jupiter 2025b, Saturn 2025b, Uranus 2025b, Neptune 2025c. | Disk-resolved HST images, phase ≤ 11° (Jupiter) and less for the others |
| Europa, Ganymede, Callisto | Hapke (1993) | Domingue & Verbiscer (1997), Icarus 128, 49 (DOI:10.1006/icar.1997.5730), 550 nm, mean of the leading and trailing hemispheres. Transcribed from the open-access reproduction in Belgacem (2019), PhD thesis, HAL tel-02421378, Tables 2.5–2.7. | Disk-integrated Voyager and telescopic phase curves |
| Pluto, Charon, Triton | Hapke (2012) | Verbiscer et al. (2022), PSJ 3, 95, Table 14 | Disk-integrated Earth-based, HST, Voyager 2 (Triton) and New Horizons LORRI/MVIC phase curves |
| Mars | Hapke (1993) | Vincendon (2013), PSS 76, 87 (arXiv:1208.4518v3): the mean BRDF of typical Martian terrains | OMEGA and CRISM, aerosols removed |

### Giant planets

- **The k used:** OPAL's k varies with filter. Examples: Jupiter 0.85 at 395 nm, 0.95 at 467–502 nm, 0.999 at 631–658 nm; Neptune 0.88 / 0.80 / 0.50 at 467 / 547 / 657 nm. The renderer takes one k for all channels, so the pipeline interpolates k linearly in the filters' nominal wavelengths to the mean wavelength of the Y-channel signal (∫λ ȳ E☉ p dλ / ∫ȳ E☉ p dλ, about 560 nm). Methane-band filters and filters without a correction are left out.
- **Why this k:** rendering the OPAL map with the law that was divided out of it reproduces the HST view.
- **Values:** k = 0.972 (Jupiter), 0.719 (Saturn), 0.788 (Uranus), 0.790 (Neptune).

### Europa, Ganymede and Callisto

- **Transcription** (`photometry/tables/domingue_verbiscer_1997_hapke.csv`): all 12 rows (two hemispheres × 470 and 550 nm).
- **Printing error corrected:** the thesis prints the two Europa trailing rows with h and B0 swapped (h 0.45/0.50, B0 0.0016). They are stored in the right columns, as the thesis's own text supports (no hemispherical difference in the opposition effect, B0 ≈ 0.5). Column `swapped` marks them.
- **Phase-function convention:** c follows Hapke's (1993, Eq. 6.18a) convention, with the backward lobe weighted (1+c)/2; the renderer uses the same convention. The thesis's own summary of the paper supports this reading:
  - Ganymede's two hemispheres are backscattering at 550 nm, which needs (1+c)/2 > ½ for c = 0.427;
  - Callisto's leading hemisphere at 470 nm is "close to isotropic", i.e. asymmetry −bc ≈ 0 for b = 0.729, c = 0.024.
- **Model:** H function of Hapke (1981/1993), K = 1, no coherent-backscatter term, as in the fit.
- **Why not the thesis's own fits:** the thesis's disk-resolved regional fits (Belgacem et al. 2020 for Europa; thesis Chapter 5) include exactly the New Horizons LORRI frames of the validation set (LOR_0034849319, LOR_0034784234, LOR_0034858514; thesis Appendix D). They are not used, so the validation stays independent.
- **Io:** no published Hapke or Minnaert fit was available to a scripted client, so Io stays Lambert.

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

- **Mercury:** the MESSENGER MDIS fits (Domingue et al. 2016, Hapke and Kaasalainen–Shkuratov) are behind a publisher bot check. The MDIS SIS (`MSGRMDS_2001/DOCUMENT/MDIS_CDR_RDRSIS`) names the models but gives no parameter values.
- **Io:** see above.
- **Saturn's mid-sized moons:** Filacchione et al. (2022) fit an Akimov disk function. That form is not among the renderer's laws; supporting it is a renderer change.
- **Uranian moons, Phobos, Deimos and the rest:** no disk-resolved law was used.
- **Earth** is drawn from its layers (render/earth.ts).
- **The Moon** has its per-texel Hapke maps (surfaces/301/hapke).
