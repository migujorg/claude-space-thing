"""Build profiles and stage parameters: the one configuration mechanism of the pipeline.

A *parameter* is a named knob of one stage (`surfaces.maxLevel`) or of the build (`build.writeRepoFiles`). Its value
is resolved, highest priority first, from
  1. `pipeline build --set key=value` (repeatable),
  2. the parameter's environment variable, if it has one (older names such as SURFACES_BODIES keep working),
  3. the build profile (`--profile minimal|standard|full`),
  4. the parameter's default.
Stages read parameters with `ctx.param("surfaces.maxLevel")`. `python -m pipeline params` lists every parameter.

A *profile* chooses which stages run and sets a few parameters. Profiles never change what a product means: they
only decide which products (or which pyramid levels of a product) are built, and anything they leave out is
recorded as not built. Each profile's cost is in README.md ("Build profiles").
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable

# Order matters: later stages may read earlier stages' outputs (each stage's DEPENDS names them).
STAGES = ["time", "ephemeris", "light", "surfaces", "shapes", "bodies", "smallbodies", "sbphotometry", "synthetic",
          "comets", "stars", "deepstars", "sky"]


def _bool(v: str) -> bool:
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off", ""):
        return False
    raise ValueError(f"not a boolean: {v!r}")


def _opt_int(v: str) -> int | None:
    s = str(v).strip().lower()
    return None if s in ("", "none", "all") else int(s)


def _int_list(v: str) -> list[int]:
    return [int(x) for x in str(v).split(",") if x.strip()]


def _str_list(v: str) -> list[str]:
    return [x.strip() for x in str(v).split(",") if x.strip()]


def _choice(*options: str) -> Callable[[str], str]:
    def parse(v: str) -> str:
        s = str(v).strip().lower()
        if s not in options:
            raise ValueError(f"expected one of {', '.join(options)}, not {v!r}")
        return s
    return parse


@dataclass(frozen=True)
class Param:
    key: str                       # "<stage or 'build'>.<name>"
    parse: Callable[[str], Any]    # text (CLI, environment) -> value
    default: Any
    doc: str
    env: str | None = None         # environment variable that also sets it
    output: bool = True            # part of the stage's fingerprint (False: only affects how, not what, is built)
    stages: tuple[str, ...] = ()   # stages whose output it changes (default: the stage named by the key's prefix)

    @property
    def scope(self) -> str:
        return self.key.split(".", 1)[0]

    @property
    def affects(self) -> tuple[str, ...]:
        return (self.stages or (self.scope,)) if self.output else ()


PARAMS: dict[str, Param] = {p.key: p for p in [
    Param("surfaces.maxLevel", _opt_int, None,
          "Highest tile-pyramid level written (none = every level the source supports). Levels up to it are "
          "identical to a full build; a capped layer header says so in `levelCap`. Level 3 is 4096 x 2048 texels."),
    Param("surfaces.bodies", _int_list, [],
          "Rebuild only these NAIF ids (others' layers are kept). Development.", env="SURFACES_BODIES"),
    Param("surfaces.earthLayers", _str_list, [],
          "Rebuild only these Earth layers (albedo, water, clouds, night). Development.", env="SURFACES_EARTH_LAYERS"),
    Param("surfaces.keepCache", _bool, False,
          "Keep data/cache/surfaces (reduced intermediates, several GB) for fast re-runs.",
          env="SURFACES_KEEP_CACHE", output=False),
    Param("shapes.damit", _bool, True,
          "Build the DAMIT lightcurve-inversion model collection (1.4 GB download, 0.18 GB product)."),
    Param("shapes.only", _str_list, [],
          "Rebuild only these shape catalogue keys (plus 'damit'); others are kept. Development.", env="SHAPES_ONLY"),
    Param("shapes.keepRaw", _bool, False,
          "Keep shape sources > 50 MB after conversion.", env="SHAPES_KEEP_RAW", output=False),
    Param("shapes.reorient", _bool, False,
          "Only recompute the orientation blocks of the existing shape headers (meshes, DAMIT kept). Development.",
          env="SHAPES_REORIENT", output=False),
    Param("smallbodies.limit", int, 0,
          "Only the first N SBDB objects (0 = all). Development only: not a release product.", env="SB_LIMIT"),
    Param("smallbodies.snapshot", str, "",
          "SBDB snapshot: a date tag in data/raw/sbdb, 'new' to download today's, empty = the newest complete one.",
          env="SB_SNAPSHOT"),
    Param("synthetic.params", str, "",
          "JSON object overriding synthetic.PARAMS (seed, hFloor, ...). Development.", env="SYNTHETIC_PARAMS"),
    Param("stars.xpSource", _choice("archive", "bulk"), "archive",
          "Where the Gaia DR3 XP spectra come from. 'archive': only the sources the star stages need, by source_id, "
          "from ARI Heidelberg's Gaia TAP service (bright tier ~0.6 GB, deep tiers ~21 GB); 'bulk': stream all "
          "114 GB of ESA's bulk files. The values are bit-identical (docs/reports/stars.md); only the provenance "
          "records differ (so the two stages that write them rebuild; the sky stage's products do not change).",
          env="STARS_XP_SOURCE", stages=("stars", "deepstars")),
    Param("stars.xpNoStream", _bool, False,
          "Bulk route only: use the Gaia XP files streamed so far. Development only: not a release product.",
          env="STARS_XP_NO_STREAM"),
    Param("deepstars.xpSource", _choice("inherit", "archive", "bulk"), "inherit",
          "Spectrum source for deep stars and sky; inherit uses stars.xpSource.",
          env="DEEPSTARS_XP_SOURCE", stages=("deepstars", "sky")),
    Param("gaia.xpWorkers", int, 4,
          "Parallel Gaia XP downloads: queries to ARI's TAP service (stars.xpSource=archive) or streams of ESA's "
          "bulk files (bulk).", output=False),
    Param("gaia.tapWorkers", int, 2,
          "Gaia archive TAP queries run at once (deep-star tiles, faint-star sums); 1 = one at a time.", output=False),
    Param("gaia.tapService", _choice("esa", "ari"), "esa",
          "Gaia catalogue TAP provider: ESA or its ARI Heidelberg partner archive (same Gaia release).",
          env="PIPELINE_GAIA_TAP_SERVICE", stages=("stars", "deepstars", "sky")),
    Param("gaia.release", str, "dr3",
          "Gaia data release (stars_gaia.RELEASES).", env="PIPELINE_GAIA_RELEASE",
          stages=("stars", "deepstars", "sky")),
    Param("build.contact", str, "",
          "Contact (e-mail or URL) added to the User-Agent of JPL API requests, as JPL asks of bulk users.",
          env="PIPELINE_CONTACT", output=False),
    Param("build.writeRepoFiles", _bool, None,
          "Let stages rewrite tracked repository files (docs/reports/*, app/tests/fixtures/*). Default: yes for "
          "`--only` builds (development), no for profile builds, so a user's build leaves the git tree clean.",
          output=False),
]}


@dataclass(frozen=True)
class Profile:
    name: str
    stages: tuple[str, ...]
    params: dict[str, Any] = field(default_factory=dict)
    doc: str = ""


PROFILES: dict[str, Profile] = {p.name: p for p in [
    Profile("minimal", ("time", "ephemeris", "light", "bodies", "stars"), {},
            "Sun, planets, every moon, rings and atmospheres, the naked-eye star field. No surface maps, shape "
            "models, small bodies, deep stars or diffuse sky."),
    Profile("standard", tuple(STAGES), {"surfaces.maxLevel": 3, "shapes.damit": False},
            "Everything, with surface maps up to pyramid level 3 and without the DAMIT asteroid model collection."),
    Profile("full", tuple(STAGES), {},
            "Everything at full resolution."),
]}
DEFAULT_PROFILE = "full"


@dataclass(frozen=True)
class Cost:
    """What a stage costs on a cold build (nothing in data/raw yet). Measured on the development machine
    (4 vCPU, ~20-40 MB/s downloads) or taken from the stage's report in docs/reports; see `source`."""
    download_gb: float        # received from the network, including files streamed and never stored
    raw_gb: float             # left in data/raw afterwards (large sources are deleted once reduced)
    peak_gb: float            # most disk in use at once by the stage (raw + transient + cache + products)
    product_gb: float         # written to app/public/data
    cold_min: float           # cold build, minutes
    warm_min: float           # rebuild with data/raw already filled, minutes
    source: str
    note: str = ""

    def describe(self) -> str:
        t = f"~{self.cold_min:.0f} min" if self.cold_min >= 1 else "under a minute"
        gb = _gb(self.download_gb)
        return f"{gb if gb.startswith('<') else '~' + gb} download, {t}"


