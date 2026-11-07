import { CWD_MISSING } from '../shared/types';
import type {
  AgentConfig,
  ApprovalAnswer,
  ChatMessage,
  Conversation,
  ConversationSettings,
  ConversationSummary,
  FileChange,
  LeadAgentSettings,
  LoginMethod,
  LoginSessionView,
  Provider,
  ProviderModels,
  ProviderSettingsUpdate,
  ProviderStatus,
  SettingsView,
  TeamPreset,
  VoiceModelId,
  VoiceSettingsUpdate,
  VoiceStatus,
} from '../shared/types';
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
  return json ? { 'X-Relay-Lang': currentLang(), 'Content-Type': 'application/json' } : { 'X-Relay-Lang': currentLang() };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: headers(method !== 'GET'),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as { error?: string; code?: string };
    throw new ApiError(err.error ?? `${res.status} ${res.statusText}`, res.status, err.code);
  }
  return data as T;
}

async function requestText(path: string): Promise<string> {
  const res = await fetch(path, { headers: headers(false) });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status);
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

export const api = {
  // conversations
  listConversations: () => request<ConversationSummary[]>('GET', '/api/conversations'),
  getConversation: (id: string) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (b: { title?: string; agents: AgentConfig[]; settings: ConversationSettings; createCwd?: boolean }) =>
    request<Conversation>('POST', '/api/conversations', b),
  updateConversation: (id: string, b: Partial<Pick<Conversation, 'title' | 'agents' | 'settings'>> & { createCwd?: boolean }) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, b),
  deleteConversation: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  /** While the team replies the message waits for the next turn (`queued`); `interrupt` stops the team and sends it now. */
  send: (id: string, text: string, attachments: AttachmentUpload[] = [], interrupt = false) =>
    request<{ ok: true; queued: boolean }>('POST', `/api/conversations/${id}/messages`, { text, attachments, interrupt }),
  /** Take back a message still waiting to be delivered; returns it. */
  withdraw: (id: string, messageId: string) => request<ChatMessage>('DELETE', `/api/conversations/${id}/queue/${messageId}`),
  attachmentUrl: (convId: string, attachmentId: string) => `/api/conversations/${convId}/attachments/${attachmentId}`,
  /** Serves the images and videos a message embeds; add `?path=`. */
  mediaBase: (convId: string, messageId: string) => `/api/conversations/${convId}/messages/${messageId}/media`,
  resend: (id: string, messageId: string, text: string) =>
    request<{ ok: true }>('PUT', `/api/conversations/${id}/messages/${messageId}`, { text }),
  retry: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/retry`),
  answerApproval: (id: string, approvalId: string, answer: ApprovalAnswer) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/approvals/${approvalId}`, answer),
  confirmPlan: (id: string, messageId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/messages/${messageId}/confirm-plan`),
  savePlan: (id: string, messageId: string, name?: string) =>
    request<TeamPreset>('POST', `/api/conversations/${id}/messages/${messageId}/save-plan`, { name }),
  stop: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/stop`),
  messageDiff: (id: string, messageId: string) => requestText(`/api/conversations/${id}/messages/${messageId}/diff`),
  agentDiff: (id: string, agentId: string) => requestText(`/api/conversations/${id}/agents/${agentId}/diff`),
  applyAgent: (id: string, agentId: string) =>
    request<{ ok: true; files: FileChange[] }>('POST', `/api/conversations/${id}/agents/${agentId}/apply`),

  // presets
  listPresets: () => request<TeamPreset[]>('GET', '/api/presets'),
  savePreset: (p: Partial<TeamPreset>) => request<TeamPreset>('POST', '/api/presets', p),
  deletePreset: (id: string) => request<{ ok: true }>('DELETE', `/api/presets/${id}`),

  // settings & providers
  getSettings: () => request<SettingsView>('GET', '/api/settings'),
  updateSettings: (b: { defaultCwd?: string; createCwd?: boolean; lead?: LeadAgentSettings }) => request<SettingsView>('PUT', '/api/settings', b),
  updateProvider: (p: Provider, b: ProviderSettingsUpdate) =>
    request<SettingsView>('PUT', `/api/settings/providers/${p}`, b),
  models: (refresh = false) => request<ProviderModels[]>('GET', `/api/models${refresh ? '?refresh=1' : ''}`),
  providers: (refresh = false) => request<ProviderStatus[]>('GET', `/api/providers${refresh ? '?refresh=1' : ''}`),
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
