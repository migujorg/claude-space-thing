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
    monkeypatch.setattr(r, 'implementation', lambda case=None: {'register.py': 'new'})
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
    from pipeline import paths
    monkeypatch.setattr(paths,'CACHE',tmp_path/'cache')
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


@pytest.mark.skip_group('missing-input')
@pytest.mark.parametrize('case_path', sorted((build.VALIDATION / 'cases').glob('*/case.json')),
                         ids=lambda p: p.parent.name)
def test_committed_case_lock_is_current(case_path, monkeypatch):
    """Landing preflight needs code/tables, products and the environment, no raw images."""
    from pipeline.validation import reproducibility as r
    case = json.loads(case_path.read_text())
    for key in r.THREAD_VARS:
        monkeypatch.setenv(key, '1')
    missing = [key for key in case['reproducibility']['inputs']
               if key.startswith('products/') and not r.input_path(key).is_file()]
    if missing:
        pytest.skip('validation input product absent: ' + ', '.join(missing))
    r.preflight(case, check_raw=False)


def test_product_lock_ignores_prose_but_checks_consumed_values_and_presence(tmp_path, monkeypatch):
    from pipeline.validation import reproducibility as r
    monkeypatch.setattr(r, 'OUT', tmp_path)
    path = tmp_path / 'rings.json'
    product = {'699': {'opticalDepth': {'value': [{'radiusKm': [1, 2], 'normalTau': [None, .2]}],
                                       'sources': ['archive'], 'method': 'original prose'}}}
    selection = [['699', 'opticalDepth', 'value', 0, 'normalTau'],
                 ['699', 'opticalDepth', 'sources']]
    path.write_text(json.dumps(product))
    with r.capture_inputs() as inputs:
        r.read_product(path, selection)
    product['699']['opticalDepth']['method'] = 'edited prose'
    path.write_text(json.dumps(product, indent=3))
    r.check_input(path, inputs['products/rings.json'])
    with r.capture_inputs(inputs):
        r.read_product(path, selection)
    product['699']['opticalDepth']['value'][0]['normalTau'][0] = 0
    path.write_text(json.dumps(product))
    with pytest.raises(r.ReproductionError, match='consumed product values'):
        r.check_input(path, inputs['products/rings.json'])
    missing = r.selected_record(path, [['absent']])
    product['absent'] = None
    path.write_text(json.dumps(product))
    assert r.selected_record(path, [['absent']]) != missing


def test_import_closure_excludes_unexecuted_stages_and_adds_himawari_only():
    from pipeline.validation import reproducibility as r
    frame = r.implementation({'id': 'neptune-voyager2-1989'})
    earth = r.implementation({'id': 'earth-himawari9-2026'})
    assert 'validation/himawari.py' not in frame
    assert set(earth) - set(frame) == {'validation/himawari.py'}
    assert 'validation/reader_voyager.py' in frame
    assert 'validation/reader_epoxi.py' not in frame
    assert 'validation/reader_epoxi.py' in r.implementation({'id': 'earth-moon-epoxi-2008'})
    assert {'validation/build.py', 'validation/readers.py', 'validation/register.py',
            'surf_color.py', 'photometry/albedo.py'} <= set(frame)
    assert not any(p.startswith(('stages/', 'syn_', 'stars_', 'surf_earth')) for p in frame)
    assert 'photometry/ring_reflectance.py' not in frame


@pytest.mark.parametrize('section', ['reference', 'rois', 'observation', 'view', 'ratios', 'sources', 'unexpected'])
def test_renewal_refuses_every_json_change_outside_lock(tmp_path, section):
    from pipeline.validation import reproducibility as r
    old, new = tmp_path / 'old', tmp_path / 'new'
    old.mkdir(); new.mkdir()
    case = {'reproducibility': {'old': True}, 'rois': [{'expected': 1, 'tolerance': .1}],
            'observation': {'fit': 1}}
    for folder in (old, new):
        (folder / 'case.json').write_text(json.dumps(case))
        (folder / 'reference.bin').write_bytes(b'fixed')
        (folder / 'preview.png').write_bytes(b'fixed preview')
    case['reproducibility'] = {'new': True}
    (new / 'case.json').write_text(json.dumps(case))
    r.assert_renewal(old, new)
    case[section] = 'changed'
    (new / 'case.json').write_text(json.dumps(case))
    with pytest.raises(r.ReproductionError, match='outside lock'):
        r.assert_renewal(old, new)


