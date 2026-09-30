// Scene builders for the renderer test page. All numbers describing bodies come from ./fixtures
// (TEST FIXTURES — NOT DATA); the geometry here is chosen to exercise the renderer.

import type { Mat3, SceneBody, SceneSnapshot, StarCatalog, Vec3 } from '../render/scene';
import { AU_KM } from '../render/constants';
import {
  FIXTURE_LAMBERT, FIXTURE_SUN_IRRADIANCE_1AU, FIXTURE_SUN_LIMB, FIXTURE_SUN_RADIUS_KM,
  fixtureBluishAlbedo, fixtureGreyAlbedo, fixtureStars,
} from './fixtures';

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Camera → ICRF rotation with columns (right, up, back), looking along `fwd`. */
export function lookAlong(fwd: Vec3, upHint: Vec3 = [0, 0, 1]): Mat3 {
  const f = norm(fwd);
  const r = norm(cross(f, upHint));
  const u = cross(r, f);
  const b = mul(f, -1);
  return [r[0], u[0], b[0], r[1], u[1], b[1], r[2], u[2], b[2]];
}

/** Direction at angle `deg` from `a`, rotated toward `toward` (both unit). */
function rotateToward(a: Vec3, toward: Vec3, deg: number): Vec3 {
  const t = norm(add(toward, mul(a, -(a[0] * toward[0] + a[1] * toward[1] + a[2] * toward[2]))));
  const r = (deg * Math.PI) / 180;
  return norm(add(mul(a, Math.cos(r)), mul(t, Math.sin(r))));
}

export interface TestScene {
  snapshot: SceneSnapshot;
  stars: StarCatalog | null;
  title: string;
}

function planet(id: number, name: string, pos: Vec3, toSun: Vec3, radius: number, albedo: SceneBody['albedoXYZS'], extra: Partial<SceneBody> = {}): SceneBody {
  return {
    id, name, pos, toSun, orient: null, radii: [radius, radius, radius],
    albedoXYZS: albedo, phase: FIXTURE_LAMBERT, surfaceUnknown: false, worstLabel: 'estimated', selected: false, ...extra,
  };
}

function sunAt(pos: Vec3, limb = true) {
  return { pos, radius: FIXTURE_SUN_RADIUS_KM, irradianceXYZS_1AU: FIXTURE_SUN_IRRADIANCE_1AU, limbDarkening: limb ? FIXTURE_SUN_LIMB : null };
}

