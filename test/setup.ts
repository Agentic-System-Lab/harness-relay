// Runs before each test file (`setupFiles` in vitest.config.ts).
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { slow } from './timeouts';

// The developer's own Harness Relay variables, such as a team limit or a voice folder set in a shell
// profile for the desktop app, must not change what the tests see (`src/server/config.ts` reads them
// as it loads, and the test file's modules load after this). A test that needs one sets it itself.
for (const k of Object.keys(process.env)) if (k.startsWith('RELAY_')) delete process.env[k];

/*
 * Windows' temporary folder may be named by its short 8.3 name (`C:\Users\RUNNER~1\…` for a user
 * name longer than eight letters, as on GitHub's runners), which `realpathSync` keeps and git and the
 * system's own real path spell out. The tests' folders are named as the folder dialog, or a typed
 * path, would name them: spelled out (`os.tmpdir()` reads TEMP).
 */
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = realpathSync.native(tmpdir());

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