def _gb(x: float) -> str:
    if x < 0.001:
        return "< 1 MB"
    return f"{x:.0f} GB" if x >= 10 else f"{x:.1f} GB" if x >= 0.1 else f"{x * 1000:.0f} MB"


MEASURED = "measured: cold build of time, ephemeris, light, bodies in an empty data root, 2026-09-30"
COSTS: dict[str, Cost] = {
    "time": Cost(0.00001, 0.00001, 0.00001, 0.000002, 0.02, 0.01, MEASURED),
    "ephemeris": Cost(0.18, 0.18, 0.32, 0.14, 4, 0.1, MEASURED,
                      "DE442s + range-request excerpts of 20 NAIF satellite kernels"),
    "light": Cost(1.0, 1.0, 1.0, 0.002, 7, 1, MEASURED,
                  "0.8 GB of it is Earth photometry (EPOXI, Himawari-9 full-disk scans)"),
    "surfaces": Cost(22, 3.0, 15, 4.2, 55, 45, "docs/reports/surfaces.md (per-module cold times, ledger)",
                     "the Moon's 13 GB of LROC mosaics, Mercury's 4.3 GB and Pluto's 1.3 GB are deleted right after "
                     "reduction, so a rebuild downloads them again; 1.3 GB of products at surfaces.maxLevel=3"),
    "shapes": Cost(2.6, 0.2, 2.5, 0.61, 25, 20, "docs/reports/shapes.md (build times), ledger",
                   "without DAMIT (shapes.damit=0): 1.2 GB download, 0.43 GB products"),
    "bodies": Cost(0.04, 0.04, 0.04, 0.001, 0.1, 0.05, MEASURED),
    "smallbodies": Cost(1.55, 1.55, 2.0, 0.22, 18, 3, "docs/reports/small-bodies.md section 7",
                        "JPL SBDB is queried one request at a time, as JPL asks"),
    "sbphotometry": Cost(0.002, 0.002, 0.002, 0.00003, 0.5, 0.2,
                         "estimated from its inputs: one 1.3 MB source archive, a few Horizons queries"),
    "synthetic": Cost(0.03, 0.03, 0.2, 0.15, 1.5, 1, "docs/reports/synthetic-populations.md"),
    "comets": Cost(0.02, 0.02, 0.05, 0.002, 5, 5, "docs/reports/comets.md",
                   "propagates every comet with M1/K1 day by day through the window; a few Horizons queries"),
    "stars": Cost(0.95, 0.9, 1.0, 0.024, 20, 1, "docs/reports/stars.md section 8 (measured 2026-09-30)",
                  "XP spectra of the 440 702 selected sources by source_id (207 queries on ARI's Gaia TAP, 0.6 GB); "
                  "stars.xpSource=bulk streams all 114 GB of ESA's bulk files instead"),
    "deepstars": Cost(22, 1.1, 3.0, 0.79, 85, 4, "docs/reports/stars.md section 8, docs/reports/sky.md",
                      "192 Gaia archive queries (1.0 GB) + XP spectra of 15.3 M sources (3158 queries, 21 GB, reduced "
                      "on the fly, 0.5 GB cache; ~55 min at 4 queries at a time); fetched again if data/cache is "
                      "deleted"),
    "sky": Cost(0.13, 0.13, 0.2, 0.04, 30, 2.5, "docs/reports/sky.md",
                "96 all-sky aggregation queries on the Gaia archive (10-19 min per 48); 18 MB of corona papers and "
                "sunspot-number files"),
}


