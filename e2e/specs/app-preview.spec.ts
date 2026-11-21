import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';
import { DEV_WEB_DIR } from '../support/paths';

test('Files previews a static site, rebuilds edits, stops it and copies errors to an editable draft', async ({ page, relay }) => {
  const site = join(relay.workDir, 'site');
  mkdirSync(site);
  const html = (title: string) =>
    `<!doctype html><title>${title}</title><h1>${title}</h1><input aria-label="Try typing"><button>Test error</button><script type="module" src="./app.js"></script>`;
  writeFileSync(join(site, 'index.html'), html('First version'));
  writeFileSync(join(site, 'app.js'), "document.querySelector('button').onclick = () => { throw new Error('Button error'); }");
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await composer(page).fill('My draft');
  await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
  const files = page.getByRole('dialog', { name: 'Files' });
  const dockerRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/apps/docker/install')) dockerRequests.push(r.method());
  });
  await files.getByRole('button', { name: 'site', exact: true }).click();
  await files.getByRole('button', { name: 'Preview this folder' }).click();

  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel).toContainText(site);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  const frame = panel.frameLocator('iframe');
  await expect(frame.getByRole('heading')).toHaveText('First version');
  const element = panel.locator('iframe');
  await expect(element).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
  await expect(element).toHaveAttribute('referrerpolicy', 'no-referrer');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog', { name: 'App preview' })).toBeFocused();
  await panel.getByRole('button', { name: 'Stop preview' }).focus();
  await page.keyboard.press('Tab');
  await expect(frame.getByRole('textbox', { name: 'Try typing' })).toBeFocused();
  await frame.getByRole('button', { name: 'Test error' }).click();
  await expect(panel.getByRole('log')).toContainText('Button error');
  writeFileSync(join(site, 'index.html'), html('Rebuilt version'));
  await panel.getByRole('button', { name: 'Rebuild preview' }).click();
  await expect(frame.getByRole('heading')).toHaveText('Rebuilt version');
  await frame.getByRole('button', { name: 'Test error' }).click();
  await expect(panel.getByRole('log')).toContainText('Button error');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Add errors to message' }).click();
  await expect(composer(page)).toHaveValue(/Button error[\s\S]*My draft/);
  await expect(composer(page)).toBeFocused();
  await page.getByRole('button', { name: 'Return to preview' }).click();
  await expect(frame.getByRole('heading')).toHaveText('Rebuilt version');
  await panel.getByRole('button', { name: 'Stop preview' }).click();
  await expect(element).toHaveCount(0);
  await expect(page.locator('.msg-user')).toHaveCount(0);
  expect(dockerRequests).toEqual([]);
});

test('a reply opens the author’s own file in parallel and the preview fits a phone', async ({ page, relay }) => {
  await openTeamChat(
    page,
    relay,
    [
      { name: 'Claude', provider: 'claude' },
      { name: 'Codex', provider: 'codex' },
    ],
    {
      permission: 'edit',
      mode: 'parallel',
    },
  );
  await send(page, 'Make a page.\n[page](site/index.html) e2e:write=site/index.html');
  const claude = await finishedReply(page, 'Claude');
  const codex = await finishedReply(page, 'Codex');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [author, reply] of [
    ['Claude', claude],
    ['Codex', codex],
  ] as const) {
    await expect(reply.getByRole('link', { name: 'page' })).toHaveAttribute('download', 'index.html');
    await reply.getByRole('button', { name: 'Preview app' }).click();
    const panel = page.getByRole('dialog', { name: 'App preview' });
    await expect(panel).toContainText('@' + author);
    await expect(panel.frameLocator('iframe').locator('body')).toContainText('Written by ' + author);
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
    await panel.getByRole('button', { name: 'Close' }).click();
  }
});

