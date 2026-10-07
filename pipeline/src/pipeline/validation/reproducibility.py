"""Rebuild locks and diagnostics. No numerical tolerance is inferred from validation scores.

Exact reproduction requires the recorded numerical environment and all input bytes. The
registration budget is positional, not a covariance for roll, so it cannot justify a
floating-point epsilon on the reference array. Legacy cases can be diagnosed but lack
an exact rebuild lock. Inputs include actual file reads, even uncited pointing checks.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
from types import FunctionType
import platform
import sys

import numpy as np
from ..paths import RAW, OUT, REPO

THREAD_VARS = ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS')
_ACTIVE = ContextVar('validation_input_capture', default=None)
_TABLES = ContextVar('validation_table_capture', default=None)
EXPECTED_CASE = ContextVar('validation_expected_case', default=None)


class ReproductionError(RuntimeError):
    pass


def file_record(path):
    from ..download import sha256_file
    return {'sha256': sha256_file(path), 'bytes': path.stat().st_size}


def check_file(path, expected):
    if not path.is_file():
        raise ReproductionError(f'{path}: locked input missing')
    actual = file_record(path)
    if any(actual[k] != expected[k] for k in ('sha256', 'bytes') if k in expected):
        raise ReproductionError(f'{path}: input sha256 differs: expected {expected["sha256"]}, '
                                f'got {actual["sha256"]}. Restore the recorded input; '
                                'use build --unlocked --output DIR only to inspect a new candidate.')


def _input_key(path):
    for prefix, root in (('raw', RAW), ('products', OUT)):
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        if rel.as_posix().startswith('_downloads') or rel.suffix in ('.lock', '.partial'):
            return None
        return f'{prefix}/{rel.as_posix()}'
    return None


def input_path(key):
    prefix, rel = key.split('/', 1)
    if prefix not in ('raw', 'products') or '..' in Path(rel).parts or Path(rel).is_absolute():
        raise ReproductionError(f'invalid locked input path: {key}')
    return (RAW if prefix == 'raw' else OUT) / rel


def _audit(event, args):
    state = _ACTIVE.get()
    tables = _TABLES.get()
    if (state is None and tables is None) or event != 'open' or not isinstance(args[0], (str, bytes, os.PathLike)):
        return
    # CPython reports both Python and native library opens here; only successful
    # reads become dependencies. Do not capture download temporary files/writes.
    flags = args[2]
    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
        return
    path = Path(os.fsdecode(args[0])).absolute()
    if tables is not None:
        base = REPO / 'pipeline/src/pipeline'
        if path.is_relative_to(base) and path.suffix not in ('.py', '.pyc') and '__pycache__' not in path.parts and path.is_file():
            tables.add(path)
    if state is None:
        return
    key = _input_key(path)
    if key is None or not path.is_file() or key in state['seen']:
        return
    state['seen'][key] = path
    expected = state['expected']
    if expected is not None and not (state['renew'] and key.startswith('products/')):
        if key not in expected:
            raise ReproductionError(f'{key}: unrecorded rebuild input')
        token = _ACTIVE.set(None)
        try:
            if 'selection' not in expected[key]:
                check_file(path, expected[key])
        finally:
            _ACTIVE.reset(token)


sys.addaudithook(_audit)


@contextmanager
def capture_inputs(expected=None, *, renew=False):
    out = {}
    state = {'seen': {}, 'expected': expected, 'selections': {}, 'renew': renew}
    token = _ACTIVE.set(state)
    successful = False
    try:
        yield out
        successful = True
    finally:
        _ACTIVE.reset(token)
        for key, path in sorted(state['seen'].items()):
            out[key] = (selected_record(path, state['selections'][key])
                        if key in state['selections'] else file_record(path))
        if successful:
            from .. import download
            ledger = download._load_ledger()
            for key, rec in out.items():
                stored = ledger.get(key.removeprefix('raw/')) if key.startswith('raw/') else None
                if stored and stored.get('sha256') != rec['sha256']:
                    raise ReproductionError(f'{key}: actual input sha256 differs from download ledger')
        if successful and expected is not None:
            actual = {k: v for k, v in out.items() if not (renew and k.startswith('products/'))}
            pinned = {k: v for k, v in expected.items() if not (renew and k.startswith('products/'))}
            changed = [k for k in sorted(set(actual) | set(pinned)) if actual.get(k) != pinned.get(k)]
            if changed:
                raise ReproductionError(f'rebuild input set/bytes differ: {", ".join(changed)}')


@contextmanager
def capture_tables():
    """Keep only source tables read by this case from the walker's table directories."""
    tables = set()
    token = _TABLES.set(tables)
    try:
        yield tables
    finally:
        _TABLES.reset(token)


