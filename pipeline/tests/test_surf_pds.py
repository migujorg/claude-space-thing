"""PDS3 label parsing and map-projection conventions used by the surface stage."""

import numpy as np
import pytest

from pipeline import surf_pds as pds

LROC_TILE = """PDS_VERSION_ID = PDS3
RECORD_BYTES  = 27360
^IMAGE        = 2
OBJECT = IMAGE_MAP_PROJECTION
    MAP_PROJECTION_TYPE          = EQUIRECTANGULAR
    A_AXIS_RADIUS                = 1737.4 <KM>
    POSITIVE_LONGITUDE_DIRECTION = EAST
    CENTER_LATITUDE              = 0 <DEG>
    CENTER_LONGITUDE             = 0 <DEG>
    MAP_RESOLUTION               = 76.000000000064 <PIX/DEG>
    MAXIMUM_LATITUDE             = 0.0 <DEG>
    MINIMUM_LATITUDE             = -70.0 <DEG>
    LINE_PROJECTION_OFFSET       = -0.5 <PIXEL>
    SAMPLE_PROJECTION_OFFSET     = -6840.5000000001 <PIXEL>
END_OBJECT = IMAGE_MAP_PROJECTION
OBJECT = IMAGE
    DESCRIPTION = "a multi-line
                   description"
    LINES = 5320
    LINE_SAMPLES = 6840
    SAMPLE_TYPE = PC_REAL
    SAMPLE_BITS = 32
    CORE_NULL = 16#FF7FFFFB#
END_OBJECT = IMAGE
END
"""

MDR_MIDLAT = """OBJECT = IMAGE
  LINES = 1360
  LINE_SAMPLES = 2080
  BANDS = 17
  BAND_NAME = ("WAC FILTER 6 430 BP 40",
               "WAC FILTER 3 480 BP 10")
  SAMPLE_TYPE = PC_REAL
  SAMPLE_BITS = 32
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
  MAP_PROJECTION_TYPE          = "EQUIRECTANGULAR"
  POSITIVE_LONGITUDE_DIRECTION = "EAST"
  CENTER_LATITUDE              = 43.75 <DEGREE>
  CENTER_LONGITUDE             = -22.50 <DEGREE>
  MAP_RESOLUTION               = 64 <PIXEL/DEGREE>
  LINE_PROJECTION_OFFSET       = 4159.477049 <PIXELS>
  SAMPLE_PROJECTION_OFFSET     = 1040.448317 <PIXELS>
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""

POLAR = """OBJECT = IMAGE_MAP_PROJECTION
  MAP_PROJECTION_TYPE = "POLAR STEREOGRAPHIC"
  A_AXIS_RADIUS = 1737.4 <KM>
  C_AXIS_RADIUS = 1737.4 <KM>
  CENTER_LATITUDE = -90.0 <DEG>
  CENTER_LONGITUDE = 0.0 <DEG>
  MAP_SCALE = 200.0 <METERS/PIXEL>
  LINE_PROJECTION_OFFSET = 4654.5
  SAMPLE_PROJECTION_OFFSET = 4654.5
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""


def test_lroc_tile_edges_fall_on_the_stated_bounds():
    lab = pds.parse_odl(LROC_TILE)
    g = pds.equirect_grid(lab)
    assert pds.image_offset(lab) == 27360
    assert lab["IMAGE"]["DESCRIPTION"] == "a multi-line description"
    assert lab["IMAGE"]["CORE_NULL"] == 0xFF7FFFFB
    e_lat, e_lon = g.lat_edges(), g.lon_edges()
    assert e_lat[0] == pytest.approx(0.0, abs=1e-9) and e_lat[-1] == pytest.approx(-70.0, abs=1e-9)
    assert e_lon[0] == pytest.approx(90.0, abs=1e-9) and e_lon[-1] == pytest.approx(180.0, abs=1e-9)
    assert pds.image_dtype(lab) == np.dtype("<f4")


def test_standard_parallel_equirectangular():
    lab = pds.parse_odl(MDR_MIDLAT)
    g = pds.equirect_grid(lab)
    # 45° of longitude in 2080 samples: spacing 1/(64 cos 43.75°); MDR offsets leave a ~1 px ambiguity
    assert g.lon_edges()[0] == pytest.approx(-45.0, abs=0.035)
    assert g.lon_edges()[-1] == pytest.approx(0.0, abs=0.035)
    assert g.lat_edges()[0] == pytest.approx(65.0, abs=0.02)
    assert pds.find(lab, "BAND_NAME")[1] == "WAC FILTER 3 480 BP 10"


def test_polar_stereographic_pole_and_orientation():
    lab = pds.parse_odl(POLAR)
    line, samp = pds.polar_stereo_pixel(lab, np.array([-90.0, -80.0, -80.0]), np.array([0.0, 0.0, 90.0]))
    assert (line[0], samp[0]) == pytest.approx((4654.5, 4654.5))
    # south polar: 0° longitude up (smaller line), 90°E to the right
    assert line[1] < 4654.5 and samp[1] == pytest.approx(4654.5)
    assert samp[2] > 4654.5 and line[2] == pytest.approx(4654.5)
    # 10° from the pole on the 1737.4 km sphere: 2R tan(5°) / 200 m
    assert 4654.5 - line[1] == pytest.approx(2 * 1737400 * np.tan(np.radians(5)) / 200)
