"""Build profiles, parameters and the resumable runner (pipeline/config.py, pipeline/build.py). Offline, no data.

The runner tests use fake stages that write small products into a temporary output directory: a stage that
finished is skipped on the next build, a failed stage is retried without redoing the others, and a stage reruns
when its parameters, its inputs (the products of the stages it depends on) or its products on disk change.
"""

from __future__ import annotations

import hashlib
import json
import types

import pytest

from pipeline import build, config, output
from pipeline.output import write_json
from pipeline.schema import BuildContext

# ------------------------------------------------------------------------------------------------ config


def test_profiles_are_consistent():
    for p in config.PROFILES.values():
        assert set(p.stages) <= set(config.STAGES)
        assert set(p.params) <= set(config.PARAMS), p.name
        # A profile never includes a stage without the stages it needs.
        for s in p.stages:
            for d in build.load_stage(s).DEPENDS:
                assert d in p.stages, f"profile {p.name}: {s} needs {d}"
    assert set(config.PROFILES["full"].stages) == set(config.STAGES) and not config.PROFILES["full"].params
    assert {"surfaces", "shapes", "smallbodies", "synthetic", "deepstars", "sky"}.isdisjoint(
        config.PROFILES["minimal"].stages)
    assert set(config.COSTS) == set(config.STAGES)


def test_parameter_resolution_order():
    env = {"SURFACES_BODIES": "301,599", "SHAPES_KEEP_RAW": "1"}
    p = config.resolve("standard", {}, environ={})
    assert p["surfaces.maxLevel"] == 3 and p["shapes.damit"] is False           # profile over default
    assert config.resolve(None, {}, environ={})["surfaces.maxLevel"] is None      # default
    p = config.resolve("standard", config.parse_sets(["surfaces.maxLevel=4"]), environ=env)
    assert p["surfaces.maxLevel"] == 4                                            # --set over profile
    assert p["surfaces.bodies"] == [301, 599] and p["shapes.keepRaw"] is True     # environment variables
    assert config.resolve("full", {"surfaces.bodies": [1]}, environ=env)["surfaces.bodies"] == [1]
    assert config.resolve(None, config.parse_sets(["surfaces.maxLevel=none"]), environ={})["surfaces.maxLevel"] is None
    # Profile builds leave tracked files alone; --only (development) builds refresh them.
    assert config.resolve("full", {}, environ={}, only=False)["build.writeRepoFiles"] is False
    assert config.resolve(None, {}, environ={}, only=True)["build.writeRepoFiles"] is True


def test_parse_sets_rejects_unknown_and_malformed():
    with pytest.raises(config.ConfigError, match="unknown parameter"):
        config.parse_sets(["surfaces.maxlevel=3"])
    with pytest.raises(config.ConfigError, match="key=value"):
        config.parse_sets(["surfaces.maxLevel"])
    with pytest.raises(config.ConfigError):
        config.parse_sets(["shapes.damit=maybe"])


def test_stage_params_and_env_export():
    p = config.resolve("standard", {"gaia.xpWorkers": 8}, environ={})
    assert config.stage_params(p, "surfaces")["surfaces.maxLevel"] == 3
    assert "surfaces.keepCache" not in config.stage_params(p, "surfaces")      # how, not what: no rebuild
    assert "gaia.xpWorkers" not in config.stage_params(p, "stars")
    assert config.stage_params(p, "sky") == {"gaia.release": "dr3", "gaia.tapService": "esa", "deepstars.xpSource": "inherit"}
    env: dict = {}
    config.export_env({**p, "surfaces.bodies": [301], "smallbodies.snapshot": "new"}, env)
    assert env == {"SURFACES_BODIES": "301", "SB_SNAPSHOT": "new"}


def test_context_param_falls_back_to_environment(monkeypatch):
    ctx = BuildContext(0.0, 1.0)
    assert ctx.param("surfaces.maxLevel") is None
    monkeypatch.setenv("SHAPES_ONLY", "eros, bennu")
    assert ctx.param("shapes.only") == ["eros", "bennu"]
    assert BuildContext(0.0, 1.0, params={"shapes.only": []}).param("shapes.only") == []
    with pytest.raises(KeyError):
        ctx.param("no.such")


