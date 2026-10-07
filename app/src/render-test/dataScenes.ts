// Real-data scenes for the renderer test page: the pipeline's products under /data (rings.json,
// photometry.json, light.json, bodies.json, surfaces/) with a synthetic viewing geometry chosen by URL
// parameters. Nothing here describes the universe: every body number is read from the products.
//   scene=rings-data&planet=599|699|799|899&B=obs elevation°&Bsun=Sun elevation°&phase=°&dist=km&fovdeg=°&map=1&et=s (TDB)
//   scene=moon-data&sunlon=Sun selenographic longitude° (east +: waxing)&lib=lat,lon (observer)&rolo=0|1&hapke=0|1 (per-texel law)
//   (both: nomodel=1 drops the reflectance model / disk model to show the not-measured treatment)
//   scene=earth-data&sun=lat,lon (sub-solar)&obs=lat,lon (sub-observer)&dist=km&fovdeg=°&map|clouds|water|night|wind|atm=0
//   scene=atm-data&body=499|299|999|606&sun=lat,lon&obs=lat,lon&dist=km&fovdeg=°&et=s past J2000 (Mars dust season)&map|atm=0
//   (a body drawn from its disk photometry, with its surface maps if any, under its atmosphere; docs/rendering-earth.md §8)

import { LABEL_ORDER, type AtmosphereFile, type Label, type RingsFile, type SurfaceLayerHeader, type Sourced, type LightData, type Body, type PhotometryFile } from '../data/schema';
import type { Mat3, SceneBody, SceneSnapshot, SurfaceLayerRef, Vec3 } from '../render/scene';
import { AU_KM } from '../render/constants';
import { unmeasuredTauPopulation } from '../render/earth';
import { diskModelPPhi, evalPhase, meanRadius, type XYZS } from '../render/photometry';
import { lookAlong, type TestScene } from './scenes';

const DATA = '/data';

