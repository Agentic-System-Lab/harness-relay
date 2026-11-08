import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  GROUP_LIMITS,
  PROVIDERS,
  VOICE_MAX_SECONDS,
  type ApprovalAnswer,
  type Conversation,
  type Provider,
  type ServerEvent,
  type TeamPreset,
} from '../shared/types';
import { attachmentPath, isInlineImage, type AttachmentPart, type AttachmentUpload } from './attachments';
import { fileRoots, listFolder, mediaInRoot, previewFile } from './files';
import { NativeSetupService, nativeForClient } from './native';
import type { Hub } from './hub';
import { byteRange, mediaRoots, mediaType, resolveMedia } from './media';
import { HttpError, forClient, type Orchestrator } from './orchestrator';
import type { ProviderService } from './providers';
import type { SettingsStore } from './settings';
import type { Store } from './store';
import {
  validDirectory,
  validGroupName,
  validVoiceModel,
  validateAgents,
  validateLead,
  validateMcpServer,
  validateProviderUpdate,
  validateSettings,
  validateToolLibraryUpdate,
  validateVoiceUpdate,
  validSkillPath,
} from './validate';
import { VoiceService } from './voice';
import { parseLang, t, withLang } from './i18n';

export interface AppDeps {
  store: Store;
  settings: SettingsStore;
  hub: Hub;
  orchestrator: Orchestrator;
  providers: ProviderService;
  /** Voice input; created on demand when not given (it does nothing until used). */
  voice?: VoiceService;
  /** Asks each CLI what it loads by itself; created when not given. */
  native?: NativeSetupService;
  /** Extra Host names allowed besides localhost (RELAY_ALLOWED_HOSTS). */
  extraHosts?: string[];
}

/** A recording of the longest allowed length (16 kHz, 16-bit mono WAV) in base64, with room to spare. */
const VOICE_MAX_BASE64 = Math.ceil(((VOICE_MAX_SECONDS + 10) * 32_000 * 4) / 3) + 1024;

