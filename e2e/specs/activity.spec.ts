import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send } from '../support/app';
import { chatWith, CLIS, eachCli } from '../support/clis';

test.describe("what an agent does on its way to a reply", () => {
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
      const tool = reply.locator('li.tool', { has: page.locator('.tool-name', { hasText: cli.listTool }) });
      await expect(tool).toHaveClass(/done/);
      // The tool's output: the working directory's entries.
      await tool.locator('summary').click();
      await expect(tool.locator('.tool-output')).toContainText('README.md');

      const todo = reply.locator('.todo');
      await expect(todo).toContainText('Plan');
      await expect(todo).toContainText('1 / 3');
      await expect(todo.locator('.todo-item.completed')).toHaveText(/Read the question/);
      await expect(todo.locator('.todo-item.in_progress')).toHaveText(/Write the answer/);
    });
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
