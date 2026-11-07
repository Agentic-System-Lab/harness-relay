import type {
  AgentConfig,
  Conversation,
  ConversationSettings,
  ConversationSummary,
  FileChange,
  LoginMethod,
  LoginSessionView,
  Provider,
  ProviderModels,
  ProviderSettingsUpdate,
  ProviderStatus,
  SettingsView,
  TeamPreset,
} from '../shared/types';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

async function requestText(path: string): Promise<string> {
  const res = await fetch(path);
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return text;
}

export const api = {
  // conversations
  listConversations: () => request<ConversationSummary[]>('GET', '/api/conversations'),
  getConversation: (id: string) => request<Conversation>('GET', `/api/conversations/${id}`),
  createConversation: (b: { title?: string; agents: AgentConfig[]; settings: ConversationSettings }) =>
    request<Conversation>('POST', '/api/conversations', b),
  updateConversation: (id: string, b: Partial<Pick<Conversation, 'title' | 'agents' | 'settings'>>) =>
    request<Conversation>('PATCH', `/api/conversations/${id}`, b),
  deleteConversation: (id: string) => request<{ ok: true }>('DELETE', `/api/conversations/${id}`),
  send: (id: string, text: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/messages`, { text }),
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
  updateSettings: (b: { defaultCwd?: string }) => request<SettingsView>('PUT', '/api/settings', b),
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
};
