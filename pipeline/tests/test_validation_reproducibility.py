"""Regression coverage for hidden fit inputs and committed-case rebuild locks."""
import json
from types import SimpleNamespace
import numpy as np
import pytest
from pipeline.validation import build, geometry as g, register


def target():
    return g.Target(999, 'test', np.array([0., 0., -1e6]), np.array([[1.,0.,0.],[0.,0.,1.],[0.,-1.,0.]]),
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


def test_lock_refuses_environment_and_code_changes(monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setattr(r, 'runtime', lambda: {'numpy': 'new'})
    monkeypatch.setattr(r, 'implementation', lambda: {'register.py': 'new'})
    c={'reproducibility': {'schema':'validation-rebuild-v1', 'runtime':{'numpy':'old'},
                           'implementation':{'register.py':'old'}, 'inputs':{}}}
    with pytest.raises(r.ReproductionError,match='numerical environment'):
        r.preflight(c)
    c['reproducibility']['runtime']={'numpy':'new'}
    with pytest.raises(r.ReproductionError,match='code/tables'):
        r.preflight(c)


def test_locked_build_refuses_new_input(tmp_path, monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setattr(r,'RAW',tmp_path)
    f=tmp_path/'unrecorded.txt'; f.write_text('new')
    with pytest.raises(r.ReproductionError,match='unrecorded rebuild input'):
        with r.capture_inputs({}):
            f.read_text()


def test_himawari_rebuild_uses_recorded_kernel_without_directory_listing(monkeypatch,tmp_path):
    from pipeline.validation import himawari, reproducibility as r
    f=tmp_path/'earth_000101_261226_260929.bpc'; f.write_bytes(b'kernel fixture')
    calls=[]
    def fetch(url,subdir):
        calls.append(url)
        return f
    monkeypatch.delenv('PIPELINE_VALIDATION_EARTH_PCK',raising=False)
    monkeypatch.setattr(himawari.download,'fetch',fetch)
    monkeypatch.setattr(himawari.download,'record',lambda p: {'url':calls[-1], 'retrieved':'2026-09-30',
                                                            'sha256':r.file_record(p)['sha256']})
    from pipeline.schema import BuildContext
    src={'id':'naif-earth-pck-high-prec', 'version':f.name, 'sha256':r.file_record(f)['sha256']}
    with r.expected_case({'sources':[src]}):
        assert himawari._earth_pck(BuildContext(0.,0.))==f
    assert calls==['https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/'+f.name]


def test_unlocked_cli_cannot_write_committed_cases():
    from pipeline.validation.__main__ import main
    with pytest.raises(SystemExit) as e:
        main(['build','--unlocked'])
    assert e.value.code==2


def test_single_thread_requirement_is_explicit(monkeypatch):
    from pipeline.validation import reproducibility as r
    for key in r.THREAD_VARS:
        monkeypatch.setenv(key,'1')
    r.require_single_thread()
    monkeypatch.setenv('OMP_NUM_THREADS','4')
    with pytest.raises(r.ReproductionError,match='before Python starts'):
        r.require_single_thread()


def test_verify_reports_reference_difference_without_modifying_case(tmp_path,monkeypatch,capsys):
    from pipeline.validation import __main__ as cli
    monkeypatch.setitem(cli.CASES,'fixture-case',object())
    monkeypatch.setattr(build,'preview',lambda path,*args: path.write_bytes(b'preview fixture'))
    built={'json': {'schema':'validation-case-v1','id':'fixture-case','observation':{},'view':{},
                    'reference':{'bands':[]},'rois':[]},
           'refs':[np.array([[1.,2.],[3.,np.nan]])], 'rois':[]}
    monkeypatch.setattr(build,'VALIDATION',tmp_path)
    old_dir=build.write_case('fixture-case',built)
    original={p.name:p.read_bytes() for p in old_dir.iterdir()}
    monkeypatch.setattr(build,'build_case',lambda case,expected: built)
    assert cli.main(['verify','--only','fixture-case','--cases-dir',str(tmp_path)])==0
    built['refs'][0][0,0]=2.
    assert cli.main(['verify','--only','fixture-case','--cases-dir',str(tmp_path)])==1
    output=capsys.readouterr().out.strip().splitlines()
    assert json.loads(output[-1])['reference']['maxAbsDifference']==1.
    assert {p.name:p.read_bytes() for p in old_dir.iterdir()}==original
    assert cli.main(['build','--only','fixture-case'])==1
    assert {p.name:p.read_bytes() for p in old_dir.iterdir()}==original


def test_unlocked_output_cannot_alias_committed_directory(tmp_path,monkeypatch):
    from pipeline.validation.__main__ import main
    monkeypatch.setattr(build,'VALIDATION',tmp_path)
    with pytest.raises(SystemExit) as e:
        main(['build','--unlocked','--output',str(tmp_path)])
    assert e.value.code==2


def test_spectral_intermediate_cache_is_private_and_discarded(tmp_path,monkeypatch):
    from pipeline.validation import reproducibility as r
    from pipeline.photometry import earth
    from pipeline import paths
    shared=tmp_path/'old-cache'; shared.mkdir()
    sentinel=shared/'historical.json'; sentinel.write_text('historical values')
    monkeypatch.setattr(earth,'CACHE',shared)
    monkeypatch.setattr(paths,'CACHE',tmp_path)
    with r.isolated_spectral_cache():
        fresh=earth.CACHE
        assert fresh!=shared and not (fresh/'historical.json').exists()
        (fresh/'derived.json').write_text('computed this run')
    assert earth.CACHE==shared and sentinel.read_text()=='historical values'
    assert not fresh.exists()


def test_generation_stamp_is_an_explicit_artifact_input(monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setenv('SOURCE_DATE_EPOCH','1791360000')
    first=r.generation_time(None)
    assert first==r.generation_time(None)
    assert r.generation_time({'generated':'2026-09-30T19:00:00+00:00'})=='2026-09-30T19:00:00+00:00'
    monkeypatch.delenv('SOURCE_DATE_EPOCH')
    with pytest.raises(r.ReproductionError,match='SOURCE_DATE_EPOCH'):
        r.generation_time(None)


def test_input_capture_refuses_stale_download_ledger(tmp_path,monkeypatch):
    from pipeline.validation import reproducibility as r
    from pipeline import download
    monkeypatch.setattr(r,'RAW',tmp_path)
    f=tmp_path/'frame.img'; f.write_bytes(b'changed on disk')
    monkeypatch.setattr(download,'_load_ledger',lambda: {'frame.img':{'sha256':'old'}})
    with pytest.raises(r.ReproductionError,match='frame.img.*ledger'):
        with r.capture_inputs():
            f.read_bytes()


def test_source_lookup_disambiguates_archived_responses_by_digest(tmp_path,monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setattr(r,'RAW',tmp_path)
    (tmp_path/'old.txt').write_bytes(b'old header')
    (tmp_path/'new.txt').write_bytes(b'new header')
    old=r.file_record(tmp_path/'old.txt')['sha256']; new=r.file_record(tmp_path/'new.txt')['sha256']
    ledger={'old.txt':{'url':'https://example.invalid/query','sha256':old},
            'new.txt':{'url':'https://example.invalid/query','sha256':new}}
    assert r.source_path({'url':'https://example.invalid/query','sha256':old},ledger)==tmp_path/'old.txt'


def test_source_lookup_prefers_consumed_identical_copy(tmp_path,monkeypatch):
    from pipeline.validation import reproducibility as r
    from pipeline import download
    monkeypatch.setattr(r,'RAW',tmp_path)
    for name in ('unused.txt','used.txt'):
        (tmp_path/name).write_bytes(b'identical response')
    sha=r.file_record(tmp_path/'used.txt')['sha256']
    ledger={name:{'url':'https://example.invalid/query','sha256':sha} for name in ('unused.txt','used.txt')}
    monkeypatch.setattr(download,'_load_ledger',lambda:ledger)
    with r.capture_inputs():
        (tmp_path/'used.txt').read_bytes()
        assert r.source_path({'url':'https://example.invalid/query','sha256':sha},ledger)==tmp_path/'used.txt'


def test_cached_fit_preserves_exact_camera_for_wrapped_roll(tmp_path,monkeypatch):
    monkeypatch.setattr(build,'CACHE',tmp_path)
    t=target(); pitch=.001; raw_roll=-21.123456789
    cam=g.camera_for(t,4,4,pitch,2.,2.,raw_roll)
    # An optimizer can return a camera differing by an ulp from reconstructing
    # its wrapped angle (observed for Pluto). Preserve its returned result.
    cam.M[0,0]=np.nextafter(cam.M[0,0],1.)
    ft=register.Fit(2.,2.,raw_roll%360.,False,1.,2.,.1,.01,cam,[1.])
    monkeypatch.setattr(register,'fit_pointing',lambda *a,**kw:ft)
    args=('case','image','abc',np.zeros((4,4)),[t],pitch,(False,))
    cold=build._fit_cached(*args).camera.M.copy()
    warm=build._fit_cached(*args).camera.M
    assert np.array_equal(cold,warm), 'normalizing a cached angle must not recompute its camera at different bits'


def test_case_build_clears_process_local_numerical_caches(monkeypatch):
    import sys
    from functools import lru_cache
    from types import ModuleType
    from pipeline.validation import reproducibility as r
    module=ModuleType('pipeline.fixture_cached_inputs')
    calls=[]
    @lru_cache()
    def read_input():
        calls.append(1)
        return len(calls)
    module.read_input=read_input
    monkeypatch.setitem(sys.modules,module.__name__,module)
    assert read_input()==read_input()==1
    r.clear_process_caches()
    assert read_input()==2
