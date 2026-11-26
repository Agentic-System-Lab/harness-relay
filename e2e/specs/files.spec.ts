import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Download, Locator, Page } from '@playwright/test';
import { FILE_LIMITS } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { chooseChatAction, acceptNextDialog, finishedReply, openTeamChat, send, settled, startChat, confirmTeam } from '../support/app';
import { CLIS, eachCli, eachHalf, endsTurnNote, logged, member, needsBelowFull, teamOf, teams } from '../support/clis';

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
    await startChat(page, 'Write the plan down e2e:write=notes/plan.md', { permission: 'edit' });
    await confirmTeam(page);
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
    // A section for each file, folded: its status, path and counts, its lines only once it is opened.
    await expect(diff.locator('.diff-files-head')).toContainText('Changed 1 file');
    const file = diff.getByRole('button', { name: /notes\/plan\.md/ });
    await expect(file).toHaveAttribute('aria-expanded', 'false');
    await expect(file).toContainText('A');
    await expect(file).toContainText('+1');
    await expect(diff).not.toContainText('Written by Claude (Claude Code).');
    // One file: nothing to open all at once.
    await expect(diff.getByRole('button', { name: 'Expand all' })).toHaveCount(0);
    await file.click();
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    await expect(diff.locator('.d-add')).toHaveText(['+Written by Claude (Claude Code).']);
    await file.click();
    await expect(diff.locator('.diff-view')).toHaveCount(0);
    await diff.getByRole('button', { name: 'Close' }).click();
    await expect(diff).toBeHidden();
  });

  // A read-only chat as each CLI is set up for it: without file tools (Claude Code, Pi), or its write
  // refused without a card by its own rules (Cursor) or by its sandbox (Copilot, whose working
  // directories are read-only there), or asking (`readOnlyWriteAsks`), declined by the user. (That a
  // write the user allows still cannot reach the folder: sandbox.spec.ts.)
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
      await expect(reply).toContainText(
        cli.decline === 'ends-turn' && cli.readOnlyWriteAsks ? endsTurnNote(cli) : 'I may not write out.txt here.',
      );
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
  eachHalf((half) => {
    test(half.title('every CLI writes in edit mode, and each turn records its own change'), async ({ page, relay }) => {
      for (const team of teams(teamOf(half.clis), 'edit')) {
        await openTeamChat(
          page,
          relay,
          team.members.map((c) => member(c)),
          { permission: team.permission },
        );
        await send(page, `Each of you, write a file ${team.members.map((c) => `e2e:write=${c.provider}.txt@${c.provider}`).join(' ')}`);
        for (const c of team.members) {
          const reply = await finishedReply(page, c.name);
          await expect(reply.locator('.changes-files')).toContainText(`${c.provider}.txt`);
          expect(existsSync(join(relay.workDir, `${c.provider}.txt`))).toBe(true);
        }
      }
    });
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

  test('a second chat writing in the same folder meanwhile works in a worktree of its own, and Apply brings its changes in', async ({
    page,
    relay,
  }) => {
    // The first chat writes in the folder, and takes its time.
    const first = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' }, 'First chat');
    await send(page, 'Take your time e2e:write=first.txt e2e:slow=120');
    await expect.poll(() => existsSync(join(relay.workDir, 'first.txt'))).toBe(true);

    // The second one, meanwhile, in the same folder: not refused, in a worktree of its own, saying why.
    await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }], { permission: 'edit' }, 'Second chat');
    await send(page, 'Meanwhile e2e:write=second.txt');
    await expect(page.locator('.msg-system').filter({ hasText: 'Conversation "First chat" is changing' })).toBeVisible();
    const codex = await finishedReply(page, 'Codex');
    const card = codex.locator('.changes-card');
    await expect(card).toContainText("in this chat's worktree · relay/");
    expect(existsSync(join(relay.workDir, 'second.txt'))).toBe(false);
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    await expect(browser.getByRole('combobox', { name: 'Folder' }).locator('option', { hasText: "This chat's worktree" })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(browser).toHaveCount(0);

    // Not applied while the first chat writes there; once it is done, it is.
    acceptNextDialog(page);
    await card.getByRole('button', { name: 'Apply to working directory' }).click();
    await expect(page.getByRole('alert')).toContainText('Conversation "First chat" is changing');
    expect(existsSync(join(relay.workDir, 'second.txt'))).toBe(false);
    await relay.api(`/api/conversations/${first}/stop`, { method: 'POST', body: {} });
    await settled(relay, first);
    acceptNextDialog(page);
    await card.getByRole('button', { name: 'Apply to working directory' }).click();
    await expect.poll(() => existsSync(join(relay.workDir, 'second.txt'))).toBe(true);
    expect(readFileSync(join(relay.workDir, 'second.txt'), 'utf8')).toBe('Written by Codex (Codex).\n');
    await expect(page.locator('.msg-system').filter({ hasText: "Applied the team's changes" })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Apply to working directory' })).toHaveCount(0);
  });

  test('the file browser shows the working directory and previews a file', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    await expect(browser).toBeVisible();
    const list = browser.locator('.file-list');
    await expect(list.locator('.file-name', { hasText: /^README\.md$/ })).toBeVisible();
    await list.locator('.file-name', { hasText: /^src$/ }).click();
    await list.locator('.file-name', { hasText: /^hello\.ts$/ }).click();
    await expect(browser.locator('.code-text')).toContainText('export function hello(name: string): string {');
    // Highlighted as TypeScript (src/web/highlight.ts): its keywords and types in their own colours.
    await expect(browser.locator('.code-text.hljs .hljs-keyword').first()).toHaveText('export');
    await expect(browser.locator('.code-text.hljs .hljs-built_in, .code-text.hljs .hljs-type').first()).toHaveText('string');
    await page.keyboard.press('Escape');
    await expect(browser).toBeHidden();
  });

  test('a text file is edited and saved in Files, and a save over a newer version offers to reload', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'queue.csv'), 'date,text\r\n2026-11-23,Hello\r\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    await browser.locator('.file-list .file-name', { hasText: /^queue\.csv$/ }).click();
    await expect(browser.locator('.code-text')).toContainText('2026-11-23,Hello');

    // Edit, then Save: the file keeps its CRLF line breaks, and the preview shows what was saved.
    await browser.getByRole('button', { name: 'Edit', exact: true }).click();
    const box = browser.getByRole('textbox', { name: 'Contents of queue.csv' });
    await expect(box).toBeFocused();
    await expect(browser.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    // What the box holds: the file with LF line breaks, as a browser's text box gives them.
    await expect(box).toHaveValue('date,text\n2026-11-23,Hello\n');
    await box.fill('date,text\n2026-11-23,Hello\n2026-11-24,From the phone\n');
    await expect(browser.getByText('Not saved')).toBeVisible();
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(box).toHaveCount(0);
    await expect(browser.locator('.code-text')).toContainText('2026-11-24,From the phone');
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).toBe('date,text\r\n2026-11-23,Hello\r\n2026-11-24,From the phone\r\n');

    // Changed meanwhile (an agent, another device): the save is refused, and Reload shows the new version.
    await browser.getByRole('button', { name: 'Edit', exact: true }).click();
    await box.fill('date,text\n2026-11-23,Hello\n2026-11-24,From the phone\nmine\n');
    writeFileSync(join(relay.workDir, 'queue.csv'), 'date,text\n2026-11-25,Written by an agent\n');
    await box.press('ControlOrMeta+s');
    const alert = browser.getByRole('alert');
    await expect(alert).toContainText('changed after you started editing');
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-25,Written by an agent\n');
    await alert.getByRole('button', { name: 'Reload' }).click();
    await expect(box).toHaveValue('date,text\n2026-11-25,Written by an agent\n');
    await box.fill('date,text\n2026-11-25,Written by an agent\n2026-11-26,Again\n');
    await box.press('ControlOrMeta+s');
    await expect(box).toHaveCount(0);
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-25,Written by an agent\n2026-11-26,Again\n');

    // Unsaved changes: closing asks first, and staying keeps them.
    await browser.getByRole('button', { name: 'Edit', exact: true }).click();
    await box.fill('draft');
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.keyboard.press('Escape');
    await expect.poll(() => asked).toBe('Discard the changes you have not saved?');
    await expect(box).toHaveValue(/draft/);
    acceptNextDialog(page);
    await browser.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(box).toHaveCount(0);
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).not.toContain('draft');
  });

  test('a new file and uploaded files go into the folder on screen, replacing a file only once confirmed', async ({ page, relay }) => {
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    const list = browser.locator('.file-list');
    await list.locator('.file-name', { hasText: /^src$/ }).click();
    await expect(list.locator('.file-name', { hasText: /^hello\.ts$/ })).toBeVisible();

    // A new file opens in the editor.
    await browser.getByRole('button', { name: 'New file' }).click();
    const name = browser.getByRole('textbox', { name: "The new file's name" });
    await name.fill('a/b.md');
    await name.press('Enter');
    await expect(browser.getByRole('alert')).toContainText('A name cannot have / or \\.');
    await name.fill('notes.md');
    await name.press('Enter');
    const box = browser.getByRole('textbox', { name: 'Contents of notes.md' });
    await expect(box).toBeFocused();
    await box.fill('# Notes\n');
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(box).toHaveCount(0);
    expect(readFileSync(join(relay.workDir, 'src', 'notes.md'), 'utf8')).toBe('# Notes\n');
    await expect(list.locator('.file-name', { hasText: /^notes\.md$/ })).toBeVisible();

    // Two files picked, one of them named as a file there: declining uploads only the other.
    const hello = readFileSync(join(relay.workDir, 'src', 'hello.ts'), 'utf8');
    const picker = browser.locator('input[type="file"]');
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await picker.setInputFiles([
      { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'hello.ts', mimeType: 'text/plain', buffer: Buffer.from('export const replaced = true;\n') },
    ]);
    await expect.poll(() => asked).toContain('This folder already has:\nhello.ts');
    await expect(browser.getByRole('status')).toHaveText('Uploaded 1 file.');
    expect(readFileSync(join(relay.workDir, 'src', 'photo.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readFileSync(join(relay.workDir, 'src', 'hello.ts'), 'utf8')).toBe(hello);
    await expect(list.locator('.file-name', { hasText: /^photo\.png$/ })).toBeVisible();

    // Accepted, it replaces it.
    acceptNextDialog(page);
    await picker.setInputFiles({ name: 'hello.ts', mimeType: 'text/plain', buffer: Buffer.from('export const replaced = true;\n') });
    await expect.poll(() => readFileSync(join(relay.workDir, 'src', 'hello.ts'), 'utf8')).toBe('export const replaced = true;\n');

    // Dropped on the list: into the folder on screen.
    const drop = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['dropped\n'], 'dropped.txt', { type: 'text/plain' }));
      return data;
    });
    const pane = browser.locator('.file-pane');
    await pane.dispatchEvent('dragenter', { dataTransfer: drop });
    await expect(pane).toHaveClass(/dropping/);
    await pane.dispatchEvent('drop', { dataTransfer: drop });
    await expect(list.locator('.file-name', { hasText: /^dropped\.txt$/ })).toBeVisible();
    expect(readFileSync(join(relay.workDir, 'src', 'dropped.txt'), 'utf8')).toBe('dropped\n');
  });

  test('a save waits while a run writes in the folder', async ({ page, relay }) => {
    writeFileSync(join(relay.workDir, 'queue.csv'), 'date,text\n');
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    await browser.locator('.file-list .file-name', { hasText: /^queue\.csv$/ }).click();
    await browser.getByRole('button', { name: 'Edit', exact: true }).click();
    const box = browser.getByRole('textbox', { name: 'Contents of queue.csv' });
    await box.fill('date,text\n2026-11-23,Mine\n');

    // The team writes in the folder meanwhile: the save is refused, saying why, and the text stays.
    await relay.api(`/api/conversations/${id}/messages`, { body: { text: 'Take your time e2e:slow=120' } });
    await expect
      .poll(async () => (await relay.api<{ id: string; running?: boolean }[]>('/api/conversations')).find((c) => c.id === id)?.running)
      .toBe(true);
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(browser.getByRole('alert')).toContainText('A run is changing files in this folder');
    await expect(box).toHaveValue('date,text\n2026-11-23,Mine\n');
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).toBe('date,text\n');

    // Once it is stopped, the same save goes through.
    await relay.api(`/api/conversations/${id}/stop`, { method: 'POST', body: {} });
    await settled(relay, id);
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(box).toHaveCount(0);
    expect(readFileSync(join(relay.workDir, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-23,Mine\n');
  });

  test('a folder downloads as a ZIP file of its files, without .git', async ({ page, relay }) => {
    // Edit mode makes the working directory a git repository at the first turn.
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' });
    await send(page, 'Write the plan down e2e:write=notes/plan.md');
    await finishedReply(page, 'Claude');
    expect(existsSync(join(relay.workDir, '.git'))).toBe(true);

    await chooseChatAction(page, 'Files');
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

  test('a file and a folder are deleted in Files once confirmed, and the file on screen goes with them', async ({ page, relay }) => {
    mkdirSync(join(relay.workDir, 'drafts', 'old'), { recursive: true });
    writeFileSync(join(relay.workDir, 'drafts', 'old', 'a.md'), '# A\n');
    writeFileSync(join(relay.workDir, 'drafts', 'b.md'), '# B\n');
    writeFileSync(join(relay.workDir, 'scratch.txt'), 'scratch\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await chooseChatAction(page, 'Files');
    const browser = page.getByRole('dialog', { name: 'Files' });
    const list = browser.locator('.file-list');
    const row = (name: string) => list.locator('.file-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) });

    // Declined, nothing goes.
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await browser.getByRole('button', { name: 'Delete scratch.txt' }).click();
    await expect.poll(() => asked).toBe('Delete "scratch.txt"? This cannot be undone.');
    await expect(row('scratch.txt')).toBeVisible();
    expect(existsSync(join(relay.workDir, 'scratch.txt'))).toBe(true);

    // Agreed to, the file goes from the list and the disk.
    acceptNextDialog(page);
    await browser.getByRole('button', { name: 'Delete scratch.txt' }).click();
    await expect(browser.getByRole('status')).toHaveText('Deleted "scratch.txt".');
    await expect(row('scratch.txt')).toHaveCount(0);
    expect(existsSync(join(relay.workDir, 'scratch.txt'))).toBe(false);

    // A folder goes with all it holds, and a file of it on screen closes.
    await row('drafts').click();
    await row('b.md').click();
    await expect(browser.locator('.preview-pane')).toContainText('B');
    await browser.getByRole('button', { name: 'Up one level' }).click();
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await browser.getByRole('button', { name: 'Delete drafts' }).click();
    await expect.poll(() => asked).toBe('Delete the folder "drafts" and everything in it? This cannot be undone.');
    await expect(row('drafts')).toHaveCount(0);
    expect(existsSync(join(relay.workDir, 'drafts'))).toBe(false);
    await expect(browser.locator('.preview-pane')).toContainText('Pick a file');
    await expect(row('README.md')).toBeVisible();
  });

  test('a folder attached to a message reaches the agent by its path, without .git or node_modules, and downloads as a ZIP file', async ({
    page,
    relay,
  }, testInfo) => {
    const site = testInfo.outputPath('site');
    mkdirSync(join(site, 'css'), { recursive: true });
    mkdirSync(join(site, '.git'), { recursive: true });
    mkdirSync(join(site, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<h1>Hi</h1>\n');
    writeFileSync(join(site, 'css', 'style.css'), 'h1 { color: teal; }\n');
    writeFileSync(join(site, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(site, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);

    // The paperclip offers files or a folder; Escape closes its menu, as a press outside it does.
    const clip = page.getByRole('button', { name: 'Attach files or a folder' });
    await clip.click();
    const menu = page.getByRole('menu', { name: 'Attach files or a folder' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Files…', 'Folder…']);
    await expect(menu.getByRole('menuitem', { name: 'Files…' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Folder…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(clip).toBeFocused();
    // The arrow keys open it from the paperclip too.
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Files…' })).toBeFocused();
    await page.locator('.chat-head').click();
    await expect(menu).toHaveCount(0);

    // An empty folder says so (not in WebKit, where Playwright gives a folder picker no empty folder).
    if (testInfo.project.name !== 'webkit') {
      const empty = testInfo.outputPath('empty');
      mkdirSync(empty, { recursive: true });
      await clip.click();
      const none = page.waitForEvent('filechooser');
      await menu.getByRole('menuitem', { name: 'Folder…' }).click();
      await (await none).setFiles(empty);
      await expect(page.locator('.composer-notice')).toHaveText('That folder has no files to attach.');
    }

    // Folder… opens the folder dialog.
    await clip.click();
    const chooser = page.waitForEvent('filechooser');
    await menu.getByRole('menuitem', { name: 'Folder…' }).click();
    await (await chooser).setFiles(site);
    const chip = page.locator('.attach-tray .attach-folder');
    await expect(chip).toContainText('site');
    await expect(chip).toContainText('2 files');
    // WebKit's folder picker leaves out folders whose names start with a dot by itself.
    await expect(chip).toHaveAttribute('title', /^site\/\nLeft out: (\.git, )?node_modules$/);
    await send(page, 'What is in the folder?');
    await finishedReply(page, 'Claude');
    const [prompt] = await logged(relay, (e) => e.cli === 'claude' && e.prompt?.includes('site/ (a folder of 2 files'));
    const path = /site\/ \(a folder of 2 files, [^)]*\): (.+)/.exec(prompt!.prompt!)![1]!.trim();
    expect(readFileSync(join(path, 'css', 'style.css'), 'utf8')).toBe('h1 { color: teal; }\n');
    expect(existsSync(join(path, '.git'))).toBe(false);

    const link = page.locator('.msg-attachments').getByRole('link', { name: /site/ });
    await expect(link).toContainText('2 files');
    await expect(link).toHaveAttribute('download', 'site.zip');
    // WebKit under Playwright downloads nothing a link opens.
    if (testInfo.project.name === 'webkit') return;
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('site.zip');
    const entries = zipEntries(readFileSync(await download.path()));
    expect([...entries.keys()].sort()).toEqual(['site/', 'site/css/', 'site/css/style.css', 'site/index.html']);
    expect(entries.get('site/index.html')!.toString('utf8')).toBe('<h1>Hi</h1>\n');
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

    await chooseChatAction(page, 'Files');
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
    expect([...entries.keys()].sort()).toEqual([
      'work/',
      'work/.gitignore',
      'work/README.md',
      'work/notes/plan.md',
      'work/src/hello.ts',
      'work/src/lib/math.ts',
    ]);
  });
});
