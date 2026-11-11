import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { acceptNextDialog, askAndConfirm, finishedReply, openTeamChat, send, startChat } from '../support/app';

test.describe('files and changes', () => {
  test('in edit mode an agent changes files, and the chat shows what changed', async ({ page, relay }) => {
    await startChat(page, { permission: 'edit' });
    await askAndConfirm(page, 'Write the plan down e2e:write=notes/plan.md');
    const reply = await finishedReply(page, 'Claude');
    await expect(reply).toContainText('I wrote notes/plan.md.');

    // The file is in the working directory, which became a git repository for the snapshots.
    expect(readFileSync(join(relay.workDir, 'notes', 'plan.md'), 'utf8')).toBe('Written by Claude (Claude Code).\n');
    expect(existsSync(join(relay.workDir, '.git'))).toBe(true);

    const changes = reply.locator('.changes-card');
    await expect(changes).toContainText('Changed 1 file');
    await expect(changes.locator('.changes-files')).toContainText('notes/plan.md');
    await changes.getByRole('button', { name: "View this turn's diff" }).click();
    const diff = page.getByRole('dialog', { name: "@Claude's changes this turn" });
    await expect(diff).toContainText('Written by Claude (Claude Code).');
    await diff.getByRole('button', { name: 'Close' }).click();
    await expect(diff).toBeHidden();
  });

  // A read-only chat as each CLI is set up for it: Claude Code without its file tools, Codex in its
  // read-only sandbox (it may ask to write), Grok asking and Harness Relay refusing, or the user.
  for (const cli of [
    { name: 'Claude', provider: 'claude', asks: false },
    { name: 'Codex', provider: 'codex', asks: true },
    { name: 'Grok', provider: 'grok', asks: true },
  ] as const) {
    test(`${cli.provider}: in a read-only chat no file is written`, async ({ page, relay }) => {
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }]);
      await send(page, 'Write it e2e:write=out.txt');
      if (cli.asks) {
        const card = page.getByRole('region', { name: `@${cli.name} wants to change files` });
        await card.getByRole('button', { name: 'Decline' }).click();
      }
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('I may not write out.txt here.');
      await expect(reply.locator('.changes-card')).toHaveCount(0);
      if (!cli.asks) await expect(reply.locator('.approval-done')).toHaveCount(0);
      expect(existsSync(join(relay.workDir, 'out.txt'))).toBe(false);
    });
  }

  test('grok: a read-only chat that refuses automatically says why', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], { approvals: 'deny' });
    await send(page, 'Write it e2e:write=out.txt');
    const reply = await finishedReply(page, 'Grok');
    await expect(reply).toContainText('I may not write out.txt here.');
    await reply.locator('details.tool-group > summary').first().click();
    await expect(reply.locator('.tool-error')).toHaveText('Not allowed in read-only mode; Grok was told to use read-only tools');
    expect(existsSync(join(relay.workDir, 'out.txt'))).toBe(false);
  });

  test('every CLI writes in edit mode, and each turn records its own change', async ({ page, relay }) => {
    await openTeamChat(
      page,
      relay,
      [
        { name: 'Claude', provider: 'claude' },
        { name: 'Codex', provider: 'codex' },
        { name: 'Grok', provider: 'grok' },
      ],
      { permission: 'edit' },
    );
    await send(page, 'Each of you, write a file e2e:write=claude.txt@claude e2e:write=codex.txt@codex e2e:write=grok.txt@grok');
    for (const [name, file] of [
      ['Claude', 'claude.txt'],
      ['Codex', 'codex.txt'],
      ['Grok', 'grok.txt'],
    ] as const) {
      const reply = await finishedReply(page, name);
      await expect(reply.locator('.changes-files')).toContainText(file);
      expect(existsSync(join(relay.workDir, file))).toBe(true);
    }
  });

  test('in parallel mode each member works in its own worktree, and a result can be applied', async ({ page, relay }) => {
    await openTeamChat(
      page,
      relay,
      [
        { name: 'Claude', provider: 'claude' },
        { name: 'Codex', provider: 'codex' },
      ],
      { permission: 'edit', mode: 'parallel' },
    );
    await send(page, 'Try it both ways e2e:write=result.txt');
    const claude = await finishedReply(page, 'Claude');
    const codex = await finishedReply(page, 'Codex');
    await expect(claude.locator('.changes-card')).toContainText('in worktree');
    await expect(codex.locator('.changes-card')).toContainText('in worktree');
    // Nothing reached the working directory yet.
    expect(existsSync(join(relay.workDir, 'result.txt'))).toBe(false);

    acceptNextDialog(page);
    await codex.getByRole('button', { name: 'Apply to working directory' }).click();
    await expect.poll(() => existsSync(join(relay.workDir, 'result.txt'))).toBe(true);
    expect(readFileSync(join(relay.workDir, 'result.txt'), 'utf8')).toBe('Written by Codex (Codex).\n');
  });

  test("the file browser shows the working directory and previews a file", async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const browser = page.getByRole('dialog', { name: 'Files' });
    await expect(browser).toBeVisible();
    const list = browser.locator('.file-list');
    await expect(list.locator('.file-name', { hasText: /^README\.md$/ })).toBeVisible();
    await list.locator('.file-name', { hasText: /^src$/ }).click();
    await list.locator('.file-name', { hasText: /^hello\.ts$/ }).click();
    await expect(browser.locator('.code-text')).toContainText('export function hello(name: string): string {');
    await page.keyboard.press('Escape');
    await expect(browser).toBeHidden();
  });
});
