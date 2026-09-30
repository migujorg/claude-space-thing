# NSSDCA planetary fact sheets (`nssdca-venusfact`, `nssdca-earthfact`, `nssdca-marsfact`, `nssdca-jupiterfact`, `nssdca-saturnfact`, `nssdca-uranusfact`, `nssdca-neptunefact`, `nssdca-plutofact`)

**Source:** Williams, D. R., NASA Space Science Data Coordinated Archive, Planetary Fact Sheets, `https://nssdc.gsfc.nasa.gov/planetary/factsheet/<planet>fact.html` (HTML pages, sha256 in the download ledger; last updated 2024-01 … 2025-05 per each page). Compiled "best" values; the pages do not cite a source per number.

**Read** (by `photometry/atmo_sources.py`, from the pages themselves, not transcribed): the "Atmosphere" section's surface pressure, scale height, mean molecular weight, 1 bar temperature and density, and the bulk table's mean surface gravity and length of day.

**Use in `atmospheres.json`** (label **derived**): `scaleHeightKm` of every body (Mars: also the dust and gas profile scale height, 11.0 km), `surfacePressurePa` (Mars 6.36 mb "at mean radius"; Venus 92 bar; Pluto ~13 µbar), `meanMolecularWeight`, the giant planets' 1 bar temperature and density, Mars's gravity 3.73 m/s² (gas column) and solar day 24.6597 h (sol counting for the dust climatology), Venus's gravity (Rayleigh column above the cloud tops, reported only).

**Caveat:** the Jupiter and Saturn scale heights (27, 59.5 km) are 13 % and 24 % larger than kT/(μ m_u g) from the same sheets' 1 bar values; the sheets do not state the level they refer to (docs/reports/atmospheres.md).
