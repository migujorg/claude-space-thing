"""The shape models built by the `shapes` stage: where each comes from, how it was made, and its frame.

Labels (docs/architecture.md §2): spacecraft stereophotoclinometry (SPC), stereophotogrammetry (SPG), structure from
motion (SfM) and laser altimetry → measured; radar delay-Doppler inversion → measured; spacecraft limb/control-point
models (Thomas) → measured at their coarse resolution; hand-fitted limb models from a few low-resolution images
(Stooke) → estimated; lightcurve inversion (DAMIT, shape_damit.py) → derived.

Keys: planetary satellites by NAIF id; asteroids and comets by the JPL SBDB SPK-ID (as the small-body catalogue),
looked up through the SBDB API at build time; satellites of asteroids by the NAIF convention 1xxxxxxxx /
2xxxxxxxx (first / second satellite of 20000000 + number).
"""

from __future__ import annotations

from dataclasses import dataclass, field

N = "https://naif.jpl.nasa.gov/pub/naif"
E = "https://spiftp.esac.esa.int/data/SPICE"
SBN = "https://sbnarchive.psi.edu/pds4"
PCK10 = f"{N}/generic_kernels/pck/pck00010.tpc"


@dataclass(frozen=True)
class ShapeSource:
    key: str                        # short name, also the raw-data subdirectory
    name: str
    naif: int | None                # SPICE body id (None: not in SPICE)
    sbdb: str | None                # SBDB search string (asteroids, comets) → SPK-ID, diameter for the scale check
    fmt: str                        # 'dsk' | 'plate' | 'obj' | 'grid-latlon' | 'grid-lonlat' | 'tab-obj'
    url: str
    kind: str                       # 'spacecraft' | 'radar' | 'lightcurve'
    label: str
    method: str
    citation: str
    finest: int                     # LOD 0 triangle cap
    frame: str                      # the body-fixed frame the vertices are given in
    frame_note: str = ""
    kernels: tuple = ()             # SPICE kernels that define `frame` as used by the source (for the comparison)
    compare_epochs: tuple = ("2000-01-01T12:00:00", "2026-10-01T00:00:00")
    lon_west: bool = False          # grids: longitudes positive west
    rotation: dict | None = None    # rotation constants from the source label (grids, radar spin files)
    spin_url: str | None = None     # radar spin-state CSV
    id_override: int | None = None
    notes: tuple = ()
    extra_files: tuple = field(default_factory=tuple)


def _dsk(key, name, naif, sbdb, url, method, citation, finest, frame, kernels=(), note="", notes=(),
         label="measured", epochs=None, id_override=None) -> ShapeSource:
    kw = {"compare_epochs": epochs} if epochs else {}
    return ShapeSource(key, name, naif, sbdb, "dsk", url, "spacecraft", label, method, citation, finest, frame, note,
                       tuple(kernels), notes=tuple(notes), id_override=id_override, **kw)


