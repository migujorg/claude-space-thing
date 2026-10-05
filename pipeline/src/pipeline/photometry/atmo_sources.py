"""Downloads cited by atmospheres.json other than Earth's (atmo_earth.py), and the NSSDCA fact-sheet reader."""

from __future__ import annotations

import html
import re
from functools import lru_cache

from .common import Download

_ARXIV = "arXiv e-print (text source for the transcription; the journal version is cited)."

# ------------------------------------------------------------------------------------------------ NSSDCA
_NSSDC_CITE = ("Williams, D. R. NASA Space Science Data Coordinated Archive (NSSDCA) Planetary Fact Sheets, NASA "
               "Goddard Space Flight Center, https://nssdc.gsfc.nasa.gov/planetary/factsheet/.")
NSSDC_SHEETS = {
    "venus": "venusfact", "earth": "earthfact", "mars": "marsfact", "jupiter": "jupiterfact",
    "saturn": "saturnfact", "uranus": "uranusfact", "neptune": "neptunefact", "pluto": "plutofact",
}


def nssdc(body: str) -> Download:
    page = NSSDC_SHEETS[body]
    return Download(
        id=f"nssdca-{page}", url=f"https://nssdc.gsfc.nasa.gov/planetary/factsheet/{page}.html",
        subdir="atmospheres/nssdca", name=f"{page}.html",
        title=f"NSSDCA {body.capitalize()} Fact Sheet (bulk parameters and atmosphere)",
        citation=_NSSDC_CITE, license="U.S. Government work",
        notes="Values are the fact sheet's compiled 'best' values (its own references not itemized per number).")


@lru_cache(maxsize=None)
def nssdc_text(body: str) -> str:
    """The fact sheet as plain text (tags removed, entities decoded, whitespace collapsed per line)."""
    raw = nssdc(body).fetch().read_text(errors="replace", encoding="utf-8")
    raw = re.sub(r"<sup>(.*?)</sup>", r"\1", raw)
    t = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return "\n".join(" ".join(line.split()) for line in t.splitlines() if line.strip())


def nssdc_table_value(body: str, label: str) -> float:
    """First numeric cell of the bulk-parameter table row whose header starts with `label`."""
    raw = nssdc(body).fetch().read_text(errors="replace", encoding="utf-8")
    m = re.search(r"<th[^>]*>\s*" + re.escape(label) + r".*?</th>\s*<td[^>]*>\s*([-0-9.]+)", raw, re.S)
    if not m:
        raise KeyError(f"{body}: row {label!r} not found")
    return float(m.group(1))


def nssdc_atmo(body: str, key: str) -> str:
    """The text after `key:` in the 'Atmosphere' section (e.g. 'Scale height', 'Surface pressure')."""
    for line in nssdc_text(body).splitlines():
        head, sep, rest = line.partition(":")
        if sep and head.strip().lower() == key.lower():
            return rest.strip()
    raise KeyError(f"{body}: '{key}' not in the fact sheet")


def first_number(s: str) -> float:
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s.replace(",", ""))
    if not m:
        raise ValueError(s)
    return float(m.group(0))


