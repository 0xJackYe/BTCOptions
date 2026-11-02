"""Download public Binance research data with published SHA256 verification.

Defaults: BTCUSDT spot 1h, 2020-01 through 2026-10. Optional --options also
downloads the 147 archived 2023 EOH option files used for IV calibration.
This script never reads API keys or accesses a trading/account endpoint.
"""
import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SPOT_BASE = "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1h/"
OPTION_BASE = "https://data.binance.vision/data/option/daily/EOHSummary/BTCUSDT/"


def fetch_bytes(url):
    request = urllib.request.Request(url, headers={"User-Agent": "BTC-options-public-research/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def parse_checksum(text, filename):
    parts = text.strip().split()
    if not parts or not re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
        raise ValueError(f"Malformed published SHA256 checksum: {filename}")
    if len(parts) > 1 and parts[1].lstrip("*") != filename:
        raise ValueError(f"Checksum names a different archive: {filename}")
    return parts[0].lower()


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_bytes(content)
    temporary.replace(path)


def download_verified(url, cache_dir, frozen_sha256=None):
    """Use a verified cached file, or download/reverify a damaged or missing one."""
    filename = url.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.zip", filename):
        raise ValueError("Unexpected archive filename")
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / filename
    checksum_path = cache_dir / (filename + ".CHECKSUM")
    checksum_bytes = checksum_path.read_bytes() if checksum_path.exists() else fetch_bytes(url + ".CHECKSUM")
    expected = parse_checksum(checksum_bytes.decode("ascii"), filename)
    if frozen_sha256 is not None and expected != frozen_sha256.lower():
        raise ValueError(f"Published archive changed from the frozen calibration source: {filename}")
    existing = path.read_bytes() if path.exists() else None
    if existing is not None and hashlib.sha256(existing).hexdigest() == expected:
        payload = existing
    else:
        payload = fetch_bytes(url)
        if hashlib.sha256(payload).hexdigest() != expected:
            raise ValueError(f"SHA256 mismatch: {filename}")
        atomic_write(path, payload)
    if not checksum_path.exists():
        atomic_write(checksum_path, checksum_bytes)
    return path, {"url": url, "file": filename, "bytes": len(payload), "sha256": expected, "verified": True}


def parse_spot_archive(path):
    """Normalize Binance's pre-2025 milliseconds and 2025+ microseconds to seconds."""
    rows = []
    with zipfile.ZipFile(path) as archive:
        for member in archive.namelist():
            if not member.lower().endswith(".csv"):
                continue
            with archive.open(member) as stream:
                for row in csv.reader(io.TextIOWrapper(stream, encoding="utf-8-sig")):
                    if not row or not row[0].isdigit():
                        continue
                    if len(row) < 6:
                        raise ValueError(f"Truncated spot row in {Path(path).name}")
                    raw_time = int(row[0])
                    seconds = raw_time // (1000000 if raw_time >= 100000000000000 else 1000)
                    o, h, lo, c, volume = map(float, row[1:6])
                    if not (seconds % 3600 == 0 and min(o, h, lo, c) > 0 and h >= max(o, c) and lo <= min(o, c) and volume >= 0):
                        raise ValueError(f"Invalid spot OHLC/hour in {Path(path).name}")
                    rows.append((seconds, o, h, lo, c, volume))
    if not rows:
        raise ValueError(f"No spot rows in {Path(path).name}")
    return rows


def default_months():
    return [f"{year}-{month:02d}" for year in range(2020, 2027)
            for month in range(1, 13) if (year, month) <= (2026, 10)]


def prepare_spot(data_dir=DATA, months=None, workers=6):
    data_dir = Path(data_dir)
    months = default_months() if months is None else months
    if not months:
        raise ValueError("No spot months requested")
    for month in months:
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
            raise ValueError("Month must be YYYY-MM")
    def one(month):
        filename = f"BTCUSDT-1h-{month}.zip"
        path, metadata = download_verified(SPOT_BASE + filename, data_dir / "spot-archives")
        rows = parse_spot_archive(path)
        metadata.update({"month": month, "rows": len(rows)})
        return metadata, rows
    manifest, by_time = [], {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for count, (metadata, rows) in enumerate(pool.map(one, months), 1):
            manifest.append(metadata)
            for row in rows:
                if row[0] in by_time and by_time[row[0]] != row:
                    raise ValueError(f"Conflicting duplicate hour: {row[0]}")
                by_time[row[0]] = row
            if count % 12 == 0:
                print(f"Verified spot archives: {count}/{len(months)}", flush=True)
    ordered = sorted(by_time.values())
    gaps = [[ordered[i - 1][0], ordered[i][0]] for i in range(1, len(ordered))
            if ordered[i][0] - ordered[i - 1][0] != 3600]
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["open_epoch_sec", "open", "high", "low", "close", "volume"])
    writer.writerows(ordered)
    atomic_write(data_dir / "btc_spot_1h.csv", output.getvalue().encode("utf-8"))
    result = {"source": "Official Binance public BTCUSDT spot 1h archives", "downloaded_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
              "all_archives_verified": True, "archives": len(manifest), "rows": len(ordered),
              "start_utc": dt.datetime.fromtimestamp(ordered[0][0], dt.timezone.utc).isoformat(),
              "end_utc": dt.datetime.fromtimestamp(ordered[-1][0] + 3600, dt.timezone.utc).isoformat(),
              "non_hourly_gaps": gaps, "gaps_filled": False, "files": manifest}
    atomic_write(data_dir / "spot-data-manifest.json", json.dumps(result, indent=2).encode("utf-8"))
    return result


def prepare_options(data_dir=DATA, workers=5):
    data_dir = Path(data_dir)
    sources = json.loads((ROOT / "calibration/archive-checksums.json").read_text(encoding="utf-8"))
    def one(item):
        filename = item["file"]
        if not re.fullmatch(r"BTCUSDT-EOHSummary-\d{4}-\d{2}-\d{2}\.zip", filename):
            raise ValueError("Unexpected option archive name in frozen source list")
        _, metadata = download_verified(OPTION_BASE + filename, data_dir / "eoh-archives", item["sha256"])
        return metadata
    files = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for count, metadata in enumerate(pool.map(one, sources), 1):
            files.append(metadata)
            if count % 25 == 0:
                print(f"Verified option archives: {count}/{len(sources)}", flush=True)
    result = {"source": "Frozen official 2023 BTCUSDT EOH sources for research calibration", "archives": len(files),
              "all_archives_verified": True, "bytes": sum(x["bytes"] for x in files), "files": files}
    atomic_write(data_dir / "option-data-manifest.json", json.dumps(result, indent=2).encode("utf-8"))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA)
    parser.add_argument("--options", action="store_true", help="Also download about 56MB of optional 2023 option archives")
    parser.add_argument("--options-only", action="store_true", help="Download only optional EOH archives; existing spot data is still needed for recalibration")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16:
        parser.error("--workers must be between 1 and 16")
    try:
        if not args.options_only:
            result = prepare_spot(args.data_dir, workers=args.workers)
            print(f"Spot ready: {result['archives']} verified archives, {result['rows']} hours")
        if args.options or args.options_only:
            result = prepare_options(args.data_dir, workers=args.workers)
            print(f"Option calibration archives ready: {result['archives']} verified files")
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(f"Data preparation failed; no unverified dataset accepted: {error}")


if __name__ == "__main__":
    main()