SPACECRAFT = [
    _dsk("phobos", "Phobos", 401, None, f"{N}/MEX/kernels/dsk/PHOBOS_M003_GAS_V01.BDS",
         "Stereophotoclinometry (SPC) from Viking Orbiter and other images, 3.1 M plates (ICQ q = 512)",
         "Gaskell, R.W. (2011). Gaskell Phobos Shape Model V1.0. VO1-SA-VISA/VISB-5-PHOBOSSHAPE-V1.0, NASA "
         "Planetary Data System. DSK by the ESA SPICE Service (PHOBOS_M003_GAS_V01.BDS, 2018).",
         2_000_000, "IAU_PHOBOS", [PCK10], "built with pck00010",
         notes=["Retrieved from the official NAIF Mars Express mirror of ESA's PHOBOS_M003_GAS_V01 model. "
                "The mirror's file comments differ from the ROSETTA copy; the source ledger pins its bytes."]),
    _dsk("deimos", "Deimos", 402, None, f"{E}/HERA/kernels/dsk/deimos_k005_tho_v02.bds",
         "Limb and control-point model from Viking Orbiter images (Thomas), 5040 plates",
         "Thomas, P.C. (1993). Gravity, tides, and topography on small satellites and asteroids: application to "
         "surface features of the Martian satellites. Icarus 105, 326-344. doi:10.1006/icar.1993.1130. Data: "
         "EAR-A-5-DDR-SHAPE-MODELS (PDS SBN); DSK by the ESA SPICE Service (deimos_k005_tho_v02.bds, 2023, which "
         "corrects a 180° rotation of v01).",
         2_000_000, "IAU_DEIMOS", [PCK10], "built with pck00010"),
    _dsk("eros", "433 Eros", 2000433, "433", f"{N}/generic_kernels/dsk/asteroids/eros/"
         "near-a-msi-5-erosshape-v1_0_512q.bds",
         "Stereophotoclinometry (SPC) from NEAR MSI images, 3.1 M plates (ICQ q = 512)",
         "Gaskell, R.W. (2008). Gaskell Eros Shape Model V1.0. NEAR-A-MSI-5-EROSSHAPE-V1.0, NASA Planetary Data "
         "System. DSK by NAIF (2015).",
         1_000_000, "EROS_FIXED",
         [f"{N}/pds/data/near-a-spice-6-v1.0/nearsp_1000/data/fk/eros_fixed.tf",
          "https://sbnarchive.psi.edu/pds3/near/NEAR_A_MSI_5_EROSSHAPE_V1_0/document/eros_alex.tpc"],
         "EROS_FIXED with the rotation constants of eros_alex.tpc (Yeomans & Konopliv, JPL), which the DSK "
         "comments and the PDS data set name as the coordinate system of Gaskell's model (pole 11.363°, 17.232°; "
         "W = 326.08° + 1639.38928°/d). NEAR's binary attitude PCK (erosatt_1998329_2001157_v01.bpc) differs "
         "from it by ~5° and is not the shape's frame.",
         notes=["pck00011's spin rate (1639.38864745°/d) and the shape frame's (1639.38928°/d) differ by "
                "0.00063°/d: the prime meridians agree at J2000 but drift ~6° apart by 2026. Eros's rotation phase "
                "today is uncertain at that level."]),
    _dsk("itokawa", "25143 Itokawa", 2025143, "25143", f"{N}/generic_kernels/dsk/asteroids/itokawa/"
         "hay_a_amica_5_itokawashape_v1_0_512q.bds",
         "Stereophotoclinometry (SPC) from Hayabusa AMICA images, 3.1 M plates (ICQ q = 512)",
         "Gaskell, R., Saito, J., Ishiguro, M., Kubota, T., Hashimoto, T., Hirata, N., Abe, S., Barnouin-Jha, O. & "
         "Scheeres, D. (2008). Gaskell Itokawa Shape Model V1.0. HAY-A-AMICA-5-ITOKAWASHAPE-V1.0, NASA Planetary "
         "Data System. DSK by NAIF.",
         1_000_000, "IAU_ITOKAWA", [PCK10], "IAU_ITOKAWA with the constants of pck00010"),
    _dsk("bennu", "101955 Bennu", 2101955, "101955",
         f"{N}/ORX/kernels/dsk/bennu_g_01680mm_alt_obj_0000n00000_v021.bds",
         "OSIRIS-REx Laser Altimeter (OLA) global model, 1.68 m ground sample, 786 k plates",
         "Barnouin, O.S. et al. (2020). Digital terrain mapping by the OSIRIS-REx mission. Planet. Space Sci. 180, "
         "104764. doi:10.1016/j.pss.2019.104764; Daly, M.G. et al. (2020). Hemispherical differences in the shape "
         "and topography of asteroid (101955) Bennu. Sci. Adv. 6, eabd3649. DSK "
         "bennu_g_01680mm_alt_obj_0000n00000_v021 (OSIRIS-REx SPICE, 2021).",
         1_000_000, "IAU_BENNU", [f"{N}/ORX/kernels/pck/bennu_v17.tpc"], "IAU_BENNU with the OSIRIS-REx PCK"),
    _dsk("ryugu", "162173 Ryugu", 2162173, "162173",
         f"{N}/pds/pds4/hyb2/hyb2_spice/spice_kernels/dsk/ryugu_shape_sfm_800k_v20200815.bds",
         "Structure from motion (SfM) from Hayabusa2 ONC images, 800 k plates (2020-08-15 release)",
         "Watanabe, S. et al. (2019). Hayabusa2 arrives at the carbonaceous asteroid 162173 Ryugu - a spinning "
         "top-shaped rubble pile. Science 364, 268-272. doi:10.1126/science.aav8032. DSK "
         "ryugu_shape_sfm_800k_v20200815 (Hayabusa2 SPICE archive, doi:10.17597/isas.darts/hyb2-00600).",
         1_000_000, "RYUGU_FIXED",
         [f"{N}/pds/pds4/hyb2/hyb2_spice/spice_kernels/fk/hyb2_ryugu_v01.tf",
          f"{N}/pds/pds4/hyb2/hyb2_spice/spice_kernels/pck/ryugu_v10.tpc"], "Hayabusa2 frame and PCK"),
    _dsk("vesta", "4 Vesta", 2000004, "4", f"{N}/DAWN/kernels/dsk/dawn_vesta_grv_icq0512_v1.bds",
         "Stereophotoclinometry (SPC) from Dawn Framing Camera images by the Dawn gravity team, 3.1 M plates",
         "Dawn Gravity Team stereophotoclinometry shape model of Vesta, DSK dawn_vesta_grv_icq0512_v1 (NAIF DAWN "
         "archive; rotation from dawn_vesta_grv221108_v1.tpc).",
         2_000_000, "IAU_VESTA", [f"{N}/DAWN/kernels/pck/dawn_vesta_grv221108_v1.tpc"],
         "IAU_VESTA with the Dawn gravity-team PCK"),
    _dsk("ceres", "1 Ceres", 2000001, "1", f"{N}/DAWN/kernels/dsk/dawn_ceres_grv_icq0512_v2.bds",
         "Stereophotoclinometry (SPC) from Dawn Framing Camera images by the Dawn gravity team, 3.1 M plates",
         "Park, R.S. et al. (2019). High-resolution shape model of Ceres from stereophotoclinometry using Dawn "
         "imaging data. Icarus 319, 812-827. doi:10.1016/j.icarus.2018.10.024. DSK dawn_ceres_grv_icq0512_v2 "
         "(NAIF DAWN archive).",
         2_000_000, "IAU_CERES", [f"{N}/DAWN/kernels/pck/dawn_ceres_grv171219_v1.tpc"],
         "IAU_CERES with the Dawn gravity-team PCK"),
    _dsk("arrokoth", "486958 Arrokoth", 2486958, "486958",
         f"{N}/pds/data/nh-j_p_ss-spice-6-v1.0/nhsp_1000/data/dsk/mu69_porter_2024_v01.bds",
         "Stereo and limb/terminator modelling from New Horizons LORRI and MVIC images, 41 k plates",
         "Porter, S.B., Singer, K.N., Schenk, P.M., McKinnon, W.B., Stern, S.A., Verbiscer, A.J., Parker, J.W., "
         "Brandt, P. & the New Horizons Geology and Imaging Team (2024). The shape and formation of Arrokoth. 55th "
         "LPSC, LPI Contrib. 3040, 2332. DSK mu69_porter_2024_v01 (New Horizons SPICE archive, NAIF 2025).",
         1_000_000, "IAU_ARROKOTH",
         [f"{N}/pds/data/nh-j_p_ss-spice-6-v1.0/nhsp_1000/data/pck/nh_arrokoth_002.tpc"],
         "IAU_ARROKOTH with the New Horizons PCK",
         notes=["The far side (not seen in daylight at the flyby) is constrained only by silhouettes against "
                "background stars and the pre-flyby occultations; its figure is less certain.",
                "The model is two closed lobes (Wenu and Weeyo). They interpenetrate at the neck by ~1.6 km³ "
                "(0.04 % of the summed volume, winding-number Monte Carlo), so the summed volume is the body's to "
                "that accuracy."]),
    _dsk("67p", "67P/Churyumov-Gerasimenko", 1000012, "67P",
         f"{E}/ROSETTA/kernels/dsk/ROS_CG_M004_OSPGDLR_N_V1.BDS",
         "Stereophotogrammetry (SPG) from Rosetta OSIRIS images by DLR (SHAP4S), 4 M plates",
         "Preusker, F. et al. (2017). The global meter-level shape model of comet 67P/Churyumov-Gerasimenko. A&A "
         "607, L1. doi:10.1051/0004-6361/201731798. Data: Scholten, F. (2016). SPG SHAP4S cartesian plate model "
         "for comet 67P/C-G 4M plates, RO-C-MULTI-5-67P-SHAPE-V1.0:CG_SPG_SHAP4S_4M, NASA PDS / ESA PSA. DSK by "
         "NAIF (2016).",
         2_000_000, "67P/C-G_CK", [], "67P/C-G_CK is a CK-based frame (Rosetta attitude of the nucleus)",
         notes=["67P/C-G_CK follows the nucleus attitude that Rosetta reconstructed for 2014-2016 (CK files). "
                "pck00011 has no rotation model for 67P. The spin period dropped from 12.40 h to 12.06 h over the "
                "2015 perihelion and changes at every perihelion (2021-11, 2028-04), so no rotation phase is known "
                "for 2026: the orientation label is unknown."]),
    _dsk("lutetia", "21 Lutetia", 2000021, "21", f"{E}/ROSETTA/kernels/dsk/ROS_LU_K780_OSPCLAM_N_V1.BDS",
         "Stereophotoclinometry (SPC, LAM) from Rosetta OSIRIS images, 785 k plates",
         "Farnham, T.L. (2013). Shape model of asteroid 21 Lutetia, RO-A-OSINAC/OSIWAC-5-LUTETIA-SHAPE-V1.0, NASA "
         "Planetary Data System. DSK ROS_LU_K780_OSPCLAM_N_V1 (ESA SPICE Service).",
         1_000_000, "ROS_LUTETIA",
         [f"{E}/ROSETTA/kernels/fk/ROS_V38.TF", f"{E}/ROSETTA/kernels/fk/ROS_LUTETIA_RSOC_V03.TF",
          f"{E}/ROSETTA/kernels/pck/ROS_LUTETIA_RSOC_V03.TPC"],
         "ROS_LUTETIA is the LUTETIA_FIXED PCK frame (RSOC rotation constants) turned 164.7° about +z so that the "
         "prime meridian contains the crater Lauriacum (Sierks et al. 2011)",
         notes=["Only the northern hemisphere was imaged at the 2010 flyby; the south is a smooth fit."]),
    _dsk("steins", "2867 Steins", 2002867, "2867", f"{E}/ROSETTA/kernels/dsk/ROS_ST_K020_OSPCLAM_N_V1.BDS",
         "Stereophotoclinometry (SPC, LAM) from Rosetta OSIRIS images, 20 k plates",
         "Farnham, T.L. & Jorda, L. (2013). Shape model of asteroid 2867 Steins, "
         "RO-A-OSINAC/OSIWAC-5-STEINS-SHAPE-V1.0, NASA Planetary Data System. DSK ROS_ST_K020_OSPCLAM_N_V1 (ESA "
         "SPICE Service).",
         1_000_000, "STEINS_FIXED",
         [f"{E}/ROSETTA/kernels/fk/ROS_V38.TF", f"{E}/ROSETTA/kernels/pck/ROS_STEINS_V05.TPC"],
         "Rosetta Steins frame and PCK"),
    _dsk("tempel1", "9P/Tempel 1", 1000093, "9P", f"{E}/ROSETTA/kernels/dsk/TEMPEL1_9P_K032_THO_V01.BDS",
         "Limb, terminator and control-point model from Deep Impact and Stardust-NExT images (Thomas), 32 k plates",
         "Thomas, P.C. et al. (2013). The nucleus of Comet 9P/Tempel 1: shape and geology from two flybys. Icarus "
         "222, 453-466. doi:10.1016/j.icarus.2012.02.037. DSK by the ESA SPICE Service.",
         1_000_000, "IAU_TEMPEL_1", [], "IAU_TEMPEL_1 (the model was built with pck00006)"),
    _dsk("didymos", "65803 Didymos", None, "65803",
         f"{E}/HERA/kernels/dsk/g_01165mm_spc_obj_didy_0000n00000_v003.bds",
         "Stereophotoclinometry (SPC) from DART DRACO and LICIACube images, 3.1 M plates",
         "Barnouin, O.S. et al. (2024). The geology and evolution of the near-Earth binary asteroid system (65803) "
         "Didymos. Nat. Commun. 15, 6202. doi:10.1038/s41467-024-50146-z; Daly, R.T. et al. (2023). Successful "
         "kinetic impact into an asteroid for planetary defence. Nature 616, 443-447. DSK "
         "g_01165mm_spc_obj_didy_0000n00000_v003 (Hera SPICE, ESA).",
         1_000_000, "DIDYMOS_FIXED",
         [f"{E}/HERA/kernels/fk/hera_v16.tf", f"{E}/HERA/kernels/pck/hera_didymos_v06.tpc"], "Hera frame and PCK",
         notes=["Only the hemisphere seen by DRACO in the last minutes before impact is resolved; the rest is "
                "constrained by limbs and earlier, coarser images."]),
    _dsk("dimorphos", "Dimorphos (65803 Didymos I)", None, None,
         f"{E}/HERA/kernels/dsk/g_00243mm_spc_obj_dimo_0000n00000_v004.bds",
         "Stereophotoclinometry (SPC) from DART DRACO images, 3.1 M plates (pre-impact shape)",
         "Daly, R.T. et al. (2023). Successful kinetic impact into an asteroid for planetary defence. Nature 616, "
         "443-447. doi:10.1038/s41586-023-05810-5. DSK g_00243mm_spc_obj_dimo_0000n00000_v004 (Hera SPICE, ESA).",
         1_000_000, "DIMORPHOS_FIXED", [], "DIMORPHOS_FIXED is a two-vector dynamic frame (+x towards Didymos)",
         id_override=120065803,
         notes=["Pre-impact shape (2022 September 26). DART's impact changed Dimorphos's shape and orbit; this is "
                "not its current figure.",
                "Only about half of the surface was seen; the unseen side is a smooth extrapolation."]),
    _dsk("donaldjohanson", "52246 Donaldjohanson", 20052246, "52246",
         f"{N}/LUCY/kernels/dsk/lcy_donj_k548_iso20m_v10.bds",
         "Stereophotogrammetry and contour fitting from Lucy L'LORRI images (DLR), 548 k plates",
         "Lucy mission DLR team (2025). Donaldjohanson shape model, DSK lcy_donj_k548_iso20m_v10 (NAIF LUCY "
         "archive; source DoJo.CA.2025_05_All.52f.iso20m40SMrmsh.obj).",
         1_000_000, "DONALDJOHANSON_FIXED",
         [f"{N}/LUCY/kernels/fk/lucy_v13.tf", f"{N}/LUCY/kernels/pck/donaldjohanson_v12.tpc"],
         "Lucy frame and PCK", notes=["One flyby (2025-04-20): the side away from the spacecraft is less "
                                     "constrained.",
                                     "Scale check: SBDB's 3.9 km diameter is NEOWISE's thermal-model value (Masiero "
                                     "et al. 2011); the model spans 8.8 × 4.4 × 3.1 km, consistent with the flyby "
                                     "images (~8 km × 3.5 km)."]),
]

