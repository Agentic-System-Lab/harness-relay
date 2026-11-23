import type { Page } from '@playwright/test';
import type { FolderHandoffs } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, replies, send, settled } from '../support/app';
import { chatWith, cli, relaySandbox } from '../support/clis';

/*
 * Secrets and fixed commands (docs/architecture.md, "Secrets and fixed commands"): a reply's <secret>
 * block (`e2e:secret`) comes out of its text into a card where the user gives the value, which is kept
 * for the working directory and never shown again; a <command> block (`e2e:command`) proposes a fixed
 * command the user saves and tries, which Harness Relay runs in its own sandbox with the secret in a
 * file, its output masked; a <command-run> block (`e2e:commandrun`) puts one run in the outbox, which
 * Send runs with its input. Settings → Secrets and commands lists the names and removes them.
 */

const VALUE = 'tok-e2e-9f8e7d6c';

const secretsCard = (page: Page) => replies(page, 'Claude').getByRole('region', { name: 'Secrets @Claude asks for' }).last();
const commandCard = (page: Page) => replies(page, 'Claude').getByRole('region', { name: 'A fixed command @Claude proposes' }).last();

/** Gives the value on the latest secrets card, and waits for the team to take the answer. */
async function giveSecret(page: Page) {
  const card = secretsCard(page);
  await card.getByLabel(/E2E_TOKEN/).fill(VALUE);
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).toContainText('Saved');
  await expect(page.locator('.msg-user').last()).toContainText('I gave E2E_TOKEN');
}

test.describe('secrets and fixed commands', () => {
  test('a secret asked for in a reply is given on its card, never shown again, and listed by name in Settings', async ({ page, relay }) => {
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    await send(page, 'Set up posting e2e:secret');
    const reply = await finishedReply(page, claude.name);
    await expect(reply.locator('.markdown')).not.toContainText('<secret');
    const card = secretsCard(page);
    await expect(card).toContainText('E2E_TOKEN');
    await expect(card).toContainText('The fake needs it for the e2e check.');
    // The value is masked while it is typed, unless the user shows it.
    const field = card.getByLabel(/E2E_TOKEN/);
    await expect(field).toHaveAttribute('type', 'password');
    await card.getByRole('button', { name: 'Show' }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await giveSecret(page);
    await settled(relay, id);
    // Nowhere on the page nor in what the server sends of the chat.
    await expect(page.locator('body')).not.toContainText(VALUE);
    expect(JSON.stringify(await relay.api(`/api/conversations/${id}`))).not.toContain(VALUE);

    const view = await relay.api<{ folders: FolderHandoffs[] }>('/api/handoffs');
    expect(view.folders.flatMap((f) => f.secrets.map((s) => s.name))).toEqual(['E2E_TOKEN']);
    expect(JSON.stringify(view)).not.toContain(VALUE);
    await page.goto(`${relay.base}/#/settings/handoffs`);
    const settingsCard = page.locator('#settings-handoffs');
    await expect(settingsCard).toContainText('E2E_TOKEN');
    page.once('dialog', (d) => void d.accept());
    await settingsCard.getByRole('button', { name: 'Remove' }).click();
    await expect(settingsCard).toContainText('No working directory keeps secrets or fixed commands yet.');
  });

  test('a proposed fixed command is saved, tried with its secret masked, shared, and run once from the outbox', async ({ page, relay }) => {
    const sandbox = relaySandbox();
    test.skip(process.platform === 'win32' || !sandbox.ok, `Harness Relay's own sandbox does not run here: ${sandbox.reason}`);
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    await send(page, 'Make me a script e2e:secret e2e:command');
    await finishedReply(page, claude.name);
    await giveSecret(page);
    await settled(relay, id);

    const card = commandCard(page);
    await expect(card).toContainText('Fixed command "e2e-check"');
    await expect(card).toContainText('No network');
    // Save pins the code it runs: it is looked at first.
    await card.getByRole('button', { name: 'Show the code it runs' }).click();
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card).toContainText('Saved');
    await card.getByRole('button', { name: 'Try it' }).click();
    const result = card.getByRole('status');
    await expect(result).toContainText('Done', { timeout: 60_000 });
    await expect(result).toContainText('E2E_TOKEN=••••');
    await expect(result).not.toContainText(VALUE);
    await card.getByRole('button', { name: 'Send the result to the team' }).click();
    await expect(page.locator('.msg-user').last()).toContainText('E2E_TOKEN=••••');
    await settled(relay, id);

    await send(page, 'Post it e2e:commandrun');
    const outbox = (await finishedReply(page, claude.name))
      .getByRole('region', { name: /Claude/ })
      .filter({ hasText: 'Run the fixed command "e2e-check" once' });
    await expect(outbox).toContainText('hello from the outbox');
    await outbox.getByRole('button', { name: 'Send' }).click();
    await expect(outbox).toContainText('done (exit code 0)', { timeout: 60_000 });
    await settled(relay, id);
    await expect(page.locator('body')).not.toContainText(VALUE);
  });
});
