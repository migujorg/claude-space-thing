import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import workstation_ranges as ranges


class RangeAssemblyTests(unittest.TestCase):
    def run_case(self, changed=False):
        body = bytes(range(256)) * 70000
        start, stop = 123, len(body) - 71
        records = {}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            class Head:
                headers = {"Content-Length": str(len(body)), "ETag": '"snapshot"'}
                def close(self):
                    pass

            def fetch(url, subdir, name, *, byte_range, headers, timeout, validate):
                a, b = byte_range
                path = root / subdir / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body[a:b])
                self.assertTrue(validate(path))
                self.assertEqual(headers, {"If-Match": '"snapshot"'})
                records[path] = {"remoteBytes": len(body) + int(changed),
                                 "etag": '"snapshot"',
                                 "sha256": hashlib.sha256(body[a:b]).hexdigest()}
                return path

            with patch.object(ranges, "RAW", root), patch.object(ranges.d, "RAW", root), \
                 patch.object(ranges.d, "request", return_value=Head()), \
                 patch.object(ranges.d, "fetch", side_effect=fetch), \
                 patch.object(ranges.d, "record", side_effect=records.__getitem__), \
                 patch.object(ranges.d, "host_limit", return_value=3), \
                 patch.object(ranges.d, "update_ledger") as update:
                item = {"url": "https://example.com/snapshot", "subdir": "input", "name": "band.bin",
                        "range": [start, stop]}
                if changed:
                    with self.assertRaisesRegex(ValueError, "changed across ranges"):
                        ranges.prepare(item)
                    self.assertFalse((root / "input/band.bin").exists())
                    update.assert_not_called()
                else:
                    ranges.prepare(item)
                    self.assertEqual((root / "input/band.bin").read_bytes(), body[start:stop])
                    entry = update.call_args.args[1]
                    self.assertEqual(entry["sha256"], hashlib.sha256(body[start:stop]).hexdigest())
                    self.assertEqual(entry["range"], f"bytes={start}-{stop-1}")

    def test_parallel_ranges_preserve_exact_order_offsets_and_tail(self):
        self.run_case()

    def test_changed_remote_object_cannot_be_published(self):
        self.run_case(changed=True)
