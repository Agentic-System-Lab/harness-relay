import type {
  AppPreviewRequest,
  AppPreviewSession,
  PublishedApp,
  PublishPlan,
  PublishRequest,
  PublishSettingsView,
  RenderRegion,
} from '../shared/types';
import type { DraftApp, DraftAppAvailability } from '../shared/apps';
import { AUTH_KEY_HEADER, SIGNED_OUT } from '../shared/auth';
import { CWD_MISSING, DEFAULT_ACCOUNT, GIT_MISSING } from '../shared/types';
import type {
  AboutInfo,
  AppDependency,
  AppDependencyView,
  PreviewDockerView,
  HostedApp,
  HostedProvider,
  HostedAppStatus,
  AccountUsage,
  AlertPrefs,
  ApiBackend,
  ModelBackendsView,
  LabSettings,
  LabsView,
  ModelEndpointUpdate,
  AgentConfig,
  ApprovalAnswer,
  AuthSessionView,
  HandoverAnswer,
  HandoverInput,
  ChatMessage,
  CheckCommand,
  CheckList,
  CheckOutcome,
  Permission,
  Conversation,
  ConversationGroup,
  ConversationSchedule,
  ConversationSettings,
  ConversationSummary,
  FileChange,
  FileListing,
  FilePreview,
  FileSaveRequest,
  FileUploadRequest,
  FileWritten,
  GitInstallView,
  GitRequirement,
  GrokFolderTrust,
  InboxItem,
  InboxReadRequest,
  InboxSummary,
  CliInstallView,
  Lang,
  SandboxSetupView,
  CliLoginView,
  LoginMethod,
  LoginSessionView,
  McpServerUpdate,
  NativeSetup,
  PickedFolders,
  Provider,
  ProviderAccountUpdate,
  ProviderModels,
  ProviderSettingsUpdate,
  ProviderStatus,
  PushStatus,
  PushSubscriptionJson,
  ReportScreenshots,
  OutboxItem,
  CommandProposal,
  FixedCommand,
  FolderHandoffs,
  InteractiveSession,
  CalendarAccountUpdate,
  ConnectorsView,
  OAuthCalendar,
  OAuthClientUpdate,
  OAuthProviderId,
  OAuthSignInView,
  OAuthUse,
  OAuthView,
  MailAccountUpdate,
  NewScheduleHook,
  ScheduleUpdate,
  SearchResult,
  ServerLimits,
  SettingsUpdate,
  SettingsView,
  ShareFileInfo,
  ShareFileRef,
  SharedPage,
  SkillCandidate,
  ReviseTeamRequest,
  TeamPreset,
  TeamRevision,
  ToolLibraryUpdate,
  ToolLibraryView,
  MemoryNoteCreate,
  MemoryNoteUpdate,
  MemorySettings,
  MemoryView,
  UpdateStatus,
  VoiceModelId,
  VoiceSettingsUpdate,
  VoiceStatus,
  WorkingDirectories,
  ZipCheck,
} from '../shared/types';
import { clearKey, readKey, signedOutAnswer, whileSigningIn, writeKey } from './auth';
import { currentLang, currentMessages } from './i18n';
import { timeoutSignal } from './util';

/**
 * How long a sign-in may take before it is given up (it is quick: the server checks a code against
 * the few live ones). Requests answered "signed out" meanwhile wait for it (`signedOutAnswer`), so
 * not for good either.
 */
export const SIGN_IN_TIMEOUT_MS = 30_000;

/** An account in a URL path: its id, or `default` for the default account. */
const accountPath = (account: string) => encodeURIComponent(account || DEFAULT_ACCOUNT);
/** An account as a query: none for the default account. */
const accountQuery = (account: string) => (account ? `?account=${encodeURIComponent(account)}` : '');

export const GIT_INSTALL_EVENT = 'relay:git-install';
export const GIT_AVAILABLE_EVENT = 'relay:git-available';

export function requestGitInstall(requirement: GitRequirement = 'git'): void {
  window.dispatchEvent(new CustomEvent(GIT_INSTALL_EVENT, { detail: requirement }));
}

const gitInstallPath = (requirement: GitRequirement) => `/api/git-install${requirement === 'gitBash' ? '?bash=1' : ''}`;

/** A request the server answered with an error; `status` is the HTTP status, `code` tells some errors apart. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** The paths the error is about (the working directories that do not exist). */
  readonly paths?: string[];
  constructor(message: string, status: number, code?: string, paths?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.paths = paths;
  }
}

/**
 * Runs `call`; if the server says working directories do not exist and `ask()` agrees (it is told
 * which: one to a line), runs it again with `createCwd: true`. Any other error, or a refusal, is thrown.
 */
export async function orCreateCwd<T>(call: (createCwd: boolean) => Promise<T>, ask: (missing: string) => boolean): Promise<T> {
  try {
    return await call(false);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === CWD_MISSING) || !ask((e.paths ?? []).join('\n'))) throw e;
    return call(true);
  }
}