export function buildScene(p: URLSearchParams): TestScene {
  const name = p.get('scene') ?? 'sphere';
  const mode = (p.get('mode') === 'enhanced' ? 'enhanced' : 'eye') as 'eye' | 'enhanced';
  const view = {
    mode,
    exposureBoostStops: Number(p.get('boost') ?? (mode === 'enhanced' ? 4 : 0)),
    overlays: { provenanceTint: p.get('tint') === '1' },
  };
  const fwd: Vec3 = norm([1, 0.3, 0.1]);
  const up: Vec3 = [0, 0, 1];
  const side = norm(cross(fwd, up));
  const deg = (d: number) => (d * Math.PI) / 180;
  const fovOverride = p.get('fov') ? deg(Number(p.get('fov'))) : null;
  const starCount = Number(p.get('stars') ?? 60000);
  const stars = starCount > 0 ? fixtureStars(starCount) : null;
  const cam = (fovY: number) => ({ orient: lookAlong(fwd, up), fovY: fovOverride ?? fovY, width: 0, height: 0 });
  const orbits = p.get('orbits') === '1';
  const phaseDeg = Number(p.get('phase') ?? 60);

  // Planet in front of the camera; Sun direction at the requested phase angle.
  const litPlanet = (dAU: number, distKm: number, radius: number, albedo: SceneBody['albedoXYZS'], extra: Partial<SceneBody> = {}) => {
    const pos = mul(fwd, distKm);
    const toObserver = mul(fwd, -1);
    const sunDir = rotateToward(toObserver, side, phaseDeg);
    const toSun = mul(sunDir, dAU * AU_KM);
    return { body: planet(1, 'Test planet', pos, toSun, radius, albedo, extra), sunPos: add(pos, toSun) };
  };

  const orbitFor = (center: Vec3, r: number) => {
    const pts = new Float64Array(3 * 257);
    const a = norm(cross(up, side)), b = side;
    for (let i = 0; i <= 256; i++) {
      const t = (i / 256) * 2 * Math.PI;
      pts.set(add(center, add(mul(a, r * Math.cos(t)), mul(b, r * Math.sin(t)))), 3 * i);
    }
    return pts;
  };

  switch (name) {
    case 'sun': {
      const sunPos = mul(fwd, AU_KM);
      return {
        title: 'Sun disk from 1 AU (limb darkening, glare)',
        stars,
        snapshot: { et: 0, camera: cam(deg(2)), sun: sunAt(sunPos, p.get('limb') !== '0'), bodies: [], view, orbits: [] },
      };
    }
    case 'stars': {
      const sunPos = mul(fwd, -AU_KM); // behind the observer
      return { title: 'Star field in darkness (Sun behind the observer)', stars, snapshot: { et: 0, camera: cam(deg(60)), sun: sunAt(sunPos), bodies: [], view, orbits: [] } };
    }
    case 'neptune': {
      const dist = Number(p.get('dist') ?? 90000);
      const dau = Number(p.get('dau') ?? 30);
      const { body, sunPos } = litPlanet(dau, dist, 24600, fixtureBluishAlbedo());
      return {
        title: dau === 30 ? 'Dim sphere at 30 AU (adaptation: "Neptune isn\'t dark")' : `Blue-green sphere at ${dau} AU (mesopic/scotopic)`,
        stars,
        snapshot: { et: 0, camera: cam(deg(50)), sun: sunAt(sunPos), bodies: [body], view, orbits: orbits ? [{ id: 1, points: orbitFor([0, 0, 0], dist), selected: true }] : [] },
      };
    }
    case 'unknown': {
      const { body, sunPos } = litPlanet(1, Number(p.get('dist') ?? 20000), 6000, null, { surfaceUnknown: true, worstLabel: 'unknown' });
      return { title: 'Sphere with unknown surface (not-measured hatch)', stars, snapshot: { et: 0, camera: cam(deg(50)), sun: sunAt(sunPos), bodies: [body], view, orbits: [] } };
    }
    case 'eclipse': {
      // A moon between the Sun and the planet casts its shadow (umbra + penumbra) on the planet.
      const dist = 30000;
      const { body, sunPos } = litPlanet(1, dist, 6000, fixtureGreyAlbedo());
      const sunDir = norm(body.toSun);
      const moonPos = add(add(body.pos, mul(sunDir, 60000)), mul(side, -1500));
      const moon = planet(2, 'Test moon', moonPos, add(sunPos, mul(moonPos, -1)), 1700, fixtureGreyAlbedo(0.12));
      return { title: 'Eclipse: moon shadow on the planet', stars, snapshot: { et: 0, camera: cam(deg(40)), sun: sunAt(sunPos), bodies: [body, moon], view, orbits: [] } };
    }
    case 'far': {
      // Same planet receding: resolved → sub-pixel transition without a brightness pop.
      // Heliocentric distance ≫ camera distance keeps the Sun behind the observer (outside the glare field).
      const dist = Number(p.get('dist') ?? 2e7);
      const { body, sunPos } = litPlanet(Number(p.get('dau') ?? 20), dist, 6000, fixtureGreyAlbedo());
      return { title: `Sphere at ${dist} km (resolved/point transition)`, stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 5))), sun: sunAt(sunPos), bodies: [body], view, orbits: [] } };
    }
    case 'sphere':
    default: {
      const dist = Number(p.get('dist') ?? 20000);
      const { body, sunPos } = litPlanet(1, dist, 6000, fixtureGreyAlbedo());
      return {
        title: 'Sunlit grey sphere at 1 AU, phase 60°',
        stars,
        snapshot: { et: 0, camera: cam(deg(50)), sun: sunAt(sunPos), bodies: [body], view, orbits: orbits ? [{ id: 1, points: orbitFor([0, 0, 0], dist), selected: false }] : [] },
      };
    }
  }
}