def test_profile_costs_grow_with_the_profile():
    t = {n: config.profile_totals(n) for n in config.PROFILES}
    assert t["minimal"]["product_gb"] < t["standard"]["product_gb"] < t["full"]["product_gb"]
    assert t["minimal"]["disk_gb"] < t["standard"]["disk_gb"] <= t["full"]["disk_gb"]
    assert config.stage_cost("surfaces", {"surfaces.maxLevel": 3}).product_gb == config.SURFACES_GB_BY_CAP[3]
    assert "| standard |" in config.cost_table(markdown=True)


def test_make_plan():
    p = build.make_plan("minimal", [], ["stars"], force=False)
    assert p.stages == ["time", "ephemeris", "light", "bodies"] and not p.forced
    assert p.left_out["stars"] == "--skip" and p.left_out["sky"] == "not in profile minimal"
    p = build.make_plan(None, ["bodies", "time"], [], force=False)
    assert p.explicit and p.stages == ["time", "bodies"] and p.forced == {"time", "bodies"}
    assert build.make_plan("full", [], [], force=True).forced == set(config.STAGES)
    with pytest.raises(config.ConfigError):
        build.make_plan(None, ["nope"], [], force=False)


# ------------------------------------------------------------------------------------------------ code closure


def test_code_closure_follows_imports_and_window_use():
    files, window = build.code_closure("surfaces")
    names = {p.relative_to(build.PKG_ROOT).as_posix() for p in files}
    assert {"stages/surfaces.py", "surf_moon.py", "surf_tiles.py", "surf_layers.py", "output.py"} <= names
    # the build machinery, the downloader and path settings do not change what a stage writes
    assert not {"config.py", "build.py", "__main__.py", "download.py", "paths.py"} & names
    assert window is False                                             # surface maps do not depend on the window
    assert build.code_closure("ephemeris")[1] is True
    assert build.code_closure("time")[1] is False
    sky = {p.relative_to(build.PKG_ROOT).as_posix() for p in build.code_closure("sky")[0]}
    assert any(n.startswith("sky_tables/") for n in sky)               # transcribed tables count as code


def test_code_hash_ignores_line_endings(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "PKG_ROOT", tmp_path)
    a, b = tmp_path / "m.py", tmp_path / "n" / "m.py"
    b.parent.mkdir()
    a.write_bytes(b"x = 1\ny = 2\n")
    h1 = build.code_hash([a])
    a.write_bytes(b"x = 1\r\ny = 2\r\n")
    assert build.code_hash([a]) == h1
    a.write_bytes(b"x = 1\ny = 3\n")
    assert build.code_hash([a]) != h1


# ------------------------------------------------------------------------------------------------ runner


class Stages:
    """Fake stages A -> B (B depends on A), C independent, each writing one product; `fail` makes one raise."""

    def __init__(self):
        self.runs: list[str] = []
        self.fail: dict[str, BaseException] = {}
        self.content = {"a": 1, "b": 1, "c": 1}

    def module(self, name: str) -> types.ModuleType:
        m = types.ModuleType(f"fake.{name}")
        m.DEPENDS = ("a",) if name == "b" else ()

        def run(ctx: BuildContext) -> None:
            self.runs.append(name)
            write_json(ctx, f"{name}.json", {"v": self.content[name], "level": ctx.param("surfaces.maxLevel")}, name)
            if name in self.fail:
                raise self.fail[name]
        m.run = run
        return m


@pytest.fixture
def env(tmp_path, monkeypatch):
    out = tmp_path / "out"
    out.mkdir()
    for mod in (build, output):
        monkeypatch.setattr(mod, "OUT", out)
    st = Stages()
    monkeypatch.setattr(config, "STAGES", ["a", "b", "c"])
    monkeypatch.setattr(config, "PROFILES", {
        "all": config.Profile("all", ("a", "b", "c")), "ac": config.Profile("ac", ("a", "c"))})
    monkeypatch.setattr(config, "COSTS", {})
    monkeypatch.setattr(build, "load_stage", st.module)
    code = {"v": b"code v1"}
    src = tmp_path / "src.py"

    def closure(stage):
        src.write_bytes(code["v"])
        return [src], stage == "b"
    monkeypatch.setattr(build, "code_closure", closure)
    monkeypatch.setattr(build, "PKG_ROOT", tmp_path)
    return types.SimpleNamespace(out=out, stages=st, code=code)


