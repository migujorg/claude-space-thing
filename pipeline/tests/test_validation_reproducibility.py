"""Regression coverage for hidden fit inputs and committed-case rebuild locks."""
import json
from types import SimpleNamespace
import numpy as np
import pytest
from pipeline.validation import build, geometry as g, register


def target():
    return g.Target(999, 'test', np.array([0., 0., -1e6]), np.eye(3),
                    np.array([0., 0., 1e8]), np.array([1000., 1000., 1000.]))


def test_pointing_cache_accounts_for_every_numerical_input(tmp_path, monkeypatch):
    monkeypatch.setattr(build, 'CACHE', tmp_path)
    calls=[]
    def fit(obs, targets, primary, pitch, flips):
        calls.append(1)
        return register.Fit(2., 2., 0., False, 1., 2., .1, .01,
                            g.camera_for(targets[0], 4, 4, pitch, 2., 2., 0.), [1.])
    monkeypatch.setattr(register, 'fit_pointing', fit)
    t=target(); obs=np.zeros((4,4))
    def run(pitch=.001):
        build._fit_cached('case', 'image', 'abc', obs, [t], pitch, (False,))
    run(); run()
    assert len(calls)==1
    t.pos[0]+=1.; run()
    assert len(calls)==2, 'target geometry must invalidate a fit'
    obs[0,0]=.1; run()
    assert len(calls)==3, 'calibrated pixels must invalidate a fit'
    run(.002)
    assert len(calls)==4, 'pixel pitch must invalidate a fit'
    t.rings=g.RingModel(np.array([2000.,3000.]), np.array([.1,.2])); run(.002)
    t.rings.tau[0]=.3; run(.002)
    assert len(calls)==6, 'ring profile values must invalidate a fit'


def test_refit_cache_does_not_round_start_or_omit_rings(tmp_path, monkeypatch):
    from pipeline import paths
    monkeypatch.setattr(paths, 'CACHE', tmp_path)
    calls=[]
    def minimize(fun, start, **kw):
        calls.append(start)
        return SimpleNamespace(x=start, fun=1.)
    monkeypatch.setattr(register.optimize, 'minimize', minimize)
    t=target(); obs=np.zeros((4,4))
    def run(cx=2.):
        return register.refit_translation(obs,[t],0,.001,cx,2.,0.)
    run(); run(); run(2.+1e-8)
    assert len(calls)==2, 'distinct starting poses must not alias'
    t.rings=g.RingModel(np.array([2000.,3000.]), np.array([.1,.2])); run()
    t.rings.tau[0]=.3; run()
    assert len(calls)==4, 'changed optical depths must not alias'


def test_lock_checks_actual_file_bytes_not_ledger(tmp_path):
    from pipeline.validation import reproducibility as r
    f=tmp_path/'image.img'; f.write_bytes(b'original')
    dep=r.file_record(f)
    r.check_file(f,dep)
    f.write_bytes(b'changed')
    with pytest.raises(r.ReproductionError,match='image.img.*sha256'):
        r.check_file(f,dep)


def test_reference_comparison_rejects_nan_footprint_change(tmp_path):
    from pipeline.validation import reproducibility as r
    a=np.array([1.,np.nan],dtype='<f4'); b=np.array([1.,2.],dtype='<f4')
    old=tmp_path/'old.bin'; new=tmp_path/'new.bin'
    old.write_bytes(a.tobytes()); new.write_bytes(b.tobytes())
    out=r.compare_reference(old,new)
    assert not out['identical'] and out['finiteMaskChanged']==1
    assert out['maxAbsDifference']==0.


def test_input_capture_checks_unregistered_files(tmp_path,monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setattr(r,'RAW',tmp_path)
    f=tmp_path/'geometry.txt'; f.write_text('first')
    with r.capture_inputs() as inputs:
        f.read_text()
    assert inputs['raw/geometry.txt']['sha256']==r.file_record(f)['sha256']
    f.write_text('changed')
    with pytest.raises(r.ReproductionError,match='geometry.txt'):
        with r.capture_inputs(inputs):
            f.read_text()