def runtime():
    # Build configuration captures BLAS/LAPACK implementation as well as versions.
    from numpy._core import _multiarray_umath
    import scipy
    import spiceypy as sp
    import zlib
    from PIL import features
    return {'python': platform.python_version(), 'machine': platform.machine(),
            'libc': list(platform.libc_ver()), 'floatRounds': sys.float_info.rounds,
            'spiceToolkit': sp.tkvrsn('TOOLKIT'),
            'pngCompression': {'pythonZlib': zlib.ZLIB_RUNTIME_VERSION, 'pillowZlib': features.version('zlib')},
            'system': platform.system(),
            'libraries': {p: version(p) for p in ('numpy', 'scipy', 'spiceypy', 'astropy',
                                                  'colour-science', 'pillow')},
            'numpyConfig': np.show_config(mode='dicts'), 'scipyConfig': scipy.show_config(mode='dicts'),
            'cpuFeatures': _multiarray_umath.__cpu_features__,
            'threads': {k: os.environ.get(k) for k in THREAD_VARS}}


def require_single_thread():
    if any(os.environ.get(k) != '1' for k in THREAD_VARS):
        raise ReproductionError('validation builds require OPENBLAS_NUM_THREADS=1 '
                                'OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 set before Python starts')


def implementation(case=None, *, tables=None):
    """Reuse the stage fingerprint import/table walker with a validation entry point.

    Its public interface takes a stage name. A private globals copy adapts that
    entry point without mutating the runner or duplicating its AST traversal.
    The selected frame reader is an explicit dynamic-import seed.
    Himawari alone adds its prepare module. CLI/report orchestration is not science.
    """
    from .. import build as fingerprints
    root = fingerprints.PKG_ROOT
    from .cases import CASES
    cid = (case or {}).get('id')
    entry = 'validation.himawari' if (case or {}).get('id') == 'earth-himawari9-2026' else 'validation.build'
    def module_file(name):
        if name == 'stages.__validation__':
            name = entry
        path = fingerprints._module_file(name)
        return None if path == root / 'build.py' else path
    namespace = dict(fingerprints.code_closure.__globals__)
    namespace.update(_module_file=module_file, NOT_CODE=fingerprints.NOT_CODE - {'build'})
    walker = FunctionType(fingerprints.code_closure.__code__, namespace)
    files, _ = walker('__validation__')
    if cid in CASES:
        entry = f'validation.reader_{CASES[cid].reader}'
        reader_files, _ = walker('__validation__')
        files = sorted(set(files) | set(reader_files))
    candidates = set(files)
    if tables is None:
        # The code hash detects changes that introduce/remove a table read; the
        # rebuild capture checks that the actual set still matches the lock.
        tables = {root / name for name in (case or {}).get('reproducibility', {}).get('implementation', {})
                  if Path(name).suffix != '.py'}
    if not set(tables) <= candidates:
        raise ReproductionError('read table outside static import/table closure')
    files = sorted({p for p in files if p.suffix == '.py'} | set(tables))
    return {p.relative_to(root).as_posix(): file_record(p)['sha256'] for p in files}


def selected_record(path, selection):
    """Canonical selected JSON paths, including presence (missing differs from null)."""
    token = _ACTIVE.set(None)
    try:
        document = json.loads(path.read_text(encoding='utf-8'))
    finally:
        _ACTIVE.reset(token)
    values = []
    for parts in selection:
        value = document
        present = True
        for part in parts:
            try:
                value = value[part]
            except (KeyError, IndexError, TypeError):
                present, value = False, None
                break
        values.append({'path': parts, 'present': present, 'value': value})
    payload = json.dumps(values, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                         allow_nan=False).encode('utf-8')
    return {'selection': selection, 'sha256': hashlib.sha256(payload).hexdigest()}


def read_product(path, selection):
    """Record exactly the fields consumed, rather than incidental product prose."""
    state = _ACTIVE.get()
    key = _input_key(path)
    document = json.loads(path.read_text(encoding='utf-8'))
    if state is not None:
        selections = state['selections'].setdefault(key, [])
        for parts in selection:
            if parts not in selections:
                selections.append(parts)
        selections.sort(key=lambda parts: json.dumps(parts))
    return document


def check_input(path, record):
    if 'selection' not in record:
        return check_file(path, record)
    if not path.is_file():
        raise ReproductionError(f'{path}: locked input product missing')
    if selected_record(path, record['selection']) != record:
        raise ReproductionError(f'{path}: consumed product values differ from committed rebuild lock')


