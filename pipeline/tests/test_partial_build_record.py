"""A filtered run cannot certify the code used for products it carries over."""

import json
import types

import pytest

from pipeline import build, config, output
from pipeline.schema import BuildContext


FILTERS = [
    ("surfaces", {"surfaces.bodies": [399]}),
    ("surfaces", {"surfaces.earthLayers": ["night"]}),
    ("shapes", {"shapes.only": ["eros"]}),
    ("shapes", {"shapes.reorient": True}),
]


@pytest.fixture
def runner(tmp_path, monkeypatch):
    for mod in (build, output):
        monkeypatch.setattr(mod, "OUT", tmp_path)
    monkeypatch.setattr(build, "PKG_ROOT", tmp_path)
    monkeypatch.setattr(config, "STAGES", ["surfaces", "shapes"])
    monkeypatch.setattr(config, "COSTS", {})
    source = tmp_path / "code.py"
    source.write_text("# version 1\n")
    monkeypatch.setattr(build, "code_closure", lambda name: ([source], False))

    def module(name):
        def run(ctx):
            old = build.read_manifest().get("products", {})
            if name == "surfaces":
                paths = ["surfaces/301/albedo.json", "surfaces/399/night.json"]
                selected = paths[1:] if (ctx.param("surfaces.bodies") or ctx.param("surfaces.earthLayers")) else paths
            else:
                paths = ["shapes/eros.bin", "shapes/bennu.bin"]
                selected = [] if ctx.param("shapes.reorient") else paths[:1] if ctx.param("shapes.only") else paths
            for path in paths:
                if path in selected:
                    output.write_bin(ctx, path, source.read_bytes(), name)
                elif path in old:
                    ctx.products[path] = old[path]
            output.write_json(ctx, f"{name}/index.json", {"code": source.read_text()}, name)
        return types.SimpleNamespace(DEPENDS=(), run=run)

    monkeypatch.setattr(build, "load_stage", module)

    outcomes = {}
    summary = build.print_summary

    def capture_summary(rows, *args):
        outcomes.clear()
        outcomes.update(rows)
        summary(rows, *args)

    monkeypatch.setattr(build, "print_summary", capture_summary)

    def invoke(stage, sets=None, dry_run=False, adopt=False):
        params = config.resolve("full", sets or {}, environ={})
        plan = build.Plan([stage], set(), {}, "full", False)
        ctx = BuildContext(0, 10, params=params, plan=(stage,))
        rc = build.adopt(ctx, plan) if adopt else build.run(ctx, plan, dry_run=dry_run)
        assert rc == (1 if adopt else 0)
        return build.read_manifest()

    return types.SimpleNamespace(invoke=invoke, source=source, out=tmp_path, outcomes=outcomes)


def changed_partial(runner, stage, filters):
    full = runner.invoke(stage)
    runner.source.write_text("# version 2\n")
    partial = runner.invoke(stage, filters)
    assert full["stages"][stage]["code"] != partial["stages"][stage]["code"]
    skipped = "surfaces/301/albedo.json" if stage == "surfaces" else "shapes/bennu.bin"
    assert partial["products"][skipped] == full["products"][skipped]
    assert (runner.out / skipped).read_text() == "# version 1\n"
    return partial


@pytest.mark.parametrize("stage,filters", FILTERS)
def test_partial_run_does_not_record_whole_stage_built(runner, stage, filters):
    record = changed_partial(runner, stage, filters)["stages"][stage]
    assert record["status"] == "partial"
    assert record["partialParams"] == filters


@pytest.mark.parametrize("stage,filters", FILTERS)
def test_full_build_after_changed_code_and_partial_run_is_stale(runner, stage, filters, capsys):
    changed_partial(runner, stage, filters)
    capsys.readouterr()
    runner.invoke(stage, dry_run=True)
    assert runner.outcomes[stage].status == "would run"


@pytest.mark.parametrize("stage,filters", FILTERS)
def test_filtered_run_never_resumes_carried_over_products(runner, stage, filters, capsys):
    partial = changed_partial(runner, stage, filters)
    # Records from before this fix also cannot certify the carried-over products.
    partial["stages"][stage]["status"] = "built"
    partial["stages"][stage].pop("partialParams", None)
    (runner.out / "manifest.json").write_text(json.dumps(partial))
    capsys.readouterr()
    runner.invoke(stage, filters, dry_run=True)
    assert runner.outcomes[stage].status == "would run"


@pytest.mark.parametrize("stage,filters", FILTERS)
def test_adopt_cannot_promote_a_partial_record(runner, stage, filters, capsys):
    changed_partial(runner, stage, filters)
    capsys.readouterr()
    runner.invoke(stage, filters, adopt=True)
    assert "NOT ADOPTABLE" in capsys.readouterr().out


@pytest.mark.parametrize("stage,sets", [
    ("surfaces", {"surfaces.maxLevel": 3}),
    ("shapes", {"shapes.damit": False}),
])
def test_complete_profile_output_resumes_and_full_output_is_stale(runner, stage, sets, capsys):
    record = runner.invoke(stage, sets)["stages"][stage]
    assert record["status"] == "built" and "partialParams" not in record
    capsys.readouterr()
    runner.invoke(stage, sets, dry_run=True)
    assert runner.outcomes[stage].status == "up to date"
    runner.invoke(stage, dry_run=True)
    assert runner.outcomes[stage].status == "would run"


def test_full_rebuild_replaces_partial_record_and_resumes(runner, capsys):
    changed_partial(runner, "surfaces", {"surfaces.bodies": [399]})
    record = runner.invoke("surfaces")["stages"]["surfaces"]
    assert record["status"] == "built" and "partialParams" not in record
    assert (runner.out / "surfaces/301/albedo.json").read_text() == "# version 2\n"
    capsys.readouterr()
    runner.invoke("surfaces", dry_run=True)
    assert runner.outcomes["surfaces"].status == "up to date"
