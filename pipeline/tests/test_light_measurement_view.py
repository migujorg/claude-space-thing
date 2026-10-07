"""The light product distinguishes known calibration views from explicit assumptions."""
from pipeline.stages.light import with_measurement_views
from pipeline.schema import sourced, unknown


def test_measurement_view_provenance_and_no_guessed_latitude():
    entries = {str(i): {"geometricAlbedoXYZS": sourced([1, 2, 3, 4], "derived", ["source"])}
               for i in (199, 399, 499, 599, 699, 799, 899, 401, 402, 501, 502, 601, 602, 603, 604, 605, 606)}
    entries["608"] = {"geometricAlbedoXYZS": unknown("no photometry")}
    result = with_measurement_views(entries)
    for key, entry in result.items():
        view = entry["albedoMeasurementView"]
        assert view["method"]
        if key in ("599", "699"):
            assert view["value"]["latitudeDeg"] == 0
            assert view["value"]["epoch"] == "1995-07-06/1995-07-10"
            assert view["label"] == ("estimated" if key == "599" else "measured")
            assert view["sources"] == (["karkoschka-1998-pds", "karkoschka-1994-text"]
                                       if key == "599" else ["karkoschka-1998-pds"])
        elif key == "608":
            assert view["value"] is None and view["label"] == "unknown"
        else:
            assert view["value"]["kind"] == "orientation-mean"
            assert "latitudeDeg" not in view["value"]
            assert view["label"] == "estimated" and view["sources"] == ["source"]
