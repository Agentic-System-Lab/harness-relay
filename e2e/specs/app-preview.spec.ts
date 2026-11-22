import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, previewControls, send } from '../support/app';
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
  await previewControls(panel);
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
  // On a phone the panel would cover the chat: the page the team made does not open by itself.
  await page.setViewportSize({ width: 390, height: 844 });
  await send(page, 'Make a page.\n[page](site/index.html) e2e:write=site/index.html');
  const claude = await finishedReply(page, 'Claude');
  const codex = await finishedReply(page, 'Codex');
  await expect(page.locator('.preview-ready')).toBeVisible();
  await expect(page.getByLabel('App preview', { exact: true })).toHaveCount(0);
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

test.describe('the app the team made', () => {
  test('a page the team writes opens by itself, folds its controls, and the card and the header bring it back', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    const toggle = page.locator('.chat-head').getByRole('button', { name: 'Preview', exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('title', 'Nothing to preview yet: this works once the team makes a page or an app');
    await send(page, 'Make a page e2e:write=site/index.html');
    await finishedReply(page, 'Claude');
    // Opened and started by itself: a page runs offline. The message box keeps the focus.
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel.frameLocator('iframe').locator('body')).toContainText('Written by Claude');
    await expect(composer(page)).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // While it runs, what it runs from and its buttons are folded into one row.
    const summary = panel.locator('.app-preview-summary');
    await expect(summary).toHaveText('site · @Claude');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('button', { name: 'Stop preview' })).toHaveCount(0);
    await summary.click();
    await expect(panel.getByRole('button', { name: 'Stop preview' })).toBeVisible();
    await expect(panel).toContainText(join(relay.workDir, 'site'));
    await summary.click();
    await expect(panel.getByRole('button', { name: 'Stop preview' })).toHaveCount(0);
    // Once the team has answered, a card offers it.
    const card = page.getByRole('region', { name: 'The app is ready to preview' });
    await expect(card).toContainText('site/index.html · @Claude');
    // The header's button hides it without stopping it: shown again, it is the same run.
    const src = await panel.locator('iframe').getAttribute('src');
    await toggle.click();
    await expect(panel).toBeHidden();
    await expect(page.locator('.chat')).not.toHaveClass(/previewing/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('iframe')).toHaveAttribute('src', src!);
    // Closed, it stops; the card starts it again.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await card.getByRole('button', { name: 'Preview app' }).click();
    await expect(panel.frameLocator('iframe').locator('body')).toContainText('Written by Claude');
    // What the conversation held when it was opened does not open by itself; the header's button opens it.
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(card).toBeVisible();
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(panel.frameLocator('iframe').locator('body')).toContainText('Written by Claude');
    // The next question puts the card away until the team has answered it.
    await send(page, 'Thanks');
    await finishedReply(page, 'Claude');
    await expect(page.locator('.msg-user')).toHaveCount(2);
    await expect(card).toHaveCount(0);
  });

  test('a Dockerfile the team writes opens by itself but waits for Start preview below full access', async ({ page, relay }) => {
    const docker: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/apps/docker/install') || (r.method() === 'POST' && r.url().endsWith('/preview'))) docker.push(r.url());
    });
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await send(page, 'Package it e2e:write=api/Dockerfile');
    await finishedReply(page, 'Claude');
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel).toContainText('Its build runs the project’s Dockerfile, which can reach the network');
    await expect(panel).toContainText(join(relay.workDir, 'api'));
    await expect(panel.getByRole('button', { name: 'Start preview' })).toBeEnabled();
    await expect(panel.locator('.app-preview-summary')).toHaveCount(0);
    // Nothing was built, nor Docker even asked about.
    expect(docker).toEqual([]);
  });

  test('the divider between the chat and the preview drags, moves with the arrow keys and is remembered', async ({ page, relay }) => {
    mkdirSync(join(relay.workDir, 'site'));
    writeFileSync(join(relay.workDir, 'site', 'index.html'), '<!doctype html><h1>Wide</h1>');
    await page.setViewportSize({ width: 1400, height: 900 });
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    const panel = page.getByLabel('App preview', { exact: true });
    const open = async () => {
      await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
      const files = page.getByRole('dialog', { name: 'Files' });
      await files.getByRole('button', { name: 'site', exact: true }).click();
      await files.getByRole('button', { name: 'Preview this folder' }).click();
      await expect(panel.frameLocator('iframe').getByRole('heading')).toHaveText('Wide');
    };
    await open();
    const width = async () => (await panel.boundingBox())!.width;
    const main = (await page.locator('.main').boundingBox())!;
    const initial = await width();
    expect(Math.abs(initial - Math.min(main.width * 0.43, 760))).toBeLessThan(2);
    const divider = page.getByRole('separator', { name: 'Resize the preview' });
    const drag = async (dx: number) => {
      const box = (await divider.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 400);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + 400, { steps: 4 });
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + 400, { steps: 4 });
      await page.mouse.up();
    };
    // To the right, over the page in its frame, which must not take the pointer: narrower.
    await drag(120);
    const narrower = await width();
    expect(Math.abs(narrower - (initial - 120))).toBeLessThan(3);
    // The chat gives way to the panel exactly.
    const chat = (await page.locator('.chat').boundingBox())!;
    expect(Math.abs(chat.x + chat.width - (main.x + main.width - narrower))).toBeLessThan(2);
    // The arrow keys: left widens.
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(width).toBeCloseTo(narrower + 32, 0);
    // Never so wide that the chat keeps less than 360 pixels.
    await drag(-2000);
    await expect.poll(width).toBeCloseTo(main.width - 360, 0);
    await drag(400);
    const kept = await width();
    // Remembered on this browser.
    await page.reload();
    await open();
    expect(Math.abs((await width()) - kept)).toBeLessThan(2);
    // A double-click puts the default width back.
    await divider.dblclick();
    await expect.poll(width).toBeCloseTo(initial, 0);
  });
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
  await previewControls(panel);
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
    await previewControls(panel);
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

