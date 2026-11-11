// Runs before each test file (`setupFiles` in vitest.config.ts).
import { vi } from 'vitest';
import { slow } from './timeouts';

/**
 * How long `vi.waitFor` waits when a test does not say: Vitest's own 1 s is too short for what runs
 * git on a busy machine (a run winding down records its changes with several git commands), which
 * all the test files running at once make it. A wait ends as soon as what it waits for is there.
 */
const WAIT_MS = 5_000;

// On a slower system (Windows) every wait is as many times longer as a test (`slow`).
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options) => {
  const o = typeof options === 'number' ? { timeout: options } : (options ?? {});
  return waitFor(callback, { ...o, timeout: slow(o.timeout ?? WAIT_MS) });
}) as typeof vi.waitFor;
