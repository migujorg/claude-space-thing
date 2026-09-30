// Entry point: wires the real core, renderer and data into the app shell (docs/architecture.md §5.1).
import { startApp } from './app/bootstrap';
import { OffscreenPresenter } from './app/offscreenPresenter';
import { Ephemeris, EphemerisSet } from './core/ephemeris';
import { apparentPosition } from './core/lighttime';
import { OrientationSet, PreciseOrientation, bodyToIcrf } from './core/rotation';
import { TimeScale, formatUtc } from './core/time';
import { Renderer } from './render/renderer';
import { SmallBodyField } from './gpu/smallbodies';

const offscreen = new URLSearchParams(location.search).get('present') === 'offscreen';
const canvas = document.getElementById('view') as HTMLCanvasElement;
startApp(canvas, document.getElementById('ui')!, {
  Renderer: offscreen ? OffscreenPresenter : Renderer,
  TimeScale,
  formatUtc,
  Ephemeris,
  EphemerisSet,
  bodyToIcrf,
  apparentPosition,
  OrientationSet,
  PreciseOrientation,
  SmallBodyField,
}).catch((e) => {
  console.error(e);
  (window as any).__frameError = String(e);
});