# ------------------------------------------------------------------------------------------------ Mars
MCD_DUST_CLIM = Download(
    id="mcd-dust-clim",
    url="https://web.lmd.jussieu.fr/~lmdz/planets/mars/datadir/dust_clim.nc",
    subdir="atmospheres/mars", name="dust_clim.nc",
    title="Mars Climate Database 'climatology' dust scenario: daily kriged maps of 9.3 um absorption column dust "
          "optical depth at 610 Pa (Mars PCM input file dust_clim.nc, 2022-01-19)",
    citation="Montabone, L., Forget, F., Millour, E., et al. (2015). Eight-year climatology of dust optical depth on "
             "Mars. Icarus 251, 65-95. DOI:10.1016/j.icarus.2014.12.034; Montabone, L., et al. (2020), JGR Planets "
             "125, e2019JE006111, DOI:10.1029/2019JE006111. File distributed with the LMD Mars Planetary Climate "
             "Model / Mars Climate Database (MCD v6), https://web.lmd.jussieu.fr/~lmdz/planets/mars/datadir/.",
    notes="Variable cdod(Time=669 sols, latitude=60, longitude=120): 'IR column dust optical depth (absorption) "
          "normalized at reference pressure of 610 Pa'. MCD v6.1 User Manual §1.2: the Climatology scenario is "
          "forced by 'a dust distribution reconstructed from observations over Mars Years 24 to 35, and thus "
          "representative of a standard (i.e.: devoided of a planet-encircling global dust storm) Martian year'.",
)
LMD_DUST_OPTPROP = Download(
    id="lmd-mars-dust-optprop-tm",
    url="https://web.lmd.jussieu.fr/~lmdz/planets/mars/datadir/optprop_dustvis_TM.dat",
    subdir="atmospheres/mars", name="optprop_dustvis_TM.dat",
    title="Martian dust extinction efficiency, single-scattering albedo and asymmetry factor, 0.263-5 um, effective "
          "radius 1.5 um (LMD Mars PCM input file optprop_dustvis_TM.dat, 2011-07-13)",
    citation="LMD Mars Planetary Climate Model data file optprop_dustvis_TM.dat "
             "(https://web.lmd.jussieu.fr/~lmdz/planets/mars/datadir/). Dust radiative properties of the MCD's "
             "nominal scenarios, 'the more recently derived Wolff et al. ones' (MCD v6.1 User Manual §1.2), i.e. "
             "Wolff, M. J., et al. (2009), Wavelength dependence of dust aerosol single scattering albedo as "
             "observed by the Compact Reconnaissance Imaging Spectrometer, J. Geophys. Res. 114, E00D04, "
             "DOI:10.1029/2009JE003350; T-matrix ('TM') properties as used by Madeleine, J.-B., et al. (2011), "
             "J. Geophys. Res. 116, E11010, DOI:10.1029/2011JE003855.",
    notes="The file has no header beyond its axes (52 wavelengths, 1 radius 1.5e-6 m). The Wolff et al. (2009) "
          "attribution is by the MCD manual's statement and the file name (the Ockert-Bell properties are the "
          "separate *_ockert* files).",
)
MCD_MANUAL = Download(
    id="mcd-6.1-user-manual",
    url="https://www-mars.lmd.jussieu.fr/mars/info_web/user_manual_6.1.pdf",
    subdir="atmospheres/mars", name="MCD_user_manual_6.1.pdf",
    title="Mars Climate Database v6.1 User Manual",
    citation="Millour, E., Forget, F., et al. Mars Climate Database v6.1 User Manual (ESTEC Contract No. "
             "4000128572/19/NL/AS). Laboratoire de Meteorologie Dynamique, Paris.",
)
LMD_DUST_PAGE = Download(
    id="lmd-dust-climatology-page",
    url="http://www-mars.lmd.jussieu.fr/mars/dust_climatology/index.html",
    subdir="atmospheres/mars", name="lmd_dust_climatology_index.html",
    title="Climatologies of the Martian Atmospheric Dust Optical Depth (data-set page; 'Important notes')",
    citation="Montabone, L., et al. LMD web page 'Climatologies of the Martian Atmospheric Dust Optical Depth', "
             "http://www-mars.lmd.jussieu.fr/mars/dust_climatology/index.html, documenting Montabone et al. (2015), "
             "Icarus 251, 65-95, DOI:10.1016/j.icarus.2014.12.034, section 2.3.4.",
)
MONTABONE_2020 = Download(
    id="montabone-2020", url="https://arxiv.org/pdf/1907.08187v1", subdir="papers", name="arXiv-1907.08187v1.pdf",
    title="Martian Year 34 column dust climatology from Mars Climate Sounder observations",
    citation="Montabone, L., Spiga, A., Kass, D. M., Kleinboehl, A., Forget, F. & Millour, E. (2020). Martian Year 34 "
             "column dust climatology from Mars Climate Sounder observations: reconstructed maps and model "
             "simulations. J. Geophys. Res. Planets 125, e2019JE006111. DOI:10.1029/2019JE006111.",
    notes=_ARXIV)
