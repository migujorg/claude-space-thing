"""Documents that define the validation images' calibration and geometry (cited in case.json and docs/sources)."""

from __future__ import annotations

from ..photometry.common import Download

RMS = "https://opus.pds-rings.seti.org/holdings"
_RMS_CITE = ("Distributed by the PDS Ring-Moon Systems Node (SETI Institute), https://pds-rings.seti.org, "
             "through its OPUS holdings.")

CISSCAL_GUIDE = Download(
    id="cisscal-users-guide-2009", url=f"{RMS}/documents/COISS_0xxx/CISSCAL-Users-Guide.pdf",
    subdir="validation/docs", name="CISSCAL-Users-Guide.pdf",
    title="CISSCAL User Guide (Cassini ISS calibration software), 2009-03-20",
    citation="CISSCAL User Guide, 20 March 2009, Cassini Imaging Central Laboratory for Operations (CICLOPS), "
             "Space Science Institute; Cassini ISS archive documentation (COISS_0xxx/CISSCAL-Users-Guide.pdf). "
             + _RMS_CITE,
    notes="§5.10.1: the absolute correction factors from standard stars 'have errors on the order of 10-15%'; "
          "'the uncertainty of stellar fluxes is on the order of 10%, so this is the uncertainty we expect to "
          "achieve'. §5.9.1: I/F = intensity / (solar flux at the target's distance) convolved with the system "
          "response. §5.11: WAC pin-cushion distortion moves image points by 'only about a pixel at the image "
          "corners'.")

CASSINI_IK = Download(
    id="naif-cassini-iss-ik-v10", url="https://naif.jpl.nasa.gov/pub/naif/CASSINI/kernels/ik/cas_iss_v10.ti",
    subdir="validation/docs", name="cas_iss_v10.ti",
    title="Cassini ISS instrument kernel cas_iss_v10.ti (NAIF)",
    citation="Cassini ISS Instrument Kernel cas_iss_v10.ti, NAIF/JPL, Cassini mission SPICE kernels "
             "(https://naif.jpl.nasa.gov/pub/naif/CASSINI/kernels/ik/). Acton, C. H. (1996), PSS 44, 65-70.",
    notes="WAC focal length 200.77 ± 0.01 mm, 12 µm pixels, 1024 × 1024 (INS-82361_*): pixel pitch "
          "12e-3/200.77 = 59.77 µrad.")

VGISS_TUTORIAL = Download(
    id="vgiss-user-tutorial", url=f"{RMS}/documents/VGISS_5xxx/User-Tutorial.txt",
    subdir="validation/docs", name="VGISS-User-Tutorial.txt",
    title="Voyager ISS archive user tutorial (VGISS_5xxx-8xxx)",
    citation="PDS Ring-Moon Systems Node, Voyager Imaging Science Subsystem archive (data set "
             "VG1/VG2-S-ISS-2/3/4/6-PROCESSED-V1.1 and successors), User Tutorial (VGISS_5xxx/User-Tutorial.txt). "
             + _RMS_CITE,
    notes="§6.3: 'Absolute calibration is still probably no more accurate than 5-10%'; REFLECTANCE_SCALING_FACTOR "
          "converts CALIB/GEOMED pixel values to I/F 'accurate to the advertised 5-10% level'. §6.1: GEOMED "
          "geometry 'reliable at the level of ~1 pixel', pixel FOV keywords 'quite precise for the GEOMED images'.")

VGISS_PROCESSING = Download(
    id="vgiss-8xxx-processing", url=f"{RMS}/documents/VGISS_5xxx/VGISS_8xxx-Processing.txt",
    subdir="validation/docs", name="VGISS_8xxx-Processing.txt",
    title="Voyager 2 Neptune ISS archive (VGISS_8xxx) processing description",
    citation="Voyager ISS Neptune archive VGISS_8xxx, document PROCESSING.TXT (VGISS_5xxx/VGISS_8xxx-"
             "Processing.txt). " + _RMS_CITE,
    notes="FICOR77 converts to I/F with scale factors (VGRSCF.DAT) corrected for the Sun-Neptune distance "
          "((2.8607e9 km / 4.5291e9 km)² relative to Uranus); GEOMA resamples onto 1000 × 1000 pixels.")

