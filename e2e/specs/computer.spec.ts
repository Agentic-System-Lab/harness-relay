import { copyFileSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openChatActions, openTeamChat, send } from '../support/app';
import { fakeCuaIn } from '../support/fake-cli';
import type { RelayServer } from '../support/relay';

/*
 * The chat's computer (Cua): Settings' Computer row, an agent's screenshot of it (Claude Code's fake,
 * `e2e:mcp`), its panel beside the chat (the screen, taking control, the user's clicks and keys, handing it
 * back), an agent refused while the user has it, the agent's hand-over through its card, and deleting it;
 * Settings' download of the desktop image, with its progress.
 * The fake Cua CLI (`e2e/fake-cli/fake-cua.cjs`) stands in for cua and its computer: it is linked into the
 * server's own Cua folder, as Settings' install puts it there; each of its starts and tool calls is in the
 * fake log. Installing Cua itself downloads from GitHub, which these tests never do: test/computer.test.ts
 * covers it.
 */

/** Cua installed in the server's own folder (`<data>/clis/cua`), as Settings' install puts it: the fake, linked there. */
function installFakeCua(relay: RelayServer, fakeBinDir: string): void {
  const dir = join(relay.dataDir, 'clis', 'cua');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, process.platform === 'win32' ? 'cua.exe' : 'cua');
  try {
    linkSync(fakeCuaIn(fakeBinDir), target);
  } catch {
    copyFileSync(fakeCuaIn(fakeBinDir), target);
  }
}

/** What the fake Cua was asked: its command lines, and the tools its MCP server was called with. */
const cuaLog = (relay: RelayServer) =>
  relay.fakeLog().filter((e) => (e as { cli?: string }).cli === 'cua') as unknown as {
    args?: string[];
    tool?: string;
    arguments?: Record<string, unknown>;
    /** `image pull`: the image, and what cua was asked to log. */
    pull?: string;
    cuaLog?: string;
  }[];

/** The computer's panel, opened from the chat's header. */
async function openComputer(page: Page) {
  const actions = await openChatActions(page);
  await actions.getByRole('button', { name: 'Computer', exact: true }).click();
  return page.getByRole('region', { name: 'Computer', exact: true });
}

