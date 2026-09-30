// Web Worker: the event finder (engine.ts) off the main thread. Gets the loaded ephemeris files, orientation
// products and bodies once, moon systems and the small-body candidates as they arrive, and answers one category
// per request with progress messages.

import { EventEngine } from './engine';
import type { EventRequest, EventResponse } from './service';

let engine: EventEngine | null = null;
const post = (m: EventResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<EventRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'init') engine = EventEngine.fromFiles(m.init);
    else if (!engine) throw new Error('event worker not initialised');
    else if (m.type === 'ephem') engine.addEphem(m.file);
    else if (m.type === 'smallbodies') engine.setSmallBodies(m.sb);
    else if (m.type === 'find') {
      const t0 = performance.now();
      let last = 0;
      const events = engine.find(m.category, (f) => {
        const t = performance.now();
        if (t - last > 200) { last = t; post({ type: 'progress', id: m.id, fraction: f }); }
      });
      post({ type: 'result', id: m.id, events, ms: performance.now() - t0, errors: engine.errors.splice(0) });
    }
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : undefined, message: String((err as Error)?.message ?? err) });
  }
};
