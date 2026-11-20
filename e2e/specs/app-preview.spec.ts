import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { composer, finishedReply, openTeamChat, send } from '../support/app';

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
  await files.getByRole('button', { name: 'site', exact: true }).click();
  await files.getByRole('button', { name: 'Preview this folder' }).click();

  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel).toContainText(site);
  await panel.getByRole('button', { name: 'Start preview' }).click();
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
    await panel.getByRole('button', { name: 'Start preview' }).click();
    await expect(panel.frameLocator('iframe').locator('body')).toContainText('Written by ' + author);
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
    await panel.getByRole('button', { name: 'Close' }).click();
  }
});

test('a package link shows the command, explains startup failure and cancels a pending start', async ({ page, relay }) => {
  writeFileSync(join(relay.workDir, 'package.json'), '{}');
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await send(page, 'Check the project.\n[project](package.json)');
  const reply = await finishedReply(page, 'Claude');
  await reply.getByRole('button', { name: 'Preview app' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel).toContainText('npm run build');
  await panel.getByLabel('Preview mode').selectOption('server');
  await expect(panel).toContainText('npm start');
  await panel.getByRole('button', { name: 'Start preview' }).click();
  await expect(panel.getByRole('alert')).toContainText('package-lock.json');
  expect(existsSync(join(relay.dataDir, 'preview-runtime-used'))).toBe(false);
  await expect(panel.locator('iframe')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add errors to message' }).click();
  await expect(composer(page)).toHaveValue(/^@Claude /);
  await reply.getByRole('button', { name: 'Preview app' }).click();
  // This transport finishes after Close, as can happen if the response races a cancellation.
  // Check both the abort signal and the deletion of that late result, by its own session id.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.endsWith('/preview') && init?.method === 'POST') {
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
  await panel.getByRole('button', { name: 'Start preview' }).click();
  await expect(panel.getByRole('status')).toBeVisible();
  const cleanup = page.waitForRequest((request) => request.url().endsWith('/preview/late-result') && request.method() === 'DELETE');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await cleanup;
});
