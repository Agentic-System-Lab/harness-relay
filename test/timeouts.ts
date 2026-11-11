/**
 * How much longer tests wait on this system. Windows starts processes and runs git several times
 * slower than macOS and Linux (and an antivirus scans each file a test writes): there, every test's
 * time limit and every `vi.waitFor` is this many times longer (`vitest.config.ts`, `test/setup.ts`).
 */
export const SLOWER = process.platform === 'win32' ? 6 : 1;

/** `ms`, as long as it takes on this system. */
export const slow = (ms: number): number => ms * SLOWER;
