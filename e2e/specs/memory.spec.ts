import type { Page } from '@playwright/test';
import type { MemoryView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, send, settled } from '../support/app';
import { chatOf, chatWith, cli, eachHalf, teamOf } from '../support/clis';
import type { RelayServer } from '../support/relay';

/*
 * Long-term memory, an experiment in Settings → Labs that is off until the user turns it on (the tests
 * that use it turn it on first, `on()`): a note an agent saves in its reply (a <remember> block,
 * `e2e:remember`) comes out of its text into a card, is listed in Settings → Labs → Long-term memory,
 * and is given to the agents of a later chat (`e2e:recall` says which notes a turn was given). The card
 * and Settings set notes aside, restore and pin them, and Tidy up now has the lead agent tidy them (the
 * fake lead agent pins the first note not pinned yet: `tidyReply` in e2e/fake-cli/lib/plan.cjs).
 */

const NOTE = 'I deploy with the blue-green script';

/** Turns long-term memory on, as its switch in Labs does. */
const on = (relay: RelayServer) => relay.api('/api/memory/settings', { method: 'PUT', body: { enabled: true } });

/** Settings → Labs → Long-term memory. */
const labsMemory = (page: Page) => page.getByRole('region', { name: 'Labs' }).getByRole('group', { name: 'Long-term memory' });

eachHalf((half) =>
  test(
    half.title("a note each CLI saves leaves its reply's text for a card, and a later chat's agents are given it"),
    async ({ page, relay }) => {
      const TEAM = teamOf(half.clis);
      await on(relay);
      const first = await chatOf(
        page,
        relay,
        TEAM.map((c) => ({ cli: c })),
      );
      await send(page, `${NOTE} e2e:remember`);
      for (const m of TEAM) {
        const reply = await finishedReply(page, m.name);
        await expect(reply).toContainText(`You said: “${NOTE}”.`);
        await expect(reply.locator('.markdown')).not.toContainText('<remember');
        const card = reply.getByRole('region', { name: 'Long-term memory' });
        await expect(card).toContainText(NOTE);
        await expect(card).toContainText('In use');
      }
      await settled(relay, first);
      // Each member saved the same note: it is kept once.
      const view = await relay.api<MemoryView>('/api/memory');
      expect(view.notes).toHaveLength(1);
      expect(view.notes[0]).toMatchObject({ text: NOTE, basis: 'user', state: 'active', author: { kind: 'agent' } });

      // A later chat's agents are given it with a question it bears on.
      const later = await chatOf(
        page,
        relay,
        TEAM.map((c) => ({ cli: c })),
      );
      await send(page, 'Which script do I deploy with? e2e:recall');
      for (const m of TEAM) await expect(await finishedReply(page, m.name)).toContainText(`My long-term memory: “${NOTE}”.`);
      await settled(relay, later);
    },
  ),
);

test.describe('long-term memory', () => {
  test('a note is set aside and restored from its card, pinned in Settings, and tidied by the lead agent', async ({ page, relay }) => {
    await on(relay);
    await relay.api('/api/memory/notes', { method: 'POST', body: { text: 'Answer in short sentences.' } });
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    await send(page, 'The release day is Friday e2e:remember');
    const card = (await finishedReply(page, claude.name)).getByRole('region', { name: 'Long-term memory' });
    await expect(card).toContainText('The release day is Friday');
    await card.getByRole('button', { name: 'Set aside' }).click();
    await expect(card).toContainText('Set aside');
    await card.getByRole('button', { name: 'Restore' }).click();
    await expect(card).toContainText('In use');
    await settled(relay, id);

    await page.goto(`${relay.base}/#/settings/labs`);
    const memory = labsMemory(page);
    const agents = memory.locator('.memory-row', { hasText: 'The release day is Friday' });
    await expect(agents).toContainText('You said it');
    await expect(agents).toContainText(`By @${claude.name} (${claude.label})`);
    const mine = memory.locator('.memory-row', { hasText: 'Answer in short sentences.' });
    await expect(mine).toContainText('By you');
    await mine.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(mine.getByRole('button', { name: 'Unpin' })).toBeVisible();

    // The fake lead agent pins the first note an agent wrote that is not pinned yet.
    await memory.getByRole('button', { name: 'Tidy up now' }).click();
    await expect(memory.getByRole('status')).toContainText('The fake lead agent read 2 notes.');
    await expect(agents.getByLabel('Pinned by the lead agent')).toBeVisible();
    const view = await relay.api<MemoryView>('/api/memory');
    expect(view.notes.map((n) => n.pinned).sort()).toEqual(['lead', 'user']);
    expect(view.lastTidy).toMatchObject({ changes: 1 });

    // Pinned notes come with every conversation, whatever it is about.
    const later = await chatWith(page, relay, claude);
    await send(page, 'Hello there e2e:recall');
    const reply = await finishedReply(page, claude.name);
    await expect(reply).toContainText('“The release day is Friday”');
    await expect(reply).toContainText('“Answer in short sentences.”');
    await settled(relay, later);
  });

  test('is off until turned on in Labs: no note saved, no card, and Labs shows only its switch', async ({ page, relay }) => {
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    await send(page, 'Plain question e2e:recall');
    let reply = await finishedReply(page, claude.name);
    await expect(reply).toContainText('I have no long-term memory notes.');
    await expect(reply.getByRole('region', { name: 'Long-term memory' })).toHaveCount(0);
    await settled(relay, id);
    // A reply that writes a note while memory is off saves nothing, and shows no card.
    await send(page, 'The release day is Friday e2e:remember');
    reply = await finishedReply(page, claude.name);
    await expect(reply).toContainText('You said: “The release day is Friday”.');
    await expect(reply.getByRole('region', { name: 'Long-term memory' })).toHaveCount(0);
    await settled(relay, id);
    expect((await relay.api<MemoryView>('/api/memory')).notes).toEqual([]);

    // Not in the Tool library any more: in Labs, its explanation and its switch, off.
    await page.goto(`${relay.base}/#/settings/tools`);
    await expect(page.locator('#settings-tools').getByRole('group', { name: 'Long-term memory', exact: true })).toHaveCount(0);
    await page.goto(`${relay.base}/#/settings/labs`);
    const memory = labsMemory(page);
    const enabled = memory.getByRole('checkbox', { name: 'Let agents read and save long-term memory' });
    await expect(enabled).not.toBeChecked();
    await expect(memory.getByRole('button', { name: 'Add a note' })).toHaveCount(0);
    await expect(memory.getByRole('button', { name: 'Tidy up now' })).toHaveCount(0);
    // Turned on, the rest shows, and it is kept (the switch follows the server's answer).
    await enabled.click();
    await expect(enabled).toBeChecked();
    await expect(memory.getByRole('button', { name: 'Add a note' })).toBeVisible();
    await expect(memory.getByRole('button', { name: 'Tidy up now' })).toBeVisible();
    expect((await relay.api<MemoryView>('/api/memory')).settings.enabled).toBe(true);
    await page.reload();
    await expect(enabled).toBeChecked();
  });
});
