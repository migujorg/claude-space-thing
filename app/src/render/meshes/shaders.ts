// WGSL for shape meshes (docs/rendering-shapes.md): the lit mesh into the bodies pass (EXT, W, MASK, depth, like
// the ellipsoids), its sunward depth map for self-shadowing, and the provenance tint overlay.
//
// The body's record (BODY_STRUCT, written by renderer.ts) supplies the photometry: the radiance prefactor K
// (albedo, phase function, spatial-law normalization, resolved fraction), the spatial law, the Sun direction,
// eclipse occluders, ring shadows and planetshine, exactly as for the ellipsoid. The mesh adds its geometry, its
// self-shadowing and the energy normalization (MeshU.info.y).

import { BODY_LIGHT_WGSL, BODY_STRUCT, COMMON } from '../shaders';
import { LAW_WGSL, RING_COMMON } from '../shaders-m2';

/** Per-draw uniform: 13 vec4 (MeshBodies.writeUniform). */
export const MESH_UNIFORM_BYTES = 13 * 16;

const MESH_U = /* wgsl */ `
struct MeshU {
  cam0: vec4f, cam1: vec4f, cam2: vec4f,  // rows: model units → camera coordinates (km); w = translation
  wld0: vec4f, wld1: vec4f, wld2: vec4f,  // rows: model units → world axes, km from the body centre
  lsp0: vec4f, lsp1: vec4f, lsp2: vec4f,  // rows: model units → light space (x, y ∈ [−1, 1], depth ∈ [0, 1]); w = offset
  info: vec4f,    // x = body index, y = energy normalization, z = 1: self-shadow map bound, w = 1: surface not measured (hatch)
  shadow: vec4f,  // x = shadow-map texel (uv units), y = constant depth bias, z = slope bias, w = soft radius (texels)
  tint: vec4f,    // provenance tint (display RGBA, premultiplied by the pass), overlay pass only
  pad: vec4f,
};
`;

export const MESH_SHADER = COMMON + BODY_STRUCT + RING_COMMON + LAW_WGSL + MESH_U + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> rings: array<Ring>;
@group(0) @binding(3) var<storage, read> ringProf: array<vec4f>;
@group(1) @binding(0) var<uniform> U: MeshU;
@group(1) @binding(1) var shadowMap: texture_depth_2d;
@group(1) @binding(2) var shadowSamp: sampler_comparison;
` + BODY_LIGHT_WGSL + /* wgsl */ `
struct MV {
  @builtin(position) pos: vec4f,
  @location(0) pb: vec3f,   // body-relative position, world axes (km)
  @location(1) nw: vec3f,   // vertex normal, world axes
  @location(2) ls: vec3f,   // light-space position (self-shadow map)
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec4f) -> MV {
  var o: MV;
  let c = vec3f(dot(U.cam0.xyz, p) + U.cam0.w, dot(U.cam1.xyz, p) + U.cam1.w, dot(U.cam2.xyz, p) + U.cam2.w);
  // Reversed-Z infinite projection, as the ellipsoids' depthOf: depth = near / (−z).
  o.pos = vec4f(c.x * F.proj.x, c.y * F.proj.y, F.proj.z, -c.z);
  o.pb = vec3f(dot(U.wld0.xyz, p), dot(U.wld1.xyz, p), dot(U.wld2.xyz, p));
  o.nw = vec3f(dot(U.wld0.xyz, n.xyz), dot(U.wld1.xyz, n.xyz), dot(U.wld2.xyz, n.xyz));
  o.ls = vec3f(dot(U.lsp0.xyz, p) + U.lsp0.w, dot(U.lsp1.xyz, p) + U.lsp1.w, dot(U.lsp2.xyz, p) + U.lsp2.w);
  return o;
}

/** Fraction of sunlight reaching a point by the self-shadow map (3×3 percentage-closer filter, bilinear taps). */
fn selfShadow(ls: vec3f, cosSun: f32) -> f32 {
  let uv = vec2f(ls.x * 0.5 + 0.5, 0.5 - ls.y * 0.5);
  let c = clamp(cosSun, 0.05, 1.0);
  let z = ls.z - U.shadow.y - U.shadow.z * sqrt(1.0 - c * c) / c;
  let r = U.shadow.w * U.shadow.x;
  var s = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(f32(i), f32(j)) * r, z);
    }
  }
  return s / 9.0;
}

struct FOut {
  @location(0) ext: vec4f,
  @location(1) w: f32,
  @location(2) mask: f32,
};

@fragment fn fs(in: MV) -> FOut {
  let b = bodies[u32(U.info.x)];
  let posW = in.pb + b.n.xyz * b.n.w;
  let range = length(posW);
  let dirN = posW / range;
  if (occulted(F, dirN)) { discard; }
  let V = -dirN;
  var Ng = normalize(cross(dpdx(in.pb), dpdy(in.pb)));
  if (dot(Ng, V) < 0.0) { Ng = -Ng; }
  var N = normalize(in.nw);
  var L = vec4f(0.0);
  if (b.misc.w > 0.5 && U.info.w < 0.5) {
    let S = b.sun.xyz;
    // The interpolated normal can face away at a silhouette: use the facet's there.
    var mu = dot(N, V);
    if (mu <= 1e-3) { mu = max(dot(Ng, V), 1e-3); }
    let mu0 = dot(N, S);
    if (mu0 > 0.0) {
      let g = vectorAngle(S, V);
      var sh = 1.0;
      if (U.info.z > 0.5) { sh = selfShadow(in.ls, dot(Ng, S)); }
      L = b.rad * U.info.y * lawRadf(mu0, mu, g, b.law0, b.law1, b.law2) * (sunVisible(b, in.pb) * ringShadowT(b, in.pb) * sh);
    }
    // Planetshine (Lambert, measured albedos of both bodies; planetshine.ts), with the same normalization.
    if (b.ps0.w > 0.5) { L += b.psK0 * U.info.y * max(dot(N, b.ps0.xyz), 0.0); }
    if (b.ps1.w > 0.5) { L += b.psK1 * U.info.y * max(dot(N, b.ps1.xyz), 0.0); }
    L *= ringViewT(b, in.pb, dirN, range);
  }
  var o: FOut;
  o.ext = toStore(F, L);
  o.w = b.misc.x;
  o.mask = select(0.0, 1.0, U.info.w > 0.5);
  return o;
}
`;

/** Depth of the mesh seen from the Sun (orthographic), for self-shadowing. */
export const MESH_SHADOW_SHADER = MESH_U + /* wgsl */ `
@group(0) @binding(0) var<uniform> U: MeshU;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return vec4f(dot(U.lsp0.xyz, p) + U.lsp0.w, dot(U.lsp1.xyz, p) + U.lsp1.w, dot(U.lsp2.xyz, p) + U.lsp2.w, 1.0);
}
`;

/** Provenance tint over the visible part of a mesh (display space; depth-tested against the bodies' depth). */
export const MESH_TINT_SHADER = COMMON + MESH_U + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(1) @binding(0) var<uniform> U: MeshU;
@vertex fn vs(@location(0) p: vec3f) -> @builtin(position) vec4f {
  let c = vec3f(dot(U.cam0.xyz, p) + U.cam0.w, dot(U.cam1.xyz, p) + U.cam1.w, dot(U.cam2.xyz, p) + U.cam2.w);
  return vec4f(c.x * F.proj.x, c.y * F.proj.y, F.proj.z, -c.z);
}
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(U.tint.rgb * U.tint.a, U.tint.a);
}
`;
