import type { Page } from '@playwright/test';
import type { Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { finishedReply, openTeamChat, send, settled } from '../support/app';
import { chatWith, CLIS, eachCli, loggedModel } from '../support/clis';
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
function turnFor(relay: RelayServer, cli: Provider, text: string) {
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

  // The others: a model from the CLI's own list (Codex's `codex debug models`, Grok's `grok models`,
  // …; an open agent's from its model backends, the test's fake endpoint), with an effort it offers
  // for it; its fake logs the model and effort its turn ran with (Codex's thread, Grok's session, …).
  // (Codex's and Grok's tests keep the titles they had before the others joined.)
  const reach: Partial<Record<Provider, string>> = { codex: "reach Codex's thread", grok: "are set on Grok's session" };
  eachCli(CLIS.filter((c) => c.provider !== 'claude'), (cli) => {
    test(`${cli.provider}: the model and effort chosen for a member ${reach[cli.provider] ?? `reach ${cli.label}`}`, async ({ page, relay }) => {
      const { model, effort } = cli.pickModel;
      const id = await chatWith(page, relay, cli);
      await pickModel(page, cli.name, model, effort);
      await send(page, 'Which model are you?');
      await expect(await finishedReply(page, cli.name)).toContainText('You said: “Which model are you?”.');
      const conv = await settled(relay, id);
      // No effort (''): the CLI offers none for that model (OpenCode on an endpoint), so none is kept, and its turn runs on its own (null).
      expect(conv.agents[0]).toMatchObject({ model, ...(effort ? { effort } : {}) });
      await expect.poll(() => relay.fakeLog().some((e) => e.cli === cli.provider && e.prompt?.includes('Which model are you?'))).toBe(true);
      const logged = loggedModel(cli);
      expect(turnFor(relay, cli.provider, 'Which model are you?').turn).toMatchObject({ ...logged, effort: logged.effort || null });
    });
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