SATURN_SMALL = [
    # (key, name, naif)
    ("atlas", "Atlas", 615), ("calypso", "Calypso", 614), ("daphnis", "Daphnis", 635),
    ("epimetheus", "Epimetheus", 611), ("helene", "Helene", 612), ("hyperion", "Hyperion", 607),
    ("janus", "Janus", 610), ("pan", "Pan", 618), ("pandora", "Pandora", 617), ("prometheus", "Prometheus", 616),
    ("telesto", "Telesto", 613),
]
SATURN_CITATION = ("Thomas, P.C. (2018). Saturn small satellite shape models, urn:nasa:pds:saturn_satellite_shape_"
                   "models (PDS SBN); Thomas, P.C. et al. (2013). The inner small satellites of Saturn: a variety of "
                   "worlds. Icarus 226, 999-1019. doi:10.1016/j.icarus.2013.07.022; Thomas, P.C. et al. (2007). "
                   "Hyperion's sponge-like appearance. Nature 448, 50-56.")

for key, name, naif in SATURN_SMALL:
    SPACECRAFT.append(ShapeSource(
        key, name, naif, None, "plate", f"{SBN}/cassini/saturn_satellite_shape_models_V1_0/data/{key}_30k_plt.tab",
        "spacecraft", "measured",
        "Limb, terminator and stereo control-point model from Cassini ISS images (Thomas), ~30 k plates", SATURN_CITATION,
        1_000_000, f"IAU_{name.upper()}",
        "body-fixed frame of the PDS model (its label names the orientation kernels used); "
        + ("Hyperion rotates chaotically and has no rotation model in pck00011." if key == "hyperion" else
           "Daphnis has no rotation model in pck00011." if key == "daphnis" else
           "compared with pck00011 only by the axes (long axis towards Saturn)."),
        notes=("Hyperion's rotation is chaotic: the renderer needs an epoch-specific attitude, which is not "
               "provided.",) if key == "hyperion" else ()))

