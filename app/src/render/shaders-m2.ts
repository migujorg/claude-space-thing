// WGSL for M2 "true-colour worlds up close" (docs/rendering-m2.md): spatial photometric laws (mirror of
// spatial.ts), surface-map virtual texturing (mirror of surface.ts), height normals and self-shadowing,
// rings (mirror of rings.ts) and the "not measured" gap hatch.

/** Spatial laws (spatial.ts lawRadf). Uses the Body fields law0..law2. */
export const LAW_WGSL = /* wgsl */ `
fn hFn2002(x: f32, w: f32) -> f32 {
  let gamma = sqrt(max(1.0 - w, 0.0));
  let r0 = (1.0 - gamma) / (1.0 + gamma);
  let xs = max(x, 1e-6);
  return 1.0 / (1.0 - w * xs * (r0 + 0.5 * (1.0 - 2.0 * r0 * xs) * log((1.0 + xs) / xs)));
}
fn hFn1981(x: f32, w: f32) -> f32 {
  let gamma = sqrt(max(1.0 - w, 0.0));
  return (1.0 + 2.0 * x) / (1.0 + 2.0 * x * gamma);
}
fn doubleHG(g: f32, b: f32, c: f32) -> f32 {
  let cg = cos(g);
  let b2 = b * b;
  return 0.5 * (1.0 + c) * (1.0 - b2) / pow(1.0 - 2.0 * b * cg + b2, 1.5) + 0.5 * (1.0 - c) * (1.0 - b2) / pow(1.0 + 2.0 * b * cg + b2, 1.5);
}
fn cotf(x: f32) -> f32 { return cos(x) / max(sin(x), 1e-6); }
/** Hapke (1984) roughness: (μ0e, μe, S). */
fn hapkeRough(i: f32, e: f32, psi: f32, tb: f32) -> vec3f {
  let mu0 = cos(i);
  let mu = cos(e);
  if (tb <= 0.0) { return vec3f(mu0, mu, 1.0); }
  let t = tan(tb);
  let chi = 1.0 / sqrt(1.0 + PI * t * t);
  let ct = 1.0 / t;
  let E1i = exp(max(-2.0 / PI * ct * cotf(i), -80.0));
  let E1e = exp(max(-2.0 / PI * ct * cotf(e), -80.0));
  let E2i = exp(max(-1.0 / PI * ct * ct * cotf(i) * cotf(i), -80.0));
  let E2e = exp(max(-1.0 / PI * ct * ct * cotf(e) * cotf(e), -80.0));
  let etai = chi * (cos(i) + sin(i) * t * E2i / (2.0 - E1i));
  let etae = chi * (cos(e) + sin(e) * t * E2e / (2.0 - E1e));
  let s2 = sin(psi * 0.5) * sin(psi * 0.5);
  let fp = select(exp(-2.0 * tan(psi * 0.5)), 0.0, psi >= PI - 1e-4);
  if (i <= e) {
    let d = 2.0 - E1e - psi / PI * E1i;
    let mu0e = chi * (cos(i) + sin(i) * t * (cos(psi) * E2e + s2 * E2i) / d);
    let mue = chi * (cos(e) + sin(e) * t * (E2e - s2 * E2i) / d);
    let S = (mue / etae) * (mu0 / etai) * chi / (1.0 - fp + fp * chi * (mu0 / etai));
    return vec3f(mu0e, mue, S);
  }
  let d = 2.0 - E1i - psi / PI * E1e;
  let mu0e = chi * (cos(i) + sin(i) * t * (E2i - s2 * E2e) / d);
  let mue = chi * (cos(e) + sin(e) * t * (cos(psi) * E2i + s2 * E2e) / d);
  let S = (mue / etae) * (mu0 / etai) * chi / (1.0 - fp + fp * chi * (mu / etae));
  return vec3f(mu0e, mue, S);
}
fn hapkeRadf(mu0: f32, mu: f32, g: f32, l0: vec4f, l1: vec4f, l2: vec4f) -> f32 {
  let i = acos(clamp(mu0, -1.0, 1.0));
  let e = acos(clamp(mu, -1.0, 1.0));
  let den = sin(i) * sin(e);
  var cpsi = 1.0;
  if (den > 1e-6) { cpsi = (cos(g) - mu0 * mu) / den; }
  let psi = acos(clamp(cpsi, -1.0, 1.0));
  let r = hapkeRough(i, e, psi, l2.x);
  let w = l0.y;
  let tg = tan(0.5 * g);
  let Bs = select(0.0, 1.0 / (1.0 + tg / l1.y), l1.y > 0.0);
  let x = select(1e9, tg / l1.w, l1.w > 0.0);
  let Bc = select(1.0, (1.0 + (1.0 - exp(-x)) / x) / (2.0 * (1.0 + x) * (1.0 + x)), x > 1e-6);
  let K = l2.y;
  var H = hFn2002(r.x / K, w) * hFn2002(r.y / K, w);
  if (l2.z > 0.5) { H = hFn1981(r.x / K, w) * hFn1981(r.y / K, w); }
  return K * w / 4.0 * r.x / (r.x + r.y) * (doubleHG(g, l0.z, l0.w) * (1.0 + l1.x * Bs) + H - 1.0) * (1.0 + l1.z * Bc) * r.z;
}
/** Radiance factor of the body's law (up to a constant; the normalization is in the radiance prefactor). */
fn lawRadf(mu0: f32, mu: f32, g: f32, l0: vec4f, l1: vec4f, l2: vec4f) -> f32 {
  if (mu0 <= 0.0 || mu <= 0.0) { return 0.0; }
  let kind = u32(l0.x + 0.5);
  switch kind {
    case 1u: { return mu0 / (mu0 + mu); }
    case 2u: { return 2.0 * l0.y * mu0 / (mu0 + mu) + (1.0 - l0.y) * mu0; }
    case 3u: { return pow(mu0, l0.y) * pow(max(mu, 1e-3), l0.y - 1.0); }
    case 4u: { return hapkeRadf(mu0, mu, g, l0, l1, l2); }
    default: { return mu0; }
  }
}
`;