/** Every request names the UI language, so server messages come back in it. `key`: the one it sends. */
function headers(json: boolean, key: string | null): Record<string, string> {
  return {
    'X-Relay-Lang': currentLang(),
    ...(key ? { [AUTH_KEY_HEADER]: key } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** The event the app listens for to show the sign-in page: the server no longer knows this browser. */
export const SIGNED_OUT_EVENT = 'relay:signed-out';

/** How a request is sent: again after an answer "signed out" (`resent`), or as the sign-in itself. */
interface Sending {
  resent?: boolean;
  signIn?: boolean;
  task?: boolean;
  keepalive?: boolean;
}

/**
 * An answer "signed out" to a request sent with `key`, read in full (`signedOutAnswer`): true when the
 * request is to be sent again with a new key. The page is told when this browser is signed out.
 */
async function signedOut(code: string | undefined, key: string | null, o: Sending): Promise<boolean> {
  // The sign-in's own request never waits for itself (and is never answered so).
  if (code !== SIGNED_OUT || o.signIn) return false;
  const answer = await signedOutAnswer(key, o.resent);
  if (answer === 'signed-out') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  return answer === 'resend';
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, o: Sending = {}): Promise<T> {
  const key = readKey();
  const requestHeaders = headers(method !== 'GET', key);
  if ((path === '/api/auth' || path === '/api/auth/login') && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    requestHeaders['X-Relay-iPad'] = '1';
  const res = await fetch(path, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: requestHeaders,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal,
    ...(o.keepalive ? { keepalive: true } : {}),
  });
  const data = await res.json().catch((err: unknown) => {
    if (o.task && res.ok) throw err;
    // Given up (its signal) while the answer was read: not an answer, but the request given up.
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    return {};
  });
  if (!res.ok) {
    const err = data as { error?: string; code?: string; paths?: unknown };
    if (res.status === 401 && (await signedOut(err.code, key, o))) return request<T>(method, path, body, signal, { ...o, resent: true });
    const paths = Array.isArray(err.paths) ? err.paths.filter((p): p is string => typeof p === 'string') : undefined;
    if (err.code === GIT_MISSING) requestGitInstall();
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code, paths);
  }
  return data as T;
}

// An uncertain delivery retains its ID across retries and reloads. Only the digest
// is persisted, so sending attachments does not put their contents in browser storage.
const taskAttempts = new Map<string, string>();
async function postTask<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const serialized = JSON.stringify({ ...body, createCwd: undefined, interrupt: undefined });
  const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = crypto.subtle
    ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
    : serialized;
  const slot = 'relay:task:' + path + ':' + digest;
  let saved = taskAttempts.get(slot);
  try {
    if (!saved && crypto.subtle) saved = sessionStorage.getItem(slot) ?? undefined;
  } catch {
    /* memory only */
  }
  // The original interrupt choice belongs to the attempt: a team may finish before the phone retries.
  const requestId = saved?.slice(0, 32) ?? hex(crypto.getRandomValues(new Uint8Array(16)));
  const interrupt = saved ? saved.endsWith('+') : body.interrupt === true;
  const entry = requestId + (interrupt ? '+' : '-');
  taskAttempts.set(slot, entry);
  try {
    if (crypto.subtle) sessionStorage.setItem(slot, entry);
  } catch {
    /* memory only */
  }
  const forget = () => {
    if (taskAttempts.get(slot) !== entry) return;
    taskAttempts.delete(slot);
    try {
      if (crypto.subtle) sessionStorage.removeItem(slot);
    } catch {
      /* memory only */
    }
  };
  try {
    const payload = { ...body, ...(typeof body.interrupt === 'boolean' ? { interrupt } : {}), requestId };
    const result = await request<T>('POST', path, payload, undefined, { task: true });
    forget();
    return result;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 400 || err.status === 404 || err.status === 409 || err.status === 422) forget();
      throw err;
    }
    throw new Error(currentMessages().chat.deliveryUnknown, { cause: err });
  }
}

async function requestText(path: string, o: Sending = {}): Promise<string> {
  const key = readKey();
  const res = await fetch(path, { headers: headers(false, key) });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const err = JSON.parse(text) as { error?: string; code?: string };
      msg = err.error ?? msg;
      code = err.code;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && (await signedOut(code, key, o))) return requestText(path, { resent: true });
    if (code === GIT_MISSING) requestGitInstall();
    throw new ApiError(msg, res.status, code);
  }
  return text;
}

type ScheduleSubmission = ScheduleUpdate & { attachments?: AttachmentUpload[]; removeAttachments?: string[] };

// Keep this browser's edits in submission order, even when the drawer is closed and reopened during an upload.
const scheduleWrites = new Map<string, Promise<unknown>>();

async function writeSchedule<T>(id: string, send: () => Promise<T>): Promise<T> {
  const previous = scheduleWrites.get(id);
  const next = previous ? previous.then(send, send) : send();
  scheduleWrites.set(id, next);
  try {
    return await next;
  } finally {
    if (scheduleWrites.get(id) === next) scheduleWrites.delete(id);
  }
}

/** A file attached to a message, as sent to the server. */
export interface AttachmentUpload {
  name: string;
  mimeType: string;
  /** Base64 contents. */
  data: string;
}

const fileQuery = (root: string, path: string) => new URLSearchParams({ root, path }).toString();

