// Pure helpers of the scene regression suite (scripts/e2e.mjs, app/e2e/README.md): scene URLs, the stats kept
// per scene, the coarse image grid, tiny PNG thumbnails, and the comparison against a committed baseline.
// No browser, no file system: unit-tested in tests/e2e-lib.test.ts.

import { deflateSync, inflateSync } from 'node:zlib';

// ---- scenes --------------------------------------------------------------------------------------------------

/** Query string of a scene: suite defaults under the scene's params (a null param removes a default). */
export function sceneQuery(suite, scene) {
  const p = { ...(suite.defaults ?? {}), ...(scene.params ?? {}) };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined) q.set(k, String(v));
  return q.toString().replace(/%3A/gi, ':');
}

// ---- the browser's WebGPU adapter (--gpu) --------------------------------------------------------------------

/** `--gpu` of e2e.mjs, validate.mjs and shot.mjs: SwiftShader (the default) or the machine's GPU through Vulkan. */
export const GPU_MODES = ['swiftshader', 'hardware'];

/**
 * Options of the Vite server a run starts for itself (createServer({ root, server: runServerOptions() })): a free
 * port, and neither the file watcher nor hot reloading. A run renders the tree as it found it. With the watcher
 * on, a file changing under `public/` (a data product being rebuilt) or `src/` reloads every open page, and the
 * scene being measured is lost ("Execution context was destroyed, most likely because of a navigation").
 */
export function runServerOptions() {
  return { port: 0, strictPort: false, hmr: false, watch: null };
}

/**
 * Chromium arguments for headless WebGPU.
 * - `swiftshader`: the software adapter. Runs anywhere, and is what the committed baseline was accepted on.
 * - `hardware`: Dawn on the system's Vulkan drivers. `--use-angle=vulkan` with `--enable-features=Vulkan` is what
 *   makes the GPU process initialize Vulkan at all (either one alone still gives SwiftShader);
 *   `--disable-vulkan-surface` because a headless browser has no window: without it Chromium asks for a window
 *   surface extension, and vkCreateInstance fails (-7, then a silent fall back to SwiftShader) when the loader is
 *   restricted to a driver that offers none without a display (VK_DRIVER_FILES = the NVIDIA ICD alone).
 *   Measured with Playwright's Chromium 141 headless shell on Linux, NVIDIA 615.71 (app/e2e/README.md).
 */
export function gpuLaunchArgs(mode = 'swiftshader') {
  if (mode === 'swiftshader') return ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
  if (mode === 'hardware') return ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'];
  throw new Error(`--gpu ${mode}: expected ${GPU_MODES.join(' or ')}`);
}

/**
 * Runs in the page (page.evaluate; it must not use anything outside its body): the adapter the app's own request
 * gets (src/render/adapter.ts: high-performance, then the default), or null without WebGPU. Chromium leaves
 * `device` and `description` empty unless developer features are on, so vendor and architecture identify it.
 */
export async function pageAdapterInfo() {
  const gpu = navigator.gpu;
  if (!gpu) return null;
  const a = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await gpu.requestAdapter());
  if (!a) return null;
  const i = a.info ?? {};
  return {
    vendor: i.vendor ?? '', architecture: i.architecture ?? '', device: i.device ?? '', description: i.description ?? '',
    fallback: !!(i.isFallbackAdapter ?? a.isFallbackAdapter),
    float32Blendable: a.features.has('float32-blendable'),
  };
}

