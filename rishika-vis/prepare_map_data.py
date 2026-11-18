"""
Regrid the GOES-18 Clear Sky Mask cube (ca_cloud_june2025.nc) onto a regular
lat/lon grid covering the SF -> SD coast, and bit-pack every hourly frame so the
browser can load the whole month (450 frames) in one small binary file.

Outputs (next to this script):
  cloud_frames.bin  - 450 frames, each ceil(rows*cols/8) bytes, row-major,
                      row 0 = northernmost latitude, bit order = little (numpy 'little').
  cloud_meta.json   - grid definition + UTC timestamp of every frame.

NOTE: timestamps in the .nc are UTC. PDT = UTC - 7 h.
"""
import json
import numpy as np
import pandas as pd
import xarray as xr
from scipy.spatial import cKDTree

LAT_MIN, LAT_MAX = 32.45, 38.45
LON_MIN, LON_MAX = -124.6, -116.4
STEP = 0.03

ds = xr.open_dataset("ca_cloud_june2025.nc")
lat, lon = ds.lat.values, ds.lon.values

lats = np.arange(LAT_MAX, LAT_MIN - 1e-9, -STEP)       # north -> south
lons = np.arange(LON_MIN, LON_MAX + 1e-9, STEP)
glon, glat = np.meshgrid(lons, lats)

# nearest native pixel for each target cell (scale lon by cos(lat) so distance ~ km)
k = np.cos(np.deg2rad(35.5))
tree = cKDTree(np.column_stack([lat.ravel(), lon.ravel() * k]))
_, idx = tree.query(np.column_stack([glat.ravel(), glon.ravel() * k]))

cube = ds.cloudy.values.reshape(len(ds.time), -1)[:, idx]   # (time, rows*cols)
bits = np.packbits(cube > 0.5, axis=1, bitorder="little")
bits.tofile("cloud_frames.bin")

meta = {
    "rows": len(lats), "cols": len(lons),
    "lat0": float(lats[0]), "lon0": float(lons[0]), "step": STEP,
    "bytesPerFrame": int(bits.shape[1]),
    "timesUTC": [t.strftime("%Y-%m-%dT%H:%MZ") for t in pd.to_datetime(ds.time.values)],
}
json.dump(meta, open("cloud_meta.json", "w"))
print(meta["rows"], meta["cols"], bits.nbytes / 1e6, "MB")
