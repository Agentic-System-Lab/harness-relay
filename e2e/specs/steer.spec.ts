import { expect, test } from '../fixtures';
import { chooseChatAction, composer, finishedReply, replies, settled } from '../support/app';
import { chatWith, cli, eachCli } from '../support/clis';

/*
 * Steering (Team settings' "Send messages into running turns while the team works"): a message sent while
 * a member works goes into its running turn, when its CLI can take one, and is marked so; with steering
 * off it waits in the queue for the next turn. The fakes of Claude Code (a user message on its input)
 * and Codex (`turn/steer`) take one; their `e2e:steer` step waits for it, then says what it heard.
 */
test.describe('steering', () => {
  eachCli([cli('claude'), cli('codex')], (c) => {
    test(`${c.provider}: with steering on, a message sent while the member works goes into its running turn`, async ({ page, relay }) => {
      const id = await chatWith(page, relay, c, { steer: true });
      await composer(page).fill('Work on it e2e:steer=20');
      await composer(page).press('Enter');
      await expect(replies(page, c.name).last().locator('.live-tag')).toBeVisible();
      await expect(composer(page)).toHaveAttribute('placeholder', 'Add to the discussion… (goes into the running turn when it can)');
      // Its answer is out, and its turn waits: the CLI's turn runs, and can take a message.
      await expect(replies(page, c.name).last()).toContainText('You said: “Work on it”.');

      await composer(page).fill('Also check the docs');
      await composer(page).press('Enter');
      const sent = page.locator('.msg-user').filter({ hasText: 'Also check the docs' });
      await expect(sent.locator('.steered-tag')).toHaveText(`Sent into @${c.name}'s turn`);
      await expect(page.locator('.queue-tray')).toHaveCount(0);

      const reply = await finishedReply(page, c.name);
      await expect(reply).toContainText('I also heard: “Also check the docs”.');
      // It was answered in that turn: no other run for it.
      const conv = await settled(relay, id);
      expect(conv.messages.filter((m) => m.author.kind === 'agent')).toHaveLength(1);
      expect(conv.messages.find((m) => m.steered)?.steered).toEqual(['m1']);
    });
  });

  eachCli([cli('claude')], (c) => {
    test(`${c.provider}: with steering off (the default), it waits in the queue and the next turn answers it`, async ({ page, relay }) => {
      const id = await chatWith(page, relay, c);
      await composer(page).fill('Work on it e2e:steer=3');
      await composer(page).press('Enter');
      await expect(replies(page, c.name).last().locator('.live-tag')).toBeVisible();
      await expect(composer(page)).toHaveAttribute('placeholder', 'Add to the discussion… (delivered before the next turn)');

      await composer(page).fill('Also check the docs');
      await composer(page).press('Enter');
      await expect(page.locator('.queue-tray')).toContainText('Also check the docs');

      await expect(replies(page, c.name)).toHaveCount(2, { timeout: 30_000 });
      await expect(replies(page, c.name).first()).not.toContainText('I also heard');
      await expect(await finishedReply(page, c.name)).toContainText('You said: “Also check the docs”.');
      const sent = page.locator('.msg-user').filter({ hasText: 'Also check the docs' });
      await expect(sent.locator('.queued-tag')).toHaveText('Added mid-reply');
      await settled(relay, id);
    });

    test(`${c.provider}: steering is switched on in Team settings while the team replies`, async ({ page, relay }) => {
      await chatWith(page, relay, c);
      await composer(page).fill('Work on it e2e:steer=20');
      await composer(page).press('Enter');
      await expect(replies(page, c.name).last()).toContainText('You said: “Work on it”.');
      await expect(replies(page, c.name).last().locator('.live-tag')).toBeVisible();

      await chooseChatAction(page, 'Team settings');
      const drawer = page.getByRole('dialog', { name: 'Team settings' });
      const box = drawer.getByRole('checkbox', { name: 'Send messages into running turns while the team works' });
      await expect(box).not.toBeChecked();
      await box.check();
      await expect(drawer).toContainText('goes into the turn of the member speaking now');
      await drawer.getByRole('button', { name: 'Save' }).click();
      await expect(drawer).toHaveCount(0);

      await composer(page).fill('Also check the docs');
      await composer(page).press('Enter');
      await expect(page.locator('.msg-user').filter({ hasText: 'Also check the docs' }).locator('.steered-tag')).toBeVisible();
      await expect(await finishedReply(page, c.name)).toContainText('I also heard: “Also check the docs”.');
    });
  });
});