CHEN_CHEN_2019 = Download(
    id="chen-chen-2019b", url="https://arxiv.org/pdf/1905.01074v1", subdir="papers", name="arXiv-1905.01074v1.pdf",
    title="Martian dust aerosol phase function from MSL Navcam/Hazcam sky radiance",
    citation="Chen-Chen, H., Perez-Hoyos, S. & Sanchez-Lavega, A. (2019). Characterisation of Martian dust aerosol "
             "phase function from sky radiance measurements by MSL engineering cameras. Icarus 330, 16-29. "
             "DOI:10.1016/j.icarus.2019.04.004.",
    notes=_ARXIV)
VINCENDON_2010 = Download(
    id="vincendon-langevin-2010", url="https://arxiv.org/pdf/1103.3215v1", subdir="papers",
    name="arXiv-1103.3215v1.pdf",
    title="A spherical Monte-Carlo model of aerosols: validation and first applications to Mars and Titan",
    citation="Vincendon, M. & Langevin, Y. (2010). A spherical Monte-Carlo model of aerosols: Validation and first "
             "applications to Mars and Titan. Icarus 207, 923-931. DOI:10.1016/j.icarus.2009.12.018.",
    notes=_ARXIV)

# ------------------------------------------------------------------------------------------------ Titan
HASI_DESCENT = Download(
    id="hasi-l4-descent", url="https://archives.esac.esa.int/psa/ftp/CASSINI-HUYGENS/HASI/"
        "HP-SSA-HASI-2-3-4-MISSION-V1.0/DATA/PROFILES/HASI_L4_ATMO_PROFILE_DESCEN.TAB",
    subdir="atmospheres/titan", name="HASI_L4_ATMO_PROFILE_DESCEN.TAB",
    title="Huygens HASI level-4 atmospheric profile, descent (time, altitude m, pressure Pa, temperature K, density)",
    citation="Fulchignoni, M., et al. (2005). In situ measurements of the physical characteristics of Titan's "
             "environment. Nature 438, 785-791. DOI:10.1038/nature04314. Data: Huygens HASI Mission Raw and "
             "Calibrated Data V1.1, HP-SSA-HASI-2-3-4-MISSION-V1.1, NASA PDS Atmospheres Node (hphasi_0001), "
             "product HASI_L4_ATMO_PROFILE_DESCEN (A. Aboudan, CISAS-UPD).",
    license="NASA PDS",
    notes="Retrieved from ESA's official PSA archive. Despite the directory name V1.0, the accompanying PDS "
          "label explicitly identifies DATA_SET_ID HP-SSA-HASI-2-3-4-MISSION-V1.1, the required product version. "
          "Original NMSU URL: https://atmos.nmsu.edu/PDS/data/hphasi_0001/DATA/PROFILES/HASI_L4_ATMO_PROFILE_DESCEN.TAB.")
HASI_ENTRY = Download(
    id="hasi-l4-entry", url="https://archives.esac.esa.int/psa/ftp/CASSINI-HUYGENS/HASI/"
        "HP-SSA-HASI-2-3-4-MISSION-V1.0/DATA/PROFILES/HASI_L4_ATMO_PROFILE_ENTRY.TAB",
    subdir="atmospheres/titan", name="HASI_L4_ATMO_PROFILE_ENTRY.TAB",
    title="Huygens HASI level-4 atmospheric profile, entry (time, altitude m, pressure Pa, temperature K)",
    citation="Fulchignoni, M., et al. (2005). Nature 438, 785-791. DOI:10.1038/nature04314. Data: NASA PDS "
             "Atmospheres Node hphasi_0001, product HASI_L4_ATMO_PROFILE_ENTRY.",
    license="NASA PDS",
    notes="Retrieved from ESA's official PSA archive. The accompanying PDS label identifies the V1.1 dataset. "
          "Original NMSU URL: https://atmos.nmsu.edu/PDS/data/hphasi_0001/DATA/PROFILES/HASI_L4_ATMO_PROFILE_ENTRY.TAB.")