test.describe('container previews', () => {
  /** Docker ready, the start answered as a container preview, its terminal stream played once from `events`. */
  async function mockContainer(page: Page, events: object[], gone = false) {
    const runs: unknown[] = [];
    const typed: unknown[] = [];
    await page.route('**/api/apps/docker/install', (route) =>
      route.fulfill({ json: { state: 'ready', available: true, canInstall: false } }),
    );
    const preview = new URL(page.url());
    preview.hostname = 'p-container.localhost';
    await page.route(preview.origin + '/app', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Served from a container</h1>' }),
    );
    await page.route('**/api/conversations/*/preview', (route) =>
      route.fulfill({ json: { id: 'container-preview', origin: preview.origin, url: preview.origin + '/app', terminal: true } }),
    );
    let streams = 0;
    await page.route('**/preview/container-preview/terminal', async (route) => {
      if (route.request().method() === 'POST') {
        typed.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      // The first stream plays the events; a reconnection waits, as a live stream does, or finds
      // the preview gone.
      if (streams++) return gone ? route.fulfill({ status: 404, json: { error: 'The preview entry is missing' } }) : new Promise(() => {});
      return route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    await page.route('**/preview/container-preview/run', (route) => {
      runs.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/preview/container-preview', (route) => route.fulfill({ json: { ok: true } }));
    return { runs, typed };
  }
  const output = (text: string, replay?: boolean) => ({
    type: 'output',
    data: Buffer.from(text).toString('base64'),
    ...(replay ? { replay } : {}),
  });

  test('a Dockerfile shows the build in a terminal, opens the page when the app serves one, and runs again', async ({ page, relay }) => {
    mkdirSync(join(relay.workDir, 'api'));
    writeFileSync(join(relay.workDir, 'api', 'Dockerfile'), 'FROM python:3.13-slim\nCMD ["python", "app.py"]\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    const container = await mockContainer(page, [
      output('#1 building\r\n', true),
      { type: 'phase', phase: 'running', command: 'python app.py' },
      output('serving on 8000\r\n'),
      { type: 'page' },
    ]);
    await send(page, 'Try the API.\n[API](api/Dockerfile)');
    await (await finishedReply(page, 'Claude')).getByRole('button', { name: 'Preview app' }).click();
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel).toContainText('The app runs in a Docker container with no network.');
    await expect(panel.frameLocator('iframe').getByRole('heading')).toHaveText('Served from a container');
    await expect(panel.getByRole('radio', { name: 'Page' })).toBeChecked();
    await panel.getByRole('radio', { name: 'Terminal' }).click();
    await expect(panel.locator('.xterm-rows')).toContainText('#1 building');
    await expect(panel.locator('.xterm-rows')).toContainText('serving on 8000');
    await previewControls(panel);
    await expect(panel.getByRole('textbox', { name: 'Command' })).toHaveValue('python app.py');
    await panel.locator('.xterm-screen').click();
    await page.keyboard.type('hi');
    const typedText = () => container.typed.map((body) => (body as { input?: string }).input ?? '').join('');
    await expect.poll(typedText).toBe('hi');
    // Escape and Tab belong to the app's terminal, even on a phone, where the panel is a dialog.
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.locator('.xterm-screen').click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'App preview' })).toBeVisible();
    await expect.poll(typedText).toBe('hi\x1b');
    await panel.getByRole('button', { name: 'Run again' }).click();
    await expect.poll(() => container.runs).toEqual([{}]);
    await panel.getByRole('textbox', { name: 'Command' }).fill('python app.py --debug');
    await panel.getByRole('button', { name: 'Run this command' }).click();
    await panel.getByRole('button', { name: 'Open a shell' }).click();
    await expect.poll(() => container.runs).toEqual([{}, { command: 'python app.py --debug' }, { command: '/bin/sh' }]);
  });

  test('a failed build says so and its terminal goes into the report to the agent', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'compose.yaml'), 'services:\n  app:\n    build: .\n');
    writeFileSync(join(relay.workDir, 'Dockerfile'), 'FROM python:3.13-slim\nRUN pip install nothing-here\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await mockContainer(page, [
      output('\x1b[1m#5 RUN pip install nothing-here\x1b[0m\r\nERROR: No matching distribution found for nothing-here\r\n', true),
      { type: 'phase', phase: 'failed', error: 'Building the image of app failed.' },
    ]);
    await composer(page).fill('My draft');
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    await page.getByRole('dialog', { name: 'Files' }).getByRole('button', { name: 'Preview this folder' }).click();
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel.locator('.app-preview-status')).toHaveText('The preview failed. The terminal says why.');
    await previewControls(panel);
    await expect(panel.getByRole('button', { name: 'Run again' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Add errors to message' }).click();
    await expect(composer(page)).toHaveValue(
      /#5 RUN pip install nothing-here\n\s+ERROR: No matching distribution found for nothing-here[\s\S]*My draft/,
    );
  });

  test('a terminal that finds its preview gone stops offering to run it', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'Dockerfile'), 'FROM python:3.13-slim\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await mockContainer(page, [output('Your name? ', true), { type: 'phase', phase: 'running', command: 'python app.py' }], true);
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    await page.getByRole('dialog', { name: 'Files' }).getByRole('button', { name: 'Preview this folder' }).click();
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel.locator('.xterm-rows')).toContainText('Your name?');
    // The stream ended and its reconnection found nothing: no Run again, nothing reconnecting.
    await previewControls(panel);
    await expect(panel.getByRole('button', { name: 'Run again' })).toHaveCount(0);
    await expect(panel.getByText('Reconnecting')).toHaveCount(0);
  });

  test('a folder with no way to run it offers to ask the agent for a Dockerfile', async ({ page, relay }) => {
    mkdirSync(join(relay.workDir, 'tool'));
    writeFileSync(join(relay.workDir, 'tool', 'main.go'), 'package main\nfunc main() {}\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const files = page.getByRole('dialog', { name: 'Files' });
    await files.getByRole('button', { name: 'tool', exact: true }).click();
    await files.getByRole('button', { name: 'Preview this folder' }).click();
    const panel = page.getByLabel('App preview', { exact: true });
    await expect(panel.getByRole('alert')).toContainText('Dockerfile');
    await panel.getByRole('button', { name: 'Ask the agent for a Dockerfile' }).click();
    await expect(composer(page)).toHaveValue(/^Please add a Dockerfile to .*tool \(and a compose\.yaml/);
  });
});
