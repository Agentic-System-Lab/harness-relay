import type { Page } from '@playwright/test';
import type { ChatMessage, Conversation, Provider } from '../../src/shared/types';
import { expect, test } from '../fixtures';
import { composer, replies, send } from '../support/app';
import type { RelayServer } from '../support/relay';
import { CLOUD, CLOUD_CLIS, ENDPOINTS, ENDPOINT_CLIS, OPEN, TYPED_MODEL, askPermission, endpointOf, has, modelId, ownModel, sessionBackend, setUpEndpoints, type LiveEndpoint } from './live';

test.use({ live: true });

/** The answer to 17 + 25, alone or in a sentence. */
const FORTY_TWO = /(^|\D)42(?!\d)/;

/** The error the member's turn ended with ("no error" when it ended without one), once it has ended. */
async function turnError(relay: RelayServer, id: string): Promise<string> {
  let error = '';
  await expect
    .poll(
      async () => {
        const last = (await relay.api<Conversation>(`/api/conversations/${id}`)).messages.filter((m) => m.author.kind === 'agent').at(-1);
        error = last && last.status !== 'streaming' ? (last.error ?? 'no error') : '';
        return error !== '';
      },
      { timeout: 5 * 60_000 },
    )
    .toBe(true);
  return error;
}

/** A reply's text, without its thinking or tools. */
const answer = (m: ChatMessage | undefined) => (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

/**
 * A chat of one member of this CLI on its default model, opened in the page; then, as a person would,
 * the member's model is picked in Team settings from the model menu (which lists the endpoint's
 * model), saved, and a question asked: the reply answers it.
 */
async function pickAndAsk(page: Page, relay: RelayServer, provider: Provider, model: string | undefined): Promise<Conversation> {
  const conv = await relay.api<Conversation>('/api/conversations', {
    body: {
      title: `${provider} ${model ?? 'own model'}`,
      agents: [{ id: 'm1', name: 'Ada', provider, role: '' }],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: askPermission(provider), approvals: 'deny', cwd: relay.workDir },
    },
  });
  // Loaded again: the page reads the model menus as it loads (Settings reads them again after a change
  // there), and the endpoints were set up through the API.
  await page.goto(`${relay.base}/#/c/${conv.id}`);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  if (model) {
    await page.locator('.chat-head').getByRole('button', { name: 'Team settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Team settings' });
    const select = drawer.getByRole('combobox', { name: 'Model', exact: true });
    // The menu lists the endpoint's model (asked of the CLI and the endpoints as the drawer opens).
    await expect(select.locator(`option[value="${model}"]`)).toHaveCount(1, { timeout: 120_000 });
    await select.selectOption(model);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer).toBeHidden();
  }
  await send(page, 'What is 17 + 25? Reply with only the number.');
  const reply = replies(page, 'Ada').last();
  await expect(reply).toBeVisible({ timeout: 120_000 });
  await expect(reply.locator('.live-tag')).toHaveCount(0, { timeout: 15 * 60_000 });
  const done = await relay.api<Conversation>(`/api/conversations/${conv.id}`);
  const last = done.messages.filter((m) => m.author.kind === 'agent').at(-1);
  expect(last?.error, 'the turn failed').toBeUndefined();
  expect(answer(last)).toMatch(FORTY_TWO);
  expect(done.agents[0]?.model ?? '').toBe(model ?? '');
  // Claude Code, Codex and Grok record where the session ran: the endpoint, or (none) their own service.
  if ((ENDPOINT_CLIS as readonly string[]).includes(provider)) expect(sessionBackend(relay, conv.id, 'm1')).toBe(endpointOf(model));
  return done;
}

for (const endpoint of ENDPOINTS) {
  test.describe(`a model of ${endpoint.name}`, () => {
    for (const provider of [...ENDPOINT_CLIS, ...OPEN].filter(has)) {
      test(`${provider}: picked in Team settings, it answers`, async ({ page, relay }) => {
        await setUpEndpoints(relay);
        await pickAndAsk(page, relay, provider, modelId(endpoint));
      });
    }
  });
}