#: The same stages with stars.xpSource=bulk (docs/reports/stars.md, sky.md): the stars stage streams all 114 GB of
#: XP bulk files once and, with deepstars or sky in the build, fills their XP cache in that pass.
BULK_XP_COSTS: dict[str, Cost] = {
    "stars": Cost(116, 1.6, 3.2, 0.024, 50, 1, "docs/reports/stars.md",
                  "streams all 114 GB of Gaia DR3 XP spectra once (only 1.2 GB kept); with deepstars or sky in the "
                  "same build it also fills their 1.1 GB XP cache in that pass"),
    "deepstars": Cost(1.1, 1.1, 3.0, 0.79, 30, 3, "docs/reports/sky.md",
                      "192 Gaia archive queries; +114 GB / ~75 min of XP streaming if the stars stage did not "
                      "fill the XP cache (e.g. data/cache deleted)"),
}


#: data/raw subdirectories each stage downloads into (from a full build's ledger): what a rerun finds already there
#: does not need space again (pre-flight space check in build.py).
RAW_DIRS: dict[str, tuple[str, ...]] = {
    "time": ("naif",), "ephemeris": ("naif",), "bodies": ("naif",),
    "light": ("earth", "atmospheres", "papers", "solar", "rings", "filters", "cie", "karkoschka", "payne2026",
              "decolibus2026", "smallbody_colors", "neowise_v2"),
    "surfaces": ("surfaces",), "shapes": ("shapes",),
    "smallbodies": ("sbdb", "ssodnet", "mpc", "lcdb", "gaia_dr3_sso", "cneos", "horizons"),
    "sbphotometry": ("sbpy",), "synthetic": ("synthetic",), "comets": ("comets", "papers"),
    "stars": ("stars",), "deepstars": ("stars/gaia_dr3_deep",), "sky": ("sky", "stars/gaia_dr3_sums"),
}

