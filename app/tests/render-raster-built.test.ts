import { expect, it } from 'vitest';
import type { BodyPhotometry, SpatialPhotometricModel } from '../src/data/schema';
import { LAMBERT_LAW, LAW, lawDiskIntegral, resolveLaw } from '../src/render/spatial';
import { publishedRadf, rasterDisk, sliverCosine, type RasterRule } from '../src/render/raster-disk';

const fs: { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string; writeFileSync(p: string, v: string): void } =
  await import(/* @vite-ignore */ 'node:fs' as string);
const { env }: { env: Record<string, string | undefined> } = await import(/* @vite-ignore */ 'node:process' as string);
const photPath = new URL('../public/data/photometry.json', import.meta.url);
const bodiesPath = new URL('../public/data/bodies.json', import.meta.url);
const built = fs.existsSync(photPath) && fs.existsSync(bodiesPath);
const photometry: Record<string, BodyPhotometry> = built ? JSON.parse(fs.readFileSync(photPath, 'utf8')) : {};
const bodies: { id: number; name: string }[] = built ? JSON.parse(fs.readFileSync(bodiesPath, 'utf8')) : [];
const models = Object.entries(photometry).filter(([, p]) => p.spatialModel?.value != null)
  .map(([id, p]) => ({ id, name: bodies.find(b => String(b.id) === id)!.name, model: p.spatialModel!.value! }));
const examples: { id: string; name: string; model: SpatialPhotometricModel }[] = [
  { id: 'test-lambert', name: 'Lambert assumption', model: { kind: 'lambert' } },
  { id: 'test-ls', name: 'LS test law (no built model)', model: { kind: 'lommel-seeliger' } },
  { id: 'test-ll', name: 'lunar-Lambert test L=0.4 (no built model)', model: { kind: 'lunar-lambert', L: 0.4 } },
];
// Akimov bodies have identical parameters; evaluate once, keep all IDs in report metadata.
const distinct = [...examples, ...models.filter(m => m.model.kind !== 'akimov' || m.id === '601')];
const phases = [0, 30, 60, 90, 120, 150, 170, 175, 179];
const offsets: [number, number][] = [[0, 0], [0.23, 0.41], [0.5, 0.5]];
const lawAt = (m: SpatialPhotometricModel, alpha: number) => {
  const result = resolveLaw(m, alpha);
  if ('error' in result) throw new Error(result.error);
  return result.law;
};

// Default regression: one built parameter set per scalar kind (Uranus exercises
// Minnaert's k<1 limb), plus the labelled test laws absent from the built product.
// Texel Hapke is dispatched separately and needs mapped-footprint tests, not this scalar matrix.
const representatives = [...examples, ...models.filter((m, i) => m.model.kind === 'minnaert'
  ? m.id === '799'
  : models.findIndex(other => other.model.kind === m.model.kind) === i)];
const regressionPhases = [0, 90, 179];
const regressionOffset: [number, number] = [0.23, 0.41];
const full = env.RASTER_FULL === '1';

it.skipIf(!built)('square-pixel footprints conserve each scalar law kind at R=1 and R=2', () => {
  for (const { model, name } of representatives) for (const phase of regressionPhases) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    const reference = rasterDisk(law, { radius: 1, alpha, rule: 'footprint', pixels: false, order: 96 }).sum;
    // Barkstrom's production CPU integral retains its floor; the reference removes it.
    if (law.kind !== LAW.barkstrom) expect(Math.abs(reference / (Math.PI * lawDiskIntegral(law, alpha)[0]) - 1)).toBeLessThan(1e-4);
    for (const radius of [1, 2]) {
      const frame = rasterDisk(law, { radius, alpha, offset: regressionOffset, rule: 'footprint', order: 32 });
      expect(frame.nonfinite, `${name}, ${phase}, R=${radius}`).toBe(0);
      const witness = frame.interiorWitness!;
      expect(witness.mu).toBeGreaterThan(0);
      expect(witness.mu0).toBeGreaterThan(0);
      expect(frame.maxPixel).toBeLessThanOrEqual(publishedRadf(law, witness.mu0, witness.mu, alpha) * (1 + 1e-4));
      expect(Math.abs(frame.sum / (radius ** 2 * reference) - 1), `${name}, ${phase}, R=${radius}`).toBeLessThan(1e-4);
    }
  }
});

