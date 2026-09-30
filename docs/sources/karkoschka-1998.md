# Karkoschka (1998) full-disk albedo spectra of the giant planets (`karkoschka-1998-pds`)

**Citation:** Karkoschka, E. (1998). Methane, ammonia, and temperature measurements of the jovian planets and Titan from CCD-spectrophotometry. *Icarus* 133, 134–146. DOI [10.1006/icar.1998.5913](https://doi.org/10.1006/icar.1998.5913). Data: ESO-J/S/N/U-SPECTROPHOTOMETER-4-V2.0, NASA PDS Atmospheres Node, volume GBAT_0001, DOI [10.17189/2bp8-k793](https://doi.org/10.17189/2bp8-k793). Method paper: Karkoschka (1994), *Icarus* 111, 174–192, DOI 10.1006/icar.1994.1139.

**File:** `https://pds-atmospheres.nmsu.edu/PDS/data/gbat_0001/data/1995low.tab` (label `1995low.lbl`): 300–1050 nm, 1 nm resolution, 0.4 nm sampling, vacuum and air wavelength columns; Jupiter full-disk albedo at 6.8° phase, Saturn full-disk albedo at 5.7° for zero ring tilt, Uranus and Neptune geometric albedo, Titan. Observed 1995 July 6–10 at ESO La Silla. The volume also contains both papers as ASCII text (`document/icarus94.asc`, `icarus98.asc`), which is where the details below come from.

**Small transcription:** `pipeline/src/pipeline/photometry/tables/karkoschka_disk_radii.json` — the equal-area disk radii Karkoschka used to turn flux into albedo (1994 Table III: Jupiter 69 140, Uranus 25 450, Neptune 24 510 km; 1998 Sec. III: Saturn equatorial 60 268 km with oblateness 0.10), the 1995 phase angles (1998 Table II / PDS label) and the assumed solar V = −26.74.

**Processing (`photometry/albedo.py`):**
- albedo × (R_Karkoschka / R_pck)² to refer it to the pck00011 volumetric mean radius (Jupiter ×0.9781, Saturn ×0.9640, Uranus ×1.0069, Neptune ×0.9909);
- Jupiter and Saturn scaled to zero phase with the Mallama & Hilton (2018) V phase law at 6.8° / 5.7° (×1.0242 / ×1.0166), assumed wavelength-independent → label **estimated**; Karkoschka himself estimated "some 5 percent";
- Uranus and Neptune taken as geometric albedos as published (phase 0.7° / 0.3°) → label **derived**.

**Quality:** absolute calibration ±4 %, relative ±2 % (Karkoschka). Our Jupiter agrees with Mallama et al. (2017) B, V, Rc to ≤ 2 % and with Horizons to 0.02 mag. Epoch caveats: Saturn's globe at ring-plane crossing (what the renderer draws, rings excluded); Neptune brightened ~3 % in V after 1995; Uranus's red albedo is 28 % above Mallama's 2000s value (seasonal change).

**Titan (M2).** PDS column 8 is the "Full disk albedo of Titan at phase angle 5.7 deg." (1995LOW.LBL). The disk radius is 2575 km (1994 Table III, `karkoschka-1994-text` = `document/icarus94.asc`, fetched), which equals the pck00011 radius, so no rescaling is needed. The zero-phase factor is 1.02 from García Muñoz et al. (2017, `garcia-munoz-2017.md`) → label **estimated**. Check: dividing our spectrum by 1.02 gives V = −1.25 ± 0.03 at 1 AU and 5.7°, which is 1998 Table II's value (with Karkoschka's solar V = −26.74). The 1998 paper's Table II also shows Titan changing by a few percent over two years (seasons, north–south asymmetry, rotation near 940 nm).
