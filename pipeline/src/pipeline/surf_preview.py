"""Preview PNGs of built surface layers for docs/reports/surfaces.md (review aid, not what the app shows).

Albedo layers: texel XYZS × the body's disk-integrated geometricAlbedoXYZS colour (photometry.json), exposure set so
that the disk mean maps to display luminance 0.30, then Bradford adaptation from sunlight's white point to D65
(an observer adapted to sunlight), linear sRGB clipped to [0, 1], sRGB transfer, 256-colour palette to keep files
small. Unknown texels are drawn as a magenta/black checkerboard so they cannot be mistaken for data.
Height layers: grey level = height (1st-99th percentile stretch) plus a hillshade with 10x vertical exaggeration
(light from the north-west at 45°); unknown as above.

`uv run python -m pipeline.surf_preview` writes docs/reports/img/surfaces-<naif>-<layer>.png.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from . import surf_tiles as st
from .paths import OUT, REPO

IMG = REPO / "docs" / "reports" / "img"
MAX_W = 768


def _checker(h: int, w: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = ((yy // 8 + xx // 8) % 2).astype(np.float32)
    return np.stack([c, 0 * c, c], axis=-1) * 0.8


def albedo_rgb(header: dict, level: int) -> np.ndarray:
    import colour
    a = st.read_level(OUT, header["body"], header["layer"], level, 4, "f16")
    known = (a != 0).any(axis=2)
    phot = json.loads((OUT / "photometry.json").read_text()).get(str(header["body"]))
    light = json.loads((OUT / "light.json").read_text())
    sun = np.array(light["sun"]["irradianceXYZS_1AU"]["value"][:3])
    sun_xy = sun[:2] / sun.sum()
    absolute = (header.get("normalization") or {}).get("absoluteDiskMean")
    if absolute:  # Earth: absolute surface reflectance per channel (the disk photometry includes clouds)
        base = np.array([absolute[c] for c in "XYZ"]) * sun / sun[1]
    elif phot and phot["geometricAlbedoXYZS"]["value"]:
        base = np.array(phot["geometricAlbedoXYZS"]["value"][:3]) / sun[1]
    else:
        base = sun / sun[1]  # no disk spectrum: grey under sunlight
    xyz = a[..., :3] * base[None, None, :]
    y_mean = st.disk_mean(xyz[..., 1:2], known, level)[0]
    xyz *= 0.30 / y_mean
    cs = colour.RGB_COLOURSPACES["sRGB"]
    rgb = colour.XYZ_to_RGB(xyz.reshape(-1, 3), cs, illuminant=np.array(sun_xy),
                            chromatic_adaptation_transform="Bradford").reshape(a.shape[0], a.shape[1], 3)
    rgb = colour.cctf_encoding(np.clip(rgb, 0, 1), function="sRGB")
    return np.where(known[..., None], rgb, _checker(*known.shape))


def height_rgb(header: dict, level: int) -> np.ndarray:
    z = st.read_level(OUT, header["body"], header["layer"], level, 1, "f32")[..., 0]
    known = np.isfinite(z)
    zz = np.where(known, z, np.nanmean(z))
    h, w = z.shape
    from .photometry.albedo import pck_radii
    r = 1000 * float(np.cbrt(np.prod(pck_radii()[header["body"]])))
    dy = np.pi * r / h
    dx = 2 * np.pi * r / w * np.cos(np.radians(st.lat_centers(level)))[:, None]
    gy, gx = np.gradient(zz)
    exag = 10.0  # display only
    sx, sy = exag * gx / np.maximum(dx, 1.0), -exag * gy / dy
    az, el = np.radians(315), np.radians(45)
    lx, ly, lz = np.cos(el) * np.sin(az), np.cos(el) * np.cos(az), np.sin(el)
    shade = (-sx * lx - sy * ly + lz) / np.sqrt(1 + sx * sx + sy * sy)
    lo, hi = np.nanpercentile(z, [1, 99])
    hyp = np.clip((zz - lo) / (hi - lo), 0, 1)
    g = np.clip(0.15 + 0.45 * hyp + 0.5 * (shade - lz), 0, 1)
    return np.where(known[..., None], np.repeat(g[..., None], 3, axis=2), _checker(h, w))


def field_rgb(header: dict, level: int) -> np.ndarray:
    """Earth's dated layers, for review only. clouds: grey = cloudFraction · τ/(τ + 13.3) (a two-stream estimate of
    cloud reflectance with asymmetry g = 0.85); night: log10 radiance 0.3-100 nW cm⁻² sr⁻¹ in warm white; water:
    blue = waterFraction, white = sea ice. NaN (unknown) as the checkerboard."""
    a = st.read_level(OUT, header["body"], header["layer"], level, len(header["channels"]), "f16", nodata="nan")
    kind = header["kind"]
    if kind == "cloud-properties":
        f, tau = a[..., 0], np.nan_to_num(a[..., 1])
        g = f * tau / (tau + 13.3)
        known = np.isfinite(f)
        rgb = np.repeat(np.nan_to_num(g)[..., None], 3, axis=2)
    elif kind == "emitted-radiance":
        r = a[..., 0]
        v = np.clip((np.log10(np.maximum(np.nan_to_num(r), 1e-3)) + 0.5) / 2.5, 0, 1)
        # texels without a Black Marble value (open ocean) are drawn dark blue instead of the checkerboard
        rgb = np.where(np.isfinite(r)[..., None], v[..., None] * np.array([1.0, 0.8, 0.5]), np.array([0, 0, 0.08]))
        known = np.ones(r.shape, bool)
    else:  # surface-water
        w, ice = a[..., 0], np.nan_to_num(a[..., 1])
        known = np.isfinite(w)
        rgb = (w * (1 - ice))[..., None] * np.array([0.1, 0.25, 0.7]) + (w * ice)[..., None] * np.array([0.95] * 3)
        rgb += (1 - w)[..., None] * np.array([0.35, 0.3, 0.2])
    return np.where(known[..., None], rgb, _checker(*known.shape))


def write(header: dict) -> Path | None:
    kind = header["kind"]
    if kind not in ("relative-reflectance", "height", "cloud-properties", "emitted-radiance", "surface-water"):
        return None
    level = max(header["minLevel"], min(header["maxLevel"], 1))
    if kind == "relative-reflectance":
        rgb = albedo_rgb(header, level)
    elif kind == "height":
        rgb = height_rgb(header, level)
    else:
        rgb = field_rgb(header, max(header["minLevel"], min(header["maxLevel"], 2)))
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    if img.width > MAX_W:
        img = img.resize((MAX_W, MAX_W // 2), Image.LANCZOS)
    img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    IMG.mkdir(parents=True, exist_ok=True)
    out = IMG / f"surfaces-{header['body']}-{header['layer']}.png"
    img.save(out, optimize=True)
    return out


def main() -> None:
    for p in sorted((OUT / "surfaces").glob("*/*.json")):
        out = write(json.loads(p.read_text()))
        if out:
            print(f"{out.relative_to(REPO)}: {out.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