PECK_KHANNA_N2 = Download(
    id="peck-khanna-1966-n2",
    url="https://raw.githubusercontent.com/polyanskiy/refractiveindex.info-database/master/database/data/main/N2/nk/"
        "Peck-0C.yml",
    subdir="atmospheres", name="refractiveindex_N2_Peck-0C.yml",
    title="Dispersion of nitrogen, 0.4679-2.0587 um, 0 C, 101.325 kPa (formula as given by the refractiveindex.info "
          "database)",
    citation="Peck, E. R. & Khanna, B. N. (1966). Dispersion of nitrogen. J. Opt. Soc. Am. 56, 1059-1063. "
             "DOI:10.1364/JOSA.56.001059. Formula via Polyanskiy, M. N., refractiveindex.info database (CC0), "
             "file database/data/main/N2/nk/Peck-0C.yml.",
    license="CC0 1.0 (database)",
    notes="Secondary transcription of the primary formula (the JOSA paper is not open access).")
BIDEAU_MEHU_CO2 = Download(
    id="bideau-mehu-1973-co2",
    url="https://raw.githubusercontent.com/polyanskiy/refractiveindex.info-database/master/database/data/main/CO2/nk/"
        "Bideau-Mehu.yml",
    subdir="atmospheres", name="refractiveindex_CO2_Bideau-Mehu.yml",
    title="Refractive index of CO2, 0.1807-1.6945 um, 0 C, 101.325 kPa (formula as given by refractiveindex.info)",
    citation="Bideau-Mehu, A., Guern, Y., Abjean, R. & Johannin-Gilles, A. (1973). Interferometric determination of "
             "the refractive index of carbon dioxide in the ultraviolet region. Optics Communications 9, 432-434. "
             "DOI:10.1016/0030-4018(73)90289-7. Formula via the refractiveindex.info database (CC0), "
             "database/data/main/CO2/nk/Bideau-Mehu.yml.",
    license="CC0 1.0 (database)",
    notes="Used only as an independent check of the Owens (1967) CO2 refractivity (Bodhaine Eq. 27).")
BAZZON_2014 = Download(
    id="bazzon-2014", url="https://arxiv.org/pdf/1409.3421v1", subdir="papers", name="arXiv-1409.3421v1.pdf",
    title="HST observations of the limb polarization of Titan (Appendix A.4: the DISR haze optical depth model)",
    citation="Bazzon, A., Schmid, H. M. & Buenzli, E. (2014). HST observations of the limb polarization of Titan. "
             "Astronomy & Astrophysics 572, A6. DOI:10.1051/0004-6361/201323139.",
    notes=_ARXIV + " Transcribes Tomasko, M. G., et al. (2008), Planet. Space Sci. 56, 669-707, "
                   "DOI:10.1016/j.pss.2007.11.019, Fig. 47 (not accessible to this pipeline).")
_TOMASKO_2008 = ("Tomasko, M. G., Doose, L., Engel, S., Dafoe, L. E., West, R., Lemmon, M., Karkoschka, E. & See, C. "
                 "(2008). A model of Titan's aerosols based on measurements made inside the atmosphere. Planetary and "
                 "Space Science 56, 669-707. DOI:10.1016/j.pss.2007.11.019")
_ADAMKOVICS = ("Adamkovics, M., Mitchell, J. L., Hayes, A. G., Rojo, P. M., Corlies, P., Barnes, J. W., Ivanov, V. D., "
               "Brown, R. H., Baines, K. H., Buratti, B. J., Clark, R. N., Nicholson, P. D. & Sotin, C. (2016). "
               "Meridional variation in tropospheric methane on Titan observed with AO spectroscopy at Keck and VLT. "
               "Icarus 270, 376-388. DOI:10.1016/j.icarus.2015.05.023 (arXiv:1509.08835, Section 3.2: 'We fit 32nd "
               "order Legendre polynomials to the phase functions tabulated at ...'; reference data of the authors' "
               "open radiative-transfer package https://github.com/adamkovics/atmosphere, atmosphere/refdata.py)")


