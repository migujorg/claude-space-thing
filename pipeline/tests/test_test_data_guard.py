"""Exercise the test-only write barrier on writable directories, without touching shared data."""

import os
from pathlib import Path
import subprocess
import sys


def test_earth_reader_cache_miss_is_private(monkeypatch):
    from pipeline import paths
    from pipeline.photometry import earth

    assert earth.CACHE.resolve() != paths.CACHE.resolve()
    # An empty test-only image selection exercises the cache writer without processing a full disk.
    monkeypatch.setattr(earth.ed, "epoxi_files", lambda: {})
    monkeypatch.setattr(earth.ed, "epoxi_selection", lambda: {})
    cache = earth.CACHE / "earth" / f"epoxi-{earth._cache_key([])}.json"
    assert not cache.exists()
    assert earth.epoxi_disk() == {}
    assert cache.read_text().strip() == "{}"


def test_shared_data_guard_blocks_real_mutations_and_allows_private_writes(tmp_path):
    code = '''
import os, sys
from pathlib import Path
import numpy as np
from conftest import DataWriteGuard, SharedDataWriteError
root = Path(sys.argv[1])
shared = root / "shared"
shared.mkdir()
file = shared / "input"
file.write_bytes(b"original")
alias = root / "alias"
alias.symlink_to(shared, target_is_directory=True)
fd = os.open(shared, os.O_RDONLY)
guard = DataWriteGuard([shared])
guard.install()
assert file.read_bytes() == b"original"
shared.mkdir(exist_ok=True)
private = root / "private"
private.mkdir()
(private / "input").write_bytes(b"private")
operations = [
    lambda: file.write_bytes(b"changed"),
    lambda: (alias / "new").write_text("changed"),
    lambda: (shared / "new-dir").mkdir(),
    lambda: file.unlink(),
    lambda: file.rename(private / "moved"),
    lambda: (private / "input").replace(shared / "replacement"),
    lambda: (shared / "link").symlink_to(private / "input"),
    lambda: os.link(private / "input", shared / "hardlink"),
    lambda: os.chmod(file, 0o777),
    lambda: os.utime(file),
    lambda: os.truncate(file, 0),
    lambda: os.open("relative", os.O_WRONLY | os.O_CREAT, dir_fd=fd),
    lambda: np.array([1.]).tofile(shared / "numpy.bin"),
]
for operation in operations:
    try:
        operation()
    except SharedDataWriteError:
        pass
    else:
        raise AssertionError("mutation escaped the guard")
assert len(guard.violations) == len(operations)
assert file.read_bytes() == b"original"
assert sorted(p.name for p in shared.iterdir()) == ["input"]
# Removing a private symlink only removes that directory entry, not the shared target.
alias.unlink()
assert file.read_bytes() == b"original"
os.close(fd)
'''
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).parent) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], env=env,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
