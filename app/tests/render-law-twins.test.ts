// CPU / shader law investigation, transcription updated deliberately for 08f1a5e. No GPU is executed here.
// Every scalar operation is rounded to f32, including uniforms and transcendentals. This is an
// IEEE single-precision transcription, not a claim about a device's allowed transcendental error,
// fusion, reassociation or denormal handling. The entire LAW_WGSL and its external PI are pinned.
import { describe, expect, it } from 'vitest';
import type { BodyPhotometry, SpatialPhotometricModel } from '../src/data/schema';
import { ANGLE_WGSL, LAW_WGSL, RING_COMMON, RING_SHADER } from '../src/render/shaders-m2';
import { COMMON } from '../src/render/shaders';
import { BODY_SHADER, ATM_BODY_SHADER, EARTH_BODY_SHADER } from '../src/render/shaders';
import { MESH_SHADER } from '../src/render/meshes/shaders';
import { gaussLegendre, LAMBERT_LAW, LAW, lawDiskIntegral, lawRadf, resolveLaw, type ResolvedLaw } from '../src/render/spatial';

// As in core-data.ts, use typed dynamic imports: the app does not require @types/node.
const { createHash }: { createHash(s: string): { update(s: string): { digest(s: string): string } } } =
  await import(/* @vite-ignore */ 'node:crypto' as string);
const fs: { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string } =
  await import(/* @vite-ignore */ 'node:fs' as string);
const { env }: { env: Record<string, string | undefined> } = await import(/* @vite-ignore */ 'node:process' as string);

type Direction = [number, number, number];
/** Float32 vector operations, in WGSL order (including input uniforms). */
function shaderVectorPair(aIn: Direction, bIn: Direction) {
  const f = Math.fround, a = aIn.map(f), b = bIn.map(f);
  const mul = (x: number, y: number) => f(x * y);
  const dot = f(f(mul(a[0], b[0]) + mul(a[1], b[1])) + mul(a[2], b[2]));
  const cross = [
    f(mul(a[1], b[2]) - mul(a[2], b[1])),
    f(mul(a[2], b[0]) - mul(a[0], b[2])),
    f(mul(a[0], b[1]) - mul(a[1], b[0])),
  ];
  const sine = f(Math.sqrt(f(f(mul(cross[0], cross[0]) + mul(cross[1], cross[1])) + mul(cross[2], cross[2]))));
  return { dot, sine };
}
function shaderVectorAngle(a: Direction, b: Direction) {
  const { sine, dot } = shaderVectorPair(a, b);
  return Math.fround(Math.atan2(sine, dot));
}

