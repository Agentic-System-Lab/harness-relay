import { PROVIDERS, type Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, openToolCategory, replies, send, startChat, confirmTeam } from '../support/app';
import { chatWith, CLIS, eachCli, faked, member, OPEN, SIGNED_IN, withClis, withEveryCli } from '../support/clis';
import { notInstalledBut } from '../support/fake-cli';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('Apps and tools is one section with bookmarkable tabs that preserve drafts', async ({ page, relay }) => {
  await page.goto(relay.base + '/#/settings');
  const nav = page.getByRole('navigation', { name: 'Sections of this page' });
  const entry = nav.getByRole('link', { name: 'Apps and tools', exact: true });
  await entry.click();
  const card = page.getByRole('region', { name: 'Apps and tools' });
  const common = card.getByRole('tab', { name: 'Common apps', exact: true });
  const tools = card.getByRole('tab', { name: 'Tool library', exact: true });
  await expect(common).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByRole('tabpanel')).toHaveCount(1);
  await common.press('End');
  await expect(page).toHaveURL(/#\/settings\/tools$/);
  await expect(tools).toBeFocused();
  await expect(entry).toHaveAttribute('aria-current', 'location');
  const memory = await openToolCategory(page, 'Memory');
  const field = memory.getByRole('textbox', { name: 'Memory: All members' });
  await field.fill('Unfinished draft');
  await common.click();
  await expect(field).toBeHidden();
  await page.goBack();
  await expect(tools).toBeFocused();
  await expect(tools).toHaveAttribute('aria-selected', 'true');
  await expect(field).toHaveValue('Unfinished draft');
  await page.reload();
  await expect(card.getByRole('tabpanel', { name: 'Tool library' })).toBeInViewport();
  await expect(entry).toHaveAttribute('aria-current', 'location');
  await tools.press('ArrowLeft');
  await expect(common).toBeFocused();
  const rows = card.getByRole('tabpanel', { name: 'Common apps' }).locator('.common-apps .app-row');
  await expect(rows).toHaveCount(10);
  const groups = card.locator('.common-apps > section');
  const categories = [
    ['Mail and calendar', ['Mail', 'Calendar']],
    ['Team messaging', ['Microsoft Teams', 'Slack']],
    ['Documents and notes', ['Google Drive', 'Notion', 'Heptabase', 'Obsidian']],
    ['Development and browsing', ['GitHub', 'Browser']],
  ] as const;
  await expect(groups.locator('h4')).toHaveText(categories.map(([name]) => name));
  for (const [name, apps] of categories) {
    await expect(card.getByRole('region', { name, exact: true }).locator('.app-row-copy > strong:visible')).toHaveText([...apps]);
  }
  // Device and account tools can be selected for a chat from their service row.
  for (const name of ['Mail', 'Calendar', 'GitHub', 'Obsidian', 'Browser']) {
    await expect(rows.and(page.getByRole('listitem', { name, exact: true })).locator('.app-chat-access')).toHaveCount(1);
  }
  // Hosted apps offer account management. Direct actions need a grant before showing their own assistant selector.
  for (const name of ['Google Drive', 'Microsoft Teams', 'Slack', 'Notion', 'Heptabase']) {
    await expect(rows.and(page.getByRole('listitem', { name, exact: true })).locator('.app-chat-access')).toHaveCount(0);
  }
  await expect(page.locator('#settings-tools .app-chat-access')).toHaveCount(0);
});

test.describe('assistant setup on a fresh installation', () => {
  test.use({ missingClis: PROVIDERS, lang: 'zh-TW', signIn: false });

  test('waits for assistant status and opens the first setup choices', async ({ page, relay }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/api\/providers(?:\?|$)/, async (route) => {
      await gate;
      await route.continue();
    });
    const overview = page.locator('#settings-overview');
    try {
      await page.goto(`${relay.base}/#code=${await relay.newSignInCode()}`);
      await page.getByRole('link', { name: /設定與登入/ }).click();
      await expect(overview.getByRole('heading', { name: '可用的 AI 助理' })).toBeInViewport();
      await expect(overview.getByRole('status')).toHaveText('檢查中…');
      await expect(overview.getByText('需要安裝')).toHaveCount(0);
    } finally {
      release();
    }
    const setup = overview.getByRole('link', { name: /^Codex (需要安裝|查看安裝需求)$/ });
    await expect(setup).toBeVisible();
    await setup.press('Enter');
    await expect(page.locator('#settings-codex .section-title a')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#settings-codex :focus')).toHaveCount(1);
    await expect(page.locator('#settings-codex')).toBeInViewport();
  });
});

