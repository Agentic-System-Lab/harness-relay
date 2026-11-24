import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Send runs with its input. Settings → Secrets and commands lists the names and removes them. Once its
 * code changes, a run waits for the user's approval (on its card, or on the run waiting in the outbox),
 * which runs nothing; a command whose runs publish something (`e2e:publishes`) asks before a try; and a
 * schedule an agent proposes may run a saved command alone (`e2e:propose=command`).
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
    await send(page, 'Set up posting e2e:secret e2e:secreturl=https://developers.example.com/tokens');
    const reply = await finishedReply(page, claude.name);
    await expect(reply.locator('.markdown')).not.toContainText('<secret');
    const card = secretsCard(page);
    await expect(card).toContainText('E2E_TOKEN');
    await expect(card).toContainText('The fake needs it for the e2e check.');
    // The page the agent named: a link for the user's own browser, opened in a new tab.
    await expect(card).toContainText('Where to get it (open it in your own browser):');
    const where = card.getByRole('link', { name: 'https://developers.example.com/tokens' });
    await expect(where).toHaveAttribute('target', '_blank');
    await expect(where).toHaveAttribute('rel', 'noopener noreferrer');
    // The value is masked while it is typed, unless the user shows it.
    const field = card.getByLabel(/E2E_TOKEN/);
    await expect(field).toHaveAttribute('type', 'password');
    await card.getByRole('button', { name: 'Show', exact: true }).click();
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

  test('a proposed fixed command is saved, tried with its input and its secret masked, shared, and run once from the outbox', async ({
    page,
    relay,
  }) => {
    const sandbox = relaySandbox();
    test.skip(process.platform === 'win32', 'Fixed commands do not run on native Windows');
    // Required (CI: E2E_REQUIRE_RELAY_SANDBOX=1): a sandbox that does not work fails it, as e2e/README.md says.
    if (!sandbox.ok && process.env.E2E_REQUIRE_RELAY_SANDBOX === '1')
      throw new Error(
        `Harness Relay's own sandbox is required (E2E_REQUIRE_RELAY_SANDBOX=1), but it does not work here: ${sandbox.reason}`,
      );
    test.skip(!sandbox.ok, `Harness Relay's own sandbox does not run here: ${sandbox.reason}`);
    const claude = cli('claude');
    // A script of the folder's, which the command's code view shows.
    writeFileSync(join(relay.workDir, 'helper.py'), 'print("e2e helper")\n');
    const id = await chatWith(page, relay, claude);
    await send(page, 'Make me a script e2e:secret e2e:command');
    await finishedReply(page, claude.name);
    await giveSecret(page);
    await settled(relay, id);

    const card = commandCard(page);
    await expect(card).toContainText('Fixed command "e2e-check"');
    await expect(card).toContainText('No network');
    // Its code, a file a row, the first open: what Save pins, there to look at.
    await card.getByRole('button', { name: 'Show the code it runs' }).click();
    const script = card.locator('.handoff-code-files > li').filter({ hasText: 'helper.py' });
    await expect(script).toContainText('As it is now');
    await expect(script.locator('details')).toHaveAttribute('open', '');
    await expect(script).toContainText('print("e2e helper")');
    // The code changes while it is open: Save refuses, and the view shows it as it is now, which Save pins next.
    writeFileSync(join(relay.workDir, 'helper.py'), 'print("e2e helper, changed")\n');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.locator('.error-line')).toContainText('Its code changed after it was read');
    await expect(script).toContainText('print("e2e helper, changed")');
    // Save without the code open: it pins the code as it is then.
    await card.getByRole('button', { name: 'Hide the code' }).click();
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card).toContainText('Saved');
    await expect(card.getByRole('button', { name: 'Tell the team it is saved' })).toBeVisible();
    // The box starts with what the agent suggested typing; what the user types instead is what it reads.
    const input = card.getByLabel('Input for this run (optional)');
    await expect(input).toHaveValue('hello from the agent');
    await input.fill('hello from Try it');
    await card.getByRole('button', { name: 'Try it' }).click();
    const result = card.getByRole('status');
    await expect(result).toContainText('Done', { timeout: 60_000 });
    await expect(result).toContainText('E2E_TOKEN=••••');
    await expect(result).toContainText('input: hello from Try it');
    await expect(result).not.toContainText(VALUE);
    // Once it ran, one answer: its result (the agent hears each try at its next turn anyway).
    await expect(card.getByRole('button', { name: 'Tell the team it is saved' })).toHaveCount(0);
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
    // The chat's note says it ran, and shows its output, secrets masked (never "not sent").
    const note = page.locator('.msg-system').filter({ hasText: 'Ran the fixed command "e2e-check" once: done (exit code 0).' });
    await expect(note).toContainText('input: hello from the outbox');
    await expect(note).toContainText('E2E_TOKEN=••••');
    await settled(relay, id);

    // Its code changes after it was saved: it does not run, and the changes are listed a file a row, a
    // line of the file that reads like another file's header staying in it; approving runs it.
    writeFileSync(join(relay.workDir, 'helper.py'), 'print("e2e helper, changed")\n### other.py (as it is now)\nprint("still helper")\n');
    await card.getByRole('button', { name: 'Try it' }).click();
    await expect(card).toContainText('Its code changed', { timeout: 60_000 });
    await card.getByRole('button', { name: 'Show the changes' }).click();
    const changed = card.locator('.handoff-code-files > li');
    await expect(changed.filter({ hasText: 'helper.py' })).toContainText('### other.py (as it is now)');
    await expect(changed.filter({ hasText: 'helper.py' })).toContainText('print("still helper")');
    await expect(changed.locator('summary').filter({ hasText: 'other.py' })).toHaveCount(0);
    // Approving pins the code again and runs nothing: Try it comes back, and runs it.
    await card.getByRole('button', { name: 'Approve the changes' }).click();
    await expect(card).not.toContainText('Its code changed');
    await card.getByRole('button', { name: 'Try it' }).click();
    await expect(card.getByRole('status')).toContainText('Done', { timeout: 60_000 });
    await settled(relay, id);

    // Its code changes again, and the agent puts a run in the outbox: its card says so and offers the
    // approval; Send waits for it (the item stays), then runs it once.
    writeFileSync(join(relay.workDir, 'helper.py'), 'print("e2e helper, third")\n');
    await send(page, 'Post again e2e:commandrun');
    const again = (await finishedReply(page, claude.name))
      .getByRole('region', { name: /Claude/ })
      .filter({ hasText: 'Run the fixed command "e2e-check" once' });
    await expect(again).toContainText("This fixed command's code changed since it was saved or approved", { timeout: 30_000 });
    await expect(again.locator('.handoff-changed')).toContainText('helper.py');
    await again.getByRole('button', { name: 'Send' }).click();
    await expect(again.locator('.error-line')).toContainText('look at the changes on this card and approve them');
    await expect(again).toContainText('Waiting for you');
    await again.getByRole('button', { name: 'Show the changes' }).click();
    await expect(again.locator('.handoff-code-files')).toContainText('print("e2e helper, third")');
    await again.getByRole('button', { name: 'Approve the changes' }).click();
    await expect(again).not.toContainText("This fixed command's code changed");
    await again.getByRole('button', { name: 'Send' }).click();
    await expect(again).toContainText('done (exit code 0)', { timeout: 60_000 });
    await settled(relay, id);
    await expect(page.locator('body')).not.toContainText(VALUE);
  });

  test('a command whose runs publish asks before Try it, and a schedule proposed with it runs it alone once it is saved, with no Send', async ({
    page,
    relay,
  }) => {
    const sandbox = relaySandbox();
    test.skip(process.platform === 'win32', 'Fixed commands do not run on native Windows');
    if (!sandbox.ok && process.env.E2E_REQUIRE_RELAY_SANDBOX === '1')
      throw new Error(
        `Harness Relay's own sandbox is required (E2E_REQUIRE_RELAY_SANDBOX=1), but it does not work here: ${sandbox.reason}`,
      );
    test.skip(!sandbox.ok, `Harness Relay's own sandbox does not run here: ${sandbox.reason}`);
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    // The command and the automation that runs it, in one reply: the automation's card waits for the command to be saved.
    await send(page, 'Make me a posting script, and post every hour e2e:secret e2e:command e2e:publishes e2e:propose=command');
    await finishedReply(page, claude.name);
    // The chat's only proposal (later replies come after it).
    const proposal = page.getByRole('region', { name: /Proposed automation/ });
    await expect(proposal).toContainText('e2e-check');
    await expect(proposal).toContainText('runs alone each time, never the team');
    await expect(proposal).toContainText('The fixed command "e2e-check" is not saved yet');
    await giveSecret(page);
    await settled(relay, id);

    const card = commandCard(page);
    await expect(card).toContainText('This command publishes, posts or sends something');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card).toContainText('Saved');
    // Saved: the automation's card reads the commands again, and warns that it posts with no one asked.
    await expect(proposal).not.toContainText('is not saved yet');
    await expect(proposal).toContainText('without asking you again, and it publishes, posts or sends something');
    // Try it asks first; Cancel runs nothing.
    await card.getByRole('button', { name: 'Try it' }).click();
    await expect(card.getByRole('alert')).toContainText('Trying it really publishes, posts or sends');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card.getByRole('status')).toHaveCount(0);
    await card.getByRole('button', { name: 'Try it' }).click();
    await card.getByRole('button', { name: 'Yes, try it once' }).click();
    await expect(card.getByRole('status')).toContainText('Done', { timeout: 60_000 });
    await settled(relay, id);

    // Created, the automation is kept with the command's id, and only runs it.
    await proposal.getByRole('button', { name: 'Create automation' }).click();
    await expect(proposal).toContainText('Automation created');
    const conv = await relay.api<{ schedule?: { command?: string; commandOnly?: boolean } }>(`/api/conversations/${id}`);
    expect(conv.schedule).toMatchObject({ commandOnly: true });
    expect(conv.schedule?.command).toBeTruthy();

    // A script of the folder's appears after it was saved: its time does not run it, and the chat's note
    // says so with the approval it waits for, which runs nothing and says it is approved.
    writeFileSync(join(relay.workDir, 'post.py'), 'print("post")\n');
    await relay.api(`/api/conversations/${id}/schedule/run`, { body: {} }).catch(() => undefined);
    const note = page.locator('.msg-system.with-card').last();
    await expect(note).toContainText('The automation did not run the fixed command "e2e-check"', { timeout: 30_000 });
    await expect(note.locator('.handoff-changed')).toContainText('post.py');
    await note.getByRole('button', { name: 'Show the changes' }).click();
    await expect(note.locator('.handoff-code-files')).toContainText('print("post")');
    await note.getByRole('button', { name: 'Approve the changes' }).click();
    await expect(note).toContainText('Approved: it runs at its next time');
  });
});