function writeLockfile(folder: string) {
  writeFileSync(join(folder, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
}

test('a package link reports a missing lockfile before checking Docker and releases a canceled start', async ({ page, relay }) => {
  writeFileSync(join(relay.workDir, 'package.json'), JSON.stringify({ scripts: { start: 'node server.cjs' } }));
  let dockerChecks = 0;
  await page.route('**/api/apps/docker/install', (route) => {
    dockerChecks++;
    return route.fulfill({ json: { state: 'ready', available: true, canInstall: false } });
  });
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await send(page, 'Check the project.\n[project](package.json)');
  const reply = await finishedReply(page, 'Claude');
  await reply.getByRole('button', { name: 'Preview app' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel.getByRole('alert')).toContainText('package-lock.json');
  expect(dockerChecks).toBe(0);
  expect(existsSync(join(relay.dataDir, 'preview-runtime-used'))).toBe(false);
  await expect(panel.locator('iframe')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add errors to message' }).click();
  await expect(composer(page)).toHaveValue(/^@Claude /);
  await panel.getByRole('button', { name: 'Close' }).click();
  writeLockfile(relay.workDir);
  // This transport finishes after Close, as can happen if the response races a cancellation.
  // Check both the abort signal and the deletion of that late result, by its own session id.
  let started!: () => void;
  const starting = new Promise<void>((resolve) => (started = resolve));
  await page.exposeFunction('previewStartReceived', started);
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.endsWith('/preview') && init?.method === 'POST') {
        void (window as unknown as { previewStartReceived(): void }).previewStartReceived();
        return new Promise<Response>((resolve) => {
          init.signal!.addEventListener(
            'abort',
            () =>
              resolve(
                Response.json({
                  id: 'late-result',
                  origin: 'http://late.localhost',
                  url: 'http://late.localhost/',
                }),
              ),
            { once: true },
          );
        });
      }
      return original(input, init);
    };
  });
  await reply.getByRole('button', { name: 'Preview app' }).click();
  await starting;
  await expect(panel.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  const cleanup = page.waitForRequest((request) => request.url().endsWith('/preview/late-result') && request.method() === 'DELETE');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await cleanup;
});

/** Only Docker and the container it would start are simulated. Relay resolves the selected files on disk. */
async function mockDocker(page: Page) {
  const docker = {
    state: 'missing' as 'missing' | 'unavailable' | 'ready',
    job: undefined as 'running' | 'failed' | 'success' | undefined,
    installs: 0,
    starts: [] as string[],
  };
  await page.route('**/api/apps/docker/install', async (route) => {
    if (route.request().method() === 'POST') {
      docker.installs++;
      docker.job = 'running';
    }
    await route.fulfill({
      json: {
        state: docker.state,
        available: docker.state === 'ready',
        canInstall: docker.state === 'missing' && docker.job !== 'running',
        detail: docker.state === 'unavailable' ? 'Local Linux container engine is stopped.' : undefined,
        job: docker.job && {
          state: docker.job,
          startedAt: 1,
          error: docker.job === 'failed' ? 'Installer failed' : undefined,
          log: docker.job === 'failed' ? 'The installer requires more disk space.' : '',
        },
      },
    });
  });
  const preview = new URL(page.url());
  preview.hostname = 'p-test.localhost';
  await page.route(preview.origin + '/app', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>App is running</h1>' }));
  await page.route('**/api/conversations/*/preview', async (route) => {
    docker.starts.push(route.request().postDataJSON().mode);
    await route.fulfill({ json: { id: 'docker-preview', origin: preview.origin, url: preview.origin + '/app' } });
  });
  await page.route('**/preview/docker-preview', (route) => route.fulfill({ json: { ok: true } }));
  return docker;
}

test.describe('Docker setup for previews', () => {
  // Opening a preview must start it once even when React's StrictMode repeats the initial effects.
  test.use({ serverEnv: { RELAY_WEB_DIR: DEV_WEB_DIR } });

  test('canceling a missing Docker prompt keeps the build on hold until a successful installation', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    writeLockfile(relay.workDir);
    const docker = await mockDocker(page);
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const files = page.getByRole('dialog', { name: 'Files' });
    await files.getByRole('button', { name: 'Preview this folder' }).click();

    const panel = page.getByLabel('App preview', { exact: true });
    const setup = page.getByRole('dialog', { name: 'Set up Docker' });
    await expect(setup.getByRole('button', { name: 'Install Docker' })).toBeVisible();
    await setup.getByRole('button', { name: 'Cancel' }).click();
    await expect(setup).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Start preview' })).toBeDisabled();
    await expect(panel.locator('iframe')).toHaveCount(0);
    expect(docker.installs).toBe(0);
    expect(docker.starts).toEqual([]);

    await panel.getByRole('button', { name: 'Set up Docker' }).click();
    await setup.getByRole('button', { name: 'Install Docker' }).click();
    await expect.poll(() => docker.installs).toBe(1);
    expect(docker.starts).toEqual([]);
    docker.job = 'failed';
    await expect(setup.getByRole('alert')).toHaveText('Installer failed');
    await setup.getByText('Installation log', { exact: true }).click();
    await expect(setup.getByText('The installer requires more disk space.')).toBeVisible();
    await setup.getByRole('button', { name: 'Install Docker' }).click();
    await expect.poll(() => docker.installs).toBe(2);
    expect(docker.starts).toEqual([]);
    docker.state = 'ready';
    docker.job = 'success';
    await expect(panel.frameLocator('iframe').getByRole('heading')).toHaveText('App is running');
    await expect(setup).toHaveCount(0);
    await panel.getByRole('button', { name: 'Stop preview' }).click();
    await expect(panel.locator('iframe')).toHaveCount(0);
    expect(docker.starts).toEqual(['build']);
    expect(docker.installs).toBe(2);
  });

  test('an installed engine can be checked again and the pending backend opens once when it becomes ready', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs', start: 'node server.cjs' } }));
    writeLockfile(relay.workDir);
    const docker = await mockDocker(page);
    docker.state = 'unavailable';
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Try the app.\n[Project](package.json)');
    const reply = await finishedReply(page, 'Claude');
    await reply.getByRole('button', { name: 'Preview app' }).click();

    const panel = page.getByLabel('App preview', { exact: true });
    const setup = page.getByRole('dialog', { name: 'Set up Docker' });
    await expect(setup).toContainText('Local Linux container engine is stopped.');
    await expect(setup.getByRole('button', { name: 'Install Docker' })).toHaveCount(0);
    const rechecked = page.waitForResponse((r) => r.url().endsWith('/api/apps/docker/install') && r.request().method() === 'GET');
    await setup.getByRole('button', { name: 'Check again' }).click();
    await rechecked;
    expect(docker.starts).toEqual([]);
    docker.state = 'ready';
    await expect(panel.frameLocator('iframe').getByRole('heading')).toHaveText('App is running');
    await expect(setup).toHaveCount(0);
    expect(docker.installs).toBe(0);
    expect(docker.starts).toEqual(['server']);
  });
});
