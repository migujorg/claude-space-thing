# Mars Express HRSC global colour mosaic (`hrsc-global-colour-mosaic`)

**What:** five global mosaics (nadir/panchromatic 675 nm, red 750 nm, green 530 nm, blue 440 nm, infrared 970 nm), float32, equirectangular on a 3396 km sphere, 2 km/px (10669 × 5334), nodata −1e32. Built from ~90 high-altitude HRSC images (pixel scale > 200 m) selected for low dust, with clouds clipped; a global colour model derived only from colour relations *inside* each image is used to colour-reference the mosaic, which suppresses image-to-image changes in atmospheric scattering while keeping long-range colour variation. Small coverage gaps remain.

**Citation:** Michael, G. G., Tirsch, D., Matz, K.-D., Zuschneid, W., Hauber, E., Gwinner, K., Walter, S. H. G., Jaumann, R., Roatsch, T. & Postberg, F. (2025). A global colour mosaic of Mars from high altitude observations. *Icarus* 425, 116350. DOI [10.1016/j.icarus.2024.116350](https://doi.org/10.1016/j.icarus.2024.116350) (preprint arXiv:2307.14238). Data: Freie Universität Berlin Refubium, DOI [10.17169/refubium-40624](https://doi.org/10.17169/refubium-40624). **Licence CC BY 4.0** (DataCite `rightsList`), credit ESA/DLR/FU Berlin.

**Files:** `https://hrscteam.dlr.de/public/data/global_mosaic/extra/{03-bl,02-gr,00-nd,01-re}-eqc.tif` (228 MB each, HTTP Last-Modified 2023-08-07). Georeferencing from the GeoTIFF tags (pixel-is-area tie point at 180°W, 90°N). HRSC filter centres: Jaumann et al. (2007), *PSS* 55, 928, DOI 10.1016/j.pss.2006.12.003.

**Use (`surf_mars.py`):** level-4 box means; band ratios at 440/530/675/750 nm → XYZS with the Mars disk spectrum. Labels: brightness **measured** (with the stated caveat that the campaign-average dust haze is not removed), colour **estimated**.
