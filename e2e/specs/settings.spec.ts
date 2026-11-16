import type { Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { askAndConfirm, finishedReply, openTeamChat, replies, send, startChat } from '../support/app';
import { chatWith, CLIS, eachCli, faked, member, OPEN, SIGNED_IN, withClis, withEveryCli } from '../support/clis';
import { notInstalledBut } from '../support/fake-cli';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('a CLI that is not signed in', () => {
  eachCli(SIGNED_IN, (cli) => {
    test.describe(() => {
      test.use({ serverEnv: { E2E_FAKE_SIGNED_OUT: cli.provider } });

      test(`${cli.provider}: shows as signed out in Settings and the sidebar, and its reply says why`, async ({ page, relay }) => {
        // Another CLI stays signed in.
        const other = SIGNED_IN.find((c) => c.provider === (cli.provider === 'claude' ? 'codex' : 'claude'))!;
        await expect(page.locator(`.provider-health a[href="#/settings/${cli.provider}"]`)).toHaveAttribute('title', `${cli.label} · Not signed in`);
        await expect(page.locator(`.provider-health a[href="#/settings/${other.provider}"]`)).toHaveAttribute('title', new RegExp(`^${escape(other.label)} · Signed in`));
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
    for (const c of SIGNED_IN.filter((x) => x.provider === 'cursor' || x.provider === 'antigravity')) {
      await expect(page.locator(`.provider-health .health.off[href="#/settings/${c.provider}"]`)).toHaveAttribute('title', `${c.label} · Not installed`);
      await expect(page.locator(`#settings-${c.provider} .provider-head .pill`)).toHaveText('Not installed');
    }
  });
});

test.describe('an open agent without a model backend', () => {
  test.use({ openBackend: false });
  withClis(...faked(OPEN).slice(0, 1).map((c) => c.provider));

  test('is not ready, and its turn says to set one up', async ({ page, relay }) => {
    const cli = faked(OPEN)[0];
    test.skip(!cli, 'no open agent has a fake written yet');
    await expect(page.locator(`.provider-health a[href="#/settings/${cli!.provider}"]`)).toHaveAttribute('title', `${cli!.label} · No model backend yet`);
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
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
        await expect(page.locator(`.provider-health .health.off[href="#/settings/${cli.provider}"]`)).toHaveAttribute('title', `${cli.label} · Not installed`);
      }
      const dots = SIGNED_IN.length + faked(OPEN).length;
      await expect(page.locator('.provider-health .health')).toHaveCount(dots);
      // Dots alone on one line, with how many are ready; their names beside them when asked for, kept after a reload.
      const toggle = page.locator('.provider-health .health-toggle');
      await expect(toggle).toHaveText(`${faked(CLIS).length}/${dots} ready`);
      const nameWidth = async () => (await page.locator('.provider-health a[href="#/settings/grok"] .health-name').boundingBox())?.width ?? 0;
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
    await expect(nav.getByRole('link')).toHaveText(['Version', 'Language', 'Appearance', 'Notifications', 'Sandboxes', 'Model backends', 'Lead agent', 'Tools', 'Voice', 'Default folder', 'Agent sessions', 'Shares', 'Browsers', 'Tour']);
    await expect(agents).toHaveText('Agents');
    await expect(agents).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toHaveCount(0);

    // Opened: every agent, the open-source ones under their heading, the focus on the first.
    await agents.click();
    await expect(agents).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['Claude Code', 'Codex', 'Grok', 'Cursor', 'Antigravity', 'Copilot', 'Muse Code', 'OpenCode', 'Goose', 'Cline', 'OpenHands', 'Pi']);
    await expect(menu.getByText('Open-source agents')).toBeVisible();
    await expect(items.first()).toBeFocused();
    // The keys move in it, round the ends; Escape closes it back to its button.
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(agents).toBeFocused();
    // ArrowUp on the button opens it at the last one; Tab closes it and goes on to the next link.
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Lead agent' })).toBeFocused();

    // An agent chosen: its card, its address, and the button naming it, highlighted.
    await agents.click();
    await items.filter({ hasText: 'Codex' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(/#\/settings\/codex$/);
    await expect(page.locator('#settings-codex')).toBeInViewport();
    await expect(agents).toHaveText('Agents: Codex');
    await expect(agents).toHaveClass(/active/);
    // Reopened, the agent being read is marked and has the focus.
    await agents.click();
    await expect(items.filter({ hasText: 'Codex' })).toHaveAttribute('aria-current', 'location');
    await expect(items.filter({ hasText: 'Codex' })).toBeFocused();
    // A click elsewhere (here the screen's bottom right, clear of the menu) closes it.
    const view = page.viewportSize()!;
    await page.mouse.click(view.width - 20, view.height - 20);
    await expect(menu).toHaveCount(0);

    // Another card's link: the button no longer names an agent.
    await nav.getByRole('link', { name: 'Lead agent' }).click();
    await expect(nav.getByRole('link', { name: 'Lead agent' })).toHaveAttribute('aria-current', 'location');
    await expect(agents).toHaveText('Agents');
    await expect(agents).not.toHaveClass(/active/);

    // An address of an agent's card, as the sidebar's dots link to: the card, and the button naming it.
    await page.goto(page.url().replace(/#.*$/, '#/settings/opencode'));
    await expect(page.locator('#settings-opencode')).toBeInViewport();
    await expect(agents).toHaveText('Agents: OpenCode');
  });

  test("on a phone, the agents' button shows whole, its menu opens inside the screen, also while the row scrolls to it, and leads to the card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Reached by an agent's address: once the links make room for the menu button (the row narrows), the button naming it shows whole.
    await page.goto(page.url().replace(/#.*$/, '#/settings/codex'));
    const nav = page.getByRole('navigation', { name: 'Sections of this page' });
    const row = nav.locator('.settings-nav-links');
    const agents = nav.getByRole('button', { name: /^Agents/ });
    await expect(agents).toHaveText('Agents: Codex');
    await expect(nav).toHaveClass(/stuck/);
    const whole = async () => {
      const r = (await row.boundingBox())!;
      const b = (await agents.boundingBox())!;
      return b.x >= r.x && b.x + b.width <= r.x + r.width;
    };
    await expect.poll(whole).toBe(true);

    // Clicked while scrolled out of view: the row brings it in, and the menu stays open, under it, inside the screen.
    await row.evaluate((el) => (el.scrollLeft = 0));
    expect(await whole()).toBe(false);
    await agents.click();
    const menu = page.getByRole('menu', { name: 'Agents' });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(500);
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const button = (await agents.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThan(button.y + button.height);
    await menu.getByRole('menuitem', { name: 'Pi', exact: true }).click();
    await expect(page.locator('#settings-pi')).toBeInViewport();
    await expect(agents).toHaveText('Agents: Pi');
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
    await expect(page.getByText(/the lead agent \(Codex\)/).first()).toBeVisible();

    await startChat(page);
    await askAndConfirm(page, 'Who picks the team? e2e:team=grok');
    await expect(page.locator('.plan-card').last()).toContainText('Lead agent: Codex');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Who picks the team?”.');
    // The lead agent's prompt went to the fake codex.
    expect(relay.fakeLog().some((e) => e.cli === 'codex' && e.prompt?.includes('Choose the team that answers it'))).toBe(true);
  });
});