def preflight(case, *, check_raw=True, renew=False):
    lock = case.get('reproducibility')
    if lock:
        if lock.get('schema') not in ('validation-rebuild-v1', 'validation-rebuild-v2'):
            raise ReproductionError('unsupported validation rebuild lock schema')
        if lock['runtime'] != runtime():
            raise ReproductionError('numerical environment differs from committed rebuild lock')
        if not renew and lock['implementation'] != implementation(case):
            raise ReproductionError('pipeline code/tables differ from committed rebuild lock')
        for key, rec in lock['inputs'].items():
            # Missing raw files can be fetched by their declared builders, but the
            # audit check must match their recorded bytes before consuming them.
            path = input_path(key)
            if key.startswith('raw/') and check_raw and path.exists():
                check_input(path, rec)
            elif key.startswith('products/') and not renew:
                check_input(path, rec)
    else:
        # Legacy cases already record many sources. Check actual bytes, never just
        # trust the download ledger's stored hash. Missing sources are checked after
        # prepare, including newly fetched responses whose timestamps have changed.
        from .. import download
        ledger = download._load_ledger()
        for src in case.get('sources', []):
            p = source_path(src, ledger)
            if p and p.exists() and src.get('sha256'):
                actual = file_record(p)['sha256']
                if actual != src['sha256']:
                    raise ReproductionError(f'{src["id"]}: source sha256 differs: expected '
                                            f'{src["sha256"]}, got {actual}')


def check_sources(expected, actual):
    old = {s['id']: s for s in expected.get('sources', []) if s.get('sha256')}
    new = {s['id']: s for s in actual.get('sources', [])}
    for sid, s in old.items():
        if sid not in new or new[sid].get('sha256') != s['sha256']:
            raise ReproductionError(f'{sid}: source sha256 differs from committed case')
    # Retrieval metadata is provenance of the pinned copy, not today's build date.
    for s in actual.get('sources', []):
        if s['id'] in old:
            s['retrieved'] = old[s['id']]['retrieved']


def compare_reference(old, new):
    a, b = np.fromfile(old, dtype='<f4'), np.fromfile(new, dtype='<f4')
    identical = file_record(old) == file_record(new)
    if a.shape != b.shape:
        return {'identical': identical, 'shapeChanged': True, 'finiteMaskChanged': None,
                'maxAbsDifference': None}
    ok = np.isfinite(a) & np.isfinite(b)
    return {'identical': identical, 'shapeChanged': False,
            'finiteMaskChanged': int(np.count_nonzero(np.isfinite(a) != np.isfinite(b))),
            'maxAbsDifference': float(np.max(np.abs(a[ok].astype(float)-b[ok]))) if ok.any() else 0.}


def compare_cases(old_dir, new_dir):
    a = json.loads((old_dir/'case.json').read_text())
    b = json.loads((new_dir/'case.json').read_text())
    refs = compare_reference(old_dir/'reference.bin', new_dir/'reference.bin')
    regions = []
    new = {r['id']: r for r in b['rois']}
    for old in a['rois']:
        fresh = new.get(old['id'])
        row = {'id': old['id'], 'oldRect': old['rect'], 'newRect': fresh['rect'] if fresh else None}
        x, y = old.get('expected', {}), fresh.get('expected', {}) if fresh else {}
        if x.get('type') == y.get('type') == 'value':
            delta = np.array(y['XYZS'])-np.array(x['XYZS'])
            row['deltaXYZS'] = delta.tolist()
            tol = np.array(x['tolerance'])
            row['deltaInOldTolerance'] = [float(d/t) if t else None for d,t in zip(delta,tol)]
        elif x.get('type') == y.get('type') == 'upper-limit':
            row['deltaUpperLimitXYZS'] = (np.array(y['upperLimitXYZS'])-np.array(x['upperLimitXYZS'])).tolist()
        else:
            row['oldType'], row['newType'] = x.get('type'), y.get('type')
        regions.append(row)
    # Earlier cases predate the unrounded optimizer trace. Its absence is a
    # reported legacy gap, not a difference in their existing scientific values.
    if 'reproducibility' not in a:
        for image in b.get('observation', {}).get('images', []):
            for key in ('fitInputs', 'fitResult', 'freeFitResult'):
                image.pop(key, None)
    keys = ('observation','view','reference','rois','ratios','comparison','pixel',
            'appProducts','notes','title','summary')
    if 'reproducibility' in a:
        keys += ('reproducibility', 'sources')
    different = [k for k in keys if a.get(k) != b.get(k)]
    fits = []
    images = {m['product']: m for m in b.get('observation', {}).get('images', [])}
    for m in a.get('observation', {}).get('images', []):
        n = images.get(m['product'], {})
        f, h = m.get('fit'), n.get('fit')
        if not f or not h:
            continue
        displacement = np.array(h['targetCentrePx'])-np.array(f['targetCentrePx'])
        norm = float(np.linalg.norm(displacement))
        sigma = m.get('registrationSigmaPx')
        fits.append({'product': m['product'], 'centreDeltaPx': displacement.tolist(),
                     'centreDistancePx': norm,
                     'centreDistanceInRegistrationSigma': norm/sigma if sigma else None,
                     'rollDeltaDeg': (h['rollDeg']-f['rollDeg']+180.)%360.-180.,
                     'rssDelta': h['rss']-f['rss'], 'parityChanged': h['mirroredDisplayOrder'] != f['mirroredDisplayOrder'],
                     'fitIdentical': f == h})
    ca, cb = a.get('view', {}).get('camera', {}), b.get('view', {}).get('camera', {})
    view_delta = (float(np.max(np.abs(np.array(ca['orient'])-np.array(cb['orient']))))
                  if ca.get('orient') and cb.get('orient') else None)
    return {'reproduces': not different and refs['identical'], 'criterion': 'exact scientific JSON and reference bytes',
            'fits': fits, 'maxCameraOrientDifference': view_delta,
            'caseBytesIdentical': file_record(old_dir/'case.json') == file_record(new_dir/'case.json'),
            'previewBytesIdentical': file_record(old_dir/'preview.png') == file_record(new_dir/'preview.png'),
            'differentSections': different, 'reference': refs, 'regions': regions}


