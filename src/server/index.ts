import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  PROVIDERS,
  type ApprovalAnswer,
  type Conversation,
  type LeadAgentSettings,
  type Provider,
  type ProviderSettingsUpdate,
  type ServerEvent,
  type TeamPreset,
} from '../shared/types';
import { openDatabase } from './db';
import { Hub } from './hub';
import { HttpError, Orchestrator } from './orchestrator';
import { killAll } from './process';
import { ProviderService } from './providers';
import { DB_FILE, SettingsStore } from './settings';
import { Store } from './store';
import { expandPath, validateAgents, validateSettings } from './validate';
import { parseLang, t, withLang } from './i18n';

const db = openDatabase(DB_FILE);
const settings = new SettingsStore(db);
const store = new Store(db);
const hub = new Hub();
const providers = new ProviderService(settings);
const orchestrator = new Orchestrator(store, hub, settings, {
  // What the lead agent may choose from when it designs a team.
  async context() {
    const [statuses, catalog] = await Promise.all([providers.statusAll(), providers.modelsAll()]);
    const available = statuses
      .filter((s) => s.installed && (s.auth.loggedIn !== false || s.usingStoredApiKey))
      .map((s) => s.provider);
    return { available, catalog, presets: store.listPresets() };
  },
});

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('[server]', err);
  return c.json({ error: err.message || 'Internal error' }, 500);
});

// This server launches coding agents that can edit files, so only the local UI may talk to it:
// block DNS-rebinding (Host) and cross-site requests (Origin / non-JSON simple POSTs).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const extraHosts = (process.env.RELAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const hostAllowed = (h: string) => LOCAL_HOST.test(h) || extraHosts.includes(h.replace(/:\d+$/, ''));

app.use('/api/*', async (c, next) => {
  const host = c.req.header('host') ?? '';
  if (!hostAllowed(host)) return c.json({ error: 'Forbidden host' }, 403);
  const origin = c.req.header('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (!hostAllowed(originHost)) return c.json({ error: 'Forbidden origin' }, 403);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (!(c.req.header('content-type') ?? '').includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }
  }
  // User-facing server text follows the UI language — also in runs this request starts.
  await withLang(parseLang(c.req.header('x-relay-lang'), c.req.header('accept-language')), () => next());
});

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function getConv(id: string): Conversation {
  const conv = store.get(id);
  if (!conv) throw new HttpError(404, t().conversationNotFound);
  return conv;
}

function provider(c: Context): Provider {
  const p = c.req.param('provider') as Provider;
  if (!PROVIDERS.includes(p)) throw new HttpError(404, t().unknownProvider(p));
  return p;
}

// --- Settings & providers ----------------------------------------------------

app.get('/api/settings', (c) => c.json(settings.view()));

app.put('/api/settings', async (c) => {
  const b = await body<{ defaultCwd?: string; lead?: Partial<LeadAgentSettings> }>(c);
  if (b.defaultCwd !== undefined) {
    const cwd = expandPath(b.defaultCwd);
    if (!existsSync(cwd)) throw new HttpError(400, t().dirNotFound(cwd));
    settings.setDefaultCwd(cwd);
  }
  if (b.lead !== undefined) {
    const p = b.lead.provider as Provider;
    if (!PROVIDERS.includes(p)) throw new HttpError(400, t().unknownProvider(String(p)));
    settings.setLead({ provider: p, model: String(b.lead.model ?? ''), effort: String(b.lead.effort ?? '') });
  }
  return c.json(settings.view());
});

app.put('/api/settings/providers/:provider', async (c) => {
  const p = provider(c);
  const b = await body<ProviderSettingsUpdate>(c);
  if (b.apiKey !== undefined && b.apiKey !== null && p === 'codex') {
    // Codex keeps its own credentials.
    await providers.codexApiKeyLogin(b.apiKey);
    delete b.apiKey;
  }
  settings.update(p, b);
  providers.invalidate(p);
  return c.json(settings.view());
});

app.get('/api/providers', async (c) => c.json(await providers.statusAll(c.req.query('refresh') === '1')));

app.get('/api/models', async (c) => c.json(await providers.modelsAll(c.req.query('refresh') === '1')));

