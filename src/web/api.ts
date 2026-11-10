import { AUTH_KEY_HEADER, SIGNED_OUT } from '../shared/auth';
import { CWD_MISSING } from '../shared/types';
import type {
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
  Provider,
  ProviderModels,
  ProviderSettingsUpdate,
  ProviderStatus,
  ScheduleUpdate,
  SearchResult,
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
  VoiceModelId,
  VoiceSettingsUpdate,
  VoiceStatus,
  WorkingDirectories,
  ZipCheck,
} from '../shared/types';
import { clearKey, readKey, writeKey } from './auth';
import { currentLang } from './i18n';

/** A request the server answered with an error; `status` is the HTTP status, `code` tells some errors apart. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Runs `call`; if the server says the working directory does not exist and `ask()` agrees,
 * runs it again with `createCwd: true`. Any other error, or a refusal, is thrown.
 */
export async function orCreateCwd<T>(call: (createCwd: boolean) => Promise<T>, ask: () => boolean): Promise<T> {
  try {
    return await call(false);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === CWD_MISSING) || !ask()) throw e;
    return call(true);
  }
}

/** Every request names the UI language, so server messages come back in it. */
function headers(json: boolean): Record<string, string> {
  const key = readKey();
  return {
    'X-Relay-Lang': currentLang(),
    ...(key ? { [AUTH_KEY_HEADER]: key } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** The event the app listens for to show the sign-in page: the server no longer knows this browser. */
export const SIGNED_OUT_EVENT = 'relay:signed-out';

function signedOut(code: string | undefined): void {
  if (code !== SIGNED_OUT) return;
  clearKey();
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: headers(method !== 'GET'),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error?: string; code?: string };
    if (res.status === 401) signedOut(err.code);
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code);
  }
  return data as T;
}

async function requestText(path: string): Promise<string> {
  const res = await fetch(path, { headers: headers(false) });
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
    if (res.status === 401) signedOut(code);
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
  authStatus: () => request<{ signedIn: boolean }>('GET', '/api/auth'),
  /** Signs this browser in with a one-time code; the server sets its cookie, the key is kept here. */
  signIn: async (code: string) => {
    const { key } = await request<{ key: string }>('POST', '/api/auth/login', { code });
    writeKey(key);
  },
  /** A one-time code for another device (a phone), from this signed-in browser. */
  newSignInCode: () => request<{ code: string; expiresAt: number }>('POST', '/api/auth/codes'),
  signedInBrowsers: () => request<AuthSessionView[]>('GET', '/api/auth/sessions'),
  /** Signs a browser out; this one's key goes too when it is this one. */
  signOut: async (id: string, current: boolean) => {
    await request<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`);
    if (current) clearKey();
  },
  /** The conversation's live updates. EventSource sends no headers, so the key goes in the query. */
  eventsUrl: (id: string) => {
    const key = readKey();
    return `/api/conversations/${id}/events${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  },

  // conversations
  listConversations: () => request<ConversationSummary[]>('GET', '/api/conversations'),
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
  updateSettings: (b: SettingsUpdate) => request<SettingsView>('PUT', '/api/settings', b),
  updateProvider: (p: Provider, b: ProviderSettingsUpdate) =>
    request<SettingsView>('PUT', `/api/settings/providers/${p}`, b),
  models: (refresh = false) => request<ProviderModels[]>('GET', `/api/models${refresh ? '?refresh=1' : ''}`),
  providers: (refresh = false) => request<ProviderStatus[]>('GET', `/api/providers${refresh ? '?refresh=1' : ''}`),
  nativeSetup: (p: Provider, refresh = false) => request<NativeSetup>('POST', `/api/providers/${p}/native`, { refresh }),
  nativeFile: (p: Provider, path: string) => request<FilePreview>('POST', `/api/providers/${p}/native/file`, { path }),
  /**
   * Whether Grok trusts `cwd`. With `trustFolder`, trust it first: only after the user confirmed that
   * folder (the `folder` of an earlier answer); the server refuses if Grok now names another.
   */
  grokFolderTrust: (cwd: string, trustFolder?: string) =>
    request<GrokFolderTrust>('POST', '/api/providers/grok/folder-trust', {
      cwd,
      ...(trustFolder !== undefined ? { trust: true, folder: trustFolder } : {}),
    }),
  loginMethods: (p: Provider) => request<LoginMethod[]>('GET', `/api/providers/${p}/login-methods`),
  startLogin: (p: Provider, method: string) => request<LoginSessionView>('POST', `/api/providers/${p}/login`, { method }),
  getLogin: (p: Provider) => request<LoginSessionView | null>('GET', `/api/providers/${p}/login`),
  loginInput: (p: Provider, text: string) =>
    request<LoginSessionView>('POST', `/api/providers/${p}/login/input`, { text }),
  cancelLogin: (p: Provider) => request<{ ok: true }>('DELETE', `/api/providers/${p}/login`),
  logout: (p: Provider) => request<{ ok: true; output: string }>('POST', `/api/providers/${p}/logout`),

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
