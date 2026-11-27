import type { HttpBindings } from '@hono/node-server';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { AUTH_KEY_HEADER, RELAY_FOLDER, SIGNED_OUT, browserLabel, mobileBrowserLabel } from '../shared/auth';
import { CODE_TTL_MS, SESSION_COOKIE, SESSION_MAX_AGE_S, type AuthStore } from './auth';
import { AppPreviews, isPreviewHost } from './appPreviews';
import { appProblems, changedPreviewTarget, detectPreviewTarget, previewAddress, previewParent, previewTarget } from './previewTarget';
import { AppPublisher } from './publish';
import type { AppPreviewRequest, CommandProposal, PreviewTerminalEvent, PublishRequest } from '../shared/types';
import { HANDOFF_LIMITS } from '../shared/types';
import { dropPin } from './fixedCommands';
import { aboutInfo, relayVersion } from './about';
import { CliInstaller } from './cliInstall';
import { SandboxSetup } from './sandboxSetup';
import { commonAppDependencies, type AppDependencies } from './appDependencies';
import { GitInstall } from './gitInstall';
import { CONFIG, limitsOf } from './config';
import { APP_SERVERS, DRAFT_APPS, HOSTED_APPS, type DraftApp } from '../shared/apps';
import { TeamsGraph } from './connectors/teams';
import { githubSignOut, githubStatus } from './connectors/apps';
import { draftAvailability } from './connectors/draftAvailability';
import { HostedAppChecks } from './connectors/hostedApps';
import { checkedVault } from './connectors/obsidian';
import { agentFolderOptions, relayFolderRefusal } from './protect';
import {
  PREVIEW_NOT_READY,
  DEFAULT_ACCOUNT,
  FILE_EDIT_LIMITS,
  FILE_LIMITS,
  FOLDER_BUSY,
  isFolderAttachment,
  type FileDeleteRequest,
  type FileSaveRequest,
  type FileUploadRequest,
  keyOnlyAccount,
  GROUP_LIMITS,
  LANGS,
  PROVIDER_LABEL,
  isOpenProvider,
  PROVIDERS,
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_MAX_BYTES,
  SHARE_FILE_REFUSED,
  SHARE_FILE_URL_MAX,
  SHARE_MAX_BYTES,
  TEAM_WORKTREE,
  TRACKING_LIMITS,
  VOICE_MAX_SECONDS,
  cwdsOf,
  pendingPlan,
  PUSH_GONE,
  PUSH_TAKEN,
  type ApprovalAnswer,
  HANDOVER_LIMITS,
  type ComputerScreenEvent,
  type HandoverAnswer,
  type HandoverScreenEvent,
  type CheckList,
  type Conversation,
  type ServerLimits,
  type ConversationSchedule,
  type NewScheduleHook,
  type ScheduleUpdate,
  type Lang,
  type PickedFolders,
  type Provider,
  type ServerEvent,
  type ReportScreenshots,
  type ShareLink,
  type SharedPage,
  type TeamPreset,
  type WorkingDirectories,
  type ZipCheck,
  PERMISSION_ORDER,
  type Permission,
  type LabsView,
} from '../shared/types';
import type { AgentsViewSync } from './agentsview';
import { freshTracking } from '../shared/tracking';
import { hasRules } from '../shared/checks';
import { gatewayNode, sandboxAvailable, servingPort } from './relaySandbox';
import { checksEnvironment } from './checkCommands';
import { Handovers, checkInputs, type HandoverRefusal } from './browser/handover';
import { checkComputerInputs } from './computer/input';
import { ComputerService } from './computer/session';
import { discoverCalendars } from './connectors/caldav';
import { calendarBackend } from './connectors/calendar';
import type { McpOAuth } from './oauth/mcp';
import type { OAuthService } from './oauth/service';
import { keptPasswordFits } from './connectors/accounts';
import { testMail } from './connectors/test';
import type { Scheduler } from './scheduler';
import {
  attachmentPath,
  attachmentsDir,
  checkFolderNames,
  decodeAttachments,
  isInlineImage,
  safeFileName,
  type AttachmentPart,
  type AttachmentUpload,
} from './attachments';
import { fileInRoot, fileRoots, listFolder, mediaInRoot, previewFile, readPreview, zipPlan, type ZipPlan } from './files';
import { deletePath, rootReadOnly, saveText, uploadFile } from './fileEdit';
import { zipStream } from './zip';
import { copyGrokTrust, restoreGrokTrustAll, trustGrokFolderAll } from './grokTrust';
import { NativeSetupService, listedFile, nativeForClient } from './native';
import type { Hub } from './hub';
import { byteRange, contentDisposition, mediaRoots, mediaType, resolveDownload, resolveMedia } from './media';
import { titleFrom } from '../shared/conversationTitle';
import { HttpError, forClient, scheduleForClient, type Orchestrator } from './orchestrator';
import { KeyOnlyAccountError, type ProviderService } from './providers';
import { DATA_DIR, type SettingsStore } from './settings';
import { fileLinkCount, fileLinksIn, megabytesOver, replaceFileLinks, shareFileHref, shareSize } from '../shared/share';
import {
  ShareError,
  findShareFiles,
  gistDescription,
  gistFileNames,
  parseShareFileRefs,
  readShareFiles,
  shareToGist,
  GhLogin,
  unshareGist,
  validGistId,
  type FoundShareFile,
  type GistUpload,
} from './share';
import { parseScreenshots, uploadScreenshots } from './screenshots';
import { Updates } from './updates';
import { listEndpointModels, verifyEndpointModels } from './endpointModels';
import type { Store, TaskRequest } from './store';
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
  validateEndpointCatalog,
  validAgentsViewLink,
  validAgentsViewUrl,
  validDirectories,
  validDirectory,
  validGroupName,
  validVoiceModel,
  validateAccountUpdate,
  validateAgents,
  validateLead,
  validLabs,
  validateMcpServer,
  validateProviderUpdate,
  validateInboxRead,
  validatePushSubscription,
  validateSchedule,
  serverTimeZone,
  validateChecks,
  validateSettings,
  validateToolLibraryUpdate,
  validateMemoryNoteCreate,
  validateMemoryNoteUpdate,
  validateMemorySettings,
  validConnectorId,
  validOAuthProvider,
  validOAuthUses,
  validateOAuthCalendar,
  validateOAuthClient,
  validateMailAccount,
  validateCalendarAccount,
  validateVoiceUpdate,
  validSkillPath,
} from './validate';
import { VoiceService } from './voice';
import { existingFolder, systemFolderPicker, type FolderPicker } from './folderPicker';
import { nextRun, validTimeZone, watchOf } from '../shared/schedule';
import { proposalUpdate } from '../shared/scheduleProposal';
import { checkReorganize } from './grouping';
import { currentLang, parseLang, t, withLang } from './i18n';
import { testPayload, type AlertWatcher } from './alerts';
import type { PushService } from './push';

export interface AppDeps {
  /**
   * Signed-in browsers: every request but signing in must come from one (`src/server/auth.ts`).
   * Null takes no sign-in, for tests only: then any program on this computer could drive the agents.
   */
  auth: AuthStore | null;
  previews?: AppPreviews;
  /** Publishing previews to the user's Render and Neon accounts (`publish/`); created when not given. */
  publisher?: AppPublisher;
  store: Store;
  settings: SettingsStore;
  hub: Hub;
  orchestrator: Orchestrator;
  providers: ProviderService;
  /** Voice input; created on demand when not given (it does nothing until used). */
  voice?: VoiceService;
  /** Installs and removes the CLIs from Settings; created when not given (it does nothing until asked). */
  clis?: CliInstaller;
  /** What the agents' sandboxes need that is missing here, and installing it; created when not given. */
  sandboxSetup?: SandboxSetup;
  gitInstall?: GitInstall;
  appDependencies?: AppDependencies;
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
  /** Current private HTTPS endpoint for the listening port, from Tailscale Serve. */
  phoneAddress?: () => string | undefined | Promise<string | undefined>;
  /** This Harness Relay's version, for a problem report (`about.ts`; a fake in tests). */
  version?: () => Promise<string>;
  /** Opens this computer's own folder dialog for the working directory box (a fake in tests). */
  folderPicker?: FolderPicker;
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
  /**
   * Tells the desktop app that started the server the language the chat in its window shows (its tray
   * menu, menu bar and dialogs follow it); none for `npm start` and `npm run dev`.
   */
  desktopLang?: (lang: Lang) => void;
  /** Accounts per CLI, team size and the turn timeout, from the environment (`config.ts`; others in tests). */
  limits?: ServerLimits;
  /** Puts a problem report's screenshots on GitHub as a secret gist, and deletes it again (`gh`; fakes in tests). */
  screenshotGists?: {
    upload(files: GistUpload[]): Promise<ReportScreenshots>;
    remove(id: string): Promise<void>;
  };
  /** Signs gh in for sharing from the share dialog (`GhLogin`: gh's own device sign-in; fakes in tests). */
  teams?: Pick<TeamsGraph, 'status' | 'install' | 'connect' | 'disconnect' | 'connectPosting' | 'disconnectPosting'>;
  ghLogin?: Pick<GhLogin, 'start' | 'view' | 'cancel'>;
  /** Browsers' push subscriptions and sending to them (`push.ts`); without it, no push notifications. */
  push?: PushService;
  /** Tells subscribed browsers when agents finish or need the user, unless their page is in front (`alerts.ts`). */
  alerts?: AlertWatcher;
  /** Checks what an automation that starts when something happens waits for, on the user's Check now (`scheduler.ts`). */
  scheduler?: Pick<Scheduler, 'check'>;
  /** The hand-overs of the chats' browsers going on (`browser/handover.ts`): the browser tools' own, else none. */
  handovers?: Handovers;
  /** The chats' Cua computers (`computer/session.ts`): the computer tools' own; without it, one that never finds Cua. */
  computer?: ComputerService;
  /** Accounts that sign in with OAuth (`oauth/service.ts`); Settings' own when not given (stand-in providers in tests). */
  oauth?: OAuthService;
  /** The tool library MCP servers' own sign-ins (`oauth/mcp.ts`), with `oauth`'s sign-ins; Settings' own when not given. */
  mcpOAuth?: McpOAuth;
  /**
   * Why Settings → Labs' modes cannot run on this computer (no sandbox for the code, no Node.js), in the
   * request's language, or undefined when they can (a fake in tests: the real one starts a sandbox).
   */
  labsUnavailable?: () => Promise<string | undefined>;
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
    throw new HttpError(413, t().shareFilesTooLarge(megabytesOver(total), shareSize(SHARE_FILES_MAX_BYTES)));
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
/** The SHA-256 (hex) of a webhook's token: all the database keeps of it. */
export function hookHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * What a saved automation keeps of what it waits for when it is saved again: each trigger's, all of
 * it, while it stays (the same source, by its key: its conditions may change) and the automation stays
 * on; nothing of a trigger removed or whose source changed (a new one starts afresh), nor of any when
 * it is turned on again, so that what came while it was off does not start it.
 */
function keptWatches(prev: ConversationSchedule | undefined, update: ScheduleUpdate): Pick<ConversationSchedule, 'watches'> {
  if (!prev?.watches || prev.repeat.kind !== 'event' || update.repeat.kind !== 'event') return {};
  if (!prev.enabled && update.enabled) return {};
  const watches = update.repeat.triggers.flatMap((t) => watchOf(prev, t) ?? []);
  return watches.length ? { watches } : {};
}

/** A request's body as text, or undefined once it is longer than `max` bytes (reading stops there). */
async function readLimited(req: Request, max: number): Promise<string | undefined> {
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Two hashes compared in constant time. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the user changed on a proposed fixed command's card before saving it (checked again by the orchestrator). */
function proposalEdits(value: unknown): Partial<CommandProposal> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const words = (x: unknown) => (Array.isArray(x) ? x.filter((w): w is string => typeof w === 'string') : undefined);
  return {
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(typeof v.run === 'string' ? { run: v.run } : {}),
    ...(words(v.hosts) ? { hosts: words(v.hosts) } : {}),
    ...(words(v.secrets) ? { secrets: words(v.secrets) } : {}),
    ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}),
    ...(typeof v.publishes === 'boolean' ? { publishes: v.publishes } : {}),
  };
}

