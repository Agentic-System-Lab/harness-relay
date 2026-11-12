import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, awaitingPlan, finishedReply, openTeamChat, replies, send, settled, startChat } from '../support/app';
import type { RelayServer } from '../support/relay';

/** A skill the CLI finds by itself: `<dir>/<name>/SKILL.md`, as the real CLIs keep theirs. */
function writeSkill(dir: string, name: string, description: string): string {
  const file = join(dir, name, 'SKILL.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nA skill for the end-to-end tests.\n`);
  return file;
}

/** Opens a CLI's "loads by itself" box in Settings (its default account's) and asks the CLI. */
async function askCli(page: Page, provider: Provider) {
  await page.goto(page.url().replace(/#.*$/, `#/settings/${provider}`));
  const box = page.locator(`#settings-${provider} details.native-setup`);
  await box.locator('summary').click();
  await box.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(box.getByRole('button', { name: 'Ask again', exact: true })).toBeVisible();
  return box;
}

/** Asks the CLI again (what is left out changed since its answer). */
async function askAgain(box: ReturnType<Page['locator']>) {
  await expect(box).toContainText('What is left out changed after this answer');
  await box.getByRole('button', { name: 'Ask again', exact: true }).click();
  await expect(box).toContainText('Asked again the way Harness Relay starts this CLI');
}

/** The skills a member's CLI loaded by itself in the turn that got `text`. */
function turnSkills(relay: RelayServer, provider: Provider, text: string): string[] | undefined {
  return relay.fakeLog().find((e) => e.cli === provider && e.prompt?.includes(text))?.skills;
}

/**
 * Makes the working directory a repository of its own. Grok trusts a whole project, the repository's
 * root: without this, a temporary folder inside a repository (a home kept in git, a repository at
 * C:\) would make that repository's root the project.
 */
const ownRepository = (relay: RelayServer) => execFileSync('git', ['init', '-q'], { cwd: relay.workDir, stdio: 'ignore' });

/** Grok's folder-trust store in its home (the default account's). */
const trustStore = (relay: RelayServer) => join(relay.home, '.grok', 'trusted_folders.toml');
/** Whether the store trusts the working directory (`[folders."…work"]`, `trusted = true`). */
const trustsWorkDir = (relay: RelayServer) =>
  existsSync(trustStore(relay)) && /\[folders\."[^"\n]*work"\]\ntrusted = true\n/.test(readFileSync(trustStore(relay), 'utf8'));

test.describe('what each CLI loads by itself', () => {
  test('claude: its own skill is listed, and one left out is not loaded in its next run', async ({ page, relay }) => {
    writeSkill(join(relay.home, '.claude', 'skills'), 'e2e-review', 'Review a change the e2e way');
    // Before: Claude Code loads it.
    const chat = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await send(page, 'Before leaving it out');
    await finishedReply(page, 'Claude');
    expect(turnSkills(relay, 'claude', 'Before leaving it out')).toEqual(['e2e-review']);

    const box = await askCli(page, 'claude');
    await expect(box.getByRole('tab', { name: /^Skills \(1\)/ })).toBeVisible();
    await expect(box.locator('.native-list')).toContainText('e2e-review');
    await expect(box.locator('.native-list')).toContainText('Review a change the e2e way');
    // Left out alone, by its name (Claude Code's skillOverrides).
    await box.getByRole('checkbox', { name: "Leave e2e-review out of Harness Relay's runs" }).check();
    await expect(box.getByRole('tab', { name: /^Skills/ })).toContainText('1 left out');
    await askAgain(box);
    await expect(box.locator('.native-list li', { hasText: 'e2e-review' })).toContainText('left out');

    await page.goto(`${relay.base}/#/c/${chat}`);
    await send(page, 'After leaving it out');
    // Its second reply, finished, so that the turn is in the log.
    await expect(replies(page, 'Claude')).toHaveCount(2);
    await finishedReply(page, 'Claude');
    expect(turnSkills(relay, 'claude', 'After leaving it out')).toEqual([]);
  });

  test('codex: its own skill is listed by its file, and one left out is not loaded in its next run', async ({ page, relay }) => {
    const file = writeSkill(join(relay.home, '.codex', 'skills'), 'e2e-notes', 'Take notes the e2e way');
    const box = await askCli(page, 'codex');
    const item = box.locator('.native-list li', { hasText: 'e2e-notes' });
    await expect(item).toContainText('Take notes the e2e way');
    await expect(item).toHaveAttribute('title', file);
    // Left out alone, by its path (Codex's skills.config); Codex is asked again with that override.
    await box.getByRole('checkbox', { name: "Leave e2e-notes out of Harness Relay's runs" }).check();
    await askAgain(box);
    await expect(item).toContainText('left out');

    const id = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    await send(page, 'After leaving it out');
    // The run checks that Codex took it out (`skills/list` once the thread started), and answers.
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “After leaving it out”.');
    await settled(relay, id);
    expect(turnSkills(relay, 'codex', 'After leaving it out')).toEqual([]);
  });

  test("grok: the Grok card shows the folder's trust, trusting it loads the project's skills, and leaving them out reaches its next run", async ({
    page,
    relay,
  }) => {
    ownRepository(relay);
    // A skill Grok takes from Claude Code's folder in the project: only in a folder it trusts.
    writeSkill(join(relay.workDir, '.claude', 'skills'), 'e2e-grok', 'A project skill');
    const box = await askCli(page, 'grok');
    await expect(box.locator('.grok-trust')).toContainText(`Grok does not trust ${relay.workDir}`);
    await expect(box.getByRole('tab', { name: /^Skills \(0\)/ })).toBeVisible();

    acceptNextDialog(page);
    await box.getByRole('button', { name: 'Trust this folder' }).click();
    await expect(box).toContainText("✓ Grok trusts this folder: it loads the project's own instructions, skills and MCP servers.");
    expect(trustsWorkDir(relay)).toBe(true);
    await expect(box.locator('.native-list')).toContainText('e2e-grok');

    // Grok leaves out only all of a kind, and only what it takes from Claude Code and Cursor.
    await box.getByRole('tab', { name: /^Skills/ }).click();
    await box.getByRole('checkbox', { name: 'Leave all out' }).check();
    await askAgain(box);
    await expect(box.locator('.native-list li', { hasText: 'e2e-grok' })).toContainText('left out');

    const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }]);
    await send(page, 'After leaving them out');
    await finishedReply(page, 'Grok');
    await settled(relay, id);
    const turn = relay.fakeLog().find((e) => e.cli === 'grok' && e.prompt?.includes('After leaving them out'));
    expect(turn).toMatchObject({ trusted: true, skills: [] });
  });
});