def _tomasko_phase(region: str, alt: str) -> Download:
    return Download(
        id=f"tomasko-2008-phase-{region}",
        url=f"https://w.astro.berkeley.edu/~madamkov/refdata/aerosol/titan/Tomasko2007_phase_{alt}km.TAB",
        subdir="atmospheres/titan", name=f"Tomasko2007_phase_{alt}km.TAB",
        title=f"Huygens DISR aerosol scattering phase functions, {alt} km, 355-5166 nm (Tomasko et al. "
              "2008 Table 1, as tabulated in the reference data of Adamkovics et al. 2016)",
        citation=f"{_TOMASKO_2008} (Table 1: phase functions of the fractal-aggregate model fitted to the DISR "
                 f"measurements, above and below 80 km). Machine-readable copy: {_ADAMKOVICS}.",
        notes="Secondary transcription: Tomasko et al. (2008) is paywalled. Columns are wavelengths in Angstrom "
              "(3550 ... 51660), rows scattering angles 0-180 deg; normalized to a mean of 1 over the sphere (checked: "
              "1.001-1.011). Below 600 nm the two altitude regions are identical in the table; from 713 nm the "
              "below-80-km functions have the stronger backscatter lobe.")


TOMASKO_PHASE_LOW = _tomasko_phase("below-80km", "0-80")
TOMASKO_PHASE_HIGH = _tomasko_phase("above-80km", "80-200")
BARNES_2018 = Download(
    id="barnes-2018-titan-twilight", url="http://stacks.iop.org/1538-3881/156/i=5/a=247/pdf", subdir="papers",
    name="Barnes2018_AJ156_247.pdf",
    title="Titan's twilight and sunset solar illumination (Fig. 4: the Doose et al. 2016 haze single-scattering "
          "albedos above 200 km and below 80 km)",
    citation="Barnes, J. W., MacKenzie, S. M., Lorenz, R. D. & Turtle, E. P. (2018). Titan's twilight and sunset "
             "solar illumination. Astronomical Journal 156, 247. DOI:10.3847/1538-3881/aae519. Plots the single-"
             "scattering albedos of Doose, L. R., Karkoschka, E., Tomasko, M. G. & Anderson, C. M. (2016), Vertical "
             "structure and optical properties of Titan's aerosols from radiance measurements made inside and outside "
             "the atmosphere, Icarus 270, 355-375, DOI:10.1016/j.icarus.2015.09.039 (paywalled, not accessible to "
             "this pipeline).",
    license="Free to read (AAS)", browser_agent=True,
    sha256="edd61cbefecaf8d32fc1427aa121512368ecb19a8324ea5a1b9a791b1b7147ec", retrieved="2026-10-01",
    notes="Fig. 4 is vector graphics: the two blue curves are read from the page's drawing paths (Bezier "
          "segments, axes calibrated on the tick marks) into photometry/tables/titan_doose_2016_ssa.csv "
          "(docs/sources/titan-haze.md).")
ES_SAYEH_2023 = Download(
    id="es-sayeh-2023", url="https://insu.hal.science/insu-04036493v1/file/Es-sayeh_2023_Planet._Sci._J._4_44.pdf",
    subdir="papers", name="Es-sayeh_2023_PSJ4_44.pdf",
    title="Updated radiative transfer model for Titan in the near-infrared (Section 2.2: Doose et al.'s altitude rule "
          "for the haze single-scattering albedo; the DISR aggregate parameters)",
    citation="Es-sayeh, M., Rodriguez, S., Coutelier, M., Rannou, P., Bezard, B., Maltagliati, L., Cornet, T., "
             "Grieger, B., Karkoschka, E., Le Mouelic, S., Le Gall, A., Neish, C., MacKenzie, S., Solomonidou, A., "
             "Sotin, C. & Coustenis, A. (2023). Updated radiative "
             "transfer model for Titan in the near-infrared wavelength range: validation against Huygens atmospheric "
             "and surface measurements and application to the Cassini/VIMS observations of the Dragonfly landing "
             "area. Planetary Science Journal 4, 44. DOI:10.3847/PSJ/acbd37.",
    license="CC BY 4.0", notes="HAL open archive copy insu-04036493v1.")
