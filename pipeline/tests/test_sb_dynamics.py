"""The small-body integrator (sb_dynamics): two-body pieces, conservation laws, the splitting against an adaptive
8th-order reference on the same forces, and JPL Horizons for the verification set (fixtures in tests/fixtures/sb).

Tests that need the planetary kernel (data/raw/naif/spk/de442s.bsp) skip when it has not been downloaded."""

import json
import math
from pathlib import Path

import numpy as np
import pytest

from pipeline import sb_catalog, sb_dynamics as dyn, sb_model, sb_verify
from pipeline.ephem_kernels import PLANETARY
from pipeline.paths import RAW

FIX = Path(__file__).parent / "fixtures" / "sb"
MU = 1.3271244004127942e11   # BODY10_GM of gm_de440.tpc (the model reads it from the kernel; here only a scale)
AU = 149597870.7
HAVE_KERNEL = (RAW / "naif" / "spk" / f"{PLANETARY}.bsp").exists()
needs_kernel = pytest.mark.skipif(not HAVE_KERNEL, reason="planetary kernel not downloaded (run the ephemeris stage)")


def _energy(s):
    return 0.5 * np.dot(s[3:], s[3:]) - MU / np.linalg.norm(s[:3])


@pytest.mark.parametrize("q_au,e", [(2.7, 0.01), (0.14, 0.89), (0.5, 0.99999), (1.0, 1.0), (1.36, 6.14)])
def test_kepler_drift_conserves_and_reverses(q_au, e):
    out = np.empty(6)
    assert dyn.elements_to_state(q_au * AU, e, 0.4, 1.1, 2.2, -20 * 86400.0, MU, 0.409, out) == dyn.OK
    rng = np.random.default_rng(1)
    s = out.copy()
    x, v = s[:3].copy(), s[3:].copy()
    total = 0.0
    for _ in range(300):
        dt = (rng.random() - 0.3) * 4 * 86400.0
        total += dt
        assert dyn.kepler_drift(x, v, dt, MU, math.nan) == dyn.OK
    s1 = np.concatenate([x, v])
    assert abs(_energy(s1) - _energy(out)) / (MU / (q_au * AU)) < 1e-12
    h0, h1 = np.cross(out[:3], out[3:]), np.cross(x, v)
    assert np.linalg.norm(h1 - h0) / np.linalg.norm(h0) < 1e-12
    x2, v2 = out[:3].copy(), out[3:].copy()
    assert dyn.kepler_drift(x2, v2, total, MU, math.nan) == dyn.OK
    assert np.linalg.norm(x2 - x) < 1e-9 * np.linalg.norm(x)
    assert dyn.kepler_drift(x2, v2, -total, MU, math.nan) == dyn.OK
    assert np.linalg.norm(x2 - out[:3]) < 1e-8 * q_au * AU


def test_elements_match_classical_ellipse():
    rng = np.random.default_rng(3)
    for _ in range(100):
        e, q = rng.random() * 0.95, (0.3 + 5 * rng.random()) * AU
        i, node, peri, M = rng.random() * np.pi, rng.random() * 6.28, rng.random() * 6.28, (rng.random() * 2 - 1) * np.pi
        a = q / (1 - e)
        n = math.sqrt(MU / a ** 3)
        out = np.empty(6)
        dyn.elements_to_state(q, e, i, node, peri, M / n, MU, 0.0, out)
        E = M
        for _ in range(60):
            E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
        cO, sO, cw, sw, ci, si = math.cos(node), math.sin(node), math.cos(peri), math.sin(peri), math.cos(i), math.sin(i)
        P = np.array([cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si])
        Q = np.array([-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si])
        assert np.linalg.norm(out[:3] - (xp * P + yp * Q)) < 1e-9 * a


def test_stumpff_series_matches_closed_form_at_boundary():
    for z in (1 - 1e-12, -1 + 1e-12):
        c2, c3 = dyn.stumpff_c2_c3(z)
        x = math.sqrt(abs(z))
        want2 = (1 - math.cos(x)) / z if z > 0 else (math.cosh(x) - 1) / -z
        want3 = (x - math.sin(x)) / (x * z) if z > 0 else (math.sinh(x) - x) / (x * -z)
        assert abs(c2 - want2) < 1e-14 and abs(c3 - want3) < 1e-14


@pytest.fixture(scope="module")
def fixture_data():
    hz = json.loads((FIX / "horizons.json").read_text(encoding="utf-8"))
    cat = sb_catalog.load_orbits([FIX / "orbits.json"])
    sb_catalog.attach_nongrav(cat, {int(p.stem): p for p in (FIX / "nongrav").glob("*.json")})
    return hz, cat


@pytest.fixture(scope="module")
def model(fixture_data):
    hz, cat = fixture_data
    ep = sb_catalog.epoch_et(cat)
    return sb_model.build(None, float(ep.min()) - 10 * 86400.0, hz["epochEt"] + 600 * 86400.0, hz["epochEt"])