it.skipIf(!built)('Minnaert footprint pixels obey the interior-cosine bound at R=2', () => {
  const model = representatives.find(m => m.model.kind === 'minnaert')!.model;
  for (const phase of regressionPhases) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha), radius = 2;
    const frame = rasterDisk(law, { radius, alpha, offset: regressionOffset, rule: 'footprint', order: 32 });
    const muInterior = sliverCosine(1 / (Math.sqrt(Math.PI) * radius), law.p);
    expect(frame.maxPixel).toBeLessThanOrEqual(publishedRadf(law, 1, muInterior, alpha) * (1 + 1e-4));
  }
});

// The opt-in sweeps add every distinct built parameter set (identical Akimov
// sets once), nine phases/three offsets at R=1,2,4, every integer phase at R=1,
// total-only checks through R=2000, and every built Minnaert bound through R=8.
// Disabled by default to keep the landing suite light; require built products too.
it.skipIf(!built || !full)('actual square-pixel footprint conserves all built laws, including thin crescents (opt-in: RASTER_FULL=1)', async () => {
  for (const { model, name } of distinct) for (const phase of phases) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    const reference = rasterDisk(law, { radius: 1, alpha, rule: 'footprint', pixels: false, order: 96 }).sum;
    for (const radius of [1, 2, 4]) for (const offset of offsets) {
      const frame = rasterDisk(law, { radius, alpha, offset, rule: 'footprint', order: 32 });
      expect(frame.nonfinite, `${name}, ${phase}, R=${radius}`).toBe(0);
      // A positive square-pixel integral is bounded by the largest interior
      // radiance (covered area <= 1); record its cosines instead of a magic cap.
      const witness = frame.interiorWitness!;
      expect(witness.mu).toBeGreaterThan(0);
      expect(witness.mu0).toBeGreaterThan(0);
      expect(frame.maxPixel).toBeLessThanOrEqual(publishedRadf(law, witness.mu0, witness.mu, alpha) * (1 + 1e-4));
      expect(Math.abs(frame.sum / (radius ** 2 * reference) - 1), `${name}, ${phase}, R=${radius}, ${offset}`).toBeLessThan(1e-4);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}, 120000);

it.skipIf(!built || !full)('footprint totals have no radius/offset dependence from R=1 through R=2000 (opt-in: RASTER_FULL=1)', async () => {
  for (const { model } of distinct) for (const phase of phases) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    const reference = rasterDisk(law, { radius: 1, alpha, rule: 'footprint', pixels: false, order: 96 }).sum;
    for (const radius of [1, 2, 4, 8, 16, 32, 63, 128, 512, 2000]) {
      const frame = rasterDisk(law, { radius, alpha, offset: [0.23, 0.41], rule: 'footprint', pixels: false, order: 48 });
      expect(Math.abs(frame.sum / (radius ** 2 * reference) - 1)).toBeLessThan(1e-4);
    }
    // Saturn's reference intentionally removes its old floor; other laws share the production integral.
    if (law.kind !== LAW.barkstrom) expect(Math.abs(reference / (Math.PI * lawDiskIntegral(law, alpha)[0]) - 1)).toBeLessThan(1e-4);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}, 120000);

it.skipIf(!built || !full)('square-pixel integration resolves every integer phase from 0 through 179 degrees (opt-in: RASTER_FULL=1)', async () => {
  for (const { model, name } of distinct) for (let phase = 0; phase <= 179; phase++) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    const reference = rasterDisk(law, { radius: 1, alpha, rule: 'footprint', pixels: false, order: 64 }).sum;
    const frame = rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rule: 'footprint', order: 32 });
    expect(Math.abs(frame.sum / reference - 1), `${name}, ${phase}`).toBeLessThan(1e-4);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}, 120000);

