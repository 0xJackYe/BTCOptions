"""Aggregate Binance spot BTCUSDT 1m klines (GitHub mirror) to the sandbox 1h CSV format.

Output columns match prepare_data.py: open_epoch_sec,open,high,low,close,volume.
Usage: python build_hourly.py <mirror_root_1m_dir> <out_csv> <first YYYY-MM> <last YYYY-MM>
"""
import sys
from pathlib import Path
import numpy as np
import pandas as pd

src, out, first, last = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
months = pd.period_range(first, last, freq="M")
frames = []
for m in months:
    f = src / f"{m.year}" / f"{m.month:02d}" / f"BTCUSDT_1m_{m.year}-{m.month:02d}.csv"
    if not f.is_file():
        raise SystemExit(f"missing month {m}")
    d = pd.read_csv(f, usecols=["timestamp", "open", "high", "low", "close", "volume"],
                    dtype={"timestamp": np.int64, "open": str, "high": str, "low": str, "close": str, "volume": str})
    frames.append(d)
d = pd.concat(frames, ignore_index=True)
ts = d.timestamp.to_numpy()
ts = np.where(ts >= 100000000000000, ts // 1000000, ts // 1000)  # us or ms -> s
if (ts % 60).any():
    raise SystemExit("non-minute timestamps")
d["sec"] = ts
d = d.drop_duplicates("sec").sort_values("sec")
for c in ("open", "high", "low", "close", "volume"):
    d[c + "_f"] = d[c].astype(float)
d["hour"] = d.sec // 3600 * 3600
g = d.groupby("hour", sort=True)
h = pd.DataFrame({
    "open_epoch_sec": g.hour.first().astype(np.int64),
    "open": g.open_f.first(), "high": g.high_f.max(), "low": g.low_f.min(),
    "close": g.close_f.last(), "volume": g.volume_f.sum(),
    "minutes": g.sec.size(),
})
bad = (h[["open", "high", "low", "close"]].min(axis=1) <= 0) | (h.high < h[["open", "close"]].max(axis=1)) | (h.low > h[["open", "close"]].min(axis=1))
if bad.any():
    raise SystemExit(f"invalid OHLC rows: {int(bad.sum())}")
gaps = np.diff(h.open_epoch_sec.to_numpy())
print("hours", len(h), "first", pd.to_datetime(h.open_epoch_sec.iloc[0], unit="s"), "last", pd.to_datetime(h.open_epoch_sec.iloc[-1], unit="s"))
print("non-hourly gaps", int((gaps != 3600).sum()), "partial hours(<60 min)", int((h.minutes < 60).sum()))
out.parent.mkdir(parents=True, exist_ok=True)
h.drop(columns="minutes").to_csv(out, index=False, float_format="%.8f")
