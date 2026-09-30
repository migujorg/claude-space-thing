"""`python -m pipeline doctor` runs its local checks (offline) and knows the data hosts of every stage."""

from pipeline import config, doctor


def test_every_stage_has_its_hosts():
    assert set(doctor.HOSTS) == set(config.STAGES)
    assert all(doctor.HOSTS[s] for s in config.STAGES)


def test_offline_doctor_runs(capsys, tmp_path, monkeypatch):
    for name in ("RAW", "CACHE", "OUT"):
        monkeypatch.setattr(doctor, name, tmp_path / name.lower())
    rc = doctor.main("minimal", offline=True)
    out = capsys.readouterr().out
    assert rc in (0, 1)                       # 1 if this machine lacks disk space or Node for the profile
    for section in ("Python", "App", "Disk and paths"):
        assert f"\n{section}\n" in f"\n{out}"
    assert "numba compiles" in out and "SPICE" in out
    assert "Network" not in out


def test_unknown_profile():
    assert doctor.main("huge", offline=True) == 2
