# Gaia DR3 (stars)

Used by the `stars` stage for astrometry, broadband photometry and flux-calibrated low-resolution spectra of
every star with G < 10. SourceRecord ids: `gaia-dr3`, `gaia-dr3-xp-sampled`, `gaia-dr3-hipparcos2-xmatch`,
`tycho-2` (the Tycho-2 copy served by the Gaia archive).

## Main source table — `gaia-dr3`

- **What:** `gaiadr3.gaia_source` rows with `phot_g_mean_mag < 10.5` (≈ 0.78 M sources; G < 10.0 are catalogue
  records, 10.0–10.5 only serve the cross-match). Columns: position, parallax, proper motion and errors at the
  reference epoch J2016.0, radial velocity, RUWE, solution type, G/BP/RP, `has_xp_sampled`, variability and
  duplication flags, `non_single_star`.
- **Citation:** Gaia Collaboration, Vallenari A. et al. 2023, A&A 674, A1, DOI 10.1051/0004-6361/202243940;
  astrometric solution Lindegren L. et al. 2021, A&A 649, A2, DOI 10.1051/0004-6361/202039709; photometry
  Riello M. et al. 2021, A&A 649, A3, DOI 10.1051/0004-6361/202039587.
- **Retrieval:** ADQL on the synchronous endpoint `https://gea.esac.esa.int/tap-server/tap/sync` (GET, CSV),
  sliced in G so each response is ≤ ~1.2 × 10⁵ rows, through `download.fetch` — the ledger holds the full query
  URL and the result's sha256; the ADQL text is also saved as `data/raw/stars/gaia_dr3/<file>.adql`.
  Two service behaviours seen during development are guarded against: the asynchronous service stalled in
  `WRITING_RESULT` for > 20 min on a 10⁵-row result (so it is not used), and a synchronous response was once cut
  off cleanly at a line boundary (106 498 of 116 821 rows, no error). Every result's row count is therefore
  checked against a `COUNT(*)` of the same query (recorded in `<file>.rows`) and re-downloaded on mismatch.
- **License:** ESA/Gaia/DPAC, CC BY-SA 3.0 IGO.
- **Caveats:** Gaia DR3 lacks most stars brighter than G ≈ 3 and is incomplete up to G ≈ 5 (saturation);
  those come from Hipparcos. Bright-star (G < 13) proper motions carry a small frame spin (≈ 80 µas/yr;
  Cantat-Gaudin & Brandt 2021), negligible here.

## XP sampled mean spectra — `gaia-dr3-xp-sampled`

- **What:** externally calibrated BP/RP spectra, 343 samples from 336 to 1020 nm in 2 nm steps, flux in
  W m⁻² nm⁻¹ (`xp_sampled_mean_spectrum`, published for sources with `has_xp_sampled`, G ≲ 15).
- **Citation:** De Angeli F. et al. 2023, A&A 674, A2, DOI 10.1051/0004-6361/202243680 (processing);
  Montegriffo P. et al. 2023, A&A 674, A3, DOI 10.1051/0004-6361/202243880 (external flux calibration).
- **Retrieval:** these spectra are not in the TAP service. DataLink (`RETRIEVAL_TYPE=XP_SAMPLED`) measured
  ≈ 2 s per source, i.e. ~11 days for 0.45 M stars, so the stage streams ESA's bulk files instead:
  `https://cdn.gea.esac.esa.int/Gaia/gdr3/Spectroscopy/xp_sampled_mean_spectrum/` — 3386 gzipped ECSV files,
  ≈ 114 GB. Each file is streamed once, its MD5 checked against ESA's `_MD5SUM.txt`, its sha256 computed, and
  only rows of the selected sources (G < 10 with `has_xp_sampled`) are kept as
  `data/raw/stars/gaia_dr3_xp_sampled/<file>.npz` (float32 flux and flux_error). Per-file url, md5, sha256,
  byte count, row count and kept count are in `_streamed.json`; the SourceRecord's sha256 is a digest over the
  per-file sha256s. The full files are not stored (disk budget).
- **Use:** integrated with the CIE observers via `cie.resample` + `cie.xyzs` → X, Y, Z, S, label `derived`,
  for G ≥ the XP bright limit (see `docs/reports/stars.md`). Also the calibration set for the photometric
  estimates of stars without a usable spectrum.
- **Caveats:** calibration systematics of a few per cent, larger below 400 nm; bright stars (G ≲ 5) are
  affected by saturation/gating (Montegriffo et al. 2023, §7) — quantified in the report. Wavelengths are
  in vacuum; the ≈ 0.14 nm air/vacuum offset is negligible for broadband CIE integrals.

## Hipparcos cross-match — `gaia-dr3-hipparcos2-xmatch`

- `gaiadr3.hipparcos2_best_neighbour` (99 525 pairs). Algorithm: Marrese P. M. et al. 2019, A&A 621, A144,
  DOI 10.1051/0004-6361/201834142. Hipparcos stars missing from it are matched by position at J2016.0
  (≤ 1.5″ with G − Hp < 1.5, then ≤ 4″ with |G − Hp| < 1), and pairings > 1 mag off in G are moved to an
  unclaimed source within 4″ that agrees with Hp (details: docs/reports/stars.md §1.1).

## Tycho-2 — `tycho-2`

- `gaiadr3.tycho2tdsc_merge` joined with `gaiadr3.tycho2tdsc_merge_best_neighbour`, only stars with VT < 11 and
  no Gaia best neighbour. Citation: Høg E. et al. 2000, A&A 355, L27 (bibcode 2000A&A...355L..27H); TDSC:
  Fabricius C. et al. 2002, A&A 384, 180, DOI 10.1051/0004-6361:20011822.
- A second query takes the Tycho-2 proper motions of the Gaia DR3 sources with G < 10 that have only a
  2-parameter solution (3 879 rows); 2 133 catalogue stars are propagated with them.
- Stars that still have no Gaia source within 2″ (J2016.0) and no Hipparcos entry, with
  V = VT − 0.090 (BT − VT) < 10 (ESA 1997, Vol. 1, §1.3 App. 4), become Tycho-only catalogue records.