HUYGENS_GCMS_CH4 = Download(
    id="huygens-gcms-ch4", url="https://archives.esac.esa.int/psa/ftp/CASSINI-HUYGENS/GCMS/"
                               "HP-SSA-GCMS-3-FCO-DESCENT-V1.0/DATA/DTWG_MOLE_FRACTION/GCMS_MOLE_FRACTION_STG2.TAB",
    subdir="atmospheres/titan", name="GCMS_MOLE_FRACTION_STG2.TAB",
    title="Huygens GCMS methane (and argon) mole fraction during the descent, by UTC (DTWG submission)",
    citation="Niemann, H. B., Atreya, S. K., Demick, J. E., Gautier, D., Haberman, J. A., Harpold, D. N., Kasprzak, W. "
             "T., Lunine, J. I., Owen, T. C. & Raulin, F. (2010). Composition of Titan's lower atmosphere and simple "
             "surface volatiles as measured by the Cassini-Huygens probe gas chromatograph mass spectrometer "
             "experiment. J. Geophys. Res. 115, E12006. DOI:10.1029/2010JE003659. Data: Huygens GCMS, NASA PDS "
             "Atmospheres Node hpgcms_0001, product DESCENT_GCMS_MOLE_FRACTION_STG2 (data set "
             "HP-SSA-GCMS-3-FCO/DESCENT-V1.0, NASA GSFC, 2006).",
    license="NASA PDS",
    notes="Retrieved from ESA's official PSA archive (the NMSU archive resets connections). The accompanying PDS "
          "label (GCMS_MOLE_FRACTION_STG2.LBL) identifies DATA_SET_ID HP-SSA-GCMS-3-FCO/DESCENT-V1.0, PRODUCT_ID "
          "DESCENT_GCMS_MOLE_FRACTION_STG2, 1303 records of 43 bytes (one header line). Original NMSU URL: "
          "https://atmos.nmsu.edu/PDS/data/hpgcms_0001/DATA/DTWG_MOLE_FRACTION/GCMS_MOLE_FRACTION_STG2.TAB.")
HUYGENS_DTWG_DESCENT = Download(
    id="huygens-dtwg-descent", url="https://archives.esac.esa.int/psa/ftp/CASSINI-HUYGENS/DTWG/"
                                   "HP-SSA-DTWG-6-TRAJECTORY-V1.0/DATA/HUY_DTWG_DESCENT_POS.TAB",
    subdir="atmospheres/titan", name="HUY_DTWG_DESCENT_POS.TAB",
    title="Huygens reconstructed descent trajectory: UTC, pressure, altitude above the 2575 km sphere",
    citation="Kazeminejad, B., Atkinson, D. H., Perez-Ayucar, M., Lebreton, J.-P. & Sollazzo, C. (2007). Huygens' "
             "entry and descent through Titan's atmosphere - Methodology and results of the trajectory reconstruction. "
             "Planet. Space Sci. 55, 1845-1876. DOI:10.1016/j.pss.2007.04.013. Data: Huygens Descent Trajectory "
             "Working Group, NASA PDS Atmospheres Node hpdtwg_0001, HUY_DTWG_DESCENT_POS (HP-SSA-DTWG-6-TRAJECTORY-"
             "V1.0).",
    license="NASA PDS",
    notes="Retrieved from ESA's official PSA archive (the NMSU archive resets connections). The accompanying PDS "
          "label (HUY_DTWG_DESCENT_POS.LBL) identifies DATA_SET_ID HP-SSA-DTWG-6-TRAJECTORY-V1.0, 10000 records of "
          "167 bytes, altitude above the 2575 km reference sphere. The PSA also holds a V2.0 data set (2011, "
          "producer ESA-ESTEC), which is not the one used here. Original NMSU URL: "
          "https://atmos.nmsu.edu/PDS/data/hpdtwg_0001/DATA/HUY_DTWG_DESCENT_POS.TAB.")