/**
 * Surface-map virtual texturing (surface.ts): page-table walk with coarse fallback, manual bilinear
 * filtering across tiles, unknown texels (albedo all zero, height NaN) flagged. Needs bindings
 * pageTable, albedoPages, heightPages and the SI uniform.
 */
export const SURFACE_WGSL = /* wgsl */ `
struct SurfInfo { albedoPerRow: u32, heightPerRow: u32, ringCount: u32, pad: u32, cloudsPerRow: u32, rg16PerRow: u32, pad1: u32, pad2: u32 };

fn levelOffset(L: u32) -> u32 { return (((1u << (2u * L)) - 1u) / 3u) * 2u; }

struct PageHit { page: u32, level: u32, x: u32, y: u32 };

/** Finest resident page at or below level L holding texel (x, y) of level L; page = 0 when none. */
fn findPage(base: u32, L: u32, x: u32, y: u32) -> PageHit {
  var l = L;
  var xx = x;
  var yy = y;
  loop {
    let e = pageTable[base + levelOffset(l) + (yy >> 8u) * (2u << l) + (xx >> 8u)];
    if (e != 0u) { return PageHit(e, l, xx, yy); }
    if (l == 0u) { break; }
    l = l - 1u;
    xx = xx >> 1u;
    yy = yy >> 1u;
  }
  return PageHit(0u, 0u, 0u, 0u);
}

fn atlasTexel(page: u32, perRow: u32, x: u32, y: u32) -> vec3i {
  let per2 = perRow * perRow;
  let p = page - 1u;
  let slot = p % per2;
  return vec3i(i32((slot % perRow) * 256u + (x & 255u)), i32((slot / perRow) * 256u + (y & 255u)), i32(p / per2));
}

fn texelOf(L: u32, uv: vec2f) -> vec2u {
  let W = 512u << L;
  let H = 256u << L;
  return vec2u(min(u32(max(uv.x, 0.0) * f32(W)), W - 1u), min(u32(max(uv.y, 0.0) * f32(H)), H - 1u));
}

/** Level to filter at: the finest level ≤ L resident under uv (graceful fallback while tiles load). */
fn residentLevel(base: u32, L: u32, uv: vec2f) -> u32 {
  let t = texelOf(L, uv);
  let h = findPage(base, L, t.x, t.y);
  return select(0u, h.level, h.page != 0u);
}

struct AlbedoSample { m: vec4f, gap: f32 };

/** Relative reflectance M (XYZS) at level L, bilinear; unknown and not-yet-loaded texels count as 1. */
fn sampleAlbedo(base: u32, L: u32, uv: vec2f) -> AlbedoSample {
  let W = 512u << L;
  let H = 256u << L;
  let c = uv * vec2f(f32(W), f32(H)) - 0.5;
  let i0 = vec2i(floor(c));
  let fr = c - vec2f(i0);
  var acc = vec4f(0.0);
  var gap = 0.0;
  for (var k = 0; k < 4; k++) {
    let dx = k & 1;
    let dy = k >> 1;
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1);
    let ix = u32((i0.x + dx + i32(W)) % i32(W));
    let iy = u32(clamp(i0.y + dy, 0, i32(H) - 1));
    let h = findPage(base, L, ix, iy);
    var v = vec4f(1.0);
    if (h.page != 0u) {
      let a = atlasTexel(h.page, SI.albedoPerRow, h.x, h.y);
      let t = textureLoad(albedoPages, a.xy, a.z, 0);
      if (t.x == 0.0 && t.y == 0.0 && t.z == 0.0 && t.w == 0.0) { gap += w; } else { v = t; }
    }
    acc += w * v;
  }
  return AlbedoSample(acc, gap);
}

fn isFiniteF(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }

/** Height (m) at level L, bilinear over known texels; y = known weight (0 → unknown or not loaded). */
fn sampleHeight(base: u32, L: u32, uv: vec2f) -> vec2f {
  let W = 512u << L;
  let H = 256u << L;
  let c = uv * vec2f(f32(W), f32(H)) - 0.5;
  let i0 = vec2i(floor(c));
  let fr = c - vec2f(i0);
  var acc = 0.0;
  var wk = 0.0;
  for (var k = 0; k < 4; k++) {
    let dx = k & 1;
    let dy = k >> 1;
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1);
    let ix = u32((i0.x + dx + i32(W)) % i32(W));
    let iy = u32(clamp(i0.y + dy, 0, i32(H) - 1));
    let h = findPage(base, L, ix, iy);
    if (h.page != 0u) {
      let a = atlasTexel(h.page, SI.heightPerRow, h.x, h.y);
      let t = textureLoad(heightPages, a.xy, a.z, 0).x;
      if (isFiniteF(t)) { acc += w * t; wk += w; }
    }
  }
  return vec2f(select(0.0, acc / wk, wk > 0.0), wk);
}

fn uvOfBf(p: vec3f) -> vec2f {
  let lon = atan2(p.y, p.x);
  let lat = atan2(p.z, length(p.xy));
  return vec2f((lon + PI) / (2.0 * PI), (0.5 * PI - lat) / PI);
}

/** Pyramid level for a surface footprint fp (km) on a body of mean radius R (surface.ts levelForFootprint). */
fn surfLevel(R: f32, fp: f32, maxL: f32) -> u32 {
  return u32(clamp(floor(log2(2.0 * PI * R / (512.0 * max(fp, 1e-9))) + 0.5), 0.0, maxL));
}
`;