export const api = {
  // signing in
  /** Whether the server knows this browser (always, when it takes no sign-in). */
  /** Whether this browser is signed in, and whether the desktop app started the server (no terminal then). */
  authStatus: () => request<{ signedIn: boolean; desktop?: boolean }>('GET', '/api/auth'),
  /** Signs this browser in with a one-time code; the server sets its cookie, the key is kept here. */
  signIn: (code: string) =>
    whileSigningIn(
      (async () => {
        const timeout = timeoutSignal(SIGN_IN_TIMEOUT_MS);
        try {
          const { key } = await request<{ key?: unknown }>('POST', '/api/auth/login', { code }, timeout.signal, { signIn: true });
          // No key in the answer: none to keep (it would be the string "undefined").
          if (typeof key !== 'string') throw new Error(currentMessages().signIn.noAnswer);
          writeKey(key);
        } catch (e) {
          // The server's own answer stands, also one that came as the time ran out.
          throw timeout.signal.aborted && !(e instanceof ApiError) ? new Error(currentMessages().signIn.noAnswer) : e;
        } finally {
          timeout.clear();
        }
      })(),
    ),
  /** A one-time code for another device (a phone), from this signed-in browser. */
  newSignInCode: () => request<{ code: string; expiresAt: number; phoneUrl?: string }>('POST', '/api/auth/codes'),
  signedInBrowsers: () => request<AuthSessionView[]>('GET', '/api/auth/sessions'),
  /** Signs a browser out; this one's key goes too when it is this one. */
  signOut: async (id: string, current: boolean) => {
    await request<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`);
    if (current) clearKey();
  },
  // notifications
  /** The notification inbox (the sidebar's bell): every notification kept, the newest first. */
  notifications: () => request<InboxItem[]>('GET', '/api/notifications'),
  /** How many are unread and where, and the newest one's id. */
  notificationSummary: () => request<InboxSummary>('GET', '/api/notifications/summary'),
  /** Marks notifications read: these, those of one conversation, or all. */
  readNotifications: (which: InboxReadRequest) => request<{ read: number }>('POST', '/api/notifications/read', which),
  /** Removes every notification. */
  clearNotifications: () => request<{ ok: true }>('DELETE', '/api/notifications'),
  /** Whether the server sends push notifications: the key to subscribe with, or why not. */
  pushStatus: () => request<PushStatus>('GET', '/api/push'),
  /** Keeps this browser's push subscription and which alerts it wants. */
  pushSubscribe: (subscription: PushSubscriptionJson, prefs: AlertPrefs) =>
    request<{ ok: true }>('PUT', '/api/push/subscription', { subscription, prefs }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('DELETE', '/api/push/subscription', { endpoint }),
  /** Has the server send this browser a test notification through its push service. */
  pushTest: (endpoint: string) => request<{ ok: true }>('POST', '/api/push/test', { endpoint }),
  /**
   * This page (`page`: its id) went to the background: kept alive as the page goes away (a phone
   * locking), so the server sends the push notifications it held for this browser now, unless another
   * page of it is still in front. Never fails.
   */
  presence: (visible: boolean, page: string) =>
    void fetch('/api/push/presence', {
      method: 'POST',
      keepalive: true,
      headers: headers(true, readKey()),
      body: JSON.stringify({ visible, page }),
    }).catch(() => undefined),
  /** The conversation's live updates. EventSource sends no headers, so the key goes in the query. */
  eventsUrl: (id: string) => {
    const key = readKey();
    return `/api/conversations/${id}/events${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  },

  // conversations
  /**
   * `page`: this page's id, and whether it is in front: then it tells the user itself when agents
   * finish or need them, so its browser gets no push notification meanwhile.
   */
  listConversations: (page?: { id: string; inFront: boolean }) =>
    request<ConversationSummary[]>(
      'GET',
      `/api/conversations${page ? `?page=${encodeURIComponent(page.id)}${page.inFront ? '&visible=1' : ''}` : ''}`,
    ),
  getConversation: (id: string) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (b: {
    title?: string;
    firstMessage?: string;
    attachments?: AttachmentUpload[];
    agents: AgentConfig[];
    settings: ConversationSettings;
    createCwd?: boolean;
  }) => postTask<Conversation>('/api/conversations', b),
  updateConversation: (id: string, b: Partial<Pick<Conversation, 'title' | 'agents' | 'settings'>> & { createCwd?: boolean }) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, b),
  deleteConversation: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  /** `groupId: null` puts it in the default group ("Other"). */
  moveToGroup: (id: string, groupId: string | null) => request<{ ok: true }>('PUT', `/api/conversations/${id}/group`, { groupId }),
  /** Pin it to the top of the sidebar, or unpin it. */
  pinConversation: (id: string, pinned: boolean) => request<{ ok: true }>('PUT', `/api/conversations/${id}/pin`, { pinned }),
  /** Set the conversation's schedule (it replaces the one there was). */
  saveSchedule: (id: string, b: ScheduleSubmission) =>
    writeSchedule(id, () => request<ConversationSchedule>('PUT', `/api/conversations/${id}/schedule`, b)),
  deleteSchedule: (id: string) => writeSchedule(id, () => request<{ ok: true }>('DELETE', `/api/conversations/${id}/schedule`)),
  /** A new schedule in a conversation of its own, whose lead agent designs the team for it now. */
  createSchedule: (b: {
    title?: string;
    settings: Partial<ConversationSettings>;
    createCwd?: boolean;
    schedule: ScheduleSubmission;
    hook?: boolean;
  }) => request<Conversation & { newHook?: NewScheduleHook }>('POST', '/api/schedules', b),
  /** Have the lead agent design the team for the schedule's message (again). */
  designSchedule: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/schedule/design`),
  /** Send the schedule's message now; `queued` while the team replies, `chatId` when it opened a new conversation. */
  runSchedule: (id: string) => request<{ ok: true; queued: boolean; chatId?: string }>('POST', `/api/conversations/${id}/schedule/run`),
  /** Check what an automation that starts when something happens waits for, now: the schedule as it is then. */
  checkSchedule: (id: string) => request<ConversationSchedule | null>('POST', `/api/conversations/${id}/schedule/check`, {}),
  /** A webhook for the schedule (a new token replaces the one it had): the token, shown this once, and the address to call. */
  createScheduleHook: (id: string) => request<NewScheduleHook>('POST', `/api/conversations/${id}/schedule/hook`, {}),
  deleteScheduleHook: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}/schedule/hook`),
  /** Conversations whose title or messages contain every word of `q`. */
  search: (q: string) => request<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  /** The working directories to offer: the default one, then the conversations', the most recently used first. */
  cwds: () => request<WorkingDirectories>('GET', '/api/cwds'),
  /** Opens this computer's folder dialog at `start`; resolves when it closes (no `paths`: cancelled). */
  pickCwd: (start: string, signal?: AbortSignal) => request<PickedFolders>('POST', '/api/cwds/pick', { start }, signal),

  // sidebar groups
  listGroups: () => request<ConversationGroup[]>('GET', '/api/groups'),
  createGroup: (name: string) => request<ConversationGroup>('POST', '/api/groups', { name }),
  renameGroup: (id: string, name: string) => request<ConversationGroup>('PATCH', `/api/groups/${id}`, { name }),
  /** Its conversations go to the default group ("Other"). */
  deleteGroup: (id: string) => request<{ ok: true }>('DELETE', `/api/groups/${id}`),
  /** While the team replies the message waits for the next turn (`queued`); `interrupt` stops the team and sends it now. */
  send: (id: string, text: string, attachments: AttachmentUpload[] = [], interrupt = false) =>
    postTask<{ ok: true; queued: boolean }>(`/api/conversations/${id}/messages`, { text, attachments, interrupt }),
  /** Take back a message still waiting to be delivered; returns it. */
  withdraw: (id: string, messageId: string) => request<ChatMessage>('DELETE', `/api/conversations/${id}/queue/${messageId}`),
  attachmentUrl: (convId: string, attachmentId: string) => `/api/conversations/${convId}/attachments/${attachmentId}`,
  /** Serves the images and videos a message embeds; add `?path=`. */
  mediaBase: (convId: string, messageId: string) => `/api/conversations/${convId}/messages/${messageId}/media`,
  /** Downloads the files a message links to; add `?path=`. */
  downloadBase: (convId: string, messageId: string) => `/api/conversations/${convId}/messages/${messageId}/download`,
  resend: (id: string, messageId: string, text: string) =>
    request<{ ok: true }>('PUT', `/api/conversations/${id}/messages/${messageId}`, { text }),
  retry: (id: string, messageId: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/retry`),
  /** A new conversation with the messages up to and including this agent reply; returns it. */
  branch: (id: string, messageId: string) => request<Conversation>('POST', `/api/conversations/${id}/messages/${messageId}/branch`),
  answerApproval: (id: string, approvalId: string, answer: ApprovalAnswer) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/approvals/${approvalId}`, answer),
  /** Opens a browser for the user alone for a secrets card (at the address its ask `name` named): its hand-over id. */
  openSecretsBrowser: (id: string, messageId: string, partId: string, name?: string) =>
    request<{ handoverId: string }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/secrets/${encodeURIComponent(partId)}/browser`,
      name === undefined ? {} : { name },
    ),
  /** Save selection as a secret: the server reads what is selected in that browser and keeps it under `name`. */
  saveSecretSelection: (id: string, messageId: string, partId: string, handoverId: string, name: string) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/secrets/${encodeURIComponent(partId)}/selection`,
      { handoverId, name },
    ),
  /** The user's answer to a hand-over of the chat's browser: start it, decline it, hand it back or cancel it. */
  answerHandover: (id: string, handoverId: string, answer: HandoverAnswer) =>
    request<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/handovers/${encodeURIComponent(handoverId)}`, answer),
  /**
   * A hand-over's screencast, as the server streams it (SSE). Read with fetch, not EventSource, so that
   * the key goes in its header like every other request's.
   */
  handoverScreen: async (id: string, handoverId: string, signal: AbortSignal): Promise<Response> => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/handovers/${encodeURIComponent(handoverId)}/screen`, {
      headers: headers(false, readKey()),
      signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code);
    }
    return res;
  },
  /** What the user did in a hand-over's screencast panel, in order. */
  handoverInput: (id: string, handoverId: string, events: HandoverInput[]) =>
    request<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/handovers/${encodeURIComponent(handoverId)}/input`, {
      events,
    }),
  connectors: () => request<ConnectorsView>('GET', '/api/connectors'),
  saveMailAccount: (id: string, b: MailAccountUpdate) => request<ConnectorsView>('PUT', `/api/connectors/mail/${id}`, b),
  addDiscoveredCalendar: (b: CalendarAccountUpdate) => request<ConnectorsView>('POST', '/api/connectors/calendar', b),
  saveCalendarAccount: (id: string, b: CalendarAccountUpdate) => request<ConnectorsView>('PUT', `/api/connectors/calendar/${id}`, b),
  deleteConnector: (kind: 'mail' | 'calendar', id: string) => request<ConnectorsView>('DELETE', `/api/connectors/${kind}/${id}`),
  testConnector: (kind: 'mail' | 'calendar', id: string) =>
    request<{ ok: boolean; message?: string; error?: string }>('POST', `/api/connectors/${kind}/${id}/test`, {}),
  discoverCalendars: (b: { url: string; username: string; password?: string; id?: string }, signal?: AbortSignal) =>
    request<{ ok: boolean; calendars?: { name: string; url: string }[]; error?: string }>(
      'POST',
      '/api/connectors/calendar/discover',
      b,
      signal,
    ),
  /** Accounts that sign in with OAuth, and the apps they sign in with: never a token. */
  oauth: () => request<OAuthView>('GET', '/api/oauth'),
  setOAuthClientDisabled: (provider: OAuthProviderId, disabled: boolean) =>
    request<OAuthView>('PATCH', `/api/oauth/clients/${provider}`, { disabled }),
  saveOAuthClient: (provider: OAuthProviderId, b: OAuthClientUpdate) => request<OAuthView>('PUT', `/api/oauth/clients/${provider}`, b),
  /** A sign-in for its uses: the provider's page sends the browser back to this page's own origin when it is on this computer. */
  /** `account`: the account signing in again, or for another use (its uses are asked for too, its address is the page's hint). */
  startOAuthSignIn: (provider: OAuthProviderId, uses: OAuthUse[], device = false, account?: string) =>
    request<OAuthSignInView>('POST', '/api/oauth/signins', {
      provider,
      uses,
      origin: location.origin,
      device,
      ...(account ? { account } : {}),
    }),
  oauthSignIn: (id: string) => request<OAuthSignInView>('GET', `/api/oauth/signins/${id}`),
  pasteOAuthAddress: (id: string, address: string) => request<OAuthSignInView>('POST', `/api/oauth/signins/${id}/address`, { address }),
  cancelOAuthSignIn: (id: string) => request<{ ok: true }>('DELETE', `/api/oauth/signins/${id}`),
  /** The user confirmed where a sign-in's page is (`OAuthSignInView.confirm`): the page comes back to open. */
  confirmOAuthSignIn: (id: string) => request<OAuthSignInView>('POST', `/api/oauth/signins/${id}/confirm`, {}),
  /** The page the provider sent the browser back to posts what it got: its state is the proof (no sign-in needed). */
  oauthCallback: (b: { state?: string; code?: string; error?: string; iss?: string }) =>
    request<{ status: OAuthSignInView['status']; provider: OAuthSignInView['provider']; email?: string; server?: string; error?: string }>(
      'POST',
      '/api/oauth/callback',
      b,
    ),
  oauthCalendars: (id: string) => request<OAuthCalendar[]>('GET', `/api/oauth/accounts/${id}/calendars`),
  addOAuthCalendar: (id: string, b: { name: string; url: string }) =>
    request<ConnectorsView>('POST', `/api/oauth/accounts/${id}/calendars`, b),
  /** An account's mail account, for the mail tools (it must have signed in for mail). */
  addOAuthMail: (id: string) => request<ConnectorsView>('POST', `/api/oauth/accounts/${id}/mail`, {}),
  removeOAuthDrive: (id: string) => request<OAuthView>('DELETE', `/api/oauth/accounts/${id}/drive`),
  removeOAuthAccount: (id: string) =>
    request<OAuthView & { connectors: ConnectorsView; permissionsPages?: string[] }>('DELETE', `/api/oauth/accounts/${id}`),
  /** A secrets card's answer: the values (kept for its working directory, never shown again), or none. */
  answerSecrets: (id: string, messageId: string, partId: string, b: { values?: Record<string, string>; decline?: boolean }) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/secrets/${encodeURIComponent(partId)}`,
      b,
    ),
  /** A proposed fixed command's card: save it (with edits), dismiss it, or tell the team about it (with its last run: `share`). */
  commandCard: (
    id: string,
    messageId: string,
    partId: string,
    action: 'save' | 'dismiss' | 'continue' | 'share',
    edits?: Partial<CommandProposal>,
  ) =>
    request<FixedCommand | { ok: true }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/commands/${encodeURIComponent(partId)}`,
      { action, ...(edits ? { edits } : {}) },
    ),
  /** An interactive command's card: start it, type a line into it, answer its password helper, cancel it, send its output to the team, or not run it. */
  interactiveCard: (
    id: string,
    messageId: string,
    partId: string,
    b:
      | { action: 'start'; workdir: boolean; seen: string[] }
      | { action: 'input'; text: string; hidden: boolean }
      | { action: 'answer'; askId: string; text?: string }
      | { action: 'cancel' | 'send' | 'dismiss' },
  ) =>
    request<InteractiveSession | { ok: true }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/interactive/${encodeURIComponent(partId)}`,
      b,
    ),
  /** Try a saved fixed command (in the background: its card follows it). */
  tryCommand: (id: string, commandId: string, b: { extra?: string; approve?: string }) =>
    request<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/try`, b),
  /** The fixed commands of a chat's working directory. */
  conversationCommands: (id: string) => request<FixedCommand[]>('GET', `/api/conversations/${encodeURIComponent(id)}/commands`),
  commandDiff: (id: string, commandId: string) =>
    request<{ changed: string[]; diff: string; digest: string }>(
      'GET',
      `/api/conversations/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/diff`,
    ),
  /** Settings: every working directory's secrets (names) and fixed commands. */
  handoffs: () => request<{ storage: boolean; folders: FolderHandoffs[] }>('GET', '/api/handoffs'),
  setHandoffSecret: (folder: string, name: string, value: string) =>
    request<{ ok: true }>('PUT', '/api/handoffs/secrets', { folder, name, value }),
  deleteHandoffSecret: (folder: string, name: string) => request<{ ok: true }>('POST', '/api/handoffs/secrets/delete', { folder, name }),
  deleteFixedCommand: (commandId: string) => request<{ ok: true }>('DELETE', `/api/handoffs/commands/${encodeURIComponent(commandId)}`),
  /** A steps card, while the team waits for the user: tick a step (by index) or untick it. */
  tickStep: (id: string, messageId: string, index: number, done: boolean) =>
    request<{ ok: true }>('PUT', `/api/conversations/${id}/messages/${messageId}/steps/${index}`, { done }),
  /** Answer it: posted as the user's message, and the team goes on with the agent that asked. */
  answerSteps: (id: string, messageId: string, answer: { done: number[]; stuckAt?: number; note?: string }) =>
    request<{ ok: true; queued: boolean }>('POST', `/api/conversations/${id}/messages/${messageId}/steps/answer`, answer),
  /** Send or discard what an agent asked to send (an outbox item); only Send sends it. */
  answerOutbox: (id: string, itemId: string, action: 'send' | 'discard') =>
    request<OutboxItem>('POST', `/api/conversations/${id}/outbox/${itemId}`, { action }),
  confirmPlan: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/confirm-plan`),
  declinePlan: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/decline-plan`),
  /** Lead review on or off (at any time); returns whether it is on now. */
  setLeadReview: (id: string, on: boolean) => request<{ leadReview: boolean }>('PUT', `/api/conversations/${id}/lead-review`, { on }),
  /** Steering on or off, at any time (also while the team replies). */
  setSteer: (id: string, on: boolean) => request<{ steer: boolean }>('PUT', `/api/conversations/${id}/steer`, { on }),
  /** Team checks: the latest result's card. */
  recheckChecks: (id: string, messageId: string, confirm = false) =>
    request<ChatMessage>('POST', `/api/conversations/${id}/checks/${messageId}/recheck`, confirm ? { confirm } : {}),
  tryCheck: (id: string, command: CheckCommand, permission?: Permission) =>
    request<CheckOutcome>('POST', `/api/conversations/${id}/checks/try`, { command, ...(permission ? { permission } : {}) }),
  checksEnvironment: () => request<{ platform: string; sandbox?: string }>('GET', '/api/checks/environment'),
  skipChecks: (id: string, messageId: string) => request<ChatMessage>('POST', `/api/conversations/${id}/checks/${messageId}/skip`, {}),
  fixChecks: (id: string, messageId: string, agentId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/checks/${messageId}/fix`, { agentId }),
  savePlan: (id: string, messageId: string, name?: string) =>
    request<TeamPreset>('POST', `/api/conversations/${id}/messages/${messageId}/save-plan`, { name }),
  /** Ask the lead agent to change the team being edited (nothing is saved); aborting `signal` stops it. */
  reviseTeam: (id: string, b: ReviseTeamRequest, signal?: AbortSignal) =>
    request<TeamRevision>('POST', `/api/conversations/${id}/revise-team`, b, signal),
  stop: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/stop`),
  /**
   * Put the conversation's shared page (made by sharePage.tsx) on the web as a secret gist; `upTo`: the
   * reply it ends with; `files`: the links to the files that go along, into a gist of their own (the page's
   * placeholder links name them by their place here).
   */
  share: (id: string, html: string, upTo?: string, files: ShareFileRef[] = []) =>
    request<SharedPage>('POST', `/api/conversations/${id}/share`, { html, upTo, files }),
  /** The files these links of the shared messages point to: each once, with its size, or why it cannot go along. */
  shareFiles: (id: string, files: ShareFileRef[], upTo?: string) =>
    request<{ files: ShareFileInfo[] }>('POST', `/api/conversations/${id}/share/files`, { files, upTo }),
  /** The conversations shared so far, the newest first. */
  listShares: () => request<SharedPage[]>('GET', '/api/shares'),
  /** Delete a share's gist (its link stops working) and forget it. */
  deleteShare: (id: string) => request<{ ok: true }>('DELETE', `/api/shares/${id}`),
  messageDiff: (id: string, messageId: string) => requestText(`/api/conversations/${id}/messages/${messageId}/diff`),
  /** `agentId`: an agent's, or `TEAM_WORKTREE` for the team's own worktrees. */
  agentDiff: (id: string, agentId: string) => requestText(`/api/conversations/${id}/agents/${encodeURIComponent(agentId)}/diff`),
  /** Team checks run first: one that does not pass applies nothing (`held`, its card's id), unless `force`. */
  applyAgent: (id: string, agentId: string, o: { force?: boolean; confirm?: boolean } = {}) =>
    request<{ ok: true; files: FileChange[]; held?: string }>(
      'POST',
      `/api/conversations/${id}/agents/${encodeURIComponent(agentId)}/apply`,
      o.force || o.confirm ? o : undefined,
    ),

  // presets
  listPresets: () => request<TeamPreset[]>('GET', '/api/presets'),
  savePreset: (p: Partial<TeamPreset>) => request<TeamPreset>('POST', '/api/presets', p),
  deletePreset: (id: string) => request<{ ok: true }>('DELETE', `/api/presets/${id}`),

  // settings & providers
  // Tool library
  tools: () => request<ToolLibraryView>('GET', '/api/tools'),
  updateTools: (b: ToolLibraryUpdate) => request<ToolLibraryView>('PUT', '/api/tools', b),
  // Long-term memory: each change answers with the whole view.
  memory: () => request<MemoryView>('GET', '/api/memory'),
  memorySettings: (s: Partial<MemorySettings>) => request<MemoryView>('PUT', '/api/memory/settings', s),
  addMemoryNote: (n: MemoryNoteCreate) => request<MemoryView>('POST', '/api/memory/notes', n),
  editMemoryNote: (id: string, patch: MemoryNoteUpdate) =>
    request<MemoryView>('PATCH', `/api/memory/notes/${encodeURIComponent(id)}`, patch),
  deleteMemoryNote: (id: string) => request<MemoryView>('DELETE', `/api/memory/notes/${encodeURIComponent(id)}`),
  tidyMemory: () => request<MemoryView>('POST', '/api/memory/tidy'),
  startAppSignIn: (app: keyof typeof import('../shared/apps').APP_SERVERS) =>
    request<OAuthSignInView>('POST', `/api/apps/${app}/signin`, { origin: location.origin }),
  addObsidianVaults: (paths: string[]) => request<ToolLibraryView>('POST', '/api/apps/obsidian', { paths }),
  removeObsidianVault: (id: string) => request<ToolLibraryView>('DELETE', '/api/apps/obsidian/' + encodeURIComponent(id)),
  hostedAppStatus: (app: HostedApp, provider: HostedProvider, account: string, verify = false) =>
    request<{ status: HostedAppStatus }>('POST', '/api/apps/' + app + '/hosted/' + provider + accountQuery(account), { verify }),
  slackPosting: () => request<import('../shared/types').SlackPostingConnection>('GET', '/api/apps/slack/posting'),
  connectSlackPosting: (token: string) =>
    request<import('../shared/types').SlackPostingConnection>('PUT', '/api/apps/slack/posting', { token }),
  disconnectSlackPosting: () => request<import('../shared/types').SlackPostingConnection>('DELETE', '/api/apps/slack/posting'),
  teamsPosting: () => request<import('../shared/types').TeamsConnection>('POST', '/api/apps/teams/posting'),
  disconnectTeamsPosting: () => request<import('../shared/types').TeamsConnection>('DELETE', '/api/apps/teams/posting'),
  teamsStatus: () => request<import('../shared/types').TeamsConnection>('GET', '/api/apps/teams'),
  teamsInstall: () => request<import('../shared/types').TeamsConnection>('POST', '/api/apps/teams/install'),
  teamsConnect: () => request<import('../shared/types').TeamsConnection>('POST', '/api/apps/teams/signin'),
  teamsDisconnect: () => request<import('../shared/types').TeamsConnection>('DELETE', '/api/apps/teams/signin'),
  githubSignOut: (login: string) => request<{ ok: true }>('POST', '/api/apps/github/signout', { login }),
  verifyDraftSlack: (permission: Permission, signal?: AbortSignal) =>
    request<DraftAppAvailability>('POST', '/api/apps/availability/slack/verify', { permission }, signal),
  draftAppAvailability: (signal?: AbortSignal, permission: Permission = 'read-only', app?: DraftApp | 'local') => {
    const query = new URLSearchParams({ permission });
    if (app) query.set('app', app);
    return request<DraftAppAvailability>('GET', '/api/apps/availability?' + query, undefined, signal);
  },
  appDependency: (name: AppDependency, signal?: AbortSignal) =>
    request<AppDependencyView>('GET', '/api/apps/' + name + '/install', undefined, signal),
  installAppDependency: (name: AppDependency) => request<AppDependencyView>('POST', '/api/apps/' + name + '/install'),
  previewDocker: (signal?: AbortSignal) => request<PreviewDockerView>('GET', '/api/apps/docker/install', undefined, signal),
  installPreviewDocker: () => request<PreviewDockerView>('POST', '/api/apps/docker/install'),
  githubStatus: () => request<import('../shared/types').GithubConnection>('GET', '/api/apps/github'),
  saveMcpServer: (name: string, b: McpServerUpdate) => request<ToolLibraryView>('PUT', `/api/tools/mcp/${encodeURIComponent(name)}`, b),
  deleteMcpServer: (name: string) => request<ToolLibraryView>('DELETE', `/api/tools/mcp/${encodeURIComponent(name)}`),
  /** An HTTP server's own sign-in, followed as an account's is (`oauthSignIn`, `pasteOAuthAddress`, `cancelOAuthSignIn`). */
  startMcpSignIn: (name: string) =>
    request<OAuthSignInView>('POST', `/api/tools/mcp/${encodeURIComponent(name)}/signin`, { origin: location.origin }),
  signOutMcp: (name: string) => request<ToolLibraryView>('DELETE', `/api/tools/mcp/${encodeURIComponent(name)}/signin`),
  scanSkills: (path: string) =>
    request<{ path: string; skills: SkillCandidate[] }>('GET', `/api/tools/skills/scan?path=${encodeURIComponent(path)}`),

  appPreviewTarget: (id: string, target: AppPreviewRequest, signal?: AbortSignal) =>
    request<{ folder: string; mode: AppPreviewRequest['mode']; entry: string }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/preview/target`,
      target,
      signal,
    ),
  /** The app a finished turn made, from the files it added or changed (404: none that runs). */
  appPreviewChanged: (id: string, messageId: string, signal?: AbortSignal) =>
    request<{ folder: string; mode: AppPreviewRequest['mode']; entry: string; shown: string }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/preview/changed`,
      { messageId },
      signal,
    ),
  /** A single-use address that opens a running preview's page in a tab of its own. */
  appPreviewTab: (id: string, session: string) =>
    request<{ url: string }>('POST', `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/tab`, {}),
  startAppPreview: (id: string, target: AppPreviewRequest, signal: AbortSignal) =>
    request<AppPreviewSession>('POST', `/api/conversations/${encodeURIComponent(id)}/preview`, target, signal),
  /**
   * A container preview's terminal, as the server streams it (SSE). Read with fetch, not EventSource,
   * so that the key goes in its header like every other request's.
   */
  appPreviewTerminal: async (id: string, session: string, signal: AbortSignal): Promise<Response> => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/terminal`, {
      headers: headers(false, readKey()),
      signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code);
    }
    return res;
  },
  /** Keystrokes for a container preview's terminal, or its new size. */
  appPreviewTerminalSend: (id: string, session: string, body: { input?: string; cols?: number; rows?: number }) =>
    request<{ ok: true }>('POST', `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/terminal`, body),
  /** Runs a container preview's app again: with its own command, or with the command line given. */
  appPreviewRun: (id: string, session: string, command?: string) =>
    request<{ ok: true }>(
      'POST',
      `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/run`,
      command === undefined ? {} : { command },
    ),
  /** What publishing a running preview would do (Render, Neon), for the dialog. */
  publishPlan: (id: string, session: string) =>
    request<PublishPlan>('POST', `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/publish/plan`, {}),
  /** Starts publishing it: the app comes back at once, its steps followed with `publishedApp`. */
  publishPreview: (id: string, session: string, body: PublishRequest) =>
    request<PublishedApp>('POST', `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}/publish`, body),
  publishSettings: () => request<PublishSettingsView>('GET', '/api/publish'),
  setRenderKey: (apiKey: string) => request<PublishSettingsView>('PUT', '/api/publish/render', { apiKey }),
  updateRender: (body: { ownerId?: string; region?: RenderRegion }) => request<PublishSettingsView>('PATCH', '/api/publish/render', body),
  removeRender: () => request<PublishSettingsView>('DELETE', '/api/publish/render'),
  setNeonKey: (apiKey: string) => request<PublishSettingsView>('PUT', '/api/publish/neon', { apiKey }),
  updateNeon: (body: { orgId?: string }) => request<PublishSettingsView>('PATCH', '/api/publish/neon', body),
  removeNeon: () => request<PublishSettingsView>('DELETE', '/api/publish/neon'),
  publishedApp: (appId: string) => request<PublishedApp>('GET', `/api/publish/apps/${encodeURIComponent(appId)}`),
  unpublishApp: (appId: string, database: boolean, forget = false) =>
    request<{ ok: true }>(
      'DELETE',
      `/api/publish/apps/${encodeURIComponent(appId)}${forget ? '?forget=1' : database ? '?database=1' : ''}`,
    ),
  stopAppPreview: (id: string, session: string) =>
    request<{ ok: true }>(
      'DELETE',
      `/api/conversations/${encodeURIComponent(id)}/preview/${encodeURIComponent(session)}`,
      undefined,
      undefined,
      { keepalive: true },
    ),

  // Files of a conversation's working directory (root: 'cwd' or an agent id)
  listFiles: (id: string, root: string, path: string) =>
    request<FileListing>('GET', `/api/conversations/${id}/files?${fileQuery(root, path)}`),
  previewFile: (id: string, root: string, path: string) =>
    request<FilePreview>('GET', `/api/conversations/${id}/files/preview?${fileQuery(root, path)}`),
  rawFileUrl: (id: string, root: string, path: string) => `/api/conversations/${id}/files/raw?${fileQuery(root, path)}`,
  downloadFileUrl: (id: string, root: string, path: string) => `/api/conversations/${id}/files/download?${fileQuery(root, path)}`,
  /** What a folder's ZIP file would hold (nothing is zipped). */
  checkZip: (id: string, root: string, path: string) =>
    request<ZipCheck>('GET', `/api/conversations/${id}/files/zip/check?${fileQuery(root, path)}`),
  /** A folder as a ZIP file; `unignored`: only what git does not ignore. */
  zipUrl: (id: string, root: string, path: string, unignored = false) =>
    `/api/conversations/${id}/files/zip?${fileQuery(root, path)}${unignored ? '&unignored=1' : ''}`,
  /** Saves a text file over the version it was loaded at, or (`version: null`) makes a new one. */
  saveFile: (id: string, file: FileSaveRequest) => request<FileWritten>('PUT', `/api/conversations/${id}/files/text`, file),
  /** Uploads one file into a folder (base64); `replace` once the user agreed to replace one there. */
  uploadFile: (id: string, file: FileUploadRequest) => request<FileWritten>('POST', `/api/conversations/${id}/files/upload`, file),

  getSettings: () => request<SettingsView>('GET', '/api/settings'),
  // Model backends (the open agents): keys come back masked
  backends: () => request<ModelBackendsView>('GET', '/api/backends'),
  // Settings → Labs
  labs: () => request<LabsView>('GET', '/api/labs'),
  updateLabs: (b: LabSettings) => request<LabsView>('PUT', '/api/labs', b),
  endpointModels: (b: { baseUrl: string; endpointId?: string; apiKey?: string | null }, signal?: AbortSignal) =>
    request<{ models: string[] }>('POST', '/api/backends/endpoint-models', b, signal),
  setBackendKey: (id: ApiBackend, apiKey: string | null) => request<ModelBackendsView>('PUT', `/api/backends/${id}`, { apiKey }),
  saveEndpoint: (id: string, b: ModelEndpointUpdate) =>
    request<ModelBackendsView>('PUT', `/api/backends/endpoints/${encodeURIComponent(id)}`, { ...b, verifyModels: true }),
  deleteEndpoint: (id: string) => request<ModelBackendsView>('DELETE', `/api/backends/endpoints/${encodeURIComponent(id)}`),
  forgetDeletedEndpoint: (id: string) => request<ModelBackendsView>('DELETE', `/api/backends/deleted-endpoints/${encodeURIComponent(id)}`),
  // The options as booleans: the server merges the patch into the default, so `false` turns one off.
  updateCheckDefaults: (patch: Omit<CheckList, 'fromDefault' | 'previewApp' | 'autoFix'> & { previewApp?: boolean; autoFix?: boolean }) =>
    request<CheckList>('PATCH', '/api/settings/checks-default', patch),
  updateSettings: (b: SettingsUpdate) => request<SettingsView>('PUT', '/api/settings', b),
  updateProvider: (p: Provider, b: ProviderSettingsUpdate) => request<SettingsView>('PUT', `/api/settings/providers/${p}`, b),
  models: (refresh = false) => request<ProviderModels[]>('GET', `/api/models${refresh ? '?refresh=1' : ''}`),
  providers: (refresh = false) => request<ProviderStatus[]>('GET', `/api/providers${refresh ? '?refresh=1' : ''}`),
  /**
   * Which Harness Relay this is, and on what, for a problem report. Given up on after 10 s: the report
   * then says the server did not answer, instead of waiting for good.
   */
  about: async () => {
    const timeout = timeoutSignal(10_000);
    try {
      return await request<AboutInfo>('GET', '/api/about', undefined, timeout.signal);
    } finally {
      timeout.clear();
    }
  },
  /** What the server's environment sets that the UI keeps to or shows (`useLimits()`). */
  limits: () => request<ServerLimits>('GET', '/api/limits'),
  /** This version, and the desktop app's updates (only the version otherwise). */
  update: () => request<UpdateStatus>('GET', '/api/update'),
  /**
   * The same, quietly, for the page's watch on the server's version: a browser that is not signed in
   * (any failure) is no answer, rather than the sign-in page shown again.
   */
  serverVersion: async (): Promise<UpdateStatus> => {
    const res = await fetch('/api/update', { headers: headers(false, readKey()) });
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as UpdateStatus;
  },
  /** Has the desktop app ask GitHub for a new version now (at most every five minutes); what it knows once it has. */
  checkUpdate: () => request<UpdateStatus>('POST', '/api/update/check'),
  /** Has the desktop app update to the newer version: it asks the user first, in its own dialog. */
  installUpdate: () => request<{ ok: true }>('POST', '/api/update/install'),
  /** Tells the desktop app the language its window's chat shows: its menus and dialogs follow it. */
  desktopLang: (lang: Lang) => request<{ ok: true }>('PUT', '/api/desktop/lang', { lang }),
  /** A problem report's screenshots (each base64) up to GitHub, as a secret gist through the user's gh. */
  uploadScreenshots: (images: string[]) =>
    request<ReportScreenshots>('POST', '/api/report/screenshots', { files: images.map((data) => ({ data })) }),
  /** Deletes the screenshots' gist again (one uploaded since the server started). */
  removeScreenshots: (id: string) => request<{ ok: true }>('DELETE', `/api/report/screenshots/${encodeURIComponent(id)}`),
  /** How much of an account's plan is used, as its CLI reports it (`refresh` asks the CLI again). */
  usage: (p: Provider, account = '', refresh = false) => {
    const query = [account && `account=${encodeURIComponent(account)}`, refresh && 'refresh=1'].filter(Boolean).join('&');
    return request<AccountUsage>('GET', `/api/providers/${p}/usage${query ? `?${query}` : ''}`);
  },
  /** What a CLI loads by itself in an account's home (empty: the default account's), with what its runs leave out. */
  nativeSetup: (p: Provider, refresh = false, account = '') =>
    request<NativeSetup>('POST', `/api/providers/${p}/native${accountQuery(account)}`, { refresh }),
  nativeFile: (p: Provider, path: string, account = '') =>
    request<FilePreview>('POST', `/api/providers/${p}/native/file${accountQuery(account)}`, { path }),
  /**
   * Whether Grok trusts `cwd`. With `trustFolder`, trust it first: only after the user confirmed that
   * folder (the `folder` of an earlier answer); the server refuses if Grok now names another.
   */
  grokFolderTrust: (cwd: string, trustFolder?: string) =>
    request<GrokFolderTrust>('POST', '/api/providers/grok/folder-trust', {
      cwd,
      ...(trustFolder !== undefined ? { trust: true, folder: trustFolder } : {}),
    }),
  /** A CLI's accounts besides its default one (`account`: its id; empty = the default account). */
  addAccount: (p: Provider, label: string) =>
    request<{ id: string; settings: SettingsView }>('POST', `/api/settings/providers/${p}/accounts`, { label }),
  updateAccount: (p: Provider, account: string, b: ProviderAccountUpdate) =>
    request<SettingsView>('PUT', `/api/settings/providers/${p}/accounts/${accountPath(account)}`, b),
  removeAccount: (p: Provider, account: string) =>
    request<SettingsView>('DELETE', `/api/settings/providers/${p}/accounts/${accountPath(account)}`),
  loginMethods: (p: Provider) => request<LoginMethod[]>('GET', `/api/providers/${p}/login-methods`),
  startLogin: (p: Provider, method: string, account = '') =>
    request<LoginSessionView>('POST', `/api/providers/${p}/login${accountQuery(account)}`, { method }),
  getLogin: (p: Provider, account = '') => request<LoginSessionView | null>('GET', `/api/providers/${p}/login${accountQuery(account)}`),
  loginInput: (p: Provider, text: string, account = '') =>
    request<LoginSessionView>('POST', `/api/providers/${p}/login/input${accountQuery(account)}`, { text }),
  cancelLogin: (p: Provider, account = '') => request<{ ok: true }>('DELETE', `/api/providers/${p}/login${accountQuery(account)}`),
  /** gh's own sign-in, for sharing (the share dialog's gh help). */
  startGhLogin: () => request<CliLoginView>('POST', '/api/gh/login', {}),
  getGhLogin: () => request<CliLoginView | null>('GET', '/api/gh/login'),
  cancelGhLogin: () => request<{ ok: true }>('DELETE', '/api/gh/login'),
  logout: (p: Provider, account = '') =>
    request<{ ok: true; output: string }>('POST', `/api/providers/${p}/logout${accountQuery(account)}`),

  // installing the CLIs from Settings
  clis: () => request<CliInstallView[]>('GET', '/api/clis'),
  installCli: (p: Provider) => request<CliInstallView>('POST', `/api/clis/${p}/install`),
  cancelCliInstall: (p: Provider) => request<CliInstallView>('DELETE', `/api/clis/${p}/install`),
  removeCli: (p: Provider) => request<CliInstallView>('DELETE', `/api/clis/${p}`),
  gitInstall: (requirement: GitRequirement, signal?: AbortSignal) =>
    request<GitInstallView>('GET', gitInstallPath(requirement), undefined, signal),
  installGit: (requirement: GitRequirement) => request<GitInstallView>('POST', gitInstallPath(requirement)),
  sandboxSetup: () => request<SandboxSetupView>('GET', '/api/sandbox-setup'),
  installSandboxSetup: () => request<SandboxSetupView>('POST', '/api/sandbox-setup/install'),
  cancelSandboxSetup: () => request<SandboxSetupView>('DELETE', '/api/sandbox-setup/install'),
  // voice input
  voice: () => request<VoiceStatus>('GET', '/api/voice'),
  updateVoice: (b: VoiceSettingsUpdate) => request<VoiceStatus>('PUT', '/api/voice/settings', b),
  /** Installs what is missing for `model` in the background (the engine, the model). */
  installVoice: (model?: VoiceModelId) => request<VoiceStatus>('POST', '/api/voice/install', { model }),
  cancelVoiceInstall: () => request<VoiceStatus>('DELETE', '/api/voice/install'),
  deleteVoiceModel: (model: VoiceModelId) => request<VoiceStatus>('DELETE', `/api/voice/models/${model}`),
  uninstallVoice: () => request<VoiceStatus>('DELETE', '/api/voice'),
  prepareVoice: () => request<{ ok: true }>('POST', '/api/voice/prepare'),
  /** `audio`: base64 16 kHz mono WAV. */
  transcribe: (audio: string) => request<{ text: string }>('POST', '/api/voice/transcribe', { audio }),
};
