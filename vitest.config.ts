import { defineConfig } from 'vitest/config';
import { slow } from './test/timeouts.ts';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    // Vitest's own 5 s and 10 s, longer on a slower system (Windows).
    testTimeout: slow(5_000),
    hookTimeout: slow(10_000),
  },
});