/** Ring profile access and physics (rings.ts), plus the disk-overlap helper shared with eclipses. */
export const RING_COMMON = /* wgsl */ `
struct Ring {
  n: vec4f,     // FAR: unit direction to the centre, w = D (km)
  e1: vec4f,    // tangent basis, w = quad half-extent (tan units)
  e2: vec4f,    // w = 1 for the NEAR path
  E1: vec4f,    // D·e1 (km)
  E2: vec4f,    // D·e2 (km)
  o: vec4f,     // camera relative to the centre (km)
  N: vec4f,     // ring-plane normal, w = inner radius (km)
  geo: vec4f,   // outer radius (km), bins, profile base (vec4 index), vec4 slots per bin edge
  sun: vec4f,   // unit direction to the Sun, w = its distance (km)
  esun: vec4f,  // solar illuminance / π at the rings (XYZS) × resolved fraction: radiance per unit I/F
  ph: vec4f,    // reflectance tables base (vec4 index; < 0: reflectance not measured), Sun radius (km), 0, 0
  pm0: vec4f, pm1: vec4f, pm2: vec4f,  // planet world → unit-sphere rows
};

const RING_NODES: u32 = 22u;     // F_lit at k_j = 2·2^(j/2)
const RING_NODES_U: u32 = 44u;   // H_u at m_j = 2^(j/4)
const RING_SLOT_FLIT: u32 = 1u;
const RING_SLOT_HU: u32 = 7u;

fn circleOverlap(r1: f32, r2: f32, d: f32) -> f32 {
  if (d >= r1 + r2) { return 0.0; }
  if (d <= abs(r1 - r2)) { let r = min(r1, r2); return PI * r * r; }
  let a1 = r1 * r1 * acos(clamp((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1), -1.0, 1.0));
  let a2 = r2 * r2 * acos(clamp((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2), -1.0, 1.0));
  let k = 0.5 * sqrt(max((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2), 0.0));
  return a1 + a2 - k;
}

fn ringC(R: Ring, j: u32, slot: u32) -> vec4f {
  return ringProf[u32(R.geo.z) + j * u32(R.geo.w) + slot];
}

/** ∫ of cumulative slot over [x0, x1] (bin units, clamped to the profile), from per-bin increments (rings.ts segment). */
fn ringSeg(R: Ring, slot: u32, x0: f32, x1: f32) -> vec4f {
  let bins = R.geo.y;
  let a = clamp(x0, 0.0, bins);
  let b = clamp(x1, 0.0, bins);
  if (b <= a) { return vec4f(0.0); }
  let j0 = u32(min(floor(a), bins - 1.0));
  let j1 = u32(min(floor(b), bins - 1.0));
  let d0 = ringC(R, j0 + 1u, slot) - ringC(R, j0, slot);
  if (j0 == j1) { return (b - a) * d0; }
  let d1 = ringC(R, j1 + 1u, slot) - ringC(R, j1, slot);
  return (f32(j0) + 1.0 - a) * d0 + (ringC(R, j1, slot) - ringC(R, j0 + 1u, slot)) + (b - f32(j1)) * d1;
}

struct RingAvg { tau: f32, knownTau: f32, knownRefl: f32, A: f32, x0: f32, x1: f32, span: f32 };

/** Footprint means over [ra, rb] (km); outside the ring counts as empty, known space (rings.ts ringAverage). */
fn ringAvg(R: Ring, ra0: f32, rb0: f32) -> RingAvg {
  let bins = R.geo.y;
  let s = bins / (R.geo.x - R.N.w);
  var x0 = (min(ra0, rb0) - R.N.w) * s;
  var x1 = (max(ra0, rb0) - R.N.w) * s;
  // Keep the footprint at least a few float32 ulps wide at this bin index (a zero-width footprint, e.g.
  // a surface point right at the ring plane, would divide 0/0).
  let h = max(5e-6, 4e-7 * max(abs(x0), abs(x1)));
  if (x1 - x0 < 2.0 * h) { let c = 0.5 * (x0 + x1); x0 = c - h; x1 = c + h; }
  let span = max(x1 - x0, 1e-30);
  let v = ringSeg(R, 0u, x0, x1);
  let inside = clamp(x1, 0.0, bins) - clamp(x0, 0.0, bins);
  var o: RingAvg;
  o.tau = max(v.x / span, 0.0);
  o.knownTau = (v.y + (span - inside)) / span;
  o.knownRefl = v.z / span;
  o.A = v.w / span;
  o.x0 = x0;
  o.x1 = x1;
  o.span = span;
  return o;
}

fn ringNode(R: Ring, a: RingAvg, slot: u32, j: u32) -> f32 {
  let v = ringSeg(R, slot + j / 4u, a.x0, a.x1);
  return v[j % 4u] / a.span;
}

fn ringSegOf(n: u32, xN0: f32, step: f32, x: f32) -> u32 {
  return u32(clamp(floor(log2(x / xN0) / step), 0.0, f32(n - 2u)));
}

/** Log-linear interpolation between two nodes; returns (F, dF/dx) (rings.ts interpSeg). */
fn ringInterpSeg(Fa: f32, Fb: f32, xa: f32, xb: f32, x: f32) -> vec2f {
  if (Fa > 1e-30 && Fb > 1e-30) {
    let sl = (log(Fb) - log(Fa)) / (xb - xa);
    let v = Fa * exp(sl * (x - xa));
    return vec2f(v, v * sl);
  }
  let t = clamp((x - xa) / (xb - xa), 0.0, 1.0);
  return vec2f(max(mix(Fa, Fb, t), 0.0), (Fb - Fa) / (xb - xa));
}

/** Tabulated footprint mean at x, nodes at xN0·2^(j·step) (rings.ts interpNodes). */
fn ringInterp(R: Ring, a: RingAvg, slot: u32, n: u32, xN0: f32, step: f32, x: f32) -> f32 {
  let j = ringSegOf(n, xN0, step, x);
  let xa = xN0 * exp2(f32(j) * step);
  return ringInterpSeg(ringNode(R, a, slot, j), ringNode(R, a, slot, j + 1u), xa, xa * exp2(step), x).x;
}

/** ∫ H_u dm over [lo, hi] of the log-linear interpolant (rings.ts integrateNodes). */
fn ringIntegrateHu(R: Ring, a: RingAvg, lo: f32, hi: f32) -> f32 {
  let step = 0.25;
  var j = ringSegOf(RING_NODES_U, 1.0, step, lo);
  var x = lo;
  var total = 0.0;
  var Ha = ringNode(R, a, RING_SLOT_HU, j);
  for (var guard = 0u; guard < RING_NODES_U + 2u; guard++) {
    if (x >= hi) { break; }
    let xa = exp2(f32(j) * step);
    let xb = xa * exp2(step);
    let end = select(min(hi, xb), hi, j >= RING_NODES_U - 2u);
    let Hb = ringNode(R, a, RING_SLOT_HU, j + 1u);
    if (Ha > 1e-30 && Hb > 1e-30) {
      let sl = (log(Hb) - log(Ha)) / (xb - xa);
      if (abs(sl) < 1e-12) { total += Ha * (end - x); }
      else { total += Ha * (exp(sl * (end - xa)) - exp(sl * (x - xa))) / sl; }
    } else {
      let fx = max(Ha + (Hb - Ha) * (x - xa) / (xb - xa), 0.0);
      let fe = max(Ha + (Hb - Ha) * (end - xa) / (xb - xa), 0.0);
      total += 0.5 * (fx + fe) * (end - x);
    }
    x = end;
    if (j < RING_NODES_U - 2u) { j++; Ha = Hb; }
  }
  return total;
}

/** Radial part of the ring I/F (without W) from footprint means (rings.ts ringRadial). */
fn ringRadial(R: Ring, a: RingAvg, mu: f32, mu0: f32, lit: bool) -> f32 {
  if (mu <= 0.0 || mu0 <= 0.0) { return 0.0; }
  if (lit) {
    let F = ringInterp(R, a, RING_SLOT_FLIT, RING_NODES, 2.0, 0.5, 1.0 / mu + 1.0 / mu0);
    return mu0 / (4.0 * (mu + mu0)) * max(a.A - F, 0.0);
  }
  let m1 = 1.0 / mu;
  let m0 = 1.0 / mu0;
  let lo = min(m1, m0);
  let hi = max(m1, m0);
  if (hi - lo < 1e-5 * lo) { return ringInterp(R, a, RING_SLOT_HU, RING_NODES_U, 1.0, 0.25, m1) / (4.0 * mu); }
  return ringIntegrateHu(R, a, lo, hi) / (hi - lo) / (4.0 * mu);
}

fn ringTab(R: Ring, i: u32) -> vec4f { return ringProf[u32(R.ph.x) + i]; }
fn ringGrid(R: Ring, start: u32, i: u32) -> f32 { let v = ringTab(R, start + i / 4u); return v[i % 4u]; }

/** Index and fraction of x on a grid of n nodes (clamped to its ends). */
fn ringGridPos(R: Ring, start: u32, n: u32, x: f32) -> vec2f {
  if (x <= ringGrid(R, start, 0u)) { return vec2f(0.0, 0.0); }
  if (x >= ringGrid(R, start, n - 1u)) { return vec2f(f32(n - 2u), 1.0); }
  var j = 0u;
  for (var i = 1u; i < n - 1u; i++) { if (ringGrid(R, start, i) <= x) { j = i; } }
  let g0 = ringGrid(R, start, j);
  return vec2f(f32(j), (x - g0) / (ringGrid(R, start, j + 1u) - g0));
}

/** W_c = ϖP (XYZS) at radius r, phase α and effective elevation Beff, degrees (rings.ts ringW). */
fn ringW(R: Ring, r: f32, alphaDeg: f32, beffDeg: f32) -> vec4f {
  let h = ringTab(R, 0u);
  let nP = u32(h.x);
  let nE = u32(h.y);
  let nR = u32(h.z);
  let sP = 2u;
  let sE = sP + (nP + 3u) / 4u;
  let sR = sE + (nE + 3u) / 4u;
  let sT = sR + nR;
  let pp = ringGridPos(R, sP, nP, alphaDeg);
  let pe = ringGridPos(R, sE, nE, beffDeg);
  let p0 = u32(pp.x);
  let e0 = u32(pe.x);
  var Wr = array<vec4f, 2>(vec4f(0.0), vec4f(0.0));
  // Region(s) and radial weight.
  var k0 = 0u;
  var k1 = 0u;
  var t = 0.0;
  let first = ringTab(R, sR);
  let last = ringTab(R, sR + nR - 1u);
  if (r >= last.y) { k0 = nR - 1u; k1 = k0; }
  else if (r > first.x) {
    for (var k = 0u; k < nR; k++) {
      let ed = ringTab(R, sR + k);
      if (r <= ed.y) {
        if (r >= ed.x || k == 0u) { k0 = k; k1 = k; }
        else { k0 = k - 1u; k1 = k; let prev = ringTab(R, sR + k - 1u); t = (r - prev.y) / (ed.x - prev.y); }
        break;
      }
    }
  }
  let ks = array<u32, 2>(k0, k1);
  for (var q = 0u; q < 2u; q++) {
    let base = sT + ks[q] * nE * nP;
    let w00 = ringTab(R, base + e0 * nP + p0);
    let w01 = ringTab(R, base + e0 * nP + p0 + 1u);
    let w10 = ringTab(R, base + (e0 + 1u) * nP + p0);
    let w11 = ringTab(R, base + (e0 + 1u) * nP + p0 + 1u);
    Wr[q] = mix(mix(w00, w01, pp.y), mix(w10, w11, pp.y), pe.y);
  }
  return mix(Wr[0], Wr[1], t);
}
`;