@needs_kernel
def test_splitting_without_planets_is_exact_kepler(model):
    """With every perturber massless and no relativity/J2, the SABA map is the exact two-body flow: energy and
    angular momentum are conserved to rounding over 548 days, and the result equals one Kepler drift."""
    import dataclasses
    m0 = dataclasses.replace(model, gm=np.full_like(model.gm, 1e-30), gr=False, j2p=model.j2p.copy())
    m0.j2p[0] = -1.0
    out = np.empty(6)
    dyn.elements_to_state(0.14 * AU, 0.89, 0.4, 1.1, 2.2, 0.0, m0.mu_sun, 0.409, out)
    s = out.reshape(1, 6).copy()
    t0 = model.span[0] + 400 * 86400.0
    ng, has = np.zeros((1, 9)), np.zeros(1, dtype=bool)
    st, stats = sb_model.propagate(m0, s, np.array([t0]), t0 + 548 * 86400.0, t0, ng, has)
    assert st[0] == dyn.OK and stats[0, 0] > 274
    ref = out.copy()
    x, v = ref[:3].copy(), ref[3:].copy()
    dyn.kepler_drift(x, v, 548 * 86400.0, m0.mu_sun, math.nan)
    assert np.linalg.norm(s[0, :3] - x) < 1e-4  # km, rounding over ~1000 drifts
    e0 = 0.5 * out[3:] @ out[3:] - m0.mu_sun / np.linalg.norm(out[:3])
    e1 = 0.5 * s[0, 3:] @ s[0, 3:] - m0.mu_sun / np.linalg.norm(s[0, :3])
    assert abs(e1 - e0) / abs(e0) < 1e-12
    assert np.linalg.norm(np.cross(s[0, :3], s[0, 3:]) - np.cross(out[:3], out[3:])) / np.linalg.norm(
        np.cross(out[:3], out[3:])) < 1e-12


@needs_kernel
def test_forward_backward_reversibility(model, fixture_data):
    hz, cat = fixture_data
    row = sb_verify.find_row(cat, "3200")
    s0 = np.array(next(o for o in hz["objects"] if o["designation"] == "3200")["stateCommon"])
    s = s0.reshape(1, 6).copy()
    c = hz["epochEt"]
    sb_model.propagate(model, s, np.array([c]), c + 300 * 86400.0, c, cat.ng[row:row + 1], cat.has_ng[row:row + 1])
    sb_model.propagate(model, s, np.array([c + 300 * 86400.0]), c, c, cat.ng[row:row + 1], cat.has_ng[row:row + 1])
    assert np.linalg.norm(s[0, :3] - s0[:3]) < 0.01  # km after 300 d there and back through perihelion


@needs_kernel
@pytest.mark.parametrize("des", ["1", "3200", "2026 RT34", "C/2025 N1", "2P"])
def test_integration_error_vs_adaptive_reference(model, fixture_data, des):
    """Same forces, adaptive DOP853 (rtol 1e-13) vs the fixed-grid splitting: the scheme's own error."""
    hz, cat = fixture_data
    o = next(o for o in hz["objects"] if o["designation"] == des)
    row = sb_verify.find_row(cat, des)
    ep = np.array(o["epochs"])
    ours, status, _ = sb_verify.propagate_along(model, np.array(o["stateCommon"]), hz["epochEt"], ep,
                                                cat.ng[row:row + 1], cat.has_ng[row:row + 1])
    ref = sb_verify.reference(model, np.array(o["stateCommon"]), hz["epochEt"], ep, cat.ng[row], cat.has_ng[row])
    err = np.nanmax(np.linalg.norm(ours[:, :3] - ref[:, :3], axis=1))
    print(f"{o['label']}: integration error {err:.4f} km")
    assert (status == 0).all() and err < 1.0


@needs_kernel
def test_against_horizons(model, fixture_data):
    """Elements -> state at the SBDB epoch -> common epoch -> fixture epochs, vs JPL Horizons (independent)."""
    hz, cat = fixture_data
    c = hz["epochEt"]
    lines = []
    for o in hz["objects"]:
        row = int(np.nonzero(cat.spkid == o["spkid"])[0][0])
        sub = cat.subset(np.array([row]))
        s, st = sb_catalog.states_at_epoch(sub, model.mu_sun, model.obliquity)
        assert st[0] == dyn.OK
        if row in cat.ng_unsupported:
            s = np.array([o["stateCommon"]])   # the product takes Horizons' state for these (see the stage)
        else:
            sb_model.propagate(model, s, sb_catalog.epoch_et(sub), c, c, sub.ng, sub.has_ng)
            # deterministic: the stage computed exactly this state
            assert np.linalg.norm(s[0, :3] - np.array(o["stateCommon"][:3])) < 1e-6
        ours, status, _ = sb_verify.propagate_along(model, s[0], c, np.array(o["epochs"]), sub.ng, sub.has_ng)
        err = np.linalg.norm(ours[:, :3] - np.array(o["states"])[:, :3], axis=1)
        lines.append(f"{o['label']:30s} {err.max():10.3f} km (tolerance {o['toleranceKm']})")
        assert err.max() <= o["toleranceKm"], o["label"]
    print("\n".join(lines))
