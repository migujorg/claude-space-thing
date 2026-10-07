import { afterEach, describe, expect, it, vi } from 'vitest';

const lib = await import(/* @vite-ignore */ '../scripts/e2e-lib.mjs' as string);
const samples = (prep = 1.6) => Array.from({ length: 60 }, () => ({ cpuPrepMs: prep, cpuFrameMs: 4, frameMs: 10 }));
const scene = (prep = 1.6, readyMs = 7932) => ({ id: 'pluto-charon', readyMs, timings: lib.summarizeFrameTimings(samples(prep)) });

afterEach(() => vi.unstubAllGlobals());

describe('scene frame cost measurements', () => {
  it('samples a fixed number of animation frames and keeps snapshots of the live renderer stats', async () => {
    const stats = { cpuPrepMs: 0, cpuFrameMs: 0, frameMs: 0, gpuFrameMs: 0, starsDrawn: 0 };
    vi.stubGlobal('window', { __app: { debugState: () => ({ renderer: stats }) } });
    let frame = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      frame++;
      Object.assign(stats, { cpuPrepMs: frame, cpuFrameMs: frame * 2, frameMs: frame * 3, gpuFrameMs: frame * 0.5, starsDrawn: frame % 2 });
      cb(frame);
      return frame;
    });
    const result = await lib.pageFrameSamples({ frames: 60, starFrames: 16, timeoutMs: 1000 });
    expect(frame).toBe(60);
    expect(result.starsDrawnFrames).toEqual([0, 1]);
    const timings = lib.summarizeFrameTimings(result.samples);
    expect(timings.frames).toBe(60);
    expect(timings.cpuPrepMs).toEqual({ samples: 60, median: 30.5, max: 60 });
    expect(timings.cpuFrameMs).toEqual({ samples: 60, median: 61, max: 120 });
    expect(timings.frameMs).toEqual({ samples: 60, median: 91.5, max: 180 });
    expect(timings.gpuFrameMs).toEqual({ samples: 60, median: 15.25, max: 30 });
  });

  it('reports unavailable GPU time as null and ignores invalid samples without inventing zero', () => {
    const timings = lib.summarizeFrameTimings([...samples(), { cpuPrepMs: NaN, cpuFrameMs: -1, gpuFrameMs: Infinity }]);
    expect(timings.cpuPrepMs).toEqual({ samples: 60, median: 1.6, max: 1.6 });
    expect(timings.gpuFrameMs).toEqual({ samples: 0, median: null, max: null });
  });

  it('fails a scene with the measured regression, naming the scene, value and absolute ceiling', () => {
    const result = lib.checkSceneTimings(scene(758), null, 'hardware');
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(['pluto-charon: median cpuPrepMs 758 ms > 50 ms ceiling (60 animation frames)']);
    expect(lib.checkSceneTimings(scene(758), null, 'swiftshader').pass).toBe(false);
    expect(lib.checkSceneTimings(scene(758), { readyMs: 8000 }, 'hardware').pass).toBe(false);
  });

  it('allows normal load, a single slow frame and the boundary; does not gate maximum or CPU/GPU total', () => {
    const normal = scene();
    normal.timings = lib.summarizeFrameTimings([...samples().slice(1), { cpuPrepMs: 1007, cpuFrameMs: 2000, frameMs: 3000 }]);
    expect(lib.checkSceneTimings(normal, null, 'hardware')).toEqual({ pass: true, failures: [], warnings: [] });
    expect(lib.checkSceneTimings(scene(50), null, 'hardware').pass).toBe(true);
    expect(lib.checkSceneTimings(scene(50.1), null, 'hardware').pass).toBe(false);
  });

  it('reports slow readiness as a WARNING with baseline numbers, without failing', () => {
    const result = lib.checkSceneTimings(scene(1.4, 18047), { readyMs: 6757 }, 'hardware');
    expect(result.pass).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/WARNING pluto-charon: readyMs 18047 ms.*baseline 6757 ms.*2\.67×/);
    expect(lib.checkSceneTimings(scene(1, 5685), { readyMs: 5500 }, 'hardware').warnings).toEqual([]);
    expect(lib.checkSceneTimings(scene(1, 10000), { readyMs: 3000 }, 'hardware').warnings).toHaveLength(1);
    expect(lib.checkSceneTimings(scene(1, 18047), null, 'hardware').warnings[0]).toMatch(/baseline unavailable/);
    expect(lib.checkSceneTimings(scene(1, 86000), null, 'swiftshader').warnings).toEqual([]);
  });

  it('fails missing CPU instrumentation rather than silently passing a performance check', () => {
    expect(lib.checkSceneTimings({ id: 'mars-map', timings: lib.summarizeFrameTimings([]) }, null, 'hardware').failures.join('\n')).toMatch(/mars-map.*cpuPrepMs.*unavailable/);
  });

  it('prints readiness and each timing median/maximum in the per-scene table', () => {
    const measured = scene();
    measured.timings.gpuFrameMs = { samples: 60, median: 2, max: 3 };
    const table = lib.statsTable([measured]);
    expect(table).toMatch(/ready ms.*CPU prep med ms.*CPU prep max ms.*CPU frame med ms.*CPU frame max ms.*GPU med ms.*GPU max ms/);
    expect(table.split('\n')[2]).toMatch(/pluto-charon\s+7932\s+1\.6\s+1\.6\s+4\s+4\s+2\s+3/);
    expect(lib.statsTable([scene()]).split('\n')[2]).toMatch(/\snone\s+none\s/);
  });

  it('accepts comparable stats but keeps frame timings out of the baseline', () => {
    const measured = { ...scene(), query: 'q', stats: { starsDrawn: 1 } };
    const baseline = lib.mergeBaseline(null, [measured], { acceptedAt: 'now' }, [measured.id]);
    expect(baseline.scenes[measured.id].readyMs).toBe(7932); // advisory comparison only
    expect(baseline.scenes[measured.id]).not.toHaveProperty('timings');
  });
});
