import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send, settled } from '../support/app';
import type { RelayServer } from '../support/relay';

/** A member's card in the open Team settings drawer, by its name. */
function memberCard(page: Page, name: string) {
  const drawer = page.getByRole('dialog', { name: 'Team settings' });
  return drawer.locator('.agent-card').filter({ has: page.getByRole('textbox', { name: 'Agent name' }).and(page.locator(`[value="${name}"]`)) });
}

/** Picks a member's model and effort in Team settings, and saves the team. */
async function pickModel(page: Page, name: string, model: string, effort: string): Promise<void> {
  await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Team settings' });
  const card = memberCard(page, name);
  // The models come from the CLI: wait until its list is there.
  const models = card.getByRole('combobox', { name: /^Model/ });
  await expect(models.locator(`option[value="${model}"]`)).toHaveCount(1);
  await models.selectOption(model);
  await card.getByRole('combobox', { name: /^Reasoning effort/ }).selectOption(effort);
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(drawer).toBeHidden();
}

/** The fake's log of the turn that got `text`: its prompt entry and the arguments its CLI started with. */
function turnFor(relay: RelayServer, cli: 'claude' | 'codex' | 'grok', text: string) {
  const log = relay.fakeLog();
  const turn = log.find((e) => e.cli === cli && e.prompt?.includes(text));
  if (!turn) throw new Error(`No ${cli} turn got “${text}”`);
  const start = log.find((e) => e.cli === cli && e.pid === turn.pid && e.args);
  return { turn, args: start?.args ?? [] };
}

/** Whether `args` hold `flag` followed by `value`. */
const passes = (args: string[], flag: string, value: string) => args.some((a, i) => a === flag && args[i + 1] === value);

test.describe("a member's model and reasoning effort", () => {
  test('claude: the model and effort chosen for a member reach Claude Code as --model and --effort', async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await pickModel(page, 'Claude', 'opus', 'high');
    await send(page, 'Which model are you?');
    await expect(await finishedReply(page, 'Claude')).toContainText('You said: “Which model are you?”.');
    const conv = await settled(relay, id);
    expect(conv.agents[0]).toMatchObject({ model: 'opus', effort: 'high' });
    const { args } = turnFor(relay, 'claude', 'Which model are you?');
    expect(passes(args, '--model', 'opus')).toBe(true);
    expect(passes(args, '--effort', 'high')).toBe(true);
  });

  test("codex: the model and effort chosen for a member reach Codex's thread", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Codex', provider: 'codex' }]);
    // Codex's own list (`codex debug models`), with each model's own efforts.
    await pickModel(page, 'Codex', 'gpt-fake-mini', 'high');
    await send(page, 'Which model are you?');
    await finishedReply(page, 'Codex');
    const conv = await settled(relay, id);
    expect(conv.agents[0]).toMatchObject({ model: 'gpt-fake-mini', effort: 'high' });
    // `thread/start` names the model, and its config the effort (`model_reasoning_effort`).
    expect(turnFor(relay, 'codex', 'Which model are you?').turn).toMatchObject({ model: 'gpt-fake-mini', effort: 'high' });
  });

  test("grok: the model and effort chosen for a member are set on Grok's session", async ({ page, relay }) => {
    const id = await openTeamChat(page, relay, [{ name: 'Grok', provider: 'grok' }]);
    // Grok's own list (`grok models`).
    await pickModel(page, 'Grok', 'grok-fake-mini', 'high');
    await send(page, 'Which model are you?');
    await finishedReply(page, 'Grok');
    const conv = await settled(relay, id);
    expect(conv.agents[0]).toMatchObject({ model: 'grok-fake-mini', effort: 'high' });
    // Set with `session/set_config_option` before the prompt (the session started on grok-fake, medium).
    expect(turnFor(relay, 'grok', 'Which model are you?').turn).toMatchObject({ model: 'grok-fake-mini', effort: 'high' });
  });

  test("the default model and effort in Settings are what a member left on Default runs with", async ({ page, relay }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const card = page.locator('#settings-claude');
    await card.locator('summary', { hasText: 'Default model and reasoning effort' }).click();
    await card.getByRole('combobox', { name: /^Model/ }).selectOption('sonnet');
    await card.getByRole('combobox', { name: /^Reasoning effort/ }).selectOption('low');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.locator('summary', { hasText: 'Default model and reasoning effort' })).toContainText('(sonnet · Low)');

    // A member with no model of its own: the drawer says what Default is now.
    const id = await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const models = memberCard(page, 'Claude').getByRole('combobox', { name: /^Model/ });
    await expect(models.locator('option:checked')).toHaveText('Default: sonnet');
    await page.keyboard.press('Escape');

    await send(page, 'Which model are you?');
    await finishedReply(page, 'Claude');
    const conv = await settled(relay, id);
    // The member keeps "Default": the setting applies at each run.
    expect(conv.agents[0]!.model ?? '').toBe('');
    const { args } = turnFor(relay, 'claude', 'Which model are you?');
    expect(passes(args, '--model', 'sonnet')).toBe(true);
    expect(passes(args, '--effort', 'low')).toBe(true);
  });
});