describe('float32 vector angle', () => {
  it('pins the vector helper independently of the unchanged spatial-law hash', () => {
    expect(ANGLE_WGSL).toBe('\nfn vectorAngle(a: vec3f, b: vec3f) -> f32 {\n  return atan2(length(cross(a, b)), dot(a, b));\n}\n');
    expect(RING_COMMON.startsWith(ANGLE_WGSL)).toBe(true);
    for (const shader of [BODY_SHADER, ATM_BODY_SHADER, EARTH_BODY_SHADER, MESH_SHADER, RING_SHADER(COMMON)]) {
      expect(shader.split('fn vectorAngle(')).toHaveLength(2);
      expect(shader).not.toMatch(/acos\(clamp\(dot\(S, V\)/);
      expect(shader).toContain('vectorAngle(S, V)');
    }
    const sky = fs.readFileSync(new URL('../src/render/sky/background.ts', import.meta.url), 'utf8');
    expect(sky).toContain('COMMON + ANGLE_WGSL + zodiacalWgsl(m)');
    expect(sky).toContain('let eps = vectorAngle(d, Z.sunDir.xyz);');
  });
  for (const degrees of [1e-5, 1e-4, 1e-3, 1e-2]) for (const opposite of [false, true]) {
    it(`${degrees}° ${opposite ? 'from 180°' : 'from zero'}: relative angle error < 1e-3`, () => {
      const small = degrees * Math.PI / 180, trueAngle = opposite ? Math.PI - small : small;
      // Axis aligned unit vectors isolate angle recovery from prior vector quantization.
      // At arbitrary orientations, input f32 directions themselves have O(1e-7 rad) error.
      const a: Direction = [1, 0, 0], b: Direction = [Math.cos(trueAngle), Math.sin(trueAngle), 0];
      const angle = shaderVectorAngle(a, b);
      expect(Math.abs(angle / trueAngle - 1)).toBeLessThan(1e-3);
      // Near pi, the output angle's f32 ulp is 2^-22 rad: it cannot retain the tiny
      // supplement to 0.1%. The cross product still retains it to that accuracy.
      expect(Math.abs(shaderVectorPair(a, b).sine / Math.sin(small) - 1)).toBeLessThan(1e-3);
      expect(Math.abs(angle - trueAngle)).toBeLessThan(opposite ? 2 ** -23 : small * 1e-3);
    });
  }
});

// Numerical guard variants are for one-at-a-time attribution only; the default is the shader.
const shaderGuards = {
  hFloor: 1e-6, cotFloor: 1e-6, expFloor: -80, psiCut: Math.PI - 1e-4,
  psiDen: 1e-6, bcCut: 1e-6, hcMissing: 1e9,
  akimovEps: 1e-4, akimovFloor: 1e-20, minnaertFloor: 1e-3, akimovStable: false, bcStable: true,
};
type Guards = typeof shaderGuards;

/** Line-for-line LAW_WGSL helpers; a/s/m/d preserve left-to-right f32 arithmetic. */
function shaderLaw(law: ResolvedLaw, guards: Partial<Guards> = {}, round = Math.fround) {
  const G = { ...shaderGuards, ...guards };
  const f = round;
  const a = (x: number, y: number) => f(x + y), s = (x: number, y: number) => f(x - y);
  const m = (x: number, y: number) => f(x * y), d = (x: number, y: number) => f(x / y);
  const sin = (x: number) => f(Math.sin(x)), cos = (x: number) => f(Math.cos(x));
  const tan = (x: number) => f(Math.tan(x)), sqrt = (x: number) => f(Math.sqrt(x));
  const exp = (x: number) => f(Math.exp(x)), log = (x: number) => f(Math.log(x));
  const pow = (x: number, y: number) => f(Math.pow(x, y));
  const acos = (x: number) => f(Math.acos(x));
  const max = (x: number, y: number) => Math.max(x, f(y));
  const clamp = (x: number, lo: number, hi: number) => Math.min(f(hi), max(x, lo));
  const PI = f(3.14159265358979);
  const l0 = [law.kind, law.p, law.b, law.c].map(f);
  const l1 = [law.bs0, law.hs, law.bc0, law.hc].map(f);
  const l2 = [law.thetaBar, law.K, law.hFn, 0].map(f);

  function hFn2002(x: number, w: number) {
    const gamma = sqrt(max(s(1, w), 0));
    const r0 = d(s(1, gamma), a(1, gamma));
    const xs = max(x, G.hFloor);
    return d(1, s(1, m(m(w, xs), a(r0, m(m(0.5, s(1, m(m(2, r0), xs))), log(d(a(1, xs), xs)))))));
  }
  function hFn1981(x: number, w: number) {
    const gamma = sqrt(max(s(1, w), 0));
    return d(a(1, m(2, x)), a(1, m(m(2, x), gamma)));
  }
  function doubleHG(g: number, b: number, c: number) {
    const cg = cos(g), b2 = m(b, b);
    return a(d(m(m(0.5, a(1, c)), s(1, b2)), pow(a(s(1, m(m(2, b), cg)), b2), 1.5)),
      d(m(m(0.5, s(1, c)), s(1, b2)), pow(a(a(1, m(m(2, b), cg)), b2), 1.5)));
  }
  const cotf = (x: number) => d(cos(x), max(sin(x), G.cotFloor));
  function hapkeRough(i: number, e: number, psi: number, tb: number) {
    const mu0 = cos(i), mu = cos(e);
    if (tb <= 0) return [mu0, mu, 1];
    const t = tan(tb), chi = d(1, sqrt(a(1, m(m(PI, t), t)))), ct = d(1, t);
    const E1i = exp(max(m(m(d(-2, PI), ct), cotf(i)), G.expFloor));
    const E1e = exp(max(m(m(d(-2, PI), ct), cotf(e)), G.expFloor));
    const E2i = exp(max(m(m(m(m(d(-1, PI), ct), ct), cotf(i)), cotf(i)), G.expFloor));
    const E2e = exp(max(m(m(m(m(d(-1, PI), ct), ct), cotf(e)), cotf(e)), G.expFloor));
    const etai = m(chi, a(cos(i), d(m(m(sin(i), t), E2i), s(2, E1i))));
    const etae = m(chi, a(cos(e), d(m(m(sin(e), t), E2e), s(2, E1e))));
    const s2 = m(sin(m(psi, 0.5)), sin(m(psi, 0.5)));
    // WGSL compares to PI - 1e-4 (a rounded subtraction), not a pre-rounded double constant.
    const fp = psi >= (G.psiCut === shaderGuards.psiCut ? s(PI, f(1e-4)) : f(G.psiCut)) ? 0 : exp(m(-2, tan(m(psi, 0.5))));
    if (i <= e) {
      const den = s(s(2, E1e), m(d(psi, PI), E1i));
      const mu0e = m(chi, a(cos(i), d(m(m(sin(i), t), a(m(cos(psi), E2e), m(s2, E2i))), den)));
      const mue = m(chi, a(cos(e), d(m(m(sin(e), t), s(E2e, m(s2, E2i))), den)));
      const S = d(m(m(d(mue, etae), d(mu0, etai)), chi), a(s(1, fp), m(m(fp, chi), d(mu0, etai))));
      return [mu0e, mue, S];
    }
    const den = s(s(2, E1i), m(d(psi, PI), E1e));
    const mu0e = m(chi, a(cos(i), d(m(m(sin(i), t), s(E2i, m(s2, E2e))), den)));
    const mue = m(chi, a(cos(e), d(m(m(sin(e), t), a(m(cos(psi), E2i), m(s2, E2e))), den)));
    const S = d(m(m(d(mue, etae), d(mu0, etai)), chi), a(s(1, fp), m(m(fp, chi), d(mu, etae))));
    return [mu0e, mue, S];
  }
  function hapkeRadf(mu0: number, mu: number, g: number) {
    const i = acos(clamp(mu0, -1, 1)), e = acos(clamp(mu, -1, 1));
    const den = m(sin(i), sin(e));
    let cpsi = 1;
    if (den > f(G.psiDen)) cpsi = d(s(cos(g), m(mu0, mu)), den);
    const psi = acos(clamp(cpsi, -1, 1));
    const r = hapkeRough(i, e, psi, l2[0]), w = l0[1], tg = tan(m(0.5, g));
    const Bs = l1[1] > 0 ? d(1, a(1, d(tg, l1[1]))) : 0;
    const x = l1[3] > 0 ? d(tg, l1[3]) : f(G.hcMissing);
    // Cancellation-free q: cubic remainder <= x^4/120 for x < 0.01, as in WGSL.
    const q = G.bcStable && x < f(0.01)
      ? s(a(s(1, m(0.5, x)), d(m(x, x), 6)), d(m(m(x, x), x), 24))
      : d(s(1, exp(-x)), x);
    const Bc = x > f(G.bcCut) ? d(a(1, q), m(m(2, a(1, x)), a(1, x))) : 1;
    let H = m(hFn2002(d(r[0], l2[1]), w), hFn2002(d(r[1], l2[1]), w));
    if (l2[2] > 0.5) H = m(hFn1981(d(r[0], l2[1]), w), hFn1981(d(r[1], l2[1]), w));
    return m(m(m(d(m(d(m(l2[1], w), 4), r[0]), a(r[0], r[1])),
      s(a(m(doubleHG(g, l0[2], l0[3]), a(1, m(l1[0], Bs))), H), 1)), a(1, m(l1[2], Bc))), r[2]);
  }
  function akimovDisk(mu0: number, mu: number, gIn: number) {
    const g = clamp(gIn, 0, s(PI, f(1e-4)));
    if (g < f(1e-6)) return 1;
    const gam = f(Math.atan2(s(mu0, m(mu, cos(g))), m(mu, sin(g))));
    const eps = G.akimovStable ? f(Math.atan2(m(mu, sin(g)), s(mu0, m(mu, cos(g))))) : s(m(0.5, PI), gam);
    const k = d(PI, s(PI, g));
    const ratio = eps > f(G.akimovEps) ? d(sin(m(k, eps)), sin(eps)) : k;
    const A = s(mu0, m(mu, cos(g))), B = m(mu, sin(g));
    const cb = G.akimovStable ? clamp(d(sqrt(a(m(A, A), m(B, B))), sin(g)), G.akimovFloor, 1)
      : clamp(d(mu, max(cos(gam), G.akimovFloor)), G.akimovFloor, 1);
    return max(m(m(cos(m(0.5, g)), ratio), pow(cb, d(g, s(PI, g)))), 0);
  }
  return (mu0In: number, muIn: number, gIn: number) => {
    const mu0 = f(mu0In), mu = f(muIn), g = f(gIn);
    if (mu0 <= 0 || mu <= 0) return 0;
    const kind = Math.trunc(a(l0[0], 0.5));
    switch (kind) {
      case 1: return d(mu0, a(mu0, mu));
      case 2: return a(d(m(m(2, l0[1]), mu0), a(mu0, mu)), m(s(1, l0[1]), mu0));
      case 3: return m(pow(mu0, l0[1]), pow(max(mu, G.minnaertFloor), s(l0[1], 1)));
      case 4: return hapkeRadf(mu0, mu, g);
      case 6: return akimovDisk(mu0, mu, g);
      case 7: return d(pow(d(m(mu0, mu), a(mu0, mu)), l0[1]), max(mu, 1e-3));
      default: return mu0;
    }
  };
}

const phaseDeg = [0, 30, 60, 90, 120, 150];
const extendedPhaseDeg = [170, 175, 179];
const microPhaseDeg = [1e-6, 1e-5, 1e-4, 0.001];
const phasesFor = (model: SpatialPhotometricModel) => [...phaseDeg, ...extendedPhaseDeg,
  ...(model.kind === 'hapke' && (model.bc0 ?? 0) > 0 ? microPhaseDeg : [])];
const deg = (d: number) => d * Math.PI / 180;
const photPath = new URL('../public/data/photometry.json', import.meta.url);
const bodiesPath = new URL('../public/data/bodies.json', import.meta.url);
const built = fs.existsSync(photPath) && fs.existsSync(bodiesPath);
const photometry: Record<string, BodyPhotometry> = built ? JSON.parse(fs.readFileSync(photPath, 'utf8')) : {};
const bodies: { id: number; name: string }[] = built ? JSON.parse(fs.readFileSync(bodiesPath, 'utf8')) : [];
const names = new Map(bodies.map(b => [String(b.id), b.name]));
const models = Object.entries(photometry).filter(([, p]) => p.spatialModel?.value != null)
  .map(([id, p]) => ({ id, name: names.get(id) ?? id, model: p.spatialModel!.value! }));
const getLaw = (model: SpatialPhotometricModel, alpha: number) => {
  const resolved = resolveLaw(model, alpha);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.law;
};

/** Independent integration of a scalar law with the same projected-area measure as spatial.ts.
 * A split in emission longitude isolates the 1e-3 limb guards, which n=32 may undersample.
 * Latitude endpoints are also split so polar grazing rays are covered, rather than hidden by GL.
 */
function integrate(radf: (mu0: number, mu: number, g: number) => number, alpha: number, n = 96) {
  const { x, w } = gaussLegendre(n);
  const lo = alpha - Math.PI / 2, hi = Math.PI / 2;
  const lamCuts = [lo, ...[hi - 0.01, hi - 0.001, hi - 0.0001].filter(v => v > lo), hi];
  const betaCuts = [-hi, -hi + 0.001, -hi + 0.01, 0, hi - 0.01, hi - 0.001, hi];
  let cpu = 0;
  for (let j = 1; j < lamCuts.length; j++) for (let k = 1; k < betaCuts.length; k++) {
    const dl = (lamCuts[j] - lamCuts[j - 1]) / 2, db = (betaCuts[k] - betaCuts[k - 1]) / 2;
    for (let p = 0; p < n; p++) {
      const lam = lamCuts[j - 1] + (x[p] + 1) * dl;
      for (let q = 0; q < n; q++) {
        const beta = betaCuts[k - 1] + (x[q] + 1) * db, cb = Math.cos(beta);
        const mu = cb * Math.cos(lam), mu0 = cb * Math.cos(lam - alpha);
        const v = radf(mu0, mu, alpha);
        if (!Number.isFinite(v)) throw new Error(`Nonfinite law at ${mu0}, ${mu}, ${alpha}`);
        cpu += v * mu * cb * w[p] * w[q] * dl * db;
      }
    }
  }
  return cpu / Math.PI;
}

// Akimov recovers longitude/latitude from f32 cosines; at 179 degrees rounding the
// recovered cos(beta) is amplified by g/(pi-g) = 179. The 48/96/384-node signed errors
// are -4.294e-4/-5.935e-4/-3.799e-4. These are bounded passing assertions, not it.fails.
const AKIMOV_F32_CRESCENT_BOUND = 7e-4;
// The shader bounds Minnaert's emission cosine at 1e-3 (see the limb-fragment test below). On a crescent thinner
// than 5 degrees the lit sliver lies at such cosines and the bound costs the disk integral up to this much
// (measured maximum 2.19e-3, Uranus at 179 degrees; below 1e-4 at 170 degrees and under). The bound belongs to
// the limb fragments, not to the law: evaluating those fragments at the mean cosine of their covered sliver
// would remove both it and this allowance (root's backlog, job limb-fragments).
const MINNAERT_BOUND_CRESCENT = 2.5e-3;
const minnaertBoundLimited = (kind: string, phase: number) => kind === 'minnaert' && phase >= 175;

describe('surface law twins', () => {
  it('pins every WGSL helper used by the transcription, and its external PI', () => {
    expect(createHash('sha256').update(LAW_WGSL).digest('hex')).toBe('834affd6f08f33a0c1824972163c28999080e76bde22093de78d8729ede669f5');
    expect(COMMON.match(/const PI: f32 = [^;]+;/)?.[0]).toBe('const PI: f32 = 3.14159265358979;');
  });
  it.skipIf(!built)('has built spatial models to compare (otherwise download/build light first)', () => {
    expect(models.length).toBeGreaterThan(0);
  });
  for (const law of [LAMBERT_LAW, { ...LAMBERT_LAW, kind: LAW.lommelSeeliger },
    { ...LAMBERT_LAW, kind: LAW.lunarLambert, p: 0.4 }]) {
    it(`law code ${law.kind}: smooth-law disk agreement (test parameters, not a product)`, () => {
      for (const phase of phaseDeg) {
        const alpha = deg(phase);
        expect(Math.abs(integrate(shaderLaw(law), alpha, 24) / lawDiskIntegral(law, alpha)[0] - 1)).toBeLessThan(1e-4);
      }
    });
  }
  it.skipIf(!built)('Akimov Mimas at 179°: production quadrature agrees with the float64 reference within 1e-4', () => {
    const model = models.find(m => m.id === '601')!.model;
    const alpha = deg(179), law = getLaw(model, alpha);
    const reference = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, 384);
    const cpuNormalization = lawDiskIntegral(law, alpha, undefined, 32)[0];
    expect(Math.abs(reference / cpuNormalization - 1)).toBeLessThan(1e-4);
  });
  it.skipIf(!built)('Minnaert: the shader law, with its bound on the emission cosine, integrates to the published law', () => {
    for (const { model } of models.filter(m => m.model.kind === 'minnaert')) for (const phase of [...phaseDeg, ...extendedPhaseDeg]) {
      const alpha = deg(phase), law = getLaw(model, alpha);
      const cpu = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, 48);
      expect(Math.abs(integrate(shaderLaw(law), alpha, 48) / cpu - 1)).toBeLessThan(minnaertBoundLimited('minnaert', phase) ? MINNAERT_BOUND_CRESCENT : 1e-4);
      // Without the bound the transcription is the published law at every phase: the allowance above is the bound's alone.
      expect(Math.abs(integrate(shaderLaw(law, { minnaertFloor: 0 }), alpha, 48) / cpu - 1)).toBeLessThan(1e-4);
    }
  });
  // The body pass evaluates the law on limb fragments of partial coverage, where the ray grazes or just misses
  // the surface and the emission cosine is zero up to float32 rounding. Minnaert's mu^(k-1) with k < 1 is
  // integrable over the disk but unbounded at a point: sampled there it drew limb pixels brighter than the disk
  // centre (7 October 2026: 56 pixels of the Uranus validation frame, +1.4 % in its disk flux). The shader bounds
  // the cosine at 1e-3, as it does for Barkstrom.
  it.skipIf(!built)('Minnaert: a limb fragment at a rounding-sized emission cosine is no brighter than at the bound', () => {
    for (const { model } of models.filter(m => m.model.kind === 'minnaert')) {
      const law = getLaw(model, 0), shader = shaderLaw(law), atBound = shader(1, 1e-3, 0);
      for (const mu of [2 ** -149, 2 ** -126, 1e-12, 1e-7, 1e-4]) expect(shader(1, mu, 0)).toBe(atBound);
      expect(shader(1, 2e-3, 0)).toBeLessThan(atBound);
    }
  });
  it.skipIf(!built)('sourced Minnaert emission powers stay finite through the entire positive f32 range', () => {
    for (const { model } of models.filter(m => m.model.kind === 'minnaert')) {
      const law = getLaw(model, 0), shader = shaderLaw(law);
      // Conservative range: actual limb dot products lose relative accuracy long before a
      // subnormal cosine. No emission clipping is needed to avoid overflow for these fits.
      for (const mu of [2 ** -149, 2 ** -126, 1e-7, 1e-3, 1]) {
        expect(Number.isFinite(shader(1, mu, 0))).toBe(true);
        expect(shader(1, mu, 0)).toBeGreaterThan(0);
      }
    }
  });
  it.skipIf(!built)('Charon: cancellation-free Bc evaluation preserves the same analytic expression', () => {
    const model = models.find(m => m.id === '901')!.model;
    for (const phase of microPhaseDeg) {
      const alpha = deg(phase), law = getLaw(model, alpha);
      const cpu = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, 48);
      expect(Math.abs(integrate(shaderLaw(law, { bcStable: true }), alpha, 48) / cpu - 1)).toBeLessThan(1e-4);
    }
  });
  it.skipIf(!built)('Akimov at 179°: f32 coordinate rounding amplified by latitude exponent stays within 7e-4 at three integration resolutions', () => {
    const alpha = deg(179), law = getLaw(models.find(m => m.id === '601')!.model, alpha);
    for (const n of [48, 96, 384]) {
      const cpu = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, n);
      expect(Math.abs(integrate(shaderLaw(law), alpha, n) / cpu - 1)).toBeLessThan(AKIMOV_F32_CRESCENT_BOUND);
    }
  });
  for (const { id, name, model } of models) for (const phase of phasesFor(model)) {
    const limited = model.kind === 'akimov' && phase === 179;
    const bounded = minnaertBoundLimited(model.kind, phase);
    it(`${name} (${id}) ${model.kind} at ${phase}°: ${limited
      ? 'f32 coordinate rounding amplified by the latitude exponent stays within 7e-4'
      : bounded ? 'disk integrals agree within the stated cost of the limb bound, 2.5e-3'
      : 'disk integrals agree within 1e-4'}`, () => {
      const alpha = deg(phase), law = getLaw(model, alpha);
      const cpu = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, 48);
      const gpu = integrate(shaderLaw(law), alpha, 48);
      expect(Math.abs(gpu / cpu - 1)).toBeLessThan(limited ? AKIMOV_F32_CRESCENT_BOUND : bounded ? MINNAERT_BOUND_CRESCENT : 1e-4);
    });
  }
});

