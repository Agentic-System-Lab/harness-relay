/*
 * Publishing a previewed app to the user's own Render and Neon accounts (`src/server/publish/`), against
 * stand-ins for their APIs on this computer (`e2e/support/cloud.ts`: `RELAY_RENDER_API_URL`,
 * `RELAY_NEON_API_URL`) and the fake gh, which makes each private repository as a bare one in the
 * folder the server's git pushes to (`RELAY_PUBLISH_GIT_DIR`). A static preview, which needs no Docker.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test as base } from '../fixtures';
import { chooseChatAction, openTeamChat } from '../support/app';
import { NEON_KEY, RENDER_KEY, startCloud, type FakeCloud } from '../support/cloud';
import type { RelayServer } from '../support/relay';

const test = base.extend<{ cloud: FakeCloud; gitDir: string }>({
  cloud: async ({}, use) => {
    const cloud = await startCloud();
    await use(cloud);
    await new Promise((r) => cloud.server.close(r));
  },
  gitDir: async ({}, use, testInfo) => {
    const dir = testInfo.outputPath('github');
    mkdirSync(dir, { recursive: true });
    await use(dir);
  },
  serverEnv: async ({ cloud, gitDir, serverEnv }, use) =>
    use({ ...serverEnv, RELAY_RENDER_API_URL: cloud.renderUrl, RELAY_NEON_API_URL: cloud.neonUrl, RELAY_PUBLISH_GIT_DIR: gitDir }),
});

/** A static site in the working directory, previewed from Files: the panel, once its page shows. */
async function previewSite(page: Page, relay: RelayServer, heading: string) {
  const site = join(relay.workDir, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), `<!doctype html><title>${heading}</title><h1>${heading}</h1>`);
  await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
  await chooseChatAction(page, 'Files');
  const files = page.getByRole('dialog', { name: 'Files' });
  await files.getByRole('button', { name: 'site', exact: true }).click();
  await files.getByRole('button', { name: 'Preview this folder' }).click();
  const panel = page.getByLabel('App preview', { exact: true });
  await expect(panel.frameLocator('iframe').getByRole('heading')).toHaveText(heading);
  return { panel, site };
}