export function createApp({
  auth,
  store,
  settings,
  hub,
  orchestrator,
  providers,
  voice = new VoiceService(settings),
  clis = new CliInstaller(settings, { changed: (p) => providers.invalidate(p), busy: () => orchestrator.anyRunning() }),
  sandboxSetup = new SandboxSetup({ changed: () => providers.invalidate() }),
  gitInstall = new GitInstall(sandboxSetup.linux, {}, clis),
  appDependencies = commonAppDependencies(sandboxSetup.linux, () => Boolean(settings.tools.browserStatus().using), clis),
  native = new NativeSetupService(settings),
  agentsView,
  extraHosts = [],
  desktopApp = false,
  phoneAddress,
  version = relayVersion,
  folderPicker = systemFolderPicker(),
  gists = {
    create: (html, description, files, onFilesGist) => shareToGist(html, description, undefined, files, { onFilesGist }),
    remove: unshareGist,
  },
  screenshotGists = { upload: (files) => uploadScreenshots(files), remove: unshareGist },
  ghLogin = new GhLogin(),
  teams = new TeamsGraph(),
  updates = new Updates(undefined, version),
  desktopLang,
  limits = limitsOf(CONFIG),
  push,
  alerts,
  scheduler,
  oauth = settings.oauth,
  mcpOAuth = settings.mcpOAuth,
  previews = new AppPreviews('test'),
  handovers = new Handovers(),
  computer = new ComputerService({
    run: () => Promise.reject(new Error('Cua is not installed')),
    available: () => false,
    startMcp: () => Promise.reject(new Error('Cua is not installed')),
    dataDir: DATA_DIR,
    handovers,
    folderOf: (id) => store.cwdOf(id),
  }),
  publisher = new AppPublisher(settings.publish, { owner: 'test' }),
  labsUnavailable = async () => {
    if (process.platform === 'win32') return t().labsWindows;
    if (!gatewayNode()) return t().labsNoNode;
    const sandbox = await sandboxAvailable();
    return sandbox.ok ? undefined : sandbox.reason;
  },
}: AppDeps): Hono {
  const app = new Hono();
  // Cua installed from Settings: the desktop image its computers are made from is downloaded next.
  appDependencies.onInstalled('cua', () => computer.startImage());
  const hostedApps = new HostedAppChecks(settings);
  const availableDraftApps = draftAvailability(settings, oauth, providers, teams, hostedApps);
  /** The gists of report screenshots uploaded since the server started: only these can be deleted here. */
  const screenshots = new Set<string>();
  /**
   * The files gists of the shares being made: recorded as unfinished as soon as they exist, but not
   * listed, nor removed, until their share is done (after a restart, one left so is listed).
   */
  const making = new Set<string>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.paths ? { paths: err.paths } : {}) },
        err.status,
      );
    }
    console.error('[server]', err);
    return c.json({ error: err.message || 'Internal error' }, 500);
  });

  // This server launches coding agents that can edit files, so only the local UI may talk to it:
  // block DNS-rebinding (Host) and cross-site requests (Origin / non-JSON simple POSTs).
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  const hostAllowed = (h: string) => LOCAL_HOST.test(h) || extraHosts.includes(h.replace(/:\d+$/, ''));

  // Preview hostnames serve only the selected app, even when its paths start with /api.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (isPreviewHost(host, CONFIG.previewDomain)) {
      const peer = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket.remoteAddress;
      const local =
        (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') &&
        !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some((header) => c.req.header(header) !== undefined);
      return previews.fetch(c.req.raw, host, local);
    }
    await next();
  });

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
      // A schedule's webhook takes its own token instead (checked by its route), for programs, not browsers.
      if (auth && !OPEN.has(`${c.req.method} ${c.req.path}`) && !(c.req.method === 'POST' && HOOK_PATH.test(c.req.path))) {
        const session = auth.check(getCookie(c, SESSION_COOKIE), requestKey(c));
        if (!session) return c.json({ error: desktopApp ? t().signedOutDesktop : t().signedOut, code: SIGNED_OUT }, 401);
        sessions.set(c.req.raw, session);
      }
      await next();
    });
  });

  /**
   * What a request takes without a signed-in browser: asking whether it is one, signing in, and the page
   * an OAuth provider sent the browser back to posting what it got (its state is the proof: the
   * redirect brings no key, and in the desktop app it comes to the system browser, never signed in).
   */
  const OPEN = new Set(['GET /api/auth', 'POST /api/auth/login', 'POST /api/oauth/callback']);
  /** The OAuth callbacks that named no sign-in lately: after too many, those that name none are refused a while. */
  const callbackMisses: number[] = [];
  /** A schedule's webhook (`POST /api/hooks/:id`): its route checks the token it was given. */
  const HOOK_PATH = /^\/api\/hooks\/[^/]+$/;
  /** When each webhook was last called, by conversation: at most one call per `TRACKING_LIMITS.hookIntervalMs`. */
  const hookCalls = new Map<string, number>();
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

  const deviceLabel = (c: Context) => browserLabel(c.req.header('user-agent'), c.req.header('X-Relay-iPad') === '1');
  app.get('/api/auth', (c) => {
    const session = auth?.check(getCookie(c, SESSION_COOKIE), c.req.header(AUTH_KEY_HEADER));
    if (session && c.req.header('X-Relay-iPad') === '1') {
      const label = deviceLabel(c);
      if (mobileBrowserLabel(label)) auth?.noteIpad(session, label);
    }
    return c.json({ signedIn: !auth || Boolean(session), ...(desktopApp ? { desktop: true } : {}) });
  });

  app.post('/api/auth/login', async (c) => {
    if (!auth) throw new HttpError(404, 'Signing in is off');
    const { code } = await body<{ code?: unknown }>(c);
    // Counted after the body is read, right before the code is tried (both synchronous): requests
    // that hold their bodies back cannot all get past the limit together.
    if (auth.tooManyFailures()) throw new HttpError(429, t().signInTooMany);
    // A browser signed in already (a sign-in link opened in it again): its new session replaces that one.
    const previous = auth.check(getCookie(c, SESSION_COOKIE), null);
    const signedIn = typeof code === 'string' ? auth.redeem(code, deviceLabel(c)) : undefined;
    if (!signedIn) throw new HttpError(400, t().signInWrongCode);
    if (previous) auth.revoke(previous);
    // HttpOnly: no page script reads it. Strict: no other site's request carries it.
    setCookie(c, SESSION_COOKIE, signedIn.cookie, { path: '/api', httpOnly: true, sameSite: 'Strict', maxAge: SESSION_MAX_AGE_S });
    return c.json({ key: signedIn.key });
  });

  /** A code for another device (a phone), from a browser that is signed in. */
  app.post('/api/auth/codes', async (c) => {
    if (!auth) throw new HttpError(404, 'Signing in is off');
    const url = await phoneAddress?.();
    const origin =
      url && /^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d{1,5})?$/i.test(url) && hostAllowed(url.slice('https://'.length)) ? url : undefined;
    return c.json({ ...auth.createCode(CODE_TTL_MS.device), ...(origin ? { phoneUrl: origin } : {}) });
  });

  app.get('/api/auth/sessions', (c) => {
    const browsers = auth?.sessions(sessions.get(c.req.raw)) ?? [];
    for (const browser of browsers) {
      if (mobileBrowserLabel(browser.label)) browser.phone = alerts?.inFront(browser.id) ? 'online' : 'paired';
    }
    return c.json(browsers);
  });

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
  function refuseRelayFolder(s: { permission: string; cwd: string; extraCwds?: readonly string[] }): void {
    const why = relayFolderRefusal(s, agentFolderOptions(settings));
    if (why) throw new HttpError(400, why, RELAY_FOLDER);
  }

  /**
   * The same for settings as sent, before `validateSettings` may create their working directories
   * (`defaults`: the ones they get without a `cwd`).
   */
  function refuseRelayFolderFirst(raw: unknown, defaults: { cwd: string; extraCwds?: readonly string[] }): void {
    const s = (raw ?? {}) as { permission?: unknown; cwd?: unknown; extraCwds?: unknown };
    const given = typeof s.cwd === 'string' && s.cwd.trim() !== '';
    const extra = given ? (Array.isArray(s.extraCwds) ? s.extraCwds : []) : (defaults.extraCwds ?? []);
    refuseRelayFolder({
      permission: String(s.permission ?? ''),
      cwd: expandPath(given ? (s.cwd as string) : defaults.cwd),
      extraCwds: extra.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(expandPath),
    });
  }

  /** The default working directories, as a new conversation gets them. */
  const defaultCwds = () => ({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds });
  /** The default working directories after the first that exist (`~` expanded), as runs give them to the CLIs. */
  const defaultExtraDirs = () =>
    settings.defaultExtraCwds.map(expandPath).filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
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

  app.patch('/api/settings/checks-default', async (c) => {
    const patch = await body<Record<string, unknown>>(c);
    // Merge with the current default so simultaneous saves of hooks and other checks both survive.
    const { fromDefault: _copied, ...list } = validateChecks({ ...settings.checksDefault, ...patch });
    settings.setChecksDefault(hasRules(list) ? list : undefined);
    return c.json(list);
  });

  app.put('/api/settings', async (c) => {
    const b = await body<{
      defaultCwd?: unknown;
      defaultExtraCwds?: unknown;
      createCwd?: unknown;
      lead?: unknown;
      agentHome?: unknown;
      agentsViewUrl?: unknown;
      agentsViewLink?: unknown;
      chatTitles?: unknown;
      checksDefault?: unknown;
    }>(c);
    if (b.chatTitles !== undefined && typeof b.chatTitles !== 'boolean') throw new HttpError(400, t().invalidField('chatTitles'));
    // Validate everything before saving anything; the folders last, since creating them is a side effect.
    const lead = b.lead !== undefined ? validateLead(b.lead) : undefined;
    // The team checks new chats start with: `null`, or a list without rules, for none.
    let checksDefault: CheckList | null | undefined;
    if (b.checksDefault === null) checksDefault = null;
    else if (b.checksDefault !== undefined) {
      const { fromDefault: _copied, ...list } = validateChecks(b.checksDefault);
      checksDefault = hasRules(list) ? list : null;
    }
    const viewUrl = b.agentsViewUrl !== undefined ? validAgentsViewUrl(b.agentsViewUrl) : undefined;
    const viewLink = b.agentsViewLink !== undefined ? validAgentsViewLink(b.agentsViewLink) : undefined;
    // The default working directories: `defaultCwd`, then the others (none when not given with it).
    const cwds =
      b.defaultCwd !== undefined ? validDirectories(b.defaultCwd, b.defaultExtraCwds, b.createCwd === true, 'defaultCwd') : undefined;
    // Not inside Harness Relay's folder or a default working directory (the new ones, when they change too).
    const home = b.agentHome !== undefined ? validAgentHome(b.agentHome, [process.cwd(), ...cwdsOf(cwds ?? defaultCwds())]) : undefined;
    // A turn that starts in the new home would find its CLI signed out, and its session elsewhere.
    if (home !== undefined && home !== settings.agentHome && orchestrator.anyRunning()) throw new HttpError(409, t().agentHomeBusy);
    // Created only now that nothing refuses the request.
    if (home) ensureFolder(home);
    if (cwds !== undefined) settings.setDefaultCwd(cwds.cwd, cwds.extraCwds);
    if (lead !== undefined) settings.setLead(lead);
    if (viewUrl !== undefined) settings.setAgentsViewUrl(viewUrl);
    if (viewLink !== undefined) settings.setAgentsViewLink(viewLink);
    if (checksDefault !== undefined) settings.setChecksDefault(checksDefault ?? undefined);
    if (typeof b.chatTitles === 'boolean') settings.setChatTitles(b.chatTitles);
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

  // --- Labs: experimental ways agents use Harness Relay's own tools (runCode.ts) --------------------

  /** Settings → Labs as the page shows it: the mode on now, where it comes from, and whether it can run here. */
  const labsView = async (): Promise<LabsView> => {
    const unavailable = await labsUnavailable();
    return { ...settings.labs(), ...(unavailable ? { unavailable } : {}) };
  };
  app.get('/api/labs', async (c) => c.json(await labsView()));
  app.put('/api/labs', async (c) => {
    // Only a model connection set up now (an API backend with its key, or an endpoint), or an account of
    // one of the CLIs it can be asked through.
    const configured = settings.backends.configured();
    settings.setLabs(validLabs(await body<unknown>(c), configured, (p, account) => settings.hasAccount(p, account)));
    return c.json(await labsView());
  });

  app.post('/api/backends/endpoint-models', async (c) => {
    const { baseUrl, endpointId, apiKey } = validateEndpointCatalog(await body<unknown>(c));
    const key = apiKey === undefined ? settings.backends.endpointCatalogKey(endpointId, baseUrl) : apiKey;
    return c.json({ models: await listEndpointModels(baseUrl, key) });
  });

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

  // A saved key stays with its base URL. Changing the base URL clears it unless a replacement is sent.
  app.put('/api/backends/endpoints/:id', async (c) => {
    const id = validEndpointId(c.req.param('id'));
    const endpoint = validateEndpoint(await body<unknown>(c));
    // The context windows the server reports, read from the same answers as the check (none asked for a new name only).
    let reported: Awaited<ReturnType<typeof verifyEndpointModels>> | undefined;
    if (endpoint.verifyModels && !settings.backends.isEndpointRename(id, endpoint)) {
      const revision = settings.backends.endpointRevision(id);
      const key = endpoint.apiKey === undefined ? settings.backends.endpointCatalogKey(id, endpoint.baseUrl) : endpoint.apiKey;
      reported = await verifyEndpointModels(endpoint.baseUrl, key, endpoint.models, endpoint.allowMissingMetadata);
      if (settings.backends.endpointRevision(id) !== revision) throw new HttpError(409, t().endpointVerifyChanged);
    }
    changingBackends(() => settings.backends.putEndpoint(id, endpoint, reported));
    return c.json(settings.backends.view());
  });

  app.delete('/api/backends/endpoints/:id', (c) => {
    const id = validEndpointId(c.req.param('id'));
    changingBackends(() => settings.backends.deleteEndpoint(id));
    return c.json(settings.backends.view());
  });

  // A deleted endpoint's id, forgotten: its models go to their CLI as they are again.
  app.delete('/api/backends/deleted-endpoints/:id', (c) => {
    settings.backends.forgetDeletedEndpoint(validEndpointId(c.req.param('id')));
    return c.json(settings.backends.view());
  });

  // --- Tool library: MCP servers, skills and memory for the agents --------------

  // Mail accounts and calendars for Harness Relay's mail and calendar tools: their passwords go to the
  // credential store and come back masked only.
  app.get('/api/connectors', (c) => c.json(settings.connectors.view()));
  app.put('/api/connectors/mail/:id', async (c) =>
    c.json(settings.connectors.saveMail(validConnectorId(c.req.param('id')), validateMailAccount(await body<unknown>(c)))),
  );
  app.post('/api/connectors/calendar', async (c) =>
    c.json(settings.connectors.addDiscoveredCalendar(validateCalendarAccount(await body<unknown>(c)))),
  );
  app.put('/api/connectors/calendar/:id', async (c) =>
    c.json(settings.connectors.saveCalendar(validConnectorId(c.req.param('id')), validateCalendarAccount(await body<unknown>(c)))),
  );
  app.delete('/api/connectors/:kind/:id', (c) => {
    const kind = c.req.param('kind');
    if (kind !== 'mail' && kind !== 'calendar') throw new HttpError(404, t().connectorNotFound(c.req.param('id')));
    return c.json(settings.connectors.delete(kind, c.req.param('id')));
  });
  // The calendars an account has, from its server's address: their names and own addresses, to pick one.
  app.post('/api/connectors/calendar/discover', async (c) => {
    const b = await body<Record<string, unknown>>(c);
    const v = validateCalendarAccount({ ...b, name: 'x' });
    // The password typed in the form, or the one kept for the account being edited, when the address
    // is its provider's (the kept one never goes to another server).
    const kept = typeof b.id === 'string' ? settings.connectors.calendar(b.id) : undefined;
    const keptFits = kept?.account.id === b.id && kept && keptPasswordFits(kept.account.url, v.url);
    const password = v.password ?? (keptFits ? kept.password : undefined);
    if (!password) throw new HttpError(400, kept && !keptFits ? t().connectorPasswordAgain : t().connectorPasswordRequired);
    try {
      return c.json({ ok: true, calendars: await discoverCalendars(v.url, { username: v.username, password }) });
    } catch (err) {
      // The server's own words (often English) after the request's language's.
      return c.json({ ok: false, error: t().connectorDiscoverFailed((err as Error).message) });
    }
  });

  // Try an account as saved: sign in to its mail server (IMAP, then SMTP's sign-in; with its password or its sign-in's token), or read its calendar.
  app.post('/api/connectors/:kind/:id/test', async (c) => {
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    /** Reached through an account that signs in (its token), not a password. */
    let signedIn = false;
    try {
      if (kind === 'mail') {
        const m = settings.connectors.mail(id);
        if (!m || m.account.id !== id) throw new HttpError(404, t().connectorNotFound(id));
        signedIn = Boolean(m.account.oauth);
        await testMail(m.account, m.password, oauth);
      } else if (kind === 'calendar') {
        const cal = settings.connectors.calendar(id);
        if (!cal || cal.account.id !== id) throw new HttpError(404, t().connectorNotFound(id));
        signedIn = Boolean(cal.account.oauth);
        const now = Date.now();
        await calendarBackend(cal.account, cal.password, oauth).events(now, now + 86_400_000);
      } else throw new HttpError(404, t().connectorNotFound(id));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return c.json({ ok: false, error: t().connectorTestFailed((err as Error).message) });
    }
    return c.json({ ok: true, message: signedIn ? t().connectorTestOkSignedIn : t().connectorTestOk });
  });

  // --- Accounts that sign in with OAuth (Microsoft, Google), for the calendar and mail tools --------
  // The server runs each sign-in; the page starts it and shows how it went. Tokens never leave the
  // server: the page sees an account's address and state only.

  app.get('/api/oauth', (c) => c.json(oauth.view()));
  app.put('/api/oauth/clients/:provider', async (c) =>
    c.json(oauth.saveClient(validOAuthProvider(c.req.param('provider')), validateOAuthClient(await body<unknown>(c)))),
  );
  app.patch('/api/oauth/clients/:provider', async (c) => {
    const provider = validOAuthProvider(c.req.param('provider'));
    const input = await body<{ disabled?: unknown }>(c);
    if (typeof input?.disabled !== 'boolean') throw new HttpError(400, t().invalidField('disabled'));
    return c.json(oauth.setClientDisabled(provider, input.disabled));
  });
  // A sign-in for its uses (the calendar, mail), its provider's page to open, which sends the browser back
  // to this page's own web app when it is on this computer (`origin`), or a code to type on another device (`device`).
  // `account`: an account signing in again, or for another use: its uses are asked for too, and its address is the page's login hint.
  app.post('/api/oauth/signins', async (c) => {
    const b = await body<{ provider?: unknown; uses?: unknown; account?: unknown; origin?: unknown; device?: unknown }>(c);
    const provider = validOAuthProvider(String(b.provider ?? ''));
    const uses = validOAuthUses(b.uses);
    if (b.account !== undefined && (typeof b.account !== 'string' || !b.account || b.account.length > 64))
      throw new HttpError(400, t().invalidField('account'));
    const session = sessions.get(c.req.raw);
    return c.json(
      await oauth.startSignIn({
        provider,
        uses,
        ...(typeof b.account === 'string' ? { account: b.account } : {}),
        ...(session ? { session } : {}),
        ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
        port: servingPort(),
        device: b.device === true,
      }),
    );
  });
  app.get('/api/oauth/signins/:id', (c) => c.json(oauth.signIn(c.req.param('id'), sessions.get(c.req.raw))));
  // The address the provider's page sent the browser to, pasted (a browser on another computer).
  app.post('/api/oauth/signins/:id/address', async (c) => {
    const b = await body<{ address?: unknown }>(c);
    if (typeof b.address !== 'string' || b.address.length > 8000) throw new HttpError(400, t().oauthBadAddress);
    return c.json(await oauth.signIns.pasted(c.req.param('id'), b.address, sessions.get(c.req.raw)));
  });
  app.delete('/api/oauth/signins/:id', (c) => {
    oauth.signIns.cancel(c.req.param('id'), sessions.get(c.req.raw));
    return c.json({ ok: true });
  });
  // The user confirmed a sign-in whose page or token endpoint is not on its authorization server's own
  // origin (an MCP server's, `confirm`), having been shown where: only now is its page given.
  app.post('/api/oauth/signins/:id/confirm', (c) => c.json(oauth.signIns.confirm(c.req.param('id'), sessions.get(c.req.raw))));
  // The page the provider sent the browser back to (`/oauth/callback`) posts the code and state it got:
  // the state is the proof (OPEN above). It answers how that sign-in went, and whose account it is.
  app.post('/api/oauth/callback', async (c) => {
    const now = Date.now();
    while (callbackMisses.length && callbackMisses[0]! < now - 10 * 60_000) callbackMisses.shift();
    const b = await body<{ state?: unknown; code?: unknown; error?: unknown; iss?: unknown }>(c);
    const field = (v: unknown) => (typeof v === 'string' && v.length <= 4096 ? v : undefined);
    const state = field(b.state);
    // Guessing states is what the limit stops: a state a sign-in here gave always goes through.
    if (callbackMisses.length >= 20 && !oauth.signIns.knows(state)) throw new HttpError(429, t().oauthCallbackTooOften);
    try {
      const code = field(b.code);
      const error = field(b.error);
      // The issuer the redirect named (RFC 9207), even empty: one there that is not the sign-in's is refused.
      const iss = typeof b.iss === 'string' ? (field(b.iss) ?? '') : undefined;
      const v = await oauth.signIns.callback({
        ...(state ? { state } : {}),
        ...(code ? { code } : {}),
        ...(error ? { error } : {}),
        ...(iss !== undefined ? { iss } : {}),
      });
      return c.json({
        status: v.status,
        provider: v.provider,
        ...(v.account ? { email: v.account.email } : {}),
        ...(v.server ? { server: v.server.name } : {}),
        ...(v.error ? { error: v.error } : {}),
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) callbackMisses.push(now);
      throw err;
    }
  });
  // An account's calendars, to add to the calendar tools.
  app.get('/api/oauth/accounts/:id/calendars', async (c) => {
    try {
      return c.json(await oauth.calendars(c.req.param('id')));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, t().connectorDiscoverFailed((err as Error).message));
    }
  });
  app.post('/api/oauth/accounts/:id/calendars', async (c) =>
    c.json(oauth.addCalendar(c.req.param('id'), validateOAuthCalendar(await body<unknown>(c)))),
  );
  // Its mail account, for the mail tools: at its provider's own servers, signed in to with its token.
  app.post('/api/oauth/accounts/:id/mail', (c) => c.json(oauth.addMail(c.req.param('id'))));
  app.delete('/api/oauth/accounts/:id/drive', (c) => c.json(oauth.removeDrive(c.req.param('id'))));
  // Removes the account, its tokens (Google's revoked), its calendars and mail accounts; Microsoft's pages to take the app's access away come back.
  app.delete('/api/oauth/accounts/:id', async (c) => {
    const removed = await oauth.removeAccount(c.req.param('id'));
    return c.json({ ...oauth.view(), connectors: settings.connectors.view(), ...removed });
  });

  app.get('/api/tools', (c) => c.json(settings.tools.view()));

  app.put('/api/tools', async (c) => c.json(settings.tools.update(validateToolLibraryUpdate(await body<unknown>(c)))));

  // Long-term memory (src/server/memory.ts): every change answers with the whole view, as Settings shows it.
  const memory = orchestrator.memory;
  app.get('/api/memory', (c) => c.json(memory.view()));
  app.put('/api/memory/settings', async (c) => c.json(memory.updateSettings(validateMemorySettings(await body<unknown>(c)))));
  app.post('/api/memory/notes', async (c) => {
    memory.add(validateMemoryNoteCreate(await body<unknown>(c)));
    return c.json(memory.view());
  });
  app.patch('/api/memory/notes/:id', async (c) => {
    memory.edit(c.req.param('id'), validateMemoryNoteUpdate(await body<unknown>(c)));
    return c.json(memory.view());
  });
  app.delete('/api/memory/notes/:id', (c) => {
    memory.remove(c.req.param('id'));
    return c.json(memory.view());
  });
  app.post('/api/memory/tidy', (c) => {
    memory.tidyNow();
    return c.json(memory.view());
  });

  // Read the selected provider account's status. Hosted service credentials are managed by the provider.
  app.post('/api/apps/:app/hosted/:provider', async (c) => {
    const app = c.req.param('app');
    const p = c.req.param('provider');
    if (!Object.hasOwn(HOSTED_APPS, app)) throw new HttpError(404, t().invalidField('app'));
    if (p !== 'claude' && p !== 'codex') throw new HttpError(404, t().unknownProvider(p));
    const id = account(c, p);
    const { verify } = await body<{ verify?: unknown }>(c);
    if (verify !== undefined && typeof verify !== 'boolean') throw new HttpError(400, t().invalidField('verify'));
    return c.json({ status: await hostedApps.check(app as keyof typeof HOSTED_APPS, p, id, verify === true) });
  });
  app.get('/api/apps/availability', async (c) => {
    const permission = c.req.query('permission') ?? 'read-only';
    const app = c.req.query('app');
    if (!PERMISSION_ORDER.includes(permission as Permission)) throw new HttpError(400, t().invalidField('permission'));
    if (app !== undefined && app !== 'local' && !DRAFT_APPS.includes(app as DraftApp)) throw new HttpError(400, t().invalidField('app'));
    c.header('Cache-Control', 'no-store');
    return c.json(await availableDraftApps(permission as Permission, app as DraftApp | 'local' | undefined));
  });

  app.post('/api/apps/availability/slack/verify', async (c) => {
    const { permission } = await body<{ permission?: Permission }>(c);
    if (!permission || !PERMISSION_ORDER.includes(permission)) throw new HttpError(400, t().invalidField('permission'));
    return c.json(await availableDraftApps(permission, 'slack', true));
  });

  app.get('/api/apps/slack/posting', (c) => c.json(settings.slackPosting.view()));
  app.put('/api/apps/slack/posting', async (c) => c.json(await settings.slackPosting.connect((await body<{ token?: unknown }>(c))?.token)));
  app.delete('/api/apps/slack/posting', (c) => c.json(settings.slackPosting.disconnect()));

  app.get('/api/apps/teams', async (c) => c.json(await teams.status()));
  app.post('/api/apps/teams/install', async (c) => c.json(await teams.install()));
  app.post('/api/apps/teams/signin', async (c) => c.json(await teams.connect()));
  app.post('/api/apps/teams/posting', async (c) => c.json(await teams.connectPosting()));
  app.delete('/api/apps/teams/posting', async (c) => {
    teams.disconnectPosting();
    return c.json(await teams.status());
  });
  app.delete('/api/apps/teams/signin', async (c) => {
    teams.disconnect();
    return c.json(await teams.status());
  });

  app.post('/api/apps/:app/signin', async (c) => {
    const app = c.req.param('app');
    if (!Object.hasOwn(APP_SERVERS, app)) throw new HttpError(404, t().invalidField('app'));
    const b = await body<{ origin?: unknown }>(c);
    const name = settings.tools.ensureApp(app as keyof typeof APP_SERVERS);
    return c.json(
      await mcpOAuth.startSignIn({
        name,
        session: sessions.get(c.req.raw),
        port: servingPort(),
        origin: typeof b.origin === 'string' ? b.origin : undefined,
      }),
    );
  });

  app.put('/api/apps/obsidian', async (c) => {
    const { path } = await body<{ path?: unknown }>(c);
    if (typeof path !== 'string') throw new HttpError(400, t().appsVault);
    const vault = path ? checkedVault(path, agentFolderOptions(settings)) : '';
    return c.json(settings.tools.setObsidianVault(vault));
  });

  app.post('/api/apps/obsidian', async (c) => {
    const { paths: requested } = await body<{ paths?: unknown }>(c);
    if (!Array.isArray(requested) || !requested.length) throw new HttpError(400, t().appsVault);
    const options = agentFolderOptions(settings);
    const paths = [...new Set(requested)].map((path) => {
      if (typeof path !== 'string' || !path) throw new HttpError(400, t().appsVault);
      return checkedVault(path, options);
    });
    return c.json(settings.tools.addObsidianVaults(paths));
  });
  app.delete('/api/apps/obsidian/:id', (c) => c.json(settings.tools.removeObsidianVault(c.req.param('id'))));

  // Adds a server, or (with `previousName`) replaces or renames one.
  app.put('/api/tools/mcp/:name', async (c) => {
    const { name, update } = validateMcpServer(c.req.param('name'), await body<unknown>(c));
    return c.json(settings.tools.saveServer(name, update));
  });

  app.delete('/api/tools/mcp/:name', (c) => c.json(settings.tools.deleteServer(c.req.param('name'))));

  // An HTTP server's own sign-in (MCP's authorization): discovery, a client registered at its
  // authorization server, then that server's page to open, followed, finished from a pasted address and
  // cancelled as an account's sign-in is (`/api/oauth/signins/:id`, `/api/oauth/callback`). Its tokens
  // never come here: the library says whether it is signed in.
  app.post('/api/tools/mcp/:name/signin', async (c) => {
    const b = await body<{ origin?: unknown }>(c);
    const session = sessions.get(c.req.raw);
    return c.json(
      await mcpOAuth.startSignIn({
        name: c.req.param('name'),
        ...(session ? { session } : {}),
        ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
        port: servingPort(),
      }),
    );
  });
  // Signs it out: its tokens are deleted, and revoked at its authorization server when it has a revocation endpoint.
  app.delete('/api/tools/mcp/:name/signin', async (c) => {
    await mcpOAuth.signOut(c.req.param('name'));
    return c.json(settings.tools.view());
  });

  // The skills under a folder, to pick from before adding them (nothing is saved).
  app.get('/api/tools/skills/scan', (c) => {
    const path = validSkillPath(c.req.query('path'));
    return c.json({ path, skills: settings.tools.scanSkills(path) });
  });

  app.put('/api/settings/providers/:provider', async (c) => {
    const p = provider(c);
    const b = validateProviderUpdate(await body<unknown>(c));
    // An open agent gets no key of the server's environment to pass on (only its run's backend's).
    if (b.passEnv !== undefined && isOpenProvider(p)) throw new HttpError(400, t().passEnvOpenAgent(PROVIDER_LABEL[p]));
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
    if (settings.accountIds(p).length + 1 >= limits.maxAccounts)
      throw new HttpError(409, t().tooManyAccounts(PROVIDER_LABEL[p], limits.maxAccounts));
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
    await providers.logoutIn(p, env, 15_000, keyOnlyAccount(p, id)).catch(() => {});
    if (home)
      await rm(home, { recursive: true, force: true }).catch((err: Error) =>
        console.warn(`[settings] could not delete ${home}: ${err.message}`),
      );
    providers.invalidate(p);
    return c.json(settingsView());
  });

  app.get('/api/providers', async (c) => c.json(await providers.statusAll(c.req.query('refresh') === '1')));

  // How much of an account's plan is used (`?account=<id>`, the default one without), as its CLI
  // reports it: asked without a prompt, in the account's home, and kept for a while (`?refresh=1`
  // asks again). Settings shows it in each account's block.
  app.get('/api/providers/:provider/usage', async (c) => {
    const p = provider(c);
    return c.json(await providers.usage(p, account(c, p), c.req.query('refresh') === '1'));
  });

  // What the server's environment sets that the UI keeps to or shows: accounts per CLI, team size, the
  // turn timeout (`RELAY_MAX_ACCOUNTS`, `RELAY_MAX_TEAM_AGENTS`, `RELAY_TURN_TIMEOUT_MIN`).
  app.get('/api/limits', (c) => c.json(limits));

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

  // The language the chat in the desktop app's window shows, as it opens and when the user picks
  // another: the app's menus and dialogs follow it. Nothing to tell without the app. Only from this
  // computer (the window loads 127.0.0.1): a phone's browser through the tailnet never changes them.
  app.put('/api/desktop/lang', async (c) => {
    const { lang } = await body<{ lang?: unknown }>(c);
    if (!LOCAL_HOST.test(c.req.header('host') ?? '')) throw new HttpError(403, t().desktopLangNotHere);
    if (typeof lang !== 'string' || !(LANGS as string[]).includes(lang)) throw new HttpError(400, t().invalidField('lang'));
    desktopLang?.(lang as Lang);
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
    return c.json(nativeForClient(await native.get(p, cwd, b.refresh === true, id || undefined, defaultExtraDirs())));
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
    const probe = await native.latest(p, validDirectory(settings.defaultCwd), id || undefined, defaultExtraDirs());
    if (!path || !listedFile(probe, path)) throw new HttpError(404, t().nativeFileNotListed);
    return c.json(readPreview(path, path, t().nativeFileNotListed));
  });

  app.get('/api/providers/:provider/login-methods', (c) => c.json(providers.loginMethods(provider(c))));

  // Signing in and out: of the default account, or of the one `?account=<id>` names.
  app.post('/api/providers/:provider/login', async (c) => {
    const p = provider(c);
    const id = account(c, p);
    const b = await body<{ method?: string }>(c);
    await providers.assertNewEnough(p, id);
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

  // --- Installing the CLIs ------------------------------------------------------------

  // How each CLI can be installed here, and what Harness Relay installed of it (with its install under
  // way, or the last one); Settings polls it while one runs.
  app.get('/api/clis', (c) => c.json(clis.views()));

  // Install a CLI in the background into a folder of its own (`cliInstall.ts`); poll GET /api/clis.
  app.post('/api/clis/:provider/install', (c) => c.json(clis.install(provider(c))));

  // Stop the install under way.
  app.delete('/api/clis/:provider/install', (c) => c.json(clis.cancel(provider(c))));

  // Delete what Harness Relay installed of a CLI (only that: never a CLI installed another way).
  app.delete('/api/clis/:provider', async (c) => c.json(await clis.remove(provider(c))));

  // --- What the sandboxes need ---------------------------------------------------------

  // What the agents' OS sandboxes need that is missing here, how each is installed, and the install
  // under way or the last one (`sandboxSetup.ts`); Settings and New chat's dialog poll it while one runs.
  app.get('/api/sandbox-setup', (c) => c.json(sandboxSetup.view()));

  // Install everything missing that can be installed here, in the background (one password prompt at most).
  app.post('/api/sandbox-setup/install', (c) => c.json(sandboxSetup.install()));

  // Stop the install under way.
  app.delete('/api/sandbox-setup/install', (c) => c.json(sandboxSetup.cancel()));

  for (const name of ['github', 'browser', 'cua'] as const) {
    const path = '/api/apps/' + name + '/install';
    app.get(path, (c) => c.json(appDependencies.view(name)));
    app.post(path, (c) => c.json(appDependencies.install(name)));
  }

  app.get('/api/apps/docker/install', async (c) => c.json(await appDependencies.dockerView()));
  app.post('/api/apps/docker/install', async (c) => c.json(await appDependencies.installDocker()));

  app.get('/api/git-install', async (c) => c.json(await gitInstall.view(c.req.query('bash') === '1' ? 'gitBash' : 'git')));
  app.post('/api/git-install', async (c) => c.json(await gitInstall.install(c.req.query('bash') === '1' ? 'gitBash' : 'git')));

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
    const name = String(b.name ?? '')
      .trim()
      .slice(0, 100);
    if (!name) throw new HttpError(400, t().presetNameRequired);
    // A template has no working directories: only the default one is checked, as it always was.
    const s = validateSettings({ ...b.settings, cwd: settings.defaultCwd, extraCwds: [] }, defaultCwds());
    const preset: TeamPreset = {
      // Only ids of user templates can be reused (to update one); never a built-in template's.
      id: typeof b.id === 'string' && /^user-[\w-]{1,80}$/.test(b.id) ? b.id : `user-${randomUUID()}`,
      name,
      description:
        String(b.description ?? '')
          .trim()
          .slice(0, 2000) || undefined,
      agents: validateAgents(b.agents, limits.maxTeamAgents),
      // A template's own list: never marked as Settings' default (`fromDefault`), which it would replace.
      settings: { mode: s.mode, rounds: s.rounds, maxHops: s.maxHops, permission: s.permission, ...ownChecks(s.checks) },
    };
    store.savePreset(preset);
    return c.json(preset);
  });

  // The template editor asks the lead agent to draft its template (the editor's template comes along):
  // the answer is shown in the editor until the user saves it; nothing is saved here. Closing the
  // request (the editor, or Stop) stops the lead agent.
  app.post('/api/presets/draft', async (c) =>
    c.json(await orchestrator.drafts.template(await body<Record<string, unknown>>(c), c.req.raw.signal)),
  );

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

  // The lead agent's suggestions for the sidebar's groups (`request`: what the user wants, if they say),
  // for the user to take or leave; nothing changes here.
  app.post('/api/groups/suggest', async (c) =>
    c.json(await orchestrator.drafts.groups(await body<Record<string, unknown>>(c), c.req.raw.signal)),
  );

  // The suggestions the user took, applied together: new groups, new names, conversations moved (each
  // with its family of branches).
  app.post('/api/groups/reorganize', async (c) => {
    const checked = checkReorganize(
      await body<unknown>(c),
      store.listGroups(),
      (id) => Boolean(store.get(id)),
      () => randomUUID(),
    );
    store.reorganize(checked);
    return c.json({ groups: store.listGroups(), created: checked.create });
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

  // --- Notifications ---------------------------------------------------------------

  /** Whether this server sends push notifications: the key browsers subscribe with, or why not. */
  app.get('/api/push', (c) => c.json(push ? push.status() : { error: t().pushUnavailable('') }));

  /** Keeps this browser's push subscription and which alerts it wants, in the request's language. */
  app.put('/api/push/subscription', async (c) => {
    if (!push) throw new HttpError(503, t().pushUnavailable(''));
    const { subscription, prefs } = validatePushSubscription(await body<unknown>(c));
    let kept: ReturnType<PushService['subscribe']>;
    try {
      kept = push.subscribe(sessions.get(c.req.raw), subscription, prefs, currentLang());
    } catch (err) {
      throw new HttpError(503, (err as Error).message);
    }
    if (kept === 'taken') throw new HttpError(409, t().pushTaken, PUSH_TAKEN);
    if (kept === 'gone') throw new HttpError(409, t().pushGone, PUSH_GONE);
    return c.json({ ok: true });
  });

  /** Removes this browser's push subscription (only its own). */
  app.delete('/api/push/subscription', async (c) => {
    const { endpoint } = await body<{ endpoint?: unknown }>(c);
    if (push && typeof endpoint === 'string') push.unsubscribe(sessions.get(c.req.raw), endpoint);
    return c.json({ ok: true });
  });

  /** Sends this browser a test notification through its push service. */
  app.post('/api/push/test', async (c) => {
    const { endpoint } = await body<{ endpoint?: unknown }>(c);
    const sub = push && typeof endpoint === 'string' ? push.subscription(sessions.get(c.req.raw), endpoint) : undefined;
    if (!push || !sub) throw new HttpError(404, t().pushNotSubscribed);
    if ((await push.push(sub, testPayload(sub), { urgency: 'high', ttl: 60 })) !== 'sent') throw new HttpError(502, t().pushTestFailed);
    return c.json({ ok: true });
  });

  // The inbox (the sidebar's bell): every alert the team gave, kept by the server (`inbox.ts`), the
  // same for every signed-in browser.

  /** Every notification kept, the newest first. */
  app.get('/api/notifications', (c) => c.json(store.notifications()));

  /** How many are unread and where, and the newest one's id: asked with each poll of the conversations. */
  app.get('/api/notifications/summary', (c) => c.json(store.notificationSummary()));

  /** Marks notifications read: `{ ids }`, `{ conversationId }` (its chat was opened) or `{ all: true }`. */
  app.post('/api/notifications/read', async (c) => {
    const read = store.readNotifications(validateInboxRead(await body<unknown>(c)));
    return c.json({ read });
  });

  /** Removes every notification. */
  app.delete('/api/notifications', (c) => {
    store.clearNotifications();
    return c.json({ ok: true });
  });

  /** The page went to the background (or came back): push notifications held for this browser go now. */
  app.post('/api/push/presence', async (c) => {
    const { visible, page } = await body<{ visible?: unknown; page?: unknown }>(c);
    alerts?.seen(sessions.get(c.req.raw), typeof page === 'string' ? page : undefined, visible === true);
    return c.json({ ok: true });
  });

  // --- Conversations ---------------------------------------------------------------

  // `page`: the asking page's own id; `visible=1`: it is in front, and tells this browser itself when
  // agents finish or need the user (no push notification is sent to it meanwhile, `alerts.ts`).
  app.get('/api/conversations', (c) => {
    const page = c.req.query('page');
    const visible = c.req.query('visible') === '1';
    if (page !== undefined || visible) alerts?.seen(sessions.get(c.req.raw), page, visible);
    return c.json(
      store.list(
        (id) => orchestrator.isRunning(id),
        (id) => orchestrator.isWaiting(id),
        (id) => orchestrator.isSorting(id),
      ),
    );
  });

  // Conversations whose title or messages contain every word of `q`.
  app.get('/api/search', (c) => c.json(store.search(c.req.query('q') ?? '')));

  // The working directories the working directory box offers: the default one, then the conversations'
  // own, the most recently used first; only folders that still exist.
  app.get('/api/cwds', async (c) => {
    // As a new conversation reads them (`~` expanded), so they are the folders conversations get by default.
    const defaults = cwdsOf(defaultCwds()).map(expandPath);
    // Each folder once, also when spelled in another case where the filesystem ignores case.
    const seen = new Set<string>();
    const paths = [...defaults, ...store.listCwds()].filter((p) => {
      const key = foldCase(resolve(p));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const isDir = await Promise.all(
      paths.map((p) =>
        stat(p).then(
          (s) => s.isDirectory(),
          () => false,
        ),
      ),
    );
    const dirs = paths.filter((_, i) => isDir[i]).map((path) => (defaults.includes(path) ? { path, default: true as const } : { path }));
    return c.json({ home: homedir(), dirs, ...(canPick(c) ? { pick: true as const } : {}) } satisfies WorkingDirectories);
  });

  /**
   * Whether the folder dialog can be opened for this request: the browser runs on this computer (it
   * asks by a loopback name; through `tailscale serve` it asks by the tailnet's, from a phone, say,
   * which would never see a dialog opened here), and this computer has one.
   */
  const canPick = (c: Context) => LOCAL_HOST.test(c.req.header('host') ?? '') && folderPicker.available();
  /** A folder dialog is open: one at a time, so a second click does not hide a second one behind it. */
  let picking = false;

  // Opens this computer's own folder dialog at `start` (a path in the box, or the nearest folder of it
  // that exists; the default working directory when empty) and answers with the folders chosen (more
  // than one where the dialog lets the user pick several), none when cancelled. The dialog closes
  // when the request does.
  app.post('/api/cwds/pick', async (c) => {
    const { start } = await body<{ start?: unknown }>(c);
    if (!LOCAL_HOST.test(c.req.header('host') ?? '')) throw new HttpError(403, t().pickFolderNotHere);
    if (!folderPicker.available()) throw new HttpError(503, t().pickFolderMissing);
    if (picking) throw new HttpError(409, t().pickFolderBusy);
    const from = typeof start === 'string' && start.trim() ? start : settings.defaultCwd;
    picking = true;
    try {
      const paths = await folderPicker.pick({
        title: t().pickFolderTitle,
        start: existingFolder(expandPath(from)),
        signal: c.req.raw.signal,
      });
      return c.json({ paths } satisfies PickedFolders);
    } catch (err) {
      throw new HttpError(502, t().pickFolderFailed((err as Error).message));
    } finally {
      picking = false;
    }
  });

  // Concurrent deliveries of one request wait for its first response. After a restart the
  // receipt lives with the message (or queue entry), including its original queued result.
  const submitting = new Map<string, { digest: string; done: Promise<unknown> }>();
  async function submitTask<T>(
    scope: string,
    id: unknown,
    payload: unknown,
    perform: (request?: TaskRequest, receipt?: ReturnType<Store['taskReceipt']>) => Promise<T>,
  ): Promise<T> {
    if (id === undefined) return perform();
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, t().invalidField('requestId'));
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const request = { scope, id, digest };
    const key = scope + '/' + id;
    const waiting = submitting.get(key);
    if (waiting) {
      if (waiting.digest !== digest) throw new HttpError(409, t().invalidField('requestId'));
      // The route is part of the key, so these two responses have the same type.
      return (await waiting.done) as T;
    }
    const receipt = store.taskReceipt(request);
    if (receipt && receipt.digest !== digest) {
      throw new HttpError(409, t().invalidField('requestId'));
    }
    const done = perform(request, receipt);
    submitting.set(key, { digest, done });
    try {
      return await done;
    } finally {
      submitting.delete(key);
    }
  }

  /** Save a new conversation and set up its working directory; one that cannot be set up is not kept. */
  async function newConversation(
    conv: Conversation,
    first?: { text: string; attachments?: AttachmentUpload[] },
    request?: TaskRequest,
    resume = false,
  ): Promise<void> {
    if (!resume) store.create(conv, request);
    // Agents that may write need a git repository; set it up now so problems surface immediately.
    try {
      // Sending the first question prepares the same workspace as opening an empty chat.
      if (first) await orchestrator.send(conv.id, first.text, first.attachments, false, request);
      else {
        await orchestrator.prepareWorkspace(conv);
        if (request) store.recordTask(request, conv.id, false);
      }
    } catch (err) {
      if (!resume && (!request || store.taskReceipt(request)?.queued == null)) store.delete(conv.id);
      throw err;
    }
  }

  app.post('/api/conversations', async (c) => {
    const { requestId, ...b } = await body<
      Partial<Conversation> & { requestId?: unknown; createCwd?: unknown; firstMessage?: unknown; attachments?: AttachmentUpload[] }
    >(c);
    if (b.firstMessage !== undefined && typeof b.firstMessage !== 'string') throw new HttpError(400, t().invalidField('firstMessage'));
    const firstMessage = b.firstMessage?.trim();
    if (b.attachments !== undefined && (!Array.isArray(b.attachments) || (b.attachments.length && !firstMessage))) {
      throw new HttpError(400, t().invalidField('attachments'));
    }
    const first = firstMessage ? { text: firstMessage, attachments: b.attachments } : undefined;
    const created = await submitTask('new', requestId, { ...b, createCwd: undefined }, async (request, receipt) => {
      if (receipt) {
        const previous = getConv(receipt.conversationId);
        if (receipt.queued === null) await newConversation(previous, first, request, true);
        return previous;
      }
      const now = Date.now();
      // Auto team: the lead agent designs the team for each question, starting with the first.
      // The agents first: creating a missing working directory is a side effect.
      const agents = b.settings?.autoTeam === true ? [] : validateAgents(b.agents, limits.maxTeamAgents);
      refuseRelayFolderFirst(b.settings, defaultCwds());
      const s = validateSettings(b.settings, defaultCwds(), b.createCwd === true);
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
      await newConversation(conv, first, request);
      return conv;
    });
    return c.json(forClient(created));
  });

  function scheduleFileChanges(input: unknown) {
    const { attachments, removeAttachments = [] } = input as { attachments?: unknown; removeAttachments?: unknown };
    const add = decodeAttachments(attachments);
    // Each run writes its folders out later: a name this disk refuses is said now.
    checkFolderNames(add);
    if (!Array.isArray(removeAttachments) || !removeAttachments.every((id): id is string => typeof id === 'string')) {
      throw new HttpError(400, t().invalidField('removeAttachments'));
    }
    return { add, remove: removeAttachments };
  }

  // The schedule form asks the lead agent to draft the schedule (the form's schedule and the browser's
  // time zone come along): shown in the form until the user saves it.
  app.post('/api/schedules/draft', async (c) =>
    c.json(await orchestrator.drafts.schedule(await body<Record<string, unknown>>(c), c.req.raw.signal)),
  );

  // A new schedule (New schedule in the sidebar): a conversation for it, with auto team, whose lead
  // agent designs the team for the schedule's message now. Nothing runs until the schedule sends it;
  // until the team is confirmed, a time that comes due is skipped.
  app.post('/api/schedules', async (c) => {
    const b = await body<{ title?: unknown; settings?: Record<string, unknown>; createCwd?: unknown; schedule?: unknown; hook?: unknown }>(
      c,
    );
    const now = Date.now();
    // The schedule first: creating a missing working directory is a side effect.
    const update = validateSchedule(b.schedule, now);
    // A new chat has no fixed command of its own yet, and its lead agent designs a team for the message.
    if (update.command) throw new HttpError(400, t().invalidField('command'));
    const files = scheduleFileChanges(b.schedule);
    // A new automation names an account that is there, on or off.
    refuseMissingTrigger(update, true);
    refuseRelayFolderFirst(b.settings, defaultCwds());
    const s = validateSettings({ ...(b.settings ?? {}), autoTeam: true }, defaultCwds(), b.createCwd === true);
    const conv: Conversation = {
      id: randomUUID(),
      title:
        String(b.title ?? '')
          .trim()
          .slice(0, 200) ||
        titleFrom(update.text) ||
        t().defaultTitle,
      createdAt: now,
      updatedAt: now,
      agents: [],
      settings: s,
      messages: [],
      agentState: {},
      worktrees: {},
    };
    refuseForeignCommand(conv, update);
    const schedule: ConversationSchedule = { ...update, lang: currentLang(), updatedAt: now };
    const next = update.enabled ? nextRun(schedule, now) : undefined;
    if (next !== undefined) schedule.nextRunAt = next;
    await newConversation(conv);
    try {
      store.setSchedule(conv, schedule, files.add, files.remove);
      orchestrator.systemNote(conv, t().scheduleCreatedNote);
      await orchestrator.designForSchedule(conv.id);
    } catch (err) {
      await orchestrator.deleteConversation(conv.id);
      throw err;
    }
    // Sorted into the user's sidebar groups by its message, as a new chat is by its first question, and
    // named after it when the user gave it no title.
    orchestrator.sortIntoGroup(conv, update.text, !String(b.title ?? '').trim());
    // Its webhook too, when asked for (New automation's "Create a webhook too"): the token goes back this once.
    const newHook = b.hook === true ? makeHook(conv) : undefined;
    return c.json({ ...forClient(conv), ...(newHook ? { newHook } : {}) });
  });

  app.get('/api/conversations/:id', (c) => c.json(forClient(getConv(c.req.param('id')))));

  app.patch('/api/conversations/:id', async (c) => {
    const conv = getConv(c.req.param('id'));
    // Lead review may be switched (on the team design card) while this request is read and its
    // workspace prepared: that switch came after this request, so it stands.
    const reviewBefore = Boolean(conv.settings.leadReview);
    // So may steering (its own request, while the team replies): that switch stands too.
    const steerBefore = Boolean(conv.settings.steer);
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
      const agents = b.agents ? validateAgents(b.agents, limits.maxTeamAgents) : conv.agents;
      // After the agents: creating a missing working directory is a side effect.
      if (b.settings) refuseRelayFolderFirst(b.settings, conv.settings);
      const next = b.settings ? validateSettings(b.settings, conv.settings, b.createCwd === true) : { ...conv.settings };
      refuseRelayFolder(next);
      // Edits never switch auto team on or off; a team set by hand replaces the lead agent's pending
      // design (the next question is designed again).
      if (conv.settings.autoTeam) next.autoTeam = true;
      else delete next.autoTeam;
      if (b.settings) await orchestrator.prepareWorkspace({ ...conv, settings: next });
      if (Boolean(conv.settings.leadReview) !== reviewBefore) {
        if (conv.settings.leadReview) next.leadReview = true;
        else delete next.leadReview;
      }
      if (Boolean(conv.settings.steer) !== steerBefore) {
        if (conv.settings.steer) next.steer = true;
        else delete next.steer;
      }
      conv.agents = agents;
      conv.settings = next;
      confirmed = orchestrator.teamSetByHand(conv, Boolean(b.agents));
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

  // Pin a conversation to the top of the sidebar (`pinned: true`), or unpin it. Pinning one that is
  // pinned already keeps its place among the pinned ones.
  app.put('/api/conversations/:id/pin', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ pinned?: unknown }>(c);
    if (typeof b.pinned !== 'boolean') throw new HttpError(400, t().invalidField('pinned'));
    if (!store.setPinned(conv.id, b.pinned)) throw new HttpError(404, t().conversationNotFound);
    return c.json({ ok: true });
  });

  // Set the conversation's schedule: a message the team is sent at set times (it replaces the one
  // there was). Saving starts its times afresh; what happened last time is kept. `fromProposal`: the
  // reply whose proposed schedule the user opened in the form to save it (its card then says so).
  app.put('/api/conversations/:id/schedule', async (c) => {
    const input = await body<unknown>(c);
    const conv = getConv(c.req.param('id'));
    const from = (input as { fromProposal?: unknown } | null)?.fromProposal;
    if (from !== undefined && (typeof from !== 'string' || !from)) throw new HttpError(400, t().invalidField('fromProposal'));
    if (from) orchestrator.proposalOf(conv.id, from);
    const saved = saveSchedule(conv, input);
    if (from) orchestrator.markProposal(conv.id, from, 'created');
    return c.json(saved);
  });

  // A schedule an agent proposed in a reply (its card): create it as it is, in the browser's time zone,
  // or dismiss it. Either way the card says what became of it.
  app.post('/api/conversations/:id/messages/:messageId/schedule', async (c) => {
    const conv = getConv(c.req.param('id'));
    const messageId = c.req.param('messageId');
    const b = await body<{ action?: unknown; timeZone?: unknown }>(c);
    const proposal = orchestrator.proposalOf(conv.id, messageId);
    if (b.action === 'dismiss') {
      orchestrator.markProposal(conv.id, messageId, 'dismissed');
      return c.json({ ok: true });
    }
    if (b.action !== 'create') throw new HttpError(400, t().invalidField('action'));
    const tz = typeof b.timeZone === 'string' && validTimeZone(b.timeZone.trim()) ? b.timeZone.trim() : serverTimeZone();
    // The fixed command it names: one saved for this chat's working directory, by its name.
    const command = proposal.command ? settings.handoffs.commandByName(orchestrator.handoffFolder(conv), proposal.command) : undefined;
    if (proposal.command && !command) throw new HttpError(409, t().handoffs.proposalCommandMissing(proposal.command));
    const saved = saveSchedule(conv, proposalUpdate(proposal, tz, command?.id));
    orchestrator.markProposal(conv.id, messageId, 'created');
    return c.json(saved);
  });

  /**
   * Saves `input` as the conversation's schedule, checked as the schedule form's is (it replaces the one
   * there was), and answers it as the browser sees it.
   */
  const saveSchedule = (conv: Conversation, input: unknown) => {
    const now = Date.now();
    const update = validateSchedule(input, now);
    const files = scheduleFileChanges(input);
    refuseMissingTrigger(update);
    refuseForeignCommand(conv, update);
    // Scheduled messages go to the current team: there must be one, and not one waiting for confirmation
    // (one that only runs its fixed command never goes to the team).
    if (update.enabled && !update.commandOnly && (conv.agents.length === 0 || pendingPlan(conv.messages))) {
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
      ...(prev?.hook ? { hook: prev.hook } : {}),
      ...keptWatches(prev, update),
    };
    // The same goal keeps what the agents said of it (and a run still in flight); a reached goal is worked on
    // again once the schedule is on. A new goal starts afresh, and none drops the notes.
    if (update.goal) {
      const kept = prev?.goal === update.goal ? prev.tracking : undefined;
      const { retry: _retry, inFlight, ...tracking } = kept ?? freshTracking();
      // A run still going stays the schedule's to try again while the schedule stays on.
      schedule.tracking = {
        ...tracking,
        ...(update.enabled && tracking.status === 'done' ? { status: 'working' as const } : {}),
        ...(inFlight && update.enabled ? { inFlight } : {}),
      };
    }
    const next = update.enabled ? nextRun(schedule, now) : undefined;
    if (next !== undefined) schedule.nextRunAt = next;
    store.setSchedule(conv, schedule, files.add, files.remove);
    orchestrator.emitConversation(conv);
    return scheduleForClient(schedule);
  };

  /** A schedule's fixed command is one saved for the conversation's own working directory. */
  const refuseForeignCommand = (conv: Conversation, update: ScheduleUpdate) => {
    if (!update.command) return;
    const cmd = settings.handoffs.command(update.command);
    if (!cmd || cmd.folder !== orchestrator.handoffFolder(conv)) throw new HttpError(400, t().handoffs.commandNotFound);
  };

  /**
   * An automation that starts when something happens, when it is on, waits for things that are there:
   * each mail account or calendar from Settings that one of its triggers names.
   */
  const refuseMissingTrigger = (update: ScheduleUpdate, always = false) => {
    // Turned off, it checks nothing: an automation whose account went can still be paused.
    if ((!update.enabled && !always) || update.repeat.kind !== 'event') return;
    for (const trigger of update.repeat.triggers) {
      if (trigger.source === 'mail' && !settings.connectors.mailById(trigger.account)) throw new HttpError(400, t().watchNoAccount);
      if (trigger.source === 'calendar' && !settings.connectors.calendarById(trigger.account))
        throw new HttpError(400, t().watchNoCalendar);
    }
  };

  // Check what the automation waits for now (Check now), as its next check would, even while it is off;
  // answers the schedule as it is then. The first check only records what is there.
  app.post('/api/conversations/:id/schedule/check', async (c) => {
    const conv = getConv(c.req.param('id'));
    if (conv.schedule?.repeat.kind !== 'event') throw new HttpError(409, t().watchNotEvent);
    if (!scheduler) throw new HttpError(503, t().watchNoScheduler);
    await scheduler.check(conv.id, true);
    const s = store.get(conv.id)?.schedule;
    return c.json(s ? scheduleForClient(s) : null);
  });

  // A webhook for the schedule: a new token (replacing the one it had), shown this once; only its hash is kept.
  const makeHook = (conv: Conversation): NewScheduleHook => {
    if (!conv.schedule) throw new HttpError(409, t().hookNeedsSchedule);
    if (conv.schedule.commandOnly) throw new HttpError(409, t().hookCommandOnly);
    const token = randomBytes(32).toString('base64url');
    store.setHook(conv, hookHash(token), Date.now());
    orchestrator.emitConversation(conv);
    // The server's system: the example to call it is written for that computer's shell.
    return {
      token,
      url: `http://127.0.0.1:${servingPort()}/api/hooks/${conv.id}`,
      hook: conv.schedule.hook!,
      platform: process.platform,
    };
  };
  app.post('/api/conversations/:id/schedule/hook', (c) => c.json(makeHook(getConv(c.req.param('id')))));

  app.delete('/api/conversations/:id/schedule/hook', (c) => {
    const conv = getConv(c.req.param('id'));
    if (conv.schedule?.hook) {
      store.setHook(conv, undefined, Date.now());
      orchestrator.emitConversation(conv);
    }
    return c.json({ ok: true });
  });

  // A program on this computer calls the schedule's webhook: the schedule's message goes now, with the JSON
  // body it posted in an <event> block. Its token stands in for a browser's sign-in; a wrong one, or none,
  // is the same 404 as a conversation that does not exist.
  app.post('/api/hooks/:id', async (c) => {
    const id = c.req.param('id');
    const given = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const stored = store.hookHash(id);
    if (!given || !stored || !sameHash(hookHash(given), stored)) throw new HttpError(404, t().hookNotFound);
    const conv = getConv(id);
    if (!conv.schedule) throw new HttpError(404, t().hookNotFound);
    // One that only runs its fixed command never takes a webhook's call: its body would reach no one, and a
    // program on this computer could run a command that posts, even while the automation is paused.
    if (conv.schedule.commandOnly) throw new HttpError(409, t().hookCommandOnly);
    // Refused before it is read when it says it is larger, and read no further than the limit when it does not say.
    const tooLarge = () => new HttpError(413, t().hookBodyTooLarge(TRACKING_LIMITS.eventBytes / 1000));
    if (Number(c.req.header('content-length') ?? 0) > TRACKING_LIMITS.eventBytes) throw tooLarge();
    const raw = await readLimited(c.req.raw, TRACKING_LIMITS.eventBytes);
    if (raw === undefined) throw tooLarge();
    let event: string;
    try {
      // `<` written as JSON's \u003c, the same data: a body cannot close the <event> block it goes in.
      event = (raw.trim() ? JSON.stringify(JSON.parse(raw), null, 2) : '{}').replace(/</g, '\\u003c');
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
    // Pretty-printed it may be longer than it came: cut to the limit, as it is only data.
    if (Buffer.byteLength(event) > TRACKING_LIMITS.eventBytes)
      event = Buffer.from(event).subarray(0, TRACKING_LIMITS.eventBytes).toString('utf8') + '\n…';
    const now = Date.now();
    const last = hookCalls.get(id);
    if (last !== undefined && now - last < TRACKING_LIMITS.hookIntervalMs)
      throw new HttpError(429, t().hookTooOften(TRACKING_LIMITS.hookIntervalMs / 1000));
    if (conv.schedule.goal && conv.schedule.tracking?.status === 'done' && !conv.schedule.enabled)
      throw new HttpError(409, t().hookGoalReached);
    hookCalls.set(id, now);
    const sent = await withLang(conv.schedule.lang, () => orchestrator.sendScheduled(id, now, { event }));
    const s = store.get(id)?.schedule;
    if (s?.hook) {
      s.hook = { ...s.hook, lastAt: now };
      store.saveSchedule(store.get(id)!);
      orchestrator.emitConversation(store.get(id)!);
    }
    if (sent.result === 'busy' || sent.result === 'skipped' || sent.result === 'failed') {
      const reason = sent.reason ?? t().scheduleBusy;
      throw new HttpError(409, reason.charAt(0).toUpperCase() + reason.slice(1));
    }
    const chatId = sent.result === 'sent' ? sent.chatId : undefined;
    return c.json({ ok: true, queued: sent.result === 'queued', ...(chatId ? { chatId } : {}) }, 202);
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
      throw new HttpError(409, reason.charAt(0).toUpperCase() + reason.slice(1), sent.result === 'failed' ? sent.code : undefined);
    }
    const chatId = sent.result === 'sent' ? sent.chatId : undefined;
    // `ran`: its fixed command found nothing new, so nothing was sent; `noted`: run alone, it found
    // something, which a note in the chat says (nothing goes to the team).
    return c.json(
      {
        ok: true,
        queued: sent.result === 'queued',
        ...(sent.result === 'ran' ? { ran: true } : {}),
        ...(sent.result === 'noted' ? { noted: true } : {}),
        ...(chatId ? { chatId } : {}),
      },
      202,
    );
  });

  app.delete('/api/conversations/:id', async (c) => {
    // Stops a run first and waits for it to wind down, so nothing writes to the deleted conversation.
    const id = c.req.param('id');
    await orchestrator.deleteConversation(id);
    await previews.stop(id);
    return c.json({ ok: true });
  });

  // Share the conversation: the web app makes the page (what it shows, without tool calls and
  // thinking); it goes up to GitHub as a secret gist with the user's GitHub CLI, read on Harness Relay's viewer.
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
    if (bytes > SHARE_MAX_BYTES) throw new HttpError(413, t().shareTooLarge(megabytesOver(bytes), shareSize(SHARE_MAX_BYTES)));
    const upTo = typeof b.upTo === 'string' ? b.upTo : undefined;
    // Measured first, and read only when they can all go along; checked again as read (one may have
    // changed since), never more than the limits in all.
    const found = await findShareFiles(
      conv,
      linked.map((n) => refs[n]!),
      upTo,
      (id) => store.get(id),
    );
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

  // Signing gh in for sharing, from the share dialog when gh is not signed in: gh's own device sign-in,
  // whose code and link the dialog shows (as Settings does for the CLIs' sign-ins), on this computer.
  app.post('/api/gh/login', (c) => c.json(ghLogin.start()));
  app.get('/api/apps/github', async (c) => c.json(await githubStatus()));
  app.post('/api/apps/github/signout', async (c) => {
    await githubSignOut((await body<{ login?: unknown }>(c)).login);
    return c.json({ ok: true });
  });
  app.get('/api/gh/login', (c) => c.json(ghLogin.view()));
  app.delete('/api/gh/login', (c) => {
    ghLogin.cancel();
    return c.json({ ok: true });
  });

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
    const { requestId, ...b } = await body<{
      text?: string;
      attachments?: AttachmentUpload[];
      interrupt?: boolean;
      followUp?: string;
      requestId?: unknown;
    }>(c);
    const id = c.req.param('id');
    const { queued } = await submitTask('send/' + id, requestId, b, async (request, receipt) => {
      if (receipt) return { queued: Boolean(receipt.queued) };
      if (b.followUp !== undefined && (typeof b.followUp !== 'string' || !b.followUp)) throw new HttpError(400, t().followUpUnavailable);
      return orchestrator.send(id, String(b.text ?? ''), b.attachments, b.interrupt === true, request, { followUp: b.followUp });
    });
    return c.json({ ok: true, queued }, 202);
  });

  // Take back a message still waiting in the queue; it is returned so the user can edit it.
  app.delete('/api/conversations/:id/queue/:messageId', (c) => c.json(orchestrator.withdraw(c.req.param('id'), c.req.param('messageId'))));

  // A file attached to a user message. Only common image types are shown inline; anything else
  // is a download, so an attached HTML or SVG file can never run in this origin. An attached folder
  // is a ZIP file of it, zipped as it is sent.
  app.get('/api/conversations/:id/attachments/:attachmentId', async (c) => {
    const conv = getConv(c.req.param('id'));
    const id = c.req.param('attachmentId');
    // Messages waiting in the queue show their files too.
    const part = [...conv.messages, ...(conv.queue ?? [])]
      .flatMap((m) => m.parts)
      .find((p): p is AttachmentPart => p.type === 'attachment' && p.id === id);
    if (!part) throw new HttpError(404, t().attachmentNotFound);
    if (isFolderAttachment(part)) {
      let plan: ZipPlan | null;
      try {
        plan = await zipPlan(join(attachmentsDir(conv.id), part.id), safeFileName(part.name));
      } catch {
        throw new HttpError(404, t().attachmentNotFound);
      }
      if (!plan) throw new HttpError(413, t().zipTooBig(FILE_LIMITS.zipItems, FILE_LIMITS.zipBytes / 1024 ** 3));
      return new Response(Readable.toWeb(Readable.from(zipStream(plan.entries))) as ReadableStream, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': contentDisposition('attachment', `${plan.name}.zip`),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          // Agents in edit mode may change what is in it: zipped afresh each time.
          'Cache-Control': 'no-store',
        },
      });
    }
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
    const file =
      msg &&
      resolveMedia(
        c.req.query('path') ?? '',
        mediaRoots(conv, msg, (id) => store.get(id)),
      );
    if (!file) throw new HttpError(404, t().mediaNotFound);
    return sendFile(c, file);
  });

  // A file a reply links to, e.g. [Slides](out/deck.pptx): any file inside the same folders as its
  // media (never in .git), always as a download, so an HTML or SVG file can never run here.
  app.get('/api/conversations/:id/messages/:messageId/download', async (c) => {
    const conv = getConv(c.req.param('id'));
    const msg = conv.messages.find((m) => m.id === c.req.param('messageId'));
    const file =
      msg &&
      resolveDownload(
        c.req.query('path') ?? '',
        mediaRoots(conv, msg, (id) => store.get(id)),
      );
    if (!file) throw new HttpError(404, t().downloadNotFound);
    return sendFile(c, file, true);
  });

  // App previews use the same working directories and reply worktrees as Files and media.
  app.post('/api/conversations/:id/preview/target', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const input = await body<Partial<AppPreviewRequest>>(c);
    return c.json(detectPreviewTarget(getConv(c.req.param('id')), input, (id) => store.get(id), settings));
  });
  // The app a finished turn made, from the files it added or changed (the card, the header's button and the panel opening by itself).
  app.post('/api/conversations/:id/preview/changed', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const input = await body<{ messageId?: unknown }>(c);
    const conv = getConv(c.req.param('id'));
    const lookup = (id: string) => store.get(id);
    try {
      return c.json(changedPreviewTarget(conv, input, lookup, settings));
    } catch (error) {
      // A new app that cannot run yet: why, for the chat to say and to ask its author to fix.
      if (!(error instanceof HttpError) || error.status !== 404 || typeof input.messageId !== 'string') throw error;
      const problem = appProblems(conv, input.messageId, lookup, settings, { added: true }).problems[0];
      if (problem) throw new HttpError(409, t().previewNotReady(problem.shown, problem.reason), PREVIEW_NOT_READY);
      throw error;
    }
  });
  app.post('/api/conversations/:id/preview', async (c) => {
    const parent = previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const address = previewAddress(parent, servingPort(), CONFIG.previewDomain);
    const input = await body<Partial<AppPreviewRequest>>(c);
    const conv = getConv(c.req.param('id'));
    const target = previewTarget(conv, input, (id) => store.get(id), settings);
    if (
      input.expectedFolder !== undefined &&
      (typeof input.expectedFolder !== 'string' ||
        !isAbsolute(input.expectedFolder) ||
        relative(input.expectedFolder, resolve(target.root, target.folder)))
    ) {
      throw new HttpError(409, t().previewFolderChanged);
    }
    const browser = sessions.get(c.req.raw);
    const live = browser && auth ? () => auth.hasSession(browser) : undefined;
    c.header('cache-control', 'no-store');
    return c.json(
      await previews.start(conv.id, target, address, parent.origin, c.req.raw.signal, live, () => Boolean(store.get(conv.id)), browser),
    );
  });
  // A container preview's terminal: what it shows, as SSE, for the browser that started it.
  const PREVIEW_STREAM_QUEUE = 2 * 1024 * 1024;
  app.get('/api/conversations/:id/preview/:previewId/terminal', (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    const previewId = c.req.param('previewId');
    const browser = sessions.get(c.req.raw);
    const terminal = previews.terminal(conv.id, previewId, browser);
    c.header('cache-control', 'no-store');
    return streamSSE(c, async (stream) => {
      let closed = false;
      const queue: PreviewTerminalEvent[] = [];
      let queued = 0;
      let wake: (() => void) | undefined;
      const unsubscribe = terminal.subscribe((event) => {
        // A browser that stops reading (a phone asleep) while the app keeps writing: past this, the
        // stream ends instead of growing, and the browser's next one starts from the replay.
        if (event.type === 'output' && (queued += event.data.length) > PREVIEW_STREAM_QUEUE) {
          queue.length = 0;
          closed = true;
        } else {
          queue.push(event);
          if (event.type === 'closed') closed = true;
        }
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      let ping = Date.now();
      while (!stream.aborted) {
        while (queue.length) {
          const event = queue.shift()!;
          if (event.type === 'output') queued -= event.data.length;
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (Date.now() - ping >= 15_000) {
          ping = Date.now();
          // Still this browser's, still running: that also keeps it from expiring as idle.
          try {
            previews.terminal(conv.id, previewId, browser);
          } catch {
            break;
          }
          await stream.writeSSE({ event: 'ping', data: '' });
        }
      }
      unsubscribe();
    });
  });
  app.post('/api/conversations/:id/preview/:previewId/terminal', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    const b = await body<{ input?: unknown; cols?: unknown; rows?: unknown }>(c);
    const terminal = previews.terminal(conv.id, c.req.param('previewId'), sessions.get(c.req.raw));
    if (b.input !== undefined) {
      if (typeof b.input !== 'string' || b.input.length > 65536) throw new HttpError(400, t().invalidField('input'));
      if (!terminal.input(b.input)) throw new HttpError(409, t().previewDocker.notRunning);
    }
    if (b.cols !== undefined || b.rows !== undefined) {
      const cols = Number(b.cols);
      const rows = Number(b.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000)
        throw new HttpError(400, t().invalidField('cols'));
      await terminal.resize(cols, rows);
    }
    return c.json({ ok: true });
  });
  // A single-use address that opens the preview's page in a tab of its own, for the browser that started it.
  app.post('/api/conversations/:id/preview/:previewId/tab', (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    return c.json({ url: previews.tab(conv.id, c.req.param('previewId'), sessions.get(c.req.raw)) });
  });
  // Runs the main service again: with its own command, or with the command line given.
  app.post('/api/conversations/:id/preview/:previewId/run', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    const b = await body<{ command?: unknown }>(c);
    if (
      b.command !== undefined &&
      (typeof b.command !== 'string' || !b.command.trim() || b.command.length > 4096 || /[\0\r\n]/.test(b.command))
    )
      throw new HttpError(400, t().invalidField('command'));
    const terminal = previews.terminal(conv.id, c.req.param('previewId'), sessions.get(c.req.raw));
    await terminal.run(b.command as string | undefined);
    return c.json({ ok: true });
  });
  app.delete('/api/conversations/:id/preview/:previewId', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    await previews.stop(getConv(c.req.param('id')).id, c.req.param('previewId'));
    return c.json({ ok: true });
  });

  // --- Publishing a previewed app (Render, Neon), only ever on the user's own request ----------------

  const conversationGone = (id: string) => !store.get(id);
  app.get('/api/publish', (c) => c.json(publisher.view(conversationGone)));
  app.put('/api/publish/render', async (c) => {
    await publisher.setRenderKey((await body<{ apiKey?: unknown }>(c))?.apiKey);
    return c.json(publisher.view(conversationGone));
  });
  app.patch('/api/publish/render', async (c) => {
    publisher.updateRender((await body<{ ownerId?: unknown; region?: unknown }>(c)) ?? {});
    return c.json(publisher.view(conversationGone));
  });
  app.delete('/api/publish/render', (c) => {
    publisher.removeRender();
    return c.json(publisher.view(conversationGone));
  });
  app.put('/api/publish/neon', async (c) => {
    await publisher.setNeonKey((await body<{ apiKey?: unknown }>(c))?.apiKey);
    return c.json(publisher.view(conversationGone));
  });
  app.patch('/api/publish/neon', async (c) => {
    publisher.updateNeon((await body<{ orgId?: unknown }>(c)) ?? {});
    return c.json(publisher.view(conversationGone));
  });
  app.delete('/api/publish/neon', (c) => {
    publisher.removeNeon();
    return c.json(publisher.view(conversationGone));
  });
  app.get('/api/publish/apps/:appId', (c) => c.json(publisher.app(c.req.param('appId'), conversationGone)));
  app.delete('/api/publish/apps/:appId', async (c) => {
    await publisher.unpublish(c.req.param('appId'), c.req.query('database') === '1', c.req.query('forget') === '1');
    return c.json({ ok: true });
  });
  // A running preview the browser that started it tried: what publishing it would do, then publishing it.
  app.post('/api/conversations/:id/preview/:previewId/publish/plan', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    const source = await previews.publishSource(conv.id, c.req.param('previewId'), sessions.get(c.req.raw), c.req.raw.signal);
    return c.json(await publisher.plan(source));
  });
  app.post('/api/conversations/:id/preview/:previewId/publish', async (c) => {
    previewParent(c.req.header('host') ?? '', c.req.header('origin'));
    const conv = getConv(c.req.param('id'));
    const request = (await body<Partial<PublishRequest>>(c)) ?? {};
    const source = await previews.publishSource(conv.id, c.req.param('previewId'), sessions.get(c.req.raw), c.req.raw.signal);
    return c.json(await publisher.publish(source, request));
  });

  // --- Browsing the working directory (and agents' worktrees) -------------------

  /** The folder a files request names (`root`: a `FileRoot.id`, `cwd` when absent) and the path inside it. */
  function fileTarget(c: Context): { roots: ReturnType<typeof fileRoots>; root: string; path: string } {
    const roots = fileRoots(getConv(c.req.param('id') ?? ''));
    const root = roots.find((r) => r.id === (c.req.query('root') || 'cwd'));
    if (!root) throw new HttpError(404, t().fileRootNotFound);
    return { roots, root: root.id, path: c.req.query('path') ?? '' };
  }
  const rootPath = (roots: ReturnType<typeof fileRoots>, id: string) => roots.find((r) => r.id === id)!.path;

  app.get('/api/conversations/:id/files', (c) => {
    const { roots, root, path } = fileTarget(c);
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync.native(rootPath(roots, root));
    } catch {
      throw new HttpError(404, t().fileRootNotFound);
    }
    const readOnly = rootReadOnly(
      roots.find((r) => r.id === root)!,
      agentFolderOptions(settings),
    );
    return c.json({
      roots,
      root,
      canonicalRoot,
      ...listFolder(canonicalRoot, path),
      writable: !readOnly,
      ...(readOnly ? { readOnly } : {}),
    });
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

  /** The name a root's ZIP file goes by: an agent's worktree is named after the folder and the agent (the team's, `team`). */
  const zipName = (c: Context, root: string): string | undefined => {
    const conv = getConv(c.req.param('id') ?? '');
    const found = fileRoots(conv).find((r) => r.id === root);
    if (!found?.agentId) return undefined;
    const agent = conv.agents.find((a) => a.id === found.agentId);
    const owner = found.agentId === TEAM_WORKTREE ? 'team' : (agent?.name ?? found.agentId);
    return `${basename(cwdsOf(conv.settings)[found.cwd ?? 0] ?? conv.settings.cwd)}-${owner}`;
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

  // --- Changing files in the working directory (the Files panel) ---------------

  /**
   * The working directory a files write names (`root`: a `FileRoot.id`, `cwd` when absent), checked to
   * take writes (`rootReadOnly`: never an agent's worktree) and that no run may be writing in it now
   * (409 `FOLDER_BUSY`). The caller writes at once, without awaiting anything, so that no run can start
   * writing there between this check and its write.
   */
  function writableRoot(convId: string, rootId: unknown): string {
    if (rootId !== undefined && typeof rootId !== 'string') throw new HttpError(400, t().invalidField('root'));
    const conv = getConv(convId);
    const root = fileRoots(conv).find((r) => r.id === (rootId || 'cwd'));
    if (!root) throw new HttpError(404, t().fileRootNotFound);
    const readOnly = rootReadOnly(root, agentFolderOptions(settings));
    if (readOnly) throw new HttpError(403, readOnly);
    let real: string;
    try {
      real = realpathSync(root.path);
    } catch {
      throw new HttpError(404, t().fileRootNotFound);
    }
    if (orchestrator.writingIn(conv.id, real)) throw new HttpError(409, t().filesEdit.busy, FOLDER_BUSY);
    return root.path;
  }

  /** A write's body may be at most `bytes` (413 before it is read in full); the routes' checks are exact. */
  const writeLimit = (bytes: number) => bodyLimit({ maxSize: bytes, onError: (c) => c.json({ error: t().filesEdit.tooLarge }, 413) });

  // A text file saved over the version the panel loaded (`version`), or made new (`version: null`).
  // JSON escapes can make text up to six times longer (`\u0001`), hence the body's limit.
  app.put('/api/conversations/:id/files/text', writeLimit(FILE_EDIT_LIMITS.maxEditBytes * 6 + 64 * 1024), async (c) => {
    const b = await body<Partial<FileSaveRequest>>(c);
    return c.json(saveText(writableRoot(c.req.param('id'), b.root), b.path, b.text, b.version));
  });

  // A file uploaded into a folder, base64 as attachments are: one a request, a file there replaced only with `replace`.
  app.post('/api/conversations/:id/files/upload', writeLimit(Math.ceil(FILE_EDIT_LIMITS.maxUploadBytes / 3) * 4 + 64 * 1024), async (c) => {
    const b = await body<Partial<FileUploadRequest>>(c);
    return c.json(uploadFile(writableRoot(c.req.param('id'), b.root), b.dir ?? '', b.name, b.data, b.replace === true));
  });

  // A file or a folder (with all it holds) deleted from the working directory; never the root itself.
  app.delete('/api/conversations/:id/files', async (c) => {
    const b = await body<Partial<FileDeleteRequest>>(c);
    const id = c.req.param('id');
    // Checked and held at once (nothing awaited between), then removed without blocking the server.
    return c.json(await deletePath(writableRoot(id, b.root), b.path, (folder) => orchestrator.holdForFiles(id, folder)));
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

  // The user's Send or Discard on something an agent asked to send (the outbox): only this sends it.
  app.post('/api/conversations/:id/outbox/:itemId', async (c) => {
    const { action } = await body<{ action?: unknown }>(c);
    if (action !== 'send' && action !== 'discard') throw new HttpError(400, t().invalidField('action'));
    return c.json(await orchestrator.answerOutbox(c.req.param('id'), c.req.param('itemId'), action));
  });

  // Secrets and fixed commands (docs/architecture.md, "Secrets and fixed commands"). A secrets card's
  // answer: the values go to the credential store for the card's working directory, and never back.
  app.post('/api/conversations/:id/messages/:messageId/secrets/:partId', async (c) => {
    const b = await body<{ values?: unknown; decline?: unknown }>(c);
    const given = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? (b.values as Record<string, unknown>) : {};
    const values = Object.fromEntries(Object.entries(given).filter((e): e is [string, string] => typeof e[1] === 'string'));
    await orchestrator.answerSecrets(
      c.req.param('id'),
      c.req.param('messageId'),
      c.req.param('partId'),
      b.decline === true ? { decline: true } : { values },
    );
    return c.json({ ok: true });
  });

  // A proposed fixed command's card: save it (with the user's edits) or not, or tell the team about it.
  app.post('/api/conversations/:id/messages/:messageId/commands/:partId', async (c) => {
    const b = await body<{ action?: unknown; edits?: unknown; digest?: unknown }>(c);
    const [id, messageId, partId] = [c.req.param('id'), c.req.param('messageId'), c.req.param('partId')];
    if (b.digest !== undefined && (typeof b.digest !== 'string' || !/^[0-9a-f]{32}$/.test(b.digest))) {
      throw new HttpError(400, t().invalidField('digest'));
    }
    switch (b.action) {
      // The code it would run (`code`), whose digest Save sends back: Save pins that code alone.
      case 'code':
        return c.json(await orchestrator.commandCode(id, messageId, partId, proposalEdits(b.edits)));
      case 'save':
        return c.json(
          await orchestrator.saveCommand(
            id,
            messageId,
            partId,
            proposalEdits(b.edits),
            typeof b.digest === 'string' ? b.digest : undefined,
          ),
        );
      case 'dismiss':
        await orchestrator.dismissCommand(id, messageId, partId);
        return c.json({ ok: true });
      case 'continue':
      case 'share':
        await orchestrator.answerCommand(id, messageId, partId, b.action === 'share');
        return c.json({ ok: true });
      default:
        throw new HttpError(400, t().invalidField('action'));
    }
  });

  // An interactive command's card (docs/architecture.md, "Interactive commands"): the user starts it
  // (never an agent, nor an automation's run), types into it, answers its password helper, cancels it,
  // sends its masked output to the team, or does not run it.
  app.post('/api/conversations/:id/messages/:messageId/interactive/:partId', async (c) => {
    const b = await body<{ action?: unknown; workdir?: unknown; seen?: unknown; text?: unknown; hidden?: unknown; askId?: unknown }>(c);
    const [id, messageId, partId] = [c.req.param('id'), c.req.param('messageId'), c.req.param('partId')];
    const text = () => {
      if (typeof b.text !== 'string') throw new HttpError(400, t().invalidField('text'));
      return b.text;
    };
    switch (b.action) {
      case 'start': {
        const seen = Array.isArray(b.seen) ? b.seen.filter((f): f is string => typeof f === 'string') : [];
        return c.json(await orchestrator.startInteractive(id, messageId, partId, { workdir: b.workdir === true, seen }));
      }
      case 'input':
        orchestrator.interactiveInput(id, messageId, partId, text(), b.hidden === true);
        return c.json({ ok: true });
      case 'answer':
        if (typeof b.askId !== 'string') throw new HttpError(400, t().invalidField('askId'));
        orchestrator.interactiveAnswer(id, messageId, partId, b.askId, b.text === undefined ? undefined : text());
        return c.json({ ok: true });
      case 'cancel':
        orchestrator.cancelInteractive(id, messageId, partId);
        return c.json({ ok: true });
      case 'send':
        await orchestrator.sendInteractive(id, messageId, partId);
        return c.json({ ok: true });
      case 'dismiss':
        await orchestrator.dismissInteractive(id, messageId, partId);
        return c.json({ ok: true });
      default:
        throw new HttpError(400, t().invalidField('action'));
    }
  });

  // Try a saved fixed command of this chat's working directory: in the background, its card follows it.
  // `confirm`: the user confirmed trying one whose runs publish, post or send something.
  app.post('/api/conversations/:id/commands/:commandId/try', async (c) => {
    const b = await body<{ extra?: unknown; stdin?: unknown; confirm?: unknown }>(c);
    if (b.extra !== undefined && (typeof b.extra !== 'string' || b.extra.length > HANDOFF_LIMITS.commandLine)) {
      throw new HttpError(400, t().invalidField('extra'));
    }
    // `stdin`: what the user typed for it to read on its standard input, this run only.
    if (b.stdin !== undefined && typeof b.stdin !== 'string') throw new HttpError(400, t().invalidField('stdin'));
    if (typeof b.stdin === 'string' && new TextEncoder().encode(b.stdin).length > HANDOFF_LIMITS.input) {
      throw new HttpError(400, t().handoffs.inputTooLong(HANDOFF_LIMITS.input));
    }
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean') throw new HttpError(400, t().invalidField('confirm'));
    await orchestrator.tryCommand(c.req.param('id'), c.req.param('commandId'), {
      ...(typeof b.extra === 'string' ? { extra: b.extra } : {}),
      ...(typeof b.stdin === 'string' && b.stdin ? { stdin: b.stdin } : {}),
      ...(b.confirm === true ? { confirm: true } : {}),
    });
    return c.json({ ok: true }, 202);
  });

  // Stop a fixed command's run that this chat's card follows (Try it, the outbox, its schedule): its card says it stopped.
  app.post('/api/conversations/:id/commands/:commandId/stop', (c) => {
    orchestrator.stopCommand(c.req.param('id'), c.req.param('commandId'));
    return c.json({ ok: true });
  });

  // Approve what changed in a fixed command's code: `digest`, of the code whose diff the user saw (`GET
  // …/diff`), which is pinned again. Nothing runs: Try it, Send or its schedule does that.
  app.post('/api/conversations/:id/commands/:commandId/approve', async (c) => {
    const b = await body<{ digest?: unknown }>(c);
    if (typeof b.digest !== 'string' || !/^[0-9a-f]{32}$/.test(b.digest)) throw new HttpError(400, t().invalidField('digest'));
    await orchestrator.approveCommand(c.req.param('id'), c.req.param('commandId'), b.digest);
    return c.json({ ok: true });
  });

  // The fixed commands of this chat's working directory (the schedule's form offers them).
  app.get('/api/conversations/:id/commands', (c) =>
    c.json(settings.handoffs.commands(orchestrator.handoffFolder(getConv(c.req.param('id'))))),
  );

  // What changed in a fixed command's code since it was pinned, for its card.
  app.get('/api/conversations/:id/commands/:commandId/diff', async (c) =>
    c.json(await orchestrator.commandDiff(c.req.param('id'), c.req.param('commandId'))),
  );

  // Settings: every working directory's secrets (their names) and fixed commands; never a value.
  app.get('/api/handoffs', (c) => c.json({ storage: settings.handoffs.storage, folders: settings.handoffs.folders() }));

  // Settings: replace or remove one of a working directory's secrets, or remove a fixed command.
  app.put('/api/handoffs/secrets', async (c) => {
    const b = await body<{ folder?: unknown; name?: unknown; value?: unknown }>(c);
    const folder = knownHandoffFolder(b.folder);
    if (typeof b.name !== 'string' || typeof b.value !== 'string') throw new HttpError(400, t().invalidField('value'));
    settings.handoffs.setSecrets(folder, { [b.name]: b.value });
    return c.json({ ok: true });
  });
  app.post('/api/handoffs/secrets/delete', async (c) => {
    const b = await body<{ folder?: unknown; name?: unknown }>(c);
    const folder = knownHandoffFolder(b.folder);
    if (typeof b.name !== 'string') throw new HttpError(400, t().invalidField('name'));
    settings.handoffs.deleteSecret(folder, b.name);
    return c.json({ ok: true });
  });
  app.delete('/api/handoffs/commands/:commandId', async (c) => {
    const id = c.req.param('commandId');
    const { pin } = settings.handoffs.deleteCommand(id);
    await dropPin(id, pin);
    orchestrator.forgetCommand(id);
    // The schedules that ran it first run none now (their message alone), rather than failing at each time;
    // one that ran only it has nothing left to do, and is turned off.
    for (const convId of store.schedulesWithCommand(id)) {
      const conv = store.get(convId);
      if (!conv?.schedule || conv.schedule.command !== id) continue;
      const { command: _gone, commandOnly, nextRunAt: _next, ...rest } = conv.schedule;
      conv.schedule = commandOnly ? { ...rest, enabled: false } : { ...rest, ...(_next !== undefined ? { nextRunAt: _next } : {}) };
      store.saveSchedule(conv);
      orchestrator.emitConversation(conv);
    }
    return c.json({ ok: true });
  });

  /** A folder Settings lists (one that has secrets or fixed commands): no other one is given secrets from there. */
  function knownHandoffFolder(value: unknown): string {
    if (typeof value !== 'string' || !settings.handoffs.folders().some((f) => f.folder === value)) {
      throw new HttpError(404, t().invalidField('folder'));
    }
    return value;
  }

  // A hand-over of the chat's browser (`browser_hand_over`): why the user's answer, watcher or input was not taken.
  const handoverRefused = (why: HandoverRefusal | undefined) => {
    if (why === 'missing') throw new HttpError(404, t().handoverNotFound);
    if (why === 'state') throw new HttpError(409, t().handoverNotNow);
    if (why === 'mode') throw new HttpError(400, t().invalidField('mode'));
  };

  // The user's answer to a hand-over of the chat's browser: start it (in a window on the computer Harness
  // Relay runs on, or as a screencast in the chat), decline it, hand it back, or cancel it; with a note
  // to the agent. Only the first answer of each step counts.
  app.post('/api/conversations/:id/handovers/:handoverId', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ action?: unknown; mode?: unknown; note?: unknown }>(c);
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, HANDOVER_LIMITS.noteMax) : undefined;
    let answer: HandoverAnswer;
    if (b.action === 'start') {
      if (b.mode !== 'window' && b.mode !== 'screencast' && b.mode !== 'computer') throw new HttpError(400, t().invalidField('mode'));
      answer = { action: 'start', mode: b.mode };
    } else if (b.action === 'done' || b.action === 'cancel') answer = { action: b.action, ...(note ? { note } : {}) };
    else throw new HttpError(400, t().invalidField('action'));
    handoverRefused(handovers.answer(conv.id, c.req.param('handoverId'), answer));
    return c.json({ ok: true });
  });

  // A hand-over's screencast, as SSE, for any signed-in browser (read with fetch: its key in the header):
  // the page's frames (the latest one only, for a browser that falls behind), where it is, the windows
  // it opened and the pages refused, and that it ended.
  app.get('/api/conversations/:id/handovers/:handoverId/screen', (c) => {
    const conv = getConv(c.req.param('id'));
    let frame: HandoverScreenEvent | undefined;
    const queue: HandoverScreenEvent[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const watching = handovers.watch(conv.id, c.req.param('handoverId'), (e) => {
      if (e.type === 'frame') frame = e;
      else queue.push(e);
      if (e.type === 'ended') ended = true;
      wake?.();
    });
    if (typeof watching === 'string') handoverRefused(watching);
    const unwatch = watching as () => void;
    c.header('cache-control', 'no-store');
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        unwatch();
        wake?.();
      });
      while (!stream.aborted) {
        while (!stream.aborted && (queue.length || (frame && !ended))) {
          const next = queue.length ? queue.shift()! : frame!;
          if (next === frame) frame = undefined;
          await stream.writeSSE({ data: JSON.stringify(next) });
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (!stream.aborted && !queue.length && !frame && !ended) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unwatch();
    });
  });

  // What the user does in a hand-over's screencast panel (clicks, scrolls, keys, text, an address,
  // Back and Forward, its size), in order: to the page, while they have it.
  app.post('/api/conversations/:id/handovers/:handoverId/input', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ events?: unknown }>(c);
    const events = checkInputs(b.events);
    if (typeof events === 'string') throw new HttpError(400, t().invalidField('events'));
    handoverRefused(await handovers.input(conv.id, c.req.param('handoverId'), events));
    return c.json({ ok: true });
  });

  // --- The chat's computer (a Cua desktop: `computer/session.ts`) ------------------------------

  // Where the chat's computer stands, who has control, what was done on it lately.
  app.get('/api/conversations/:id/computer', (c) => c.json(computer.view(getConv(c.req.param('id')).id)));

  // The user starts it, takes control (the agents' calls wait), hands it back, or turns it off (suspended).
  app.post('/api/conversations/:id/computer', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ action?: unknown; note?: unknown }>(c);
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, HANDOVER_LIMITS.noteMax) : undefined;
    switch (b.action) {
      case 'start':
        try {
          return c.json(computer.turnOn(conv.id));
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      case 'take':
        return c.json(computer.takeControl(conv.id));
      case 'return':
        return c.json(computer.handBack(conv.id, note));
      case 'stop':
        return c.json(await computer.turnOff(conv.id));
      default:
        throw new HttpError(400, t().invalidField('action'));
    }
  });

  // Settings' download of the desktop image computers are made from (and on macOS and Windows Cua's own
  // Linux VM), in the background, so that a computer's first start takes seconds; GET /api/computer says how
  // it goes. It also starts by itself once Settings installed Cua.
  app.post('/api/computer/image', async (c) => {
    computer.startImage();
    return c.json(await computer.settingsView(false, () => store.folders()));
  });

  // The desktop image's download alone, which Settings polls while it runs (the computers are not listed).
  app.get('/api/computer/image', (c) => c.json({ image: computer.imageState() ?? null }));

  // Settings' Cancel of the desktop image's download: it ends cancelled, and can be started again.
  app.delete('/api/computer/image', (c) => {
    computer.cancelImage();
    return c.json({ image: computer.imageState() ?? null });
  });

  // Settings' Remove Cua, in the background: this server's computers, Cua's downloads (unless another
  // sandbox uses them) and Harness Relay's own copy of cua; GET /api/computer says how it goes.
  app.post('/api/computer/remove', async (c) => {
    computer.startRemoval();
    return c.json(await computer.settingsView(false, () => store.folders()));
  });

  // Deletes one of this server's computers by its name (Settings' list), with its disk.
  app.delete('/api/computers/:name', async (c) => {
    if (!(await computer.removeByName(c.req.param('name')))) throw new HttpError(404, t().computer.unknown);
    return c.json({ ok: true });
  });

  // The computer's panel, as SSE for any signed-in browser (read with fetch: its key in the header): its
  // state as it changes, and its screen (the latest frame only, for a browser that falls behind), taken
  // while someone watches.
  app.get('/api/conversations/:id/computer/screen', (c) => {
    const conv = getConv(c.req.param('id'));
    let frame: ComputerScreenEvent | undefined;
    let state: ComputerScreenEvent | undefined;
    let wake: (() => void) | undefined;
    const unwatch = computer.watch(conv.id, (e) => {
      if (e.type === 'frame') frame = e;
      else state = e;
      wake?.();
    });
    c.header('cache-control', 'no-store');
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        unwatch();
        wake?.();
      });
      while (!stream.aborted) {
        while (!stream.aborted && (state || frame)) {
          const next = state ?? frame!;
          if (next === state) state = undefined;
          else frame = undefined;
          await stream.writeSSE({ data: JSON.stringify(next) });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (!stream.aborted && !state && !frame) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unwatch();
    });
  });

  // What the user does in the computer's panel (clicks, drags, scrolling, keys, text), in order, while they
  // have control.
  app.post('/api/conversations/:id/computer/input', async (c) => {
    const conv = getConv(c.req.param('id'));
    const b = await body<{ events?: unknown }>(c);
    const events = checkComputerInputs(b.events);
    if (typeof events === 'string') throw new HttpError(400, t().invalidField('events'));
    if (!(await computer.input(conv.id, events))) throw new HttpError(409, t().computer.notYours);
    return c.json({ ok: true });
  });

  // A link to Cua's own viewer of the computer (smoother video, the clipboard), for a browser on this
  // computer, through Harness Relay's proxy: it takes input only while the user has control.
  app.post('/api/conversations/:id/computer/viewer', async (c) => {
    const conv = getConv(c.req.param('id'));
    return c.json(await computer.viewerLink(conv.id));
  });

  // Settings → Common apps → Computer: Cua as found here, whether its computers can run, and the chats'
  // computers. `?check=1` asks Cua what this computer can run (`cua runtime doctor`: seconds).
  app.get('/api/computer', async (c) => c.json(await computer.settingsView(c.req.query('check') === '1', () => store.folders())));

  // Answer an agent's request to do something its permission does not cover.
  app.post('/api/conversations/:id/approvals/:approvalId', async (c) => {
    const b = await body<ApprovalAnswer>(c);
    orchestrator.answerApproval(c.req.param('id'), c.req.param('approvalId'), b);
    return c.json({ ok: true });
  });

  // A steps card (an agent's <steps> block), while the team waits for the user: tick a step as they go
  // (or untick it), kept for every browser.
  app.put('/api/conversations/:id/messages/:messageId/steps/:index', async (c) => {
    const { done } = await body<{ done?: unknown }>(c);
    if (typeof done !== 'boolean') throw new HttpError(400, t().invalidField('done'));
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) throw new HttpError(400, t().invalidField('index'));
    orchestrator.tickStep(c.req.param('id'), c.req.param('messageId'), index, done);
    return c.json({ ok: true });
  });

  // Answer it: the steps done (by index), the one the user is stuck at, a note. Their answer is posted as
  // their message, and the team goes on as after an answer to a question: the agent that asked first.
  app.post('/api/conversations/:id/messages/:messageId/steps/answer', async (c) => {
    const b = await body<{ done?: unknown; stuckAt?: unknown; note?: unknown }>(c);
    const index = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!Array.isArray(b.done) || !b.done.every(index)) throw new HttpError(400, t().invalidField('done'));
    if (b.stuckAt !== undefined && !index(b.stuckAt)) throw new HttpError(400, t().invalidField('stuckAt'));
    if (b.note !== undefined && typeof b.note !== 'string') throw new HttpError(400, t().invalidField('note'));
    const { queued } = await orchestrator.answerSteps(c.req.param('id'), c.req.param('messageId'), {
      done: [...new Set(b.done as number[])],
      ...(b.stuckAt !== undefined ? { stuckAt: b.stuckAt as number } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
    });
    return c.json({ ok: true, queued }, 202);
  });

  // Let an agent answer again: its reply and everything after it are dropped.
  app.post('/api/conversations/:id/messages/:messageId/retry', async (c) => {
    await orchestrator.retry(c.req.param('id'), c.req.param('messageId'));
    return c.json({ ok: true }, 202);
  });

  // Team checks: the latest result's card. Check it again (a new result after it), go on without it
  // passing (what waits in the queue goes), or ask a member to fix it (a turn of its own).
  // `confirm`: run the commands the run's changes kept from running (it changed what they read).
  app.post('/api/conversations/:id/checks/:messageId/recheck', async (c) => {
    const b = await body<{ confirm?: unknown }>(c);
    return c.json(await orchestrator.recheckChecks(c.req.param('id'), c.req.param('messageId'), { confirm: b.confirm === true }));
  });

  // Run one command of the list being edited on the working directories as they are now, as the
  // checks would with the permission Team settings shows (`permission`), and say how it went (Team
  // settings' "Try it"); nothing is posted.
  app.post('/api/conversations/:id/checks/try', async (c) => {
    const b = await body<{ command?: unknown; permission?: unknown }>(c);
    const [command] = validateChecks({ commands: [b.command] }).commands ?? [];
    if (!command) throw new HttpError(400, t().invalidField('command'));
    if (b.permission !== undefined && !PERMISSION_ORDER.includes(b.permission as Permission))
      throw new HttpError(400, t().invalidField('permission'));
    return c.json(await orchestrator.tryCheckCommand(c.req.param('id'), command, b.permission as Permission | undefined));
  });

  // What team checks' commands can do on this computer: its system, and why Harness Relay's sandbox
  // cannot start here, if it cannot (below full access they then cannot run).
  app.get('/api/checks/environment', async (c) => c.json(await checksEnvironment(orchestrator.checkCommandDeps)));

  // The team checks editor asks the lead agent to draft its rules: for a conversation or a new chat it
  // reads the project first, read-only. Shown in the editor until the user saves it; nothing runs here.
  app.post('/api/checks/draft', async (c) =>
    c.json(await orchestrator.drafts.checks(await body<Record<string, unknown>>(c), c.req.raw.signal)),
  );

  app.post('/api/conversations/:id/checks/:messageId/skip', (c) =>
    c.json(orchestrator.skipChecks(c.req.param('id'), c.req.param('messageId'))),
  );

  app.post('/api/conversations/:id/checks/:messageId/fix', async (c) => {
    const b = await body<{ agentId?: unknown }>(c);
    if (typeof b.agentId !== 'string' || !b.agentId) throw new HttpError(400, t().invalidField('agentId'));
    await orchestrator.fixChecks(c.req.param('id'), c.req.param('messageId'), b.agentId);
    return c.json({ ok: true }, 202);
  });

  // Branch the conversation from an agent's reply: a new conversation with the messages up to and
  // including it, which goes on from there on its own (this one stays as it is). Answers with it.
  app.get('/api/conversations/:id/branch-point', (c) => c.json(orchestrator.branchPoint(c.req.param('id'), c.req.query('messageId'))));
  app.post('/api/conversations/:id/messages/:messageId/branch', async (c) => {
    const kind = c.req.query('kind') ?? 'child';
    if (kind !== 'child' && kind !== 'topic') throw new HttpError(400, t().badBranchKind);
    return c.json(forClient(await orchestrator.branch(c.req.param('id'), c.req.param('messageId'), kind)));
  });

  // Accept the team the lead agent designed for a question (auto team); that team then answers it.
  app.post('/api/conversations/:id/messages/:messageId/confirm-plan', async (c) => {
    orchestrator.confirmPlan(c.req.param('id'), c.req.param('messageId'));
    return c.json({ ok: true });
  });

  // Lead review on or off, at any time (the team design card's box): read when the team has answered.
  app.put('/api/conversations/:id/lead-review', async (c) => {
    const b = await body<{ on?: unknown }>(c);
    if (typeof b.on !== 'boolean') throw new HttpError(400, t().invalidField('on'));
    const conv = orchestrator.setLeadReview(c.req.param('id'), b.on);
    return c.json({ leadReview: Boolean(conv.settings.leadReview) });
  });

  // Steering on or off, at any time (Team settings' box, also while the team replies): read as each message is sent.
  app.put('/api/conversations/:id/steer', async (c) => {
    const b = await body<{ on?: unknown }>(c);
    if (typeof b.on !== 'boolean') throw new HttpError(400, t().invalidField('on'));
    const conv = orchestrator.setSteer(c.req.param('id'), b.on);
    return c.json({ steer: Boolean(conv.settings.steer) });
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

  // Team checks run first, on the folders with the result in them: one that does not pass is not
  // applied (`held`: its card's id), unless `force` (the card's "Apply anyway").
  app.post('/api/conversations/:id/agents/:agentId/apply', async (c) => {
    // No body at all (as before `force`) is an apply with the checks.
    const text = await c.req.text();
    type ApplyBody = { force?: unknown; confirm?: unknown } | null;
    let b: ApplyBody = null;
    if (text.trim()) {
      try {
        b = JSON.parse(text) as ApplyBody;
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    }
    // `confirm`: the result changed what the commands read, and the user had them run all the same.
    const { files, held } = await orchestrator.applyAgentWork(c.req.param('id'), c.req.param('agentId'), {
      force: b?.force === true,
      confirm: b?.confirm === true,
    });
    return c.json({ ok: true, files, ...(held ? { held } : {}) });
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
        commandRunning: orchestrator.commandRunning(conv.id),
        folderHeld: orchestrator.folderHeld(conv.id),
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

/** A list kept as a template's own, without the mark of Settings' default it may have been copied from. */
function ownChecks(list: CheckList | undefined): { checks?: CheckList } {
  if (!list) return {};
  const { fromDefault: _copied, ...own } = list;
  return { checks: own };
}
