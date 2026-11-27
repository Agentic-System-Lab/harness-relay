import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { acceptNextDialog } from '../support/app';
import { notInstalledBut } from '../support/fake-cli';
import type { RelayServer } from '../support/relay';
import { withClis } from '../support/clis';

// Codex and Grok besides Claude Code, the one CLI a test server has by default: tests here use them.
withClis('codex', 'grok');

/**
 * Installing a CLI from its card in Settings (`src/server/cliInstall.ts`), with the fake npm
 * (`e2e/fake-cli/fake-npm.cjs`) first on the server's PATH: it installs the CLI's fake into the
 * folder Harness Relay gives it, as npm's global layout would. Its files in `fake-npm/` steer it:
 * `hold` keeps an install under way, `fail` fails it as npm does for a package it cannot find.
 */
function fakeNpm(relay: RelayServer) {
  const dir = join(relay.root, 'fake-npm');
  mkdirSync(dir, { recursive: true });
  return {
    set: (name: 'hold' | 'fail') => writeFileSync(join(dir, name), ''),
    clear: (name: 'hold' | 'fail') => rmSync(join(dir, name), { force: true }),
  };
}

test.describe('installing a CLI from Settings', () => {
  // Claude Code and Codex installed; Copilot and Cline not, as by default; Grok neither, here.
  test.use({ missingClis: notInstalledBut(['codex']) });

  test('installs a CLI that is not found into a folder of its own, and removes it again', async ({ page, relay }) => {
    const npm = fakeNpm(relay);
    const dir = join(relay.dataDir, 'clis', 'copilot');
    await page.goto(`${relay.base}/#/settings/copilot`);
    const card = page.locator('#settings-copilot');
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    // The pill says it once: no "not found" line, nor a link to its website, beside Install.
    await expect(card).not.toContainText('copilot not found');
    await expect(card.getByRole('link', { name: /from its website/ })).toHaveCount(0);
    const install = card.getByRole('button', { name: 'Install Copilot' });
    await expect(install).toBeVisible();
    // Where it goes, but not the command it runs, which shows in its output once it starts.
    const offer = card.locator('.cli-install');
    await expect(offer).toContainText(`Into a folder of Harness Relay's own, ${dir}; you can remove it here later.`);
    await expect(offer).not.toContainText('npm install');

    // Under way: what npm printed so far, and Cancel.
    npm.set('hold');
    await install.click();
    const running = card.locator('.cli-install.running');
    await expect(running).toContainText('Installing Copilot…');
    await expect(running.locator('.cli-install-log')).toContainText(`$ npm install -g --prefix ${dir} @github/copilot`);
    await expect(running.locator('.cli-install-log')).toContainText('npm http fetch GET 200 https://registry.npmjs.org/@github/copilot');
    await expect(running.getByRole('button', { name: 'Cancel install' })).toBeVisible();

    // Settings closed while it installs: the sidebar's dot follows the install all the same.
    await page.goto(`${relay.base}/#/`);
    const dot = page.locator('.provider-health .health.off[href="#/settings/copilot"]');
    await expect(dot).toBeVisible();
    npm.clear('hold');
    await expect(dot).toHaveCount(0, { timeout: 15_000 });
    await page.goto(`${relay.base}/#/settings/copilot`);

    // Installed: the CLI runs from that folder, its card and the sidebar say so, and it can be removed.
    const ours = card.locator('.cli-install.ours');
    await expect(ours).toContainText(`Installed by Harness Relay in ${dir}`);
    await expect(card.locator('.provider-head')).toContainText('v1.0.999');
    await expect(card.locator('.provider-head .pill')).toHaveCount(0);
    await expect(card).not.toContainText('copilot not found');
    const program = process.platform === 'win32' ? join(dir, 'copilot.cmd') : join(dir, 'bin', 'copilot');
    await expect(card.locator('summary', { hasText: 'Executable' })).toContainText(program);
    await expect(page.locator('.provider-health .health.off[href="#/settings/copilot"]')).toHaveCount(0);
    const npmRuns = relay.fakeLog().filter((e) => e.cli === 'npm');
    const cache = join(dir, 'install-cache');
    expect(npmRuns.map((e) => e.args)).toEqual([
      [
        'install',
        '--global',
        '--prefix',
        dir,
        '--cache',
        join(cache, 'npm'),
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
        '@github/copilot',
      ],
    ]);
    // npm's cache was the install's own, and went with it.
    expect(existsSync(cache)).toBe(false);

    // Removed: the folder goes, and the executable path is what it was before (here, a path that is not there).
    acceptNextDialog(page);
    await ours.getByRole('button', { name: 'Remove' }).click();
    await expect(install).toBeVisible();
    await expect(card).toContainText('Removed Copilot');
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    expect(existsSync(dir)).toBe(false);
  });

  test('says why an install failed, leaves nothing behind, and stops one under way', async ({ page, relay }) => {
    const npm = fakeNpm(relay);
    const dir = join(relay.dataDir, 'clis', 'cline');
    await page.goto(`${relay.base}/#/settings/cline`);
    const card = page.locator('#settings-cline');

    npm.set('fail');
    await card.getByRole('button', { name: 'Install Cline' }).click();
    const failed = card.locator('.login-panel.failed');
    await expect(failed).toContainText('Install failed');
    await expect(failed).toContainText(`npm install -g --prefix ${dir} cline@3.0.74 failed (exit 1). Its output is below.`);
    await expect(failed.locator('.login-output pre')).toContainText("'cline@3.0.74' is not in this registry.");
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    expect(existsSync(dir)).toBe(false);

    npm.clear('fail');
    npm.set('hold');
    await card.getByRole('button', { name: 'Try again' }).click();
    const running = card.locator('.cli-install.running');
    await expect(running.locator('.cli-install-log')).toContainText('https://registry.npmjs.org/cline');
    await running.getByRole('button', { name: 'Cancel install' }).click();
    await expect(card).toContainText('Install cancelled; nothing was left behind.');
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(existsSync(dir)).toBe(false);
    npm.clear('hold');
  });

  test("offers a maker's own installer, its bash script on macOS and Linux and its PowerShell one on Windows, without showing its command", async ({
    page,
    relay,
  }) => {
    await page.goto(`${relay.base}/#/settings/grok`);
    const card = page.locator('#settings-grok');
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    // Not clicked: the script is the maker's, on the network.
    await expect(card.getByRole('button', { name: 'Install Grok' })).toBeVisible();
    await expect(card.locator('.cli-install')).toContainText('The installer gets that folder as its home');
    // What it would run, the maker's script for this system, is not shown on the card.
    const command =
      process.platform === 'win32' ? 'irm https://x.ai/cli/install.ps1 | iex' : 'curl -fsSL https://x.ai/cli/install.sh | bash';
    await expect(card.locator('.cli-install')).not.toContainText(command);
    const views = await relay.api<{ provider: string; method: string; command: string }[]>('/api/clis');
    expect(views.find((v) => v.provider === 'grok')).toMatchObject({ method: 'script', command });
    await expect(card).not.toContainText('grok not found');
    await expect(card.getByRole('link', { name: /from its website/ })).toHaveCount(0);
  });
});
