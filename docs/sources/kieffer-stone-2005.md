# ROLO lunar model: Kieffer & Stone (2005) (`kieffer-stone-2005`)

**Paper:** Kieffer, H. H. & Stone, T. C. (2005). The spectral irradiance of the Moon. *Astronomical Journal* 129, 2887–2901, DOI [10.1086/430185](https://doi.org/10.1086/430185). PDF from `https://iopscience.iop.org/article/10.1086/430185/pdf`. The publisher serves scripted clients a bot check, so the PDF was retrieved by hand with a browser User-Agent on 2026-09-30 (sha256 `1666a5414916c2e38fcf34097aad3794cc1aae9d4a7d090bef2a049219316e96`, recorded in the Download).

**What it is:** the USGS Robotic Lunar Observatory (ROLO) model of the whole Moon's irradiance, version 311g.
- It is an empirical fit (Eq. 10) to about 38 000 extinction-corrected whole-disk measurements in 32 bands (350–2384 nm), for phase angles 1.55° < g < 97° and the Earth-based libration range.
- The model has terms for:
  - the phase angle (cubic polynomial);
  - which hemisphere is lit, i.e. the Sun's selenographic longitude Φ (odd polynomial, the waxing/waning asymmetry);
  - libration (the observer's selenographic latitude θ and longitude φ);
  - the opposition effect (two exponentials, scale angles 4.06° and 12.88°);
  - an empirical cosine term.
- The fitted quantity is the disk-equivalent reflectance A_k, defined by I_k = A_k Ω_M E_k/π with Ω_M = 6.4177×10⁻⁵ sr at 384 400 km (Eq. 8). This is A = p·Φ for a disk of radius 1737.4 km.

**Transcribed:** `pipeline/src/pipeline/photometry/tables/kieffer_stone_2005_rolo.json` holds:
- Table 4 (p. 2896, 32 bands × a0–a3, b1–b3, d1–d3);
- the Eq. 11 constants (p. 2897: c1–c4, p1–p4);
- Table 5's example values and effects (p. 2897), kept for checks only.

The paper's minus signs are lost by ordinary text extraction. Here the PDF text was extracted by script, in which the minus glyph comes out as a control character (U+0001), so the signs were kept mechanically. Checks:
1. The table was read against a 200 dpi rendering of the page.
2. Table 4 is identical to an independent transcription: `https://raw.githubusercontent.com/mcoughlin/skybrightness/master/data/kieffer_stone_table4.txt`, sha256 `bd6f99440efbdd25e1e64749fcf5178df66721865b02b5936b978e7949c15aaf`, retrieved 2026-09-30.
3. c1–c4 and p1–p4 are identical to those in an independent implementation: `https://raw.githubusercontent.com/oknuutti/visnav-py/master/visnav/calibration/moon.py`, sha256 `749996fc3c4a3abcd9f41ddeaf8a226b6a2527ebb0b298a212fe90ddd5a47888`. That code offsets its p array by one element, so only its values were compared, not its evaluation.
4. Table 5's example values have the same signs as the band averages of Table 4 for every coefficient except d3, the smallest term.
5. Table 5's "Effect" column (the change in ln A over each term's range) is reproduced within 1–2 % with g and Φ in radians up to 99° in the polynomials and g in degrees from 1.55° in the exponentials. This confirms the units (`tests/test_rolo.py`).

**Physical checks:**
- With Φ east-positive (Φ > 0 before full Moon), the model makes the waxing Moon brighter than the waning Moon: ×1.10 at 60°, ×1.14 at 90°. Lane & Irvine (1973) and Rougier (1934) observed the same direction, 0.01–0.09 mag between quadrature and full Moon.
- The logarithmic slope steepens towards zero phase (the opposition surge).
- The Moon reddens with phase.

**Use:**
- `photometry.json` → `301.diskReflectanceModel` (label **derived**). The band reflectances are interpolated linearly in wavelength (bands 350–865 nm cover the 360–830 nm grid), weighted by sunlight (TSIS-1 HSRS) and the CIE observers. Eq. 10's wavelength-dependent coefficients are refitted per channel, with max |Δ ln A| = 2.3×10⁻⁵. The c and p constants are wavelength independent and carry over exactly.
- `301.phaseFunction` for 1.55–97° (label **estimated** for the whole curve because of the join at 97°): the Y-channel A at zero libration, as the geometric mean of the waxing and waning Moon, divided by the Lane & Irvine albedo p_Y that `geometricAlbedoXYZS` keeps. For 97–120° Lane & Irvine's curve is shifted to join it (lane-irvine-1973.md).

**Caveats:**
- In the paper's words, the absolute scale is "uncertain by several percent" (Sec. 5). The project goal was 2.5 %. The scale is based on Vega (Hayes 1985: 1.5 % at 555.6 nm) and adjusted to Apollo sample spectra (average adjustment 3.5 %; a different choice of reference phase would raise it by up to 4 % at 440–700 nm, Sec. 4.2).
- Precision: mean absolute fit residual 0.0096 in ln A.
- The model describes the near side as seen from Earth. For views of the far side, or for observers outside the libration range (about ±7° latitude, ±8° longitude, read from the paper's Fig. 2), it does not apply.
- Below 1.55° (the Moon near Earth's shadow) it is not defined.
- The 763.7 nm (O₂ A band) and 939/942 nm (water) bands carry larger atmospheric corrections. At 760 nm the CIE weights are negligible.
