# mpc-natsats-{jupiter,saturn,uranus,neptune}: the known irregular moons and their H (MPC)

- **URL:** `https://www.minorplanetcenter.net/cgi-bin/natsats.cgi?sel1={1A,2A,3A,4A}&sel4=1&sel9=1` (the Natural Satellites Ephemeris Service, https://www.minorplanetcenter.net/iau/NatSats/NaturalSatellites.html: "all outer irregular satellites" of Jupiter, Saturn, Uranus, Neptune; orbital elements only, one-line format). Cached as `data/raw/synthetic/mpc-natsats-{planet}.html`, retrieved 2026-10-01:

  | id | bytes | sha256 | moons |
  |---|---:|---|---:|
  | mpc-natsats-jupiter | 22 161 | cd74a414e75d7f1a1ac1e3afb8bdf5cf5763f087b07bdf5259356d8c34d77f2e | 107 |
  | mpc-natsats-saturn | 52 608 | 86c7f215db27ddb4e39772e7624010d55cc6abba550d7f9837b2e0d5d6b30341 | 268 |
  | mpc-natsats-uranus | 2 882 | b45ec33c6c20db255aeb700bccbdf42cc8737b080d8cbc301bb0cb1f1c28cf98 | 10 |
  | mpc-natsats-neptune | 2 420 | fa7fcdc31ce9975aab00aaf506f358eb9e91ccb27491d0355f8e53daa4ab640d | 8 |

- **Format:** https://www.minorplanetcenter.net/iau/info/SatOrbitFormat.html. "Orbital elements for natural satellites are planet-barycentric": epoch, time of pericentre, argument of pericentre, node and inclination (ecliptic J2000), e, pericentre distance (au), central body, absolute magnitude H, arc, observations, residual.
- **Version:** a snapshot of the retrieval date; the service is updated as orbits are refined and moons are added.

## How it is used

`synthetic` stage, populations `irregular-<planet>` (pipeline/syn_outer.py):

- **The known moons.** Their H (V band: Ashton et al. 2025 Sec. 4.1, `ashton-2025-saturn`) and (a, e, i) are the catalogue the irregular-moon models are conditioned on: the known count per H bin sets the completeness limit, and the known moons per (a, H) group are subtracted from the model.
- **Orbit template.** The (a, e, i) of the known moons of the modelled class brighter than the limit are the orbit distribution of the synthetic moons (an assumption, labelled as such: no debiased orbit model of irregular moons is published).
- **Magnitude calibration.** The discovery surveys' own photometry of known moons (transcribed in `syn_tables/populations.json`) against these H gives the offset from each survey's magnitudes to H_V.
- **Cross-match with the app's moons** (`bodies.json`, NAIF satellite kernels), by MPC number or designation: 106 of 107 Jovian, 267 of 268 Saturnian and all Uranian and Neptunian irregulars are in the app. The unmatched two are numbered moons without a name in the MPC list (Jupiter LXXIII, Saturn LXVII); the app has two provisionally designated Jovian (S/2003 J 2, S/2025 J 1) and two Saturnian (S/2004 S 7, S/2009 S 2) moons the list does not name, so the pairs are probably the same objects under their new numbers. S/2009 S 2 rests on four Cassini images and is in no ground-based list.

## Caveats

- The elements are osculating at each orbit's own epoch, and the Sun perturbs irregular moons strongly (e and i oscillate over centuries): time-averaged elements would describe families better. Only (a, e, i) bins of 0.01–0.02 au × 0.1 × 5° are used.
- H values of small moons come from discovery photometry, often in R or w bands converted by the MPC; their scatter is ~0.1–0.3 mag (see the calibrations in docs/reports/synthetic-populations.md §12).
