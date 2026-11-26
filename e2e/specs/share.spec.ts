import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { devices, type Download, type Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, composer, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import type { RelayServer } from '../support/relay';
import { FAKE_OWNER, fakeGithub, openShared, writeGist } from '../support/share';
import { shareViewerUrl } from '../../src/shared/share';

/** A share's link: the viewer on Harness Relay's website, naming the gist the fake gh made (its owner, relay-e2e, and id). */
const VIEWER_LINK = /^https:\/\/agentic-system-lab\.github\.io\/harness-relay\/share\/#relay-e2e\/[0-9a-f]{32}$/;

/** The gist a share's link names. */
const gistOfLink = (link: string) => link.split('/').pop()!;

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

/** Gist operations and sign-ins are independent of the app picker's GitHub account checks. */
const ghCalls = (relay: RelayServer, command: 'gist' | 'auth') =>
  relay
    .fakeLog()
    .filter((e) => e.cli === 'gh')
    .map((e) => e.args ?? [])
    .filter((args) => args[0] === command);

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
    const second = [
      '---',
      '**User**',
      'Second question',
      '---',
      '**@Claude** · Claude Code',
      'Hello from Claude (Claude Code). You said: “Second question”.',
    ];

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

test.describe('copying a message on iOS', () => {
  test.use({ userAgent: devices['iPhone 13'].userAgent });

  test('a URL followed by a Chinese paragraph pastes back as the complete message', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    const url = 'https://example.com/a%20b?x=1&y=2';
    const message = `${url}\n\n幫我看這個網站做得如何？ 行銷做得如何？`;
    await send(page, message);
    await settled(relay, id);
    const bubble = page.locator('.msg-user');
    await expect(bubble.getByRole('link')).toHaveAttribute('href', url);
    await bubble.hover();
    const copy = bubble.getByRole('button', { name: 'Copy', exact: true });
    // Only the browser's default selection copy avoids the additional URL type on iOS.
    const nativeCopy = await page.evaluateHandle(() => {
      const observed = { used: false };
      window.addEventListener('copy', (event) => (observed.used = !event.defaultPrevented), { once: true });
      return observed;
    });
    await copy.click();
    await expect(bubble.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect((await nativeCopy.jsonValue()).used).toBe(true);
    await composer(page).press('ControlOrMeta+v');
    await expect(composer(page)).toHaveValue(message);
  });
});

test.describe('sharing as a secret gist', () => {
  test("a shared chat is a secret gist of the page the browser made, opened on Harness Relay's website, listed in Settings until removed", async ({
    page,
    relay,
  }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'Pelican facts');
    await send(page, 'What do pelicans eat? e2e:think e2e:tool');
    const reply = await finishedReply(page, 'Claude');
    // On screen, the reply shows its thinking and its tool call (folded).
    await expect(reply.locator('details.tool-group')).not.toHaveCount(0);
    await settled(relay, id);

    const dialog = await shareChat(page);
    await dialog.getByRole('button', { name: 'Create link' }).click();
    // The link is Harness Relay's viewer of the gist gh made, on its website.
    const link = dialog.getByRole('textbox', { name: 'Public link' });
    await expect(link).toHaveValue(VIEWER_LINK);
    const url = await link.inputValue();
    const gistId = gistOfLink(url);
    await expect(dialog.getByRole('link', { name: 'View the gist on GitHub' })).toHaveAttribute(
      'href',
      `https://gist.github.com/relay-e2e/${gistId}`,
    );

    // gh made a secret gist (its default: no --public) of one index.html, the page read from stdin.
    const create = ['gist', 'create', '--filename', 'index.html', '--desc', 'Pelican facts · Harness Relay', '-'];
    expect(ghCalls(relay, 'gist')).toEqual([create]);
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

    // Opened as its reader opens it: the viewer reads the gist's raw file (never GitHub's API, 60 times
    // an hour for each reader), says whose gist it is, and shows the page in a frame that runs nothing.
    const shared = await openShared(page.context(), fakeGithub(relay), url);
    await expect(shared.page.locator('#share-bar')).toHaveText(/Shared by @relay-e2e as a GitHub gist\s*View on GitHub/);
    await expect(shared.page.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      `https://gist.github.com/relay-e2e/${gistId}`,
    );
    await expect(shared.page).toHaveTitle('Pelican facts · Harness Relay');
    await expect(shared.frame.getByText('Hello from Claude (Claude Code). You said: “What do pelicans eat?”.')).toBeVisible();
    expect(await shared.page.locator('#share-frame').getAttribute('sandbox')).toBe(
      'allow-downloads allow-popups allow-popups-to-escape-sandbox',
    );
    expect(shared.rawCalls).toEqual([`https://gist.githubusercontent.com/relay-e2e/${gistId}/raw/index.html`]);
    expect(shared.apiCalls).toEqual([]);
    await shared.page.close();

    // Settings lists it; removing it there deletes the gist.
    await dialog.getByRole('link', { name: 'Manage or remove shares in Settings' }).click();
    const card = page.locator('section', { has: page.getByRole('heading', { name: 'Shared conversations' }) });
    const row = card.getByRole('listitem').filter({ hasText: 'Pelican facts' });
    await expect(row.getByRole('link', { name: 'Pelican facts' })).toHaveAttribute('href', url);
    await expect(row).toContainText('Whole conversation');
    await expect(row.getByRole('link', { name: 'Open the gist on GitHub' })).toHaveAttribute(
      'href',
      `https://gist.github.com/relay-e2e/${gistId}`,
    );
    expect(await relay.api<{ id: string }[]>('/api/shares')).toEqual([expect.objectContaining({ id: gistId, conversationId: id })]);

    acceptNextDialog(page);
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(card.getByText('Removed 1 shared page.')).toBeVisible();
    await expect(card.getByText('Nothing shared yet.')).toBeVisible();
    expect(ghCalls(relay, 'gist')).toEqual([create, ['gist', 'delete', gistId, '--yes']]);
    expect(existsSync(gist.dir)).toBe(false);
    expect(await relay.api('/api/shares')).toEqual([]);
    // Its link now says so.
    const gone = await openShared(page.context(), fakeGithub(relay), url);
    await expect(
      gone.page.getByText('This shared conversation is not on GitHub: it was removed, or the link was not copied whole.'),
    ).toBeVisible();
    await expect(gone.page.locator('#share-frame')).toBeHidden();
    // Asked GitHub's API once whether it is somewhere else now (refused here: still not found).
    expect(gone.apiCalls).toEqual([`https://api.github.com/gists/${gistId}`]);
    await expect(gone.page.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      `https://gist.github.com/relay-e2e/${gistId}`,
    );
    await gone.page.close();
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
      expect(ghCalls(relay, 'gist')).toEqual([['gist', 'create', '--filename', 'index.html', '--desc', 'Not yet · Harness Relay', '-']]);
      expect(ghCalls(relay, 'auth')).toEqual([]);
      expect(await relay.api('/api/shares')).toEqual([]);
    });

    test("signs gh in from the dialog with GitHub's code, then creates the link without another click", async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Signed in here');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      // The terminal's command is still there, as the other way.
      await expect(help.getByText('gh auth login', { exact: true })).toBeVisible();
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();

      // gh's own device sign-in, run by the server: GitHub's code to copy and the page to enter it on.
      await expect(help.getByText('Waiting for authorisation…')).toBeVisible();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      await expect(help.getByRole('link', { name: /github\.com\/login\/device/ })).toHaveAttribute(
        'href',
        'https://github.com/login/device',
      );
      expect(ghCalls(relay, 'auth')).toContainEqual(['auth', 'login', '--web', '--hostname', 'github.com']);

      // Approved on GitHub: gh is signed in, and the dialog makes the link by itself.
      writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
      const link = dialog.getByRole('textbox', { name: 'Public link' });
      await expect(link).toHaveValue(VIEWER_LINK);
      await expect(dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' })).toHaveCount(0);
      expect(ghCalls(relay, 'gist')).toEqual([
        ['gist', 'create', '--filename', 'index.html', '--desc', 'Signed in here · Harness Relay', '-'],
        ['gist', 'create', '--filename', 'index.html', '--desc', 'Signed in here · Harness Relay', '-'],
      ]);
      expect(await relay.api('/api/shares')).toHaveLength(1);
    });

    test('removing a share in Settings with gh signed out signs it in there, then removes it', async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Remove me later');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);
      // A share made while gh was signed in (from the dialog), then gh signed out again.
      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
      const link = dialog.getByRole('textbox', { name: 'Public link' });
      await expect(link).toHaveValue(VIEWER_LINK);
      const gistId = gistOfLink(await link.inputValue());
      rmSync(join(relay.root, 'fake-github', 'signed-in'));
      rmSync(join(relay.root, 'fake-github', 'approve'));

      await dialog.getByRole('link', { name: 'Manage or remove shares in Settings' }).click();
      const card = page.locator('section', { has: page.getByRole('heading', { name: 'Shared conversations' }) });
      const row = card.getByRole('listitem').filter({ hasText: 'Remove me later' });
      acceptNextDialog(page);
      await row.getByRole('button', { name: 'Remove' }).click();
      const settingsHelp = card.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await expect(settingsHelp).toContainText('Then come back and remove it again.');
      await settingsHelp.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(settingsHelp.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
      // Signed in: the help says so and how to go on, and nothing on the card says gh is signed out any more.
      const signedIn = card.getByRole('status').filter({ hasText: 'Signed in to GitHub.' });
      await expect(signedIn).toContainText('Then come back and remove it again.');
      await expect(card.getByText(/not signed in/)).toHaveCount(0);
      // Removing asks first, so it is not done by itself: removed on the next try.
      expect(existsSync(fakeGist(relay, gistId).dir)).toBe(true);
      acceptNextDialog(page);
      await row.getByRole('button', { name: 'Remove' }).click();
      await expect(card.getByText('Removed 1 shared page.')).toBeVisible();
      expect(existsSync(join(relay.root, 'fake-github', 'gists', gistId))).toBe(false);
    });

    test('a sign-in still waiting is picked up when the dialog opens again, and a failed request keeps its code', async ({
      page,
      relay,
    }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Picked up');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);

      let dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      let help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();

      // The dialog closed and opened again, and Create link pressed while gh still waits for GitHub:
      // the same sign-in, its code shown again, and no new one started.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      await expect(help.getByRole('button', { name: 'Sign in to GitHub' })).toHaveCount(0);
      expect(ghCalls(relay, 'auth')).toHaveLength(1);

      // One request about it fails: the code stays, and it goes on asking.
      let failedOnce = false;
      await page.route('**/api/gh/login', async (route) => {
        if (route.request().method() === 'GET' && !failedOnce) {
          failedOnce = true;
          return route.abort();
        }
        await route.continue();
      });
      await expect.poll(() => failedOnce).toBe(true);
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();

      // Approved: the picked-up sign-in makes the link, once.
      writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
      await expect(dialog.getByRole('textbox', { name: 'Public link' })).toHaveValue(VIEWER_LINK);
      expect(await relay.api('/api/shares')).toHaveLength(1);
    });

    test('a sign-in from the dialog can be cancelled, and started again', async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Not now');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      await help.getByRole('button', { name: 'Cancel' }).click();
      await expect(help.getByText('Cancelled')).toBeVisible();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toHaveCount(0);
      // Nothing was shared, and it starts again: a new sign-in of gh, with its code.
      expect(await relay.api('/api/shares')).toEqual([]);
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      expect(ghCalls(relay, 'auth')).toHaveLength(2);
      await help.getByRole('button', { name: 'Cancel' }).click();
      await expect(help.getByText('Cancelled')).toBeVisible();
    });

    test("a sign-in GitHub refuses says so, with gh's words, and can be tried again", async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Denied');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      writeFileSync(join(relay.root, 'fake-github', 'deny'), '');
      await expect(help.getByText('Sign-in failed')).toBeVisible();
      await expect(help.getByText('error: authorization was denied by the user')).toBeVisible();
      await expect(help.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible();
      expect(await relay.api('/api/shares')).toEqual([]);
    });

    test('on a slow network the sign-in still makes one link, and only once', async ({ page, relay }) => {
      const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }], {}, 'Slow line');
      await send(page, 'Share me');
      await finishedReply(page, 'Grok');
      await settled(relay, id);
      // Every question about the sign-in takes longer than the second between them, as on a phone.
      await page.route('**/api/gh/login', async (route) => {
        if (route.request().method() === 'GET') await new Promise((done) => setTimeout(done, 2500));
        await route.continue();
      });

      const dialog = await shareChat(page);
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const help = dialog.getByRole('alert').filter({ hasText: 'GitHub CLI (gh) is not signed in' });
      await help.getByRole('button', { name: 'Sign in to GitHub' }).click();
      await expect(help.getByRole('button', { name: /ABCD-1234/ })).toBeVisible();
      writeFileSync(join(relay.root, 'fake-github', 'approve'), '');
      await expect(dialog.getByRole('textbox', { name: 'Public link' })).toHaveValue(VIEWER_LINK);
      // Answers still on their way when it was signed in make no second link.
      await page.waitForTimeout(6000);
      expect(await relay.api('/api/shares')).toHaveLength(1);
      expect(ghCalls(relay, 'gist')).toHaveLength(2);
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

