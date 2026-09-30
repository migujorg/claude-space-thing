// HEALPix, NESTED ordering (Górski et al. 2005, ApJ 622, 759): the sky products (sky/*.bin, stars/deep tiles)
// are HEALPix maps in ICRS. Same algorithm as the pipeline's sky_healpix.py (healpix_base loc2pix/pix2loc), in
// TypeScript for the CPU side and WGSL for the GPU side (keep the three in sync; tests compare them).

export type V3 = [number, number, number];

export const npix = (order: number): number => 12 * 4 ** order;

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

/** Interleave: bits of x in the even positions, of y in the odd ones (x, y < 2^15). */
function interleave(x: number, y: number): number {
  let r = 0;
  for (let b = 0; b < 15; b++) r += (((x >> b) & 1) + 2 * ((y >> b) & 1)) * 4 ** b;
  return r;
}

function deinterleave(p: number): [number, number] {
  let x = 0, y = 0;
  for (let b = 0; b < 15; b++) {
    const q = Math.floor(p / 4 ** b) % 4;
    x |= (q & 1) << b;
    y |= (q >> 1) << b;
  }
  return [x, y];
}

/** NESTED pixel index of a direction (need not be normalised). order <= 13. */
export function vec2pix(order: number, v: readonly number[]): number {
  const nside = 2 ** order;
  const r = Math.hypot(v[0], v[1], v[2]);
  const z = v[2] / r;
  const za = Math.abs(z);
  let tt = Math.atan2(v[1], v[0]) / (Math.PI / 2);
  if (tt < 0) tt += 4;
  if (tt >= 4) tt = 0;
  let face: number, ix: number, iy: number;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt);
    const t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2);
    const jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(Math.floor(tp * tmp), nside - 1);
    const jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; } else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return face * nside * nside + interleave(ix, iy);
}

/** Unit vector of a NESTED pixel centre. */
export function pix2vec(order: number, pix: number): V3 {
  const nside = 2 ** order;
  const npface = nside * nside;
  const face = Math.floor(pix / npface);
  const [ix, iy] = deinterleave(pix - face * npface);
  const jr = JRLL[face] * nside - ix - iy - 1;
  let nr: number, z: number, kshift: number;
  if (jr < nside) { nr = jr; z = 1 - (nr * nr) / (3 * nside * nside); kshift = 0; }
  else if (jr > 3 * nside) { nr = 4 * nside - jr; z = -1 + (nr * nr) / (3 * nside * nside); kshift = 0; }
  else { nr = nside; z = ((2 * nside - jr) * 2) / (3 * nside); kshift = (jr - nside) & 1; }
  let jp = Math.floor((JPLL[face] * nr + ix - iy + 1 + kshift) / 2);
  if (jp > 4 * nside) jp -= 4 * nside;
  if (jp < 1) jp += 4 * nside;
  const phi = (jp - (kshift + 1) * 0.5) * ((Math.PI / 2) / nr);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/** Mean pixel spacing (rad) at an order: sqrt(4π / npix). */
export const pixelSize = (order: number): number => Math.sqrt((4 * Math.PI) / npix(order));

/**
 * WGSL: `fn hpxVec2Pix(order: u32, v: vec3f) -> u32` (NESTED), the same algorithm. Orders up to 13
 * (indices < 2^32). f32 precision limits it to pixel positions good to ~1e-7 rad, far below any map's pixel.
 */
export const HEALPIX_WGSL = /* wgsl */ `
fn hpxSpread(v: u32) -> u32 {
  var x = v & 0x0000ffffu;
  x = (x | (x << 8u)) & 0x00ff00ffu;
  x = (x | (x << 4u)) & 0x0f0f0f0fu;
  x = (x | (x << 2u)) & 0x33333333u;
  x = (x | (x << 1u)) & 0x55555555u;
  return x;
}
fn hpxVec2Pix(order: u32, vin: vec3f) -> u32 {
  let nside = 1u << order;
  let ns = f32(nside);
  let v = normalize(vin);
  let z = v.z;
  let za = abs(z);
  var tt = atan2(v.y, v.x) / (0.5 * 3.14159265358979);
  if (tt < 0.0) { tt = tt + 4.0; }
  if (tt >= 4.0) { tt = 0.0; }
  var face: u32;
  var ix: u32;
  var iy: u32;
  if (za <= 2.0 / 3.0) {
    let t1 = ns * (0.5 + tt);
    let t2 = ns * z * 0.75;
    let jp = u32(max(floor(t1 - t2), 0.0));
    let jm = u32(max(floor(t1 + t2), 0.0));
    let ifp = jp / nside;
    let ifm = jm / nside;
    if (ifp == ifm) { face = ifp | 4u; } else if (ifp < ifm) { face = ifp; } else { face = ifm + 8u; }
    ix = jm & (nside - 1u);
    iy = nside - (jp & (nside - 1u)) - 1u;
  } else {
    let ntt = min(3u, u32(floor(tt)));
    let tp = tt - f32(ntt);
    let tmp = ns * sqrt(3.0 * (1.0 - za));
    let jp = min(u32(floor(tp * tmp)), nside - 1u);
    let jm = min(u32(floor((1.0 - tp) * tmp)), nside - 1u);
    if (z >= 0.0) { face = ntt; ix = nside - jm - 1u; iy = nside - jp - 1u; }
    else { face = ntt + 8u; ix = jp; iy = jm; }
  }
  // face in 0..11 lies above the ix/iy bits; nside*nside*face fits in u32 for order <= 13
  return face * nside * nside + hpxSpread(ix) + (hpxSpread(iy) << 1u);
}
`;
