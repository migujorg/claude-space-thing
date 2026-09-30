// Scene builders for the renderer test page. All numbers describing bodies come from ./fixtures
// (TEST FIXTURES — NOT DATA); the geometry here is chosen to exercise the renderer.

import type { Mat3, SceneBody, SceneSnapshot, StarCatalog, Vec3 } from '../render/scene';
import { AU_KM } from '../render/constants';
import {
  FIXTURE_LAMBERT, FIXTURE_SUN_IRRADIANCE_1AU, FIXTURE_SUN_LIMB, FIXTURE_SUN_RADIUS_KM,
  fixtureBluishAlbedo, fixtureGreyAlbedo, fixtureStars,
} from './fixtures';
import { FIXTURE_CHECKER, FIXTURE_CRATER_RADIUS_KM, FIXTURE_CRATERS, FIXTURE_HAPKE, fixtureRings } from './fixtures/surfaces';

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

/** Rotation (row-major, body-fixed → world) taking body-fixed unit vector `a` onto world unit vector `b`. */
function rotationTaking(a: Vec3, b: Vec3): Mat3 {
  const v = cross(a, b);
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}
const bfDir = (latDeg: number, lonDeg: number): Vec3 => {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};

export interface TestScene {
  snapshot: SceneSnapshot;
  stars: StarCatalog | null;
  title: string;
  /** Built from the pipeline's products (dataScenes.ts) rather than test fixtures. */
  realData?: boolean;
  /** The comet model for snapshot.comets (Renderer.setCometModel). */
  cometModel?: import('../data/schema').CometModelProduct;
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
    sunShield: p.get('shield') === '1',
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
    case 'offscreen-sun': {
      // The Sun just outside the frame (default 45° from the view axis, horizontally): its CIE 146
      // veil must still light the frame, strongest at the edge nearest the Sun.
      const off = Number(p.get('off') ?? 45);
      const sunPos = mul(rotateToward(fwd, side, off), AU_KM);
      return { title: `Sun ${off}° off-axis, outside the frame (off-screen glare)`, stars, snapshot: { et: 0, camera: cam(deg(50)), sun: sunAt(sunPos), bodies: [], view, orbits: [] } };
    }
    case 'vt': {
      // Virtual texturing: a Moon-sized body with the fixture checker map (and its not-measured gap)
      // turned so the gap faces the camera. Move closer (dist) to load finer levels.
      const R = FIXTURE_CRATER_RADIUS_KM;
      const dist = Number(p.get('dist') ?? 6000);
      const { body, sunPos } = litPlanet(1, dist, R, fixtureGreyAlbedo(0.12), {
        orient: rotationTaking(bfDir(...((p.get('at') ?? '-25,40').split(',').map(Number) as [number, number])), mul(fwd, -1)),
        surface: { albedo: FIXTURE_CHECKER },
      });
      return { title: `Virtual texturing: fixture checker map at ${dist} km`, stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 40))), sun: sunAt(sunPos), bodies: [body], view, orbits: [] } };
    }
    case 'lowsun': {
      // Height map → normals and self-shadowing near the terminator (phase ≈ 85° puts it near the centre).
      const R = FIXTURE_CRATER_RADIUS_KM;
      const dist = Number(p.get('dist') ?? 2600);
      const orient = rotationTaking(bfDir(10, 20), mul(fwd, -1));
      const extra: Partial<SceneBody> = { orient, surface: { height: FIXTURE_CRATERS, ...(p.get('map') === '1' ? { albedo: FIXTURE_CHECKER } : {}) } };
      if (p.get('law') === 'hapke') extra.spatialModel = FIXTURE_HAPKE;
      const { body, sunPos } = litPlanet(1, dist, R, fixtureGreyAlbedo(0.12), extra);
      return { title: `Low Sun on a fixture crater field (height map) at ${dist} km`, stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 30))), sun: sunAt(sunPos), bodies: [body], view, orbits: [] } };
    }
    case 'hapke': {
      // Lambert (left) vs Hapke (right, fixture Moon-like parameters), same albedo and phase: the Hapke
      // disk is flatter (brighter limb) at small phase; both integrate to the same disk brightness.
      const dist = 60000;
      const pos1 = add(mul(fwd, dist), mul(side, -8000));
      const pos2 = add(mul(fwd, dist), mul(side, 8000));
      const sunDir = rotateToward(mul(fwd, -1), side, phaseDeg);
      const toSun = mul(sunDir, AU_KM);
      const a = planet(1, 'Lambert', pos1, toSun, 6000, fixtureGreyAlbedo(0.12));
      // law2=akimov: the parameter-free Akimov disk function on the right instead; law2=barkstrom&B=<exponent>
      // (TEST VALUE): the Barkstrom law.
      const law2 = p.get('law2');
      const B = Number(p.get('B') ?? 0.9);
      const name2 = law2 === 'akimov' ? 'Akimov' : law2 === 'barkstrom' ? `Barkstrom B = ${B}` : 'Hapke';
      const model2: SceneBody['spatialModel'] = law2 === 'akimov' ? { kind: 'akimov' } : law2 === 'barkstrom' ? { kind: 'barkstrom', B } : FIXTURE_HAPKE;
      const b = planet(2, name2, pos2, toSun, 6000, fixtureGreyAlbedo(0.12), { spatialModel: model2 });
      // Adapt to the whole field (both disks), not to the dark gap at the centre.
      const v2 = { ...view, eye: { adaptationFieldDeg: 25 } };
      return { title: `Lambert (left) vs ${name2} (right) at phase ${phaseDeg}°`, stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 25))), sun: sunAt(add(pos1, toSun)), bodies: [a, b], view: v2, orbits: [] } };
    }
    case 'rings': {
      // Saturn-like planet with fixture rings, seen from the lit (default) or unlit face; Sun 12° above
      // the ring plane. The planet shadows the rings and the rings shadow the planet.
      const dist = Number(p.get('dist') ?? 400000);
      const pos = mul(fwd, dist);
      const up2: Vec3 = norm(cross(side, fwd));
      const tilt = deg(Number(p.get('tilt') ?? 20));
      const unlit = p.get('side') === 'unlit';
      // Ring normal tilted toward the camera by `tilt` (lit side) or away from it (unlit side).
      const normal = norm(add(mul(up2, Math.cos(tilt)), mul(fwd, unlit ? Math.sin(tilt) : -Math.sin(tilt))));
      const e = deg(12);
      // Sun azimuth offset from the camera direction (default: phase angle ≈ 20–30°, inside the model's
      // 0.25–47° domain; sunaz=0.8 puts part of the rings beyond 47°, where they are hatched).
      const sunAz = Number(p.get('sunaz') ?? 0.3);
      const sunDir = norm(add(mul(normal, Math.sin(e)), mul(norm(add(mul(fwd, -1), mul(side, sunAz))), Math.cos(e))));
      const toSun = mul(sunDir, 9.5 * AU_KM);
      const orient = rotationTaking([0, 0, 1], normal);
      const body = planet(1, 'Ringed planet', pos, toSun, 60268, fixtureGreyAlbedo(0.34), { radii: [60268, 60268, 54364], orient, rings: fixtureRings(normal, p.get('nomodel') !== '1') });
      return { title: `Rings from the ${unlit ? 'unlit' : 'lit'} face (fixture profiles)`, stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 50))), sun: sunAt(add(pos, toSun)), bodies: [body], view, orbits: [] } };
    }
    case 'earthshine': {
      // A crescent Moon-like body lit on its night side by a gibbous Earth-like body behind the camera.
      const moonDist = Number(p.get('dist') ?? 12000);
      const moonPos = mul(fwd, moonDist);
      const earthPos = mul(fwd, moonDist - 384400);
      const sunDir = rotateToward(mul(fwd, -1), side, Number(p.get('phase') ?? 176)); // Sun just behind the Moon
      const toSun = mul(sunDir, AU_KM);
      const moon = planet(1, 'Moon-like', moonPos, toSun, 1737.4, fixtureGreyAlbedo(0.12));
      const earth = planet(2, 'Earth-like', earthPos, toSun, 6371, fixtureBluishAlbedo());
      return { title: 'Earthshine on a crescent (fixture bodies)', stars, snapshot: { et: 0, camera: cam(deg(Number(p.get('fovdeg') ?? 25))), sun: sunAt(add(moonPos, toSun)), bodies: [moon, earth], view, orbits: [] } };
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