def _build(profile="all", only=(), skip=(), force=False, sets=None, window=(0.0, 10.0)):
    plan = build.make_plan(profile if not only else None, list(only), list(skip), force)
    params = config.resolve(None if only else profile, sets or {}, environ={}, only=bool(only))
    ctx = BuildContext(*window, params=params, plan=tuple(plan.stages))
    return build.run(ctx, plan)


def _manifest(out):
    return json.loads((out / "manifest.json").read_text(encoding="utf-8"))


def test_resume_skips_finished_stages_and_retries_the_failed_one(env, capsys):
    env.stages.fail["a"] = RuntimeError("server said 503")
    assert _build() == 1
    m = _manifest(env.out)
    assert env.stages.runs == ["a", "c"]                 # b was blocked: it needs a
    assert m["stages"]["a"]["status"] == "failed" and "503" in m["stages"]["a"]["error"]
    assert "a.json" not in m["products"] and "c.json" in m["products"]   # a's partial output is not listed
    assert m["build"]["stages"]["b"] == {"status": "blocked", "reason": "needs a failed"}
    assert "BLOCKED" in capsys.readouterr().out

    env.stages.fail.clear()
    env.stages.runs.clear()
    assert _build() == 0
    assert env.stages.runs == ["a", "b"]                 # c is up to date
    env.stages.runs.clear()
    assert _build() == 0 and env.stages.runs == []       # everything up to date
    assert {s["status"] for s in _manifest(env.out)["stages"].values()} == {"built"}


def test_reruns_when_inputs_change(env):
    assert _build() == 0
    env.stages.runs.clear()
    # a stage's own parameters: only surfaces.* would matter for a stage named surfaces; here none apply
    assert _build(sets={"surfaces.maxLevel": 2}) == 0 and env.stages.runs == []
    # --only reruns a; its product changes, so b (which depends on it) reruns on the next profile build
    env.stages.content["a"] = 2
    assert _build(only=["a"]) == 0 and env.stages.runs == ["a"]
    env.stages.runs.clear()
    assert _build() == 0 and env.stages.runs == ["b"]
    # the code a stage imports changed
    env.stages.runs.clear()
    env.code["v"] = b"code v2"
    assert _build() == 0 and env.stages.runs == ["a", "b", "c"]
    # the window changed: only b's code reads it
    env.stages.runs.clear()
    assert _build(window=(0.0, 20.0)) == 0 and env.stages.runs == ["b"]
    # a product went missing on disk
    env.stages.runs.clear()
    (env.out / "c.json").unlink()
    assert _build(window=(0.0, 20.0)) == 0 and env.stages.runs == ["c"]
    # --force reruns everything in the profile
    env.stages.runs.clear()
    assert _build(force=True, window=(0.0, 20.0)) == 0 and env.stages.runs == ["a", "b", "c"]


def test_profile_leaves_stages_out_and_blocks_what_needs_them(env):
    assert _build(profile="ac") == 0
    m = _manifest(env.out)
    assert env.stages.runs == ["a", "c"] and "b" not in m["stages"]
    assert m["build"]["stages"]["b"] == {"status": "not built", "reason": "not in profile ac"}
    env.stages.runs.clear()
    assert _build(skip=["a"]) == 0 and env.stages.runs == ["b"]     # a's products exist from before: b can run


def test_blocked_when_a_dependency_was_never_built(env):
    assert _build(only=["b"]) == 1
    assert env.stages.runs == [] and _manifest(env.out)["build"]["stages"]["b"]["status"] == "blocked"


def test_interrupt_records_state_and_stops(env):
    env.stages.fail["a"] = KeyboardInterrupt()
    assert _build() == 130
    m = _manifest(env.out)
    assert env.stages.runs == ["a"]
    assert m["stages"]["a"]["status"] == "failed"
    assert m["build"]["stages"]["c"] == {"status": "not built", "reason": "build interrupted"}