/** The HTTP API (`/api/*`). Static files and the listening server are set up in `index.ts`. */
export function createApp({
  store,
  settings,
  hub,
  orchestrator,
  providers,
  voice = new VoiceService(settings),
  native = new NativeSetupService(settings),
  extraHosts = [],
}: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.code ? { error: err.message, code: err.code } : { error: err.message }, err.status);
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
    const b = await body<{ defaultCwd?: unknown; createCwd?: unknown; lead?: unknown }>(c);
    // Validate everything before saving anything; the directory last, since creating it is a side effect.
    const lead = b.lead !== undefined ? validateLead(b.lead) : undefined;
    const cwd = b.defaultCwd !== undefined ? validDirectory(b.defaultCwd, b.createCwd === true) : undefined;
    if (cwd !== undefined) settings.setDefaultCwd(cwd);
    if (lead !== undefined) settings.setLead(lead);
    return c.json(settings.view());
  });

  // --- Tool library: MCP servers, skills and memory for the agents --------------

  app.get('/api/tools', (c) => c.json(settings.tools.view()));

  app.put('/api/tools', async (c) => c.json(settings.tools.update(validateToolLibraryUpdate(await body<unknown>(c)))));

  // Adds a server, or (with `previousName`) replaces or renames one.
  app.put('/api/tools/mcp/:name', async (c) => {
    const { name, update } = validateMcpServer(c.req.param('name'), await body<unknown>(c));
    return c.json(settings.tools.saveServer(name, update));
  });

  app.delete('/api/tools/mcp/:name', (c) => c.json(settings.tools.deleteServer(c.req.param('name'))));

  // The skills under a folder, to pick from before adding them (nothing is saved).
  app.get('/api/tools/skills/scan', (c) => {
    const path = validSkillPath(c.req.query('path'));
    return c.json({ path, skills: settings.tools.scanSkills(path) });
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

  // What the CLI loads by itself (its own skills, MCP servers, memory) for the default working
  // directory. A POST, because it starts the CLI (Claude Code runs the project's hooks): the JSON
  // content-type check keeps other sites from setting it off. Answers are kept for a minute.
  app.post('/api/providers/:provider/native', async (c) => {
    const p = provider(c);
    const b = await body<{ refresh?: unknown }>(c);
    const cwd = validDirectory(settings.defaultCwd);
    return c.json(nativeForClient(await native.get(p, cwd, b.refresh === true)));
  });

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

  // --- Voice input -------------------------------------------------------------------

  app.get('/api/voice', (c) => c.json(voice.status()));

  app.put('/api/voice/settings', async (c) => c.json(voice.update(validateVoiceUpdate(await body<unknown>(c)))));

  // Install what is missing for a model (the engine, the model) in the background; poll GET /api/voice.
  app.post('/api/voice/install', async (c) => {
    const b = await body<{ model?: unknown }>(c);
    return c.json(voice.install(b.model === undefined ? voice.status().model : validVoiceModel(b.model)));
  });

  app.delete('/api/voice/install', (c) => c.json(voice.cancel()));

  app.delete('/api/voice/models/:model', (c) => c.json(voice.deleteModel(validVoiceModel(c.req.param('model')))));

  // Delete the downloaded models and engine.
  app.delete('/api/voice', (c) => c.json(voice.uninstall()));

  // The user started recording: load the model while they speak.
  app.post('/api/voice/prepare', (c) => {
    voice.prepare();
    return c.json({ ok: true });
  });

  // A recording (base64 16-bit PCM WAV) to text.
  app.post('/api/voice/transcribe', async (c) => {
    const b = await body<{ audio?: unknown }>(c);
    if (typeof b.audio !== 'string' || b.audio.length > VOICE_MAX_BASE64) throw new HttpError(400, t().voiceBadAudio);
    return c.json({ text: await voice.transcribe(Buffer.from(b.audio, 'base64')) });
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

  // --- Sidebar groups -------------------------------------------------------------

  function getGroup(id: string) {
    const group = store.getGroup(id);
    if (!group) throw new HttpError(404, t().groupNotFound);
    return group;
  }

  app.get('/api/groups', (c) => c.json(store.listGroups()));

  app.post('/api/groups', async (c) => {
    const b = await body<{ name?: unknown }>(c);
    const groups = store.listGroups();
    if (groups.length >= GROUP_LIMITS.maxGroups) throw new HttpError(400, t().tooManyGroups(GROUP_LIMITS.maxGroups));
    const group = { id: randomUUID(), name: validGroupName(b.name, groups) };
    store.createGroup(group);
    return c.json(group);
  });

  app.patch('/api/groups/:id', async (c) => {
    const group = getGroup(c.req.param('id'));
    const b = await body<{ name?: unknown }>(c);
    const name = validGroupName(b.name, store.listGroups(), group.id);
    store.renameGroup(group.id, name);
    return c.json({ ...group, name });
  });

  // Its conversations go to the default group ("Other").
  app.delete('/api/groups/:id', (c) => {
    store.deleteGroup(getGroup(c.req.param('id')).id);
    return c.json({ ok: true });
  });

  // --- Conversations ---------------------------------------------------------------

  app.get('/api/conversations', (c) =>
    c.json(
      store.list(
        (id) => orchestrator.isRunning(id),
        (id) => orchestrator.isWaiting(id),
        (id) => orchestrator.isSorting(id),
      ),
    ),
  );

  // Conversations whose title or messages contain every word of `q`.
  app.get('/api/search', (c) => c.json(store.search(c.req.query('q') ?? '')));

  app.post('/api/conversations', async (c) => {
    const b = await body<Partial<Conversation> & { createCwd?: unknown }>(c);
    const now = Date.now();
    // Auto team: the lead agent designs the team from the first message.
    // The agents first: creating a missing working directory is a side effect.
    const agents = b.settings?.autoTeam === true ? [] : validateAgents(b.agents);
    const s = validateSettings(b.settings, settings.defaultCwd, b.createCwd === true);
    const conv: Conversation = {
      id: randomUUID(),
      title: String(b.title ?? '').trim() || t().defaultTitle,
      createdAt: now,
      updatedAt: now,
      agents,
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
    const b = await body<Partial<Conversation> & { createCwd?: unknown }>(c);
    const save = () => {
      if (b.title !== undefined) conv.title = String(b.title).trim().slice(0, 200) || conv.title;
      conv.updatedAt = Date.now();
      store.saveMeta(conv);
      orchestrator.emitConversation(conv);
      return c.json(forClient(conv));
    };
    if (!b.agents && !b.settings) return save(); // renaming is fine while the team replies
    let confirmed = false;
    // Reserved while the workspace is prepared, so no run starts with half-changed settings.
    const res = await orchestrator.exclusive(conv.id, t().busySettings, async () => {
      const agents = b.agents ? validateAgents(b.agents) : conv.agents;
      // After the agents: creating a missing working directory is a side effect.
      const next = b.settings ? validateSettings(b.settings, conv.settings.cwd, b.createCwd === true) : { ...conv.settings };
      // Edits never switch auto team on; a team set by hand replaces the lead agent's pending design.
      next.autoTeam = b.agents ? undefined : conv.settings.autoTeam;
      if (b.settings) await orchestrator.prepareWorkspace({ ...conv, settings: next });
      conv.agents = agents;
      conv.settings = next;
      if (b.agents) confirmed = orchestrator.confirmPendingPlan(conv);
      return save();
    });
    // The team set by hand answers the question written while its design waited.
    if (confirmed) orchestrator.startQueued(conv);
    return res;
  });

  // Put a conversation in a sidebar group; `groupId: null` is the default group ("Other").
  app.put('/api/conversations/:id/group', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ groupId?: unknown }>(c);
    const groupId = b.groupId === null || b.groupId === undefined || b.groupId === '' ? null : String(b.groupId);
    if (groupId !== null && !store.getGroup(groupId)) throw new HttpError(404, t().groupNotFound);
    store.moveToGroup(conv.id, groupId);
    return c.json({ ok: true });
  });

  app.delete('/api/conversations/:id', async (c) => {
    // Stops a run first and waits for it to wind down, so nothing writes to the deleted conversation.
    await orchestrator.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Send a message. While the team replies it waits in the queue for the next turn ({ queued: true });
  // `interrupt` stops the team first and sends it now.
  app.post('/api/conversations/:id/messages', async (c) => {
    const b = await body<{ text?: string; attachments?: AttachmentUpload[]; interrupt?: boolean }>(c);
    const { queued } = await orchestrator.send(c.req.param('id'), String(b.text ?? ''), b.attachments, b.interrupt === true);
    return c.json({ ok: true, queued }, 202);
  });

  // Take back a message still waiting in the queue; it is returned so the user can edit it.
  app.delete('/api/conversations/:id/queue/:messageId', (c) =>
    c.json(orchestrator.withdraw(c.req.param('id'), c.req.param('messageId'))),
  );

  // A file attached to a user message. Only common image types are shown inline; anything else
  // is a download, so an attached HTML or SVG file can never run in this origin.
  app.get('/api/conversations/:id/attachments/:attachmentId', async (c) => {
    const conv = getConv(c.req.param('id'));
    const id = c.req.param('attachmentId');
    // Messages waiting in the queue show their files too.
    const part = [...conv.messages, ...(conv.queue ?? [])]
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
    return sendMedia(c, file);
  });

  // --- Browsing the working directory (and agents' worktrees) -------------------

  /** The folder a files request names (`root`: `cwd` or an agent id) and the path inside it. */
  function fileTarget(c: Context): { roots: ReturnType<typeof fileRoots>; root: string; path: string } {
    const roots = fileRoots(getConv(c.req.param('id') ?? ''));
    const root = roots.find((r) => r.id === (c.req.query('root') || 'cwd'));
    if (!root) throw new HttpError(404, t().fileRootNotFound);
    return { roots, root: root.id, path: c.req.query('path') ?? '' };
  }
  const rootPath = (roots: ReturnType<typeof fileRoots>, id: string) => roots.find((r) => r.id === id)!.path;

  app.get('/api/conversations/:id/files', (c) => {
    const { roots, root, path } = fileTarget(c);
    return c.json({ roots, root, ...listFolder(rootPath(roots, root), path) });
  });

  app.get('/api/conversations/:id/files/preview', (c) => {
    const { roots, root, path } = fileTarget(c);
    return c.json(previewFile(rootPath(roots, root), path));
  });

  // Images and videos only, served like the media endpoint; text comes as JSON from /preview.
  app.get('/api/conversations/:id/files/raw', (c) => {
    const { roots, root, path } = fileTarget(c);
    return sendMedia(c, mediaInRoot(rootPath(roots, root), path));
  });

  /** An image or video file, so that it can never run in this origin. */
  async function sendMedia(c: Context, file: string): Promise<Response> {
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
  }

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

  // Accept the team the lead agent designed (auto team); then the user asks their first question.
  app.post('/api/conversations/:id/messages/:messageId/confirm-plan', async (c) => {
    orchestrator.confirmPlan(c.req.param('id'), c.req.param('messageId'));
    return c.json({ ok: true });
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
