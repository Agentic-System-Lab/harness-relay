import type { Page } from '@playwright/test';
import type { SandboxSetupView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { homePage } from '../support/app';

/*
 * What the agents' sandboxes lack, asked as New chat opens, and Settings → Sandboxes. What a computer
 * lacks is its own (CI's runners differ), so the server's answers (`GET /api/sandbox-setup`, the
 * install) are the test's: `src/server/sandboxSetup.ts` itself is covered by test/sandbox-setup.test.ts.
 */

const PACKAGES = { kind: 'packages' as const, items: ['bubblewrap', 'socat'], for: ['claude' as const, 'open' as const], command: 'sudo apt-get install -y bubblewrap socat' };

/** Answers the page's questions about the sandboxes' setup with `views` in turn (the last one from then on); records what it was asked to do. */
async function answer(page: Page, views: SandboxSetupView[], installed: SandboxSetupView = views[views.length - 1]!) {
  const asked: string[] = [];
  let i = 0;
  let after: SandboxSetupView | undefined;
  await page.route(/\/api\/sandbox-setup(\/install)?$/, async (route) => {
    const req = route.request();
    asked.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (req.method() === 'POST') {
      after = installed;
      return route.fulfill({ json: { needs: views[0]!.needs, job: { state: 'running', startedAt: Date.now(), log: '$ sudo apt-get install bubblewrap socat\n' } } });
    }
    const view = after ?? views[Math.min(i++, views.length - 1)]!;
    return route.fulfill({ json: view });
  });
  return asked;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Installing what the sandboxes need is strongly recommended' });
const newChat = (page: Page) => page.getByRole('button', { name: 'New chat' }).first().click();

test.describe('what the sandboxes need', () => {
  test.use({ sandboxAsk: true });

  test('New chat asks to install it, strongly recommended; Not now leaves it to Settings → Sandboxes', async ({ page }) => {
    await answer(page, [{ needs: [PACKAGES], admin: 'pkexec' }]);
    await newChat(page);
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d).toContainText('installing it now is strongly recommended');
    await expect(d).toContainText('Linux packages: bubblewrap, socat');
    await expect(d).toContainText('for the sandboxes of Claude Code, the open-source agents');
    await expect(d).toContainText('your system asks for the administrator password in a window of its own');
    await expect(d).toContainText('You can install it any time in Settings → Sandboxes.');
    await expect(d.getByRole('button', { name: 'Install (strongly recommended)' })).toBeVisible();
    await d.getByRole('button', { name: 'Not now' }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();

    // Not asked again in this browser, also after a reload.
    await page.locator('.sidebar').getByRole('link', { name: 'Harness Relay', exact: true }).click();
    await expect(homePage(page)).toBeVisible();
    await newChat(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    // Settings still offers it.
    await page.goto(page.url().replace(/#.*$/, '#/settings/sandboxes'));
    const card = page.locator('#settings-sandboxes');
    await expect(card.getByRole('heading', { name: 'Sandboxes' })).toBeVisible();
    await expect(card).toContainText('Linux packages: bubblewrap, socat');
    await expect(card.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  });

  test('installing from the dialog shows its output, then that the sandboxes have everything', async ({ page }) => {
    const asked = await answer(page, [{ needs: [PACKAGES], admin: 'sudo' }], { needs: [], job: { state: 'success', startedAt: 1, finishedAt: 2, log: '$ sudo apt-get install bubblewrap socat\nok\n' } });
    await newChat(page);
    const d = dialog(page);
    await d.getByRole('button', { name: 'Install (strongly recommended)' }).click();
    await expect(d).toContainText('Installed: the sandboxes have everything they need.');
    expect(asked).toContain('POST /api/sandbox-setup/install');
    await d.locator('footer').getByRole('button', { name: 'Close' }).click();
    await expect(d).toHaveCount(0);
    // Answered: not asked again.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('what cannot be installed here comes with the command to run in a terminal, and no Install', async ({ page }) => {
    await answer(page, [{ needs: [{ ...PACKAGES, blocked: 'admin' }] }]);
    await newChat(page);
    const d = dialog(page);
    await expect(d).toContainText('There is no way to get administrator rights here');
    await expect(d).toContainText('To install it yourself, run this in a terminal:');
    await expect(d.locator('pre')).toHaveText('sudo apt-get install -y bubblewrap socat');
    await expect(d.getByRole('button', { name: 'Install (strongly recommended)' })).toHaveCount(0);
    // Escape closes it for this page only.
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await page.reload();
    await expect(dialog(page)).toBeVisible();
  });

  test('with nothing missing, New chat asks nothing, and Settings says the sandboxes have everything', async ({ page }) => {
    await answer(page, [{ needs: [] }]);
    await newChat(page);
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await page.goto(page.url().replace(/#.*$/, '#/settings/sandboxes'));
    await expect(page.locator('#settings-sandboxes')).toContainText('The sandboxes have everything they need on this computer.');
  });
});