#: surfaces products by level cap (GB), summed from the tiles of a full build (levels 0..cap of every layer).
SURFACES_GB_BY_CAP = {0: 0.03, 1: 0.10, 2: 0.37, 3: 1.26, 4: 3.10}
CACHE_GB = 1.0   # data/cache after a full build (XP reductions 0.5 GB, 1.1 GB with stars.xpSource=bulk; small-body
#                  states, shapes)


def stage_cost(stage: str, params: dict[str, Any]) -> Cost | None:
    """COSTS[stage], adjusted for the parameters that change it (surface level cap, DAMIT, XP source)."""
    from dataclasses import replace
    c = COSTS.get(stage)
    if c is None:
        return None
    if params.get("stars.xpSource") == "bulk":
        c = BULK_XP_COSTS.get(stage, c)
    if stage == "surfaces" and params.get("surfaces.maxLevel") is not None:
        gb = SURFACES_GB_BY_CAP.get(int(params["surfaces.maxLevel"]), c.product_gb)
        c = replace(c, product_gb=gb, peak_gb=c.peak_gb - c.product_gb + gb)
    if stage == "shapes" and params.get("shapes.damit") is False:
        c = replace(c, download_gb=1.2, peak_gb=1.4, product_gb=0.43, cold_min=c.cold_min - 3, warm_min=c.warm_min - 2)
    return c


def profile_totals(profile: str, sets: dict[str, Any] | None = None) -> dict[str, float]:
    """Download, data/raw, products, disk needed (at rest + the largest transient) and time of a cold build."""
    params = resolve(profile, sets or {}, environ={})
    cs = [stage_cost(s, params) for s in PROFILES[profile].stages if s in COSTS]
    raw = sum(c.raw_gb for c in cs)
    prod = sum(c.product_gb for c in cs)
    transient = max((c.peak_gb - c.raw_gb - c.product_gb for c in cs), default=0.0)
    cache = CACHE_GB if {"deepstars", "smallbodies", "shapes"} & set(PROFILES[profile].stages) else 0.2
    return {"download_gb": sum(c.download_gb for c in cs), "raw_gb": raw, "product_gb": prod,
            "disk_gb": raw + prod + cache + max(transient, 0.0), "cold_min": sum(c.cold_min for c in cs),
            "warm_min": sum(c.warm_min for c in cs)}


def cost_table(markdown: bool = False) -> str:
    rows = [("stage", "cold download", "kept in data/raw", "peak disk", "products", "cold build", "forced rebuild",
             "notes")]
    for s in STAGES:
        c = COSTS[s]
        rows.append((s, _gb(c.download_gb), _gb(c.raw_gb), _gb(c.peak_gb), _gb(c.product_gb), _min(c.cold_min),
                     _min(c.warm_min), c.note))
    prow = [("profile", "cold download", "kept in data/raw", "disk needed", "products", "cold build", "forced rebuild",
             "stages")]
    for name, p in PROFILES.items():
        t = profile_totals(name)
        extra = ", ".join(f"{k}={json.dumps(v)}" for k, v in p.params.items())
        prow.append((name, _gb(t["download_gb"]), _gb(t["raw_gb"]), _gb(t["disk_gb"]), _gb(t["product_gb"]),
                     _min(t["cold_min"]), _min(t["warm_min"]),
                     ("all" if len(p.stages) == len(STAGES) else ", ".join(p.stages)) + (f"; {extra}" if extra else "")))
    if markdown:
        def md(rs):
            out = ["| " + " | ".join(rs[0]) + " |", "|" + "---|" * len(rs[0])]
            out += ["| " + " | ".join(r) + " |" for r in rs[1:]]
            return "\n".join(out)
        return md(prow) + "\n\n" + md(rows)
    w = [max(len(r[k]) for r in rows + prow) for k in range(7)]
    fmt = lambda r: "  ".join(r[k].ljust(w[k]) for k in range(7)) + "  " + r[7]  # noqa: E731
    return "\n".join([fmt(r) for r in prow] + [""] + [fmt(r) for r in rows])