def test_dry_run_writes_nothing(env):
    plan = build.make_plan("all", [], [], False)
    ctx = BuildContext(0.0, 10.0, params=config.resolve("all", {}, environ={}), plan=tuple(plan.stages))
    assert build.run(ctx, plan, dry_run=True) == 0
    assert env.stages.runs == [] and not (env.out / "manifest.json").exists()


def _unrecorded(out):
    """Drop the stage records: products from before resume records existed (or merged by hand)."""
    m = _manifest(out)
    m.pop("stages", None)
    m.pop("build", None)
    (out / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    return m


def _adopt(profile="all", window=(0.0, 10.0), sets=None):
    plan = build.make_plan(profile, [], [], False)
    ctx = BuildContext(*window, params=config.resolve(profile, sets or {}, environ={}), plan=tuple(plan.stages))
    return build.adopt(ctx, plan)


def test_adopt_records_existing_products_and_runs_nothing(env, capsys):
    assert _build() == 0
    _unrecorded(env.out)
    env.stages.runs.clear()
    assert _adopt() == 0 and env.stages.runs == []
    out = capsys.readouterr().out
    assert "a  adopted" in out.replace("  ", "  ") and "nothing is run or downloaded" in out
    assert {s["status"] for s in _manifest(env.out)["stages"].values()} == {"built"}
    assert _build() == 0 and env.stages.runs == []              # the next build finds everything up to date
    assert _adopt() == 0 and "already recorded" in capsys.readouterr().out


def test_adopt_never_runs_a_stage_it_cannot_adopt(env, capsys):
    assert _build() == 0
    _unrecorded(env.out)
    (env.out / "c.json").unlink()
    env.stages.runs.clear()
    assert _adopt() == 1
    out = capsys.readouterr().out
    assert env.stages.runs == []                                # the bug: this used to rebuild c
    assert "c.json missing" in out and "NOT ADOPTABLE" in out
    m = _manifest(env.out)
    assert set(m["stages"]) == {"a", "b"} and "c.json" in m["products"]   # c is left exactly as it was


def test_adopt_refreshes_a_stale_json_entry_but_not_a_changed_binary(env, capsys):
    assert _build() == 0
    m = _unrecorded(env.out)
    # a hand merge: the file on disk was rewritten later (still valid JSON), the manifest kept the old entry
    (env.out / "a.json").write_text(json.dumps({"v": 1, "level": None, "extra": "wind layer"}), encoding="utf-8")
    old_sha = m["products"]["a.json"]["sha256"]
    assert _adopt() == 0
    assert "refreshed a.json" in capsys.readouterr().out
    entry = _manifest(env.out)["products"]["a.json"]
    assert entry["sha256"] != old_sha and entry["bytes"] == (env.out / "a.json").stat().st_size
    env.stages.runs.clear()
    assert _build() == 0 and env.stages.runs == []

    # a non-JSON product that differs from its entry cannot be checked by content: not adoptable
    _unrecorded(env.out)
    p = env.out / "t.bin"
    p.write_bytes(b"\0" * 8)
    output._register(types.SimpleNamespace(products=(reg := {})), "t.bin", p, "c")
    m = _manifest(env.out)
    m["products"].update(reg)
    (env.out / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    p.write_bytes(b"\1" * 8)
    assert _adopt() == 1
    assert "t.bin: on disk" in capsys.readouterr().out
    # and a JSON file naming a product that does not exist is not adoptable either
    (env.out / "b.json").write_text(json.dumps({"bin": "b/missing.bin"}), encoding="utf-8")
    _unrecorded(env.out)
    assert _adopt() == 1 and "b/missing.bin" in capsys.readouterr().out


def test_adopt_checks_the_window(env, capsys):
    assert _build() == 0
    _unrecorded(env.out)
    assert _adopt(window=(0.0, 20.0)) == 1                      # b's code reads the window; a and c do not
    out = capsys.readouterr().out
    assert "products are for the window" in out
    assert set(_manifest(env.out)["stages"]) == {"a", "c"}


def test_verify_products_checks_tiles_through_their_listing(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "OUT", tmp_path)
    tiles = {"s/1/l/0/0/0.bin": b"x" * 10, "s/1/l/0/0/1.bin": b"y" * 12}
    listing = ""
    for rel, data in sorted(tiles.items()):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(data)
        listing += f"{hashlib.sha256(data).hexdigest()}  {rel}\n"
    (tmp_path / "s/1/l.sha256").write_text(listing, encoding="utf-8")
    products = {
        "s/1/l.sha256": {"stage": "s", "bytes": len(listing), "sha256": hashlib.sha256(listing.encode()).hexdigest()},
        "s/1/l/": {"stage": "s", "bytes": 22, "files": 2, "sha256": hashlib.sha256(listing.encode()).hexdigest()},
    }
    assert build.verify_products("s", products)[0] == []
    (tmp_path / "s/1/l/0/0/1.bin").write_bytes(b"z" * 12)
    assert "sha256 differs from its listing" in build.verify_products("s", products)[0][0]


def test_param_problem_level_cap_and_damit(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "OUT", tmp_path)
    (tmp_path / "surfaces/301").mkdir(parents=True)
    hdr = {"minLevel": 0, "maxLevel": 3, "levelCap": {"sourceMaxLevel": 5}}
    (tmp_path / "surfaces/301/albedo.json").write_text(json.dumps(hdr), encoding="utf-8")
    prods = {"surfaces/301/albedo.json": {"stage": "surfaces"}}
    assert build.param_problem("surfaces", {"surfaces.maxLevel": 3}, prods) is None
    assert "levels up to 3" in build.param_problem("surfaces", {"surfaces.maxLevel": None}, prods)
    hdr = {"minLevel": 0, "maxLevel": 5}
    (tmp_path / "surfaces/301/albedo.json").write_text(json.dumps(hdr), encoding="utf-8")
    assert build.param_problem("surfaces", {"surfaces.maxLevel": None}, prods) is None
    assert build.param_problem("surfaces", {"surfaces.maxLevel": 3}, prods) is not None
    assert "lack DAMIT" in build.param_problem("shapes", {"shapes.damit": True}, {})
    assert build.param_problem("shapes", {"shapes.damit": False}, {}) is None
    assert "development" in build.param_problem("shapes", {"shapes.only": ["eros"], "shapes.damit": False}, {})


# ------------------------------------------------------------------------------------------------ disk space


def test_stage_that_may_not_fit_is_not_started(env, monkeypatch, capsys):
    monkeypatch.setattr(config, "COSTS", {"a": config.Cost(50, 1, 5.0, 1, 1, 1, "test")})
    monkeypatch.setattr(build, "free_space", lambda: (2.0, env.out))
    assert _build() == 1
    out = capsys.readouterr().out
    assert env.stages.runs == ["c"]                              # a refused, b blocked by it, c independent
    assert "NOT STARTED" in out and "--force-space" in out and "NO SPACE" in out
    m = _manifest(env.out)
    assert m["build"]["stages"]["a"]["status"] == "no space" and "a" not in m.get("stages", {})
    assert m["build"]["stages"]["b"]["status"] == "blocked"
    env.stages.runs.clear()
    plan = build.make_plan("all", [], [], False)
    ctx = BuildContext(0.0, 10.0, params=config.resolve("all", {}, environ={}), plan=tuple(plan.stages))
    assert build.run(ctx, plan, force_space=True) == 0 and env.stages.runs == ["a", "b"]


def test_space_needed_counts_what_is_already_there(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "RAW", tmp_path)
    monkeypatch.setitem(config.RAW_DIRS, "x", ("xdir",))
    cost = config.Cost(100.0, 2.0, 6.0, 1.0, 1, 1, "test")      # 100 GB download, but at most 6 GB on disk
    assert build.space_needed("x", cost, {}) == pytest.approx(6.0 + build.SPACE_MARGIN_GB)
    (tmp_path / "xdir").mkdir()
    (tmp_path / "xdir" / "f").write_bytes(b"\0" * 1000)
    prods = {"p": {"stage": "x", "bytes": int(1e9)}}
    assert build.space_needed("x", cost, prods) == pytest.approx(6.0 - 1e-6 - 1.0 + build.SPACE_MARGIN_GB)
    assert build.space_needed("x", None, {}) == 0.0
