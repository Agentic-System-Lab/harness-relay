import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Download, Locator, Page } from '@playwright/test';
import { FILE_LIMITS } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, askAndConfirm, finishedReply, openTeamChat, send, startChat } from '../support/app';
import { CLIS, eachCli, endsTurnNote, HALVES, member, needsBelowFull, teamOf, teams } from '../support/clis';

/**
 * A ZIP file's entries, by name (a folder's ends with `/`), with each one's bytes: read from its central
 * directory, which follows the data, and each file's local header, as any unzip tool reads them.
 */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  // The end of the central directory: its 22 bytes come last (this archive has no comment).
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end), 'the end of the central directory').toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at), 'a central directory header').toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    expect(zip.readUInt32LE(local), 'a local file header').toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

/** Clicks a folder's download button, and returns the ZIP file the browser saved, and its entries. */
async function downloadZip(page: Page, button: Locator): Promise<{ download: Download; entries: Map<string, Buffer> }> {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(await download.failure()).toBeNull();
  return { download, entries: zipEntries(readFileSync(await download.path())) };
}

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

  // A read-only chat as each CLI is set up for it: without file tools (Claude Code, Pi), or its write
  // refused by its own rules without a card (Cursor), or asking (`readOnlyWriteAsks`), declined by the
  // user. (That a write the user allows still cannot reach the folder: sandbox.spec.ts.)
  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: in a read-only chat no file is written`, async ({ page, relay }) => {
      needsBelowFull(cli.provider);
      await openTeamChat(page, relay, [member(cli)]);
      await send(page, 'Write it e2e:write=out.txt');
      if (cli.readOnlyWriteAsks) {
        const card = page.getByRole('region', { name: `@${cli.name} wants to change files` });
        await card.getByRole('button', { name: 'Decline' }).click();
      }
      const reply = await finishedReply(page, cli.name);
      // A CLI that ends its turn after a refusal says nothing more of it.
      await expect(reply).toContainText(cli.decline === 'ends-turn' && cli.readOnlyWriteAsks ? endsTurnNote(cli) : 'I may not write out.txt here.');
      await expect(reply.locator('.changes-card')).toHaveCount(0);
      if (!cli.readOnlyWriteAsks) await expect(reply.locator('.approval-done')).toHaveCount(0);
      expect(existsSync(join(relay.workDir, 'out.txt'))).toBe(false);
    });
  });

  test('grok: a read-only chat that refuses automatically says why', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], { approvals: 'deny' });
    await send(page, 'Write it e2e:write=out.txt');
    const reply = await finishedReply(page, 'Grok');
    await expect(reply).toContainText('I may not write out.txt here.');
    await reply.locator('details.tool-group > summary').first().click();
    await expect(reply.locator('.tool-error')).toHaveText('Not allowed in read-only mode; Grok was told to use read-only tools');
    expect(existsSync(join(relay.workDir, 'out.txt'))).toBe(false);
  });

  // The CLIs in two teams, each in a chat of its own: those that cannot run below full access here in
  // one with full access (`teams()`).
  for (const half of HALVES) {
    test(half.title('every CLI writes in edit mode, and each turn records its own change'), async ({ page, relay }) => {
      for (const team of teams(teamOf(half.clis), 'edit')) {
        await openTeamChat(page, relay, team.members.map((c) => member(c)), { permission: team.permission });
        await send(page, `Each of you, write a file ${team.members.map((c) => `e2e:write=${c.provider}.txt@${c.provider}`).join(' ')}`);
        for (const c of team.members) {
          const reply = await finishedReply(page, c.name);
          await expect(reply.locator('.changes-files')).toContainText(`${c.provider}.txt`);
          expect(existsSync(join(relay.workDir, `${c.provider}.txt`))).toBe(true);
        }
      }
    });
  }

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

  test('a folder downloads as a ZIP file of its files, without .git', async ({ page, relay }) => {
    // Edit mode makes the working directory a git repository at the first turn.
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await send(page, 'Write the plan down e2e:write=notes/plan.md');
    await finishedReply(page, 'Claude');
    expect(existsSync(join(relay.workDir, '.git'))).toBe(true);

    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const browser = page.getByRole('dialog', { name: 'Files' });
    // The whole working directory, named after its folder.
    const all = await downloadZip(page, browser.getByRole('button', { name: 'Download "Working directory" as a ZIP file' }));
    expect(all.download.suggestedFilename()).toBe('work.zip');
    expect([...all.entries.keys()].sort()).toEqual([
      'work/',
      'work/README.md',
      'work/notes/',
      'work/notes/plan.md',
      'work/src/',
      'work/src/hello.ts',
      'work/src/lib/',
      'work/src/lib/math.ts',
    ]);
    expect(all.entries.get('work/src/hello.ts')!.toString('utf8')).toBe(readFileSync(join(relay.workDir, 'src', 'hello.ts'), 'utf8'));
    expect(all.entries.get('work/notes/plan.md')!.toString('utf8')).toBe('Written by Claude (Claude Code).\n');

    // A folder of the list, from its row.
    const src = await downloadZip(page, browser.getByRole('button', { name: 'Download "src" as a ZIP file' }));
    expect(src.download.suggestedFilename()).toBe('src.zip');
    expect([...src.entries.keys()].sort()).toEqual(['src/', 'src/hello.ts', 'src/lib/', 'src/lib/math.ts']);
    expect(src.entries.get('src/lib/math.ts')!.toString('utf8')).toBe(readFileSync(join(relay.workDir, 'src', 'lib', 'math.ts'), 'utf8'));
  });

  test('a folder too large to zip in full is offered without what git ignores', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await send(page, 'Write the plan down e2e:write=notes/plan.md');
    await finishedReply(page, 'Claude');
    // An ignored file over the ZIP's limit, made by setting its length: nothing is written, and the
    // server only looks at its size.
    writeFileSync(join(relay.workDir, '.gitignore'), 'build/\n');
    mkdirSync(join(relay.workDir, 'build'));
    writeFileSync(join(relay.workDir, 'build', 'huge.bin'), '');
    truncateSync(join(relay.workDir, 'build', 'huge.bin'), FILE_LIMITS.zipBytes + 1);

    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const browser = page.getByRole('dialog', { name: 'Files' });
    const button = browser.getByRole('button', { name: 'Download "Working directory" as a ZIP file' });
    // Declined, nothing is downloaded.
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    await button.click();
    await expect.poll(() => asked).toContain('is too large to zip in full');
    expect(asked).toContain('Download only the files git does not ignore? 5 files');
    await expect(button).toBeEnabled();
    expect(downloads).toBe(0);

    acceptNextDialog(page);
    const { download, entries } = await downloadZip(page, button);
    expect(download.suggestedFilename()).toBe('work.zip');
    expect([...entries.keys()].sort()).toEqual(['work/', 'work/.gitignore', 'work/README.md', 'work/notes/plan.md', 'work/src/hello.ts', 'work/src/lib/math.ts']);
  });
});
