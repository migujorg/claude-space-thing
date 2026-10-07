// CPU float32 transcription of the scattering-angle site, not a GPU execution.
// Pin both recognized expressions so a shader edit cannot silently detach the twin.
import { describe, expect, it } from 'vitest';
import { ANGLE_WGSL } from '../src/render/shaders-m2';
import type { V3 } from '../src/render/sky/zodiacal';

const fs: { readFileSync(p: URL, enc: 'utf8'): string } = await import(/* @vite-ignore */ 'node:fs' as string);
const source = fs.readFileSync(new URL('../src/render/sky/zodiacal.ts', import.meta.url), 'utf8');
const site = source.match(/fn zodiF\([\s\S]*?\n}/)![0];
const legacy = site.includes('zodiPhase(acos(clamp(cosT, -1.0, 1.0)))');
const f = Math.fround;
const mul = (a: number, b: number) => f(a * b);
const dot = (a: V3, b: V3) => f(f(mul(a[0], b[0]) + mul(a[1], b[1])) + mul(a[2], b[2]));
const length = (a: V3) => f(Math.sqrt(dot(a, a)));
function pair(x: V3, d: V3) {
  const a = x.map(v => f(-v)) as V3, b = d.map(f) as V3;
  const cross: V3 = [f(mul(a[1], b[2]) - mul(a[2], b[1])), f(mul(a[2], b[0]) - mul(a[0], b[2])), f(mul(a[0], b[1]) - mul(a[1], b[0]))];
  return { a, b, sine: length(cross), cosine: dot(a, b) };
}
function scatteringAngle(x: V3, d: V3) {
  const p = pair(x, d);
  return legacy ? f(Math.acos(Math.max(-1, Math.min(1, f(p.cosine / length(p.a)))))) : f(Math.atan2(p.sine, p.cosine));
}

describe('zodiacal float32 scattering angle', () => {
  it('pins the scattering site and its already-included helper', () => {
    expect(site).toBe('fn zodiF(obs: vec3f, d: vec3f, s: f32, earthLon: f32) -> f32 {\n  let x = obs + s * d;\n  let r = length(x);\n  return zodiDensity(x, earthLon) * zodiPhase(vectorAngle(-x, d)) / (r * r);\n}');
    expect(ANGLE_WGSL).toBe('\nfn vectorAngle(a: vec3f, b: vec3f) -> f32 {\n  return atan2(length(cross(a, b)), dot(a, b));\n}\n');
    const caller = fs.readFileSync(new URL('../src/render/sky/background.ts', import.meta.url), 'utf8');
    expect(caller).toContain('COMMON + ANGLE_WGSL + zodiacalWgsl(m)');
  });
  for (const degrees of [1e-5, 1e-4, 1e-3, 1e-2]) for (const opposite of [false, true]) {
    it(`${degrees}° from ${opposite ? '180°' : '0°'}: relative angle error < 1e-3`, () => {
      const small = degrees * Math.PI / 180, theta = opposite ? Math.PI - small : small;
      // Non-unit x checks the actual scattering geometry: the helper must not require normalization.
      // Axis alignment isolates inversion error from O(1e-7 rad) input-direction quantization.
      const x: V3 = [-2, 0, 0], d: V3 = [Math.cos(theta), Math.sin(theta), 0];
      const got = scatteringAngle(x, d);
      expect(Math.abs(got / theta - 1)).toBeLessThan(1e-3);
      // An f32 angle near pi has ulp 2^-22 rad; its tiny supplement cannot have 0.1% relative precision.
      // Check half an output ulp there and the transverse signal's relative precision separately.
      expect(Math.abs(got - theta)).toBeLessThan(opposite ? 2 ** -23 : small * 1e-3);
      expect(Math.abs(pair(x, d).sine / (2 * Math.sin(small)) - 1)).toBeLessThan(1e-3);
    });
  }
});