// Optional reproducible report; no shared products are written. Run with LAW_TWINS_REPORT=1.
if (env.LAW_TWINS_REPORT) {
  for (const { id, name, model } of models) for (const phase of (
    env.LAW_TWINS_REPORT === 'tiny' ? (model.kind === 'hapke' && (model.bc0 ?? 0) > 0 ? microPhaseDeg : [])
      : env.LAW_TWINS_REPORT === 'akimov-edge' ? (id === '601' ? [179] : []) : phasesFor(model))) {
    it(`reports ${name} at ${phase}°`, async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      const alpha = deg(phase), law = getLaw(model, alpha);
      const n = env.LAW_TWINS_REPORT === 'akimov-edge' ? 384 : 96;
      const cpu = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, n);
      const shader = integrate(shaderLaw(law), alpha, n);
      const doubleShader = integrate(shaderLaw(law, {}, x => x), alpha, n);
      const lowCPU = lawDiskIntegral(law, alpha, undefined, law.kind === LAW.hapke ? 24 : 32)[0];
      let maxRelative = 0, maxAbsolute = 0;
      // Uniform lune grid + logarithmically spaced rays approaching the limb and terminator.
      const lo = alpha - Math.PI / 2, hi = Math.PI / 2;
      const fractions = [...Array.from({ length: 99 }, (_, i) => (i + 1) / 100), ...[1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7].flatMap(x => [x, 1 - x])];
      const radf = shaderLaw(law);
      for (const t of fractions) for (const beta of [0, 30, 60, 80, 89, 89.99]) {
        const lam = lo + t * (hi - lo), cb = Math.cos(deg(beta));
        const mu = cb * Math.cos(lam), mu0 = cb * Math.cos(lam - alpha);
        const c = lawRadf(law, mu0, mu, alpha), s = radf(mu0, mu, alpha);
        maxAbsolute = Math.max(maxAbsolute, Math.abs(s - c));
        if (c > 0) maxRelative = Math.max(maxRelative, Math.abs(s / c - 1));
      }
      const fineRel = shader / cpu - 1;
      const coarseCPU = integrate((mu0, mu, g) => lawRadf(law, mu0, mu, g), alpha, 48);
      const coarseShader = integrate(shaderLaw(law), alpha, 48);
      const variants: Partial<Guards>[] = model.kind === 'hapke' ? [
        { hFloor: 1e-12 }, { cotFloor: 1e-12 }, { expFloor: -700 }, { psiCut: Math.PI },
        { psiDen: 1e-12 }, { bcCut: 1e-9 }, { hcMissing: Infinity },
      ] : model.kind === 'minnaert' ? [{ minnaertFloor: 0 }]
        : model.kind === 'akimov' ? [{ akimovEps: 1e-6 }, { akimovFloor: 1e-300 }] : [];
      const doubleCoarse = integrate(shaderLaw(law, {}, x => x), alpha, 48);
      const attribution = variants.map(guards => {
        const variant = shaderLaw(law, guards, x => x);
        const base = shaderLaw(law, {}, x => x);
        let pointRelative = 0, pointAbsolute = 0;
        for (const t of fractions) for (const beta of [0, 30, 60, 80, 89, 89.99]) {
          const lam = lo + t * (hi - lo), cb = Math.cos(deg(beta));
          const mu = cb * Math.cos(lam), mu0 = cb * Math.cos(lam - alpha);
          const v = variant(mu0, mu, alpha), b = base(mu0, mu, alpha);
          if (v > 0) pointRelative = Math.max(pointRelative, Math.abs(b / v - 1));
          pointAbsolute = Math.max(pointAbsolute, Math.abs(b - v));
        }
        return { guards: Object.fromEntries(Object.entries(guards).map(([key, value]) =>
          [key, typeof value === 'number' && !Number.isFinite(value) ? String(value) : value])), rel: doubleCoarse / integrate(variant, alpha, 48) - 1, pointRelative, pointAbsolute };
      });
      const bcStableRel = model.kind === 'hapke' && (model.bc0 ?? 0) > 0 ? integrate(shaderLaw(law, { bcStable: true }), alpha, 48) / coarseCPU - 1 : null;
      const stableRel = model.kind === 'akimov' ? integrate(shaderLaw(law, { akimovStable: true }), alpha, n) / cpu - 1 : null;

      console.log(JSON.stringify({ id, name, kind: model.kind, phase, n, cpu, shader, rel: fineRel,
        guardRel: doubleShader / cpu - 1, lowCPUrel: lowCPU / cpu - 1,
        quadratureDelta: coarseShader / coarseCPU - 1 - fineRel,
        maxRelative: Number.isFinite(maxRelative) ? maxRelative : 'overflow', maxAbsolute, attribution, stableRel, bcStableRel }));
    }, 30000);
  }
}