/** Rings: analytic ray–plane intersection on a screen quad (FAR) or full screen (NEAR). */
export const RING_SHADER = (COMMON: string) => COMMON + RING_COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> rings: array<Ring>;
@group(0) @binding(2) var<storage, read> ringProf: array<vec4f>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) xy: vec2f,
  @location(1) @interpolate(flat) id: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let R = rings[ii];
  let c = corners[vi];
  var o: VOut;
  o.id = ii;
  if (R.e2.w > 0.5) {
    o.pos = vec4f(c, 0.0, 1.0);
    o.xy = c;
  } else {
    let xy = c * R.e1.w;
    let d = R.n.xyz + xy.x * R.e1.xyz + xy.y * R.e2.xyz;
    let cc = toCam(F, d);
    o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
    o.xy = xy;
  }
  return o;
}

/** Fraction of the solar disk visible from ring point X past the planet (unit-sphere frame angles). */
fn planetShadow(R: Ring, X: vec3f) -> f32 {
  let pp = vec3f(dot(R.pm0.xyz, X), dot(R.pm1.xyz, X), dot(R.pm2.xyz, X));
  let sp = vec3f(dot(R.pm0.xyz, R.sun.xyz), dot(R.pm1.xyz, R.sun.xyz), dot(R.pm2.xyz, R.sun.xyz));
  if (dot(pp, sp) >= 0.0) { return 1.0; }
  let dp = length(pp);
  let rp = asin(min(1.0 / dp, 1.0));
  let sep = angleBetween(-pp / dp, normalize(sp));
  let rs = max(asin(min(R.ph.y / R.sun.w, 1.0)), 1e-7);
  return clamp(1.0 - circleOverlap(rs, rp, sep) / (PI * rs * rs), 0.0, 1.0);
}