it.skipIf(!built || !full)('Minnaert footprint pixels obey a finite interior-cosine bound without an emission floor (opt-in: RASTER_FULL=1)', async () => {
  for (const { model } of models.filter(m => m.model.kind === 'minnaert')) for (const phase of phases) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    for (const radius of [1, 2, 4, 8]) for (const offset of offsets) {
      const frame = rasterDisk(law, { radius, alpha, offset, rule: 'footprint', order: 32 });
      // Rearrangement inequality: a square's covered area <=1; the outer annulus of
      // area 1 maximises integral mu^(k-1). Incidence mu0^k <=1. Its mean is the
      // law at mu*=sliverCosine(1/(sqrt(pi)*R),k), strictly inside the limb.
      const muInterior = sliverCosine(1 / (Math.sqrt(Math.PI) * radius), law.p);
      expect(frame.maxPixel).toBeLessThanOrEqual(publishedRadf(law, 1, muInterior, alpha) * (1 + 1e-4));
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}, 120000);

it('neither centre-sampling nor the local sliver rule preserves an unresolved 179-degree crescent', () => {
  const law = { ...LAMBERT_LAW, kind: LAW.minnaert, p: 0.788 }, alpha = 179 * Math.PI / 180;
  for (const rule of ['bounded', 'unbounded', 'sliver'] as const) {
    const frame = rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rotation: 0, rule });
    expect(frame.sum).toBe(0);
  }
  expect(rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rule: 'footprint' }).sum).toBeGreaterThan(0);
});

it.skipIf(!built || !env.RASTER_REPORT)('writes the explicit raster sampling matrix (offline CPU only)', async () => {
  const rows: unknown[] = [];
  for (const { id, name, model } of distinct) for (let phase = 0; phase <= 179; phase++) {
    const alpha = phase * Math.PI / 180, law = lawAt(model, alpha);
    const reference = rasterDisk(law, { radius: 1, alpha, rule: 'footprint', pixels: false, order: 64 }).sum;
    const cpuIntegral = Math.PI * lawDiskIntegral(law, alpha)[0];
    for (const radius of (phases.includes(phase) ? [1, 2, 4, 8, 16, 32, 63, 128, ...(phase >= 170 ? [512, 2000] : [])] : [1])) for (const offset of offsets) {
      const errors: Partial<Record<RasterRule, number>> = {}, maxima: Partial<Record<RasterRule, number>> = {};
      for (const rule of ['bounded', 'unbounded', 'sliver'] as const) {
        const frame = rasterDisk(law, { radius, alpha, offset, rule });
        expect(frame.nonfinite).toBe(0);
        errors[rule] = frame.sum / (radius ** 2 * reference) - 1; maxima[rule] = frame.maxPixel;
      }
      const footprint = rasterDisk(law, { radius, alpha, offset, rule: 'footprint', pixels: false, order: 48 });
      errors.footprint = footprint.sum / (radius ** 2 * reference) - 1;
      rows.push({ id, name, kind: model.kind, phase, radius, offset, errors, maxima, cpuIntegralError: cpuIntegral / reference - 1 });
    }
    // Let Vitest deliver task updates during this optional long numerical survey.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  fs.writeFileSync(env.RASTER_REPORT!, JSON.stringify({ initialCommit: 'ef12c65', models, phases: 'all integers 0..179 at R=1; 0,30,60,90,120,150,170,175,179 at R<=128; 170,175,179 at R=512,2000', offsets, geometry: 'f32 orthographic sphere; y rotation 0.37 rad; paired quad derivatives; uniform map; collimated Sun', rows }, null, 2));
}, 1800000);
