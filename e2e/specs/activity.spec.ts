import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, replies, send } from '../support/app';
import { basePermission, chatWith, CLIS, eachCli, listToolAt, needsBelowFull, showsTodo } from '../support/clis';

test.describe('what an agent does on its way to a reply', () => {
  // Each CLI's own tool for the listing (`listTool`), which runs without asking in a read-only chat.
  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: thinking, a tool call and a to-do list are shown with the reply`, async ({ page, relay }) => {
      await chatWith(page, relay, cli);
      await send(page, 'Look around e2e:think e2e:tool e2e:todo');
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('You said: “Look around”.');

      // The steps between two pieces of text fold into a row each (the to-do list stands apart):
      // open them to see each step.
      const groups = reply.locator('details.tool-group');
      await expect(groups.first().locator(':scope > summary')).toContainText(/action|thought|Thinking/);
      for (const summary of await groups.locator(':scope > summary').all()) await summary.click();
      await expect(reply.locator('.thought-title').first()).toContainText(`${cli.name} is thinking`);
      const tool = reply.locator('li.tool', {
        has: page.locator('.tool-name', { hasText: listToolAt(cli, basePermission(cli.provider)) }),
      });
      await expect(tool).toHaveClass(/done/);
      // The tool's output: the working directory's entries.
      await tool.locator('summary').click();
      await expect(tool.locator('.tool-output')).toContainText('README.md');

      const todo = reply.locator('.todo');
      if (!showsTodo(cli)) return void (await expect(todo).toHaveCount(0));
      await expect(todo).toContainText('Plan');
      await expect(todo).toContainText('1 / 3');
      await expect(todo.locator('.todo-item.completed')).toHaveText(/Read the question/);
      await expect(todo.locator('.todo-item.in_progress')).toHaveText(/Write the answer/);
    });
  });

  test("a step in progress shows the app's loader in its row, the Logo turning, and the step's icon once it is done", async ({
    page,
    relay,
  }) => {
    // Codex reports its command before it asks about it: the step runs while the approval card waits.
    needsBelowFull('codex');
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], { permission: 'read-only' });
    await send(page, 'Print a line e2e:approve e2e:slow=4');
    const card = page.getByRole('region', { name: '@Codex wants to run a command' });
    await expect(card).toBeVisible();
    const summary = replies(page, 'Codex').last().locator('details.tool-group > summary');
    await expect(summary).toContainText('Shell');
    await expect(summary.locator('.logo-spinner .logo-dot')).toHaveCount(3);

    // The team design card's turns, from the first moment (no delay) and again and again, on the
    // orbit alone: the dots are in place at once, with none of their spiral in, so that a loader
    // coming and going as steps start and end never flickers.
    const parts = await summary.evaluate((s) =>
      s.getAnimations({ subtree: true }).map((a) => ({
        name: (a as CSSAnimation).animationName,
        on: ((a.effect as KeyframeEffect).target as Element).className,
        delay: a.effect!.getTiming().delay,
        duration: a.effect!.getTiming().duration,
        iterations: a.effect!.getTiming().iterations,
      })),
    );
    expect(parts).toEqual([{ name: 'logo-turn', on: 'logo-motion-orbit', delay: 0, duration: 1900, iterations: Infinity }]);
    const box = (await summary.locator('.logo-spinner').boundingBox())!;
    expect(box.width).toBeCloseTo(14, 0);
    expect(box.height).toBeCloseTo(14, 0);
    const textAt = async () => (await summary.locator('.tool-summary').boundingBox())!.x;
    const runningAt = await textAt();

    // Allowed, the step is done while the reply still streams: its ⚙ in the loader's place (the
    // loader is for a step at work, not for the reply), and the text where it was.
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(summary.locator('.tool-icon')).toHaveText('⚙');
    await expect(summary.locator('.logo-spinner')).toHaveCount(0);
    await expect(replies(page, 'Codex').last().locator('.live-tag')).toBeVisible();
    expect(await textAt()).toBeCloseTo(runningAt, 0);
    const reply = await finishedReply(page, 'Codex');
    await expect(reply.locator('.logo-spinner')).toHaveCount(0);
    await expect(reply.locator('details.tool-group > summary .tool-icon')).toHaveText('⚙');
  });

  test('a reply in Markdown is rendered: heading, list, table and highlighted code', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Summarize e2e:markdown');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply.getByRole('heading', { name: 'Fake findings' })).toBeVisible();
    await expect(reply.getByRole('listitem').filter({ hasText: 'second point' })).toBeVisible();
    await expect(reply.getByRole('table')).toContainText('Claude Code');
    await expect(reply.locator('pre code')).toContainText('const answer = 42;');
  });
});