app.get('/api/providers/:provider/login-methods', (c) => c.json(providers.loginMethods(provider(c))));

app.post('/api/providers/:provider/login', async (c) => {
  const b = await body<{ method?: string }>(c);
  return c.json(providers.startLogin(provider(c), b.method));
});

app.get('/api/providers/:provider/login', (c) => c.json(providers.login(provider(c))));

app.post('/api/providers/:provider/login/input', async (c) => {
  const b = await body<{ text?: string }>(c);
  const view = providers.sendLoginInput(provider(c), String(b.text ?? ''));
  if (!view) throw new HttpError(404, t().noLogin);
  return c.json(view);
});

app.delete('/api/providers/:provider/login', (c) => {
  providers.cancelLogin(provider(c));
  return c.json({ ok: true });
});

app.post('/api/providers/:provider/logout', async (c) => {
  const output = await providers.logout(provider(c));
  return c.json({ ok: true, output });
});

// --- Presets -------------------------------------------------------------------

app.get('/api/presets', (c) => c.json(store.listPresets()));

app.post('/api/presets', async (c) => {
  const b = await body<Partial<TeamPreset>>(c);
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, t().presetNameRequired);
  const s = validateSettings({ ...b.settings, cwd: settings.defaultCwd }, settings.defaultCwd);
  const preset: TeamPreset = {
    id: b.id && !b.builtin && /^[\w-]+$/.test(b.id) ? b.id : `user-${randomUUID()}`,
    name,
    description: String(b.description ?? '').trim() || undefined,
    agents: validateAgents(b.agents),
    settings: { mode: s.mode, rounds: s.rounds, maxHops: s.maxHops, permission: s.permission },
  };
  store.savePreset(preset);
  return c.json(preset);
});

app.delete('/api/presets/:id', (c) => {
  store.deletePreset(c.req.param('id'));
  return c.json({ ok: true });
});

// --- Conversations ---------------------------------------------------------------

app.get('/api/conversations', (c) =>
  c.json(store.list((id) => orchestrator.isRunning(id), (id) => orchestrator.isWaiting(id))),
);

