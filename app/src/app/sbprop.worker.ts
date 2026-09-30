// Web Worker: propagates selected small bodies across the catalogue window with the core reference propagator
// (sbgrid.ts gridStates), so a selection, go-to or orbit track never stalls the main thread. It gets the force
// model and the same eagerly loaded ephemeris files as the main thread (the perturbers' positions).

import { Ephemeris, EphemerisSet } from '../core/ephemeris';
import { SmallBodyPropagator } from '../core/smallbody';
import { gridStates, type GridRequest, type GridResponse } from './sbgrid';

let prop: SmallBodyPropagator | null = null;
let init: Extract<GridRequest, { type: 'init' }> | null = null;
const post = (m: GridResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<GridRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const set = new EphemerisSet();
      for (const f of m.ephem) set.add(new Ephemeris(f.header, f.data));
      prop = new SmallBodyPropagator(m.forceModel, set);
      init = m;
      post({ type: 'ready' });
    } else if (m.type === 'grid') {
      if (!prop || !init) throw new Error('propagation worker not initialised');
      const t0 = performance.now();
      const g = gridStates(prop, m.state, m.ng, init.epochEt, init.forceModel.grid.baseStepS, init.window);
      post({ type: 'grid', id: m.id, row: m.row, n0: g.n0, states: g.states, ms: performance.now() - t0 }, [g.states.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : undefined, message: String((err as Error)?.message ?? err) });
  }
};