# ------------------------------------------------------------------------------------------------ Venus
HANSEN_HOVENIER = Download(
    id="hansen-hovenier-1974",
    url="https://journals.ametsoc.org/view/journals/atsc/31/4/1520-0469_1974_031_1137_iotpov_2_0_co_2.xml",
    subdir="atmospheres", name="HansenHovenier1974_JAS31_1137.html",
    title="Interpretation of the polarization of Venus (abstract: cloud-particle refractive index, size distribution, "
          "tau = 1 pressure)",
    citation="Hansen, J. E. & Hovenier, J. W. (1974). Interpretation of the polarization of Venus. Journal of the "
             "Atmospheric Sciences 31, 1137-1160. DOI:10.1175/1520-0469(1974)031<1137:IOTPOV>2.0.CO;2.",
    browser_agent=True,
    sha256="8d865b91081a7d757166a705a8020b517a6be1f1b67bae1b26e8d3d8d497e8d9", retrieved="2026-09-30")
LEE_2021 = Download(
    id="lee-2021-venus", url="https://arxiv.org/pdf/2103.09021v2", subdir="papers", name="arXiv-2103.09021v2.pdf",
    title="Investigation of UV absorbers on Venus using the 283 and 365 nm phase curves obtained from Akatsuki",
    citation="Lee, Y. J., Garcia Munoz, A., Yamazaki, A., Yamada, M., Watanabe, S. & Encrenaz, T. (2021). "
             "Investigation of UV absorbers on Venus using the 283 and 365 nm phase curves obtained from Akatsuki. "
             "Geophysical Research Letters 48, e2020GL090577. DOI:10.1029/2020GL090577.",
    notes=_ARXIV)
PERE_2016 = Download(
    id="pere-2016-venus", url="https://arxiv.org/pdf/1608.08544v1", subdir="papers", name="arXiv-1608.08544v1.pdf",
    title="Multilayer modeling of the aureole photometry during the Venus transit (upper-haze scale height)",
    citation="Pere, C., Tanga, P., Widemann, Th., Bendjoya, Ph., Mahieux, A., Wilquet, V. & Vandaele, A. C. (2016). "
             "Multilayer modeling of the aureole photometry during the Venus transit: comparison between SDO/HMI "
             "and VEx/SOIR data. Astronomy & Astrophysics 595, A115. DOI:10.1051/0004-6361/201628528.",
    notes=_ARXIV)

# ------------------------------------------------------------------------------------------------ Pluto
GLADSTONE_2016 = Download(
    id="gladstone-2016", url="https://arxiv.org/pdf/1604.05356v1", subdir="papers", name="arXiv-1604.05356v1.pdf",
    title="The atmosphere of Pluto as observed by New Horizons (hazes)",
    citation="Gladstone, G. R., Stern, S. A., Ennico, K., et al. (2016). The atmosphere of Pluto as observed by New "
             "Horizons. Science 351, aad8866. DOI:10.1126/science.aad8866.",
    notes=_ARXIV)
CHENG_2017 = Download(
    id="cheng-2017", url="https://arxiv.org/pdf/1702.07771v2", subdir="papers", name="arXiv-1702.07771v2.pdf",
    title="Haze in Pluto's atmosphere (Table 4: haze I/F versus phase angle)",
    citation="Cheng, A. F., Summers, M. E., Gladstone, G. R., et al. (2017). Haze in Pluto's atmosphere. Icarus 290, "
             "112-133. DOI:10.1016/j.icarus.2017.02.024.",
    notes=_ARXIV)
