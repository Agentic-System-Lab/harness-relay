import { expect, test } from '../fixtures';
import { acceptNextDialog, askAndConfirm, chatId, finishedReply, openTeamChat, send, settled, startChat } from '../support/app';

test.describe('the sidebar', () => {
  test("the lead agent sorts a new conversation into the user's group", async ({ page, relay }) => {
    await page.getByRole('button', { name: 'New group' }).click();
    const name = page.getByRole('textbox', { name: 'Group name' });
    await name.fill('Billing');
    await name.press('Enter');
    const group = page.locator('.conv-group', { has: page.locator('.group-name', { hasText: 'Billing' }) });
    await expect(group).toBeVisible();

    await startChat(page, { autoConfirm: true });
    await send(page, 'The Billing export drops the last row');
    await finishedReply(page, 'Claude');
    await expect(group.locator('.conv-link', { hasText: 'The Billing export drops the last row' })).toBeVisible();
    await settled(relay, chatId(page));
  });

  test('a conversation can be renamed and deleted', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Old title');
    await expect(page.locator('.conv-link', { hasText: 'Old title' })).toBeVisible();

    acceptNextDialog(page, 'New title');
    await page.locator('.chat-title').click();
    await expect(page.locator('.chat-title')).toHaveText('New title');
    await expect(page.locator('.conv-link', { hasText: 'New title' })).toBeVisible();

    const item = page.locator('.conv-item', { hasText: 'New title' });
    await item.hover();
    acceptNextDialog(page);
    await item.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(page.locator('.conv-item', { hasText: 'New title' })).toHaveCount(0);
    await expect.poll(async () => (await relay.api<{ id: string }[]>('/api/conversations')).some((c) => c.id === id)).toBe(false);
  });

  test("search finds a conversation by what an agent wrote in it", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'About pelicans');
    await send(page, 'Tell me about pelicans');
    await finishedReply(page, 'Codex');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Something else');

    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel('Search conversations').fill('Hello from Codex');
    const hit = page.locator('.search-hit');
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText('About pelicans');
    await expect(page.getByText('1 conversation matches')).toBeVisible();
    await hit.locator('.conv-link').click();
    await expect(page.locator('.chat-title')).toHaveText('About pelicans');
  });

  test('a conversation started in the UI keeps its title from the first question', async ({ page }) => {
    await startChat(page, { title: 'My named chat' });
    await askAndConfirm(page, 'Anything');
    await finishedReply(page, 'Claude');
    await expect(page.locator('.chat-title')).toHaveText('My named chat');
    await expect(page.locator('.conv-link', { hasText: 'My named chat' })).toBeVisible();
  });
});