SPACECRAFT += [
    ShapeSource("phoebe", "Phoebe", 609, None, "obj",
                f"{SBN}/cassini/satellite-phoebe.cassini.shape-models-maps_V1_0/data/phoebe_128_o.obj",
                "spacecraft", "measured",
                "Stereophotoclinometry (SPC) from Cassini ISS images, 1.2 km resolution (ICQ q = 128, 196 k plates)",
                "Gaskell, R. & Weirich, J.R. (2023). Phoebe shape models and maps, "
                "urn:nasa:pds:satellite-phoebe.cassini.shape-models-maps (PDS SBN), product phoebe_128_o.", 1_000_000, "IAU_PHOEBE", "body-fixed frame of the PDS model"),
    ShapeSource("ida", "243 Ida", 2431010, "243", "grid-latlon",
                f"{SBN}/non_mission/ast-sat.thomas.shape-models_V1_0/data/243ida.tab", "spacecraft", "measured",
                "Stereogrammetry and limb matching from Galileo SSI images (1993-08-28), 2° lat/lon radius grid",
                "Thomas, P.C., Belton, M.J.S., Carcich, B., Chapman, C.R., Davies, M.E., Sullivan, R. & Veverka, J. "
                "(1996). The shape of Ida. Icarus 120, 20-32. doi:10.1006/icar.1996.0033. Data: "
                "urn:nasa:pds:ast-sat.thomas.shape-models (PDS SBN, 2021).", 1_000_000, "IAU_IDA",
                "planetocentric, longitudes east (Ida rotates retrograde)",
                rotation={"poleRaDeg": 348.76, "poleDecDeg": 87.10, "w0Deg": 265.95, "wDotDegPerDay": -1864.6280070,
                          "source": "PDS label (Thomas 2021)", "note": "pole ± 7.5° / 0.4°; retrograde"},
                notes=("Scale check: pck00011's triaxial radii (26.8 × 12.0 × 7.6 km) give a smaller volume than this "
                       "shape (16,100 km³, Thomas et al. 1996); the 1.16 ratio is the ellipsoid's, not the shape's.",)),
    ShapeSource("gaspra", "951 Gaspra", 9511010, "951", "grid-latlon",
                f"{SBN}/non_mission/ast-sat.thomas.shape-models_V1_0/data/951gaspra.tab", "spacecraft", "measured",
                "Stereogrammetry and limb matching from Galileo SSI images (1991-10-29), 2° lat/lon radius grid",
                "Thomas, P.C., Veverka, J., Simonelli, D., Helfenstein, P., Carcich, B., Belton, M.J.S., Davies, M.E. "
                "& Chapman, C. (1994). The shape of Gaspra. Icarus 107, 25-36. doi:10.1006/icar.1994.1004. Data: "
                "urn:nasa:pds:ast-sat.thomas.shape-models (PDS SBN).", 1_000_000, "IAU_GASPRA",
                "planetocentric, longitudes west (prograde rotation)", lon_west=True),
    ShapeSource("mathilde", "253 Mathilde", None, "253", "grid-latlon",
                f"{SBN}/non_mission/ast-sat.thomas.shape-models_V1_0/data/253mathilde.tab", "spacecraft", "measured",
                "Limb and stereo model from NEAR MSI images (1997-06-27; about 60 % of the surface seen), 2° grid",
                "Thomas, P.C. et al. (1999). Mathilde: size, shape and geology. Icarus 140, 17-27. "
                "doi:10.1006/icar.1999.6121. Data: urn:nasa:pds:ast-sat.thomas.shape-models (PDS SBN).",
                1_000_000, "MATHILDE body-fixed", "planetocentric, longitudes west (prograde rotation)",
                lon_west=True, notes=("Mathilde rotates slowly (17.4 d); its pole is poorly known.",)),
]

