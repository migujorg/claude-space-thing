// A small body's states on the catalogue's integration grid (epochEt + n·baseStep) across the whole window,
// computed with the core reference propagator. Used off the main thread (sbprop.worker.ts, through
// GridWorkerClient) so selecting an object never stalls a frame; CpuSmallBodyStates (smallbodies.ts) seeds its
// per-object store with the result. Every step ends on the grid, so these states are bit-identical to the ones
// the main thread would compute step by step.

import { SB_OK, type NonGrav, type SmallBodyPropagator } from '../core/smallbody';
import type { EphemHeader, SmallBodyForceModel } from '../data/schema';

export interface GridStates {
  /** Grid index of the first state (≤ 0). */
  n0: number;
  /** 6 numbers per grid index n0, n0+1, …; NaN from the first index that could not be reached (outward). */
  states: Float64Array;
}

/** Grid indices covered by a window: [nMin, nMax] with nMin ≤ 0 ≤ nMax when the epoch lies inside. */
export function gridRange(epochEt: number, H: number, window: { startEt: number; endEt: number }): [number, number] {
  return [Math.min(0, Math.ceil((window.startEt - epochEt) / H)), Math.max(0, Math.floor((window.endEt - epochEt) / H))];
}

/** Propagate one object outward from the epoch state to both ends of the window, keeping every grid state. */
export function gridStates(prop: SmallBodyPropagator, st0: ArrayLike<number>, ng: NonGrav | null, epochEt: number, H: number, window: { startEt: number; endEt: number }): GridStates {
  const [nMin, nMax] = gridRange(epochEt, H, window);
  const out = new Float64Array(6 * (nMax - nMin + 1)).fill(NaN);
  const st = Float64Array.from(st0);
  out.set(st, 6 * -nMin);
  for (let n = 1; n <= nMax; n++) {
    if (prop.propagateOne(st, 0, epochEt + (n - 1) * H, epochEt + n * H, epochEt, ng) !== SB_OK) break;
    out.set(st, 6 * (n - nMin));
  }
  st.set(Array.from(st0));
  for (let n = -1; n >= nMin; n--) {
    if (prop.propagateOne(st, 0, epochEt + (n + 1) * H, epochEt + n * H, epochEt, ng) !== SB_OK) break;
    out.set(st, 6 * (n - nMin));
  }
  return { n0: nMin, states: out };
}

// ---- worker protocol ------------------------------------------------------------------------------------------

export type GridRequest =
  | { type: 'init'; forceModel: SmallBodyForceModel; epochEt: number; window: { startEt: number; endEt: number }; ephem: { header: EphemHeader; data: Float64Array }[] }
  | { type: 'grid'; id: number; row: number; state: number[]; ng: NonGrav | null };

export type GridResponse =
  | { type: 'ready' }
  | { type: 'grid'; id: number; row: number; n0: number; states: Float64Array; ms: number }
  | { type: 'error'; id?: number; message: string };

/** What CpuSmallBodyStates needs from a background propagator. */
export interface GridWorkerPort {
  grid(row: number, state: ArrayLike<number>, ng: NonGrav | null): Promise<GridStates>;
}

/** Main-thread side of sbprop.worker.ts. */
export class GridWorkerClient implements GridWorkerPort {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (g: GridStates) => void; reject: (e: Error) => void }>();
  private failed: Error | null = null;
  /** Wall-clock ms the worker spent propagating (diagnostics). */
  ms = 0;

  constructor(private readonly worker: Worker, init: Extract<GridRequest, { type: 'init' }>) {
    worker.onmessage = (e: MessageEvent<GridResponse>) => {
      const m = e.data;
      if (m.type === 'grid') {
        this.ms += m.ms;
        this.waiting.get(m.id)?.resolve({ n0: m.n0, states: m.states });
        this.waiting.delete(m.id);
      } else if (m.type === 'error') {
        if (m.id !== undefined) {
          this.waiting.get(m.id)?.reject(new Error(m.message));
          this.waiting.delete(m.id);
        } else this.fail(new Error(m.message));
      }
    };
    worker.onerror = (e) => this.fail(new Error(e.message || 'small-body propagation worker failed'));
    worker.postMessage(init);
  }

  private fail(e: Error): void {
    this.failed = e;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  grid(row: number, state: ArrayLike<number>, ng: NonGrav | null): Promise<GridStates> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'grid', id, row, state: Array.from(state), ng } satisfies GridRequest);
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
