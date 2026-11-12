import type { Locator, Page } from '@playwright/test';
import { PROVIDERS, type ConversationGroup, type ConversationSummary, type ProviderStatus } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, askAndConfirm, chatId, finishedReply, openTeamChat, send, settled, startChat } from '../support/app';
import type { RelayServer } from '../support/relay';

/** Makes a group in the sidebar, as the user does, and returns its section. */
async function newGroup(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'New group' }).click();
  const field = page.getByRole('textbox', { name: 'Group name' });
  await field.fill(name);
  await field.press('Enter');
  const group = page.getByRole('region', { name, exact: true });
  await expect(group).toBeVisible();
  return group;
}

/** A conversation's row in the sidebar, or in one of its groups, by its whole title. */
const row = (page: Page, scope: Page | Locator, title: string) =>
  scope.locator('.conv-item').filter({ has: page.locator('.conv-title-text').getByText(title, { exact: true }) });

/** The group the server keeps the conversation in (null: Other). */
const groupOf = async (relay: RelayServer, id: string) =>
  (await relay.api<ConversationSummary[]>('/api/conversations')).find((c) => c.id === id)?.groupId ?? null;

const groupId = async (relay: RelayServer, name: string) =>
  (await relay.api<ConversationGroup[]>('/api/groups')).find((g) => g.name === name)!.id;

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

  test('a conversation dragged into a group is kept there, and dragged out goes back to Other', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Invoice totals');
    const billing = await newGroup(page, 'Billing');
    const other = page.getByRole('region', { name: 'Other', exact: true });
    await expect(billing).toContainText('Drag conversations here');
    const billingId = await groupId(relay, 'Billing');

    await row(page, other, 'Invoice totals').dragTo(billing);
    await expect(row(page, billing, 'Invoice totals')).toBeVisible();
    await expect(other).toContainText('Drag conversations here');
    await expect.poll(() => groupOf(relay, id)).toBe(billingId);
    // Kept by the server: still there after a reload.
    await page.reload();
    await expect(row(page, billing, 'Invoice totals')).toBeVisible();

    await row(page, billing, 'Invoice totals').dragTo(other);
    await expect(row(page, other, 'Invoice totals')).toBeVisible();
    await expect(billing).toContainText('Drag conversations here');
    await expect.poll(() => groupOf(relay, id)).toBeNull();
  });

  test("a branched conversation's family moves between groups as one", async ({ page, relay }) => {
    const trunk = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Trunk');
    await send(page, 'Start here');
    const reply = await finishedReply(page, 'Codex');
    await settled(relay, trunk);
    await reply.hover();
    await reply.getByRole('button', { name: 'Branch conversation' }).click();
    await expect.poll(() => chatId(page)).not.toBe(trunk);
    const branch = chatId(page);
    const billing = await newGroup(page, 'Billing');
    const other = page.getByRole('region', { name: 'Other', exact: true });
    const billingId = await groupId(relay, 'Billing');
    const groups = () => Promise.all([groupOf(relay, trunk), groupOf(relay, branch)]);

    // Dragging the branch takes the conversation it came from along, the branch still under it.
    await row(page, other, 'Branch · Trunk').dragTo(billing);
    await expect(billing.locator('.conv-item')).toHaveCount(2);
    await expect(row(page, billing.locator('.conv-children'), 'Branch · Trunk')).toBeVisible();
    await expect(other).toContainText('Drag conversations here');
    await expect.poll(groups).toEqual([billingId, billingId]);

    // Dragging the original out takes its branch along.
    await row(page, billing, 'Trunk').dragTo(other);
    await expect(other.locator('.conv-item')).toHaveCount(2);
    await expect(billing).toContainText('Drag conversations here');
    await expect.poll(groups).toEqual([null, null]);
  });
  test("every CLI's dot and the count fit on one line, the chevron ending at the report icon's edge", async ({ page }) => {
    // Every CLI installed and ready, the widest the line gets ("10/10 ready"). The e2e server has no
    // Cursor, Antigravity or open agent, so its answer is changed on the way to the page.
    await page.route('**/api/providers*', async (route) => {
      const res = await route.fetch();
      const list = (await res.json()) as ProviderStatus[];
      await route.fulfill({ response: res, json: list.map((p) => ({ ...p, installed: true, auth: { ...p.auth, loggedIn: true } })) });
    });
    await page.reload();
    const health = page.locator('.provider-health');
    await expect(health.locator('a.health')).toHaveCount(PROVIDERS.length);
    const toggle = health.locator('.health-toggle');
    await expect(toggle).toHaveText(`${PROVIDERS.length}/${PROVIDERS.length} ready`);

    // Where each drawn line ends: an icon's paths, plus half their stroke (1 of the icon's 24 units).
    const measure = () =>
      page.evaluate(() => {
        const row = document.querySelector('.provider-health') as HTMLElement;
        const end = (svg: Element) =>
          Math.max(...[...svg.querySelectorAll('path')].map((p) => p.getBoundingClientRect().right)) + svg.getBoundingClientRect().width / 24;
        const settings = document.querySelector('.settings-link') as HTMLElement;
        return {
          overflow: row.scrollWidth - row.clientWidth,
          chevron: end(document.querySelector('.health-toggle svg')!),
          reportIcon: end(document.querySelector('.report-button svg')!),
          firstDot: document.querySelector('.provider-health .health i')!.getBoundingClientRect().left,
          settingsText: settings.getBoundingClientRect().left + parseFloat(getComputedStyle(settings).paddingLeft),
        };
      });

    // The dots alone: one line, nothing cut off; the first dot under Settings' ⚙, the chevron's tip
    // at the right edge of the report icon under it.
    const dots = await measure();
    expect(dots.overflow).toBe(0);
    expect(Math.abs(dots.firstDot - dots.settingsText)).toBeLessThan(0.5);
    expect(Math.abs(dots.chevron - dots.reportIcon)).toBeLessThan(0.5);

    // With the names, the chevron turned down still ends there (once it has turned).
    await toggle.click();
    await expect(health.locator('a[href="#/settings/antigravity"]')).toContainText('Antigravity');
    await expect.poll(async () => Math.abs((await measure()).chevron - dots.reportIcon)).toBeLessThan(0.5);
  });
});
