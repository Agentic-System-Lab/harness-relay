import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { acceptNextDialog, chatId, finishedReply, openTeamChat, send } from '../support/app';

/*
 * The fake CLIs write only where the real ones could (their permission and sandbox, and the folders
 * Harness Relay passes them), so these tell whether a chat's folders reach each CLI.
 */
const CLIS = [
  { name: 'Claude', provider: 'claude' },
  { name: 'Codex', provider: 'codex' },
  { name: 'Grok', provider: 'grok' },
] as const;

const read = (file: string) => readFileSync(file, 'utf8');

test.describe('a folder the chat was not given', () => {
  for (const cli of CLIS) {
    test(`${cli.provider}: stays out of reach in edit mode`, async ({ page, relay }) => {
      // Grok has no sandbox on native Windows (docs/sandboxing.md): nothing keeps it in its folders.
      test.skip(cli.provider === 'grok' && process.platform === 'win32', 'Grok has no sandbox on Windows');
      const other = relay.addProject('other');
      // Refused automatically: what is outside the chat's folders is beyond its permission.
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }], { permission: 'edit', approvals: 'deny' });
      await send(page, 'Write next door e2e:write=../other/x.txt');
      await expect(await finishedReply(page, cli.name)).toContainText('I may not write ../other/x.txt here.');
      expect(existsSync(join(other, 'x.txt'))).toBe(false);
    });
  }

  for (const cli of CLIS.filter((c) => c.provider !== 'grok')) {
    test(`${cli.provider}: asks first, and writes there once the user allows it`, async ({ page, relay }) => {
      const other = relay.addProject('other');
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }], { permission: 'edit' });
      await send(page, 'Write next door e2e:write=../other/y.txt');
      const card = page.getByRole('region', { name: `@${cli.name} wants to change files` });
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      await expect(await finishedReply(page, cli.name)).toContainText('I wrote ../other/y.txt.');
      expect(existsSync(join(other, 'y.txt'))).toBe(true);
    });
  }
});

test.describe('several working directories', () => {
  test('folders are added and removed in the box, and the chat works in all of them', async ({ page, relay }) => {
    const second = relay.addProject('second');
    const third = relay.addProject('third');
    await page.getByRole('button', { name: 'New chat' }).first().click();
    const box = page.getByRole('combobox', { name: 'Working directories' });
    const chips = page.locator('.cwd-chip-path');
    await expect(chips).toHaveText([relay.workDir]);
    for (const dir of [second, third]) {
      await box.fill(dir);
      await box.press('Enter');
    }
    await expect(chips).toHaveText([relay.workDir, second, third]);
    await page.getByRole('button', { name: `Remove ${third}` }).click();
    await expect(chips).toHaveText([relay.workDir, second]);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('checkbox', { name: "Use the lead agent's team without asking me" }).check();
    await page.getByRole('button', { name: 'Start chat →' }).click();
    await page.waitForURL(/#\/c\//);
    const conv = await relay.api<{ settings: { cwd: string; extraCwds?: string[] } }>(`/api/conversations/${chatId(page)}`);
    expect([conv.settings.cwd, ...(conv.settings.extraCwds ?? [])]).toEqual([relay.workDir, second]);

    await send(page, 'Note it in both e2e:write=one.txt e2e:writeother=two.txt');
    await expect(await finishedReply(page, 'Claude')).toContainText('I wrote one.txt. I wrote two.txt.');
    expect(existsSync(join(relay.workDir, 'one.txt'))).toBe(true);
    expect(existsSync(join(second, 'two.txt'))).toBe(true);
    expect(existsSync(join(third, 'two.txt'))).toBe(false);
  });

  for (const cli of CLIS) {
    test(`${cli.provider}: writes in each folder, and the changes card lists them by folder`, async ({ page, relay }) => {
      const second = relay.addProject('second');
      await openTeamChat(page, relay, [{ name: cli.name, provider: cli.provider }], { permission: 'edit', extraCwds: [second] });
      await send(page, 'Note it in both e2e:write=one.txt e2e:writeother=two.txt');
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('I wrote one.txt. I wrote two.txt.');
      expect(read(join(relay.workDir, 'one.txt'))).toBe(`Written by ${cli.name} (${cli.provider === 'claude' ? 'Claude Code' : cli.name}).\n`);
      expect(existsSync(join(second, 'two.txt'))).toBe(true);

      const changes = reply.locator('.changes-card');
      await expect(changes).toContainText('Changed 2 files');
      await expect(changes.locator('.changes-repo')).toHaveCount(2);
      await expect(changes.locator('.changes-repo-name')).toHaveText([`📁 ${relay.workDir}`, `📁 ${second}`]);
      await changes.getByRole('button', { name: "View this turn's diff" }).click();
      const diff = page.getByRole('dialog', { name: `@${cli.name}'s changes this turn` });
      await expect(diff).toContainText('one.txt');
      await expect(diff).toContainText('two.txt');
    });
  }

  test('the file browser lists every working directory', async ({ page, relay }) => {
    const second = relay.addProject('second');
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { extraCwds: [second] });
    await page.locator('.chat-head').getByRole('button', { name: 'Files' }).click();
    const browser = page.getByRole('dialog', { name: 'Files' });
    const root = browser.getByRole('combobox', { name: 'Folder' });
    await expect(root.locator('option')).toHaveCount(2);
    await expect(browser.locator('.file-name', { hasText: /^second\.md$/ })).toHaveCount(0);
    await root.selectOption({ index: 1 });
    await expect(browser.locator('.file-name', { hasText: /^second\.md$/ })).toBeVisible();
  });

  test('in parallel mode each member gets a worktree of each folder, and Apply applies them all', async ({ page, relay }) => {
    const second = relay.addProject('second');
    await openTeamChat(
      page,
      relay,
      [
        { name: 'Claude', provider: 'claude' },
        { name: 'Codex', provider: 'codex' },
      ],
      { permission: 'edit', mode: 'parallel', extraCwds: [second] },
    );
    await send(page, 'Try it both ways e2e:write=a.txt e2e:writeother=b.txt');
    const claude = await finishedReply(page, 'Claude');
    const codex = await finishedReply(page, 'Codex');
    for (const reply of [claude, codex]) {
      await expect(reply).toContainText('I wrote a.txt. I wrote b.txt.');
      await expect(reply.locator('.changes-card')).toContainText('in worktree');
      await expect(reply.locator('.changes-repo')).toHaveCount(2);
    }
    expect(existsSync(join(relay.workDir, 'a.txt'))).toBe(false);
    expect(existsSync(join(second, 'b.txt'))).toBe(false);

    acceptNextDialog(page);
    await codex.getByRole('button', { name: 'Apply to working directory' }).click();
    await expect.poll(() => existsSync(join(second, 'b.txt'))).toBe(true);
    expect(read(join(relay.workDir, 'a.txt'))).toBe('Written by Codex (Codex).\n');
    expect(read(join(second, 'b.txt'))).toBe('Written by Codex (Codex).\n');
  });

  test("Settings' default working directories are where new chats start", async ({ page, relay }) => {
    const second = relay.addProject('second');
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const card = page.locator('#settings-cwd');
    const box = card.getByRole('combobox', { name: 'Default working directories' });
    await expect(card.locator('.cwd-chip-path')).toHaveText([relay.workDir]);
    await box.fill(second);
    await box.press('Enter');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText('Default working directories saved');

    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(page.locator('.cwd-chip-path')).toHaveText([relay.workDir, second]);
  });
});

