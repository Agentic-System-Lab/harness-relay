import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { PROVIDER_LABEL, PROVIDERS, type Provider, type ToolLibraryView } from '../../src/shared/types';
import { en } from '../../src/web/locales/en';
import { emptyLibraryText, noneForCliText, toolsHintText } from '../../src/web/tools';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, replies, send, settled } from '../support/app';
import { chatOf, eachHalf, libraryEnv, logged, skillReadAsks, teamOf, type Cli } from '../support/clis';
import type { RelayServer } from '../support/relay';

/*
 * Settings → Tool library, as a person sets it up, and what each CLI then gets: the fakes say which
 * MCP servers they were given, the memory in their briefing, and the first line of each skill's
 * SKILL.md they could read (Claude Code only where its Read rules let it, as the real one).
 *
 * Each test runs twice: with a team of the CLIs with a sign-in, and with one of the open agents
 * (`open agents: …`), of those whose fake is written. A test that turns an item off for one CLI and
 * on or off for one member takes the team's second and third members for that (Codex and Grok in
 * the first team).
 */

const SECRET = 's3cr3t-e2e-token';
const HAS_MCP = "My tool library's MCP servers: e2e-tools.";

/** The Tool library card of the settings page. */
async function toolLibrary(page: Page, relay: RelayServer): Promise<Locator> {
  await page.goto(`${relay.base}/#/settings/tools`);
  const card = page.locator('#settings-tools');
  await expect(card.getByRole('heading', { name: 'MCP servers' })).toBeVisible();
  return card;
}

