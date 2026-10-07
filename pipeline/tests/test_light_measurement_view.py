"""Calibration geometry is derived from dated inputs, never guessed from a scene."""
from pipeline.stages.light import with_measurement_views
from pipeline.schema import sourced, unknown


def test_dated_giant_views_are_derived_outside_the_build_window():
    entries = {str(i): {"geometricAlbedoXYZS": sourced([1, 2, 3, 4], "derived", ["karkoschka-1998-pds"])}
               for i in (599, 699, 799, 899, 606)}
    result = with_measurement_views(entries)
    for key, entry in result.items():
        view = entry["albedoMeasurementView"]
        assert view["label"] == "derived"
        assert {"karkoschka-1998-pds", "naif-de442s", "naif-pck00011", "naif-lsk-naif0012"} <= set(view["sources"])
        assert view["value"]["epoch"] == "1995-07-06/1995-07-10"
        assert view["value"]["subSolarLatitudeDeg"] is not None
        assert 0 <= view["value"]["phaseAngleDeg"] < 10
        assert view["value"]["views"]
        assert "Earth centre" in view["method"]
    assert abs(result["799"]["albedoMeasurementView"]["value"]["latitudeDeg"]) > 30


def test_unknown_albedo_has_unknown_view():
    entry = with_measurement_views({"608": {"geometricAlbedoXYZS": unknown("no photometry")}})["608"]
    assert entry["albedoMeasurementView"]["value"] is None
    assert entry["albedoMeasurementView"]["label"] == "unknown"


def test_bound_below_formal_error_keeps_the_disk_scale_derived():
    entries = {str(i): {"geometricAlbedoXYZS": sourced([1,2,3,4],"derived",["filacchione-2022"])}
               for i in (601,604,605)}
    result = with_measurement_views(entries)
    for key in ("604","605"):
        spread=result[key]["albedoViewSpread"]["value"]
        assert spread["bareMaxRelative"] < spread["albedoSigmaRelative"]
        assert spread["scaleLabel"] == "derived"
        assert result[key]["geometricAlbedoXYZS"]["label"] == "derived"
    spread=result["601"]["albedoViewSpread"]["value"]
    assert spread["bareMaxRelative"] > spread["albedoSigmaRelative"]
    assert spread["scaleLabel"] == "estimated"
    assert result["601"]["geometricAlbedoXYZS"]["label"] == "derived"
    assert "orientation envelope" in result["601"]["geometricAlbedoXYZS"]["uncertainty"]


def test_ahi_view_retains_the_actual_scan_geometry():
    entry = with_measurement_views({"399":{"geometricAlbedoXYZS":sourced([1,2,3,4],"estimated",["himawari9-ahi-l1b-fldk-20250320-0230"])}})["399"]
    view=entry["albedoMeasurementView"]
    assert view["label"] == "derived"
    assert view["value"]["latitudeDeg"] == 0
    assert "2025-03-20" in view["value"]["epoch"]
    assert abs(view["value"]["phaseAngleDeg"]-2.420352164420693) < 1e-6
