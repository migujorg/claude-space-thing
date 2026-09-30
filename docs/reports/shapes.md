# Shape models: review report

Generated 2026-09-30 (commit 92416f4) by `cd pipeline && uv run python -m pipeline.shape_report` from `app/public/data/shapes/`. Contract: `ShapeModelHeader`, `DamitIndexHeader` and `ShapeIndex` in app/src/data/schema.ts; architecture §6; source notes docs/sources/shape-models.md.

## Summary

- **56 meshes** (spacecraft 35, radar 21): 407 MiB of LOD meshes.
- **DAMIT:** 16,098 lightcurve-inversion models of 10,753 asteroids (19,924,304 triangles), 173 MiB. Label derived; one preferred model per asteroid is flagged. 5 models are not closed and 267 needed vertex welding.
- **Total product:** 580 MiB (0.61 GB).
- **Build time:** phobos 186 s, deimos 1 s, eros 93 s, itokawa 129 s, bennu 26 s, ryugu 21 s, vesta 115 s, ceres 176 s, arrokoth 1 s, 67p 363 s, lutetia 66 s, steins 3 s, tempel1 2 s, didymos 84 s, dimorphos 88 s, donaldjohanson 15 s, atlas 2 s, calypso 2 s, daphnis 1 s, epimetheus 3 s, helene 2 s, hyperion 2 s, janus 2 s, pan 2 s, pandora 2 s, prometheus 2 s, telesto 2 s, phoebe 9 s, ida 3 s, gaspra 2 s, mathilde 1 s, amalthea 2 s, thebe 2 s, proteus 1 s, larissa 1 s, rashalom 0 s, mithra 0 s, nereus 0 s, 1992sk 0 s, 1950da 0 s, 1998wt24 0 s, yorp 0 s, moshup 0 s, squannit 0 s, 1994cc 0 s, 2002ce26 0 s, 2008ev5 0 s, apophis 0 s, kleopatra 0 s, geographos 0 s, 1998ky26 0 s, bacchus 0 s, toutatis 1 s, castalia 0 s, golevka 0 s, 1998ml14 0 s, damit 120 s.

## Meshes

LOD triangle counts run finest first. R_eq is the volume-equivalent radius of the source mesh. The reference is the pck00011 volumetric mean radius or the SBDB diameter / 2. The orientation difference is the rotation angle between the source's frame and the app's pck00011 IAU frame at J2000 and 2026-10-01.