app.post('/api/conversations', async (c) => {
  const b = await body<Partial<Conversation>>(c);
  const now = Date.now();
  const s = validateSettings(b.settings, settings.defaultCwd);
  const conv: Conversation = {
    id: randomUUID(),
    title: String(b.title ?? '').trim() || t().defaultTitle,
    createdAt: now,
    updatedAt: now,
    // Auto team: the lead agent designs the team from the first message.
    agents: s.autoTeam ? [] : validateAgents(b.agents),
    settings: s,
    messages: [],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  // Agents that may write need a git repository; set it up now so problems surface immediately.
  try {
    await orchestrator.prepareWorkspace(conv);
  } catch (err) {
    store.delete(conv.id);
    throw err;
  }
  return c.json(conv);
});

app.get('/api/conversations/:id', (c) => c.json(getConv(c.req.param('id'))));

app.patch('/api/conversations/:id', async (c) => {
  const conv = getConv(c.req.param('id'));
  const b = await body<Partial<Conversation>>(c);
  if ((b.agents || b.settings) && orchestrator.isRunning(conv.id)) {
    throw new HttpError(409, t().busySettings);
  }
  if (b.title !== undefined) conv.title = String(b.title).trim() || conv.title;
  const agents = b.agents ? validateAgents(b.agents) : conv.agents;
  const next = b.settings ? validateSettings(b.settings, conv.settings.cwd) : { ...conv.settings };
  // Edits never switch auto team on; a team set by hand replaces the lead agent's pending design.
  next.autoTeam = b.agents ? undefined : conv.settings.autoTeam;
  if (b.settings) await orchestrator.prepareWorkspace({ ...conv, settings: next });
  conv.agents = agents;
  conv.settings = next;
  conv.updatedAt = Date.now();
  store.saveMeta(conv);
  orchestrator.emitConversation(conv);
  return c.json(conv);
});

app.delete('/api/conversations/:id', async (c) => {
  const id = c.req.param('id');
  orchestrator.stop(id);
  const conv = store.get(id);
  if (conv) await orchestrator.cleanupWorktrees(conv);
  store.delete(id);
  return c.json({ ok: true });
});

app.post('/api/conversations/:id/messages', async (c) => {
  const b = await body<{ text?: string }>(c);
  await orchestrator.send(c.req.param('id'), String(b.text ?? ''));
  return c.json({ ok: true }, 202);
});

// Edit one of the user's messages: everything after it is dropped and the team answers again.
app.put('/api/conversations/:id/messages/:messageId', async (c) => {
  const b = await body<{ text?: string }>(c);
  await orchestrator.resend(c.req.param('id'), c.req.param('messageId'), String(b.text ?? ''));
  return c.json({ ok: true }, 202);
});

// Answer an agent's request to do something its permission does not cover.
app.post('/api/conversations/:id/approvals/:approvalId', async (c) => {
  const b = await body<ApprovalAnswer>(c);
  orchestrator.answerApproval(c.req.param('id'), c.req.param('approvalId'), b);
  return c.json({ ok: true });
});

// Let an agent answer again: its reply and everything after it are dropped.
app.post('/api/conversations/:id/messages/:messageId/retry', async (c) => {
  await orchestrator.retry(c.req.param('id'), c.req.param('messageId'));
  return c.json({ ok: true }, 202);
});

// Save a team the lead agent designed (auto team) as a template.
app.post('/api/conversations/:id/messages/:messageId/save-plan', async (c) => {
  const b = await body<{ name?: string }>(c);
  return c.json(orchestrator.savePlanAsPreset(c.req.param('id'), c.req.param('messageId'), b.name));
});

// Changes made by agents: per-message diff, per-agent (worktree) diff, and applying a worktree result.
app.get('/api/conversations/:id/messages/:messageId/diff', async (c) =>
  c.text(await orchestrator.messageDiff(c.req.param('id'), c.req.param('messageId'))),
);

app.get('/api/conversations/:id/agents/:agentId/diff', async (c) =>
  c.text(await orchestrator.agentDiff(c.req.param('id'), c.req.param('agentId'))),
);

app.post('/api/conversations/:id/agents/:agentId/apply', async (c) => {
  const files = await orchestrator.applyAgentWork(c.req.param('id'), c.req.param('agentId'));
  return c.json({ ok: true, files });
});

app.post('/api/conversations/:id/stop', (c) => {
  orchestrator.stop(c.req.param('id'));
  return c.json({ ok: true });
});

app.get('/api/conversations/:id/events', (c) => {
  const conv = getConv(c.req.param('id'));
  return streamSSE(c, async (stream) => {
    const send = (e: ServerEvent) => stream.writeSSE({ data: JSON.stringify(e) });
    // Subscribe before the snapshot so nothing emitted in between is lost (the client dedupes by id).
    const queue: ServerEvent[] = [];
    let ready = false;
    const unsubscribe = hub.subscribe(conv.id, (e) => (ready ? void send(e) : queue.push(e)));
    stream.onAbort(unsubscribe);
    await send({
      type: 'snapshot',
      conversation: conv,
      running: orchestrator.isRunning(conv.id),
      activeAgentIds: orchestrator.activeAgentIds(conv.id),
    });
    // Deltas already applied to the snapshot must not be applied twice; whole-message events are idempotent.
    for (const e of queue) if (e.type !== 'delta') await send(e);
    ready = true;
    while (!stream.aborted) {
      await stream.sleep(15_000);
      if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
    }
    unsubscribe();
  });
});

// --- Static web app (production build) ------------------------------------------

const webDir = resolve(process.cwd(), 'dist/web');
if (existsSync(join(webDir, 'index.html'))) {
  app.use('/*', serveStatic({ root: 'dist/web' }));
  app.get('*', serveStatic({ path: 'dist/web/index.html' }));
} else {
  app.get('/', (c) => c.text('Web UI is not built. Run `npm run dev` (http://localhost:5173) or `npm run build` first.'));
}

// --- Start -------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Harness Relay API listening on http://${host}:${info.port}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  orchestrator.stopAll();
  providers.shutdown();
  killAll();
  store.flushAll();
  db.close();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