/** A skill folder with its SKILL.md, outside the working directory (as in ~/.claude/skills). */
function writeSkill(dir: string, name: string, description: string, firstLine: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${firstLine}\n\nMore steps follow.\n`);
  return dir;
}

/** A member's card in the open Team settings drawer, by its place in the team. */
const memberCard = (page: Page, index: number) => page.getByRole('dialog', { name: 'Team settings' }).locator('.agent-card').nth(index);

/** Ticks (or unticks) a tool library item in a member's Tools. */
async function setMemberTool(page: Page, index: number, item: string, on: boolean): Promise<void> {
  const tools = memberCard(page, index).locator('.agent-tools');
  await tools.getByRole('button', { name: 'Change' }).click();
  await tools.getByRole('checkbox', { name: new RegExp(item) }).setChecked(on);
  await tools.getByRole('button', { name: 'Done' }).click();
}

/** A team chat of `team`, each member under its CLI's usual name. */
const teamChat = (page: Page, relay: RelayServer, team: Cli[]) => chatOf(page, relay, team.map((cli) => ({ cli })));

/** A member's reply once it has read the skills (`e2e:skills`): a CLI that asks before reading them is allowed to. */
async function readingReply(page: Page, c: Cli) {
  if (skillReadAsks(c)) await page.getByRole('region', { name: new RegExp(`^@${c.name} wants to`) }).getByRole('button', { name: 'Allow', exact: true }).click();
  return finishedReply(page, c.name);
}

/** What the tool library's summary says of an item given to every CLI but `off`. */
const allBut = (off: Provider) => `Only ${PROVIDERS.filter((p) => p !== off).map((p) => PROVIDER_LABEL[p]).join(', ')}`;

test("with an empty tool library, or one with nothing for its CLI, each member's Tools say what its own CLI loads by itself", async ({ page, relay }) => {
  // A CLI with a sign-in and an open agent: the card names each one's own case, not "no tools".
  await openTeamChat(page, relay, [
    { name: 'Claude', provider: 'claude' },
    { name: 'Goose', provider: 'goose' },
  ]);
  // While the library loads, a card says nothing of it: not that it is empty.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/tools', async (route) => {
    await held;
    await route.continue();
  });
  await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
  await expect(memberCard(page, 0).locator('.agent-tools')).toBeVisible();
  await expect(memberCard(page, 0).locator('.agent-tools')).toHaveText('Tools');
  release();
  for (const [index, provider] of [[0, 'claude'], [1, 'goose']] as const) {
    const tools = memberCard(page, index).locator('.agent-tools');
    await expect(tools).toContainText(emptyLibraryText(en, provider));
    await expect(tools.getByRole('link', { name: 'Go to Settings → Tool library' })).toBeVisible();
  }
  await expect(memberCard(page, 0).locator('.agent-tools')).toContainText('Claude Code also loads its own setup');
  await expect(memberCard(page, 1).locator('.agent-tools')).toContainText("Goose runs with a config folder of Harness Relay's own");

  // A memory note for another CLI only: the library is not empty, but it has nothing for theirs.
  await page.unroute('**/api/tools');
  await relay.api('/api/tools', { method: 'PUT', body: { memory: { codex: 'Run the tests first.' } } });
  await page.reload();
  await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
  for (const [index, provider] of [[0, 'claude'], [1, 'goose']] as const) {
    const tools = memberCard(page, index).locator('.agent-tools');
    await expect(tools).toContainText(noneForCliText(en, provider));
    await expect(tools).not.toContainText('is empty');
  }
});

eachHalf((half) => test.describe('the tool library', () => {
  test(half.title('an MCP server added on the page reaches every CLI, with its secret masked and kept off the command line'), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis);
    const card = await toolLibrary(page, relay);
    await expect(card).toContainText('No MCP servers yet.');
    await card.getByRole('button', { name: /Add MCP server/ }).click();
    const form = card.locator('.mcp-form');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill('e2e-tools');
    await form.getByRole('textbox', { name: 'Command' }).fill('e2e-mcp-server');
    await form.getByRole('textbox', { name: 'Arguments (one per line)' }).fill('--serve');
    await form.getByRole('button', { name: /Add a row/ }).click();
    const row = form.locator('.var-row');
    await row.getByRole('textbox', { name: 'Name' }).fill('E2E_TOKEN');
    await row.getByLabel('Value').fill(SECRET);
    // Given to every CLI's members by default.
    await expect(form.getByRole('group', { name: 'Given by default to' }).getByRole('button', { pressed: true })).toHaveCount(PROVIDERS.length);
    await form.getByRole('button', { name: 'Save' }).click();

    const server = card.locator('.lib-row', { hasText: 'e2e-tools' });
    await expect(server).toContainText('e2e-mcp-server --serve');
    await expect(server).toContainText('All members');
    // Shown again only masked: editing it leaves the value empty, to keep.
    await server.getByRole('button', { name: 'Edit' }).click();
    await expect(form.locator('.var-row').getByLabel('Value')).toHaveValue('');
    await expect(form.locator('.var-row').getByLabel('Value')).toHaveAttribute('placeholder', 'unchanged (s3c…ken)');
    await form.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.content()).not.toContain(SECRET);
    const lib = await relay.api<ToolLibraryView>('/api/tools');
    expect(lib.mcpServers[0]!.env).toEqual([{ name: 'E2E_TOKEN', masked: 's3c…ken' }]);
    expect(JSON.stringify(lib)).not.toContain(SECRET);

    const id = await teamChat(page, relay, TEAM);
    await send(page, 'Which tools do you have?');
    for (const m of TEAM) await expect(await finishedReply(page, m.name)).toContainText(HAS_MCP);
    await settled(relay, id);

    for (const m of TEAM) {
      // The server got the value…
      await logged(relay, (e) => e.cli === m.provider && e.mcpEnv?.['e2e-tools']?.E2E_TOKEN === SECRET);
      // …and no CLI was started with it.
      for (const start of relay.fakeLog().filter((e) => e.cli === m.provider && e.args)) expect(JSON.stringify(start.args)).not.toContain(SECRET);
    }
    // Claude Code got it in a file of its own, gone once the turn ended.
    if (TEAM.some((c) => c.provider === 'claude')) {
      const claudeRun = relay.fakeLog().find((e) => e.cli === 'claude' && e.args?.includes('--mcp-config'))!;
      const file = claudeRun.args![claudeRun.args!.indexOf('--mcp-config') + 1]!;
      await expect.poll(() => existsSync(file)).toBe(false);
    }
  });

  test(half.title("an MCP server turned off for a CLI, or in a member's Tools, is not given"), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis, 3);
    const [, off, other] = TEAM as [Cli, Cli, Cli];
    await relay.api('/api/tools/mcp/e2e-tools', {
      method: 'PUT',
      body: { transport: 'stdio', command: 'e2e-mcp-server', args: [], env: [{ name: 'E2E_TOKEN', value: SECRET }] },
    });
    const card = await toolLibrary(page, relay);
    const server = card.locator('.lib-row', { hasText: 'e2e-tools' });
    await server.getByRole('button', { name: 'Edit' }).click();
    const form = card.locator('.mcp-form');
    await form.getByRole('group', { name: 'Given by default to' }).getByRole('button', { name: off.label, exact: true }).click();
    await expect(form).toContainText(allBut(off.provider));
    // Its value is kept: the row is left empty.
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(card.locator('.lib-row', { hasText: 'e2e-tools' })).toContainText(allBut(off.provider));

    const id = await teamChat(page, relay, TEAM);
    await send(page, 'Which tools do you have?');
    for (const m of TEAM) {
      const reply = await finishedReply(page, m.name);
      if (m === off) await expect(reply).not.toContainText("My tool library's MCP servers");
      else await expect(reply).toContainText(HAS_MCP);
    }
    await settled(relay, id);

    // A member's Tools: given to the member of the CLI it is off for after all, taken away from the next.
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    // Over the items, what the member's own CLI loads by itself (an open agent: not its config folder in the home folder).
    const tools = memberCard(page, 1).locator('.agent-tools');
    await tools.getByRole('button', { name: 'Change' }).click();
    await expect(tools).toContainText(toolsHintText(en, off.provider));
    await tools.getByRole('button', { name: 'Done' }).click();
    await setMemberTool(page, 1, 'e2e-tools', true);
    await setMemberTool(page, 2, 'e2e-tools', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'And now?');
    for (const m of TEAM) {
      // Its second reply, finished: before that, a check that something is missing would pass on a
      // reply still streaming (or on the first one).
      await expect(replies(page, m.name)).toHaveCount(2);
      const reply = await finishedReply(page, m.name);
      if (m === other) {
        await expect(reply).toContainText('You said: “And now?”.');
        await expect(reply).not.toContainText("My tool library's MCP servers");
      } else await expect(reply).toContainText('You said: “And now?”. ' + HAS_MCP);
    }
    await settled(relay, id);
    // The secret still reaches the server it is given to.
    await logged(relay, (e) => e.cli === off.provider && e.mcpEnv?.['e2e-tools']?.E2E_TOKEN === SECRET);
  });

  test(half.title("a skill picked from a folder on the page is in each CLI's briefing, and each reads its SKILL.md"), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis);
    const skills = join(relay.root, 'skills');
    writeSkill(join(skills, 'release-notes'), 'release-notes', 'Write release notes in the house style', 'Begin each note with the words Shipped today.');
    writeSkill(join(skills, 'haiku'), 'haiku', 'Answer in a haiku', 'Count the syllables.');

    const card = await toolLibrary(page, relay);
    await expect(card).toContainText('No skills yet.');
    await card.getByRole('textbox', { name: 'Skill folder path' }).fill(skills);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    // A folder of skills: pick the ones to add.
    const picker = page.getByRole('dialog', { name: 'Choose skills to add' });
    await expect(picker).toContainText(`Found 2 skills in ${skills}.`);
    await picker.getByRole('checkbox', { name: /release-notes/ }).check();
    await picker.getByRole('button', { name: 'Add 1' }).click();
    await expect(picker).toBeHidden();
    const skill = card.locator('.lib-row', { hasText: 'release-notes' });
    await expect(skill).toContainText('Write release notes in the house style');
    await expect(skill).toContainText(join(skills, 'release-notes'));
    await expect(card.locator('.lib-row', { hasText: 'haiku' })).toHaveCount(0);

    const id = await teamChat(page, relay, TEAM);
    await send(page, 'Write the notes e2e:skills');
    for (const m of TEAM) {
      const reply = await readingReply(page, m);
      // Claude Code reads it outside its working directory only by the Read rule its adapter adds.
      await expect(reply).toContainText('I read the skill release-notes: “Begin each note with the words Shipped today.”.');
      await expect(reply).not.toContainText('haiku');
    }
    await settled(relay, id);
    for (const m of TEAM) {
      const [turn] = await logged(relay, (e) => e.cli === m.provider && e.prompt?.includes('Write the notes'));
      expect(turn!.briefing).toContain(`- release-notes: Write release notes in the house style (${join(skills, 'release-notes', 'SKILL.md')})`);
    }
  });

  test(half.title("a skill turned off for a CLI, or in a member's Tools, is not given"), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis, 3);
    const [first, , off] = TEAM as [Cli, Cli, Cli];
    const dir = writeSkill(join(relay.root, 'skills', 'release-notes'), 'release-notes', 'Write release notes', 'Begin each note with the words Shipped today.');
    const card = await toolLibrary(page, relay);
    // A folder that is a skill itself is added at once.
    await card.getByRole('textbox', { name: 'Skill folder path' }).fill(dir);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    const picks = card.getByRole('group', { name: 'release-notes: Given by default to' });
    await expect(picks.getByRole('button', { pressed: true })).toHaveCount(PROVIDERS.length);
    await picks.getByRole('button', { name: off.label, exact: true }).click();
    await expect(picks.getByRole('button', { name: off.label, exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await relay.api<ToolLibraryView>('/api/tools')).skills[0]?.providers).toEqual(PROVIDERS.filter((p) => p !== off.provider));

    const id = await teamChat(page, relay, TEAM);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    await setMemberTool(page, 0, 'release-notes', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'Which skills? e2e:skills');
    for (const m of TEAM) {
      if (m === first || m === off) await expect(await finishedReply(page, m.name)).toContainText('I was given no skills.');
      else await expect(await readingReply(page, m)).toContainText('I read the skill release-notes: “Begin each note with the words Shipped today.”.');
    }
    await settled(relay, id);
    // Neither in Claude Code's briefing nor in a Read rule for its folder.
    if (first.provider === 'claude') {
      const claudeRun = relay.fakeLog().filter((e) => e.cli === 'claude' && e.args?.includes('--append-system-prompt')).pop()!;
      expect(JSON.stringify(claudeRun.args)).not.toContain('release-notes');
    }
  });

  test(half.title("memory for all members and for one CLI reaches each CLI's briefing, and a member's Tools can leave it out"), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis, 3);
    const [first, own, other] = TEAM as [Cli, Cli, Cli];
    const card = await toolLibrary(page, relay);
    const memory = card.locator('.tools-section', { has: page.getByRole('heading', { name: 'Memory' }) });
    await memory.getByRole('textbox', { name: 'Memory: All members' }).fill('Lead with the conclusion.');
    // A click while the page still settles can land without switching tabs: click until it is selected.
    const ownTab = memory.getByRole('tab', { name: own.label, exact: true });
    await expect(async () => {
      await ownTab.click();
      await expect(ownTab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
    }).toPass();
    await memory.getByRole('textbox', { name: `Memory: ${own.label}` }).fill('Indent with tabs.');
    await memory.getByRole('button', { name: 'Save' }).click();
    await expect(memory).toContainText('Saved');
    expect((await relay.api<ToolLibraryView>('/api/tools')).memory).toMatchObject({
      all: 'Lead with the conclusion.',
      [own.provider]: 'Indent with tabs.',
      [first.provider]: '',
      [other.provider]: '',
    });

    const id = await teamChat(page, relay, TEAM);
    await send(page, 'What do you remember? e2e:memory');
    for (const m of TEAM) {
      // The CLI's own part comes after the shared one.
      await expect(await finishedReply(page, m.name)).toContainText(m === own ? 'My memory: “Lead with the conclusion. Indent with tabs.”.' : 'My memory: “Lead with the conclusion.”.');
    }
    await settled(relay, id);

    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    await setMemberTool(page, 2, 'Shared memory', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'And now? e2e:memory');
    await expect(await finishedReply(page, first.name)).toContainText('You said: “And now?”. My memory: “Lead with the conclusion.”.');
    await expect(replies(page, other.name)).toHaveCount(2);
    await expect(await finishedReply(page, other.name)).toContainText('You said: “And now?”. I have no memory notes.');
  });

  test(half.title('an MCP server given a new value on the page gets it at the next turn, and once removed it is given no more'), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis);
    const NEW = 'n3w-e2e-token-9876';
    await relay.api('/api/tools/mcp/e2e-tools', {
      method: 'PUT',
      body: { transport: 'stdio', command: 'e2e-mcp-server', args: [], env: [{ name: 'E2E_TOKEN', value: SECRET }] },
    });
    // Another server, which stays: a turn after the changes still gets the library's servers.
    await relay.api('/api/tools/mcp/e2e-other', { method: 'PUT', body: { transport: 'stdio', command: 'e2e-other-server', args: [] } });
    const id = await teamChat(page, relay, TEAM);
    await send(page, 'Which tools do you have?');
    for (const m of TEAM) await expect(await finishedReply(page, m.name)).toContainText("My tool library's MCP servers: e2e-tools, e2e-other.");
    await settled(relay, id);

    // A new value, typed where the masked one was.
    const card = await toolLibrary(page, relay);
    await card.locator('.lib-row', { hasText: 'e2e-tools' }).getByRole('button', { name: 'Edit' }).click();
    const form = card.locator('.mcp-form');
    await form.locator('.var-row').getByLabel('Value').fill(NEW);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toHaveCount(0);
    expect((await relay.api<ToolLibraryView>('/api/tools')).mcpServers.find((s) => s.name === 'e2e-tools')!.env).toEqual([{ name: 'E2E_TOKEN', masked: 'n3w…876' }]);

    /** What the CLIs logged during the next message's turns. */
    const nextTurns = async (text: string, n: number) => {
      const from = relay.fakeLog().length;
      await page.goto(`${relay.base}/#/c/${id}`);
      await send(page, text);
      for (const m of TEAM) {
        // Each member's reply to this message, finished.
        await expect(replies(page, m.name)).toHaveCount(n);
        await expect(await finishedReply(page, m.name)).toContainText(`You said: “${text}”.`);
      }
      await settled(relay, id);
      // Every member's prompt logged (a fake in Harness Relay's own sandbox sends its lines a moment later).
      for (const m of TEAM) await logged(relay, (e) => e.cli === m.provider && e.prompt?.includes(text));
      return relay.fakeLog().slice(from);
    };

    let turns = await nextTurns('And now?', 2);
    for (const m of TEAM) {
      await expect(replies(page, m.name).last()).toContainText("My tool library's MCP servers: e2e-tools, e2e-other.");
      // The server got the new value only, and no CLI was started with it.
      const given = turns.filter((e) => e.cli === m.provider && e.mcpEnv?.['e2e-tools']);
      expect(given.length).toBeGreaterThan(0);
      for (const e of given) expect(libraryEnv(m, e.mcpEnv!['e2e-tools']!)).toEqual({ E2E_TOKEN: NEW });
      for (const start of turns.filter((e) => e.cli === m.provider && e.args)) expect(JSON.stringify(start.args)).not.toContain(NEW);
    }

    await toolLibrary(page, relay);
    acceptNextDialog(page);
    await card.locator('.lib-row', { hasText: 'e2e-tools' }).getByRole('button', { name: 'Remove' }).click();
    await expect(card.locator('.lib-row', { hasText: 'e2e-tools' })).toHaveCount(0);
    expect((await relay.api<ToolLibraryView>('/api/tools')).mcpServers.map((s) => s.name)).toEqual(['e2e-other']);

    turns = await nextTurns('And after removing it?', 3);
    for (const m of TEAM) {
      await expect(replies(page, m.name).last()).toContainText("My tool library's MCP servers: e2e-other.");
      expect(turns.some((e) => e.cli === m.provider && e.mcpEnv?.['e2e-other'])).toBe(true);
      expect(turns.filter((e) => e.cli === m.provider && (e.mcpEnv?.['e2e-tools'] || e.mcp?.includes('e2e-tools')))).toEqual([]);
    }
  });

  test(half.title('a skill and a memory note removed on the page are given no more'), async ({ page, relay }) => {
    const TEAM = teamOf(half.clis);
    const skills = join(relay.root, 'skills');
    const notes = writeSkill(join(skills, 'release-notes'), 'release-notes', 'Write release notes', 'Begin each note with the words Shipped today.');
    const haiku = writeSkill(join(skills, 'haiku'), 'haiku', 'Answer in a haiku', 'Count the syllables.');
    // Memory for all members, and each CLI's own, which stays (as does the other skill): a turn after
    // the changes still gets the library's items.
    const own = 'Indent with tabs.';
    await relay.api('/api/tools', {
      method: 'PUT',
      body: { skills: [{ path: notes }, { path: haiku }], memory: { all: 'Lead with the conclusion.', ...Object.fromEntries(TEAM.map((m) => [m.provider, own])) } },
    });
    const id = await teamChat(page, relay, TEAM);
    await send(page, 'What do you know? e2e:memory e2e:skills');
    for (const m of TEAM) {
      const reply = await readingReply(page, m);
      await expect(reply).toContainText(`My memory: “Lead with the conclusion. ${own}”.`);
      await expect(reply).toContainText('I read the skill haiku: “Count the syllables.”.');
    }
    await settled(relay, id);

    const card = await toolLibrary(page, relay);
    await card.locator('.lib-row', { hasText: 'haiku' }).getByRole('button', { name: 'Remove' }).click();
    await expect(card.locator('.lib-row', { hasText: 'haiku' })).toHaveCount(0);
    const memory = card.locator('.tools-section', { has: page.getByRole('heading', { name: 'Memory' }) });
    await memory.getByRole('textbox', { name: 'Memory: All members' }).fill('');
    await memory.getByRole('button', { name: 'Save' }).click();
    await expect(memory).toContainText('Saved');
    const lib = await relay.api<ToolLibraryView>('/api/tools');
    expect(lib.skills.map((s) => s.name)).toEqual(['release-notes']);
    // Each team CLI's own note stays; the other CLIs have none.
    expect(lib.memory).toEqual({ ...Object.fromEntries(PROVIDERS.map((p) => [p, ''])), all: '', ...Object.fromEntries(TEAM.map((m) => [m.provider, own])) });

    await page.goto(`${relay.base}/#/c/${id}`);
    await send(page, 'And now? e2e:memory e2e:skills');
    for (const m of TEAM) {
      await expect(replies(page, m.name)).toHaveCount(2);
      const reply = await readingReply(page, m);
      await expect(reply).toContainText(`You said: “And now?”. My memory: “${own}”. I read the skill release-notes: “Begin each note with the words Shipped today.”.`);
      await expect(reply).not.toContainText('haiku');
    }
    await settled(relay, id);
    for (const m of TEAM) {
      const [turn] = await logged(relay, (e) => e.cli === m.provider && e.prompt?.includes('And now?'));
      expect(turn!.briefing).not.toContain('haiku');
      expect(turn!.briefing).not.toContain('Lead with the conclusion.');
    }
  });
}));
