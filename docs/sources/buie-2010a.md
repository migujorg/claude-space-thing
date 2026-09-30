# Buie et al. (2010) HST photometry of Pluto and Charon (`buie-2010a`) — transcription

**Citation:** Buie, M. W., Grundy, W. M., Young, E. F., Young, L. A. & Stern, S. A. (2010). Pluto and Charon with the Hubble Space Telescope. I. Monitoring global change and improved surface properties from light curves. *Astronomical Journal* 139, 1117–1127. DOI [10.1088/0004-6256/139/3/1117](https://doi.org/10.1088/0004-6256/139/3/1117). Publisher PDF fetched (sha256 recorded). The paper's machine-readable tables are the per-visit photometry; the quantities we need (Fourier a0 terms, zero-phase corrections, phase coefficients) are in the text and printed tables.

**Transcribed** (`tables/buie_2010a_pluto.json`): mean opposition distance r = 39.5, Δ = 38.5 AU (Sec. 3.3); Pluto V a0 = 15.3298 (Table 8) and B a0 = 16.2832 (Table 7) at 1° phase; 1°→0° corrections −0.0398 (V) and −0.0434 (B) (Fig. 2 and Fig. 1 captions); β_V = 0.0355 ± 0.0045, β_B = 0.0392 ± 0.0064 mag/deg over 0.36–1.74° (abstract, Sec. 5.2); B−V = 0.9540 ± 0.0010; Charon V a0 = 17.0978 (Table 12) and −0.2549 to 0° (Fig. 8 caption).

**Use:**
- Pluto V(1,0) = −0.620, B(1,0) = +0.330 (Pluto alone, 2002–2003). With V☉, B☉ from Willmer (2018) and the pck00011 radius 1188.3 km: p_V = 0.555 (**derived**), p_B = 0.413.
- Spectrum: p linear in λ fixed by the B and V band averages, extrapolated to 360–830 nm (**estimated**; the red end is probably too high).
- Phase function: poly-mag [0, 0.0355], 0–1.74° (**measured**). Nothing beyond 1.74° (New Horizons phase curves were not found in machine-usable form).
- Charon: used in the Horizons comparison, since Horizons' Pluto magnitude includes Charon, and, from M2, as its own entry (below).

**M2 additions.**
- Charon B a0 = 17.7935 (Table 11) and B−V = 0.7315 ± 0.0013 (Table 10 weighted mean, also the abstract; Sec. 6.3 prints 0.7313 ± 0.0017 as the adopted value).
- Table 9 global Hapke parameters (h, P, B₀, θ̄, w) for Pluto and Charon in B and V.

They are used as follows:
- **Charon entry:**
  - p_V = 0.510, from V(1,0) = +0.933 and the pck00011 radius 606.0 km. Label **derived**.
  - Spectrum: B/V linear reconstruction. Label **estimated**.
  - Phase function: Buie's Table 9 V Hapke fit, integrated over the disk (`photometry/diskint.py`, Hapke 1986 without roughness), tabulated over 0–1.74°. Label **derived**. The integral reproduces the paper's own 1°→0° corrections: Charon V 0.2549, Pluto V 0.0398 and Pluto B 0.0434 (to 0.002 mag, `tests/test_photometry_moons.py`).
- Verbiscer et al. (2022) list p_V = 0.41 for Charon (Stern et al. 2015). The difference is mostly the size of the extrapolated surge (0.25 mag between 1° and 0°).

**Fetch fix (M1 → M2).** The M1 ledger entry for this PDF held the sha256 of a bot-check page: the publisher had answered the scripted request with HTML and status 200. `Download` now validates PDFs (`%PDF-` magic) and retries. For documents behind a bot check it also records the sha256 of the copy retrieved by hand (89b6dd0c…, 2026-09-30) and accepts that copy from `data/raw/papers/`. The transcribed numbers were re-checked against the real PDF.
