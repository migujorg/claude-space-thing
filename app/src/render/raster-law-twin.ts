// CPU investigation only. Transcribed from render-law-twins.test.ts at ef12c65.
// Every WGSL scalar operation rounds to f32; GPU fusion/transcendentals are not emulated.
import type { ResolvedLaw } from './spatial';

// Numerical guard variants are for one-at-a-time attribution only; the default is the shader.
const shaderGuards = {
  hFloor: 1e-6, cotFloor: 1e-6, expFloor: -80, psiCut: Math.PI - 1e-4,
  psiDen: 1e-6, bcCut: 1e-6, hcMissing: 1e9,
  akimovEps: 1e-4, akimovFloor: 1e-20, minnaertFloor: 1e-3, barkstromFloor: 1e-3, akimovStable: false, bcStable: true,
};
type Guards = typeof shaderGuards;

/** Line-for-line LAW_WGSL helpers; a/s/m/d preserve left-to-right f32 arithmetic. */
export function rasterShaderLaw(law: ResolvedLaw, guards: Partial<Guards> = {}, round = Math.fround) {
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
      case 7: return d(pow(d(m(mu0, mu), a(mu0, mu)), l0[1]), max(mu, G.barkstromFloor));
      default: return mu0;
    }
  };
}
