import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { cli as cliOf, defaultHome, eachCli, homeIn, SIGNED_IN, withClis } from '../support/clis';
import type { RelayServer } from '../support/relay';

/*
 * Each account's plan usage in Settings, as its CLI reports it without a prompt (Claude Code's
 * `get_usage`, Codex's `account/rateLimits/read`, Grok's `_x.ai/billing`, `muse usage --json`,
 * Copilot's `account.getQuota` on its headless server, Antigravity's `/usage` and `/credits` in print
 * mode, Cursor's plan from `about`). The fakes report 42% used for the default sign-in (e2e@example.com) and 7% for
 * any other account, so that each account shows its own.
 */

/** An account's box in a CLI's card in Settings, by the name it shows. */
const accountBlock = (page: Page, provider: Provider, name: string) =>
  page.locator(`#settings-${provider} .account-block`).filter({ has: page.locator('.account-head strong', { hasText: new RegExp(`^${name}$`) }) });

/** The plan usage of an account's box. */
const usagePanel = (page: Page, provider: Provider, name: string) => accountBlock(page, provider, name).locator('.usage-panel');

/** Adds an account through the API; returns its id and the folder its fake keeps its sign-in in. */
async function apiAccount(relay: RelayServer, provider: Provider, label = 'Work'): Promise<{ id: string; home: string }> {
  const { id } = await relay.api<{ id: string }>(`/api/settings/providers/${provider}/accounts`, { body: { label } });
  return { id, home: join(relay.dataDir, 'accounts', `${provider}-${id}`, ...homeIn(cliOf(provider))) };
}

/** The homes the fakes of `provider` were asked their plan usage in, in order. */
const usageAsked = (relay: RelayServer, provider: Provider) =>
  relay
    .fakeLog()
    .filter((e) => e.cli === provider && e.usage !== undefined)
    .map((e) => e.home);

test.describe('plan usage in Settings', () => {
  eachCli(SIGNED_IN, (cli) => {
    test(`${cli.provider}: the default account shows how much of its plan is left, or why its CLI does not say`, async ({ page, relay }) => {
      await page.goto(`${relay.base}/#/settings/${cli.provider}`);
      const panel = usagePanel(page, cli.provider, 'Default account');
      expect(cli.usage, `e2e/support/clis/${cli.provider}.ts needs its usage fact`).toBeDefined();
      const u = cli.usage!;
      if (u.plan) await expect(panel.locator('.usage-plan')).toHaveText(`Plan: ${u.plan}`);
      if (u.limit) {
        const first = panel.locator('.usage-limit').first();
        await expect(first.locator('.usage-label')).toHaveText(u.limit);
        await expect(first).toContainText(`58% left · ${u.used ?? '42% used'} · resets `);
        await expect(first.getByRole('meter')).toHaveAttribute('aria-valuenow', '42');
        // Asked once, in the account's own home (Copilot: in a home of the question's own, as its sign-in is).
        if (u.inQuestionHome) expect(usageAsked(relay, cli.provider)).toHaveLength(1);
        else expect(usageAsked(relay, cli.provider)).toEqual([defaultHome(relay, cli.provider)]);
      } else {
        await expect(panel.locator('.usage-limit')).toHaveCount(0);
      }
      if (u.note) await expect(panel).toContainText(u.note);
      await expect(panel.locator('.error-line')).toHaveCount(0);
    });
  });

  test.describe(() => {
    withClis('claude');

    test("each account shows its own plan's usage, asked in its own folder, and Check again asks again", async ({ page, relay }) => {
      const work = await apiAccount(relay, 'claude');
      // The fake signs that account in as another address than the default account's.
      mkdirSync(work.home, { recursive: true });
      writeFileSync(join(work.home, 'e2e-account'), 'work@example.com');
      await page.goto(`${relay.base}/#/settings/claude`);

      const main = usagePanel(page, 'claude', 'Default account');
      const mine = usagePanel(page, 'claude', 'Work');
      await expect(main.locator('.usage-limit').first()).toContainText('58% left');
      // Asked once its box is on screen.
      await mine.scrollIntoViewIfNeeded();
      await expect(mine.locator('.usage-limit').first()).toContainText('93% left · 7% used');
      await expect(mine.locator('.usage-limit').nth(1)).toContainText('Weekly limit');
      expect(new Set(usageAsked(relay, 'claude'))).toEqual(new Set([defaultHome(relay, 'claude'), work.home]));

      // Asked again for that account only (the server keeps each answer a while).
      await mine.getByRole('button', { name: 'Check again: the plan usage of "Work"' }).click();
      await expect.poll(() => usageAsked(relay, 'claude').filter((h) => h === work.home).length).toBe(2);
      await expect(mine.getByRole('button', { name: 'Check again: the plan usage of "Work"' })).toBeEnabled();
      expect(usageAsked(relay, 'claude').filter((h) => h === defaultHome(relay, 'claude'))).toHaveLength(1);
    });

    test('an account on an API key says it has no plan limits, and one signed out shows no usage', async ({ page, relay }) => {
      const work = await apiAccount(relay, 'claude');
      await relay.api(`/api/settings/providers/claude/accounts/${work.id}`, { method: 'PUT', body: { apiKey: 'sk-ant-e2e-usage-key-5678' } });
      const out = await apiAccount(relay, 'claude', 'Old');
      mkdirSync(out.home, { recursive: true });
      writeFileSync(join(out.home, 'e2e-signed-out'), '');
      await page.goto(`${relay.base}/#/settings/claude`);

      const keyed = usagePanel(page, 'claude', 'Work');
      await keyed.scrollIntoViewIfNeeded();
      await expect(keyed).toContainText('This account runs on an API key');
      await expect(keyed.locator('.usage-limit')).toHaveCount(0);
      await expect(accountBlock(page, 'claude', 'Old').locator('.pill')).toHaveText('Not signed in');
      await expect(usagePanel(page, 'claude', 'Old')).toHaveCount(0);
    });
  });
});