def assert_renewal(old_dir, new_dir):
    old = json.loads((old_dir / 'case.json').read_text())
    new = json.loads((new_dir / 'case.json').read_text())
    old.pop('reproducibility', None)
    new.pop('reproducibility', None)
    if old != new:
        sections = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
        raise ReproductionError('renewal changes committed JSON outside lock: ' + ', '.join(sections))
    for name in ('reference.bin', 'preview.png'):
        if (old_dir / name).read_bytes() != (new_dir / name).read_bytes():
            raise ReproductionError(f'renewal changes committed {name} bytes')


@contextmanager
def expected_case(case):
    token = EXPECTED_CASE.set(case)
    try:
        yield
    finally:
        EXPECTED_CASE.reset(token)


@contextmanager
def isolated_spectral_cache():
    """Recompute Earth spectral intermediates instead of trusting unversioned caches.

    The ordinary light stage's Earth cache hashes raw files but omits code/library
    versions. Validation must not inherit a historical result from that cache.
    Keep the shared cache intact and discard this build's intermediate afterwards.
    """
    import tempfile
    from ..paths import CACHE
    from ..photometry import earth
    CACHE.mkdir(parents=True, exist_ok=True)
    previous = earth.CACHE
    with tempfile.TemporaryDirectory(prefix="validation-spectrum-", dir=CACHE) as tmp:
        earth.CACHE = Path(tmp)
        try:
            yield
        finally:
            earth.CACHE = previous


def generation_time(expected):
    """Artifact creation time is an input, never a fresh wall-clock read on rebuild."""
    if expected and expected.get('generated'):
        return expected['generated']
    import datetime as dt
    value = os.environ.get('SOURCE_DATE_EPOCH')
    if value is None:
        raise ReproductionError('new validation candidates require SOURCE_DATE_EPOCH (Unix seconds of '
                                'artifact creation, fixed once for the batch); committed rebuilds retain '
                                'their recorded generated timestamp')
    try:
        return dt.datetime.fromtimestamp(int(value), dt.timezone.utc).isoformat(timespec='seconds')
    except (ValueError, OverflowError, OSError) as exc:
        raise ReproductionError('invalid SOURCE_DATE_EPOCH: expected Unix seconds') from exc


def source_path(source, ledger):
    """Resolve source copies by digest, preferring the file actually read this build.

    A URL can name several archived responses (different service timestamps), or
    identical copies downloaded for different cases. A URL alone is not identity.
    """
    candidates = [(RAW / key, rec) for key, rec in ledger.items()
                  if rec['url'] == source['url'] and (RAW / key).is_file()]
    if not candidates:
        return None
    state = _ACTIVE.get()
    seen = set(state['seen'].values()) if state is not None else set()
    consumed = [(path, rec) for path, rec in candidates if path in seen]
    pool = consumed or candidates
    matching = [path for path, rec in pool if rec.get('sha256') == source.get('sha256')]
    return matching[0] if matching else pool[0][0]


def clear_process_caches():
    """Each case must read its own numerical dependencies, regardless of CLI order.

    For example, albedo._radii reads a second copy of pck00011 only on its first
    call. Inheriting that result from a preceding case hides a file dependency.
    """
    from functools import _lru_cache_wrapper
    seen = set()
    for name, module in list(sys.modules.items()):
        if not name.startswith('pipeline.') or module is None:
            continue
        for value in list(vars(module).values()):
            if isinstance(value, _lru_cache_wrapper) and id(value) not in seen:
                value.cache_clear()
                seen.add(id(value))
