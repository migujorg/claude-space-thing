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
import platform
import sys

import numpy as np
from ..paths import RAW, OUT, REPO

THREAD_VARS = ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS')
_ACTIVE = ContextVar('validation_input_capture', default=None)
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
    if state is None or event != 'open' or not isinstance(args[0], (str, bytes, os.PathLike)):
        return
    # CPython reports both Python and native library opens here; only successful
    # reads become dependencies. Do not capture download temporary files/writes.
    flags = args[2]
    if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
        return
    path = Path(os.fsdecode(args[0])).absolute()
    key = _input_key(path)
    if key is None or not path.is_file() or key in state['seen']:
        return
    state['seen'][key] = path
    expected = state['expected']
    if expected is not None:
        if key not in expected:
            raise ReproductionError(f'{key}: unrecorded rebuild input')
        token = _ACTIVE.set(None)
        try:
            check_file(path, expected[key])
        finally:
            _ACTIVE.reset(token)


sys.addaudithook(_audit)


@contextmanager
def capture_inputs(expected=None):
    out = {}
    state = {'seen': {}, 'expected': expected}
    token = _ACTIVE.set(state)
    successful = False
    try:
        yield out
        successful = True
    finally:
        _ACTIVE.reset(token)
        for key, path in sorted(state['seen'].items()):
            out[key] = file_record(path)
        if successful and expected is not None and out != expected:
            raise ReproductionError('rebuild input set/bytes differ from recorded inputs')


def runtime():
    # Build configuration captures BLAS/LAPACK implementation as well as versions.
    from numpy._core import _multiarray_umath
    return {'python': platform.python_version(), 'machine': platform.machine(),
            'system': platform.system(),
            'libraries': {p: version(p) for p in ('numpy', 'scipy', 'spiceypy', 'astropy',
                                                  'colour-science', 'pillow')},
            'numpyConfig': np.show_config(mode='dicts'),
            'cpuFeatures': _multiarray_umath.__cpu_features__,
            'threads': {k: os.environ.get(k) for k in THREAD_VARS}}


def require_single_thread():
    if any(os.environ.get(k) != '1' for k in THREAD_VARS):
        raise ReproductionError('validation builds require OPENBLAS_NUM_THREADS=1 '
                                'OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 set before Python starts')


def implementation():
    base = REPO / 'pipeline/src/pipeline'
    # Include imported physics and transcriptions, not only the validation fitter.
    return {p.relative_to(base).as_posix(): file_record(p)['sha256']
            for p in sorted(base.rglob('*')) if p.is_file() and
            (p.suffix in ('.py', '.csv', '.json') and '__pycache__' not in p.parts)
            and p != base / 'validation/report.py'}


def preflight(case):
    lock = case.get('reproducibility')
    if lock:
        if lock.get('schema') != 'validation-rebuild-v1':
            raise ReproductionError('unsupported validation rebuild lock schema')
        if lock['runtime'] != runtime():
            raise ReproductionError('numerical environment differs from committed rebuild lock')
        if lock['implementation'] != implementation():
            raise ReproductionError('pipeline code/tables differ from committed rebuild lock')
        for key, rec in lock['inputs'].items():
            # Missing raw files can be fetched by their declared builders, but the
            # audit check must match their recorded bytes before consuming them.
            path = input_path(key)
            if path.exists() or key.startswith('products/'):
                check_file(path, rec)
    else:
        # Legacy cases already record many sources. Check actual bytes, never just
        # trust the download ledger's stored hash. Missing sources are checked after
        # prepare, including newly fetched responses whose timestamps have changed.
        from .. import download
        ledger = download._load_ledger()
        by_url = {v['url']: RAW / k for k, v in ledger.items()}
        for src in case.get('sources', []):
            p = by_url.get(src['url'])
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
    keys = ('observation','view','reference','rois','ratios','comparison','pixel')
    different = [k for k in keys if a.get(k) != b.get(k)]
    return {'reproduces': not different and refs['identical'], 'criterion': 'exact scientific JSON and reference bytes',
            'caseBytesIdentical': file_record(old_dir/'case.json') == file_record(new_dir/'case.json'),
            'previewBytesIdentical': file_record(old_dir/'preview.png') == file_record(new_dir/'preview.png'),
            'differentSections': different, 'reference': refs, 'regions': regions}


@contextmanager
def expected_case(case):
    token = EXPECTED_CASE.set(case)
    try:
        yield
    finally:
        EXPECTED_CASE.reset(token)
