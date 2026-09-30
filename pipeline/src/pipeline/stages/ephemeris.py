"""`ephemeris` stage -> app/public/data/ephem/<PLANETARY>.{json,bin} and ephem/sat-<system>.{json,bin}.

<PLANETARY> (de442s): every segment of NAIF's de442s.bsp, restricted to the records overlapping the manifest window
widened by MARGIN_S on both sides (room for light-time: no observer in the solar system sees anything more than a
few hours in the past). Records are copied bit-for-bit (label `measured`).

sat-mar, sat-jup, sat-sat, sat-ura, sat-nep, sat-plu: every moon of that planetary system plus the planet centre
(499 ... 999 wrt the system barycentre), excerpted from the current NAIF satellite kernels over the same window
(ephem_satellites.py). Records are the kernels' own, bit-for-bit (label `measured`); one moonlet is an SPK type 17
precessing conic. Chain: moon -> barycentre (or planet centre) -> SSB through ephem/<PLANETARY>.
"""

from __future__ import annotations

from collections import defaultdict

from .. import ephem_satellites as sat
from ..ephem_kernels import PLANETARY, SRC_PLANETARY, planetary
from ..ephem_spk import read_spk, restrict, write_product
from ..paths import OUT
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ()

DAY = 86400.0
MARGIN_S = 2 * DAY


def run(ctx: BuildContext) -> None:
    t0, t1 = ctx.start_et - MARGIN_S, ctx.end_et + MARGIN_S

    path = planetary(ctx)
    segs = []
    for s in read_spk(path):
        r = restrict(s, t0, t1)
        r.sources = [SRC_PLANETARY]
        r.label = "measured"
        r.method = f"SPK type 2 records copied unchanged from {PLANETARY}.bsp (those overlapping the window)."
        segs.append(r)
    write_product(ctx, PLANETARY, segs, "ephemeris", notes=(
        f"Every {PLANETARY}.bsp segment restricted to the records overlapping the manifest window +/- 2 days; records "
        "are bit-identical to the kernel. Chain: 10,1..9 wrt 0 (SSB); 199 wrt 1; 299 wrt 2; 301, 399 wrt 3."))
    print(f"[ephemeris] {PLANETARY}: {len(segs)} segments, {sum(s.records.size for s in segs)} doubles")

    session = sat._session()
    surveys = {k.name: sat.survey(k, session) for k in sat.KERNELS}
    targets = sat.assign_targets(surveys, t0, t1)
    by_system: dict[str, list] = defaultdict(list)
    for k in sat.KERNELS:
        if not targets[k.name]:
            raise ValueError(f"{k.name} provides no body: drop it from ephem_satellites.KERNELS")
        path = sat.excerpt(k, targets[k.name], t0, t1, session)
        src = sat.register_source(ctx, k, path, surveys[k.name])
        info = sat.kernel_info(k, path)
        got = read_spk(path, targets[k.name])
        if {s.target for s in got} != targets[k.name]:
            raise ValueError(f"{k.name}: excerpt does not hold every assigned target")
        for s in got:
            r = restrict(s, t0, t1)
            r.sources = [src]
            r.label = "measured"
            r.method = (f"SPK type {s.type} {'records' if s.type != 17 else 'elements'} copied unchanged from "
                        f"{k.name}.bsp ({'whole file' if k.whole else 'range-request excerpt'}).")
            r.uncertainty = info.uncertainty
            by_system[k.system].append(r)
        print(f"[ephemeris] {k.name}: {len(got)} bodies from {path.name} ({path.stat().st_size / 1e6:.2f} MB)")

    for key, (bary, planet) in sat.SYSTEMS.items():
        segs = sorted(by_system[key], key=lambda s: (s.target != 100 * bary + 99, s.target))
        write_product(ctx, f"sat-{key}", segs, "ephemeris", notes=(
            f"{planet} system: planet centre {100 * bary + 99} and every moon, wrt the {planet} barycentre ({bary}) "
            f"or the planet centre, from the NAIF satellite kernels "
            f"{', '.join(sorted({s.sources[0].removeprefix('naif-') for s in segs}))}; records bit-identical. "
            f"Chain to the SSB through ephem/{PLANETARY}."))
        print(f"[ephemeris] sat-{key}: {len(segs)} segments")

    # ephem/ belongs to this stage: drop products it no longer writes (e.g. after changing PLANETARY).
    for f in (OUT / "ephem").iterdir():
        if f"ephem/{f.name}" not in ctx.products:
            f.unlink()
            print(f"[ephemeris] removed stale {f.name}")