@pytest.mark.parametrize('artifact', ['reference.bin', 'preview.png'])
def test_renewal_refuses_changed_artifact_bytes(tmp_path, artifact):
    from pipeline.validation import reproducibility as r
    old, new = tmp_path / 'old', tmp_path / 'new'
    old.mkdir(); new.mkdir()
    for folder in (old, new):
        (folder / 'case.json').write_text('{}')
        (folder / 'reference.bin').write_bytes(b'fixed')
        (folder / 'preview.png').write_bytes(b'fixed preview')
    (new / artifact).write_bytes(b'changed')
    with pytest.raises(r.ReproductionError, match=artifact):
        r.assert_renewal(old, new)


def test_renewal_writes_no_locks_if_any_case_changes(tmp_path, monkeypatch):
    from pipeline.validation import __main__ as cli, reproducibility as r
    from pipeline import paths
    from copy import deepcopy
    monkeypatch.setattr(paths, 'CACHE', tmp_path / 'cache')
    monkeypatch.setattr(build, 'VALIDATION', tmp_path)
    monkeypatch.setattr(cli, 'CASES', {'first': object(), 'second': object()})
    monkeypatch.setattr(build, 'preview', lambda path, *args: path.write_bytes(b'preview fixture'))
    for key in r.THREAD_VARS:
        monkeypatch.setenv(key, '1')
    originals, candidates = {}, {}
    for cid in cli.CASES:
        built = {'json': {'id': cid, 'generated': '2026-10-07T00:00:00+00:00',
                          'reproducibility': {'old': True}, 'reference': {'bands': []},
                          'rois': [], 'view': {}, 'observation': {'fit': 1}},
                 'refs': [np.array([[1., np.nan]])], 'rois': []}
        folder = build.write_case(cid, built)
        originals[cid] = {p.name: p.read_bytes() for p in folder.iterdir()}
        candidates[cid] = deepcopy(built)
        candidates[cid]['json']['reproducibility'] = {'renewed': True}
    candidates['second']['json']['observation']['fit'] = 2
    monkeypatch.setattr(build, 'build_case', lambda case, expected, renew: candidates[expected['id']])
    assert cli.main(['renew-locks']) == 1
    for cid in cli.CASES:
        assert {p.name: p.read_bytes() for p in (tmp_path / 'cases' / cid).iterdir()} == originals[cid]
    candidates['second']['json']['observation']['fit'] = 1
    assert cli.main(['renew-locks']) == 0
    for cid in cli.CASES:
        folder = tmp_path / 'cases' / cid
        assert json.loads((folder / 'case.json').read_text())['reproducibility'] == {'renewed': True}
        for name in ('reference.bin', 'preview.png'):
            assert (folder / name).read_bytes() == originals[cid][name]


def test_tables_lock_only_actual_reads_from_static_closure():
    from pipeline.validation import reproducibility as r
    from pipeline.photometry.common import read_table_json
    with r.capture_tables() as tables:
        read_table_json('karkoschka_disk_radii.json')
    assert {p.name for p in tables} == {'karkoschka_disk_radii.json'}
    lock = r.implementation({'id': 'neptune-voyager2-1989'}, tables=tables)
    assert 'photometry/tables/karkoschka_disk_radii.json' in lock
    assert 'photometry/tables/salo_french_2010_table4.csv' not in lock
    assert r.implementation({'id': 'neptune-voyager2-1989',
                             'reproducibility': {'implementation': lock}}) == lock
