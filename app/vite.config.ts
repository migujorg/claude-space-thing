import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: 'es2022' },
  // testTimeout: a test's limit is on what it computes, asserted where it matters in CPU time
  // (render-law-motion-cost.test.ts), not on wall time: the default 5 s made heavy but correct tests fail at random
  // when the suite's workers and the lanes shared the machine (7 October 2026: a 2 s test took 6.6 s in the suite).
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
} as any);
