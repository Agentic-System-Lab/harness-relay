import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import type { Conversation } from '../../src/shared/types';
import { acceptNextDialog, chatId, composer, confirmTeam, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import { chatWith, CLIS, eachCli, endsTurnNote, member, needsBelowFull, writtenBy } from '../support/clis';

/*
 * The fake CLIs write only where the real ones could (their permission and sandbox, and the folders
 * Harness Relay passes them), so these tell whether a chat's folders reach each CLI. The open agents'
 * fakes write for real, and Harness Relay's own sandbox refuses what is not theirs to write.
 */
const read = (file: string) => readFileSync(file, 'utf8');

test.describe('a folder the chat was not given', () => {
  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: stays out of reach in edit mode`, async ({ page, relay }) => {
      needsBelowFull(cli.provider);
      // Grok has no sandbox on native Windows (docs/sandboxing.md): nothing keeps it in its folders.
      test.skip(Boolean(cli.unconfinedOn?.includes(process.platform)), `${cli.label} has no sandbox on ${process.platform}`);
      const other = relay.addProject('other');
      // Refused automatically: what is outside the chat's folders is beyond its permission (a CLI
      // without a sandbox asks, and is refused; the others' sandbox refuses it).
      await openTeamChat(page, relay, [member(cli)], { permission: 'edit', approvals: 'deny' });
      await send(page, 'Write next door e2e:write=../other/x.txt');
      const reply = await finishedReply(page, cli.name);
      // A CLI that ends its turn after a refusal says nothing more of it.
      await expect(reply).toContainText(cli.decline === 'ends-turn' && cli.outsideWrite.asks ? endsTurnNote(cli) : 'I may not write ../other/x.txt here.');
      expect(existsSync(join(other, 'x.txt'))).toBe(false);
    });
  });

  // The CLIs that ask about it (`outsideWrite`), and write once allowed: not Grok, whose sandbox
  // refuses it all the same, nor the open agents, whose sandbox nothing widens.
  eachCli(CLIS.filter((c) => c.outsideWrite.asks && c.outsideWrite.writtenOnceAllowed), (cli) => {
    test(`${cli.provider}: asks first, and writes there once the user allows it`, async ({ page, relay }) => {
      needsBelowFull(cli.provider);
      const other = relay.addProject('other');
      await openTeamChat(page, relay, [member(cli)], { permission: 'edit' });
      await send(page, 'Write next door e2e:write=../other/y.txt');
      const card = page.getByRole('region', { name: `@${cli.name} wants to change files` });
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      await expect(await finishedReply(page, cli.name)).toContainText('I wrote ../other/y.txt.');
      expect(existsSync(join(other, 'y.txt'))).toBe(true);
    });
  });
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

  eachCli(CLIS, (cli) => {
    test(`${cli.provider}: writes in each folder, and the changes card lists them by folder`, async ({ page, relay }) => {
      const second = relay.addProject('second');
      await chatWith(page, relay, cli, { permission: 'edit', extraCwds: [second] });
      await send(page, 'Note it in both e2e:write=one.txt e2e:writeother=two.txt');
      // A CLI that asks before writing in the folders after its first (Cursor), allowed.
      if (cli.otherCwdWriteAsks) await page.getByRole('region', { name: `@${cli.name} wants to change files` }).getByRole('button', { name: 'Allow', exact: true }).click();
      const reply = await finishedReply(page, cli.name);
      await expect(reply).toContainText('I wrote one.txt. I wrote two.txt.');
      expect(read(join(relay.workDir, 'one.txt'))).toBe(writtenBy(cli));
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
  });

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

/*
 * Two chats in one folder: while one changes it, a team the other confirms waits for it (its note, the
 * message box and the tray say so), gathers what the user writes meanwhile and starts on its own once
 * the folder is free; Stop stops it waiting.
 */
test.describe('two chats in one folder', () => {
  /** A chat whose member changes the folder for a few seconds, and an auto-team chat in the same folder, open. */
  async function holderAndWaiter(page: import('@playwright/test').Page, relay: import('../support/relay').RelayServer) {
    const holder = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'edit' }, 'Holder');
    await send(page, 'Take your time e2e:slow=12');
    const waiter = await relay.api<Conversation>('/api/conversations', {
      body: {
        title: 'Waiter',
        agents: [],
        settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'edit', cwd: relay.workDir, autoTeam: true },
      },
    });
    await page.goto(`${relay.base}/#/c/${waiter.id}`);
    await send(page, 'Build it');
    await confirmTeam(page);
    await expect(page.locator('.msg-system').last()).toContainText('Another conversation is changing');
    return { holder, waiter: waiter.id };
  }
  const tray = (page: import('@playwright/test').Page) => page.locator('.queue-tray');

  test('a team confirmed while another chat changes the folder waits, gathers what is written meanwhile, and starts on its own', async ({ page, relay }) => {
    await holderAndWaiter(page, relay);
    await expect(composer(page)).toHaveAttribute('placeholder', /Another conversation is changing this folder/);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    // What is written meanwhile waits with the team, and the tray says it starts on its own.
    await composer(page).fill('And look at the tests');
    await composer(page).press('Enter');
    await expect(tray(page)).toContainText('1 waiting for the folder');
    await expect(tray(page)).toContainText('the team starts on its own once it has finished');
    await expect(tray(page).getByRole('button', { name: /^Send/ })).toHaveCount(0);
    // Opened again (the stream's first snapshot), it still says so; on a phone too, where the tray's
    // note is hidden but its title says it.
    await page.reload();
    await expect(composer(page)).toHaveAttribute('placeholder', /Another conversation is changing this folder/);
    await page.setViewportSize({ width: 360, height: 760 });
    await expect(tray(page).locator('.queue-title')).toHaveText('1 waiting for the folder');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    // The other chat finishes: the team answers, with the message.
    const reply = await finishedReply(page, 'Claude', 30_000);
    await expect(tray(page)).toBeHidden();
    await expect(page.locator('.msg-user').last()).toContainText('And look at the tests');
    await expect(reply).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
  });

  test('Stop stops the wait: the team starts when the user sends', async ({ page, relay }) => {
    const { holder } = await holderAndWaiter(page, relay);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.msg-system').last()).toContainText('Stopped waiting for the folder');
    await expect(composer(page)).not.toHaveAttribute('placeholder', /Another conversation is changing/);
    // The other chat finishes; this one stays as it is.
    await settled(relay, holder);
    await page.waitForTimeout(500);
    await expect(replies(page, 'Claude')).toHaveCount(0);
    await page.getByRole('button', { name: /^Continue/ }).click();
    await finishedReply(page, 'Claude');
  });
});