/*
 * The system's folder dialog, from the working directories box. Linux finds its dialog (zenity) on
 * the PATH in a graphical session, so there the fake one (`e2e/fake-cli/fake-dialog.cjs`) stands in
 * for it, answering with the folders E2E_FAKE_PICK names from where it opens. macOS and Windows open
 * their own by their full paths (AppleScript, PowerShell), which a test cannot answer.
 */
test.describe('the folder dialog', () => {
  test.skip(process.platform !== 'linux', 'only Linux finds its folder dialog on the PATH, where a fake one can stand in');
  const DISPLAY = ':e2e';

  test.describe('choosing folders', () => {
    test.use({ serverEnv: { DISPLAY, E2E_FAKE_PICK: JSON.stringify(['../second', '../third']) } });

    test('adds the folders chosen in it to the box, and the chat starts in all of them', async ({ page, relay }) => {
      const second = relay.addProject('second');
      const third = relay.addProject('third');
      await page.getByRole('button', { name: 'New chat' }).first().click();
      const chips = page.locator('.cwd-chip-path');
      await expect(chips).toHaveText([relay.workDir]);
      // The button shows once the box's list has told it the server has a dialog.
      await page.getByRole('combobox', { name: 'Working directories' }).click();
      await page.getByRole('button', { name: 'Choose folders…' }).click();
      await expect(chips).toHaveText([relay.workDir, second, third]);

      // Opened inside the last folder, with several folders allowed and the title in English.
      const opened = relay.fakeLog().filter((e) => e.cli === 'zenity');
      expect(opened).toHaveLength(1);
      expect(opened[0]!.args).toEqual(expect.arrayContaining(['--directory', '--multiple', `--filename=${relay.workDir}/`, '--title=Choose a working directory']));

      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('checkbox', { name: "Use the lead agent's team without asking me" }).check();
      await page.getByRole('button', { name: 'Start chat →' }).click();
      await page.waitForURL(/#\/c\//);
      const conv = await relay.api<{ settings: { cwd: string; extraCwds?: string[] } }>(`/api/conversations/${chatId(page)}`);
      expect([conv.settings.cwd, ...(conv.settings.extraCwds ?? [])]).toEqual([relay.workDir, second, third]);
    });
  });

  test.describe('in Chinese, on a server without a UTF-8 locale', () => {
    // Cancelled; a server that a service started may have no LANG.
    test.use({ lang: 'zh-TW', serverEnv: { DISPLAY, E2E_FAKE_PICK: '[]', LANG: 'C', LC_ALL: '', LC_CTYPE: '' } });

    test('opens with the title in Chinese and a UTF-8 character set, and Cancel adds nothing', async ({ page, relay }) => {
      await page.getByRole('button', { name: '新對話' }).first().click();
      await expect(page.getByRole('heading', { name: '新對話' })).toBeVisible();
      const chips = page.locator('.cwd-chip-path');
      await expect(chips).toHaveText([relay.workDir]);
      const box = page.getByRole('combobox', { name: '工作目錄' });
      await box.click();
      const pick = page.getByRole('button', { name: '選擇資料夾…' });
      await pick.click();
      await expect.poll(() => relay.fakeLog().filter((e) => e.cli === 'zenity').length).toBe(1);
      // The button shows while the box has the focus, which it gave up for the dialog.
      await box.click();
      await expect(pick).toBeEnabled();
      await expect(chips).toHaveText([relay.workDir]);
      const [opened] = relay.fakeLog().filter((e) => e.cli === 'zenity');
      expect(opened!.args).toContain('--title=選擇工作目錄');
      expect(opened!.env).toEqual({ LANG: 'C', LC_CTYPE: 'C.UTF-8' });
    });
  });
});
