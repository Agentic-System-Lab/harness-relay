import { GIT_MISSING } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { openNewChat } from '../support/app';

test('offers Git only when an edit action needs it, and preserves the chat form through installation and retry', async ({ page }) => {
  let available = false;
  let installs = 0;
  let attempts = 0;
  await page.route('**/api/conversations', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts++;
    if (available) return route.fallback();
    return route.fulfill({ status: 400, json: { error: 'This action needs Git.', code: GIT_MISSING } });
  });
  await page.route('**/api/git-install', (route) => {
    if (route.request().method() === 'POST') {
      installs++;
      return route.fulfill({ json: { available: false, method: 'linux', job: { state: 'running', startedAt: 1, log: 'Installing git' } } });
    }
    if (installs) available = true;
    return route.fulfill({ json: available ? { available } : { available, method: 'linux' } });
  });

  await openNewChat(page);
  await page.locator('.chat-options > summary').click();
  const dialog = page.getByRole('dialog', { name: 'Git is required' });
  const title = page.getByPlaceholder(/Conversation title/);
  const question = page.getByLabel('What would you like to accomplish?');
  await question.fill('Review this project');
  const start = page.getByRole('button', { name: 'Send question' });
  await expect(dialog).toHaveCount(0);
  await title.fill('Keep this title');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await start.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(title).toHaveValue('Keep this title');
  expect(installs).toBe(0);

  await start.click();
  await dialog.getByRole('button', { name: 'Install Git', exact: true }).click();
  await expect(dialog).toContainText('Git is ready.');
  await dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(title).toHaveValue('Keep this title');
  await expect(question).toHaveValue('Review this project');
  expect(installs).toBe(1);
  expect(attempts).toBe(2);
  await start.click();
  await page.waitForURL(/#\/c\//);
  expect(attempts).toBe(3);
});

test('shows a manual installation command and can check again', async ({ page }) => {
  let ready = false;
  await page.route('**/api/conversations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 400, json: { error: 'This action needs Git.', code: GIT_MISSING } })
      : route.fallback(),
  );
  await page.route('**/api/git-install', (route) =>
    route.fulfill({ json: ready ? { available: true } : { available: false, command: 'sudo apt-get install -y git' } }),
  );
  await openNewChat(page);
  await page.getByLabel('What would you like to accomplish?').fill('Review this project');
  await page.getByRole('button', { name: 'Send question' }).click();
  const dialog = page.getByRole('dialog', { name: 'Git is required' });
  await expect(dialog.getByText('sudo apt-get install -y git')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Install Git', exact: true })).toHaveCount(0);
  ready = true;
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog).toContainText('Git is ready.');
});

test.describe('Git Bash in Settings', () => {
  test.use({ missingClis: ['goose'] });

  test('refreshes the blocked CLI card when Git finishes after the modal was closed', async ({ page, relay }) => {
    let available = false;
    let installing = false;
    await page.route('**/api/clis', (route) =>
      route.fulfill({
        json: [{ provider: 'goose', method: 'script', dir: relay.workDir, ...(available ? {} : { blocked: 'gitBash' }) }],
      }),
    );
    await page.route('**/api/git-install?bash=1', (route) => {
      if (route.request().method() === 'POST') installing = true;
      return route.fulfill({
        json: {
          available,
          method: 'winget',
          ...(installing && !available ? { job: { state: 'running', startedAt: 1, log: 'Installing Git for Windows' } } : {}),
        },
      });
    });

    await page.goto(`${relay.base}/#/settings/goose`);
    const card = page.locator('#settings-goose');
    await card.getByRole('button', { name: 'Install Git', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Git is required' });
    await expect(dialog).toContainText('Bash that comes with Git for Windows');
    await dialog.getByRole('button', { name: 'Install Git', exact: true }).click();
    await expect(dialog).toContainText('Installing Git…');
    await dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    available = true;
    await expect(card.getByRole('button', { name: 'Install Goose', exact: true })).toBeVisible();
  });
});
