"""`time` stage: NAIF LSK naif0012.tls -> app/public/data/time.json (schema TimeData).

The leap-second table and the TDB-TT formula constants are read through SPICE's kernel-pool parser, which
converts the LSK's @dates to "UTC seconds past J2000" on a leap-second-free count (86400 s per day), i.e.
exactly unix_seconds - 946728000. That is the `utcJ2000` value of each LeapSecond (see schema.ts).
"""

from __future__ import annotations

from ..ephem_kernels import SRC_LSK, gd, lsk, pool
from ..output import write_json
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ()

UNIX_S_AT_J2000_UTC_COUNT = 946728000  # 2000-01-01T12:00:00 on the leap-second-free count (10957.5 d * 86400 s)

NOTES = (
    "utcJ2000 = (Unix seconds of the UTC instant) - 946728000, i.e. seconds from 2000-01-01T12:00:00 counted with "
    "86400 s per UTC day and no leap seconds (SPICE's 'UTC seconds past J2000' in DELTET/DELTA_AT). deltaAT = TAI-UTC "
    "in seconds from that instant on. TT = TAI + deltaTA; TDB = TT + k*sin(E), E = M + eb*sin(M), M = m0 + m1*t with "
    "t = TT seconds past J2000 (SPICE DELTET). Before the first entry SPICE uses deltaAT(first) - 1."
)


def run(ctx: BuildContext) -> None:
    path = lsk(ctx)
    with pool(path):
        table = gd("DELTET/DELTA_AT")
        dta, k, eb, m = gd("DELTET/DELTA_T_A"), gd("DELTET/K"), gd("DELTET/EB"), gd("DELTET/M")
    if table is None or dta is None or k is None or eb is None or m is None or len(m) != 2:
        raise ValueError(f"{path.name}: missing DELTET variables")
    pairs = [(table[i + 1], table[i]) for i in range(0, len(table), 2)]
    if any(b[0] <= a[0] for a, b in zip(pairs, pairs[1:])):
        raise ValueError("leap-second table not strictly increasing")
    for utc, dat in pairs:
        if utc != round(utc) or dat != round(dat):
            raise ValueError(f"unexpected non-integer leap-second entry {utc}, {dat}")
    data = {
        "source": SRC_LSK,
        "notes": NOTES,
        "leapSeconds": [{"utcJ2000": int(u), "deltaAT": int(d)} for u, d in pairs],
        "deltaTA": dta[0],
        "k": k[0],
        "eb": eb[0],
        "m0": m[0],
        "m1": m[1],
    }
    write_json(ctx, "time.json", data, "time")
    print(f"[time] {len(pairs)} leap-second entries, last deltaAT={pairs[-1][1]:.0f} s")
