"""Archive selection must preserve Gaia boolean semantics and participate in data provenance fingerprints."""
import numpy as np
import pytest
from astropy.table import Column

from pipeline import config, stars_gaia
from pipeline.stages.stars import _column


@pytest.mark.parametrize("name", ["has_xp_sampled", "duplicated_source"])
def test_archive_boolean_encodings_produce_boolean_masks(name):
    expected = np.array([True, False, True], dtype=bool)
    for values in (["true", "false", "true"], ["1", "0", "1"], [1, 0, 1]):
        result = _column(name, Column(values))
        assert result.dtype == np.dtype(bool)
        np.testing.assert_array_equal(result, expected)
        np.testing.assert_array_equal(np.array([11, 22, 33])[result], [11, 33])


def test_unknown_boolean_text_is_rejected():
    with pytest.raises(ValueError, match="invalid Gaia boolean"):
        _column("has_xp_sampled", Column(["true", "unexpected"]))
    with pytest.raises(ValueError, match="invalid Gaia boolean"):
        _column("has_xp_sampled", Column([1, 2]))


def test_source_ids_remain_integers():
    ids = np.array([139281533098990336, 140595724371656192], dtype=np.int64)
    np.testing.assert_array_equal(_column("source_id", Column(ids)), ids)


def test_tap_service_is_fingerprinted_for_affected_stages():
    params = config.resolve("full", {"gaia.tapService": "ari"})
    for stage in ("stars", "deepstars", "sky"):
        assert config.stage_params(params, stage)["gaia.tapService"] == "ari"
    assert "gaia.tapService" not in config.stage_params(params, "light")


def test_provider_selection_and_invalid_provider():
    original = stars_gaia.TAP_URL, stars_gaia.TAP_MAXREC
    try:
        stars_gaia.set_tap_service("ari")
        assert stars_gaia.TAP_URL == stars_gaia.ARI_TAP_URL
        assert stars_gaia.TAP_MAXREC == 10_000_000
        stars_gaia.set_tap_service("esa")
        assert stars_gaia.TAP_URL == "https://gea.esac.esa.int/tap-server/tap"
        assert stars_gaia.TAP_MAXREC == 3_000_000
        with pytest.raises(ValueError):
            stars_gaia.set_tap_service("unknown")
    finally:
        stars_gaia.TAP_URL, stars_gaia.TAP_MAXREC = original


def test_fits_queries_allow_tiles_larger_than_archive_default(monkeypatch, tmp_path):
    observed = {}
    def fetch(url, subdir, name, **kwargs):
        observed.update(kwargs["params"])
        return tmp_path / name
    monkeypatch.setattr(stars_gaia, "fetch", fetch)
    stars_gaia.tap_query_fits("source_id", "gaiadr3.gaia_source", "source_id < 1", "test", "tile")
    # Dense tiles may exceed the partner archive's 100,000-row default by more than an order of magnitude.
    assert observed["MAXREC"] >= 1_200_000


def test_parallel_catalogue_queries_preserve_order_and_final_magnitude_cut(monkeypatch):
    def query(select, table, where, subdir, base, expect):
        return base, where
    monkeypatch.setattr(stars_gaia, "tap_query", query)
    sequential = stars_gaia.fetch_gaia_sources(9.2, workers=1)
    parallel = stars_gaia.fetch_gaia_sources(9.2, workers=2)
    assert parallel == sequential
    assert len(parallel) == 3
    assert parallel[-1][1] == "phot_g_mean_mag >= 9.0 AND phot_g_mean_mag < 9.2"


def test_tycho_lookup_uses_exact_supplied_source_ids(monkeypatch):
    observed = {}
    def query(select, table, where, *args, **kwargs):
        observed.update(select=select, table=table, where=where)
        return "result"
    monkeypatch.setattr(stars_gaia, "tap_query", query)
    stars_gaia.fetch_tycho_pm_for_2p(10, np.array([33, 11, 33], dtype=np.int64))
    assert observed["where"] == "b.source_id IN (11,33)"
    assert ".gaia_source" not in observed["table"]
    assert observed["select"].startswith("b.source_id,")


def test_empty_tycho_source_set_does_not_query_every_star(monkeypatch):
    observed = {}
    def query(select, table, where, *args, **kwargs):
        observed["where"] = where
        return "result"
    monkeypatch.setattr(stars_gaia, "tap_query", query)
    stars_gaia.fetch_tycho_pm_for_2p(10, np.array([], dtype=np.int64))
    assert observed["where"] == "1 = 0"


def test_sums_format_parameter_validation_environment_and_fingerprint():
    default = config.resolve("full", environ={})
    assert default["gaia.sumsFormat"] == "csv"
    env = {"PIPELINE_GAIA_SUMS_FORMAT": "fits"}
    assert config.resolve("full", environ=env)["gaia.sumsFormat"] == "fits"
    explicit = config.resolve("full", config.parse_sets(["gaia.sumsFormat=csv"]), environ=env)
    assert explicit["gaia.sumsFormat"] == "csv"
    for stage in ("stars", "deepstars", "light"):
        assert "gaia.sumsFormat" not in config.stage_params(default, stage)
    assert config.stage_params(default, "sky")["gaia.sumsFormat"] == "csv"
    assert "gaia.sumsFormat" in config.describe()
    with pytest.raises(config.ConfigError, match="csv, fits"):
        config.parse_sets(["gaia.sumsFormat=votable"])
    from pipeline import build
    assert build.fingerprint("sky", (), default, (0, 1), {})["fingerprint"] != build.fingerprint(
        "sky", (), {**default, "gaia.sumsFormat": "fits"}, (0, 1), {})["fingerprint"]
