import { expect, it } from 'vitest';

const fs = await import(/* @vite-ignore */ 'node:fs' as string);
it('ring geometry has no invented minimum-width constant or shader clamp', () => {
  for (const file of ['../src/render/ringComponents.ts', '../src/render/shaders-m2.ts',
    '../../pipeline/src/pipeline/photometry/ring_components.py']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/MIN_WIDTH_KM|CMP_MINW/);
    expect(source).not.toMatch(/(?:Math\.)?max\(rOut\s*-\s*rIn,\s*0\.5\)/);
  }
});
