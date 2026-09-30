# Shape models of irregular bodies (`shape-<key>`, `damit`)

The `shapes` stage (`pipeline/src/pipeline/stages/shapes.py`) converts published shape models into `shapes/<id>.json` + `.bin` (`ShapeModelHeader`). The catalogue in `shape_catalog.py` lists every model with its file, method, citation, label and frame. Each model gets its own SourceRecord (`shape-<key>`) that pins the downloaded files (and the SPICE kernels used for the frame comparison) by sha256.

## Labels

| Method | Label | Why |
|---|---|---|
| Spacecraft stereophotoclinometry (SPC), stereophotogrammetry (SPG), structure from motion (SfM), laser altimetry (OLA) | measured | the surface is reconstructed from many resolved images or ranges; errors are small compared with the shape |
| Spacecraft limb, terminator and control-point models (Thomas) | measured | resolved images; coarse (2° grids or tens of thousands of plates); unseen regions are interpolated (noted per body) |
| Radar delay-Doppler inversion (Hudson method) | measured | resolved delay-Doppler images; resolution tens of metres; some sides less constrained |
| Hand-fitted limb models from a few low-resolution images (Stooke: Amalthea, Thebe, Proteus, Larissa) | **estimated** | the author calls them preliminary / of limited accuracy; Larissa is fitted to a single image |
| Lightcurve inversion (DAMIT) | **derived** | the light curves are measured; the shape is the solution of an inverse problem with an assumed scattering law (Lambert + Lommel-Seeliger) and, for convex models, the convexity constraint. Global elongation and pole are constrained by the data; concavities are not (convex hull by construction), and the size is usually not constrained at all (dimensionless models) |

## Sources

- **NAIF/ESA/JAXA SPICE DSK files** (type 2 plate models), read with spiceypy 8.2: Phobos (Gaskell 2011, `PHOBOS_M003_GAS_V01.BDS`, ESA SPICE); Deimos (Thomas 1993, `deimos_k005_tho_v02.bds`, ESA Hera SPICE); Eros (Gaskell 2008, NAIF generic `near-a-msi-5-erosshape-v1_0_512q.bds`); Itokawa (Gaskell et al. 2008, `hay_a_amica_5_itokawashape_v1_0_512q.bds`); Bennu (Barnouin et al. 2020, Daly et al. 2020, OLA v021 1.68 m); Ryugu (Watanabe et al. 2019, SfM 800k, 2020-08-15 release, Hayabusa2 SPICE archive doi:10.17597/isas.darts/hyb2-00600); Vesta and Ceres (Dawn gravity team SPC; Park et al. 2019 for Ceres); Arrokoth (Porter et al. 2024, `mu69_porter_2024_v01.bds`); 67P (Preusker et al. 2017, SHAP4S 4M, `ROS_CG_M004_OSPGDLR_N_V1.BDS`); Lutetia and Steins (Farnham 2013; Farnham & Jorda 2013); 9P/Tempel 1 (Thomas et al. 2013); Didymos and Dimorphos (DART SPC: Daly et al. 2023; Barnouin et al. 2024; Hera SPICE); Donaldjohanson (Lucy DLR team 2025).
- **PDS Small Bodies Node**: Saturn small satellites (Thomas 2018 bundle `saturn_satellite_shape_models`: Atlas, Calypso, Daphnis, Epimetheus, Helene, Hyperion, Janus, Pan, Pandora, Prometheus, Telesto; ~30 k plates each); Phoebe (Gaskell & Weirich 2023, `phoebe_128_o.obj`); Thomas grid models of Ida, Gaspra and Mathilde (`ast-sat.thomas.shape-models`; 2° lat/lon radius grids; the label states the longitude direction); Stooke models of Amalthea, Thebe, Proteus and Larissa (`small_bodies.stooke.shape-models`, 5° grids, west longitudes); radar models (`gbo.ast.jpl.radar.shape_models` with spin-state CSVs and their PDS4 field definitions; `compil.ast.radar.shape-models` (Hudson/Ostro, PDS3 EAR-A-5-DDR-RADARSHAPE-MODELS-V2.0); Apophis (Brozović et al. 2018)).
- **DAMIT** (Ďurech et al. 2010, A&A 513, A46; CC BY 4.0): complete export `damit-20260930T000302Z.tar.gz` (1.32 GB; only `shape.txt`, `spin.txt`, `IAUspin`/`IAUspin.txt` and the tables are read; the tar is deleted after one extraction pass, ~0.2 GB of extracted shapes stay in data/cache). 16,098 models of 10,753 asteroids (the 8 tumbler models are not included). Rotation convention (DAMIT documentation): r_ecl = Rz(λ) Ry(90° − β) Rz(φ0 + 2π(t − t0)/P + ½υ(t − t0)²) r_ast; the IAU form W = W0 + dW/dt (t − J2000) is given where DAMIT provides it.
- **JPL SBDB API** (`https://ssd-api.jpl.nasa.gov/sbdb.api`): SPK-IDs and the diameters used for the scale check (each response saved and hashed).