/** A software rasterizer? The app asks the same of its device (src/app/sky.ts: a 256² sky cube instead of 512²). */
export function isSoftwareAdapter(info) {
  return !!info && (info.fallback === true || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`));
}

/** "nvidia blackwell (hardware)", "google swiftshader (software)", "none". */
export function adapterLabel(info) {
  if (!info) return 'none';
  const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unnamed adapter';
  return `${name} (${isSoftwareAdapter(info) ? 'software' : 'hardware'})`;
}

/**
 * Why this adapter is not what `--gpu` asked for, or null. Only `hardware` is checked: Chromium falls back to
 * SwiftShader without a word when Vulkan does not initialize or the GPU process keeps crashing, and such a run
 * must not pass for a run on the GPU. (With `swiftshader` the adapter is recorded, as before nothing is required.)
 */
export function gpuMismatch(mode, info) {
  if (mode !== 'hardware') return null;
  if (!info) return '--gpu hardware: the browser has no WebGPU adapter';
  if (isSoftwareAdapter(info)) return `--gpu hardware: the browser's adapter is ${adapterLabel(info)}; Vulkan did not initialize or the GPU process was lost (DEBUG=pw:browser shows the browser's log)`;
  return null;
}

/** The HDR targets of a frame, from the renderer's warnings (it warns when they are the rgba16float fallback). */
export function hdrFormatOf(warnings) {
  return (warnings ?? []).some((w) => w.includes('rgba16float')) ? 'rgba16float' : 'rgba32float';
}

/**
 * A note when a baseline and a run were rendered by different kinds of adapter (a baseline without the record
 * predates `--gpu` and was SwiftShader). Their numbers differ a little by construction: see app/e2e/README.md.
 */
export function gpuNote(baselineGpu, gpu) {
  const was = baselineGpu?.mode ?? 'swiftshader', is = gpu?.mode ?? 'swiftshader';
  if (was === is) return null;
  return `The baseline was accepted on ${was}${baselineGpu?.adapter ? ` (${adapterLabel(baselineGpu.adapter)})` : ''}; this run rendered on ${is}${gpu?.adapter ? ` (${adapterLabel(gpu.adapter)})` : ''}. Differences may come from the adapter.`;
}

/**
 * The baseline after an acceptance. Its header (`acceptedAt`, `git`, `data`, `viewport`, `gpu`) says what the whole
 * suite was last accepted with. When only some scenes are accepted (`--accept --only`), the header stays what it
 * was and each of those scenes records its own acceptance in `accepted`: otherwise the header would claim today's
 * adapter and data build for scenes rendered long before. Scenes no longer in `sceneIds` are dropped.
 */
export function mergeBaseline(prev, results, meta, sceneIds) {
  const whole = sceneIds.every((id) => results.some((r) => r.id === id)) || !prev?.acceptedAt;
  const header = whole ? meta : { acceptedAt: prev.acceptedAt, git: prev.git, data: prev.data, viewport: prev.viewport, ...(prev.gpu ? { gpu: prev.gpu } : {}) };
  const scenes = { ...(prev?.scenes ?? {}) };
  for (const r of results) {
    scenes[r.id] = {
      query: r.query, stats: r.stats, consoleErrors: r.consoleErrors ?? [], readyMs: r.readyMs,
      ...(whole ? {} : { accepted: { acceptedAt: meta.acceptedAt, git: meta.git, data: meta.data, gpu: meta.gpu } }),
    };
  }
  for (const id of Object.keys(scenes)) if (!sceneIds.includes(id)) delete scenes[id];
  return { ...header, scenes };
}

/** What a scene's baseline was accepted with: its own acceptance, or the whole suite's. */
export function sceneAcceptance(baseline, id) {
  return baseline?.scenes?.[id]?.accepted ?? { acceptedAt: baseline?.acceptedAt, git: baseline?.git, data: baseline?.data, gpu: baseline?.gpu };
}

/**
 * Notes for a comparison whose baseline was accepted on another data build or another adapter, per scene (a scene
 * accepted on its own has its own). A note that holds for every compared scene is given once, without their names.
 */
export function acceptanceNotes(baseline, ids, dataInfo, gpu) {
  const by = new Map();
  const add = (text, id) => by.set(text, [...(by.get(text) ?? []), id]);
  for (const id of ids) {
    if (!baseline?.scenes?.[id]) continue;
    const a = sceneAcceptance(baseline, id);
    if (a.data?.manifestSha256 && a.data.manifestSha256 !== dataInfo?.manifestSha256)
      add(`The baseline was accepted on another data build (manifest ${a.data.manifestGeneratedAt}); this run uses ${dataInfo?.manifestGeneratedAt}. Differences may come from the data.`, id);
    const g = gpuNote(a.gpu, gpu);
    if (g) add(g, id);
  }
  const compared = ids.filter((id) => baseline?.scenes?.[id]).length;
  return [...by].map(([text, who]) => (who.length === compared ? text : `${who.join(', ')}: ${text}`));
}

/**
 * Runs in the page: the distinct values `renderer.starsDrawn` takes over `frames` animation frames, ascending.
 * A settled scene whose eye is always adapted (adapt=instant) has one value: every point source in the frame is in
 * the point image, so the veil the stars are judged against does not depend on which stars were drawn the frame
 * before (render/shaders.ts CULL_SHADER). Until that was so, the count alternated between two values on consecutive
 * frames in 9 of the 26 scenes, and a GPU run, whose frames take ~10 ms, read either. A scene whose adaptation runs
 * in real time (adapt=realtime) moves by a few stars as its pigments regenerate.
 */
export async function pageStarsDrawnFrames(frames) {
  const seen = new Set();
  for (let i = 0; i < frames; i++) {
    await new Promise(requestAnimationFrame);
    const n = window.__app?.debugState?.()?.renderer?.starsDrawn;
    if (typeof n === 'number') seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** A note for a scene whose star count was not one number over the sampled frames (`compared`: the one in the stats). */
export function starsFramesNote(values, compared) {
  if (!values || values.length < 2) return null;
  const list = values.length <= 6 ? values.join(', ') : `${values[0]} … ${values[values.length - 1]} (${values.length} values)`;
  return `starsDrawn changes from frame to frame: ${list}; the stats hold ${compared ?? 'none'}`;
}

/**
 * The same as a failure, for a scene whose eye is always adapted (`adapt=instant` in its URL): nothing in such a
 * scene changes between frames, so a count that does means a verdict depends on an earlier frame again. Null for a
 * steady count and for a scene whose adaptation runs in real time.
 */
export function starsFramesFailure(values, compared, query) {
  if (!/(^|&)adapt=instant(&|$)/.test(query ?? '')) return null;
  const note = starsFramesNote(values, compared);
  return note ? `${note} (the eye is always adapted in this scene: the settled frame must be one frame)` : null;
}

// ---- tolerances ----------------------------------------------------------------------------------------------

/** Suite defaults; a scene's `tolerance` in scenes.json overrides any of them. */
export const DEFAULT_TOLERANCE = {
  /** |log10(current / baseline)| for adaptation luminances. */
  adaptationLog10: 0.15,
  pupilMm: 0.3,
  limitingMag: 0.3,
  mesopicM: 0.1,
  /** Relative change of the number of stars drawn. */
  starsRel: 0.05,
  /** Coarse image: mean and largest |ΔL| over the 16×9 grid of display lightness (0..1). */
  gridMeanAbs: 0.06,
  gridMaxAbs: 0.35,
};

// ---- stats kept per scene ------------------------------------------------------------------------------------

/** The comparable stats of one rendered scene, from window.__app.debugState() (renderer stats included). */
export function extractStats(debug) {
  const r = debug?.renderer ?? {};
  // Bodies in the frame (debugState().drawn.inView): those at least a pixel across in full, the others (points and
  // overlay markers, often hundreds of moons behind a planet) compactly as "id:label" (":marker" for markers).
  const inView = [...(debug?.drawn?.inView ?? [])].sort((a, b) => a.id - b.id);
  const bodies = inView.filter((b) => b.px >= 1).map((b) => ({ id: b.id, name: b.name, worstLabel: b.worstLabel ?? 'n/a', surfaceUnknown: !!b.surfaceUnknown }));
  const points = inView.filter((b) => !(b.px >= 1)).map((b) => `${b.id}:${b.worstLabel ?? 'n/a'}${b.marker ? ':marker' : ''}`);
  return {
    adaptationLuminance: num(r.adaptationLuminance),
    scotopicAdaptationLuminance: num(r.scotopicAdaptationLuminance),
    pupilDiameterMm: num(r.pupilDiameterMm),
    mesopicM: num(r.mesopicM),
    limitingMagnitude: num(r.limitingMagnitude),
    starsDrawn: num(r.starsDrawn),
    bodiesDrawn: bodies.length + points.length,
    bodies,
    points,
    /** Everything sent to the renderer this frame, in view or not. */
    bodiesInSnapshot: (debug?.drawn?.bodies ?? []).length,
    sun: !!debug?.drawn?.sun,
    warnings: [...new Set(r.warnings ?? [])].sort(),
    badge: debug?.badge ?? [],
  };
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// ---- coarse image --------------------------------------------------------------------------------------------

export const THUMB_W = 64;
export const THUMB_H = 36;
export const GRID_W = 16;
export const GRID_H = 9;

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Box-average RGBA sRGB bytes (w×h) into THUMB_W×THUMB_H cells, averaging in linear light. Returns linear RGB
 * floats (3 per cell). The page does the same in the browser (scripts/e2e.mjs); this one serves tests.
 */
export function boxLinear(rgba, w, h, tw = THUMB_W, th = THUMB_H) {
  const out = new Float64Array(tw * th * 3);
  const cnt = new Float64Array(tw * th);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / w));
      const i = 4 * (y * w + x), c = ty * tw + tx;
      out[3 * c] += srgbToLinear(rgba[i] / 255);
      out[3 * c + 1] += srgbToLinear(rgba[i + 1] / 255);
      out[3 * c + 2] += srgbToLinear(rgba[i + 2] / 255);
      cnt[c]++;
    }
  }
  for (let c = 0; c < tw * th; c++) for (let k = 0; k < 3; k++) out[3 * c + k] /= Math.max(1, cnt[c]);
  return out;
}

/** Linear RGB cells → 8-bit sRGB RGBA thumbnail. */
export function thumbFromLinear(lin, tw = THUMB_W, th = THUMB_H) {
  const px = new Uint8Array(tw * th * 4);
  for (let c = 0; c < tw * th; c++) {
    for (let k = 0; k < 3; k++) px[4 * c + k] = Math.round(255 * clamp01(linearToSrgb(lin[3 * c + k])));
    px[4 * c + 3] = 255;
  }
  return px;
}

/**
 * GRID_W×GRID_H display lightness (sRGB-encoded relative luminance, 0..1) of an sRGB RGBA thumbnail:
 * luminance averaged in linear light over each block of thumbnail pixels.
 */
export function gridFromThumb(px, tw = THUMB_W, th = THUMB_H) {
  const g = new Array(GRID_W * GRID_H).fill(0);
  const n = new Array(GRID_W * GRID_H).fill(0);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = 4 * (y * tw + x);
      const Y = 0.2126 * srgbToLinear(px[i] / 255) + 0.7152 * srgbToLinear(px[i + 1] / 255) + 0.0722 * srgbToLinear(px[i + 2] / 255);
      const c = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / th)) * GRID_W + Math.min(GRID_W - 1, Math.floor((x * GRID_W) / tw));
      g[c] += Y;
      n[c]++;
    }
  }
  return g.map((s, c) => Math.round(1000 * linearToSrgb(s / Math.max(1, n[c]))) / 1000);
}

// ---- PNG (8-bit RGBA / RGB, non-interlaced): enough for the thumbnails ---------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + 4 * w));
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * 4 * w, 4 * w).copy(raw, y * (1 + 4 * w) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePng(buf) {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG: only 8-bit, non-interlaced');
      ct = data[9];
      if (ct !== 6 && ct !== 2) throw new Error('PNG: only RGB or RGBA');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { width: w, height: h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[4 * i] = px[3 * i]; rgba[4 * i + 1] = px[3 * i + 1]; rgba[4 * i + 2] = px[3 * i + 2]; rgba[4 * i + 3] = 255; }
  return { width: w, height: h, rgba };
}

// ---- comparison ----------------------------------------------------------------------------------------------

const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

/**
 * Compare one scene against its baseline. Returns failures (the scene fails) and notes (changes within
 * tolerance, or improvements such as a warning that went away).
 */
export function compareScene(cur, base, tolerance = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const failures = [], notes = [];
  if (cur.error) failures.push(`did not render: ${cur.error}`);
  if (!cur.stats) return { pass: false, failures: failures.length ? failures : ['no stats (the page did not report its state)'], notes };
  if (!base) return { pass: failures.length === 0, failures, notes: ['no baseline for this scene'] };
  const s = cur.stats, b = base.stats;
  const logRatio = (key) => {
    const x = s[key], y = b[key];
    if (x === null && y === null) return;
    if (x === null || y === null) { failures.push(`${key}: ${fmt(y)} → ${fmt(x)}`); return; }
    if (x <= 0 || y <= 0) { if (x !== y) failures.push(`${key}: ${fmt(y)} → ${fmt(x)}`); return; }
    const d = Math.abs(Math.log10(x / y));
    (d > tol.adaptationLog10 ? failures : d > 0 ? notes : []).push(`${key}: ${fmt(y)} → ${fmt(x)} (Δlog10 ${d.toFixed(3)}, tolerance ${tol.adaptationLog10})`);
  };
  const absDiff = (key, t, unit = '') => {
    const x = s[key], y = b[key];
    if (x === null && y === null) return;
    if (x === null || y === null) { failures.push(`${key}: ${fmt(y)} → ${fmt(x)}`); return; }
    const d = Math.abs(x - y);
    (d > t ? failures : d > 0 ? notes : []).push(`${key}: ${fmt(y)} → ${fmt(x)}${unit} (Δ ${d.toFixed(3)}, tolerance ${t})`);
  };
  logRatio('adaptationLuminance');
  logRatio('scotopicAdaptationLuminance');
  absDiff('pupilDiameterMm', tol.pupilMm, ' mm');
  absDiff('limitingMagnitude', tol.limitingMag, ' mag');
  absDiff('mesopicM', tol.mesopicM);
  if (s.starsDrawn !== null || b.starsDrawn !== null) {
    const x = s.starsDrawn ?? 0, y = b.starsDrawn ?? 0;
    const d = Math.abs(x - y) / Math.max(1, y);
    (d > tol.starsRel ? failures : d > 0 ? notes : []).push(`starsDrawn: ${y} → ${x} (${(100 * d).toFixed(1)}%, tolerance ${(100 * tol.starsRel).toFixed(0)}%)`);
  }
  // Bodies in the frame and what each was drawn from: resolved bodies by name, points and markers by id.
  const bb = new Map(b.bodies.map((x) => [x.id, x])), cb = new Map(s.bodies.map((x) => [x.id, x]));
  const gone = b.bodies.filter((x) => !cb.has(x.id)).map((x) => x.name);
  const added = s.bodies.filter((x) => !bb.has(x.id)).map((x) => x.name);
  if (gone.length) failures.push(`no longer drawn resolved: ${gone.join(', ')}`);
  if (added.length) failures.push(`newly drawn resolved: ${added.join(', ')}`);
  for (const x of s.bodies) {
    const y = bb.get(x.id);
    if (!y) continue;
    if (x.worstLabel !== y.worstLabel) failures.push(`${x.name}: worst label ${y.worstLabel} → ${x.worstLabel}`);
    if (x.surfaceUnknown !== y.surfaceUnknown) failures.push(`${x.name}: surface ${y.surfaceUnknown ? 'unknown' : 'known'} → ${x.surfaceUnknown ? 'unknown' : 'known'}`);
  }
  const bp = new Set(b.points ?? []), cp = new Set(s.points ?? []);
  const pGone = (b.points ?? []).filter((x) => !cp.has(x)), pNew = (s.points ?? []).filter((x) => !bp.has(x));
  const few = (a) => a.slice(0, 8).join(', ') + (a.length > 8 ? ` … (${a.length})` : '');
  if (pGone.length) failures.push(`points/markers gone or changed (id:label): ${few(pGone)}`);
  if (pNew.length) failures.push(`points/markers new or changed (id:label): ${few(pNew)}`);
  if (s.sun !== b.sun) failures.push(`Sun ${b.sun ? 'drawn' : 'not drawn'} → ${s.sun ? 'drawn' : 'not drawn'}`);
  const bw = new Set(b.warnings), cw = new Set(s.warnings);
  for (const w of s.warnings) if (!bw.has(w)) failures.push(`new renderer warning: ${w}`);
  for (const w of b.warnings) if (!cw.has(w)) failures.push(`renderer warning gone (accept the baseline if intended): ${w}`);
  if ((cur.consoleErrors?.length ?? 0) > (base.consoleErrors?.length ?? 0)) failures.push(`console errors ${base.consoleErrors?.length ?? 0} → ${cur.consoleErrors.length}: ${cur.consoleErrors.slice(0, 3).join(' | ')}`);
  // Coarse image.
  if (cur.grid && base.grid) {
    const d = cur.grid.map((x, i) => Math.abs(x - base.grid[i]));
    const dm = mean(d), dx = Math.max(...d);
    const mc = mean(cur.grid), mb = mean(base.grid);
    if (mb > 0.05 && mc < 0.1 * mb) failures.push(`image went black (mean lightness ${mb.toFixed(3)} → ${mc.toFixed(3)})`);
    else if (mb < 0.8 && mc > 0.95) failures.push(`image went white (mean lightness ${mb.toFixed(3)} → ${mc.toFixed(3)})`);
    if (dm > tol.gridMeanAbs) failures.push(`image: mean |ΔL| ${dm.toFixed(3)} > ${tol.gridMeanAbs}`);
    if (dx > tol.gridMaxAbs) failures.push(`image: largest |ΔL| ${dx.toFixed(3)} > ${tol.gridMaxAbs} (cell ${d.indexOf(dx) % GRID_W},${Math.floor(d.indexOf(dx) / GRID_W)})`);
    if (dm > 0 && dm <= tol.gridMeanAbs && dx <= tol.gridMaxAbs) notes.push(`image: mean |ΔL| ${dm.toFixed(3)}, largest ${dx.toFixed(3)}`);
  } else if (base.grid && !cur.grid) failures.push('no image to compare');
  return { pass: failures.length === 0, failures, notes };
}

function fmt(x) {
  if (x === null || x === undefined) return 'none';
  if (typeof x !== 'number') return String(x);
  const a = Math.abs(x);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? x.toExponential(3) : String(Number(x.toPrecision(4)));
}

/** A plain-text table of the scenes' stats (for the console and the report). */
export function statsTable(results) {
  const head = ['scene', 'ready s', 'L_adapt cd/m²', 'pupil mm', 'lim mag', 'stars', 'bodies (resolved)', 'worst labels', 'warnings', 'mean L', 'result'];
  const rows = results.map((r) => {
    const s = r.stats ?? {};
    const labels = {};
    for (const l of [...(s.bodies ?? []).map((b) => b.worstLabel), ...(s.points ?? []).map((p) => p.split(':')[1])]) labels[l] = (labels[l] ?? 0) + 1;
    return [
      r.id,
      r.readyMs !== undefined ? (r.readyMs / 1000).toFixed(0) : '',
      fmt(s.adaptationLuminance),
      s.pupilDiameterMm !== null && s.pupilDiameterMm !== undefined ? s.pupilDiameterMm.toFixed(2) : 'none',
      s.limitingMagnitude !== null && s.limitingMagnitude !== undefined ? s.limitingMagnitude.toFixed(2) : 'none',
      String(s.starsDrawn ?? ''),
      s.bodies ? `${s.bodiesDrawn} (${s.bodies.length})` : '',
      Object.entries(labels).map(([l, n]) => `${n} ${l}`).join(', '),
      String(s.warnings?.length ?? 0),
      r.grid ? mean(r.grid).toFixed(3) : '',
      r.error ? 'ERROR' : r.compare ? (r.compare.pass ? 'pass' : `FAIL (${r.compare.failures.length})`) : 'rendered',
    ];
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}
