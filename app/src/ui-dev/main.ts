// UI development page (app/ui-dev.html): the real app shell (startApp) running on FIXTURE data,
// fake core modules and a 2D stand-in renderer. Nothing here is real data; the page says so.
//
//   npm run shot -- --url "/ui-dev.html" --out shots/ui.png
//   /ui-dev.html?omit=photometry.json,light.json   → exercise the "missing product" states
//   /ui-dev.html?panel=data,dials                  → open panels for a screenshot
//   plus every URL view parameter of the real app (t, target, dist, az, el, exists, view, ...)

import { startApp } from '../app/bootstrap';
import { fixtureFetch } from './fixtures/data';
import { FixtureEphemeris, FixtureEphemerisSet, fixtureApparent, fixtureBodyToIcrf, fixtureFormatUtc, FixtureTimeScale } from './fixtures/fakeCore';
import { StandInRenderer } from './standInRenderer';

async function main() {
  const params = new URLSearchParams(location.search);
  const omit = (params.get('omit') ?? '').split(',').filter(Boolean);
  const nowEt = new FixtureTimeScale({} as never).utcMsToEt(Date.now());
  const fetch = await fixtureFetch({ nowEt, omit });
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const app = await startApp(canvas, ui, {
    Renderer: StandInRenderer,
    TimeScale: FixtureTimeScale,
    Ephemeris: FixtureEphemeris,
    EphemerisSet: FixtureEphemerisSet,
    apparentPosition: fixtureApparent,
    bodyToIcrf: fixtureBodyToIcrf,
    formatUtc: fixtureFormatUtc,
    fetch,
    dataBaseUrl: '/fixture-data/',
    banner: 'UI DEV · FIXTURE DATA — NOT REAL',
  });
  await app.ready;
  // Dev-only: ?panel=data|help|sources|dials|search opens a panel (for screenshots).
  for (const p of (params.get('panel') ?? '').split(',').filter(Boolean)) app.ui.openPanel(p as never);
}

main().catch((e) => {
  console.error(e);
  window.__frameError = String(e);
});