| body | id | kind | shape label | source triangles | LOD triangles | closed | MiB | R_eq (km) | reference (km) | ratio | frame | vs app frame | orientation label |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (1998 KY26) | 50012415 | radar | measured | 4,092 | 4,092 / 1,022 | yes | 0.1 | 0.01321 | 0.0055 (SBDB) | 2.402 | principal axes (radar model) | – | unknown |
| 10115 (1992 SK) | 20010115 | radar | measured | 1,016 | 1,016 | yes | 0.0 | 0.5025 | 0.469 (SBDB) | 1.071 | principal axes (radar model) | – | measured |
| 136617 (1994 CC) | 20136617 | radar | measured | 3,996 | 3,996 | yes | 0.1 | 0.3101 | – | – | principal axes (radar model) | – | measured |
| 1620 Geographos | 20001620 | radar | measured | 16,380 | 16,380 / 4,094 / 1,022 | yes | 0.3 | 1.299 | 1.28 (SBDB) | 1.015 | principal axes (radar model) | – | unknown |
| 2063 Bacchus | 20002063 | radar | measured | 4,092 | 4,092 / 1,022 | yes | 0.1 | 0.3186 | 0.512 (SBDB) | 0.622 | principal axes (radar model) | – | unknown |
| 2100 Ra-Shalom | 20002100 | radar | measured | 2,292 | 2,292 | yes | 0.0 | 1.14 | 1.15 (SBDB) | 0.991 | principal axes (radar model) | – | measured |
| 216 Kleopatra | 20000216 | radar | measured | 4,092 | 4,092 / 1,022 | yes | 0.1 | 55.31 | 61 (SBDB) | 0.907 | principal axes (radar model) | – | unknown |
| 276049 (2002 CE26) | 20276049 | radar | measured | 2,292 | 2,292 | yes | 0.0 | 1.73 | 1.75 (SBDB) | 0.988 | principal axes (radar model) | – | measured |
| 29075 (1950 DA) | 20029075 | radar | measured | 1,016 | 1,016 | yes | 0.0 | 0.6491 | 0.65 (SBDB) | 0.999 | principal axes (radar model) | – | measured |
| 33342 (1998 WT24) | 20033342 | radar | measured | 7,996 | 7,996 / 1,998 | yes | 0.1 | 0.2077 | 0.216 (SBDB) | 0.961 | principal axes (radar model) | – | measured |
| 341843 (2008 EV5) | 20341843 | radar | measured | 3,996 | 3,996 | yes | 0.1 | 0.2026 | 0.2 (SBDB) | 1.013 | principal axes (radar model) | – | measured |
| 4179 Toutatis | 20004179 | radar | measured | 39,996 | 39,996 / 9,998 / 2,498 | yes | 0.8 | 1.224 | 2.7 (SBDB) | 0.453 | principal axes (radar model) | – | measured |
| 4486 Mithra | 20004486 | radar | measured | 5,996 | 5,996 / 1,498 | yes | 0.1 | 0.8456 | 0.9245 (SBDB) | 0.915 | principal axes (radar model) | – | measured |
| 4660 Nereus | 20004660 | radar | measured | 2,292 | 2,292 | yes | 0.0 | 0.1667 | 0.165 (SBDB) | 1.010 | principal axes (radar model) | – | measured |
| 4769 Castalia | 20004769 | radar | measured | 4,092 | 4,092 / 1,022 | yes | 0.1 | 0.5422 | 0.7 (SBDB) | 0.775 | principal axes (radar model) | – | unknown |
| 52760 (1998 ML14) | 20052760 | radar | measured | 16,320 | 16,320 / 4,080 / 1,020 | yes | 0.3 | 0.4961 | 0.5 (SBDB) | 0.992 | principal axes (radar model) | – | unknown |
| 54509 YORP | 20054509 | radar | measured | 572 | 572 | yes | 0.0 | 0.05639 | – | – | principal axes (radar model) | – | measured |
| 6489 Golevka | 20006489 | radar | measured | 4,092 | 4,092 / 1,022 | yes | 0.1 | 0.265 | 0.265 (SBDB) | 1.000 | principal axes (radar model) | – | unknown |
| 66391 Moshup (1999 KW4) | 20066391 | radar | measured | 9,168 | 9,168 / 2,292 | yes | 0.2 | 0.6584 | 0.6585 (SBDB) | 1.000 | principal axes (radar model) | – | measured |
| 99942 Apophis | 20099942 | radar | measured | 3,996 | 3,996 | yes | 0.1 | 0.1679 | 0.17 (SBDB) | 0.988 | principal axes (radar model) | – | measured |
| Squannit (66391 Moshup I) | 120066391 | radar | measured | 2,292 | 2,292 | yes | 0.0 | 0.2255 | – | – | principal axes (radar model) | – | measured |
| 1 Ceres | 20000001 | spacecraft | measured | 3,145,728 | 2,000,000 / 499,986 / 124,966 / 31,224 | yes | 52.3 | 469.7 | 473.1 (pck00011) | 0.993 | IAU_CERES | 2000 0.33°; 2026 0.29° | measured |
| 101955 Bennu | 20101955 | spacecraft | measured | 786,432 | 786,432 / 196,346 / 48,898 / 12,160 | yes | 20.6 | 0.2446 | 0.2422 (SBDB) | 1.010 | IAU_BENNU | – | measured |
| 162173 Ryugu | 20162173 | spacecraft | measured | 799,998 | 799,998 / 199,910 / 49,926 / 12,442 | yes | 20.9 | 0.4491 | 0.448 (SBDB) | 1.002 | RYUGU_FIXED | – | measured |
| 21 Lutetia | 20000021 | spacecraft | measured | 784,510 | 784,508 / 196,126 / 49,030 / 12,256 | yes | 20.5 | 49.2 | 52.61 (pck00011) | 0.935 | ROS_LUTETIA | 2000 164.54°; 2026 164.35° | measured |
| 243 Ida | 20000243 | spacecraft | measured | 32,040 | 32,040 / 8,010 / 2,002 | yes | 0.6 | 15.66 | 13.47 (pck00011) | 1.163 | IAU_IDA | – | measured |
| 25143 Itokawa | 20025143 | spacecraft | measured | 3,145,728 | 1,000,000 / 249,948 / 62,406 / 15,584 | yes | 26.1 | 0.1618 | 0.16 (pck00011) | 1.011 | IAU_ITOKAWA | 2000 0.00°; 2026 0.00° | measured |
| 253 Mathilde | 20000253 | spacecraft | measured | 14,160 | 14,160 / 3,538 | yes | 0.3 | 25.6 | 26.4 (SBDB) | 0.970 | MATHILDE body-fixed | – | measured |
| 2867 Steins | 20002867 | spacecraft | measured | 20,480 | 20,480 / 5,120 / 1,280 | yes | 0.4 | 2.631 | 2.623 (pck00011) | 1.003 | STEINS_FIXED | 2000 0.30°; 2026 0.33° | measured |
| 4 Vesta | 20000004 | spacecraft | measured | 3,145,728 | 2,000,000 / 500,000 / 124,996 / 31,250 | yes | 52.3 | 261.5 | 264.6 (pck00011) | 0.988 | IAU_VESTA | 2000 0.73°; 2026 1.05° | measured |
| 433 Eros | 20000433 | spacecraft | measured | 3,145,728 | 1,000,000 / 250,000 / 62,498 / 15,622 | yes | 26.2 | 8.428 | 8.012 (pck00011) | 1.052 | EROS_FIXED | 2000 0.02°; 2026 6.19° | measured |
| 486958 Arrokoth | 20486958 | spacecraft | measured | 40,960 | 40,960 / 10,240 / 2,560 | yes | 0.8 | 9.948 | – | – | IAU_ARROKOTH | – | measured |
| 52246 Donaldjohanson | 20052246 | spacecraft | measured | 547,996 | 547,996 / 136,998 / 34,248 / 8,562 | yes | 14.3 | 2.405 | 1.948 (SBDB) | 1.235 | DONALDJOHANSON_FIXED | – | measured |
| 65803 Didymos | 20065803 | spacecraft | measured | 3,145,728 | 1,000,000 / 250,000 / 62,500 / 15,622 | yes | 26.2 | 0.3651 | 0.39 (SBDB) | 0.936 | DIDYMOS_FIXED | – | measured |
| 67P/Churyumov-Gerasimenko | 1000012 | spacecraft | measured | 3,999,958 | 1,999,896 / 499,994 / 124,998 / 31,224 | no (LOD 3) | 52.3 | 1.621 | 1.647 (pck00011) | 0.985 | 67P/C-G_CK | – | unknown |
| 951 Gaspra | 20000951 | spacecraft | measured | 32,040 | 32,040 / 8,010 / 2,002 | yes | 0.6 | 6.104 | 5.927 (pck00011) | 1.030 | IAU_GASPRA | – | measured |
| 9P/Tempel 1 | 1000093 | spacecraft | measured | 32,040 | 32,040 / 8,010 / 2,002 | yes | 0.6 | 2.833 | 3 (pck00011) | 0.944 | IAU_TEMPEL_1 | – | measured |
| Amalthea | 505 | spacecraft | estimated | 5,040 | 5,040 / 1,260 | yes | 0.1 | 81.68 | 83.59 (pck00011) | 0.977 | IAU_AMALTHEA | – | measured |
| Atlas | 615 | spacecraft | measured | 26,990 | 26,990 / 6,746 / 1,676 | yes | 0.5 | 14.89 | 15.08 (pck00011) | 0.987 | IAU_ATLAS | – | measured |
| Calypso | 614 | spacecraft | measured | 28,276 | 28,276 / 7,062 / 1,748 | yes | 0.5 | 9.492 | 9.642 (pck00011) | 0.984 | IAU_CALYPSO | – | measured |
| Daphnis | 635 | spacecraft | measured | 26,926 | 26,926 / 6,728 / 1,678 | yes | 0.5 | 3.886 | 3.87 (pck00011) | 1.004 | IAU_DAPHNIS | – | measured |
| Deimos | 402 | spacecraft | measured | 5,040 | 5,040 / 1,260 | yes | 0.1 | 6.232 | 6.203 (pck00011) | 1.005 | IAU_DEIMOS | 2000 0.01°; 2026 0.11° | measured |
| Dimorphos (65803 Didymos I) | 120065803 | spacecraft | measured | 3,145,728 | 1,000,000 / 249,994 / 62,480 / 15,614 | yes | 26.2 | 0.0749 | – | – | DIMORPHOS_FIXED | – | measured |
| Epimetheus | 611 | spacecraft | measured | 27,826 | 27,826 / 6,954 / 1,728 | yes | 0.5 | 58.49 | 58.2 (pck00011) | 1.005 | IAU_EPIMETHEUS | – | measured |
| Helene | 612 | spacecraft | measured | 26,986 | 26,986 / 6,746 / 1,678 | yes | 0.5 | 18.02 | 18.03 (pck00011) | 0.999 | IAU_HELENE | – | measured |
| Hyperion | 607 | spacecraft | measured | 29,268 | 29,268 / 7,314 / 1,826 | yes | 0.5 | 136 | 135 (pck00011) | 1.008 | IAU_HYPERION | – | unknown |
| Janus | 610 | spacecraft | measured | 26,758 | 26,758 / 6,688 / 1,666 | yes | 0.5 | 88.91 | 89.7 (pck00011) | 0.991 | IAU_JANUS | – | measured |
| Larissa | 807 | spacecraft | estimated | 5,040 | 5,040 / 1,260 | yes | 0.1 | 94.57 | 96 (pck00011) | 0.985 | IAU_LARISSA | – | measured |
| Pan | 618 | spacecraft | measured | 27,468 | 27,468 / 6,866 / 1,710 | yes | 0.5 | 13.67 | 14.02 (pck00011) | 0.975 | IAU_PAN | – | measured |
| Pandora | 617 | spacecraft | measured | 27,124 | 27,124 / 6,780 / 1,688 | yes | 0.5 | 39.97 | 40.63 (pck00011) | 0.984 | IAU_PANDORA | – | measured |
| Phobos | 401 | spacecraft | measured | 3,145,728 | 2,000,000 / 500,000 / 125,000 / 31,250 | yes | 52.3 | 11.12 | 11.05 (pck00011) | 1.006 | IAU_PHOBOS | 2000 0.14°; 2026 2.47° | measured |
| Phoebe | 609 | spacecraft | measured | 196,608 | 196,608 / 49,152 / 12,288 / 3,072 | yes | 4.9 | 106.7 | 106.5 (pck00011) | 1.002 | IAU_PHOEBE | – | measured |
| Prometheus | 616 | spacecraft | measured | 28,362 | 28,362 / 7,090 / 1,760 | yes | 0.5 | 42.58 | 43.09 (pck00011) | 0.988 | IAU_PROMETHEUS | – | measured |
| Proteus | 808 | spacecraft | estimated | 5,040 | 5,040 / 1,260 | yes | 0.1 | 201 | 208.9 (pck00011) | 0.962 | IAU_PROTEUS | – | measured |
| Telesto | 613 | spacecraft | measured | 27,604 | 27,604 / 6,898 / 1,710 | yes | 0.5 | 12.27 | 12.35 (pck00011) | 0.993 | IAU_TELESTO | – | measured |
| Thebe | 514 | spacecraft | estimated | 5,040 | 5,040 / 1,260 | yes | 0.1 | 45.55 | 49.24 (pck00011) | 0.925 | IAU_THEBE | – | measured |