test.describe("Harness Relay's viewer of shared conversations", () => {
  // A gist's page as Harness Relay shares it, with its generator (`generator: false`: someone else's page).
  const sharedPage = (title: string, body: string, o: { lang?: string; generator?: boolean; head?: string } = {}) =>
    [
      '<!doctype html>',
      `<html lang="${o.lang ?? 'en'}"><head><meta charset="utf-8">`,
      o.generator === false ? '' : '<meta name="generator" content="Harness Relay">',
      `<title>${title}</title>${o.head ?? ''}</head>`,
      `<body>${body}</body></html>`,
    ].join('\n');
  const gist = (n: number) => n.toString(16).repeat(32).slice(0, 32);

  test('a file that went along downloads from the viewer, in a tab of its own', async ({ browser, browserName }, testInfo) => {
    // Playwright's WebKit starts no download from a link at all, also on a page without a frame, sent as an attachment.
    test.skip(browserName === 'webkit', 'WebKit under Playwright downloads nothing a link opens');
    const root = testInfo.outputPath('github');
    const [PAGE, FILES] = [gist(1), gist(2)];
    // Not text: GitHub serves it as a download.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 255])]);
    writeGist(root, FILES, { 'report.pdf': pdf });
    const link = `https://gist.githubusercontent.com/${FAKE_OWNER}/${FILES}/raw/report.pdf`;
    writeGist(root, PAGE, {
      'index.html': sharedPage(
        'Report',
        `<p><a class="file-link" href="${link}" target="_blank" rel="noopener noreferrer">report.pdf</a></p>`,
      ),
    });
    const context = await browser.newContext();
    const downloads: Download[] = [];
    context.on('page', (p) => p.on('download', (d) => downloads.push(d)));
    const shared = await openShared(context, root, shareViewerUrl(FAKE_OWNER, PAGE));
    await shared.frame.getByRole('link', { name: 'report.pdf' }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0]!.suggestedFilename()).toBe('report.pdf');
    expect(readFileSync(await downloads[0]!.path())).toEqual(pdf);
    await context.close();
  });

  test("a gist's page runs nothing, loads nothing and moves no page: scripts, a refresh, links to the top or keeping their opener, images from elsewhere, a form", async ({
    browser,
  }, testInfo) => {
    const root = testInfo.outputPath('github');
    const ID = gist(3);
    const EVIL = 'https://evil.e2e.test';
    const ran = `document.body.insertAdjacentHTML('beforeend', '<p id=ran>ran</p>')`;
    writeGist(root, ID, {
      'index.html': sharedPage(
        'Hostile',
        [
          '<p id="words">Nothing here runs.</p>',
          `<script>${ran}</script>`,
          `<img src="x" onerror="${ran}">`,
          `<img src="${EVIL}/pixel.png">`,
          `<p><a id="top" href="${EVIL}/top" target="_top">top</a> <a id="opener" href="${EVIL}/opener" target="_blank" rel="opener">opener</a> <a id="plain" href="${EVIL}/plain">plain</a></p>`,
          `<form action="${EVIL}/form"><button id="send">Send</button></form>`,
        ].join('\n'),
        { head: `<meta http-equiv="refresh" content="0;url=${EVIL}/refresh">` },
      ),
    });
    const context = await browser.newContext();
    const evil: string[] = [];
    // A page elsewhere that would move the tab that opened it, if it could.
    await context.route(`${EVIL}/**`, (route) => {
      evil.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        contentType: 'text/html',
        body: `<title>…</title><script>try { opener.top.location = '${EVIL}/hijacked' } catch {} document.title = 'opener: ' + (window.opener === null)</script>`,
      });
    });
    const shared = await openShared(context, root, shareViewerUrl(FAKE_OWNER, ID));
    const viewer = shared.page.url();
    await expect(shared.frame.locator('#words')).toBeVisible();
    // Time for a refresh, a script or an image's error to have done something.
    await shared.page.waitForTimeout(1500);
    await expect(shared.frame.locator('#ran')).toHaveCount(0);
    expect(evil).toEqual([]);
    // Each link opens a tab of its own, which never learns what opened it: this one stays as it is.
    for (const id of ['top', 'opener', 'plain']) {
      const [tab] = await Promise.all([context.waitForEvent('page'), shared.frame.locator(`#${id}`).click()]);
      await expect(tab).toHaveTitle('opener: true');
      await tab.close();
      expect(shared.page.url(), id).toBe(viewer);
    }
    await shared.frame.locator('#send').click();
    await shared.page.waitForTimeout(500);
    expect(evil.sort()).toEqual(['/opener', '/plain', '/top']);
    expect(shared.page.url()).toBe(viewer);
    await expect(shared.frame.locator('#words')).toBeVisible();
    await context.close();
  });

  test("says what it cannot show, in the page's language or the browser's: another gist after the #, one Harness Relay did not share, an address that names none, GitHub failing", async ({
    browser,
  }, testInfo) => {
    const root = testInfo.outputPath('github');
    const [ZH, OTHER] = [gist(4), gist(5)];
    writeGist(root, ZH, { 'index.html': sharedPage('鵜鶘 · Harness Relay', '<p id="zh">鵜鶘吃魚。</p>', { lang: 'zh-TW' }) });
    writeGist(root, OTHER, { 'index.html': sharedPage('Sign in', '<p>Someone else’s page.</p>', { generator: false }) });
    const context = await browser.newContext({ locale: 'en-US' });
    // A page in Chinese: the bar is too.
    const shared = await openShared(context, root, shareViewerUrl(FAKE_OWNER, ZH));
    await expect(shared.frame.locator('#zh')).toBeVisible();
    await expect(shared.page.locator('#share-bar')).toHaveText(/由 @relay-e2e 以 GitHub gist 分享\s*在 GitHub 上查看/);
    await expect(shared.page).toHaveTitle('鵜鶘 · Harness Relay');
    expect(await shared.page.evaluate(() => document.documentElement.lang)).toBe('zh-TW');
    // Another gist after the #, without a reload: one that is not Harness Relay's is not shown, nor its title.
    await shared.page.evaluate((hash) => (location.hash = hash), `#${FAKE_OWNER}/${OTHER}`);
    await expect(
      shared.page.getByText('This gist is not a conversation shared from Harness Relay, so it is not shown here.'),
    ).toBeVisible();
    await expect(shared.page.locator('#share-frame')).toBeHidden();
    await expect(shared.page).toHaveTitle('Shared conversation · Harness Relay');
    await expect(shared.page.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      `https://gist.github.com/${FAKE_OWNER}/${OTHER}`,
    );
    // An address that names no gist: nothing to ask GitHub, and the way home.
    const asked = shared.rawCalls.length;
    await shared.page.evaluate(() => (location.hash = '#not-a-gist'));
    await expect(
      shared.page.getByText('This address does not name a shared conversation. Check that the link was copied whole.'),
    ).toBeVisible();
    await expect(shared.page.locator('#share-bar')).toBeHidden();
    await expect(shared.page.getByRole('link', { name: "Harness Relay's website" })).toHaveAttribute('href', '../');
    expect(shared.rawCalls).toHaveLength(asked);
    await shared.page.close();
    // GitHub failing: says so, with its answer, and asks its API nothing.
    const down = await openShared(context, root, shareViewerUrl(FAKE_OWNER, ZH), { rawStatus: 503 });
    await expect(
      down.page.getByText('Could not load the shared conversation from GitHub (HTTP 503). Try again in a moment.'),
    ).toBeVisible();
    expect(down.apiCalls).toEqual([]);
    await context.close();
  });

  test("finds a gist through GitHub's API when its owner has another name now, or the link names none, and asks it only then", async ({
    browser,
  }, testInfo) => {
    const root = testInfo.outputPath('github');
    const ID = gist(6);
    writeGist(root, ID, { 'index.html': sharedPage('Renamed · Harness Relay', '<p id="found">Found again.</p>') }, 'New-Name');
    const raw = `https://gist.githubusercontent.com/New-Name/${ID}/raw/0a1b2c/index.html`;
    const api = (id: string) =>
      id === ID
        ? { status: 200, json: { id: ID, owner: { login: 'New-Name' }, files: { 'index.html': { raw_url: raw } } } }
        : { status: 404 };
    const context = await browser.newContext();
    // The link names the owner as it was: the raw files have nothing there, the API says where it is now.
    const renamed = await openShared(context, root, shareViewerUrl('old-name', ID), { api });
    await expect(renamed.frame.locator('#found')).toBeVisible();
    await expect(renamed.page.locator('#share-bar')).toHaveText(/Shared by @New-Name as a GitHub gist/);
    expect(renamed.rawCalls).toEqual([`https://gist.githubusercontent.com/old-name/${ID}/raw/index.html`, raw]);
    expect(renamed.apiCalls).toEqual([`https://api.github.com/gists/${ID}`]);
    await renamed.page.close();
    // The id alone: the API first.
    const bare = await openShared(context, root, shareViewerUrl(undefined, ID), { api });
    await expect(bare.frame.locator('#found')).toBeVisible();
    expect(bare.apiCalls).toHaveLength(1);
    expect(bare.rawCalls).toEqual([raw]);
    await bare.page.close();
    // Under the owner it has: the raw files alone.
    const named = await openShared(context, root, shareViewerUrl('new-name', ID), { api });
    await expect(named.frame.locator('#found')).toBeVisible();
    expect(named.apiCalls).toEqual([]);
    await context.close();
  });
});