STOOKE = [
    ("amalthea", "Amalthea", 505, "j5amalthea", "Voyager 1 and 2", "Stooke, P.J. (1994). The geology of Amalthea. "
     "Earth Moon Planets 64, 87-97. doi:10.1007/BF00604489 (model corrected since)"),
    ("thebe", "Thebe", 514, "j14thebe", "Galileo", "Stooke, P.J.: Thebe shape model (preliminary, low-resolution "
     "Galileo images; orientation by P. Thomas)"),
    ("proteus", "Proteus", 808, "n8proteus", "Voyager 2", "Stooke, P.J. (1994). The surfaces of Larissa and Proteus. "
     "Earth Moon Planets 65, 31-54. doi:10.1007/BF00572198"),
    ("larissa", "Larissa", 807, "n7larissa", "Voyager 2", "Stooke, P.J. (1994). The surfaces of Larissa and "
     "Proteus. Earth Moon Planets 65, 31-54. doi:10.1007/BF00572198 (fit to a single image)"),
]
for key, name, naif, stem, mission, cit in STOOKE:
    SPACECRAFT.append(ShapeSource(
        key, name, naif, None, "grid-lonlat", f"{SBN}/non_mission/small_bodies.stooke.shape-models/data/{stem}.tab",
        "spacecraft", "estimated",
        f"Hand-fitted limb model from a few low-resolution {mission} images (Stooke), 5° lon/lat radius grid",
        cit + ". Data: urn:nasa:pds:small_bodies.stooke.shape-models (PDS SBN, 2025).", 1_000_000,
        f"IAU_{name.upper()}", "planetocentric, longitudes west (planetary satellite)", lon_west=True,
        notes=("The author describes the model as preliminary / of limited accuracy: the global figure is only as "
               "good as the few limb views it was fitted to.",)))

