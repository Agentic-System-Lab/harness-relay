import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  PROVIDERS,
  type ApprovalAnswer,
  type Conversation,
  type Provider,
  type ServerEvent,
  type TeamPreset,
} from '../shared/types';
import { attachmentPath, isInlineImage, type AttachmentPart, type AttachmentUpload } from './attachments';
import type { Hub } from './hub';
import { byteRange, mediaRoots, mediaType, resolveMedia } from './media';
import { HttpError, forClient, type Orchestrator } from './orchestrator';
import type { ProviderService } from './providers';
import type { SettingsStore } from './settings';
import type { Store } from './store';
import { validDirectory, validateAgents, validateLead, validateProviderUpdate, validateSettings } from './validate';
import { parseLang, t, withLang } from './i18n';

export interface AppDeps {
  store: Store;
  settings: SettingsStore;
  hub: Hub;
  orchestrator: Orchestrator;
  providers: ProviderService;
  /** Extra Host names allowed besides localhost (RELAY_ALLOWED_HOSTS). */
  extraHosts?: string[];
}

/** The HTTP API (`/api/*`). Static files and the listening server are set up in `index.ts`. */
export function createApp({ store, settings, hub, orchestrator, providers, extraHosts = [] }: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error('[server]', err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });

  // This server launches coding agents that can edit files, so only the local UI may talk to it:
  // block DNS-rebinding (Host) and cross-site requests (Origin / non-JSON simple POSTs).
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
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
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return c.json({ error: 'Content-Type must be application/json' }, 415);
      }
    }
    // User-facing server text follows the UI language — also in runs this request starts.
    await withLang(parseLang(c.req.header('x-relay-lang'), c.req.header('accept-language')), () => next());
  });

  /** The request's JSON body, which must be an object. */
  async function body<T>(c: Context): Promise<T> {
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid JSON body');
    return value as T;
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
    const b = await body<{ defaultCwd?: unknown; lead?: unknown }>(c);
    // Validate everything before saving anything.
    const cwd = b.defaultCwd !== undefined ? validDirectory(b.defaultCwd) : undefined;
    const lead = b.lead !== undefined ? validateLead(b.lead) : undefined;
    if (cwd !== undefined) settings.setDefaultCwd(cwd);
    if (lead !== undefined) settings.setLead(lead);
    return c.json(settings.view());
  });

  app.put('/api/settings/providers/:provider', async (c) => {
    const p = provider(c);
    const b = validateProviderUpdate(await body<unknown>(c));
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
    const name = String(b.name ?? '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, t().presetNameRequired);
    const s = validateSettings({ ...b.settings, cwd: settings.defaultCwd }, settings.defaultCwd);
    const preset: TeamPreset = {
      // Only ids of user templates can be reused (to update one); never a built-in template's.
      id: typeof b.id === 'string' && /^user-[\w-]{1,80}$/.test(b.id) ? b.id : `user-${randomUUID()}`,
      name,
      description: String(b.description ?? '').trim().slice(0, 2000) || undefined,
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
    return c.json(forClient(conv));
  });

  app.get('/api/conversations/:id', (c) => c.json(forClient(getConv(c.req.param('id')))));

  app.patch('/api/conversations/:id', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<Partial<Conversation>>(c);
    const save = () => {
      if (b.title !== undefined) conv.title = String(b.title).trim().slice(0, 200) || conv.title;
      conv.updatedAt = Date.now();
      store.saveMeta(conv);
      orchestrator.emitConversation(conv);
      return c.json(forClient(conv));
    };
    if (!b.agents && !b.settings) return save(); // renaming is fine while the team replies
    // Reserved while the workspace is prepared, so no run starts with half-changed settings.
    return orchestrator.exclusive(conv.id, t().busySettings, async () => {
      const agents = b.agents ? validateAgents(b.agents) : conv.agents;
      const next = b.settings ? validateSettings(b.settings, conv.settings.cwd) : { ...conv.settings };
      // Edits never switch auto team on; a team set by hand replaces the lead agent's pending design.
      next.autoTeam = b.agents ? undefined : conv.settings.autoTeam;
      if (b.settings) await orchestrator.prepareWorkspace({ ...conv, settings: next });
      conv.agents = agents;
      conv.settings = next;
      return save();
    });
  });

  app.delete('/api/conversations/:id', async (c) => {
    // Stops a run first and waits for it to wind down, so nothing writes to the deleted conversation.
    await orchestrator.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const b = await body<{ text?: string; attachments?: AttachmentUpload[] }>(c);
    await orchestrator.send(c.req.param('id'), String(b.text ?? ''), b.attachments);
    return c.json({ ok: true }, 202);
  });

  // A file attached to a user message. Only common image types are shown inline; anything else
  // is a download, so an attached HTML or SVG file can never run in this origin.
  app.get('/api/conversations/:id/attachments/:attachmentId', async (c) => {
    const conv = getConv(c.req.param('id'));
    const id = c.req.param('attachmentId');
    const part = conv.messages
      .flatMap((m) => m.parts)
      .find((p): p is AttachmentPart => p.type === 'attachment' && p.id === id);
    if (!part) throw new HttpError(404, t().attachmentNotFound);
    let data: Buffer;
    try {
      data = await readFile(attachmentPath(conv.id, part));
    } catch {
      throw new HttpError(404, t().attachmentNotFound);
    }
    const inline = isInlineImage(part.mimeType);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': inline ? part.mimeType : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(part.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // An image or video a reply embeds, e.g. ![chart](out/chart.png): only media files inside the
  // working directory (or the agent's worktree, or the attachments), served so they never run here.
  app.get('/api/conversations/:id/messages/:messageId/media', async (c) => {
    const conv = getConv(c.req.param('id'));
    const msg = conv.messages.find((m) => m.id === c.req.param('messageId'));
    const file = msg && resolveMedia(c.req.query('path') ?? '', mediaRoots(conv, msg));
    if (!file) throw new HttpError(404, t().mediaNotFound);
    const { size, mtimeMs } = await stat(file);
    const etag = `W/"${size}-${Math.floor(mtimeMs)}"`;
    const headers: Record<string, string> = {
      'Content-Type': mediaType(file)!,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // Agents may write the file again: check before reusing a cached copy.
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'Accept-Ranges': 'bytes',
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    // Videos are fetched in ranges (Safari plays nothing otherwise, and seeking needs them).
    const range = byteRange(c.req.header('range'), size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(size ? end - start + 1 : 0);
    const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream) : null;
    return new Response(body, { status: range ? 206 : 200, headers });
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
      // The snapshot is serialized synchronously right after subscribing, so every event the listener
      // receives happened after it — deltas included. Events that arrive while the snapshot is still
      // being written wait in the queue, so they reach the client in order.
      const queue: ServerEvent[] = [];
      let ready = false;
      const unsubscribe = hub.subscribe(conv.id, (e) => (ready ? void send(e) : queue.push(e)));
      stream.onAbort(unsubscribe);
      await send({
        type: 'snapshot',
        conversation: forClient(conv),
        running: orchestrator.isRunning(conv.id),
        activeAgentIds: orchestrator.activeAgentIds(conv.id),
      });
      while (queue.length) await send(queue.shift()!);
      ready = true;
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    });
  });

  return app;
}
