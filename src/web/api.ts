import { AUTH_KEY_HEADER, SIGNED_OUT } from '../shared/auth';
import { CWD_MISSING, DEFAULT_ACCOUNT } from '../shared/types';
import type {
  AboutInfo,
  AlertPrefs,
  ApiBackend,
  ModelBackendsView,
  ModelEndpointUpdate,
  AgentConfig,
  ApprovalAnswer,
  AuthSessionView,
  ChatMessage,
  Conversation,
  ConversationGroup,
  ConversationSchedule,
  ConversationSettings,
  ConversationSummary,
  FileChange,
  FileListing,
  FilePreview,
  GrokFolderTrust,
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
  const res = await fetch(path, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: headers(method !== 'GET', key),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal,
  });
  const data = await res.json().catch(() => {
    // Given up (its signal) while the answer was read: not an answer, but the request given up.
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    return {};
  });
  if (!res.ok) {
    const err = data as { error?: string; code?: string; paths?: unknown };
    if (res.status === 401 && (await signedOut(err.code, key, o))) return request<T>(method, path, body, signal, { resent: true });
    const paths = Array.isArray(err.paths) ? err.paths.filter((p): p is string => typeof p === 'string') : undefined;
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code, paths);
  }
  return data as T;
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
    throw new ApiError(msg, res.status, code);
  }
  return text;
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
  newSignInCode: () => request<{ code: string; expiresAt: number }>('POST', '/api/auth/codes'),
  signedInBrowsers: () => request<AuthSessionView[]>('GET', '/api/auth/sessions'),
  /** Signs a browser out; this one's key goes too when it is this one. */
  signOut: async (id: string, current: boolean) => {
    await request<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`);
    if (current) clearKey();
  },
  // notifications
  /** Whether the server sends push notifications: the key to subscribe with, or why not. */
  pushStatus: () => request<PushStatus>('GET', '/api/push'),
  /** Keeps this browser's push subscription and which alerts it wants. */
  pushSubscribe: (subscription: PushSubscriptionJson, prefs: AlertPrefs) => request<{ ok: true }>('PUT', '/api/push/subscription', { subscription, prefs }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('DELETE', '/api/push/subscription', { endpoint }),
  /** Has the server send this browser a test notification through its push service. */
  pushTest: (endpoint: string) => request<{ ok: true }>('POST', '/api/push/test', { endpoint }),
  /**
   * This page (`page`: its id) went to the background: kept alive as the page goes away (a phone
   * locking), so the server sends the push notifications it held for this browser now, unless another
   * page of it is still in front. Never fails.
   */
  presence: (visible: boolean, page: string) =>
    void fetch('/api/push/presence', { method: 'POST', keepalive: true, headers: headers(true, readKey()), body: JSON.stringify({ visible, page }) }).catch(
      () => undefined,
    ),
  /** The conversation's live updates. EventSource sends no headers, so the key goes in the query. */
  eventsUrl: (id: string) => {
    const key = readKey();
    return `/api/conversations/${id}/events${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  },

  // conversations
  /**
   * `page`: this page's id, given while it is in front: it tells the user itself when agents finish or
   * need them, so its browser gets no push notification meanwhile.
   */
  listConversations: (page?: string) =>
    request<ConversationSummary[]>('GET', `/api/conversations${page ? `?visible=1&page=${encodeURIComponent(page)}` : ''}`),
  getConversation: (id: string) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (b: { title?: string; agents: AgentConfig[]; settings: ConversationSettings; createCwd?: boolean }) =>
    request<Conversation>('POST', '/api/conversations', b),
  updateConversation: (id: string, b: Partial<Pick<Conversation, 'title' | 'agents' | 'settings'>> & { createCwd?: boolean }) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, b),
  deleteConversation: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  /** `groupId: null` puts it in the default group ("Other"). */
  moveToGroup: (id: string, groupId: string | null) =>
    request<{ ok: true }>('PUT', `/api/conversations/${id}/group`, { groupId }),
  /** Set the conversation's schedule (it replaces the one there was). */
  saveSchedule: (id: string, b: ScheduleUpdate) => request<ConversationSchedule>('PUT', `/api/conversations/${id}/schedule`, b),
  deleteSchedule: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}/schedule`),
  /** A new schedule in a conversation of its own, whose lead agent designs the team for it now. */
  createSchedule: (b: { title?: string; settings: Partial<ConversationSettings>; createCwd?: boolean; schedule: ScheduleUpdate }) =>
    request<Conversation>('POST', '/api/schedules', b),
  /** Have the lead agent design the team for the schedule's message (again). */
  designSchedule: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/schedule/design`),
  /** Send the schedule's message now; `queued` while the team replies, `chatId` when it opened a new conversation. */
  runSchedule: (id: string) => request<{ ok: true; queued: boolean; chatId?: string }>('POST', `/api/conversations/${id}/schedule/run`),
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
    request<{ ok: true; queued: boolean }>('POST', `/api/conversations/${id}/messages`, { text, attachments, interrupt }),
  /** Take back a message still waiting to be delivered; returns it. */
  withdraw: (id: string, messageId: string) => request<ChatMessage>('DELETE', `/api/conversations/${id}/queue/${messageId}`),
  attachmentUrl: (convId: string, attachmentId: string) => `/api/conversations/${convId}/attachments/${attachmentId}`,
  /** Serves the images and videos a message embeds; add `?path=`. */
  mediaBase: (convId: string, messageId: string) => `/api/conversations/${convId}/messages/${messageId}/media`,
  /** Downloads the files a message links to; add `?path=`. */
  downloadBase: (convId: string, messageId: string) => `/api/conversations/${convId}/messages/${messageId}/download`,
  resend: (id: string, messageId: string, text: string) =>
    request<{ ok: true }>('PUT', `/api/conversations/${id}/messages/${messageId}`, { text }),
  retry: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/retry`),
  /** A new conversation with the messages up to and including this agent reply; returns it. */
  branch: (id: string, messageId: string) =>
    request<Conversation>('POST', `/api/conversations/${id}/messages/${messageId}/branch`),
  answerApproval: (id: string, approvalId: string, answer: ApprovalAnswer) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/approvals/${approvalId}`, answer),
  confirmPlan: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/confirm-plan`),
  declinePlan: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/decline-plan`),
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
  agentDiff: (id: string, agentId: string) => requestText(`/api/conversations/${id}/agents/${agentId}/diff`),
  applyAgent: (id: string, agentId: string) =>
    request<{ ok: true; files: FileChange[] }>('POST', `/api/conversations/${id}/agents/${agentId}/apply`),

  // presets
  listPresets: () => request<TeamPreset[]>('GET', '/api/presets'),
  savePreset: (p: Partial<TeamPreset>) => request<TeamPreset>('POST', '/api/presets', p),
  deletePreset: (id: string) => request<{ ok: true }>('DELETE', `/api/presets/${id}`),

  // settings & providers
  // Tool library
  tools: () => request<ToolLibraryView>('GET', '/api/tools'),
  updateTools: (b: ToolLibraryUpdate) => request<ToolLibraryView>('PUT', '/api/tools', b),
  saveMcpServer: (name: string, b: McpServerUpdate) =>
    request<ToolLibraryView>('PUT', `/api/tools/mcp/${encodeURIComponent(name)}`, b),
  deleteMcpServer: (name: string) => request<ToolLibraryView>('DELETE', `/api/tools/mcp/${encodeURIComponent(name)}`),
  scanSkills: (path: string) =>
    request<{ path: string; skills: SkillCandidate[] }>('GET', `/api/tools/skills/scan?path=${encodeURIComponent(path)}`),

  // Files of a conversation's working directory (root: 'cwd' or an agent id)
  listFiles: (id: string, root: string, path: string) =>
    request<FileListing>('GET', `/api/conversations/${id}/files?${fileQuery(root, path)}`),
  previewFile: (id: string, root: string, path: string) =>
    request<FilePreview>('GET', `/api/conversations/${id}/files/preview?${fileQuery(root, path)}`),
  rawFileUrl: (id: string, root: string, path: string) => `/api/conversations/${id}/files/raw?${fileQuery(root, path)}`,
  downloadFileUrl: (id: string, root: string, path: string) => `/api/conversations/${id}/files/download?${fileQuery(root, path)}`,
  /** What a folder's ZIP file would hold (nothing is zipped). */
  checkZip: (id: string, root: string, path: string) => request<ZipCheck>('GET', `/api/conversations/${id}/files/zip/check?${fileQuery(root, path)}`),
  /** A folder as a ZIP file; `unignored`: only what git does not ignore. */
  zipUrl: (id: string, root: string, path: string, unignored = false) =>
    `/api/conversations/${id}/files/zip?${fileQuery(root, path)}${unignored ? '&unignored=1' : ''}`,

  getSettings: () => request<SettingsView>('GET', '/api/settings'),
  // Model backends (the open agents): keys come back masked
  backends: () => request<ModelBackendsView>('GET', '/api/backends'),
  setBackendKey: (id: ApiBackend, apiKey: string | null) => request<ModelBackendsView>('PUT', `/api/backends/${id}`, { apiKey }),
  saveEndpoint: (id: string, b: ModelEndpointUpdate) => request<ModelBackendsView>('PUT', `/api/backends/endpoints/${encodeURIComponent(id)}`, b),
  deleteEndpoint: (id: string) => request<ModelBackendsView>('DELETE', `/api/backends/endpoints/${encodeURIComponent(id)}`),
  forgetDeletedEndpoint: (id: string) => request<ModelBackendsView>('DELETE', `/api/backends/deleted-endpoints/${encodeURIComponent(id)}`),
  updateSettings: (b: SettingsUpdate) => request<SettingsView>('PUT', '/api/settings', b),
  updateProvider: (p: Provider, b: ProviderSettingsUpdate) =>
    request<SettingsView>('PUT', `/api/settings/providers/${p}`, b),
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
  /** A problem report's screenshots (each base64) up to GitHub, as a secret gist through the user's gh. */
  uploadScreenshots: (images: string[]) =>
    request<ReportScreenshots>('POST', '/api/report/screenshots', { files: images.map((data) => ({ data })) }),
  /** Deletes the screenshots' gist again (one uploaded since the server started). */
  removeScreenshots: (id: string) => request<{ ok: true }>('DELETE', `/api/report/screenshots/${encodeURIComponent(id)}`),
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
  logout: (p: Provider, account = '') =>
    request<{ ok: true; output: string }>('POST', `/api/providers/${p}/logout${accountQuery(account)}`),

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
