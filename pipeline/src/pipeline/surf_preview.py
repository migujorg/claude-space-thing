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
    if phot and phot["geometricAlbedoXYZS"]["value"]:
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


def write(header: dict) -> Path | None:
    kind = header["kind"]
    if kind not in ("relative-reflectance", "height"):
        return None
    level = max(header["minLevel"], min(header["maxLevel"], 1))
    rgb = albedo_rgb(header, level) if kind == "relative-reflectance" else height_rgb(header, level)
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