async function json<T>(path: string): Promise<T> {
  const r = await fetch(`${DATA}/${path}`);
  if (!r.ok) throw new Error(`${DATA}/${path}: HTTP ${r.status} (build the pipeline products first)`);
  return r.json() as Promise<T>;
}
async function layer(path: string): Promise<SurfaceLayerRef | undefined> {
  const r = await fetch(`${DATA}/${path}`);
  // A missing file may come back as the dev server's HTML fallback.
  if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return undefined;
  return { url: DATA, header: (await r.json()) as SurfaceLayerHeader };
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const rad = (d: number) => (d * Math.PI) / 180;
const radec = (ra: number, dec: number): Vec3 => [Math.cos(rad(dec)) * Math.cos(rad(ra)), Math.cos(rad(dec)) * Math.sin(rad(ra)), Math.sin(rad(dec))];

/** Rotation (row-major, body-fixed → world) taking body +z onto `pole`. */
function poleFrame(pole: Vec3): Mat3 {
  const z = norm(pole);
  const x = norm(cross([0, 0, 1], z).some((v) => Math.abs(v) > 1e-9) ? cross([0, 0, 1], z) : [1, 0, 0]);
  const y = cross(z, x);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

const worse = (a: Label, b: Label): Label => (LABEL_ORDER.indexOf(a) >= LABEL_ORDER.indexOf(b) ? a : b);

interface Products { bodies: Body[]; phot: PhotometryFile; light: LightData }
async function products(): Promise<Products> {
  const [bodies, phot, light] = await Promise.all([json<Body[]>('bodies.json'), json<PhotometryFile>('photometry.json'), json<LightData>('light.json')]);
  return { bodies, phot, light };
}

function sunOf(light: LightData, pos: Vec3): SceneSnapshot['sun'] {
  const s = light.sun;
  if (s.radius.value === null || s.irradianceXYZS_1AU.value === null) throw new Error('light.json: Sun radius or irradiance unknown');
  return {
    pos, radius: s.radius.value, irradianceXYZS_1AU: s.irradianceXYZS_1AU.value,
    limbDarkening: s.limbDarkening.label === 'unknown' || !s.limbDarkening.value ? null : s.limbDarkening.value.coeffsXYZS,
  };
}

function bodyOf(pr: Products, id: number, pos: Vec3, toSun: Vec3, orient: Mat3, extra: Partial<SceneBody> = {}): SceneBody {
  const b = pr.bodies.find((x) => x.id === id)!;
  const ph = pr.phot[String(id)];
  const lab = (s: Sourced<unknown> | undefined): Label => s?.label ?? 'unknown';
  const albedo = ph && ph.geometricAlbedoXYZS.label !== 'unknown' ? ph.geometricAlbedoXYZS.value : null;
  const phase = ph && ph.phaseFunction.label !== 'unknown' ? ph.phaseFunction.value : null;
  return {
    id, name: b.name, pos, toSun, orient, radii: b.radii.value,
    albedoMeasurementView: ph?.albedoMeasurementView?.value ?? null,
    albedoReferenceNormalization: ph?.albedoReferenceNormalization?.value ?? null,
    albedoScaleLabel: ph?.albedoMeasurementView?.label,
    albedoXYZS: albedo, phase, surfaceUnknown: !albedo || !phase,
    worstLabel: [lab(b.radii), lab(ph?.geometricAlbedoXYZS), lab(ph?.phaseFunction), ...(ph?.albedoMeasurementView ? [lab(ph.albedoMeasurementView)] : [])].reduce(worse, 'measured'),
    selected: false, allowPhaseExtrapolation: true, phaseEstimated: !!phase && ph.phaseFunction.label === 'estimated', ...extra,
  };
}

export async function buildDataScene(p: URLSearchParams): Promise<TestScene> {
  const name = p.get('scene');
  const view = { mode: 'eye' as const, exposureBoostStops: 0, overlays: { provenanceTint: p.get('tint') === '1' }, sunShield: p.get('shield') === '1' };
  const noModel = p.get('nomodel') === '1';
  const pr = await products();
  if (name === 'rings-data') {
    const id = Number(p.get('planet') ?? 699);
    const rings = await json<RingsFile>('rings.json');
    const rs = rings[String(id)];
    const rot = pr.bodies.find((x) => x.id === id)!.rotation.value;
    if (!rot) throw new Error(`bodies.json: no rotation (pole) for ${id}`);
    const N = radec(rot.poleRa[0], rot.poleDec[0]);
    const u1 = norm(cross(N, [0, 0, 1]));
    const u2 = cross(N, u1);
    const B = rad(Number(p.get('B') ?? 20)), Bs = rad(Number(p.get('Bsun') ?? 20)), ph = rad(Number(p.get('phase') ?? 5));
    const toObs = add(mul(u1, Math.cos(B)), mul(N, Math.sin(B)));
    const cphi = Math.max(-1, Math.min(1, (Math.cos(ph) - Math.sin(B) * Math.sin(Bs)) / (Math.cos(B) * Math.cos(Bs))));
    const phi = Math.acos(cphi);
    const sunDir = add(mul(add(mul(u1, Math.cos(phi)), mul(u2, Math.sin(phi))), Math.cos(Bs)), mul(N, Math.sin(Bs)));
    const dist = Number(p.get('dist') ?? 600000);
    const pos = mul(toObs, -dist);
    const toSun = mul(sunDir, 9.54 * AU_KM);
    const refl = !noModel && rs.reflectance.label !== 'unknown' ? rs.reflectance.value : null;
    const comps = !noModel && rs.components && rs.components.label !== 'unknown' ? rs.components.value : null;
    const surface = p.get('map') === '1' ? { albedo: await layer(`surfaces/${id}/albedo.json`) } : undefined;
    const body = bodyOf(pr, id, pos, toSun, poleFrame(N), {
      surface,
      rings: p.get('norings') === '1' ? null
        // Ring components (Jupiter, Uranus, Neptune; ringComponents.ts) at TDB seconds `et` (default: the model epoch).
        : comps ? { normal: N, opticalDepth: [], reflectance: null, components: comps, et: p.has('et') ? Number(p.get('et')) : undefined, worstLabel: rs.components!.label }
        : rs.opticalDepth.value ? {
          normal: N, opticalDepth: rs.opticalDepth.value, reflectance: refl,
          worstLabel: worse(rs.opticalDepth.label, refl ? rs.reflectance.label : 'measured'),
        } : null,
    });
    const fwd = mul(toObs, -1);
    const cam = { orient: lookAlong(fwd, N), fovY: rad(Number(p.get('fovdeg') ?? 40)), width: 0, height: 0 };
    const snapshot: SceneSnapshot = { et: 0, camera: cam, sun: sunOf(pr.light, add(pos, toSun)), bodies: [body], view, orbits: [] };
    return { title: `${body.name} rings (REAL DATA) · observer ${p.get('B') ?? 20}°, Sun ${p.get('Bsun') ?? 20}° above the ring plane, phase ${p.get('phase') ?? 5}°`, stars: null, snapshot, realData: true };
  }
  if (name === 'moon-data') {
    const sunLon = Number(p.get('sunlon') ?? 60);
    const [lat, lon] = (p.get('lib') ?? '0,0').split(',').map(Number);
    const bf = (la: number, lo: number): Vec3 => [Math.cos(rad(la)) * Math.cos(rad(lo)), Math.cos(rad(la)) * Math.sin(rad(lo)), Math.sin(rad(la))];
    const toObs = bf(lat, lon);
    const dist = Number(p.get('dist') ?? 384400);
    const pos = mul(toObs, -dist);
    const toSun = mul(bf(0, sunLon), AU_KM);
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const ph = pr.phot['301'];
    const rolo = !noModel && p.get('rolo') !== '0' && ph.diskReflectanceModel && ph.diskReflectanceModel.label !== 'unknown' ? ph.diskReflectanceModel.value : null;
    const [albedo, height, hapke] = await Promise.all([layer('surfaces/301/albedo.json'), layer('surfaces/301/height.json'), layer('surfaces/301/hapke.json')]);
    const body = bodyOf(pr, 301, pos, toSun, I, {
      diskReflectanceModel: rolo,
      surface: p.get('map') === '0' ? undefined : { albedo, height, photometry: p.get('hapke') === '0' ? undefined : hapke },
    });
    if (rolo) body.worstLabel = worse(body.worstLabel, ph.diskReflectanceModel!.label);
    // Disk-integrated illuminance both ways, for the title (Y, lux).
    const R = meanRadius(body.radii!);
    const irr = pr.light.sun.irradianceXYZS_1AU.value as XYZS;
    const toObsKm = mul(toObs, dist);
    const pPhiRolo = ph.diskReflectanceModel ? diskModelPPhi(ph.diskReflectanceModel.value, I, R, toSun, toObsKm, irr) : null;
    const alpha = Math.acos(Math.max(-1, Math.min(1, toObs[0] * bf(0, sunLon)[0] + toObs[1] * bf(0, sunLon)[1] + toObs[2] * bf(0, sunLon)[2])));
    const phi = body.phase ? evalPhase(body.phase, alpha) : null;
    const k = (R / dist) ** 2;
    const eRolo = pPhiRolo ? pPhiRolo[1] * k : NaN;
    const ePhase = phi && phi.ok && body.albedoXYZS ? body.albedoXYZS[1] * phi.phi * k : NaN;
    const fwd = mul(toObs, -1);
    const cam = { orient: lookAlong(fwd, [0, 0, 1]), fovY: rad(Number(p.get('fovdeg') ?? 0.8)), width: 0, height: 0 };
    const snapshot: SceneSnapshot = { et: 0, camera: cam, sun: sunOf(pr.light, add(pos, toSun)), bodies: [body], view, orbits: [] };
    return {
      title: `Moon (REAL DATA) · Sun at selenographic longitude ${sunLon}° (${sunLon > 0 ? 'waxing' : 'waning'}), observer at ${lat}°, ${lon}° · ${rolo ? 'ROLO' : 'phase curve'} · E_Y ROLO ${eRolo.toPrecision(4)} lx, phase curve ${ePhase.toPrecision(4)} lx`,
      stars: null, snapshot, realData: true,
    };
  }
  if (name === 'earth-data') {
    // Earth from its layers (render/earth.ts), body-fixed frame = world frame. Sub-solar and sub-observer
    // points in planetocentric degrees.
    const [sLat, sLon] = (p.get('sun') ?? '-2,0').split(',').map(Number);
    const [oLat, oLon] = (p.get('obs') ?? '10,-20').split(',').map(Number);
    const bf = (la: number, lo: number): Vec3 => [Math.cos(rad(la)) * Math.cos(rad(lo)), Math.cos(rad(la)) * Math.sin(rad(lo)), Math.sin(rad(la))];
    const toObs = bf(oLat, oLon);
    const dist = Number(p.get('dist') ?? 45000);
    const pos = mul(toObs, -dist);
    const toSun = mul(bf(sLat, sLon), AU_KM);
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const [albedo, clouds, water, night, wind, cloudTau, cloudTauEstimated] = await Promise.all(['albedo', 'clouds', 'water', 'night', 'wind', 'cloudTau', 'cloudTauEstimated'].map((l) => layer(`surfaces/399/${l}.json`)));
    const off = (k: string) => p.get(k) === '0';
    const atmFile = off('atm') ? null : await json<AtmosphereFile>('atmospheres.json');
    const atmBody = atmFile?.bodies['399'];
    const body = bodyOf(pr, 399, pos, toSun, I, {
      surface: {
        albedo: off('map') ? undefined : albedo,
        clouds: off('clouds') ? undefined : clouds,
        // estimated=0: the measured thickness alone (as at Strict); else the layer with the provider's estimates, as at Best.
        cloudTau: off('clouds') || off('cloudtau') ? undefined : off('estimated') ? cloudTau : cloudTauEstimated ?? cloudTau,
        // unmeasured=0: the cloud without a retrieval stays unknown (as at Strict).
        cloudTauUnmeasured: off('clouds') || off('cloudtau') || off('unmeasured') ? undefined : unmeasuredTauPopulation(cloudTau?.header) ?? undefined,
        water: off('water') ? undefined : water,
        night: off('night') ? undefined : night,
        wind: off('wind') ? undefined : wind,
      },
      atmosphere: atmFile && atmBody ? {
        wavelengthsNm: atmFile.wavelengthsNm, foldWeights: atmFile.foldWeights.value!, body: atmBody,
        worstLabel: atmBody.components.map((c) => c.extinctionPerKm.label).reduce(worse, 'measured'),
      } : null,
    });
    const fwd = mul(toObs, -1);
    const cam = { orient: lookAlong(fwd, [0, 0, 1]), fovY: rad(Number(p.get('fovdeg') ?? 18)), width: 0, height: 0 };
    const snapshot: SceneSnapshot = { et: 0, camera: cam, sun: sunOf(pr.light, add(pos, toSun)), bodies: [body], view, orbits: [] };
    // comet=behind|front: the TEST FIXTURE comet (tests/fixtures/comet_reference.json: Lemmon's model and heliocentric
    // state, not this scene's geometry), its nucleus cometin° inside Earth's limb (default 1.5) on the side its tail
    // points to on the sky, beyond the Earth (behind: the nucleus hidden, the tail emerging through the atmosphere's
    // limb) or at half the Earth's distance (front); cometd=<km> sets the camera distance instead.
    const cometWhere = p.get('comet');
    let cometModel: TestScene['cometModel'];
    if (cometWhere === 'behind' || cometWhere === 'front') {
      const fx = await (await fetch('/tests/fixtures/comet_reference.json')).json();
      const { activityOf } = await import('../render/comets/model');
      cometModel = fx.model;
      const o = fx.ours[1];
      const th = Math.asin(6378.137 / dist) - rad(Number(p.get('cometin') ?? 1.5));
      const n = mul(fwd, 1);
      // The tail points away from the Sun: its direction on the sky is the heliocentric direction projected.
      const hl = Math.hypot(...(o.helioKm as Vec3));
      const h: Vec3 = [o.helioKm[0] / hl, o.helioKm[1] / hl, o.helioKm[2] / hl];
      const hn = h[0] * n[0] + h[1] * n[1] + h[2] * n[2];
      const ep: Vec3 = [h[0] - hn * n[0], h[1] - hn * n[1], h[2] - hn * n[2]];
      const el = Math.hypot(...ep);
      const e: Vec3 = [ep[0] / el, ep[1] / el, ep[2] / el];
      const u: Vec3 = add(mul(n, Math.cos(th)), mul(e, Math.sin(th)));
      const D = Number(p.get('cometd') ?? (cometWhere === 'behind' ? 0.64 * AU_KM : 0.5 * dist));
      snapshot.comets = [{
        id: -1, name: `${fx.comet.name} (TEST FIXTURE placement)`, rel: mul(u, D), helioPos: o.helioKm, helioVel: o.helioVelKmS,
        M1: fx.comet.M1, K1: fx.comet.K1, totalLabel: 'estimated', activity: activityOf(fx.model, fx.measured), dust: 'longPeriod',
      }];
    }
    const phase = Math.acos(Math.max(-1, Math.min(1, toObs[0] * bf(sLat, sLon)[0] + toObs[1] * bf(sLat, sLon)[1] + toObs[2] * bf(sLat, sLon)[2]))) * 180 / Math.PI;
    return {
      title: `Earth (REAL DATA: surface, clouds, water, night layers) · sub-solar ${sLat}°, ${sLon}° · sub-observer ${oLat}°, ${oLon}° · phase ${phase.toFixed(1)}° · ${dist} km${cometModel ? ` · TEST FIXTURE comet ${cometWhere} the limb` : ''}`,
      stars: null, snapshot, realData: true, cometModel,
    };
  }
  if (name === 'atm-data') {
    const id = Number(p.get('body') ?? 499);
    const [sLat, sLon] = (p.get('sun') ?? '0,0').split(',').map(Number);
    const [oLat, oLon] = (p.get('obs') ?? '0,-30').split(',').map(Number);
    const bf = (la: number, lo: number): Vec3 => [Math.cos(rad(la)) * Math.cos(rad(lo)), Math.cos(rad(la)) * Math.sin(rad(lo)), Math.sin(rad(la))];
    const toObs = bf(oLat, oLon);
    const b0 = pr.bodies.find((x) => x.id === id);
    if (!b0 || !b0.radii.value) throw new Error(`bodies.json: no radii for ${id}`);
    const dist = Number(p.get('dist') ?? 8 * Math.max(...b0.radii.value));
    const pos = mul(toObs, -dist);
    const sunAu = Number(p.get('au') ?? 1.52);
    const toSun = mul(bf(sLat, sLon), sunAu * AU_KM);
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const off = (k: string) => p.get(k) === '0';
    const [albedo, height] = off('map') ? [undefined, undefined] : await Promise.all([layer(`surfaces/${id}/albedo.json`), layer(`surfaces/${id}/height.json`)]);
    const atmFile = off('atm') ? null : await json<AtmosphereFile>('atmospheres.json');
    const atmBody = atmFile?.bodies[String(id)];
    const body = bodyOf(pr, id, pos, toSun, I, {
      surface: albedo || height ? { albedo, height } : undefined,
      atmosphere: atmFile && atmBody ? {
        wavelengthsNm: atmFile.wavelengthsNm, foldWeights: atmFile.foldWeights.value!, body: atmBody,
        worstLabel: atmBody.components.map((c) => c.extinctionPerKm.label).reduce(worse, 'measured'),
      } : null,
    });
    const fwd = mul(toObs, -1);
    const cam = { orient: lookAlong(fwd, [0, 0, 1]), fovY: rad(Number(p.get('fovdeg') ?? 20)), width: 0, height: 0 };
    const et = Number(p.get('et') ?? 844000000);
    const snapshot: SceneSnapshot = { et, camera: cam, sun: sunOf(pr.light, add(pos, toSun)), bodies: [body], view, orbits: [] };
    const phase = Math.acos(Math.max(-1, Math.min(1, toObs[0] * bf(sLat, sLon)[0] + toObs[1] * bf(sLat, sLon)[1] + toObs[2] * bf(sLat, sLon)[2]))) * 180 / Math.PI;
    return {
      title: `${body.name} (REAL DATA${atmBody && atmFile ? ', atmosphere' : ''}) · sub-solar ${sLat}°, ${sLon}° · sub-observer ${oLat}°, ${oLon}° · phase ${phase.toFixed(1)}° · ${dist.toFixed(0)} km · Sun ${sunAu} AU`,
      stars: null, snapshot, realData: true,
    };
  }
  throw new Error(`unknown data scene ${name}`);
}