test.describe('a CLI that is not signed in', () => {
  eachCli(SIGNED_IN, (cli) => {
    test.describe(() => {
      test.use({ serverEnv: { E2E_FAKE_SIGNED_OUT: cli.provider } });

      test(`${cli.provider}: shows as signed out in Settings and the sidebar, and its reply says why`, async ({ page, relay }) => {
        // Another CLI stays signed in.
        const other = SIGNED_IN.find((c) => c.provider === (cli.provider === 'claude' ? 'codex' : 'claude'))!;
        await expect(page.locator(`.provider-health a[href="#/settings/${cli.provider}"]`)).toHaveAttribute(
          'title',
          `${cli.label} · Not signed in`,
        );
        await expect(page.locator(`.provider-health a[href="#/settings/${other.provider}"]`)).toHaveAttribute(
          'title',
          new RegExp(`^${escape(other.label)} · Signed in`),
        );
        await page.getByRole('link', { name: /Settings & sign-in/ }).click();
        const card = page.locator(`#settings-${cli.provider}`);
        const head = card.locator('.account-block').first().locator('.account-head');
        await expect(head).toContainText('Not signed in');
        // Nothing of the CLI's own words after it (Codex's "Not logged in"). (Elsewhere on the card,
        // a CLI whose models it asks for may say why it could not list them.)
        if (cli.signedOutError) await expect(head).not.toContainText(cli.signedOutError);
        await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

        await openTeamChat(page, relay, [member(cli)]);
        await send(page, 'Anyone there?');
        if (cli.signedOutError) await expect(replies(page, cli.name).last().locator('.msg-error')).toContainText(cli.signedOutError);
        else await expect(replies(page, cli.name).last().locator('.msg-error')).not.toBeEmpty();
      });
    });
  });
});

test.describe('a CLI that is not installed', () => {
  // Left out, as they are by default (the CLIs installed are Claude Code, Codex and Grok).
  test.use({ missingClis: [...new Set<Provider>([...notInstalledBut(), 'cursor', 'antigravity'])] });

  test('shows so in Settings and the sidebar', async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const overview = page.locator('#settings-overview');
    await expect(overview).toBeInViewport();
    await expect(overview.getByRole('link', { name: 'Claude Code Ready' })).toBeVisible();
    const cursor = overview.getByRole('link', { name: /^Cursor (Needs installation|View install requirements)$/ });
    await expect(cursor).toBeHidden();
    await overview.getByText('Connect another assistant').click();
    await cursor.click();
    await expect(page.locator('#settings-cursor')).toBeInViewport();
    for (const c of SIGNED_IN.filter((x) => x.provider === 'cursor' || x.provider === 'antigravity')) {
      await expect(page.locator(`.provider-health .health.off[href="#/settings/${c.provider}"]`)).toHaveAttribute(
        'title',
        `${c.label} · Not installed`,
      );
      await expect(page.locator(`#settings-${c.provider} .provider-head .pill`)).toHaveText('Not installed');
    }
  });
});

