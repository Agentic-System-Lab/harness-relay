import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import type { RelayServer } from '../support/relay';

/** Opens the share dialog of the whole conversation, from the chat's header. */
async function shareChat(page: Page) {
  await page.locator('.chat-head').getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share conversation' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** What the fake gh keeps of a gist it made (`e2e/fake-cli/fake-gh.cjs`): its gist.json, and its files' folder. */
function fakeGist(relay: RelayServer, id: string) {
  const dir = join(relay.root, 'fake-github', 'gists', id);
  const meta = JSON.parse(readFileSync(join(dir, 'gist.json'), 'utf8')) as { description: string; public: boolean; files: string[] };
  return { dir, meta };
}

const ghCalls = (relay: RelayServer) => relay.fakeLog().filter((e) => e.cli === 'gh').map((e) => e.args ?? []);

test.describe('copying', () => {
  test.beforeEach(async ({ context, browserName }) => {
    // Only Chromium lets a page read the clipboard without asking (Firefox and WebKit have no such permission).
    test.skip(browserName !== 'chromium', 'reading the clipboard needs Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  // Windows' clipboard holds text with CRLF line ends, whatever was written to it.
  const clipboard = async (page: Page) => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');

  test("a reply's copy button copies its Markdown, not the text on screen", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    await send(page, 'Sum it up e2e:markdown');
    const reply = await finishedReply(page, 'Codex');
    await expect(reply.getByRole('heading', { name: 'Fake findings' })).toBeVisible();
    await settled(relay, id);

    await reply.hover();
    const copy = reply.getByRole('button', { name: 'Copy', exact: true });
    await copy.click();
    await expect(reply.getByRole('button', { name: 'Copied' })).toBeVisible();
    const text = await clipboard(page);
    expect(text).toMatch(/^Hello from Codex \(Codex\)\. You said: “Sum it up”\./);
    // The source: a heading with its ##, the table's pipes, the code block's fence.
    expect(text).toContain('\n\n## Fake findings\n\n- first point\n- second point\n');
    expect(text).toContain('| Codex | yes |');
    expect(text).toContain('```js\nconst answer = 42;\n```');
  });

  test('the share dialog copies the whole conversation, or up to a reply, as Markdown', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Copy me');
    await send(page, 'First question');
    await finishedReply(page, 'Claude');
    await settled(relay, id);
    await send(page, 'Second question');
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await finishedReply(page, 'Claude');
    await settled(relay, id);

    const first = [
      '# Copy me',
      '**User**',
      'First question',
      '---',
      '**@Claude** · Claude Code',
      'Hello from Claude (Claude Code). You said: “First question”.',
    ];
    const second = ['---', '**User**', 'Second question', '---', '**@Claude** · Claude Code', 'Hello from Claude (Claude Code). You said: “Second question”.'];

    const dialog = await shareChat(page);
    await expect(dialog).toContainText('The whole conversation');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe(`${[...first, ...second].join('\n\n')}\n`);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // From the first reply: only what came up to it.
    const reply = replies(page, 'Claude').first();
    await reply.hover();
    await reply.getByRole('button', { name: 'Share', exact: true }).click();
    const upTo = page.getByRole('dialog', { name: "Share up to @Claude's reply" });
    await expect(upTo).toContainText("up to and including @Claude's reply");
    await upTo.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(upTo.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe(`${first.join('\n\n')}\n`);
  });
});

test.describe('sharing as a secret gist', () => {
  test('a shared chat is a secret gist of the page the browser made, listed in Settings until removed', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Pelican facts');
    await send(page, 'What do pelicans eat? e2e:think e2e:tool');
    const reply = await finishedReply(page, 'Claude');
    // On screen, the reply shows its thinking and its tool call (folded).
    await expect(reply.locator('details.tool-group')).not.toHaveCount(0);
    await settled(relay, id);

    const dialog = await shareChat(page);
    await dialog.getByRole('button', { name: 'Create link' }).click();
    // The link is gistpreview's page of the gist gh made.
    const link = dialog.getByRole('textbox', { name: 'Public link' });
    await expect(link).toHaveValue(/^https:\/\/gistpreview\.github\.io\/\?[0-9a-f]{32}$/);
    const gistId = (await link.inputValue()).split('?')[1]!;
    await expect(dialog.getByRole('link', { name: 'View the gist on GitHub' })).toHaveAttribute('href', `https://gist.github.com/relay-e2e/${gistId}`);

    // gh made a secret gist (its default: no --public) of one index.html, the page read from stdin.
    expect(ghCalls(relay)).toEqual([['gist', 'create', '--filename', 'index.html', '--desc', 'Pelican facts · Harness Relay', '-']]);
    const gist = fakeGist(relay, gistId);
    expect(gist.meta).toMatchObject({ description: 'Pelican facts · Harness Relay', public: false, files: ['index.html'] });
    // The page the browser made of the chat on screen: a page of its own, with the question and the
    // reply, without the thinking and the tool call.
    const html = readFileSync(join(gist.dir, 'index.html'), 'utf8');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<title>Pelican facts · Harness Relay</title>');
    const body = html.slice(html.indexOf('<body'));
    expect(body).toContain('What do pelicans eat?');
    expect(body).toContain('Hello from Claude (Claude Code). You said: “What do pelicans eat?”.');
    expect(body).not.toContain('tool-group');
    expect(body).not.toContain('is thinking about');
    expect(body).not.toContain('README.md');

    // Settings lists it; removing it there deletes the gist.
    await dialog.getByRole('link', { name: 'Manage or remove shares in Settings' }).click();
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'Shared conversations' }) });
    const row = card.getByRole('listitem').filter({ hasText: 'Pelican facts' });
    await expect(row.getByRole('link', { name: 'Pelican facts' })).toHaveAttribute('href', `https://gistpreview.github.io/?${gistId}`);
    await expect(row).toContainText('Whole conversation');
    await expect(row.getByRole('link', { name: 'Open the gist on GitHub' })).toHaveAttribute('href', `https://gist.github.com/relay-e2e/${gistId}`);
    expect(await relay.api<{ id: string }[]>('/api/shares')).toEqual([expect.objectContaining({ id: gistId, conversationId: id })]);

    acceptNextDialog(page);
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(card.getByText('Removed 1 shared page.')).toBeVisible();
    await expect(card.getByText('Nothing shared yet.')).toBeVisible();
    expect(ghCalls(relay).at(-1)).toEqual(['gist', 'delete', gistId, '--yes']);
    expect(existsSync(gist.dir)).toBe(false);
    expect(await relay.api('/api/shares')).toEqual([]);
  });

  test.describe('with gh signed out', () => {
    test.use({ serverEnv: { E2E_FAKE_SIGNED_OUT: 'gh' } });

    test('sharing says how to sign gh in, and nothing is shared', async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Not yet');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await expect(help).toBeVisible();
      await expect(help.getByText('gh auth login', { exact: true })).toBeVisible();
      await expect(help).toContainText('Then come back and press "Create link" again.');
      // Not the help for a missing gh, and ready for another try.
      await expect(help).not.toContainText('brew install gh');
      await expect(dialog.getByRole('button', { name: 'Create link' })).toBeEnabled();
      expect(ghCalls(relay)).toEqual([['gist', 'create', '--filename', 'index.html', '--desc', 'Not yet · Harness Relay', '-']]);
      expect(await relay.api('/api/shares')).toEqual([]);
    });
  });

  test.describe('without gh', () => {
    // A `gh` whose `#!` names no program fails to start as one that is not there does (ENOENT).
    // Leaving gh off the PATH would not do: the server also looks where Homebrew puts it, where a
    // developer's real gh is.
    test.skip(process.platform === 'win32', 'Windows has no #! line to stand in for a missing gh');
    test.use({
      serverEnv: async ({ fakeBinDir }, use) => {
        const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-no-gh-'));
        writeFileSync(join(dir, 'gh'), '#!/nonexistent/relay-e2e/no-such-program\n');
        chmodSync(join(dir, 'gh'), 0o755);
        await use({ PATH: [dir, fakeBinDir, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) });
        rmSync(dir, { recursive: true, force: true });
      },
    });

    test('sharing says how to install gh and sign it in', async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
      await send(page, 'Share me');
      await finishedReply(page, 'Claude');
      await settled(relay, id);

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) not found' });
      await expect(help).toBeVisible();
      await expect(help.getByText('brew install gh', { exact: true })).toBeVisible();
      await expect(help.getByText('gh auth login', { exact: true })).toBeVisible();
      await expect(help).toContainText('Restart Harness Relay so it reads the new PATH.');
      expect(await relay.api('/api/shares')).toEqual([]);
    });
  });
});