struct FOut {
  @location(0) ext: vec4f,
  @location(1) w: f32,
  @location(2) mask: f32,
  @builtin(frag_depth) depth: f32,
};

@fragment fn fs(in: VOut) -> FOut {
  let R = rings[in.id];
  let N = R.N.xyz;
  var X: vec3f;
  var t: f32;
  var dir: vec3f;
  if (R.e2.w > 0.5) {
    dir = worldDirNdc(F, in.xy);
    let dN = dot(dir, N);
    t = -dot(R.o.xyz, N) / select(dN, 1e-30, abs(dN) < 1e-30);
    X = R.o.xyz + t * dir;
  } else {
    let q = in.xy.x * R.E1.xyz + in.xy.y * R.E2.xyz;
    let qN = dot(q, N);
    let den = dot(R.n.xyz, N) + qN / R.n.w;
    let s = -qN / select(den, 1e-30, abs(den) < 1e-30);
    X = s * R.n.xyz + (1.0 + s / R.n.w) * q;
    t = R.n.w + s;
    dir = R.n.xyz + in.xy.x * R.e1.xyz + in.xy.y * R.e2.xyz;
  }
  if (!(t > 0.0) || occulted(F, dir)) { discard; }
  let r = length(X);
  let fw = max(fwidth(r), 1e-3);
  if (r + fw < R.N.w || r - fw > R.geo.x) { discard; }
  let cov = clamp((r - R.N.w) / fw + 0.5, 0.0, 1.0) * clamp((R.geo.x - r) / fw + 0.5, 0.0, 1.0);
  let a = ringAvg(R, r - 0.5 * fw, r + 0.5 * fw);
  let V = -normalize(dir);
  let S = R.sun.xyz;
  let vN = dot(V, N);
  let sN = dot(S, N);
  let mu = abs(vN);
  let mu0 = abs(sN);
  let lit = vN * sN > 0.0;
  let alphaDeg = degrees(acos(clamp(dot(S, V), -1.0, 1.0)));
  var L = vec4f(0.0);
  var reflKnown = false;
  if (R.ph.x >= 0.0) {
    let dom = ringTab(R, 1u);
    if (alphaDeg >= dom.x && alphaDeg <= dom.y) {
      reflKnown = a.knownRefl >= 0.5;
      if (a.knownRefl > 0.0 && mu > 0.0 && mu0 > 0.0) {
        let beff = degrees(asin(clamp(2.0 * mu * mu0 / (mu + mu0), 0.0, 1.0)));
        let W = ringW(R, r, alphaDeg, beff);
        L = W * ringRadial(R, a, mu, mu0, lit) * R.esun * planetShadow(R, X) * cov;
      }
    }
  }
  var o: FOut;
  o.ext = toStore(F, L);
  o.w = 1.0;
  // "Not measured": τ unknown there, or ring material whose reflectance is unknown (no model, phase angle
  // outside its domain, or radii it does not cover).
  let unknown = a.knownTau < 0.5 || (a.tau > 1e-3 && !reflKnown);
  o.mask = select(0.0, cov, unknown);
  o.depth = F.proj.z / max(t * dot(dir, -F.back.xyz), F.proj.z);
  return o;
}
`;

/** Display-space hatch over "not measured" regions of surfaces (map gaps) and rings. */
export const MASK_HATCH_SHADER = /* wgsl */ `
@group(0) @binding(0) var maskTex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let m = textureLoad(maskTex, vec2i(pos.xy), 0).x;
  if (m < 0.5) { discard; }
  let s = fract((pos.x - pos.y) / 10.0);
  let g = select(0.18, 0.55, s < 0.5);
  return vec4f(vec3f(g) * 0.7, 0.7);
}
`;

