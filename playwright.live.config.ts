import { defineConfig, devices } from '@playwright/test';

/*
 * The live end-to-end tests (`npm run test:e2e:live`): the real server and the built UI with the real
 * CLIs, signed in as the user is, on real models (an Ollama or vLLM server of the user's own, and the
 * CLIs' own cloud models when E2E_LIVE_CLOUD=1). They are never run on CI: each test is skipped
 * unless the environment names what it needs (a model server, or E2E_LIVE_CLOUD=1). One at a time, since a turn on a real model is slow
 * and the CLIs share the user's own folders. See the developer guide, "Live tests".
 */
export default defineConfig({
  testDir: './e2e/live',
  globalSetup: './e2e/global-setup.ts',
  outputDir: './test-results/e2e-live',
  timeout: 20 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    ...devices['Desktop Chrome'],
  },
});