NH_SOC_ICD = Download(
    id="nh-soc-inst-icd-2017", url=f"{RMS}/volumes/NHxxLO_xxxx/NHPELO_2001/document/soc_inst_icd.pdf",
    subdir="validation/docs", name="nh_soc_inst_icd.pdf",
    title="New Horizons SOC to Instrument Pipeline ICD (05310-SOCINST-01), September 2017",
    citation="Southwest Research Institute, New Horizons SOC to Instrument Pipeline ICD, Document No. "
             "05310-SOCINST-01, Rev 0 Chg 0, September 2017 (PDS data set NH-P-LORRI-3-PLUTO-V3.0, "
             "document/soc_inst_icd.pdf). " + _RMS_CITE,
    notes="§9.3.9 (LORRI): radiance at the pivot wavelength I = C/TEXP/RSOLAR for a solar-type spectrum "
          "[(DN/s/pixel)/(erg cm⁻² s⁻¹ sr⁻¹ Å⁻¹)]; I/F = π I r² / F_solar with F_solar = 176 erg cm⁻² s⁻¹ Å⁻¹ at "
          "1 AU at the pivot wavelength 6076.2 Å.")

WEAVER_2020 = Download(
    id="weaver-2020-lorri", url="https://arxiv.org/pdf/2001.03524v1", subdir="validation/docs",
    name="weaver2020_lorri.pdf",
    title="In-Flight Performance and Calibration of LORRI for the New Horizons Mission",
    citation="Weaver, H. A., Cheng, A. F., Morgan, F., et al. (2020). In-flight performance and calibration of the "
             "LOng Range Reconnaissance Imager (LORRI) for the New Horizons mission. Accepted for publication in "
             "the Publications of the Astronomical Society of the Pacific (January 2020); arXiv:2001.03524v1.",
    notes="Absolute calibration tied to the solar analog HD 37962: 'LORRI's absolute sensitivity is accurate to "
          "~2% (1σ) for targets with solar-type SEDs'; '≤10% (1σ) absolute for non-solar-type SEDs' unless "
          "synthetic photometry is used. Pixel scale 4.96 µrad (1×1).")

LORRI_EXPTIME = Download(
    id="spencer-weaver-2020-lorri-exposure", url=f"{RMS}/documents/NHxxLO_xxxx/LORRI-True-Exposure-Times.pdf",
    subdir="validation/docs", name="LORRI-True-Exposure-Times.pdf",
    title="Determination of the True Exposure Time of New Horizons LORRI Images (February 2020)",
    citation="Spencer, J. and Weaver, H. (2020). Determination of the True Exposure Time of New Horizons LORRI "
             "Images. New Horizons archive documentation, February 2020 (NHxxLO_xxxx/LORRI-True-Exposure-Times.pdf). "
             + _RMS_CITE,
    notes="True exposure = commanded + 0.6 ms; the pipeline added it to EXPTIME from 2020 on.")

EPOXI_CAL_SUMMARY = Download(
    id="epoxi-cal-pipeline-summary-2014",
    url="https://pdssbn.astro.umd.edu/holdings/di-c-hrii_hriv_mri_its-6-doc-set-v4.0/document/calibration/"
        "calibration_docs/epoxical_v5_10/epoxi_cal_pipeline_summ.pdf",
    subdir="validation/docs", name="epoxi_cal_pipeline_summ.pdf",
    title="EPOXI Calibration Pipeline Summary (last revised 2014-05-11)",
    citation="EPOXI Calibration Pipeline Summary, last revised May 11, 2014, in the Deep Impact and EPOXI "
             "documentation data set DI-C-HRII/HRIV/MRI/ITS-6-DOC-SET-V4.0, NASA PDS Small Bodies Node "
             "(document/calibration/calibration_docs/epoxical_v5_10/).",
    notes="'The uncertainty in conversion to absolute radiometric units is estimated to be 5% for HRI-VIS except "
          "for the 950-nm filter, where the uncertainty is ~10%'; HRI-VIS out of focus with a PSF FWHM of ~9 pixels; "
          "red leaks in the 350, 550, 650 and 850-nm HRI-VIS filters.")

ALL = [EPOXI_CAL_SUMMARY, CISSCAL_GUIDE, CASSINI_IK, VGISS_TUTORIAL, VGISS_PROCESSING, NH_SOC_ICD, WEAVER_2020,
       LORRI_EXPTIME]
