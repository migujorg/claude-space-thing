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


def test_ahi_view_retains_the_actual_scan_geometry():
    entry = with_measurement_views({"399":{"geometricAlbedoXYZS":sourced([1,2,3,4],"estimated",["himawari9-ahi-l1b-fldk-20250320-0230"])}})["399"]
    view=entry["albedoMeasurementView"]
    assert view["label"] == "derived"
    assert view["value"]["latitudeDeg"] == 0
    assert "2025-03-20" in view["value"]["epoch"]
    assert abs(view["value"]["phaseAngleDeg"]-2.420352164420693) < 1e-6


def test_compiled_measurements_define_derived_orientation_means():
    cases = {199:'payne-2026-mercury',499:'mallama-2017',401:'fornasier-2024',402:'wargnier-2025',
             501:'mayorga-2020',502:'mayorga-2020',601:'filacchione-2022',602:'filacchione-2022',
             603:'filacchione-2022',604:'filacchione-2022',605:'filacchione-2022',609:'grav-2015',
             701:'decolibus-2026-data'}
    entries = {str(i): {'geometricAlbedoXYZS': sourced([1,2,3,4], 'derived', [source])}
               for i, source in cases.items()}
    for entry in with_measurement_views(entries).values():
        assert entry['albedoMeasurementView']['label'] == 'derived'
        assert 'Source description:' in entry['albedoMeasurementView']['method']
        assert 'scaleLabel' not in entry['albedoViewSpread']['value']
        assert entry['geometricAlbedoXYZS']['label'] == 'derived'


def test_unrecognized_single_observation_introduces_assumed_view():
    entry = with_measurement_views({'199': {'geometricAlbedoXYZS': sourced([1,2,3,4], 'measured', ['single-undated'])}})['199']
    assert entry['albedoMeasurementView']['label'] == 'estimated'
    assert 'Assumed' in entry['albedoMeasurementView']['method']
    assert entry['geometricAlbedoXYZS']['label'] == 'measured'