test.describe('an open agent without a model backend', () => {
  test.use({ openBackend: false });
  withClis(
    ...faked(OPEN)
      .slice(0, 1)
      .map((c) => c.provider),
  );

  test('is not ready, and its turn says to set one up', async ({ page, relay }) => {
    const cli = faked(OPEN)[0];
    test.skip(!cli, 'no open agent has a fake written yet');
    await expect(page.locator(`.provider-health a[href="#/settings/${cli!.provider}"]`)).toHaveAttribute(
      'title',
      `${cli!.label} · No model backend yet`,
    );
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const overview = page.locator('#settings-overview');
    await overview.getByText('Connect another assistant').click();
    await overview.getByRole('link', { name: `${cli!.label} Set up a model backend` }).press('Enter');
    await expect(page.locator('#settings-backends .section-title a')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#settings-backends :focus')).toHaveCount(1);
    await expect(page.locator('#settings-backends')).toBeInViewport();
    const card = page.locator(`#settings-${cli!.provider}`);
    await expect(card.locator('.provider-head .pill')).toHaveText('Not ready');
    await expect(card).toContainText('No model backend set up yet (Settings → Model backends)');

    await chatWith(page, relay, cli!);
    await send(page, 'Anyone there?');
    await expect(replies(page, cli!.name).last().locator('.msg-error')).toContainText(`${cli!.label} has no model.`);
  });
});

test.describe('settings', () => {
  // Every CLI installed: the others' tests leave all but Claude Code, Codex, Grok and their own out.
  test.describe(() => {
    withEveryCli();

    test('each CLI is found, with its version, and signed in', async ({ page }) => {
      await page.getByRole('link', { name: /Settings & sign-in/ }).click();
      await expect(page.getByRole('heading', { name: 'Settings & sign-in', level: 1 })).toBeVisible();
      // Each CLI whose fake is written, with its version: signed in, or for an open agent ready on the
      // test's fake endpoint. Those whose fake is not written yet are not installed here.
      for (const cli of CLIS) {
        const card = page.locator(`#settings-${cli.provider}`);
        await expect(card.locator('.provider-head')).toContainText(cli.label);
        if (!cli.implemented) {
          await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
          continue;
        }
        await expect(card.locator('.provider-head')).toContainText(cli.version);
        if (cli.open) await expect(card.locator('.provider-head .pill')).toHaveText('Ready');
        else await expect(card).toContainText('Signed in');
      }
      await expect(page.locator('#settings-claude')).toContainText('e2e@example.com');
      // The sidebar's health dots say the same; the open agents get a dot only once installed.
      for (const cli of faked(CLIS)) {
        const dot = page.locator(`.provider-health .health.ok[href="#/settings/${cli.provider}"]`);
        await expect(dot).toBeVisible();
        if (cli.open) await expect(dot).toHaveAttribute('title', `${cli.label} · Model backends set up`);
      }
      for (const cli of SIGNED_IN.filter((c) => !c.implemented)) {
        await expect(page.locator(`.provider-health .health.off[href="#/settings/${cli.provider}"]`)).toHaveAttribute(
          'title',
          `${cli.label} · Not installed`,
        );
      }
      const dots = SIGNED_IN.length + faked(OPEN).length;
      await expect(page.locator('.provider-health .health')).toHaveCount(dots);
      // Dots alone on one line, with how many are ready; their names beside them when asked for, kept after a reload.
      const toggle = page.locator('.provider-health .health-toggle');
      await expect(toggle).toHaveText(`${faked(CLIS).length}/${dots} ready`);
      const nameWidth = async () =>
        (await page.locator('.provider-health a[href="#/settings/grok"] .health-name').boundingBox())?.width ?? 0;
      expect(await nameWidth()).toBeLessThanOrEqual(1);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.provider-health a[href="#/settings/grok"]')).toContainText('Grok');
      await expect.poll(nameWidth).toBeGreaterThan(10);
      await page.reload();
      await expect(page.locator('.provider-health .health-toggle')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  test("a CLI's executable path can be set, and a wrong one shows it as missing", async ({ page }) => {
    await page.goto(page.url().replace(/#.*$/, '#/settings/grok'));
    const card = page.locator('#settings-grok');
    // Loaded first: the box shows the saved path once the settings come.
    await expect(card.locator('.provider-head')).toContainText('v1.0.999');
    await card.locator('summary', { hasText: 'Executable' }).click();
    const bin = card.getByRole('textbox', { name: 'Executable' });
    await bin.fill('/no/such/grok');
    await bin.press('Enter');
    await expect(card.locator('.provider-head .pill')).toHaveText('Not installed');
    await expect(card).toContainText('/no/such/grok');

    await bin.fill('');
    await bin.press('Enter');
    await expect(card.locator('.provider-head')).toContainText('v1.0.999');
  });

  test("the links row gathers the agents in one menu, which leads to each agent's card and names the one being read", async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const nav = page.getByRole('navigation', { name: 'Sections of this page' });
    const agents = nav.getByRole('button', { name: /^Agents/ });
    const menu = page.getByRole('menu', { name: 'Agents' });
    // One entry for the twelve agents' cards, where their links were; the other links as they were.
    await expect(nav.getByRole('link')).toHaveText([
      'Overview',
      'Version',
      'Language',
      'Appearance',
      'Notifications',
      'Sandboxes',
      'Model backends',
      'Lead agent',
      'Apps and tools',
      'Voice',
      'Default folder',
      'Agent sessions',
      'Shares',
      'Browsers',
      'Connect your phone',
      'Tour',
    ]);
    await expect(agents).toHaveAccessibleName('Agents');
    await expect(agents).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);

    // Opened: every agent, the open-source ones in a group under their heading, the focus on the first.
    await agents.click();
    await expect(agents).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([
      'Claude Code',
      'Codex',
      'Grok',
      'Cursor',
      'Antigravity',
      'Copilot',
      'Muse Code',
      'OpenCode',
      'Goose',
      'Cline',
      'OpenHands',
      'Pi',
    ]);
    await expect(menu.getByRole('group', { name: 'Open-source agents' }).getByRole('menuitem')).toHaveText([
      'OpenCode',
      'Goose',
      'Cline',
      'OpenHands',
      'Pi',
    ]);
    await expect(items.first()).toBeFocused();
    // The keys move in it, round the ends; Escape closes it back to its button.
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(agents).toBeFocused();
    // ArrowUp on the button opens it at the last one; Tab closes it and goes on to the next link, Shift+Tab back to the button.
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Lead agent' })).toBeFocused();
    await agents.focus();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(menu).toHaveCount(0);
    await expect(agents).toBeFocused();

    // A click on its heading leaves its keys working; the focus moving elsewhere closes it.
    await agents.click();
    await menu.getByText('Open-source agents').click();
    await expect(menu).toBeVisible();
    // The focus stays on the item that had it.
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await agents.click();
    await nav.getByRole('link', { name: 'Tools' }).focus();
    await expect(menu).toHaveCount(0);

    // An agent chosen: its card, its address, and the button naming it, highlighted.
    await agents.click();
    await items.filter({ hasText: 'Codex' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(/#\/settings\/codex$/);
    await expect(page.locator('#settings-codex')).toBeInViewport();
    await expect(agents).toHaveAccessibleName('Agents: Codex');
    await expect(agents).toHaveClass(/active/);
    // Reopened, the agent being read is marked and has the focus.
    await agents.click();
    await expect(items.filter({ hasText: 'Codex' })).toHaveAttribute('aria-current', 'location');
    await expect(items.filter({ hasText: 'Codex' })).toBeFocused();
    // A click elsewhere (here the screen's bottom right, clear of the menu) closes it.
    const view = page.viewportSize()!;
    await page.mouse.click(view.width - 20, view.height - 20);
    await expect(menu).toHaveCount(0);

    // Another card's link: the button no longer names an agent, and keeps its width, so the links after it stay put.
    const leadLink = nav.getByRole('link', { name: 'Lead agent' });
    const leadAt = (await leadLink.boundingBox())!.x;
    await leadLink.click();
    await expect(leadLink).toHaveAttribute('aria-current', 'location');
    await expect(agents).toHaveAccessibleName('Agents');
    await expect(agents).not.toHaveClass(/active/);
    expect(Math.abs((await leadLink.boundingBox())!.x - leadAt)).toBeLessThanOrEqual(1);

    // An address of an agent's card, as the sidebar's dots link to: the card, and the button naming it.
    await page.goto(page.url().replace(/#.*$/, '#/settings/opencode'));
    await expect(page.locator('#settings-opencode')).toBeInViewport();
    await expect(agents).toHaveAccessibleName('Agents: OpenCode');
  });

  test("in a short window the agents' menu stays inside it, and the keys show the item they reach", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    // At the top of the page, where the links sit lower than once stuck.
    await page.goto(page.url().replace(/#.*$/, '#/settings'));
    const agents = page.getByRole('navigation', { name: 'Sections of this page' }).getByRole('button', { name: /^Agents/ });
    await agents.click();
    const menu = page.getByRole('menu', { name: 'Agents' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(480);
    // End reaches Pi: the menu scrolls to show it, inside the window.
    await page.keyboard.press('End');
    const pi = menu.getByRole('menuitem', { name: 'Pi', exact: true });
    await expect(pi).toBeFocused();
    const shown = (await pi.boundingBox())!;
    expect(shown.y).toBeGreaterThanOrEqual(box.y);
    expect(shown.y + shown.height).toBeLessThanOrEqual(box.y + box.height);
    // Home back to the first, shown too.
    await page.keyboard.press('Home');
    const first = (await menu.getByRole('menuitem').first().boundingBox())!;
    expect(first.y).toBeGreaterThanOrEqual(box.y);
  });

  test("on a phone, the agents' button shows whole, its menu stays inside the screen and with its button, and leads to the card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Reached by an agent's address: once the links make room for the menu button (the row narrows), the button naming it shows whole.
    await page.goto(page.url().replace(/#.*$/, '#/settings/codex'));
    const nav = page.getByRole('navigation', { name: 'Sections of this page' });
    const row = nav.locator('.settings-nav-links');
    const agents = nav.getByRole('button', { name: /^Agents/ });
    const menu = page.getByRole('menu', { name: 'Agents' });
    await expect(agents).toHaveAccessibleName('Agents: Codex');
    await expect(nav).toHaveClass(/stuck/);
    const whole = async (el: typeof agents) => {
      const r = (await row.boundingBox())!;
      const b = (await el.boundingBox())!;
      return b.x >= r.x - 1 && b.x + b.width <= r.x + r.width + 1;
    };
    await expect.poll(() => whole(agents)).toBe(true);

    // Tab out of the menu: the next link, brought into view.
    await agents.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Tab');
    const lead = nav.getByRole('link', { name: 'Lead agent' });
    await expect(lead).toBeFocused();
    await expect.poll(() => whole(lead)).toBe(true);

    // The button at the row's right end (partly out of it): the menu opens inside the screen.
    await row.evaluate((el) => (el.scrollLeft = 0));
    await agents.dispatchEvent('click');
    await expect(menu).toBeVisible();
    let box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // The row scrolled while it is open: it stays open, and moves with its button.
    await row.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const b = (await agents.boundingBox())!;
        const m = (await menu.boundingBox())!;
        return Math.round(m.x) === Math.round(Math.max(8, Math.min(b.x, 390 - m.width - 8)));
      })
      .toBe(true);
    box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThan((await agents.boundingBox())!.y);
    await menu.getByRole('menuitem', { name: 'Pi', exact: true }).click();
    await expect(page.locator('#settings-pi')).toBeInViewport();
    await expect(agents).toHaveAccessibleName('Agents: Pi');
  });

  test("the agents' menu moves with its button as the links stick beside the collapsed sidebar's button", async ({ page }) => {
    // A wide window with the sidebar collapsed: its button sits in the corner, and the links make room for it once they come up to it.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.goto(page.url().replace(/#.*$/, '#/settings'));
    const nav = page.getByRole('navigation', { name: 'Sections of this page' });
    const agents = nav.getByRole('button', { name: /^Agents/ });
    await expect(nav).not.toHaveClass(/stuck/);
    await agents.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Agents' });
    await expect(menu).toBeVisible();
    const before = (await agents.boundingBox())!.x;
    // The page scrolled a little (the wheel leaves the focus in the menu): the links stick and shift right, without scrolling sideways.
    await page.mouse.move(450, 800);
    await page.mouse.wheel(0, 200);
    await expect(nav).toHaveClass(/stuck/);
    await expect.poll(async () => (await agents.boundingBox())!.x).toBeGreaterThan(before + 10);
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const b = (await agents.boundingBox())!;
        const m = (await menu.boundingBox())!;
        return Math.abs(m.x - Math.max(8, Math.min(b.x, 900 - m.width - 8))) <= 1;
      })
      .toBe(true);
  });

  test('the language can be switched, and the choice is kept', async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const languages = page.locator('#settings-language');
    await languages.getByRole('radio', { name: '繁體中文' }).click();
    await expect(page.getByRole('heading', { name: '設定與登入', level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '設定與登入', level: 1 })).toBeVisible();
    await languages.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings & sign-in', level: 1 })).toBeVisible();
  });

  test('another CLI can be the lead agent', async ({ page, relay }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const lead = page.locator('#settings-lead');
    await lead.getByRole('radio', { name: 'Codex' }).click();
    await lead.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(lead).toContainText('Lead agent saved');
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(page.getByText(/Codex will choose a team/)).toBeVisible();

    await startChat(page, 'Who picks the team? e2e:team=grok');
    await confirmTeam(page);
    await expect(page.locator('.plan-card').last()).toContainText('Lead agent: Codex');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Who picks the team?”.');
    // The lead agent's prompt went to the fake codex.
    expect(relay.fakeLog().some((e) => e.cli === 'codex' && e.prompt?.includes('Choose the team that answers it'))).toBe(true);
  });
});