test.describe("Grok's trust in a folder", () => {
  test('a team with a Grok member says when Grok does not trust the folder, and trusting it there records the trust', async ({ page, relay }) => {
    ownRepository(relay);
    await startChat(page);
    await send(page, 'Look at this project e2e:team=grok');
    const card = awaitingPlan(page);
    await expect(card.locator('.grok-trust')).toContainText(`Grok does not trust ${relay.workDir}`);
    acceptNextDialog(page);
    await card.getByRole('button', { name: 'Trust this folder' }).click();
    // Trusted: the card has nothing more to say about it.
    await expect(card.locator('.grok-trust')).toHaveCount(0);
    expect(trustsWorkDir(relay)).toBe(true);

    await card.getByRole('button', { name: 'Confirm team' }).click();
    await finishedReply(page, 'Grok');
    expect(relay.fakeLog().find((e) => e.cli === 'grok' && e.prompt?.includes('Look at this project'))).toMatchObject({ trusted: true });
  });

  test('the team starts without trusting the folder when the user declines, and nothing is recorded', async ({ page, relay }) => {
    ownRepository(relay);
    await startChat(page);
    await send(page, 'Look at this project e2e:team=grok');
    const card = awaitingPlan(page);
    await expect(card.locator('.grok-trust')).toContainText('Grok does not trust');
    // The confirmation dismissed: nothing is written, and the note stays.
    page.once('dialog', (d) => void d.dismiss());
    await card.getByRole('button', { name: 'Trust this folder' }).click();
    await expect(card.locator('.grok-trust')).toContainText('Grok does not trust');

    await card.getByRole('button', { name: 'Confirm team' }).click();
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “Look at this project”.');
    expect(existsSync(trustStore(relay))).toBe(false);
    expect(relay.fakeLog().find((e) => e.cli === 'grok' && e.prompt?.includes('Look at this project'))).toMatchObject({ trusted: false });
  });
});
