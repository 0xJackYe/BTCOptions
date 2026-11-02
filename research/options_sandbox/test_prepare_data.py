"""Offline public-data downloader integrity tests; never makes a network call."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import prepare_data as data


def archive_bytes(rows):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("sample.csv", "\n".join(rows) + "\n")
    return stream.getvalue()


class PrepareDataTests(unittest.TestCase):
    def test_expected_default_month_range(self):
        months = data.default_months()
        self.assertEqual(len(months), 82)
        self.assertEqual(months[0], "2020-01")
        self.assertEqual(months[-1], "2026-10")

    def test_milliseconds_and_microseconds_normalize(self):
        payload = archive_bytes(["open_time,open,high,low,close,volume", "1577836800000,100,105,90,101,2", "1735689600000000,200,210,190,205,3"])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.zip"
            path.write_bytes(payload)
            rows = data.parse_spot_archive(path)
        self.assertEqual([x[0] for x in rows], [1577836800, 1735689600])

    def test_invalid_ohlc_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.zip"
            path.write_bytes(archive_bytes(["1577836800000,100,90,80,101,2"]))
            with self.assertRaises(ValueError):
                data.parse_spot_archive(path)

    def test_checksum_name_and_digest_are_validated(self):
        with self.assertRaises(ValueError):
            data.parse_checksum("garbage", "a.zip")
        with self.assertRaises(ValueError):
            data.parse_checksum("0" * 64 + "  other.zip", "a.zip")

    def test_verified_cache_needs_no_network(self):
        payload = archive_bytes(["1577836800000,100,105,90,101,2"])
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "sample.zip").write_bytes(payload)
            (root / "sample.zip.CHECKSUM").write_text(digest + "  sample.zip")
            with patch.object(data, "fetch_bytes", side_effect=AssertionError("No network allowed")):
                _, metadata = data.download_verified("https://example.invalid/sample.zip", root)
            self.assertTrue(metadata["verified"])

    def test_mismatched_download_is_not_saved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checksum = ("0" * 64 + "  sample.zip").encode()
            def fetch(url):
                return checksum if url.endswith(".CHECKSUM") else b"wrong"
            with patch.object(data, "fetch_bytes", side_effect=fetch):
                with self.assertRaises(ValueError):
                    data.download_verified("https://example.invalid/sample.zip", root)
            self.assertFalse((root / "sample.zip").exists())

    def test_corrupted_cache_is_replaced_only_after_verification(self):
        payload = archive_bytes(["1577836800000,100,105,90,101,2"])
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "sample.zip").write_bytes(b"damaged")
            (root / "sample.zip.CHECKSUM").write_text(digest + "  sample.zip")
            with patch.object(data, "fetch_bytes", return_value=payload) as request:
                path, metadata = data.download_verified("https://example.invalid/sample.zip", root)
            request.assert_called_once_with("https://example.invalid/sample.zip")
            self.assertEqual(path.read_bytes(), payload)

    def test_frozen_option_source_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(data, "fetch_bytes", return_value=("1" * 64 + "  sample.zip").encode()):
                with self.assertRaises(ValueError):
                    data.download_verified("https://example.invalid/sample.zip", temporary, "0" * 64)

    def test_merged_csv_and_manifest_are_built_offline(self):
        payload = archive_bytes(["1577836800000,100,105,90,101,2", "1577844000000,101,108,100,106,4"])
        digest = hashlib.sha256(payload).hexdigest()
        def fetch(url):
            return (digest + "  BTCUSDT-1h-2020-01.zip").encode() if url.endswith(".CHECKSUM") else payload
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(data, "fetch_bytes", side_effect=fetch):
                manifest = data.prepare_spot(temporary, months=["2020-01"], workers=1)
            root = Path(temporary)
            self.assertEqual(manifest["rows"], 2)
            self.assertEqual(manifest["non_hourly_gaps"], [[1577836800, 1577844000]])
            self.assertFalse(manifest["gaps_filled"])
            self.assertTrue((root / "btc_spot_1h.csv").is_file())
            self.assertTrue(json.loads((root / "spot-data-manifest.json").read_text())["all_archives_verified"])


if __name__ == "__main__":
    unittest.main()
