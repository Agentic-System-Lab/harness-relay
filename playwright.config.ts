import { defineConfig, devices, type Project } from '@playwright/test';

/*
 * End-to-end tests (`npm run test:e2e`): the real server and the built UI in a real browser, with
 * fake `claude`, `codex` and `grok` CLIs (`e2e/fake-cli/`), so they run offline, on macOS, Linux
 * and Windows. Each test gets a server of its own (`e2e/fixtures.ts`). See the developer guide,
 * "End-to-end tests".
 *
 * E2E_BROWSERS picks the browsers, comma-separated: chromium (the default), firefox and webkit.
 * (A phone's screen and touch are tried in `e2e/specs/mobile.spec.ts`, in each of them.)
 */
const BROWSERS: Record<string, Project['use']> = {
  chromium: { ...devices['Desktop Chrome'] },
  firefox: { ...devices['Desktop Firefox'] },
  webkit: { ...devices['Desktop Safari'] },
};
const wanted = (process.env.E2E_BROWSERS ?? 'chromium')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const unknown = wanted.filter((b) => !BROWSERS[b]);
if (unknown.length) throw new Error(`E2E_BROWSERS: unknown ${unknown.join(', ')} (choose from ${Object.keys(BROWSERS).join(', ')})`);

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/global-setup.ts',
  outputDir: './test-results/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // Every test starts a server, a browser and agents of its own. On CI, two at a time keep Linux's
  // and macOS's runners busy (a third only made each test slower there), while Windows' tests
  // mostly wait on processes starting: there each of the runner's four cores takes one.
  workers: ci ? (process.platform === 'win32' ? 4 : 2) : '50%',
  reporter: ci
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: wanted.map((name) => ({ name, use: BROWSERS[name] })),
});
