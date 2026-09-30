// Exact WGSL literals for numbers computed in float64 on the CPU: an f32 is written as a bitcast of its bits (no
// decimal round trip), a float64 as a double-single pair (hi = nearest f32, lo = nearest f32 of the remainder).

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);

/** WGSL expression for Math.fround(x), exact. */
export function f32(x: number): string {
  f32buf[0] = x;
  const v = f32buf[0];
  if (!Number.isFinite(v)) throw new Error(`wgsl f32 literal: ${x} is not a finite float32`);
  return `bitcast<f32>(${u32buf[0]}u)`;
}

/** [hi, lo] float32 pair with hi + lo = x to ~2^-48 relative. */
export function split64(x: number): [number, number] {
  const hi = Math.fround(x);
  return [hi, Math.fround(x - hi)];
}

/** WGSL vec2f(hi, lo) for a float64. */
export function df(x: number): string {
  const [hi, lo] = split64(x);
  return `vec2f(${f32(hi)}, ${f32(lo)})`;
}

export function f32Array(xs: readonly number[]): string {
  return `array<f32, ${xs.length}>(${xs.map(f32).join(', ')})`;
}

export function dfArray(xs: readonly number[]): string {
  return `array<vec2f, ${xs.length}>(${xs.map(df).join(', ')})`;
}
