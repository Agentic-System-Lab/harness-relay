import { expect, test } from '../fixtures';
import { awaitingPlan, openTeamChat, replies, send, settled, startChat } from '../support/app';

test.describe('limits the environment sets', () => {
  test.use({ serverEnv: { RELAY_MAX_TEAM_AGENTS: '2', RELAY_MAX_ACCOUNTS: '2', RELAY_TURN_TIMEOUT_MIN: '90' } });

  test('the team editor stops adding members at RELAY_MAX_TEAM_AGENTS, and the server refuses more', async ({ page, relay }) => {
    expect(await relay.api('/api/limits')).toEqual({ maxAccounts: 2, maxTeamAgents: 2, turnTimeoutMinutes: 90 });
    await openTeamChat(page, relay, [{ name: 'Claude', provider: 'claude' }]);
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    const addCodex = drawer.getByRole('button', { name: '＋ Codex' });
    await expect(addCodex).toBeEnabled();
    await addCodex.click();
    // Two members: no more.
    for (const label of ['Claude Code', 'Codex', 'Grok']) await expect(drawer.getByRole('button', { name: `＋ ${label}` })).toBeDisabled();

    const three = ['A', 'B', 'C'].map((name) => ({ name, provider: 'claude', role: '' }));
    await expect(relay.api('/api/presets', { body: { name: 'Too big', agents: three } })).rejects.toThrow('400 {"error":"At most 2 agents"}');
  });

  test('a template larger than the limit says why it cannot be used, and the lead agent does not pick one', async ({ page, relay }) => {
    // The built-in templates have three members.
    await page.locator('.preset-card', { hasText: 'Three-way debate' }).locator('.preset-main').click();
    await expect(page.getByRole('dialog')).toContainText('A team may have at most 2 members');
    await page.keyboard.press('Escape');

    const id = await startChat(page);
    await send(page, 'Should we rewrite it? e2e:template=builtin-debate');
    const card = awaitingPlan(page);
    await expect(card).toContainText('Using the template "General-question panel" instead');
    await expect(card).toContainText('the template "Three-way debate" has more members than a team may have (2)');
    await card.getByRole('button', { name: 'Confirm team' }).click();
    const conv = await settled(relay, id);
    expect(conv.agents.map((a) => a.name)).toEqual(['Analyst', 'Critic']);
    await expect(replies(page, 'Synthesizer')).toHaveCount(0);
  });

  test("a schedule's hint gives the turn timeout RELAY_TURN_TIMEOUT_MIN sets", async ({ page }) => {
    await page.getByRole('button', { name: 'New schedule' }).click();
    // The schedule's own choice (the team's is above it).
    await page.getByRole('radiogroup', { name: 'Actions outside the permission' }).getByRole('radio', { name: 'Ask me' }).click();
    await expect(page.getByText('while you are away the agent waits (up to 90 minutes per turn)')).toBeVisible();
  });

  test('Settings stops adding accounts at RELAY_MAX_ACCOUNTS', async ({ page }) => {
    await page.getByRole('link', { name: /Settings & sign-in/ }).click();
    const card = page.locator('#settings-grok');
    await card.locator('summary', { hasText: 'Add an account' }).click();
    const add = card.getByRole('button', { name: 'Add an account' });
    await add.click();
    await expect(card).toContainText('Up to 2 accounts (the default one included)');
    await expect(add).toBeDisabled();
  });
});