test.describe("a CLI's default model set to an endpoint's in Settings", () => {
  const first = ENDPOINTS[0];
  test.skip(!first, 'needs an endpoint (E2E_LIVE_OLLAMA or E2E_LIVE_VLLM)');
  for (const provider of ENDPOINT_CLIS.filter(has)) {
    test(`${provider}: a member without a model of its own runs on it`, async ({ page, relay }) => {
      await setUpEndpoints(relay);
      const model = modelId(first!);
      // As a person would: the CLI's card, its default model picked from the menu's own endpoints, saved.
      await page.goto(page.url().replace(/#.*$/, `#/settings/${provider}`));
      await page.reload();
      const card = page.locator(`#settings-${provider}`);
      const section = card.locator('details.sub', { has: page.locator('summary', { hasText: 'Default model and reasoning effort' }) });
      const defaults = section.locator('summary');
      await defaults.click();
      const select = section.getByRole('combobox', { name: 'Model', exact: true });
      await expect(select.locator('optgroup[label="Your own endpoints (Settings → Model backends)"]').locator(`option[value="${model}"]`)).toHaveCount(1, { timeout: 120_000 });
      await select.selectOption(model);
      await section.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(defaults).toContainText(model);
      const conv = await relay.api<Conversation>('/api/conversations', {
        body: {
          title: `${provider} default`,
          agents: [{ id: 'm1', name: 'Ada', provider, role: '' }],
          settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: 'read-only', approvals: 'deny', cwd: relay.workDir },
        },
      });
      await page.goto(`${relay.base}/#/c/${conv.id}`);
      await send(page, 'What is 17 + 25? Reply with only the number.');
      const reply = replies(page, 'Ada').last();
      await expect(reply).toBeVisible({ timeout: 120_000 });
      await expect(reply.locator('.live-tag')).toHaveCount(0, { timeout: 15 * 60_000 });
      const last = (await relay.api<Conversation>(`/api/conversations/${conv.id}`)).messages.filter((m) => m.author.kind === 'agent').at(-1);
      expect(last?.error, 'the turn failed').toBeUndefined();
      expect(answer(last)).toMatch(FORTY_TWO);
      expect(sessionBackend(relay, conv.id, 'm1')).toBe(first!.id);
    });
  }
});

test.describe("the CLIs' own cloud models", () => {
  test.skip(!CLOUD, "E2E_LIVE_CLOUD=1 runs these (the user's sign-ins pay for them)");
  for (const provider of CLOUD_CLIS.filter(has)) {
    test(`${provider} on its default model answers`, async ({ page, relay }) => {
      await pickAndAsk(page, relay, provider, undefined);
    });
    // A model of its own list, picked in Team settings as a person would (E2E_LIVE_MODEL_<CLI>).
    const own = ownModel(provider);
    if (own) {
      test(`${provider} on ${own}, picked in Team settings, answers`, async ({ page, relay }) => {
        await pickAndAsk(page, relay, provider, own);
      });
    }
  }
});

test.describe('endpoints that are gone', () => {
  const first: LiveEndpoint | undefined = ENDPOINTS[0];
  // Claude Code, Codex and Grok would otherwise send the model's id to their own service; an open
  // agent has no service of its own, so for it the endpoint is just not there.
  const cases = [
    { provider: ENDPOINT_CLIS.find(has), error: /custom endpoint "gone" was deleted under Settings → Model backends\. The turn did not run/ },
    { provider: OPEN.find(has), error: /there is no custom endpoint with the id "gone"/ },
  ].flatMap((c) => (c.provider ? [{ provider: c.provider, error: c.error }] : []));
  test.skip(!first || !cases.length, 'needs an endpoint (E2E_LIVE_OLLAMA or E2E_LIVE_VLLM) and a CLI that runs on one');

  for (const c of cases) {
    test(`${c.provider}: a member on a deleted endpoint's model fails its turn, saying so`, async ({ relay }) => {
      await setUpEndpoints(relay);
      await relay.api('/api/backends/endpoints/gone', { method: 'PUT', body: { name: 'Gone', baseUrl: first!.baseUrl, models: [first!.model], ...(first!.apiKey ? { apiKey: first!.apiKey } : {}) } });
      const conv = await relay.api<Conversation>('/api/conversations', {
        body: {
          title: 'gone',
          agents: [{ id: 'm1', name: 'Ada', provider: c.provider, role: '', model: `gone/${first!.model}` }],
          settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: askPermission(c.provider), approvals: 'deny', cwd: relay.workDir },
        },
      });
      await relay.api('/api/backends/endpoints/gone', { method: 'DELETE', body: {} });
      expect((await relay.api<{ deletedEndpoints?: string[] }>('/api/backends')).deletedEndpoints).toContain('gone');
      await relay.api(`/api/conversations/${conv.id}/messages`, { body: { text: 'Say hello.' } });
      expect(await turnError(relay, conv.id)).toMatch(c.error);
    });
  }
});

test.describe('a model typed for an endpoint', () => {
  const ollama = ENDPOINTS.find((e) => e.id === 'ollama');
  const typed = TYPED_MODEL;
  test.skip(!ollama || !typed || !has('grok'), 'needs E2E_LIVE_OLLAMA, E2E_LIVE_OLLAMA_TYPED and Grok');

  test("Grok runs on a model the endpoint's list leaves out", async ({ page, relay }) => {
    await setUpEndpoints(relay);
    const conv = await relay.api<Conversation>('/api/conversations', {
      body: {
        title: 'typed',
        agents: [{ id: 'm1', name: 'Ada', provider: 'grok', role: '', model: `ollama/${typed}` }],
        settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: 'read-only', approvals: 'deny', cwd: relay.workDir },
      },
    });
    await page.goto(`${relay.base}/#/c/${conv.id}`);
    await send(page, 'What is 17 + 25? Reply with only the number.');
    const reply = replies(page, 'Ada').last();
    await expect(reply).toBeVisible({ timeout: 120_000 });
    await expect(reply.locator('.live-tag')).toHaveCount(0, { timeout: 15 * 60_000 });
    const last = (await relay.api<Conversation>(`/api/conversations/${conv.id}`)).messages.filter((m) => m.author.kind === 'agent').at(-1);
    expect(last?.error, 'the turn failed').toBeUndefined();
    expect(answer(last)).toMatch(FORTY_TWO);
  });
});

test.describe('open agents on native Windows', () => {
  test.skip(process.platform !== 'win32', 'only on Windows');
  const provider = OPEN.find(has);
  const first = ENDPOINTS[0];
  test.skip(!provider || !first, 'needs an open agent and an endpoint');

  test('below full access they do not run, and say why', async ({ relay }) => {
    await setUpEndpoints(relay);
    const conv = await relay.api<Conversation>('/api/conversations', {
      body: {
        title: 'windows',
        agents: [{ id: 'm1', name: 'Ada', provider: provider!, role: '', model: modelId(first!) }],
        settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: 'read-only', approvals: 'deny', cwd: relay.workDir },
      },
    });
    await relay.api(`/api/conversations/${conv.id}/messages`, { body: { text: 'Say hello.' } });
    expect(await turnError(relay, conv.id)).toMatch(/only runs with full access/);
  });
});
