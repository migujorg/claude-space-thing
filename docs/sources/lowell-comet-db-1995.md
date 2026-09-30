# lowell-comet-db-1995: Lowell Observatory comet database: production rates and Afρ of 85 comets (A'Hearn et al. 1995)

- **URL:** https://pdssbn.astro.umd.edu/holdings/ear-c-phot-3-rdr-lowell-comet-db-v1.0/data/locdprod.tab (cached as `data/raw/comets/lowell-db/locdprod.tab`, 102 870 bytes, sha256 043f9e23d7e1a5b5ce7eb64b524a4a1180d23a663b03222d5941156de6e40e78; `data/raw/comets/lowell-db/locdprod.lbl`, 20 800 bytes, sha256 085427f8fd60952b6190aa3e7201cdf294d8b022a672586edf4c75691a7f5e13; retrieved 2026-09-30).
- **Recorded sha256:** 07f629783eb325b6e2e2931474fd4487712801e438c6b2d50931d6eeaa91498a (SHA-256 over the per-file sha256 values, one per line, file order).
- **Citation:** A'Hearn, M. F., Millis, R. L., Schleicher, D. G., Osip, D. J. & Birch, P. V. (1995). The ensemble properties of comets: results from narrowband photometry of 85 comets, 1976-1992. Icarus 118, 223-270. DOI:10.1006/icar.1995.1190. Data: Osip, D. J. (ed.), Lowell Observatory Cometary Database, EAR-C-PHOT-3-RDR-LOWELL-COMET-DB-V1.0, NASA Planetary Data System (Small Bodies Node).
- **Licence:** NASA Planetary Data System (public).

## Contents

810 observations (1976–1992) of 85 comets with Lowell narrowband photometry: per observation r, Δ, heliocentric radial velocity, aperture (log ρ), log Q of OH, NH, CN, C3, C2 (Haser, v = 1 km/s) and log A(θ)fρ in the UV (3650 Å) and blue (4845 Å) continua. 99.99 marks a quantity not measured. Fixed-width ASCII described by the PDS3 label.

## How it is used

`comets` stage (`comet_sources.read_lowell_db`, `comet_model.lowell_ratios`): per comet the medians of log Q(C2)/Q(OH), log Q(CN)/Q(OH), log Q(C3)/Q(OH) and log Afρ(blue)/Q(OH) over its observations; the population value is the median of the per-comet medians. A comet of the catalogue that A'Hearn et al. observed (numbered periodic comets matched by number, others by IAU designation) uses its own ratios (label derived: measured at other apparitions); every other comet uses the population medians (label estimated). These fix how the M1/K1 light splits between gas and dust and the dust coma's Afρ.

## Caveats

- Ratios measured in 1976–1992; a comet's composition can change between apparitions.
- The population median mixes 'typical' and carbon-chain-depleted comets (A'Hearn et al. 1995 find about a third depleted, mostly Jupiter-family).
- Afρ in the blue continuum at the phase angle of each observation (not phase-corrected).