JPL_RADAR = f"{SBN}/non_mission/gbo.ast.jpl.radar.shape_models_V1_0/data"
COMPIL = f"{SBN}/non_mission/compil.ast.radar.shape-models/data"
RADAR_CITATION_JPL = ("JPL radar shape models, urn:nasa:pds:gbo.ast.jpl.radar.shape_models (PDS SBN); per-object "
                      "papers in the bundle documentation.")
RADAR_CITATION_COMPIL = ("Neese, C. (ed.) Small Bodies Radar Shape Models V2.0, EAR-A-5-DDR-RADARSHAPE-MODELS-V2.0 "
                         "(migrated to PDS4 as urn:nasa:pds:compil.ast.radar.shape-models, 2020); models by S. Hudson "
                         "and colleagues (per-object references in the bundle).")


def _radar(key, name, sbdb, url, spin=None, cit=RADAR_CITATION_JPL, notes=(), id_override=None,
           fmt="obj") -> ShapeSource:
    return ShapeSource(key, name, None, sbdb, fmt, url, "radar", "measured",
                       "Delay-Doppler radar imaging (Arecibo/Goldstone) inverted to a polyhedral shape (Hudson "
                       "method); axes are principal axes, +z the spin axis unless noted", cit, 1_000_000,
                       "principal axes (radar model)", "origin at the centre of mass; +z = spin axis",
                       spin_url=spin, notes=tuple(notes), id_override=id_override)