test('Settings keeps the keys, a static preview publishes in one click, and Settings unpublishes it', async ({
  page,
  relay,
  cloud,
  gitDir,
}) => {
  await page.goto(relay.base + '/#/settings/publish');
  const card = page.locator('#settings-publish');
  const render = card.getByRole('group', { name: 'Render' });
  await render.getByLabel('Render API key').fill('rnd_notTheRightKeyAtAll');
  await render.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('.error-line')).toContainText('The Render API key is not valid');
  await render.getByLabel('Render API key').fill(RENDER_KEY);
  await render.getByRole('button', { name: 'Save' }).click();
  await expect(render).toContainText('Workspace: Relay Test');
  await expect(render).toContainText(`Saved (••••${RENDER_KEY.slice(-4)})`);
  await render.getByLabel('Region').selectOption('singapore');
  const neon = card.getByRole('group', { name: 'Neon' });
  await neon.getByLabel('Neon API key').fill(NEON_KEY);
  await neon.getByRole('button', { name: 'Save' }).click();
  await expect(neon).toContainText('Organization: Relay Test org');
  await expect(card).not.toContainText(RENDER_KEY);
  await expect(card).toContainText('No app has been published yet.');
  // Each box links its setup guide on the website, in the page's language, in a new tab.
  const docs = 'https://agentic-system-lab.github.io/harness-relay/docs/conversations/';
  for (const [box, name, anchor] of [
    [render, 'Set up Render step by step, with screenshots', 'render-setup'],
    [neon, 'Set up Neon step by step, with screenshots', 'neon-setup'],
  ] as const) {
    const link = box.getByRole('link', { name });
    await expect(link).toHaveAttribute('href', `${docs}#${anchor}`);
    await expect(link).toHaveAttribute('target', '_blank');
  }

  const { panel } = await previewSite(page, relay, 'Hello from Relay');
  await panel.getByRole('button', { name: 'Publish…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to the cloud' });
  await expect(dialog).toContainText('A private GitHub repository, relay-test/site');
  await expect(dialog).toContainText('A free Render static site');
  await expect(dialog.getByLabel('Name')).toHaveValue('site');
  const publish = dialog.getByRole('button', { name: 'Publish', exact: true });
  await expect(publish).toBeDisabled();
  await dialog.getByLabel('I understand that anyone with its address can open this app.').check();
  await publish.click();
  // A step under way turns the app's mark: Render's build, which the stand-in reports building until the server's next poll, 5 s later.
  await expect(dialog.locator('.publish-step.build.running .logo-spinner')).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('Live: https://site.onrender.com/', { timeout: 30_000 });
  await expect(dialog.locator('.publish-step .logo-spinner')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'https://site.onrender.com/' })).toHaveAttribute('target', '_blank');
  await expect(dialog.getByRole('link', { name: 'See it on GitHub' })).toHaveAttribute('href', 'https://github.com/relay-test/site');

  // Render made a static site from the private repository, which holds the previewed page alone.
  expect([...cloud.services.values()]).toEqual([
    expect.objectContaining({
      type: 'static_site',
      name: 'site',
      ownerId: 'tea-e2e',
      repo: 'https://github.com/relay-test/site',
      branch: 'main',
      autoDeployTrigger: 'off',
      serviceDetails: { publishPath: '.' },
    }),
  ]);
  expect(cloud.requests.filter((r) => r.path.startsWith('/api/v2/projects'))).toEqual([]);
  const repo = join(gitDir, 'relay-test', 'site.git');
  expect(execFileSync('git', ['--git-dir', repo, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim()).toBe('index.html');
  expect(execFileSync('git', ['--git-dir', repo, 'show', 'main:index.html'], { encoding: 'utf8' })).toContain('Hello from Relay');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Publishing again updates the same site with a new commit.
  await panel.getByRole('button', { name: 'Publish…' }).click();
  await expect(dialog).toContainText('A new commit pushed to relay-test/site, then deployed');
  await expect(dialog.getByLabel('Name')).toHaveCount(0);
  await dialog.getByLabel('I understand that anyone with its address can open this app.').check();
  await dialog.getByRole('button', { name: 'Publish update' }).click();
  await expect(dialog.getByRole('status')).toContainText('Live', { timeout: 30_000 });
  expect(cloud.services.size).toBe(1);
  expect(cloud.requests.filter((r) => r.method === 'POST' && /^\/v1\/services\/[^/]+\/deploys$/.test(r.path))).toHaveLength(1);
  expect(execFileSync('git', ['--git-dir', repo, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).toBe('2');
  await page.keyboard.press('Escape');

  // Settings lists it with its address, and unpublishes it; the repository stays.
  await page.goto(relay.base + '/#/settings/publish');
  const row = card.locator('.publish-app').filter({ hasText: 'site' });
  await expect(row.getByRole('link', { name: 'site', exact: true })).toHaveAttribute('href', 'https://site.onrender.com/');
  await expect(row).toContainText('Live');
  await row.getByRole('button', { name: 'Unpublish' }).click();
  await expect(row).toContainText('Unpublish "site"? Its Render service is deleted');
  await row.getByRole('group', { name: 'Unpublish' }).getByRole('button', { name: 'Unpublish' }).click();
  await expect(card).toContainText('Unpublished. The GitHub repository relay-test/site stays');
  await expect(card).toContainText('No app has been published yet.');
  expect(cloud.services.size).toBe(0);
  expect(existsSync(repo)).toBe(true);
});

test('publishing says what Settings still needs, and refuses files changed since the preview', async ({ page, relay, cloud }) => {
  const { panel, site } = await previewSite(page, relay, 'Before');
  await panel.getByRole('button', { name: 'Publish…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to the cloud' });
  const setup = dialog.getByRole('alert').filter({ hasText: 'Set these up first:' });
  await expect(setup).toContainText("Render's API key");
  await expect(setup.getByRole('link', { name: 'Go to Settings → Publish to the cloud' })).toHaveAttribute('href', '#/settings/publish');
  await dialog.getByLabel('I understand that anyone with its address can open this app.').check();
  await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  // The files change after the preview started: what is published would not be what was tried.
  writeFileSync(join(site, 'index.html'), '<h1>After</h1>');
  await panel.getByRole('button', { name: 'Publish…' }).click();
  await expect(dialog.getByRole('alert')).toContainText("The folder's files changed since the preview started. Rebuild the preview");
  expect(cloud.requests).toEqual([]);
});
