// Guard the §1 provenance boundary: production callers cannot retype these physical values.
import { expect, it } from 'vitest';
import ts from 'typescript';

interface Fs {
  readdirSync(p: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(p: string, encoding: 'utf8'): string;
}
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const src = new URL('../src/', import.meta.url).pathname;
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}

it('defines physical coefficients and display standards only in the cited constants modules', () => {
  // Deliberately omit mathematical identities, SI prefix conversions, numerical tolerances,
  // interaction settings and binary-layout numbers. Strings/comments are not numeric definitions.
  const physical = new Set([
    149597870.7, 299792.458, 86400, 365.25, 84381.448, 1329,
    100.46457166, 35999.37244981, 6.61e-12,
    0.265, 0.38971, 0.867, 0.96, 0.003, 5.12e-3, 1.338, 13.8,
  ]);
  const offenders: string[] = [];
  for (const path of files(src)) {
    if (!path.endsWith('.ts') || /\/(core|eye)\/constants\.ts$/.test(path)) continue;
    // Dedicated fixtures/probes and the shader sources are outside this production-code audit.
    if (/\/(ui-dev|render-test)\/|\/testpage\.ts$|\/gputest\.ts$|\/shaders[^/]*\.ts$|\/kernels\.ts$/.test(path)) continue;
    const file = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isNumericLiteral(node) && (physical.has(Number(node.text)) ||
        (path.endsWith('/render/earth.ts') && Number(node.text) === 1.02) ||
        (path.endsWith('/app/sky.ts') && Number(node.text) === 6.5 &&
          ts.isCallExpression(node.parent) && node.parent.expression.getText(file) === 'luxFromMagnitude'))) {
        offenders.push(`${path.slice(src.length)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(offenders).toEqual([]);
});

it('ring geometry has no invented minimum-width constant or shader clamp', () => {
  for (const file of ['../src/render/ringComponents.ts', '../src/render/shaders-m2.ts',
    '../../pipeline/src/pipeline/photometry/ring_components.py']) {
    const source = fs.readFileSync(new URL(file, import.meta.url).pathname, 'utf8');
    expect(source).not.toMatch(/MIN_WIDTH_KM|CMP_MINW/);
    expect(source).not.toMatch(/(?:Math\.)?max\(rOut\s*-\s*rIn,\s*0\.5\)/);
  }
});