RADAR = [
    _radar("rashalom", "2100 Ra-Shalom", "2100", f"{JPL_RADAR}/a2100rashalom.obj", f"{JPL_RADAR}/a2100_spin_state.csv"),
    _radar("mithra", "4486 Mithra", "4486", f"{JPL_RADAR}/a4486mithra.obj",
           f"{JPL_RADAR}/a4486_prograde_spin_state.csv",
           notes=["Prograde and retrograde spin states fit equally; the prograde one is given."]),
    _radar("nereus", "4660 Nereus", "4660", f"{JPL_RADAR}/a4660nereus.obj", f"{JPL_RADAR}/a4660_spin_state.csv"),
    _radar("1992sk", "10115 (1992 SK)", "10115", f"{JPL_RADAR}/a10115_1992sk.obj", f"{JPL_RADAR}/a10115_spin_state.csv"),
    _radar("1950da", "29075 (1950 DA)", "29075", f"{JPL_RADAR}/a29075_1950da_retrogrademodel.obj",
           f"{JPL_RADAR}/a29075_retrograde_spin_state.csv",
           notes=["Busch et al. (2007) give prograde and retrograde solutions; the retrograde one is used because "
                  "the measured Yarkovsky drift requires retrograde rotation (Farnocchia & Chesley 2014)."]),
    _radar("1998wt24", "33342 (1998 WT24)", "33342", f"{JPL_RADAR}/a33342_1998wt24.obj",
           f"{JPL_RADAR}/a33342_spin_state.csv"),
    _radar("yorp", "54509 YORP", "54509", f"{JPL_RADAR}/a54509_yorp.obj", f"{JPL_RADAR}/a54509_spin_state.csv"),
    _radar("moshup", "66391 Moshup (1999 KW4)", "66391", f"{JPL_RADAR}/a66391_1999kw4_primary.obj",
           f"{JPL_RADAR}/a66391_alpha_spin_state.csv"),
    _radar("squannit", "Squannit (66391 Moshup I)", None, f"{JPL_RADAR}/a66391_1999kw4_secondary.obj",
           f"{JPL_RADAR}/a66391_beta_spin_state.csv", id_override=120066391),
    _radar("1994cc", "136617 (1994 CC)", "136617", f"{JPL_RADAR}/a136617_1994cc_primary.obj",
           f"{JPL_RADAR}/a136617_spin_state.csv", notes=["Primary of a triple system; satellites not modelled."]),
    _radar("2002ce26", "276049 (2002 CE26)", "276049", f"{JPL_RADAR}/a276049_2002ce26_primary.obj",
           f"{JPL_RADAR}/a276049_spin_state.csv"),
    _radar("2008ev5", "341843 (2008 EV5)", "341843", f"{JPL_RADAR}/a341843_2008ev5.obj",
           f"{JPL_RADAR}/a341843_spin_state.csv"),
    _radar("apophis", "99942 Apophis", "99942",
           f"{SBN}/non_mission/gbo.ast-apophis.jpl.radar.shape_model_v1.0/data/apophis_v233s7.obj",
           f"{SBN}/non_mission/gbo.ast-apophis.jpl.radar.shape_model_v1.0/data/apophis_v233s7_spin_state.csv",
           cit="Brozović, M. et al. (2018). Goldstone and Arecibo radar observations of (99942) Apophis in "
               "2012-2013. Icarus 300, 115-128. doi:10.1016/j.icarus.2017.08.032. Data: "
               "urn:nasa:pds:gbo.ast-apophis.jpl.radar.shape_model (PDS SBN).",
           notes=["Apophis is in non-principal-axis (tumbling) rotation; the spin state file gives the full "
                  "Euler-angle model."]),
    _radar("kleopatra", "216 Kleopatra", "216", f"{COMPIL}/216kleopatra.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj", notes=["Ostro et al. (2000) radar model; later adaptive-optics work (Marchis et al. "
                                 "2021) revised the size upward by ~10 %."]),
    _radar("geographos", "1620 Geographos", "1620", f"{COMPIL}/1620geographos.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj"),
    _radar("1998ky26", "(1998 KY26)", "1998 KY26", f"{COMPIL}/1998ky26.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj", notes=["Scale disputed: the radar model (Ostro et al. 1999) is ~30 m across, while "
                                 "Santana-Ros et al. (2025, Nat. Commun. 16, 8275) find 11 m from new observations "
                                 "(SBDB now gives 11 m). The form is from radar; the size may be ~2.4× too large."]),
    _radar("bacchus", "2063 Bacchus", "2063", f"{COMPIL}/2063bacchus.tab", cit=RADAR_CITATION_COMPIL, fmt="tab-obj",
           notes=["Scale check: SBDB's 1.02 km is NEOWISE's thermal-model diameter (Nugent et al. 2016); the radar "
                  "model spans 1.11 × 0.53 × 0.51 km (Benner et al. 1999)."]),
    _radar("toutatis", "4179 Toutatis", "4179", f"{COMPIL}/4179toutatis2.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj", notes=["+z is the long axis (not the spin axis): Toutatis is a non-principal-axis "
                                 "rotator (Hudson & Ostro 1995).",
                                 "Scale check: SBDB's 5.4 km diameter comes from a 1994 compilation (Hazards due to "
                                 "Comets and Asteroids) that predates the radar model; the model spans 4.58 × 2.28 × "
                                 "1.91 km, as Hudson & Ostro (1995) give (4.60 × 2.29 × 1.92 km)."]),
    _radar("castalia", "4769 Castalia", "4769", f"{COMPIL}/4769castalia.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj", notes=["Scale check: SBDB's 1.4 km diameter comes from a 1994 compilation (Hazards due "
                                 "to Comets and Asteroids) that predates the radar model (Hudson & Ostro 1994), "
                                 "which spans 1.63 × 1.00 × 0.84 km."]),
    _radar("golevka", "6489 Golevka", "6489", f"{COMPIL}/6489golevka.tab", cit=RADAR_CITATION_COMPIL, fmt="tab-obj"),
    _radar("1998ml14", "52760 (1998 ML14)", "52760", f"{COMPIL}/52760.tab", cit=RADAR_CITATION_COMPIL,
           fmt="tab-obj"),
]

ALL = SPACECRAFT + RADAR