## Verification

`uv run pytest tests/test_shapes.py` covers the following:

- mesh utilities: cube volume and area, orientation flip, boundary detection, seam welding, sphere from a radius grid, decimation that keeps a mesh closed and its volume, removal of back-to-back fins, binary round trip, outward unit normals, and the plate/OBJ readers;
- every built mesh: part sizes, index bounds, finite vertices, decreasing LODs of at most 2 M triangles, each LOD's `watertight` flag recomputed from its edges, each LOD closed when the source is, volumes within 2 %, and |R_eq / reference − 1| < 10 % for measured shapes (exceptions below);
- the DAMIT table: one preferred model per asteroid, SPK-ID = 20000000 + number, `closed` flags that match the header count, a Pallas model decoded to a closed polyhedron of the right size, and the pole convention (DAMIT's ecliptic λ, β rotated to the equator match the spacecraft poles of Eros, Vesta and Lutetia: Eros 0.4°, Vesta 3.8°, Lutetia 0.9° (closest of 2 models));
- the orientation helper: constants re-derived from a PCK frame match the PCK's.

Frame checks:

- **Phobos frame:** the long principal axis is 0.8° from ±x (it points at Mars; IAU longitude 0° is the sub-Mars point) and the short axis 0.7° from +z (the spin axis). **Stickney** (IAU Gazetteer 1.0°S, 49.0°W): mean radius within 5° of its centre 11.047 km, on a 22-30° ring 12.291 km. It is a depression at the gazetteer position, so longitudes run the right way.
- **Bennu:** mean radius per 5° latitude band peaks at +2.5° (269 m, against 229 m at 60°S): the equatorial ridge lies on the z = 0 plane.
- **Eros:** extents along the frame axes x 32.7, y 16.9, z 12.0 km (published 34.4 × 11.2 × 11.2 km along its own axes); the long principal axis is 9.4° from +x and the short axis 0.0° from +z (the spin axis).
- **Ryugu:** equatorial radius 501 m vs polar 442 m: the spinning-top shape with its ridge on the equator.
- **Spin axis = short axis** (principal-axis rotators with well-separated moments; angle between the shape's short principal axis and the frame's +z): Phobos 0.7°, 433 Eros 0.0°, 25143 Itokawa 0.9°, 243 Ida 0.8°, 486958 Arrokoth 0.3°, 67P/Churyumov-Gerasimenko 3.9°, 2867 Steins 0.0°, 4 Vesta 0.5°, 101955 Bennu 0.7°, 162173 Ryugu 0.6°, 21 Lutetia 2.0°, Atlas 0.1°, Janus 0.3°.

## Open issues and caveats

- **Scale exceptions:**
  - Ida: R_eq 15.7 km matches Thomas et al.'s 16,100 km³, but pck00011's triaxial radii imply 13.4 km.
  - Kleopatra: the 2000 radar model is ~10 % smaller than later adaptive-optics sizes.
  - 1998 KY26: the 1999 radar model is ~30 m across, while SBDB now gives 11 m (Hayabusa2-era observations, Santana-Ros et al. 2025). The header notes that the size is disputed.
  - Bacchus: SBDB's 1.02 km is NEOWISE's thermal-model diameter; the radar model spans 1.11 × 0.53 × 0.51 km (Benner et al. 1999).
  - Toutatis and Castalia: SBDB's 5.4 km and 1.4 km come from a 1994 compilation that predates the radar models; Toutatis's extents match Hudson & Ostro (1995).
  - Donaldjohanson: SBDB's 3.9 km is NEOWISE's thermal-model diameter (Masiero et al. 2011); the Lucy shape spans 8.8 × 4.4 × 3.1 km (R_eq 2.41 km), as the flyby images show.
- **Orientation:**
  - 67P (Rosetta CK frame), Dimorphos (two-vector frame towards Didymos) and Apophis (tumbling) cannot be compared with a constant-rate model.
  - Hyperion rotates chaotically, 67P's spin changes at every perihelion (no rotation model valid in 2026), and the radar models without a spin file have no rotation model: their orientation label is unknown.
  - Where the source frame and pck00011 drift apart, the mesh must be placed with the header's `sourceRotation`, not the app's IAU frame. Phobos (pck00010 vs pck00011) is 2.5° off by 2026-10, and Eros (the shape frame's spin rate in eros_alex.tpc vs pck00011's) 6.2°. Lutetia's shape frame puts the crater Lauriacum on the prime meridian, 164° from pck00011's IAU_LUTETIA; its `sourceRotation` is evaluated from the Rosetta frame kernels.
  - The Saturn small-satellite models state binary PCKs (`*_mst2018.bpc`) in their labels; these were not used for the comparison.
- **Topology:** 67P's source surface has handles (tunnels through the mesh; genus in the header), and the coarsest LOD, where decimation closes them, keeps a few non-manifold edges (flagged). Arrokoth's model is two closed lobes that interpenetrate slightly at the neck: its volume and R_eq are the sum of the lobes. Lutetia's source has one zero-volume back-to-back plate pair; it is removed, which closes the surface.
- **Coverage:** Arrokoth's far side, Lutetia's south, Didymos's and Dimorphos's unseen sides, Mathilde's unseen 40 % and parts of the Voyager/Galileo-era models are smooth interpolations (noted per header).
- **Not available:**
  - Dinkinesh/Selam: no public shape model yet.
  - Annefrank, Braille: no published shape model in PDS.
  - Hartley 2, Wild 2, Borrelly: not included this round; their models exist.
  - The New Horizons Charon/Pluto DEMs: not included; they are near-spheres.
- **DAMIT:** tumblers are not included, and the preferred model is a pipeline choice (highest quality flag, then newest), not DAMIT's. Mirror-pole solutions remain as separate rows.
