import type { Locator, Page } from '@playwright/test';
import type { VoiceJobView, VoiceStatus } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { en } from '../../src/web/locales/en';
import { syntheticMicrophone } from '../support/voice';
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
    const expectBadgeOnMic = async (mic: Locator) => {
      const badge = mic.locator('.mic-badge .logo-spinner');
      await expect(badge).toBeVisible();
      const box = (await badge.boundingBox())!;
      const button = (await mic.boundingBox())!;
      expect(box.width).toBeCloseTo(12, 0);
      expect(box.x + box.width).toBeCloseTo(button.x + button.width - 2, 0);
      expect(box.y).toBeCloseTo(button.y + 2, 0);
    };
    for (const name of ['New chat', 'New automation']) {
      await page.getByRole('button', { name, exact: true }).first().click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expectBadgeOnMic(page.locator('.first-input .mic-button'));
    }
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await expectBadgeOnMic(page.locator('.composer .mic-button'));
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

for (const name of ['New chat', 'New automation']) {
  test(name + ' keeps the attachment and microphone buttons in place', async ({ page, relay }) => {
    await syntheticMicrophone(page, await relay.api<VoiceStatus>('/api/voice'));
    await page.getByRole('button', { name, exact: true }).first().click();
    const attach = page.getByRole('button', { name: en.composer.attach });
    const mic = page.getByRole('button', { name: en.voice.start, exact: true });
    const apps = page.locator('.first-input-tools').getByRole('button', { name: en.apps.title });
    const stop = page.getByRole('button', { name: en.voice.stop, exact: true });
    const cancel = page.getByRole('button', { name: en.voice.cancel });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(mic).toBeInViewport();
      const attachBox = await attach.boundingBox();
      const micBox = (await mic.boundingBox())!;
      const appsBox = (await apps.boundingBox())!;
      await expect(apps).toBeInViewport();
      expect(appsBox.x).toBeGreaterThanOrEqual(attachBox!.x + attachBox!.width);
      expect(appsBox.x + appsBox.width).toBeLessThanOrEqual(micBox.x);
      const picker = page.waitForEvent('filechooser');
      await attach.click();
      const files = ['weekly-report.txt', 'release-notes.txt', 'meeting-agenda.txt', 'review-checklist.txt'];
      await (await picker).setFiles(files.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('draft') })));
      await expect(page.getByRole('button', { name: en.composer.removeFile(files[0]!) })).toBeVisible();
      expect(await attach.boundingBox()).toEqual(attachBox);
      expect(await mic.boundingBox()).toEqual(micBox);

      await mic.click();
      await expect(stop).toBeVisible();
      expect(await stop.boundingBox()).toEqual(micBox);
      expect(await attach.boundingBox()).toEqual(attachBox);
      await expect(cancel).toBeInViewport();
      if (width === 1280) {
        await cancel.click();
      } else {
        // Hold the response so we can measure the busy button before the transcript arrives.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route('**/api/voice/transcribe', async (route) => {
          await held;
          await route.fulfill({ json: { text: 'Review the files' } });
        });
        await expect(page.getByRole('timer')).toHaveText(/0:0[1-9]/);
        await stop.click();
        try {
          const busy = page.getByRole('button', { name: en.voice.transcribing });
          await expect(busy).toBeDisabled();
          expect(await busy.boundingBox()).toEqual(micBox);
          expect(await attach.boundingBox()).toEqual(attachBox);
        } finally {
          release();
        }
        await expect(page.locator('.task-input')).toHaveValue('Review the files');
      }
      await expect(mic).toBeVisible();
      expect(await mic.boundingBox()).toEqual(micBox);
      for (const file of files) await page.getByRole('button', { name: en.composer.removeFile(file) }).click();
      expect(await attach.boundingBox()).toEqual(attachBox);
      expect(await mic.boundingBox()).toEqual(micBox);
    }
  });
}
