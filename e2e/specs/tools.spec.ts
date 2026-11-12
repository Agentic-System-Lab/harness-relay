import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { ToolLibraryView } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { acceptNextDialog, finishedReply, openTeamChat, replies, send, settled, type Member } from '../support/app';
import type { RelayServer } from '../support/relay';

/*
 * Settings → Tool library, as a person sets it up, and what each CLI then gets: the fakes say which
 * MCP servers they were given, the memory in their briefing, and the first line of each skill's
 * SKILL.md they could read (Claude Code only where its Read rules let it, as the real one).
 */
const TEAM: Member[] = [
  { name: 'Claude', provider: 'claude' },
  { name: 'Codex', provider: 'codex' },
  { name: 'Grok', provider: 'grok' },
];

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

test.describe('the tool library', () => {
  test('an MCP server added on the page reaches every CLI, with its secret masked and kept off the command line', async ({ page, relay }) => {
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
    await expect(form.getByRole('group', { name: 'Given by default to' }).getByRole('button', { pressed: true })).toHaveCount(3);
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

    const id = await openTeamChat(page, relay, TEAM);
    await send(page, 'Which tools do you have?');
    for (const m of TEAM) await expect(await finishedReply(page, m.name)).toContainText(HAS_MCP);
    await settled(relay, id);

    const log = relay.fakeLog();
    for (const m of TEAM) {
      // The server got the value…
      expect(log.some((e) => e.cli === m.provider && e.mcpEnv?.['e2e-tools']?.E2E_TOKEN === SECRET)).toBe(true);
      // …and no CLI was started with it.
      for (const start of log.filter((e) => e.cli === m.provider && e.args)) expect(JSON.stringify(start.args)).not.toContain(SECRET);
    }
    // Claude Code got it in a file of its own, gone once the turn ended.
    const claudeRun = log.find((e) => e.cli === 'claude' && e.args?.includes('--mcp-config'))!;
    const file = claudeRun.args![claudeRun.args!.indexOf('--mcp-config') + 1]!;
    await expect.poll(() => existsSync(file)).toBe(false);
  });

  test("an MCP server turned off for a CLI, or in a member's Tools, is not given", async ({ page, relay }) => {
    await relay.api('/api/tools/mcp/e2e-tools', {
      method: 'PUT',
      body: { transport: 'stdio', command: 'e2e-mcp-server', args: [], env: [{ name: 'E2E_TOKEN', value: SECRET }] },
    });
    const card = await toolLibrary(page, relay);
    const server = card.locator('.lib-row', { hasText: 'e2e-tools' });
    await server.getByRole('button', { name: 'Edit' }).click();
    const form = card.locator('.mcp-form');
    await form.getByRole('group', { name: 'Given by default to' }).getByRole('button', { name: 'Codex' }).click();
    await expect(form).toContainText('Only Claude Code, Grok');
    // Its value is kept: the row is left empty.
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(card.locator('.lib-row', { hasText: 'e2e-tools' })).toContainText('Only Claude Code, Grok');

    const id = await openTeamChat(page, relay, TEAM);
    await send(page, 'Which tools do you have?');
    await expect(await finishedReply(page, 'Claude')).toContainText(HAS_MCP);
    await expect(await finishedReply(page, 'Codex')).not.toContainText("My tool library's MCP servers");
    await expect(await finishedReply(page, 'Grok')).toContainText(HAS_MCP);
    await settled(relay, id);

    // A member's Tools: given to this Codex member after all, taken away from Grok.
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    await setMemberTool(page, 1, 'e2e-tools', true);
    await setMemberTool(page, 2, 'e2e-tools', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'And now?');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “And now?”. ' + HAS_MCP);
    await expect(await finishedReply(page, 'Codex')).toContainText('You said: “And now?”. ' + HAS_MCP);
    // Its second reply, finished: before that, a check that something is missing would pass on a
    // reply still streaming (or on the first one).
    await expect(replies(page, 'Grok')).toHaveCount(2);
    const grok = await finishedReply(page, 'Grok');
    await expect(grok).toContainText('You said: “And now?”.');
    await expect(grok).not.toContainText("My tool library's MCP servers");
    // The secret still reaches the server it is given to.
    expect(relay.fakeLog().some((e) => e.cli === 'codex' && e.mcpEnv?.['e2e-tools']?.E2E_TOKEN === SECRET)).toBe(true);
  });

  test('a skill picked from a folder on the page is in each CLI\'s briefing, and each reads its SKILL.md', async ({ page, relay }) => {
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

    const id = await openTeamChat(page, relay, TEAM);
    await send(page, 'Write the notes e2e:skills');
    for (const m of TEAM) {
      const reply = await finishedReply(page, m.name);
      // Claude Code reads it outside its working directory only by the Read rule its adapter adds.
      await expect(reply).toContainText('I read the skill release-notes: “Begin each note with the words Shipped today.”.');
      await expect(reply).not.toContainText('haiku');
    }
    await settled(relay, id);
    for (const m of TEAM) {
      const turn = relay.fakeLog().find((e) => e.cli === m.provider && e.prompt?.includes('Write the notes'))!;
      expect(turn.briefing).toContain(`- release-notes: Write release notes in the house style (${join(skills, 'release-notes', 'SKILL.md')})`);
    }
  });

  test("a skill turned off for a CLI, or in a member's Tools, is not given", async ({ page, relay }) => {
    const dir = writeSkill(join(relay.root, 'skills', 'release-notes'), 'release-notes', 'Write release notes', 'Begin each note with the words Shipped today.');
    const card = await toolLibrary(page, relay);
    // A folder that is a skill itself is added at once.
    await card.getByRole('textbox', { name: 'Skill folder path' }).fill(dir);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    const picks = card.getByRole('group', { name: 'release-notes: Given by default to' });
    await expect(picks.getByRole('button', { pressed: true })).toHaveCount(3);
    await picks.getByRole('button', { name: 'Grok' }).click();
    await expect(picks.getByRole('button', { name: 'Grok' })).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await relay.api<ToolLibraryView>('/api/tools')).skills[0]?.providers).toEqual(['claude', 'codex']);

    const id = await openTeamChat(page, relay, TEAM);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    await setMemberTool(page, 0, 'release-notes', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'Which skills? e2e:skills');
    await expect(await finishedReply(page, 'Claude')).toContainText('I was given no skills.');
    await expect(await finishedReply(page, 'Codex')).toContainText('I read the skill release-notes: “Begin each note with the words Shipped today.”.');
    await expect(await finishedReply(page, 'Grok')).toContainText('I was given no skills.');
    await settled(relay, id);
    // Neither in Claude Code's briefing nor in a Read rule for its folder.
    const claudeRun = relay.fakeLog().filter((e) => e.cli === 'claude' && e.args?.includes('--append-system-prompt')).pop()!;
    expect(JSON.stringify(claudeRun.args)).not.toContain('release-notes');
  });

  test("memory for all members and for one CLI reaches each CLI's briefing, and a member's Tools can leave it out", async ({ page, relay }) => {
    const card = await toolLibrary(page, relay);
    const memory = card.locator('.tools-section', { has: page.getByRole('heading', { name: 'Memory' }) });
    await memory.getByRole('textbox', { name: 'Memory: All members' }).fill('Lead with the conclusion.');
    // A click while the page still settles can land without switching tabs: click until it is selected.
    const codexTab = memory.getByRole('tab', { name: 'Codex', exact: true });
    await expect(async () => {
      await codexTab.click();
      await expect(codexTab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
    }).toPass();
    await memory.getByRole('textbox', { name: 'Memory: Codex' }).fill('Indent with tabs.');
    await memory.getByRole('button', { name: 'Save' }).click();
    await expect(memory).toContainText('Saved');
    expect((await relay.api<ToolLibraryView>('/api/tools')).memory).toMatchObject({ all: 'Lead with the conclusion.', codex: 'Indent with tabs.', claude: '', grok: '' });

    const id = await openTeamChat(page, relay, TEAM);
    await send(page, 'What do you remember? e2e:memory');
    await expect(await finishedReply(page, 'Claude')).toContainText('My memory: “Lead with the conclusion.”.');
    // The CLI's own part comes after the shared one.
    await expect(await finishedReply(page, 'Codex')).toContainText('My memory: “Lead with the conclusion. Indent with tabs.”.');
    await expect(await finishedReply(page, 'Grok')).toContainText('My memory: “Lead with the conclusion.”.');
    await settled(relay, id);

    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    await setMemberTool(page, 2, 'Shared memory', false);
    await page.getByRole('dialog', { name: 'Team settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Team settings' })).toBeHidden();

    await send(page, 'And now? e2e:memory');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “And now?”. My memory: “Lead with the conclusion.”.');
    await expect(await finishedReply(page, 'Grok')).toContainText('You said: “And now?”. I have no memory notes.');
  });

  test('an MCP server given a new value on the page gets it at the next turn, and once removed it is given no more', async ({ page, relay }) => {
    const NEW = 'n3w-e2e-token-9876';
    await relay.api('/api/tools/mcp/e2e-tools', {
      method: 'PUT',
      body: { transport: 'stdio', command: 'e2e-mcp-server', args: [], env: [{ name: 'E2E_TOKEN', value: SECRET }] },
    });
    // Another server, which stays: a turn after the changes still gets the library's servers.
    await relay.api('/api/tools/mcp/e2e-other', { method: 'PUT', body: { transport: 'stdio', command: 'e2e-other-server', args: [] } });
    const id = await openTeamChat(page, relay, TEAM);
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
      return relay.fakeLog().slice(from);
    };

    let turns = await nextTurns('And now?', 2);
    for (const m of TEAM) {
      await expect(replies(page, m.name).last()).toContainText("My tool library's MCP servers: e2e-tools, e2e-other.");
      // The server got the new value only, and no CLI was started with it.
      const given = turns.filter((e) => e.cli === m.provider && e.mcpEnv?.['e2e-tools']);
      expect(given.length).toBeGreaterThan(0);
      for (const e of given) expect(e.mcpEnv!['e2e-tools']).toEqual({ E2E_TOKEN: NEW });
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

  test('a skill and a memory note removed on the page are given no more', async ({ page, relay }) => {
    const skills = join(relay.root, 'skills');
    const notes = writeSkill(join(skills, 'release-notes'), 'release-notes', 'Write release notes', 'Begin each note with the words Shipped today.');
    const haiku = writeSkill(join(skills, 'haiku'), 'haiku', 'Answer in a haiku', 'Count the syllables.');
    // Memory for all members, and each CLI's own, which stays (as does the other skill): a turn after
    // the changes still gets the library's items.
    const own = 'Indent with tabs.';
    await relay.api('/api/tools', {
      method: 'PUT',
      body: { skills: [{ path: notes }, { path: haiku }], memory: { all: 'Lead with the conclusion.', claude: own, codex: own, grok: own } },
    });
    const id = await openTeamChat(page, relay, TEAM);
    await send(page, 'What do you know? e2e:memory e2e:skills');
    for (const m of TEAM) {
      const reply = await finishedReply(page, m.name);
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
    expect(lib.memory).toEqual({ all: '', claude: own, codex: own, grok: own });

    await page.goto(`${relay.base}/#/c/${id}`);
    await send(page, 'And now? e2e:memory e2e:skills');
    for (const m of TEAM) {
      await expect(replies(page, m.name)).toHaveCount(2);
      const reply = await finishedReply(page, m.name);
      await expect(reply).toContainText(`You said: “And now?”. My memory: “${own}”. I read the skill release-notes: “Begin each note with the words Shipped today.”.`);
      await expect(reply).not.toContainText('haiku');
    }
    await settled(relay, id);
    for (const m of TEAM) {
      const turn = relay.fakeLog().find((e) => e.cli === m.provider && e.prompt?.includes('And now?'))!;
      expect(turn.briefing).not.toContain('haiku');
      expect(turn.briefing).not.toContain('Lead with the conclusion.');
    }
  });
});
