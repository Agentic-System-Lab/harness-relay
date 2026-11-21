import type { MemoryView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, openToolCategory, send, settled } from '../support/app';
import { chatOf, chatWith, cli, eachHalf, teamOf } from '../support/clis';

/*
 * Long-term memory: a note an agent saves in its reply (a <remember> block, `e2e:remember`) comes out
 * of its text into a card, is listed in Settings → Apps and tools → Tool library → Long-term memory,
 * and is given to the agents of a later chat (`e2e:recall` says which notes a turn was given). The card
 * and Settings set notes aside, restore and pin them, and Tidy up now has the lead agent tidy them (the
 * fake lead agent pins the first note not pinned yet: `tidyReply` in e2e/fake-cli/lib/plan.cjs).
 */

const NOTE = 'I deploy with the blue-green script';

eachHalf((half) =>
  test(
    half.title("a note each CLI saves leaves its reply's text for a card, and a later chat's agents are given it"),
    async ({ page, relay }) => {
      const TEAM = teamOf(half.clis);
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

    await page.goto(`${relay.base}/#/settings/tools`);
    const memory = await openToolCategory(page, 'Long-term memory');
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

  test('a reply that saves nothing has no card, and nothing is saved while memory is off', async ({ page, relay }) => {
    await relay.api('/api/memory/settings', { method: 'PUT', body: { enabled: false } });
    const claude = cli('claude');
    const id = await chatWith(page, relay, claude);
    await send(page, 'Plain question e2e:recall');
    const reply = await finishedReply(page, claude.name);
    await expect(reply).toContainText('I have no long-term memory notes.');
    await expect(reply.getByRole('region', { name: 'Long-term memory' })).toHaveCount(0);
    await settled(relay, id);
    expect((await relay.api<MemoryView>('/api/memory')).notes).toEqual([]);
  });
});
