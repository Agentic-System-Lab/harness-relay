import type { Locator, Page } from '@playwright/test';
import type { Conversation } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, replies, send, settled } from '../support/app';
import { chatWith, cli } from '../support/clis';

/*
 * Interactive commands: a command an agent asks the user to run themselves (an <interactive> block,
 * `e2e:interactive` in the fakes), which only the user starts, from its card. On macOS and Linux it runs
 * for real (`/bin/sh`): its output shows the link and the code, what the user types hidden never shows
 * (the program prints it, masked), its password helper asks the card (`e2e:interactive=askpass`), and
 * its masked output goes to the team once the user sends it. On native Windows the card says it cannot
 * run there.
 */

const claude = cli('claude');

/** The card of the command the reply asks the user to run. */
async function proposed(page: Page, directive: string): Promise<Locator> {
  await send(page, `Sign me in ${directive}`);
  const reply = await finishedReply(page, claude.name);
  await expect(reply.locator('.markdown')).not.toContainText('<interactive');
  await expect(reply.getByRole('region', { name: `The command @${claude.name} asks you to run` })).toBeVisible();
  // The chat's one card, wherever later replies put the last one.
  const card = page.getByRole('region', { name: `The command @${claude.name} asks you to run` });
  await expect(card).toContainText('Run a command yourself');
  return card;
}

test.describe('interactive commands', () => {
  test.skip(process.platform === 'win32', 'They do not run on native Windows yet');

  test('the user starts a command an agent asks for, types into it hidden, and sends its masked output to the team', async ({
    page,
    relay,
  }) => {
    const id = await chatWith(page, relay, claude);
    const card = await proposed(page, 'e2e:interactive');
    await expect(card).toContainText('To sign in to the example service.');
    await expect(card).toContainText("outside every agent's sandbox");
    // In an empty folder of its own unless the user chooses the working directory.
    await expect(card.getByRole('radio', { name: 'An empty folder of its own' })).toBeChecked();
    await card.getByRole('button', { name: 'Start', exact: true }).click();

    await expect(card.getByRole('link', { name: /example\.test\/device/ })).toBeVisible();
    await expect(card.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
    await expect(card).toContainText('Password:');
    // It asks for a password: what is typed is hidden until the user says otherwise.
    const hide = card.getByRole('checkbox', { name: 'Hide what I type' });
    await expect(hide).toBeChecked();
    const line = card.getByLabel('A line to type into it');
    await expect(line).toHaveAttribute('type', 'password');
    await line.fill('hunter2-e2e');
    await line.press('Enter');
    await expect(card).toContainText('Got ••••');
    await expect(card).toContainText('Ended (exit code 0)');
    await expect(card).not.toContainText('hunter2-e2e');
    await expect(card.getByLabel('A line to type into it')).toHaveCount(0);

    await card.getByRole('button', { name: 'Send the output to the team' }).click();
    await expect(card).toContainText('Sent to the team');
    await expect(replies(page, claude.name).last()).toContainText(`Thanks, ${claude.name} got your answer`);
    const conv: Conversation = await settled(relay, id);
    const answer = conv.messages.filter((m) => m.author.kind === 'user').at(-1)!;
    const text = answer.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain('Got ••••');
    expect(JSON.stringify(conv)).not.toContain('hunter2-e2e');
  });

  test("its password helper asks the card for a hidden line, as sudo -A's does", async ({ page, relay }) => {
    const id = await chatWith(page, relay, claude);
    const card = await proposed(page, 'e2e:interactive=askpass');
    await card.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(card).toContainText('The program asks, through the password helper:');
    await expect(card).toContainText('Passphrase for the e2e key:');
    const answer = card.getByLabel('Answer (hidden)');
    await expect(answer).toHaveAttribute('type', 'password');
    await answer.fill('open-sesame-e2e');
    await card.getByRole('button', { name: 'Answer', exact: true }).click();
    await expect(card).toContainText('helper got ••••');
    await expect(card).toContainText('Ended (exit code 0)');
    await expect(card).not.toContainText('open-sesame-e2e');
    // Not sent: the team waits, and nothing of it reached the agents.
    await card.getByRole('button', { name: 'Run it again' }).click();
    await expect(card).toContainText('Passphrase for the e2e key:');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toContainText('You cancelled it');
    const conv = await settled(relay, id);
    expect(JSON.stringify(conv)).not.toContain('open-sesame-e2e');
    expect(conv.messages.filter((m) => m.author.kind === 'user')).toHaveLength(1);
  });
});

test('on native Windows the card says it cannot run there', async ({ page, relay }) => {
  test.skip(process.platform !== 'win32', 'Only native Windows refuses them');
  await chatWith(page, relay, claude);
  const card = await proposed(page, 'e2e:interactive');
  await expect(card).toContainText('Commands cannot be run from a card on native Windows yet.');
  await expect(card.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
});
