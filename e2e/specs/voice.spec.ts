import type { Page } from '@playwright/test';
import type { VoiceJobView, VoiceStatus } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { openTeamChat } from '../support/app';

const MB = 1024 * 1024;

/**
 * Settings → Voice input with an install in it. A real install downloads the engine and a model
 * (pinned sizes and SHA-256), which the tests cannot do offline, so the page gets the server's own
 * answer to GET /api/voice with `job` put in.
 */
/**
 * The server's answer, asked again when the connection was reset: the page asks every moment while an
 * install runs, and on Windows a request sent on a kept-alive connection the server has just closed
 * fails with ECONNRESET now and then.
 */
async function fetchAgain<T>(fetch: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fetch();
    } catch (err) {
      if (i >= tries || !/ECONNRESET|ECONNREFUSED|socket hang up/.test(String(err))) throw err;
    }
  }
}

async function showInstall(page: Page, base: string, job: Omit<VoiceJobView, 'model'>): Promise<void> {
  await page.route('**/api/voice', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await fetchAgain(() => route.fetch());
    const status = (await res.json()) as VoiceStatus;
    await route.fulfill({ response: res, json: { ...status, job: { ...job, model: status.model } } });
  });
  await page.goto(`${base}/#/settings/voice`);
  await expect(page.locator('.voice-job')).toBeVisible();
}

const STEPS = ['engine', 'model', 'check'] as VoiceJobView['steps'];

test.describe("voice input's install", () => {
  // The page keeps asking for the install's state while a test ends and its server stops: a request
  // the route is fetching then fails (ECONNRESET on Windows). Let the route go first, quietly.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('shows its steps in line, says their state to screen readers, and its download in the bar', async ({ page, relay }) => {
    await showInstall(page, relay.base, {
      id: 'e2e',
      state: 'running',
      steps: STEPS,
      step: 'model',
      received: 228 * MB,
      total: 574 * MB,
      bytesPerSecond: 12 * MB,
      startedAt: Date.now(),
      log: '',
    });
    const steps = page.locator('.voice-job .voice-steps li');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(0)).toContainText('Install whisper.cpp (done)');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'now');
    await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(steps.nth(1)).toContainText('model (in progress)');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'todo');
    await expect(steps.nth(2)).not.toHaveAttribute('aria-current');
    await expect(steps.nth(2)).toContainText('Start the engine and load the model (not started)');
    // The state is for screen readers only; the step not reached yet is laid out like the others,
    // not as the chat's to-do card.
    await expect(steps.nth(2).locator('.visually-hidden')).toHaveCSS('position', 'absolute');
    for (const i of [0, 1, 2]) {
      await expect(steps.nth(i)).toHaveCSS('flex-direction', 'row');
      await expect(steps.nth(i)).toHaveCSS('border-top-width', '0px');
    }

    // 228 of 574 MB: 39%, the bar's fill scaled to it.
    const bar = page.locator('.voice-progress [role=progressbar]');
    await expect(bar).toHaveAttribute('aria-valuenow', '39');
    await expect(bar.locator('span')).toHaveCSS('transform', 'matrix(0.39, 0, 0, 1, 0, 0)');
    await expect(page.locator('.voice-progress')).toContainText('39% · 228 MB / 574 MB');
    // While it runs, the app's loader (the Logo turning) beside its state; and in a chat, at the
    // microphone's top right, 12px.
    await expect(page.locator('.voice-job .login-state .logo-spinner')).toBeVisible();
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    const badge = page.locator('.composer .mic-button .mic-badge .logo-spinner');
    await expect(badge).toBeVisible();
    const box = (await badge.boundingBox())!;
    const mic = (await page.locator('.composer .mic-button').boundingBox())!;
    expect(box.width).toBeCloseTo(12, 0);
    expect(box.x + box.width).toBeCloseTo(mic.x + mic.width - 2, 0);
    expect(box.y).toBeCloseTo(mic.y + 2, 0);
  });

  test('says which step stopped a failed install', async ({ page, relay }) => {
    await showInstall(page, relay.base, {
      id: 'e2e',
      state: 'failed',
      steps: STEPS,
      step: 'model',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      log: 'curl: (56) Recv failure',
      error: 'The download stopped.',
    });
    const steps = page.locator('.voice-job .voice-steps li');
    await expect(steps.nth(0)).toContainText('(done)');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'stopped');
    await expect(steps.nth(1)).toContainText('model (stopped)');
    await expect(steps.nth(2)).toContainText('(not started)');
    await expect(page.locator('.voice-job [aria-current]')).toHaveCount(0);
    await expect(page.locator('.voice-progress')).toHaveCount(0);
  });
});

test('leaving New chat releases a microphone granted after navigation', async ({ page }) => {
  await page.route('**/api/voice', (route) => route.fulfill({ json: { ready: true } }));
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const mic = page.getByRole('button', { name: 'Voice input', exact: true });
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const stream = ctx.createMediaStreamDestination().stream;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        document.addEventListener('grant-test-microphone', () => resolve(stream), { once: true });
        const track = stream.getAudioTracks()[0]!;
        Object.defineProperty(window, 'testMicState', { get: () => track.readyState });
      });
  });
  await mic.click();
  const trackState = () => page.evaluate(() => Reflect.get(window, 'testMicState'));
  await expect.poll(trackState).toBe('live');
  await page.getByRole('link', { name: 'Change the lead agent' }).click();
  await expect(mic).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event('grant-test-microphone')));
  await expect.poll(trackState).toBe('ended');
});
