# NAIF satellite kernels: how moon positions are obtained

This is an overview of the `naif-<kernel>` sources: mar099s, jup365, jup347, jup348, jup349, sat441, sat415, sat455, sat456, sat457, sat459, sat480, ura184_part-1/2/3, nep098_part-1/2/3, nep104 and plu060. Each kernel has its own note, `docs/sources/naif-<kernel>.md`. The research behind this is in `docs/research/m2-worlds.md` §1a.

## Products

The `ephemeris` stage writes `app/public/data/ephem/sat-{mar,jup,sat,ura,nep,plu}.json` and `.bin`, one pair per planetary system, so the app can lazy-load. Each holds the planet centre (499 … 999 relative to the system barycentre) and every moon of that system. The records are the kernels' own, bit for bit (label `measured`), in the same header and layout as `ephem/de442s`. Chain: moon → barycentre (or planet centre) → SSB through `ephem/de442s`.

The build of 2026-09-30 contains 459 moons and 6 planet centres from 20 kernels, 138 MB in total:

| Product | Size |
|---|---|
| sat-ura | 63 MB (the inner Uranian moons use 0.1-day records) |
| sat-nep | 34 MB |
| sat-sat | 25 MB |
| sat-jup | 13 MB |
| sat-mar | 3.6 MB |
| sat-plu | 0.9 MB |

These products replace the M1 Horizons-fitted `ephem/centers`. Every planet centre is available natively from a kernel, so no fitted centre is kept. The current `ephem/centers` (1.8 MB, Mars 0.9 MB of it) holds only the six planet-centre segments 499–999, as bit-identical copies of the records in `sat-*`. The app loads it before the first frame, so every planet can be placed while the moon systems are still loading. Where both copies are loaded, `EphemerisSet` serves the one added last; the copies are identical, so the result is the same. pytest (`test_ephem.py`) and vitest (`core-ephemeris.test.ts`) both check this.

## Method

- **Excerpting.** Each kernel's segment table is read over HTTP Range requests and cached per kernel size and Last-Modified in `data/cache/satellite-survey/`. For the window ± 2 days, only the records of the chosen bodies are copied, using jplephem's `write_excerpt` (jplephem 2.24, MIT). The excerpt is padded to whole 1024-byte DAF records so SPICE can read it.
  - Each excerpt is stored in `data/raw/naif/spk-excerpts/` and recorded in the download ledger with its sha256, the original's URL, size and Last-Modified, the window, the targets and the number of range requests.
  - Right after writing, 3–4 random records per kernel are re-read from the original with independent range requests and compared byte for byte.
- **Excluded segments.** DE copies are never taken. Every satellite kernel embeds the Sun, the Earth-Moon barycentre, the Earth and the system barycentre from DE440 or DE442, which would override the planetary ephemeris.
- **One kernel per body.** The first kernel in `ephem_satellites.KERNELS` that has a body wins. This matters only for planet centres and Methone. The order follows JPL Horizons' own choice of source: 599 from jup365, 699 from sat441, 799 from ura184, 899 from nep098, 499 from mar099s, 999 from plu060, and Methone (632) from sat441.
- **Coverage.** A chosen segment must cover the whole window, and the build fails otherwise.
- **SPK types.** Types 2 and 3 are Chebyshev. The one type-17 body, S/2009 S 2 (65304) in sat480, is a precessing equinoctial conic. The excerpter cannot copy it, so sat480 (12.6 MB) is downloaded whole. Type 17 is evaluated natively as SPICE EQNCPV does, in `ephem_spk.eqncpv` and `app/src/core/ephemeris.ts`. It agrees with SPICE to < 1 mm, and not bit for bit, because the ~1e5 rad mean longitude has an ulp of ~1 mm at a = 117,061 km.
- **Not used:**
  - Superseded or extended variants: nep097, nep105, the full mar099 (same data as mar099s over 1995–2050), and the `*xl*` files.
  - `sat393_daphnis.bsp`: a 2016 type-17 conic for Daphnis (635), for which JPL Horizons gives no ephemeris after 2018-01-17. Daphnis therefore has no position and is not in `bodies.json`.

## Accuracy

- **Interpolation error.** The kernels state their Chebyshev interpolation error per satellite ephemeris, e.g.:

  | Ephemeris | Stated error |
  |---|---|
  | MAR099 | 2 m |
  | JUP365 | 16 m |
  | SAT441 | 7.5 m |
  | SAT415 | 5.8 m |
  | SAT454/456 irregulars | 556 m |

  It is recorded in each segment's `uncertainty`.
- **Orbit-determination uncertainty.** Not published in the kernels. For recently discovered irregular moons it can be far above 1 km.
- **Planet-centre pairing (Janus).** One planet centre is used per system. Horizons pairs Janus and the other sat415 moons with sat415's own Saturn centre, while we use sat441's. The two differ by up to 5.1 m, inside sat415's stated 5.8 m.

## Verification

- **Excerpts vs original kernels, via SPICE:**
  - `spkgeo` on the whole original equals `spkgeo` on the excerpt, exactly, at 300 epochs for every body of mar099s, jup348 and plu060. These originals are downloaded whole by `python -m pipeline.ephem_fixtures`.
  - Every excerpt is byte-checked against its original at build time.
- **Products vs excerpts:** every product segment is bit-identical to its excerpt. Our Python and TS evaluators equal `spkgeo` exactly for types 2/3 (all 465 bodies, `pipeline/tests/test_ephem_satellites.py`) and to 8.4e-7 km for type 17.
- **Independent JPL Horizons check, moon relative to planet centre, 5 epochs:**

  | Bodies | Max difference |
  |---|---|
  | Io, Europa, Titan, Enceladus, Phobos, Triton, Charon, Miranda, Himalia (jup347), Sycorax (ura184), S/2009 S 2 (type 17), S/2011 J 4 (5-digit id) | ≤ 4.4e-7 km |
  | Janus (see above) | 5.1e-3 km |

  (`app/tests/core-ephemeris.test.ts`)