test.describe('the chat’s computer', () => {
  test('an agent looks at it, the user watches, takes control, clicks and types, hands it back; Settings deletes it, then removes Cua', async ({
    page,
    relay,
    fakeBinDir,
  }) => {
    installFakeCua(relay, fakeBinDir);
    // Settings: Cua as Harness Relay installed it, and who may use the computer.
    await page.goto(`${relay.base}/#/settings/apps`);
    const row = page.locator('.app-row').filter({ hasText: 'Computer (Cua)' });
    await expect(row).toContainText('Cua 0.31.2 (installed by Harness Relay)');
    await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { computer: ['claude'] } } });

    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Computer');
    await send(page, 'Look at the computer {} e2e:mcp=computer_screenshot');
    const reply = await finishedReply(page, 'Claude', 60_000);
    await expect(reply).toContainText('The computer_screenshot tool said: Saved the screenshot as');
    await expect(reply).toContainText('1200×750 pixels');
    // Made at its first use, with Cua's Linux desktop, waited for until it takes input.
    expect(cuaLog(relay).some((e) => e.args?.join(' ').includes('sb create linux --name relay-'))).toBe(true);

    const panel = await openComputer(page);
    await expect(panel.locator('.computer-status')).toHaveText('On');
    await expect(panel).toContainText('The agents are at it; you watch');
    // One computer per working directory: the panel says whose it is.
    await expect(panel).toContainText(`Shared by the chats in ${relay.workDir}`);
    const screen = panel.locator('.computer-screen img');
    await expect(screen).toHaveAttribute('src', /^data:image\/png;base64,/);
    // Watching: a click on the screen goes nowhere.
    const clicks = () => cuaLog(relay).filter((e) => e.tool === 'computer_click').length;
    await screen.click({ force: true });
    expect(clicks()).toBe(0);

    await panel.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(panel).toContainText('You have control; the agents wait for you');
    const box = (await panel.locator('.computer-screen').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(clicks, { timeout: 10_000 }).toBe(1);
    const click = cuaLog(relay).find((e) => e.tool === 'computer_click')!;
    expect(click.arguments).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(Math.abs((click.arguments!.x as number) - 600)).toBeLessThan(40);
    await page.keyboard.type('hi');
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        cuaLog(relay)
          .filter((e) => e.tool === 'computer_type')
          .map((e) => e.arguments?.text)
          .join(''),
      )
      .toBe('hi');
    await expect.poll(() => cuaLog(relay).some((e) => e.tool === 'computer_key' && e.arguments?.key === 'enter')).toBe(true);

    // An agent's call waits for the user: refused, and told why.
    await send(page, 'Click {"x":1,"y":1} e2e:mcp=computer_click');
    const refused = await finishedReply(page, 'Claude', 60_000);
    await expect(refused).toContainText('The user has taken control of the computer');

    await panel.getByRole('button', { name: 'Hand back to the agents', exact: true }).click();
    await expect(panel).toContainText('The agents are at it; you watch');
    await panel.locator('.computer-recent summary').click();
    await expect(panel.locator('.computer-recent')).toContainText('You took control of the computer');

    // Deleting it is Settings' alone: its folder's row there, used by this chat.
    await expect(panel.getByRole('button', { name: 'Delete computer' })).toHaveCount(0);
    await page.goto(`${relay.base}/#/settings/apps`);
    const settings = page.locator('.app-row').filter({ hasText: 'Computer (Cua)' });
    await settings.locator('summary').first().click();
    const listed = settings.locator('.computer-list li');
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(relay.workDir);
    await expect(listed).toContainText('used by 1 chat');
    acceptNextDialog(page);
    await listed.getByRole('button', { name: `Delete the computer of ${relay.workDir}` }).click();
    await expect(settings.locator('.computer-list')).toContainText('No conversation has used a computer yet.');
    await expect.poll(() => cuaLog(relay).some((e) => e.args?.slice(0, 2).join(' ') === 'sb rm')).toBe(true);

    // Removing Cua altogether: its downloads and Harness Relay's own copy (no runtime of Cua's own here: a container engine).
    acceptNextDialog(page);
    await settings.getByRole('button', { name: 'Remove Cua' }).click();
    await expect(settings).toContainText('Removed Cua.');
    expect(cuaLog(relay).map((e) => e.args?.slice(0, 3).join(' '))).toEqual(expect.arrayContaining(['--json cache prune']));
    expect(cuaLog(relay).some((e) => e.args?.includes('host'))).toBe(false);
    await expect(settings.getByRole('button', { name: 'Install Cua' })).toBeVisible();
  });

  test('an agent asks the user to take over: the card opens the computer, the user hands it back with a note', async ({
    page,
    relay,
    fakeBinDir,
  }) => {
    installFakeCua(relay, fakeBinDir);
    await relay.api('/api/tools', { method: 'PUT', body: { relayTools: { computer: ['claude'] } } });
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], { permission: 'full' }, 'Take over');
    await send(page, 'Please sign in {"reason":"Sign in to the site, then hand it back"} e2e:mcp=computer_hand_over');
    const card = page.getByRole('region', { name: '@Claude asks you to take over the computer' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Sign in to the site, then hand it back');
    await card.getByRole('button', { name: 'Take control of the computer' }).click();
    const panel = page.getByRole('region', { name: 'Computer', exact: true });
    await expect(panel).toContainText('You have control; the agents wait for you');
    await expect(panel).toContainText('@Claude asks you to take over:');
    await panel.getByPlaceholder('A note for the agent (optional)').fill('Signed in');
    await panel.getByRole('button', { name: 'Hand back to the agents', exact: true }).click();
    const reply = await finishedReply(page, 'Claude', 60_000);
    await expect(reply).toContainText(
      'The computer_hand_over tool said: The user took control of the computer and handed it back, saying: "Signed in".',
    );
    await expect(reply.locator('.handover-done')).toContainText('Handed back (computer): Signed in');
  });

  test('Settings downloads the desktop image with its progress, again after it failed or was cancelled, and says it is downloaded', async ({
    page,
    relay,
    fakeBinDir,
  }) => {
    installFakeCua(relay, fakeBinDir);
    // The fake cua's pull fails while this file says so, as cua does without a container engine.
    const steer = join(relay.home, '.cua', 'fake-cua-pull.json');
    mkdirSync(join(relay.home, '.cua'), { recursive: true });
    writeFileSync(steer, JSON.stringify({ fail: 'a container engine is not available' }));
    await page.goto(`${relay.base}/#/settings/apps`);
    const row = page.locator('.app-row').filter({ hasText: 'Computer (Cua)' });
    await row.locator('summary').first().click();
    const image = row.locator('.computer-image');
    await expect(image).toContainText("Not downloaded yet: a computer's first start would download it");
    await image.getByRole('button', { name: 'Download the desktop image' }).click();
    await expect(image.getByRole('alert')).toContainText(
      'Could not download the desktop image: cua: provider not configured: a container engine is not available',
    );
    // Slowly, then cancelled on the user's word: back to where it was.
    writeFileSync(steer, JSON.stringify({ stepMs: 1000 }));
    await image.getByRole('button', { name: 'Download again' }).click();
    await expect(image.locator('progress')).toBeVisible();
    await image.getByRole('button', { name: 'Cancel' }).click();
    await expect(image).toContainText("Not downloaded yet: a computer's first start would download it");
    rmSync(steer);
    await image.getByRole('button', { name: 'Download the desktop image' }).click();
    // Docker's progress, as cua logs it: how much of the image, with a bar; then downloaded.
    await expect(image).toContainText('Downloading the desktop image…');
    await expect(image).toContainText(/Downloading: \d+ of 324 MB \(\d+%\)/);
    await expect(image.locator('progress')).toBeVisible();
    await expect(image).toContainText('The desktop image is downloaded: computers start in seconds, the first one too.', {
      timeout: 15_000,
    });
    const pulls = cuaLog(relay).filter((e) => e.pull);
    expect(pulls.map((e) => e.pull)).toEqual(Array(3).fill('ghcr.io/trycua/linux:24.04'));
    expect(pulls[2]!.cuaLog).toBe('info,bollard::read=debug');
    // Kept: a later visit says the same, with nothing to download.
    await page.reload();
    await row.locator('summary').first().click();
    await expect(image).toContainText('The desktop image is downloaded');
    await expect(image.getByRole('button')).toHaveCount(0);
  });

  test('without Cua, Settings offers to install it and the panel says it is missing', async ({ page, relay }) => {
    await page.goto(`${relay.base}/#/settings/apps`);
    const row = page.locator('.app-row').filter({ hasText: 'Computer (Cua)' });
    await row.locator('summary').first().click();
    await expect(row).toContainText('Installs Cua 0.31.2 (the official release, its checksum checked)');
    await expect(row.getByRole('button', { name: 'Install Cua' })).toBeVisible();
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }], {}, 'No Cua');
    const panel = await openComputer(page);
    await expect(panel).toContainText('Cua is not installed here.');
  });
});