def _min(m: float) -> str:
    return "< 1 min" if m < 1 else f"{m:.0f} min" if m < 90 else f"{m / 60:.1f} h"


class ConfigError(ValueError):
    pass


def parse_sets(items: list[str]) -> dict[str, Any]:
    """['surfaces.maxLevel=4', ...] -> {key: value}, validated against PARAMS."""
    out: dict[str, Any] = {}
    for it in items:
        key, sep, text = it.partition("=")
        key = key.strip()
        if not sep:
            raise ConfigError(f"--set {it!r}: expected key=value")
        if key not in PARAMS:
            raise ConfigError(f"unknown parameter {key!r}; known: {', '.join(sorted(PARAMS))}")
        try:
            out[key] = PARAMS[key].parse(text)
        except ValueError as e:
            raise ConfigError(f"--set {key}: {e}") from None
    return out


def env_params(environ: dict | None = None) -> dict[str, Any]:
    """Parameters set through their environment variables."""
    env = os.environ if environ is None else environ
    out = {}
    for p in PARAMS.values():
        if p.env and env.get(p.env, "").strip():
            try:
                out[p.key] = p.parse(env[p.env])
            except ValueError as e:
                raise ConfigError(f"{p.env}: {e}") from None
    return out


def resolve(profile: str | None, sets: dict[str, Any] | None = None, environ: dict | None = None,
            only: bool = False) -> dict[str, Any]:
    """Every parameter's value for a build (see the module docstring for the order)."""
    prof = PROFILES[profile].params if profile else {}
    vals = {k: p.default for k, p in PARAMS.items()}
    vals.update(prof)
    vals.update(env_params(environ))
    vals.update(sets or {})
    if vals["build.writeRepoFiles"] is None:
        vals["build.writeRepoFiles"] = only
    return vals


def _text(v: Any) -> str:
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (list, tuple)):
        return ",".join(str(x) for x in v)
    return "" if v is None else str(v)


def export_env(params: dict[str, Any], environ: dict | None = None) -> None:
    """Mirror parameters that have an environment variable into it, so modules that read the variable directly
    (at import, or deep in a helper without the build context) and worker processes see the resolved value."""
    env = os.environ if environ is None else environ
    for k, p in PARAMS.items():
        if p.env and k in params and params[k] != p.default:
            env[p.env] = _text(params[k])


def value(params: dict[str, Any], key: str) -> Any:
    """params[key], or (for a context built without a resolved config, e.g. in tests) env var, then default."""
    if key in params:
        return params[key]
    if key not in PARAMS:
        raise KeyError(f"unknown parameter {key!r}")
    return env_params().get(key, PARAMS[key].default)


def stage_params(params: dict[str, Any], stage: str) -> dict[str, Any]:
    """The parameters that can change what `stage` writes (part of its fingerprint)."""
    return {k: params.get(k, PARAMS[k].default) for k, p in sorted(PARAMS.items()) if stage in p.affects}


def describe() -> str:
    lines = ["Profiles:"]
    for p in PROFILES.values():
        extra = ", ".join(f"{k}={json.dumps(v)}" for k, v in p.params.items())
        lines.append(f"  {p.name:9s} {p.doc}")
        lines.append(f"            stages: {', '.join(p.stages)}" + (f"; {extra}" if extra else ""))
    lines += ["", "Parameters (pipeline build --set key=value; env var in brackets):"]
    for p in PARAMS.values():
        env = f" [{p.env}]" if p.env else ""
        lines.append(f"  {p.key} = {json.dumps(p.default)}{env}")
        lines.append(f"      {p.doc}")
    return "\n".join(lines)
