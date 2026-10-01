// The binary products of the nightglow stage (nightglow/aurora-*.bin; schema AuroraModel), as loaded.

/** The aurora model's binaries, decoded to float32. */
export interface AuroraBins {
  /** [season 4][quantity 2][coupling node][MLT][MLAT] */
  ovation: Float32Array;
  /** [lat][lon][mlat deg, cos mlon, sin mlon] */
  magnetic: Float32Array;
  /** [energy node][altitude][line group 4] */
  emission: Float32Array;
}

/** Decode IEEE 754 half floats (little endian) to float32. */
export function decodeFloat16(buf: ArrayBuffer): Float32Array {
  const u = new Uint16Array(buf, 0, buf.byteLength >> 1);
  const out = new Float32Array(u.length);
  for (let k = 0; k < u.length; k++) {
    const h = u[k];
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    out[k] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return out;
}