## Frames

The vertices stay in each source's own body-fixed frame. Each header's `orientation` block gives the following:

- the frame's name;
- the SPICE kernels that define it for the source (mission PCK/FK);
- the rotation constants behind it;
- the app's frame for the body (the IAU frame of pck00011, which bodies.json uses), with its constants;
- the angle between the two frames at J2000 and 2026-10-01, computed with SPICE in a separate process.

The constants include the nutation/precession terms where the kernel has them: Phobos's are ~2° (pck00010), Deimos's and Vesta's smaller. For a frame without constants of its own, such as Lutetia's ROS_LUTETIA (the RSOC PCK frame turned 164.7° so that Lauriacum is on the prime meridian), they are the equivalent constant pole and uniform rate, evaluated with SPICE. The app places each mesh with them (docs/rendering-shapes.md §2). `build --only shapes --set shapes.reorient=1` (or `SHAPES_REORIENT=1`) recomputes only these blocks. `uv run python -m pipeline.shape_fixtures` writes the app's reference fixture: SPICE `pxform` of those frames, and DAMIT models with both spin forms.

Where pck00011 has no rotation for a body (Bennu, Ryugu, Arrokoth, Didymos, Donaldjohanson, Mathilde, radar targets), the source's own rotation constants or spin state are the only orientation available. They are given so the renderer can use them.

## Processing

1. Weld duplicate vertices (ICQ models repeat the vertices along cube-face seams). Drop degenerate plates, repeated plates and zero-volume back-to-back plate pairs. Lutetia's K780 model has one such pair, and removing it closes the surface. The header counts removed plates (`weldedTriangles`, `notes`).
2. Orient the faces outward, using the signed volume.
3. Check integrity: every edge must be shared by exactly two faces with opposite directions. The header also records the connected components and, for closed meshes, the genus (handles). Two sources are not sphere-like. Arrokoth is two closed lobes that interpenetrate by ~1.6 km³ (0.04 % of the volume). 67P's SHAP4S surface has handles: 4 in the 2 M-plate level, i.e. thin tunnels under overhangs. Decimation closes them at the coarsest level, which keeps a few non-manifold edges; that level is flagged (`watertight: false`, `defectEdges`, a note).
4. Decimate to at most 4 LODs by quadric error (Garland & Heckbert 1997, `fast-simplification` 0.2), about ÷4 per level, each level from the previous one. LOD 0 is capped at 2 M triangles for Ceres, Vesta, 67P and Phobos, and at 1 M for the others. An edge collapse sometimes folds two triangles back to back onto the same three vertices (a zero-volume fin whose edges then belong to four triangles); such pairs are removed, which closes the surface again (`cancel_fins`). If a level of a closed source is still open, it is re-decimated with gentler settings and slightly different targets. Each LOD records `method` (`source` or `quadric`), `watertight` (recomputed from the edges; `defectEdges` when open) and its volume relative to the source.
5. Compute area-weighted vertex normals.
6. Check the scale: the volume-equivalent radius against the pck00011 triaxial radii (volumetric mean) or the SBDB diameter. Where the two disagree by more than 10 %, the reference is usually the weaker value, and the header notes say why:
   - NEOWISE thermal diameters for Donaldjohanson and Bacchus;
   - 1994 pre-radar compilation values for Toutatis and Castalia;
   - pck00011's ellipsoid for Ida.

   The exception is 1998 KY26, whose radar size (~30 m) is disputed by Santana-Ros et al. (2025, 11 m).
7. Frame sanity: for principal-axis rotators with well-separated moments, the short principal axis of the enclosed volume must be the frame's +z (spin) axis. It is within 1° for Phobos, Eros, Itokawa, Ida, Arrokoth, Steins, Vesta, Bennu and Ryugu, and within 4° for 67P. Phobos's long axis is within 1° of +x (towards Mars), and Stickney is a depression at its gazetteer position (tests).
