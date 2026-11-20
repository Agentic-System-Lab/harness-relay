import type { Locator, Page } from '@playwright/test';
import { PROVIDERS, type ConversationGroup, type ConversationSummary, type ProviderStatus } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, askAndConfirm, chatId, finishedReply, homePage, openTeamChat, send, settled, startChat } from '../support/app';
import type { RelayServer } from '../support/relay';
import { REPO, REPO_URL } from '../../src/web/star';

/** The star's yellow (`--star` in styles.css). */
const YELLOW = 'rgb(250, 204, 21)';

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
    // The chat that was open is gone: the home page opens.
    await expect(homePage(page)).toBeVisible();
    await expect.poll(async () => (await relay.api<{ id: string }[]>('/api/conversations')).some((c) => c.id === id)).toBe(false);
  });

  test('Search comes first under New chat, and New group, an icon only beside it, still opens the box for a new group', async ({
    page,
  }) => {
    const row = page.locator('.sidebar-actions');
    const buttons = row.getByRole('button');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveAccessibleName('Search');
    await expect(buttons.nth(1)).toHaveAccessibleName('New group');
    const [search, newGroup] = [buttons.nth(0), buttons.nth(1)];
    await expect(search).toHaveText('Search');
    // No words: its name and tooltip say it, a folder with a plus shows it.
    await expect(newGroup).toHaveText('');
    await expect(newGroup).toHaveAttribute('title', 'New group');
    await expect(newGroup.locator('svg')).toBeVisible();
    // Search takes the row but for New group's narrow column, at its right; both the same height.
    const [s, g] = [(await search.boundingBox())!, (await newGroup.boundingBox())!];
    expect(s.x + s.width).toBeLessThan(g.x);
    expect(g.width).toBeLessThan(s.width / 3);
    expect(Math.abs(s.height - g.height)).toBeLessThan(1);

    await newGroup.click();
    const name = page.getByRole('textbox', { name: 'Group name' });
    await expect(name).toBeFocused();
    await name.press('Escape');
    await expect(row).toBeVisible();
    await search.click();
    await expect(page.getByLabel('Search conversations')).toBeFocused();
  });

  test('search finds a conversation by what an agent wrote in it', async ({ page, relay }) => {
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

  test("while its agents reply, a conversation's row shows the app's loader in its state dot's place, and none once they are done", async ({
    page,
    relay,
  }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Busy chat');
    await send(page, 'Take your time e2e:slow=3');
    const dot = row(page, page, 'Busy chat').locator('.status-dot.running');
    // The Logo turning, 12px, centred on the dot's 8px place: the title beside it stays where a dot leaves it.
    await expect(dot.locator('.logo-spinner .logo-dot')).toHaveCount(3);
    const place = await dot.evaluate((d) => {
      const box = d.getBoundingClientRect();
      const spin = d.querySelector('.logo-spinner')!.getBoundingClientRect();
      return {
        width: box.width,
        size: spin.width,
        dx: spin.left + spin.width / 2 - (box.left + box.width / 2),
        dy: spin.top + spin.height / 2 - (box.top + box.height / 2),
      };
    });
    expect(place.width).toBeCloseTo(8, 0);
    expect(place.size).toBeCloseTo(12, 0);
    expect(Math.abs(place.dx)).toBeLessThan(0.5);
    expect(Math.abs(place.dy)).toBeLessThan(0.5);
    await finishedReply(page, 'Claude');
    await expect(dot).toHaveCount(0);
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

  test("the pin in a conversation's top-left corner shows on hover, lists it under Pinned above the groups, the one pinned last first, and unpins it", async ({
    page,
    relay,
  }) => {
    test.setTimeout(90_000);
    const older = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Older chat');
    const newer = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], {}, 'Newer chat');
    const billing = await newGroup(page, 'Billing');
    const other = page.getByRole('region', { name: 'Other', exact: true });
    const pinnedRegion = page.getByRole('region', { name: 'Pinned', exact: true });
    const pinnedAt = async (id: string) =>
      (await relay.api<ConversationSummary[]>('/api/conversations')).find((c) => c.id === id)?.pinnedAt;
    const pin = (scope: Locator, title: string) => row(page, scope, title).locator('.conv-pin');
    await expect(pinnedRegion).toHaveCount(0);

    // Hidden until the pointer is on the conversation; then its middle on the row's top-left corner.
    await page.mouse.move(0, 0);
    await expect(pin(other, 'Older chat')).toHaveCSS('opacity', '0');
    await row(page, other, 'Older chat').hover();
    await expect(pin(other, 'Older chat')).toHaveCSS('opacity', '1');
    const [box, item, title, icon] = await Promise.all([
      pin(other, 'Older chat').boundingBox(),
      row(page, other, 'Older chat').boundingBox(),
      row(page, other, 'Older chat').locator('.conv-title-text').boundingBox(),
      pin(other, 'Older chat').locator('svg').boundingBox(),
    ]);
    expect(Math.abs(box!.x + box!.width / 2 - item!.x)).toBeLessThanOrEqual(6);
    expect(Math.abs(box!.y + box!.height / 2 - item!.y)).toBeLessThanOrEqual(6);
    // Clear of the title, and its icon in the middle of the circle (a button's own padding would push it right).
    expect(box!.x + box!.width).toBeLessThanOrEqual(title!.x + 0.5);
    expect(Math.abs(icon!.x + icon!.width / 2 - (box!.x + box!.width / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(icon!.y + icon!.height / 2 - (box!.y + box!.height / 2))).toBeLessThanOrEqual(0.5);
    // Tilted, in the muted outline, until it is pinned.
    await expect(pin(other, 'Older chat').locator('g')).toHaveAttribute('transform', /rotate\(-45/);
    await expect(pin(other, 'Older chat').locator('svg')).toHaveCSS('fill', 'none');

    await pin(other, 'Older chat').click();
    await expect(row(page, pinnedRegion, 'Older chat')).toBeVisible();
    // Still in its group, its pin shown (filled) without the pointer on it.
    await page.mouse.move(0, 0);
    await expect(row(page, other, 'Older chat')).toBeVisible();
    await expect(pin(other, 'Older chat')).toHaveCSS('opacity', '1');
    await expect(pin(other, 'Older chat')).toHaveAttribute('aria-label', 'Unpin "Older chat"');
    // Upright and yellow once pinned.
    await expect(pin(other, 'Older chat').locator('g')).not.toHaveAttribute('transform', /rotate/);
    await expect(pin(other, 'Older chat').locator('svg')).toHaveCSS('fill', YELLOW);
    await expect.poll(() => pinnedAt(older)).toBeGreaterThan(0);
    // Pinned above the groups.
    const [pinnedBox, billingBox] = await Promise.all([pinnedRegion.boundingBox(), billing.boundingBox()]);
    expect(pinnedBox!.y).toBeLessThan(billingBox!.y);

    // From the keyboard: Tab from the conversation reaches its pin, which shows, and Enter pins it. The one
    // pinned last comes first, whatever was active last; kept by the server.
    await page.mouse.move(0, 0);
    await row(page, other, 'Newer chat').locator('.conv-link').focus();
    await page.keyboard.press('Tab');
    await expect(pin(other, 'Newer chat')).toBeFocused();
    await expect(pin(other, 'Newer chat')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(pinnedRegion.locator('.conv-title-text')).toHaveText(['Newer chat', 'Older chat']);
    await expect.poll(() => pinnedAt(newer)).toBeGreaterThan(0);
    // A pinned row's folder menu is its family's group: moved to Billing elsewhere, then back from Pinned.
    await relay.api(`/api/conversations/${older}/group`, { method: 'PUT', body: { groupId: await groupId(relay, 'Billing') } });
    await page.reload();
    await expect(pinnedRegion.locator('.conv-title-text')).toHaveText(['Newer chat', 'Older chat']);
    expect(await pinnedAt(newer)).toBeGreaterThan((await pinnedAt(older))!);
    await expect(row(page, billing, 'Older chat')).toBeVisible();
    await row(page, pinnedRegion, 'Older chat').hover();
    const move = row(page, pinnedRegion, 'Older chat').locator('.conv-move select');
    await expect(move).toHaveValue(await groupId(relay, 'Billing'));
    await move.selectOption('');
    await expect(row(page, other, 'Older chat')).toBeVisible();
    await expect.poll(() => groupOf(relay, older)).toBeNull();
    await expect(row(page, pinnedRegion, 'Older chat')).toBeVisible();

    // Collapsed from its chevron, also its lower-left corner next to the first row's pin, it shows how
    // many; remembered after a reload; open again.
    const toggle = pinnedRegion.getByRole('button', { name: /Pinned/ });
    const chevron = (await toggle.locator('.group-chevron').boundingBox())!;
    await page.mouse.click(chevron.x + 1, chevron.y + chevron.height - 1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(pinnedRegion.locator('.conv-item')).toHaveCount(0);
    await expect(pinnedRegion.locator('.group-count')).toHaveText('2');
    expect(await pinnedAt(newer)).toBeGreaterThan(0);
    await page.reload();
    await expect(pinnedRegion.locator('.group-count')).toHaveText('2');
    await expect(pinnedRegion.locator('.conv-item')).toHaveCount(0);
    await toggle.click();
    await expect(pinnedRegion.locator('.conv-item')).toHaveCount(2);

    // A pin that fails says so, and the conversation stays as it was.
    await page.route('**/api/conversations/*/pin', (route) => route.fulfill({ status: 500, json: { error: 'disk full' } }));
    const said = new Promise<string>((done) => page.once('dialog', (d) => void d.accept().then(() => done(d.message()))));
    await pinnedRegion.getByRole('button', { name: 'Unpin "Newer chat"' }).click();
    expect(await said).toBe('Could not change the pin: disk full');
    await expect(pinnedRegion.locator('.conv-title-text')).toHaveText(['Newer chat', 'Older chat']);
    await page.unroute('**/api/conversations/*/pin');

    // Unpinned from the Pinned section, or from its group.
    await pinnedRegion.getByRole('button', { name: 'Unpin "Older chat"' }).click();
    await expect(pinnedRegion.locator('.conv-title-text')).toHaveText(['Newer chat']);
    await expect.poll(() => pinnedAt(older)).toBeUndefined();
    await row(page, other, 'Newer chat').hover();
    await other.getByRole('button', { name: 'Unpin "Newer chat"' }).click();
    await expect(pinnedRegion).toHaveCount(0);
    await expect.poll(() => pinnedAt(newer)).toBeUndefined();
    await expect(other.locator('.conv-item')).toHaveCount(2);

    // A pinned conversation deleted leaves Pinned too.
    await row(page, other, 'Older chat').hover();
    await pin(other, 'Older chat').click();
    await expect(pinnedRegion.locator('.conv-title-text')).toHaveText(['Older chat']);
    await row(page, pinnedRegion, 'Older chat').hover();
    acceptNextDialog(page);
    await pinnedRegion.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(pinnedRegion).toHaveCount(0);
    await expect(row(page, other, 'Older chat')).toHaveCount(0);
  });

  test("every CLI's dot and the count fit on one line, the chevron ending at the report icon's edge", async ({ page }) => {
    // Every CLI installed and ready, the widest the line gets ("12/12 ready"), whichever fakes are
    // written yet: the server's answer is changed on the way to the page.
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
          Math.max(...[...svg.querySelectorAll('path')].map((p) => p.getBoundingClientRect().right)) +
          svg.getBoundingClientRect().width / 24;
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
    const layout = (selector: string) =>
      page.locator(selector).evaluate((el) => ({
        icon: el.querySelector('svg')!.getBoundingClientRect().left,
        text: el.querySelector('span')!.getBoundingClientRect().left,
        height: el.getBoundingClientRect().height,
      }));
    expect(await layout('.sidebar-bottom .phone-link')).toEqual(await layout('.sidebar-bottom .settings-link'));
    const dots = await measure();
    expect(dots.overflow).toBe(0);
    expect(Math.abs(dots.firstDot - dots.settingsText)).toBeLessThan(0.5);
    expect(Math.abs(dots.chevron - dots.reportIcon)).toBeLessThan(0.5);

    // With the names, the chevron turned down still ends there (once it has turned).
    await toggle.click();
    await expect(health.locator('a[href="#/settings/antigravity"]')).toContainText('Antigravity');
    await expect.poll(async () => Math.abs((await measure()).chevron - dots.reportIcon)).toBeLessThan(0.5);
  });

  test('the star left of Report a problem asks for a star on GitHub, shows how, and opens the repository in a new tab', async ({
    page,
  }) => {
    // The repository's page is never loaded: the new tab gets an empty page of the test's instead.
    await page.context().route('https://github.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>e2e</title>' }));
    const star = page.locator('.sidebar').getByRole('button', { name: 'Star us on GitHub' });
    const report = page.locator('.sidebar').getByRole('button', { name: 'Report a problem' });
    const [starBox, reportBox] = [await star.boundingBox(), await report.boundingBox()];
    expect(starBox!.x + starBox!.width).toBeLessThanOrEqual(reportBox!.x);
    expect(Math.abs(starBox!.y - reportBox!.y)).toBeLessThan(0.5);
    // Yellow under the mouse.
    await star.hover();
    await expect(star.locator('svg')).toHaveCSS('fill', YELLOW);

    await star.click();
    const dialog = page.getByRole('dialog', { name: 'Give Harness Relay a star' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('please star its repository on GitHub');
    await expect(dialog).toContainText('click Star at the top right');
    // The picture: the repository's page, its Star button pressed a few times by the pointer (with
    // transform and opacity alone), then the pointer resting on Star.
    const picture = dialog.locator('.star-picture');
    await expect(picture).toContainText(`github.com/${REPO}`);
    await expect(picture.locator('.star-picture-button')).toContainText('Star');
    const played = await picture.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => {
        const effect = a.effect as KeyframeEffect;
        const changed = new Set(effect.getKeyframes().flatMap((k) => Object.keys(k)));
        for (const key of ['offset', 'computedOffset', 'easing', 'composite']) changed.delete(key);
        return { name: (a as CSSAnimation).animationName, iterations: effect.getComputedTiming().iterations, changed: [...changed].sort() };
      }),
    );
    expect(played.map((a) => a.name).sort()).toEqual(['star-filled', 'star-off', 'star-on', 'star-pointer']);
    for (const a of played) {
      expect(a.iterations, a.name).toBe(3);
      expect(
        a.changed.every((p) => p === 'transform' || p === 'opacity'),
        `${a.name} changes ${a.changed.join(', ')}`,
      ).toBe(true);
    }

    const link = dialog.getByRole('link', { name: 'Star it on GitHub' });
    await expect(link).toHaveAttribute('href', REPO_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Its star is yellow, filled.
    await expect(link.locator('svg')).toHaveCSS('fill', YELLOW);
    const opened = page.context().waitForEvent('page');
    await link.click();
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(REPO_URL);
    await tab.close();
    await page.bringToFront();
    await expect(dialog.getByRole('status')).toHaveText('Thank you for your support!');
    await dialog.getByRole('button', { name: 'Later' }).click();
    await expect(dialog).toBeHidden();

    // Opened again from the keyboard, it has not thanked the user yet; Escape closes it, and focus goes
    // back to the star (a click focuses no button in WebKit, so the keyboard opens it here).
    await star.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(star).toBeFocused();

    // × and a click beside the dialog close it too.
    await star.click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await star.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
  });

  test('with reduced motion, the star dialog shows the pointer resting on Star, the press not played', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.sidebar').getByRole('button', { name: 'Star us on GitHub' }).click();
    const dialog = page.getByRole('dialog', { name: 'Give Harness Relay a star' });
    await expect(dialog).toBeVisible();
    expect(await dialog.locator('.star-picture').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    const shown = (selector: string) => dialog.locator(selector).evaluate((el) => getComputedStyle(el).opacity);
    expect(await shown('.star-picture-pointer')).toBe('1');
    expect(await shown('.star-picture-off')).toBe('1');
    expect(await shown('.star-picture-on')).toBe('0');
    expect(await shown('.star-picture-filled')).toBe('0');
  });
});
