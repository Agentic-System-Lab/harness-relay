import { randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { AUTH_KEY_HEADER, RELAY_FOLDER, SIGNED_OUT, browserLabel } from '../shared/auth';
import { CODE_TTL_MS, SESSION_COOKIE, SESSION_MAX_AGE_S, type AuthStore } from './auth';
import { aboutInfo, relayVersion } from './about';
import { agentFolderOptions, relayFolderRefusal } from './protect';
import {
  DEFAULT_ACCOUNT,
  FILE_LIMITS,
  GROUP_LIMITS,
  MAX_ACCOUNTS,
  PROVIDER_LABEL,
  isOpenProvider,
  PROVIDERS,
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_MAX_BYTES,
  SHARE_FILE_REFUSED,
  SHARE_FILE_URL_MAX,
  SHARE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  pendingPlan,
  type ApprovalAnswer,
  type Conversation,
  type ConversationSchedule,
  type Provider,
  type ServerEvent,
  type ReportScreenshots,
  type ShareLink,
  type SharedPage,
  type TeamPreset,
  type WorkingDirectories,
  type ZipCheck,
} from '../shared/types';
import type { AgentsViewSync } from './agentsview';
import { attachmentPath, isInlineImage, type AttachmentPart, type AttachmentUpload } from './attachments';
import { fileInRoot, fileRoots, listFolder, mediaInRoot, previewFile, readPreview, zipPlan, type ZipPlan } from './files';
import { zipStream } from './zip';
import { copyGrokTrust, restoreGrokTrustAll, trustGrokFolderAll } from './grokTrust';
import { NativeSetupService, listedFile, nativeForClient } from './native';
import type { Hub } from './hub';
import { byteRange, contentDisposition, mediaRoots, mediaType, resolveDownload, resolveMedia } from './media';
import { HttpError, forClient, titleFrom, type Orchestrator } from './orchestrator';
import { KeyOnlyAccountError, type ProviderService } from './providers';
import type { SettingsStore } from './settings';
import { fileLinkCount, fileLinksIn, replaceFileLinks, shareFileHref, shareSize } from '../shared/share';
import {
  ShareError,
  findShareFiles,
  gistDescription,
  gistFileNames,
  parseShareFileRefs,
  readShareFiles,
  shareToGist,
  unshareGist,
  validGistId,
  type FoundShareFile,
  type GistUpload,
} from './share';
import { parseScreenshots, uploadScreenshots } from './screenshots';
import { Updates } from './updates';
import type { Store } from './store';
import {
  ensureFolder,
  expandPath,
  foldCase,
  validAccountLabel,
  validAgentHome,
  validApiBackend,
  validEndpointId,
  validateBackendKey,
  validateEndpoint,
  validAgentsViewLink,
  validAgentsViewUrl,
  validDirectory,
  validGroupName,
  validVoiceModel,
  validateAccountUpdate,
  validateAgents,
  validateLead,
  validateMcpServer,
  validateProviderUpdate,
  validateSchedule,
  validateSettings,
  validateToolLibraryUpdate,
  validateVoiceUpdate,
  validSkillPath,
} from './validate';
import { VoiceService } from './voice';
import { nextRun } from '../shared/schedule';
import { currentLang, parseLang, t, withLang } from './i18n';

export interface AppDeps {
  /**
   * Signed-in browsers: every request but signing in must come from one (`src/server/auth.ts`).
   * Null takes no sign-in, for tests only: then any program on this computer could drive the agents.
   */
  auth: AuthStore | null;
  store: Store;
  settings: SettingsStore;
  hub: Hub;
  orchestrator: Orchestrator;
  providers: ProviderService;
  /** Voice input; created on demand when not given (it does nothing until used). */
  voice?: VoiceService;
  /** Asks each CLI what it loads by itself; created when not given. */
  native?: NativeSetupService;
  /** Sends conversations to AgentsView; its last failure is shown with the settings. */
  agentsView?: AgentsViewSync;
  /** Extra Host names allowed besides localhost (RELAY_ALLOWED_HOSTS). */
  extraHosts?: string[];
  /**
   * Started by the desktop app (desktop/): it has no terminal, so a browser that is not signed in is
   * pointed at the app's menu (which opens a new sign-in link) instead of the link printed at start.
   */
  desktopApp?: boolean;
  /** This Harness Relay's version, for a problem report (`about.ts`; a fake in tests). */
  version?: () => Promise<string>;
  /**
   * Puts a shared conversation's page on the web, with the files it takes along (its placeholder links
   * name them by their place in `files`), and takes it down (secret gists through `gh`; fakes in tests).
   */
  gists?: {
    /** `onFilesGist`: told of the files gist as soon as it is made, as it would be left without a page. */
    create(html: string, description: string, files?: GistUpload[], onFilesGist?: (gist: ShareLink) => void): Promise<ShareLink>;
    remove(id: string): Promise<void>;
  };
  /** The desktop app's updates (`updates.ts`); none when it is not given. */
  updates?: Updates;
  /** Puts a problem report's screenshots on GitHub as a secret gist, and deletes it again (`gh`; fakes in tests). */
  screenshotGists?: {
    upload(files: GistUpload[]): Promise<ReportScreenshots>;
    remove(id: string): Promise<void>;
  };
}

/** A recording of the longest allowed length (16 kHz, 16-bit mono WAV) in base64, with room to spare. */
const VOICE_MAX_BASE64 = Math.ceil(((VOICE_MAX_SECONDS + 10) * 32_000 * 4) / 3) + 1024;

/**
 * Refuses the files a share would take along when one cannot go (409, for the dialog to check them
 * again), or when there are too many of them, or too many bytes (413).
 */
function refuseShareFiles(found: FoundShareFile[]): void {
  const refused = found.find((f) => f.info.problem);
  if (refused) {
    const problem = refused.info.problem!;
    const reason = problem === 'too-large' ? t().shareFileTooLarge(shareSize(SHARE_FILE_MAX_BYTES)) : t().shareFileProblem[problem];
    throw new HttpError(409, t().shareFileRefused(refused.info.name, reason), SHARE_FILE_REFUSED);
  }
  if (found.length > SHARE_FILES_MAX) throw new HttpError(413, t().shareFilesTooMany(SHARE_FILES_MAX));
  const total = found.reduce((sum, f) => sum + (f.info.size ?? 0), 0);
  if (total > SHARE_FILES_MAX_BYTES) {
    throw new HttpError(413, t().shareFilesTooLarge((total / 1_000_000).toFixed(1), shareSize(SHARE_FILES_MAX_BYTES)));
  }
}

/** A folder's real path (links resolved), as Grok sees it; the path itself when it cannot be resolved. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The HTTP API (`/api/*`). Static files and the listening server are set up in `index.ts`. */
export function createApp({
  auth,
  store,
  settings,
  hub,
  orchestrator,
  providers,
  voice = new VoiceService(settings),
  native = new NativeSetupService(settings),
  agentsView,
  extraHosts = [],
  desktopApp = false,
  version = relayVersion,
  gists = {
    create: (html, description, files, onFilesGist) => shareToGist(html, description, undefined, files, { onFilesGist }),
    remove: unshareGist,
  },
  screenshotGists = { upload: (files) => uploadScreenshots(files), remove: unshareGist },
  updates = new Updates(undefined, version),
}: AppDeps): Hono {
  const app = new Hono();
  /** The gists of report screenshots uploaded since the server started: only these can be deleted here. */
  const screenshots = new Set<string>();
  /**
   * The files gists of the shares being made: recorded as unfinished as soon as they exist, but not
   * listed, nor removed, until their share is done (after a restart, one left so is listed).
   */
  const making = new Set<string>();

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
    return withLang(parseLang(c.req.header('x-relay-lang'), c.req.header('accept-language')), async () => {
      if (auth && !OPEN.has(`${c.req.method} ${c.req.path}`)) {
        const session = auth.check(getCookie(c, SESSION_COOKIE), requestKey(c));
        if (!session) return c.json({ error: desktopApp ? t().signedOutDesktop : t().signedOut, code: SIGNED_OUT }, 401);
        sessions.set(c.req.raw, session);
      }
      await next();
    });
  });

  /** What a request takes without a signed-in browser: asking whether it is one, and signing in. */
  const OPEN = new Set(['GET /api/auth', 'POST /api/auth/login']);
  /** The session each request came from. */
  const sessions = new WeakMap<Request, string>();

  /**
   * The key a request shows. The browser loads files by itself (images, videos, downloads, a folder's
   * ZIP), without the header: those GETs take the cookie alone (null), and read only files in the
   * conversation's folders, which an agent there can read anyway. The live updates (EventSource, which
   * sends no headers either) carry the key in the query.
   */
  function requestKey(c: Context): string | null | undefined {
    if (['GET', 'HEAD'].includes(c.req.method) && BROWSER_LOADS.test(c.req.path)) return null;
    if (c.req.method === 'GET' && /^\/api\/conversations\/[^/]+\/events$/.test(c.req.path)) return c.req.query('key');
    return c.req.header(AUTH_KEY_HEADER);
  }
  const BROWSER_LOADS = /^\/api\/conversations\/[^/]+\/(attachments\/[^/]+|messages\/[^/]+\/(media|download)|files\/(raw|download|zip))$/;

  // --- Signing in ---------------------------------------------------------------------

  app.get('/api/auth', (c) =>
    c.json({
      signedIn: !auth || Boolean(auth.check(getCookie(c, SESSION_COOKIE), c.req.header(AUTH_KEY_HEADER))),
      // The sign-in page then says where a desktop app's user gets a link.
      ...(desktopApp ? { desktop: true } : {}),
    }),
  );

  app.post('/api/auth/login', async (c) => {
    if (!auth) throw new HttpError(404, 'Signing in is off');
    const { code } = await body<{ code?: unknown }>(c);
    // Counted after the body is read, right before the code is tried (both synchronous): requests
    // that hold their bodies back cannot all get past the limit together.
    if (auth.tooManyFailures()) throw new HttpError(429, t().signInTooMany);
    // A browser signed in already (a sign-in link opened in it again): its new session replaces that one.
    const previous = auth.check(getCookie(c, SESSION_COOKIE), null);
    const signedIn = typeof code === 'string' ? auth.redeem(code, browserLabel(c.req.header('user-agent'))) : undefined;
    if (!signedIn) throw new HttpError(400, t().signInWrongCode);
    if (previous) auth.revoke(previous);
    // HttpOnly: no page script reads it. Strict: no other site's request carries it.
    setCookie(c, SESSION_COOKIE, signedIn.cookie, { path: '/api', httpOnly: true, sameSite: 'Strict', maxAge: SESSION_MAX_AGE_S });
    return c.json({ key: signedIn.key });
  });

  /** A code for another device (a phone), from a browser that is signed in. */
  app.post('/api/auth/codes', (c) => {
    if (!auth) throw new HttpError(404, 'Signing in is off');
    return c.json(auth.createCode(CODE_TTL_MS.device));
  });

  app.get('/api/auth/sessions', (c) => c.json(auth ? auth.sessions(sessions.get(c.req.raw)) : []));

  /** Signs a browser out (this one too: its cookie goes as well). */
  app.delete('/api/auth/sessions/:id', (c) => {
    if (!auth) throw new HttpError(404, 'Signing in is off');
    const id = c.req.param('id');
    if (!auth.revoke(id)) throw new HttpError(404, t().signInNoSession);
    if (id === sessions.get(c.req.raw)) deleteCookie(c, SESSION_COOKIE, { path: '/api' });
    return c.json({ ok: true });
  });

  /**
   * Edit mode in a working directory that holds Harness Relay itself, or what decides how the agents
   * run (the home folder, a CLI's own folder or program), is refused (`relayFolderRefusal`).
   */
  function refuseRelayFolder(s: { permission: string; cwd: string }): void {
    const why = relayFolderRefusal(s, agentFolderOptions(settings));
    if (why) throw new HttpError(400, why, RELAY_FOLDER);
  }

  /** The same for settings as sent, before `validateSettings` may create their working directory. */
  function refuseRelayFolderFirst(raw: unknown, defaultCwd: string): void {
    const s = (raw ?? {}) as { permission?: unknown; cwd?: unknown };
    refuseRelayFolder({ permission: String(s.permission ?? ''), cwd: expandPath(String(s.cwd || defaultCwd)) });
  }


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

  /**
   * The account a request is for: the `:account` path parameter, else the `account` query parameter;
   * empty or `default` = the CLI's default account (returned as empty), anything else one it has.
   */
  function account(c: Context, p: Provider): string {
    const raw = c.req.param('account') ?? c.req.query('account') ?? '';
    const id = raw === DEFAULT_ACCOUNT ? '' : raw;
    if (!settings.hasAccount(p, id)) throw new HttpError(404, t().unknownAccount(PROVIDER_LABEL[p], raw));
    return id;
  }

  // --- Settings & providers ----------------------------------------------------

  /** The settings, with how the last update of AgentsView (at the current address) went. */
  const settingsView = () => {
    const v = settings.view();
    const error = agentsView?.error;
    return error ? { ...v, agentsViewError: error } : v;
  };

  app.get('/api/settings', (c) => c.json(settingsView()));

  app.put('/api/settings', async (c) => {
    const b = await body<{
      defaultCwd?: unknown;
      createCwd?: unknown;
      lead?: unknown;
      agentHome?: unknown;
      agentsViewUrl?: unknown;
      agentsViewLink?: unknown;
    }>(c);
    // Validate everything before saving anything; the folders last, since creating them is a side effect.
    const lead = b.lead !== undefined ? validateLead(b.lead) : undefined;
    const viewUrl = b.agentsViewUrl !== undefined ? validAgentsViewUrl(b.agentsViewUrl) : undefined;
    const viewLink = b.agentsViewLink !== undefined ? validAgentsViewLink(b.agentsViewLink) : undefined;
    const cwd = b.defaultCwd !== undefined ? validDirectory(b.defaultCwd, b.createCwd === true) : undefined;
    // Not inside Harness Relay's folder or the default working directory (the new one, when it changes too).
    const home = b.agentHome !== undefined ? validAgentHome(b.agentHome, [process.cwd(), cwd ?? settings.defaultCwd]) : undefined;
    // A turn that starts in the new home would find its CLI signed out, and its session elsewhere.
    if (home !== undefined && home !== settings.agentHome && orchestrator.anyRunning()) throw new HttpError(409, t().agentHomeBusy);
    // Created only now that nothing refuses the request.
    if (home) ensureFolder(home);
    if (cwd !== undefined) settings.setDefaultCwd(cwd);
    if (lead !== undefined) settings.setLead(lead);
    if (viewUrl !== undefined) settings.setAgentsViewUrl(viewUrl);
    if (viewLink !== undefined) settings.setAgentsViewLink(viewLink);
    if (home !== undefined && home !== settings.agentHome) {
      settings.setAgentHome(home);
      // Another home (for every account): another sign-in, other models and other parts of its own.
      // A sign-in still running would finish in the old home.
      providers.invalidate();
      providers.cancelLogins();
    }
    return c.json(settingsView());
  });

  // --- Model backends: what the open agents run their models on (keys masked) ---------

  app.get('/api/backends', (c) => c.json(settings.backends.view()));

  // Each change to the backends refreshes the model menus and the agents' status, also one that failed
  // part way (an endpoint saved while the credential store refused its key).
  const changingBackends = <T>(change: () => T): T => {
    try {
      return change();
    } finally {
      providers.backendsChanged();
    }
  };

  // An API backend's key (openai, anthropic, xai): `{ apiKey }`, null or "" removes it.
  app.put('/api/backends/:id', async (c) => {
    const id = validApiBackend(c.req.param('id'));
    const key = validateBackendKey(await body<unknown>(c));
    changingBackends(() => settings.backends.setApiKey(id, key));
    return c.json(settings.backends.view());
  });

  // Adds a custom endpoint, or replaces the one with this id (its key stays unless `apiKey` is sent).
  app.put('/api/backends/endpoints/:id', async (c) => {
    const id = validEndpointId(c.req.param('id'));
    const endpoint = validateEndpoint(await body<unknown>(c));
    changingBackends(() => settings.backends.putEndpoint(id, endpoint));
    return c.json(settings.backends.view());
  });

  app.delete('/api/backends/endpoints/:id', (c) => {
    const id = validEndpointId(c.req.param('id'));
    changingBackends(() => settings.backends.deleteEndpoint(id));
    return c.json(settings.backends.view());
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
    return c.json(settingsView());
  });

  // A CLI's accounts besides its default one: each has a folder of its own for the CLI (its sign-in,
  // settings and sessions) and may have an API key of its own. Agents and the lead agent name theirs.
  app.post('/api/settings/providers/:provider/accounts', async (c) => {
    const p = provider(c);
    // An open agent has no sign-in, so no other account: it runs on the model backends.
    if (isOpenProvider(p)) throw new HttpError(400, t().openNoLogin(PROVIDER_LABEL[p]));
    const b = await body<{ label?: unknown }>(c);
    const label = validAccountLabel(b.label ?? '');
    if (settings.accountIds(p).length + 1 >= MAX_ACCOUNTS) throw new HttpError(409, t().tooManyAccounts(PROVIDER_LABEL[p], MAX_ACCOUNTS));
    const id = settings.addAccount(p, label);
    if (p === 'grok') {
      // The folders the default account trusts (which Settings shows) are trusted for this one too.
      try {
        copyGrokTrust(settings.env('grok'), settings.env('grok', id));
      } catch (err) {
        console.warn(`[settings] could not copy Grok's folder trust to account ${id}: ${(err as Error).message}`);
      }
    }
    providers.invalidate(p);
    return c.json({ id, settings: settingsView() });
  });

  // Renames an account (`default`: the default one), sets or removes its key, or changes how Harness
  // Relay runs it: its default model and effort, and what its runs leave out of what the CLI loads by
  // itself in its home. A Codex key signs the account in with it, in its own folder; Codex keeps it.
  app.put('/api/settings/providers/:provider/accounts/:account', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = validateAccountUpdate(await body<unknown>(c));
    const signIn = b.apiKey !== undefined;
    if (b.apiKey !== undefined && b.apiKey !== null && p === 'codex') {
      await providers.codexApiKeyLogin(b.apiKey, id);
      delete b.apiKey;
    }
    settings.updateAccount(p, id, b);
    // Its name and sign-in are in the status; its defaults are layered over the models at each request.
    if (signIn || b.label !== undefined) providers.invalidate(p);
    return c.json(settingsView());
  });

  // Removes an account besides the default one: signs it out (as far as the CLI can; a key it kept in
  // the system's credential store goes with it), forgets its key, and deletes its folder, with its
  // sign-in and the CLI's sessions. Agents that named it use the default account from then on.
  app.delete('/api/settings/providers/:provider/accounts/:account', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    if (!id) throw new HttpError(400, t().defaultAccountStays);
    // A turn of this account would go on in a folder being deleted.
    if (orchestrator.anyRunning()) throw new HttpError(409, t().accountBusy);
    providers.forgetLogin(p, id);
    // Forgotten at once, with nothing awaited since the check: a turn that starts while the CLI signs
    // out runs as the default account, never in the folder about to go. The sign-out uses the
    // account's environment taken before (its id now names the default account).
    const env = settings.env(p, id);
    const home = settings.removeAccount(p, id);
    await providers.logoutIn(p, env, 15_000).catch(() => {});
    if (home) await rm(home, { recursive: true, force: true }).catch((err: Error) => console.warn(`[settings] could not delete ${home}: ${err.message}`));
    providers.invalidate(p);
    return c.json(settingsView());
  });

  app.get('/api/providers', async (c) => c.json(await providers.statusAll(c.req.query('refresh') === '1')));

  // Which Harness Relay this is, and on what, for a problem report the user sends by email.
  app.get('/api/about', async (c) => c.json(await aboutInfo(desktopApp, version)));

  // The desktop app's updates: this version, a newer one, an update under way (only the version for
  // `npm start`). Settings' "Check again" has the app ask GitHub now; Update has it ask the user, in its
  // own dialog on the computer it runs on, then update as from its menu.
  app.get('/api/update', async (c) => c.json(await updates.status()));
  app.post('/api/update/check', async (c) => c.json(await updates.check()));
  app.post('/api/update/install', (c) => {
    const asked = updates.install();
    if (asked !== 'asked') throw new HttpError(409, asked === 'under-way' ? t().updateUnderWay : t().updateNone);
    return c.json({ ok: true });
  });

  // A problem report's screenshots, which a mail link cannot carry: one secret gist of them, uploaded
  // with the user's GitHub CLI when they press Upload, its page the link the mail carries. Deleting it
  // again (Remove upload) takes only one uploaded here since the server started.
  app.post('/api/report/screenshots', async (c) => {
    const b = await body<{ files?: unknown }>(c);
    const files = parseScreenshots(b.files);
    const shots = await gistCall(() => screenshotGists.upload(files));
    screenshots.add(shots.id);
    return c.json(shots);
  });

  app.delete('/api/report/screenshots/:id', async (c) => {
    const id = c.req.param('id');
    if (!validGistId(id) || !screenshots.has(id)) throw new HttpError(404, t().reportShotsNotFound);
    await gistCall(() => screenshotGists.remove(id));
    screenshots.delete(id);
    return c.json({ ok: true });
  });

  app.get('/api/models', async (c) => c.json(await providers.modelsAll(c.req.query('refresh') === '1')));

  // What the CLI loads by itself (its own skills, MCP servers, memory) for the default working
  // directory, in the home of the default account or the one `?account=<id>` names, with what that
  // account's runs leave out. A POST, because it starts the CLI (Claude Code runs the project's hooks):
  // the JSON content-type check keeps other sites from setting it off. Answers are kept for a minute.
  app.post('/api/providers/:provider/native', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = await body<{ refresh?: unknown }>(c);
    const cwd = validDirectory(settings.defaultCwd);
    return c.json(nativeForClient(await native.get(p, cwd, b.refresh === true, id || undefined)));
  });

  // Whether Grok trusts a folder (the default working directory unless `cwd` names one), and with
  // `trust: true` — sent after the user confirmed — record that it does, as `grok --trust` would.
  // A POST with a JSON body, so no other site can send it.
  app.post('/api/providers/grok/folder-trust', async (c) => {
    const b = await body<{ cwd?: unknown; trust?: unknown; folder?: unknown }>(c);
    const cwd = validDirectory(typeof b.cwd === 'string' && b.cwd.trim() ? b.cwd : settings.defaultCwd);
    const trust = b.trust === true;
    // Trusting asks Grok again, so the folder recorded is the one Grok decides trust for right now.
    const before = await native.get('grok', cwd, trust);
    const folder = before.trustFolder ?? realDir(cwd);
    const above = before.trustFolderAbove === true;
    if (!trust || before.folderTrusted === true) return c.json({ cwd, folder, above, trusted: before.folderTrusted });
    // The user confirmed trust in the folder they were shown; if Grok now names another, ask again.
    if (typeof b.folder === 'string' && b.folder !== folder) throw new HttpError(409, t().grokTrustFolderChanged(folder));
    // Every Grok account keeps its own trust, in its own folder: the folder is trusted for all of them
    // (or none, when one of them cannot be written).
    const envs = ['', ...settings.accountIds('grok')].map((id) => settings.env('grok', id));
    const written = trustGrokFolderAll(folder, envs);
    const after = await native.get('grok', cwd, true);
    if (after.folderTrusted === false) {
      // Grok did not take it: leave no entry behind that does nothing.
      restoreGrokTrustAll(written);
      throw new HttpError(409, t().grokTrustNotTaken(folder));
    }
    return c.json({ cwd, folder, above, trusted: after.folderTrusted });
  });

  // One of the files the CLI reported (an instruction or memory file, a skill's SKILL.md) for the
  // default account or `?account=<id>`, to read it in the UI. Any other path is refused, so this
  // cannot read other files on the computer.
  app.post('/api/providers/:provider/native/file', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = await body<{ path?: unknown }>(c);
    const path = typeof b.path === 'string' ? b.path : '';
    // Checked against the answer the UI showed, however old: opening a file must not start the CLI.
    const probe = await native.latest(p, validDirectory(settings.defaultCwd), id || undefined);
    if (!path || !listedFile(probe, path)) throw new HttpError(404, t().nativeFileNotListed);
    return c.json(readPreview(path, path, t().nativeFileNotListed));
  });

  app.get('/api/providers/:provider/login-methods', (c) => c.json(providers.loginMethods(provider(c))));

  // Signing in and out: of the default account, or of the one `?account=<id>` names.
  app.post('/api/providers/:provider/login', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = await body<{ method?: string }>(c);
    try {
      return c.json(providers.startLogin(p, b.method, id));
    } catch (err) {
      if (err instanceof KeyOnlyAccountError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  app.get('/api/providers/:provider/login', (c) => {
    const p = provider(c);
    return c.json(providers.login(p, account(c, p)));
  });

  app.post('/api/providers/:provider/login/input', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = await body<{ text?: string }>(c);
    const view = providers.sendLoginInput(p, String(b.text ?? ''), id);
    if (!view) throw new HttpError(404, t().noLogin);
    return c.json(view);
  });

  app.delete('/api/providers/:provider/login', (c) => {
    const p = provider(c);
    providers.cancelLogin(p, account(c, p));
    return c.json({ ok: true });
  });

  app.post('/api/providers/:provider/logout', async (c) => {
    const p = provider(c);
    const output = await providers.logout(p, account(c, p));
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

  // The working directories the working directory box offers: the default one, then the conversations'
  // own, the most recently used first; only folders that still exist.
  app.get('/api/cwds', async (c) => {
    // As a new conversation reads it (`~` expanded), so it is the folder conversations get by default.
    const def = expandPath(settings.defaultCwd);
    // Each folder once, also when spelled in another case where the filesystem ignores case.
    const seen = new Set<string>();
    const paths = [def, ...store.listCwds()].filter((p) => {
      const key = foldCase(resolve(p));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const isDir = await Promise.all(paths.map((p) => stat(p).then((s) => s.isDirectory(), () => false)));
    const dirs = paths.filter((_, i) => isDir[i]).map((path) => (path === def ? { path, default: true as const } : { path }));
    return c.json({ home: homedir(), dirs } satisfies WorkingDirectories);
  });

  /** Save a new conversation and set up its working directory; one that cannot be set up is not kept. */
  async function newConversation(conv: Conversation): Promise<void> {
    store.create(conv);
    // Agents that may write need a git repository; set it up now so problems surface immediately.
    try {
      await orchestrator.prepareWorkspace(conv);
    } catch (err) {
      store.delete(conv.id);
      throw err;
    }
  }

  app.post('/api/conversations', async (c) => {
    const b = await body<Partial<Conversation> & { createCwd?: unknown }>(c);
    const now = Date.now();
    // Auto team: the lead agent designs the team for each question, starting with the first.
    // The agents first: creating a missing working directory is a side effect.
    const agents = b.settings?.autoTeam === true ? [] : validateAgents(b.agents);
    refuseRelayFolderFirst(b.settings, settings.defaultCwd);
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
    await newConversation(conv);
    return c.json(forClient(conv));
  });

  // A new schedule (New schedule in the sidebar): a conversation for it, with auto team, whose lead
  // agent designs the team for the schedule's message now. Nothing runs until the schedule sends it;
  // until the team is confirmed, a time that comes due is skipped.
  app.post('/api/schedules', async (c) => {
    const b = await body<{ title?: unknown; settings?: Record<string, unknown>; createCwd?: unknown; schedule?: unknown }>(c);
    const now = Date.now();
    // The schedule first: creating a missing working directory is a side effect.
    const update = validateSchedule(b.schedule, now);
    refuseRelayFolderFirst(b.settings, settings.defaultCwd);
    const s = validateSettings({ ...(b.settings ?? {}), autoTeam: true }, settings.defaultCwd, b.createCwd === true);
    const conv: Conversation = {
      id: randomUUID(),
      title: String(b.title ?? '').trim().slice(0, 200) || titleFrom(update.text) || t().defaultTitle,
      createdAt: now,
      updatedAt: now,
      agents: [],
      settings: s,
      messages: [],
      agentState: {},
      worktrees: {},
    };
    const schedule: ConversationSchedule = { ...update, lang: currentLang(), updatedAt: now };
    const next = update.enabled ? nextRun(schedule, now) : undefined;
    if (next !== undefined) schedule.nextRunAt = next;
    await newConversation(conv);
    try {
      conv.schedule = schedule;
      store.saveSchedule(conv);
      orchestrator.systemNote(conv, t().scheduleCreatedNote);
      await orchestrator.designForSchedule(conv.id);
    } catch (err) {
      await orchestrator.deleteConversation(conv.id);
      throw err;
    }
    // Sorted into the user's sidebar groups by its message, as a new chat is by its first question.
    orchestrator.sortIntoGroup(conv, update.text);
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
      // AgentsView shows the title as the thread's name (not for a conversation being deleted).
      if (b.title !== undefined) orchestrator.trace(conv);
      return c.json(forClient(conv));
    };
    if (!b.agents && !b.settings) return save(); // renaming is fine while the team replies
    let confirmed = false;
    // Reserved while the workspace is prepared, so no run starts with half-changed settings.
    const res = await orchestrator.exclusive(conv.id, t().busySettings, async () => {
      const agents = b.agents ? validateAgents(b.agents) : conv.agents;
      // After the agents: creating a missing working directory is a side effect.
      if (b.settings) refuseRelayFolderFirst(b.settings, conv.settings.cwd);
      const next = b.settings ? validateSettings(b.settings, conv.settings.cwd, b.createCwd === true) : { ...conv.settings };
      refuseRelayFolder(next);
      // Edits never switch auto team on or off; a team set by hand replaces the lead agent's pending
      // design (the next question is designed again).
      if (conv.settings.autoTeam) next.autoTeam = true;
      else delete next.autoTeam;
      if (b.settings) await orchestrator.prepareWorkspace({ ...conv, settings: next });
      conv.agents = agents;
      conv.settings = next;
      if (b.agents) confirmed = orchestrator.confirmPendingPlan(conv);
      return save();
    });
    // The team set by hand answers the question its design was for.
    if (confirmed) orchestrator.startConfirmed(conv);
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

  // Set the conversation's schedule: a message the team is sent at set times (it replaces the one
  // there was). Saving starts its times afresh; what happened last time is kept.
  app.put('/api/conversations/:id/schedule', async (c) => {
    const conv = getConv(c.req.param('id'));
    const now = Date.now();
    const update = validateSchedule(await body<unknown>(c), now);
    // Scheduled messages go to the current team: there must be one, and not one waiting for confirmation.
    if (update.enabled && (conv.agents.length === 0 || pendingPlan(conv.messages))) {
      throw new HttpError(409, t().scheduleNeedsTeam);
    }
    const prev = conv.schedule;
    // Changing the message or the other choices keeps an interval's cadence; changing the times restarts it.
    const sameTimes = prev && JSON.stringify(prev.repeat) === JSON.stringify(update.repeat) && prev.timeZone === update.timeZone;
    const schedule: ConversationSchedule = {
      ...update,
      lang: currentLang(),
      updatedAt: sameTimes ? prev.updatedAt : now,
      ...(prev?.lastRunAt !== undefined ? { lastRunAt: prev.lastRunAt } : {}),
      ...(prev?.lastResult ? { lastResult: prev.lastResult } : {}),
      ...(prev?.lastError ? { lastError: prev.lastError } : {}),
      ...(prev?.lastChatId ? { lastChatId: prev.lastChatId } : {}),
    };
    const next = update.enabled ? nextRun(schedule, now) : undefined;
    if (next !== undefined) schedule.nextRunAt = next;
    conv.schedule = schedule;
    store.saveSchedule(conv);
    orchestrator.emitConversation(conv);
    return c.json(schedule);
  });

  app.delete('/api/conversations/:id/schedule', (c) => {
    const conv = getConv(c.req.param('id'));
    if (conv.schedule) {
      conv.schedule = undefined;
      store.saveSchedule(conv);
      orchestrator.emitConversation(conv);
    }
    return c.json({ ok: true });
  });

  // Have the lead agent design the team for the schedule's message (again), e.g. after a design was
  // stopped. Nothing runs once it is confirmed: the team gets the message when the schedule sends it.
  app.post('/api/conversations/:id/schedule/design', async (c) => {
    await orchestrator.designForSchedule(getConv(c.req.param('id')).id);
    return c.json({ ok: true }, 202);
  });

  // Send the schedule's message now, as it would be sent when it comes due (its times stay as they are).
  // `chatId`: the conversation it opened, for a schedule that opens a new one each time.
  app.post('/api/conversations/:id/schedule/run', async (c) => {
    const sent = await orchestrator.sendScheduled(c.req.param('id'));
    if (sent.result === 'busy' || sent.result === 'skipped' || sent.result === 'failed') {
      const reason = sent.reason ?? t().scheduleBusy;
      throw new HttpError(409, reason.charAt(0).toUpperCase() + reason.slice(1));
    }
    const chatId = sent.result === 'sent' ? sent.chatId : undefined;
    return c.json({ ok: true, queued: sent.result === 'queued', ...(chatId ? { chatId } : {}) }, 202);
  });

  app.delete('/api/conversations/:id', async (c) => {
    // Stops a run first and waits for it to wind down, so nothing writes to the deleted conversation.
    await orchestrator.deleteConversation(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Share the conversation: the web app makes the page (what it shows, without tool calls and
  // thinking); it goes up to GitHub as a secret gist with the user's GitHub CLI, read on gistpreview.
  // `upTo`: the agent reply it ends with (recorded, for the list in Settings). `files`: the links of
  // the files to take along (each placeholder link on the page names one by its place here): the
  // files go into a second secret gist, read only as the replies' download links would serve them.
  app.post('/api/conversations/:id/share', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ html?: unknown; upTo?: unknown; files?: unknown }>(c);
    if (typeof b.html !== 'string' || !b.html.trim()) throw new HttpError(400, t().shareEmpty);
    const refs = parseShareFileRefs(b.files);
    const linked = fileLinksIn(b.html);
    if (!refs || linked.some((n) => n >= refs.length)) throw new HttpError(400, t().shareBadFiles);
    // Each link to a file grows to its address on GitHub.
    const bytes = Buffer.byteLength(b.html) + fileLinkCount(b.html) * SHARE_FILE_URL_MAX;
    if (bytes > SHARE_MAX_BYTES) throw new HttpError(413, t().shareTooLarge((bytes / 1_000_000).toFixed(1)));
    const upTo = typeof b.upTo === 'string' ? b.upTo : undefined;
    // Measured first, and read only when they can all go along; checked again as read (one may have
    // changed since), never more than the limits in all.
    const found = await findShareFiles(conv, linked.map((n) => refs[n]!), upTo, (id) => store.get(id));
    refuseShareFiles(found);
    await readShareFiles(found);
    refuseShareFiles(found);
    const names = gistFileNames(found.map((f) => f.info.name));
    const files: GistUpload[] = found.map((f, i) => ({ name: names[i]!, data: f.data! }));
    // The page's links name the request's files; the gist gets each file once.
    const fileOf = new Map<number, number>();
    found.forEach((f, i) => f.info.refs.forEach((r) => fileOf.set(linked[r]!, i)));
    const html = replaceFileLinks(b.html, (n) => shareFileHref(fileOf.get(n)!));

    const reply = upTo !== undefined ? conv.messages.find((m) => m.id === upTo) : undefined;
    const author = reply?.author;
    const agentName =
      author?.kind === 'agent' ? (reply!.agentName ?? conv.agents.find((a) => a.id === author.agentId)?.name ?? '') : undefined;
    const record = (link: ShareLink): SharedPage => ({
      ...link,
      conversationId: conv.id,
      title: conv.title,
      ...(reply && agentName !== undefined ? { upTo: { messageId: reply.id, agentName } } : {}),
      createdAt: Date.now(),
      ...(files.length ? { files: files.length } : {}),
    });
    // The files gist is listed as unfinished as soon as it is made, so it can be removed in Settings
    // also when the server stops before the share is done; forgotten again once the page is up, or
    // once the gist was deleted again (one left on GitHub stays listed).
    let pending: string | undefined;
    const onFilesGist = (gist: ShareLink) => {
      pending = gist.id;
      making.add(gist.id);
      store.addShare({ ...record(gist), unfinished: true });
    };
    let link: ShareLink;
    try {
      link = await gistCall(
        async () => {
          try {
            return await gists.create(html, gistDescription(conv.title), files, onFilesGist);
          } catch (err) {
            if (pending && err instanceof ShareError && !err.leftover) store.deleteShare(pending);
            throw err;
          }
        },
        (leftover) => store.addShare({ ...record(leftover), unfinished: true }),
      );
    } finally {
      if (pending) making.delete(pending);
    }
    const shared = record(link);
    if (pending && pending !== link.id) store.replaceShare(pending, shared);
    else store.addShare(shared);
    return c.json(shared);
  });

  // The files the messages of a share (up to and including `upTo`, or all) link to, by the links
  // given: each once, with its size, and why it cannot go along when it cannot.
  app.post('/api/conversations/:id/share/files', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ files?: unknown; upTo?: unknown }>(c);
    const refs = parseShareFileRefs(b.files);
    if (!refs) throw new HttpError(400, t().shareBadFiles);
    const found = await findShareFiles(conv, refs, typeof b.upTo === 'string' ? b.upTo : undefined, (id) => store.get(id));
    return c.json({ files: found.map((f) => f.info) });
  });

  /** A gist call, its trouble reported to the user (gh missing, not signed in…), a gist it left behind to `leftover`. */
  async function gistCall<T>(fn: () => Promise<T>, leftover?: (link: ShareLink) => void): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ShareError && err.leftover) leftover?.(err.leftover);
      if (err instanceof ShareError) throw new HttpError(502, err.message, err.code);
      throw err;
    }
  }

  // The conversations shared so far, the newest first (not those still being made); removing one
  // deletes its gists.
  app.get('/api/shares', (c) => c.json(store.listShares().filter((s) => !making.has(s.id))));

  // Both of a share's gists go: the files gist first, then the page's. The share is forgotten only once
  // both are gone, so one that could not be deleted stays listed, to be removed again (a gist already
  // gone counts as deleted then).
  app.delete('/api/shares/:id', async (c) => {
    const id = c.req.param('id');
    const share = validGistId(id) ? store.getShare(id) : undefined;
    if (!share) throw new HttpError(404, t().shareNotFound);
    // Its files are going up: deleting their gist now would leave the share without them.
    if (making.has(id)) throw new HttpError(409, t().shareBeingMade);
    const files = share.filesGist && share.filesGist !== id && validGistId(share.filesGist) ? [share.filesGist] : [];
    let failed: unknown;
    for (const gist of [...files, id]) {
      try {
        await gists.remove(gist);
      } catch (err) {
        failed ??= err;
      }
    }
    if (failed !== undefined) await gistCall(() => Promise.reject(failed));
    store.deleteShare(id);
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
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', part.name),
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
    const file = msg && resolveMedia(c.req.query('path') ?? '', mediaRoots(conv, msg, (id) => store.get(id)));
    if (!file) throw new HttpError(404, t().mediaNotFound);
    return sendFile(c, file);
  });

  // A file a reply links to, e.g. [Slides](out/deck.pptx): any file inside the same folders as its
  // media (never in .git), always as a download, so an HTML or SVG file can never run here.
  app.get('/api/conversations/:id/messages/:messageId/download', async (c) => {
    const conv = getConv(c.req.param('id'));
    const msg = conv.messages.find((m) => m.id === c.req.param('messageId'));
    const file = msg && resolveDownload(c.req.query('path') ?? '', mediaRoots(conv, msg, (id) => store.get(id)));
    if (!file) throw new HttpError(404, t().downloadNotFound);
    return sendFile(c, file, true);
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
    return sendFile(c, mediaInRoot(rootPath(roots, root), path));
  });

  // Any file in the folder, as a download.
  app.get('/api/conversations/:id/files/download', (c) => {
    const { roots, root, path } = fileTarget(c);
    return sendFile(c, fileInRoot(rootPath(roots, root), path), true);
  });

  /** The name a root's ZIP file goes by: an agent's worktree is named after the folder and the agent. */
  const zipName = (c: Context, root: string): string | undefined => {
    if (root === 'cwd') return undefined;
    const conv = getConv(c.req.param('id') ?? '');
    const agent = conv.agents.find((a) => a.id === root);
    return `${basename(conv.settings.cwd)}-${agent?.name ?? root}`;
  };

  // What downloading a folder as a ZIP file would hold: all of it, or (when that is too much) only
  // what git does not ignore. Nothing is read or zipped.
  app.get('/api/conversations/:id/files/zip/check', async (c) => {
    const { roots, root, path } = fileTarget(c);
    const dir = rootPath(roots, root);
    const size = (p: ZipPlan | null) => (p ? { files: p.files, bytes: p.bytes } : null);
    const all = await zipPlan(dir, path);
    const check: ZipCheck = { all: size(all), ...(all ? {} : { unignored: size(await zipPlan(dir, path, { unignored: true })) }) };
    return c.json(check);
  });

  // A folder (the root too) as a ZIP file, zipped as it is sent; `unignored=1`: only what git does not
  // ignore. Like any download, it has no type the browser could render here.
  app.get('/api/conversations/:id/files/zip', async (c) => {
    const { roots, root, path } = fileTarget(c);
    const plan = await zipPlan(rootPath(roots, root), path, { unignored: c.req.query('unignored') === '1', name: zipName(c, root) });
    if (!plan) throw new HttpError(413, t().zipTooBig(FILE_LIMITS.zipItems, FILE_LIMITS.zipBytes / 1024 ** 3));
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `${plan.name}.zip`),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    };
    if (c.req.method === 'HEAD') return new Response(null, { headers });
    return new Response(Readable.toWeb(Readable.from(zipStream(plan.entries))) as ReadableStream, { headers });
  });

  /**
   * An image or video to show, or (`download`) any file to save, so that it can never run in this
   * origin: a download has no type the browser could render, and both are sandboxed.
   */
  async function sendFile(c: Context, file: string, download = false): Promise<Response> {
    const { size, mtimeMs } = await stat(file);
    const etag = `W/"${size}-${Math.floor(mtimeMs)}"`;
    const lastModified = new Date(mtimeMs).toUTCString();
    const headers: Record<string, string> = {
      'Content-Type': download ? 'application/octet-stream' : mediaType(file)!,
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', basename(file)),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // Agents may write the file again: check before reusing a cached copy.
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'Last-Modified': lastModified,
      'Accept-Ranges': 'bytes',
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    // Videos are fetched in ranges (Safari plays nothing otherwise, and seeking needs them), and a
    // download can go on where it stopped. A download's range of a file that changed since (If-Range,
    // which may not name a weak ETag) is the whole file again; video seeking stays as it was.
    const ifRange = download ? c.req.header('if-range') : undefined;
    const range = !ifRange || ifRange === lastModified ? byteRange(c.req.header('range'), size) : null;
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(size ? end - start + 1 : 0);
    const status = range ? 206 : 200;
    // HEAD (asked to check that a file is there) gets the headers only: no file is opened.
    if (c.req.method === 'HEAD') return new Response(null, { status, headers });
    const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream) : null;
    return new Response(body, { status, headers });
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

  // Branch the conversation from an agent's reply: a new conversation with the messages up to and
  // including it, which goes on from there on its own (this one stays as it is). Answers with it.
  app.post('/api/conversations/:id/messages/:messageId/branch', async (c) =>
    c.json(forClient(await orchestrator.branch(c.req.param('id'), c.req.param('messageId')))),
  );

  // Accept the team the lead agent designed for a question (auto team); that team then answers it.
  app.post('/api/conversations/:id/messages/:messageId/confirm-plan', async (c) => {
    orchestrator.confirmPlan(c.req.param('id'), c.req.param('messageId'));
    return c.json({ ok: true });
  });

  // Decline it: the current team stays, and answers the question.
  app.post('/api/conversations/:id/messages/:messageId/decline-plan', async (c) => {
    orchestrator.declinePlan(c.req.param('id'), c.req.param('messageId'));
    return c.json({ ok: true });
  });

  // Save a team the lead agent designed (auto team) as a template.
  app.post('/api/conversations/:id/messages/:messageId/save-plan', async (c) => {
    const b = await body<{ name?: string }>(c);
    return c.json(orchestrator.savePlanAsPreset(c.req.param('id'), c.req.param('messageId'), b.name));
  });

  // Ask the lead agent to change the team being edited in the team drawer (the drawer's team comes
  // along). It returns the changed team, which the drawer shows until the user saves it; nothing in the
  // conversation changes here. Closing the request (the drawer, or Stop) stops the lead agent.
  app.post('/api/conversations/:id/revise-team', async (c) => {
    const b = await body<{ request?: unknown; agents?: unknown; settings?: unknown }>(c);
    return c.json(await orchestrator.reviseTeam(c.req.param('id'), b, c.req.raw.signal));
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
