import { BACKEND_LIMITS, ENDPOINT_ID_RE, isApiBackend, type ModelEndpointUpdate, type ModelEndpointView } from '../shared/types';

/** Settings → Model connections: the endpoint form's logic, kept out of the component so it can be tested without a DOM. */

/** The endpoint form as typed: the selected model IDs are kept intact. */
export interface EndpointDraft {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  /** A new key; empty keeps the current one (or none for a new endpoint). */
  apiKey: string;
  /** Remove the current key. */
  removeKey: boolean;
}

export type EndpointProblem = 'name' | 'nameLong' | 'id' | 'idTaken' | 'idReserved' | 'url' | 'models';

/** An id from the endpoint's name: "Homelab vLLM" → "homelab-vllm" (what `ENDPOINT_ID_RE` takes, at most 32 characters). */
export function endpointSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** The model names typed, each once, in their order. */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/** The form for an endpoint (empty for a new one). */
export function endpointDraft(e?: ModelEndpointView): EndpointDraft {
  return {
    id: e?.id ?? '',
    name: e?.name ?? '',
    baseUrl: e?.baseUrl ?? '',
    models: [...(e?.models ?? [])],
    apiKey: '',
    removeKey: false,
  };
}

/** Whether the base URL is one the server takes: http(s), with no user name, password, query or fragment. */
export function normalizedBaseUrl(text: string): string | undefined {
  const raw = text.trim();
  if (!raw || raw.length > BACKEND_LIMITS.maxUrl || raw.includes('?') || raw.includes('#')) return;
  try {
    const url = new URL(raw);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href.replace(/\/+$/, '');
  } catch {
    // The user may still be entering the address.
  }
}

export function validBaseUrl(text: string): boolean {
  return normalizedBaseUrl(text) !== undefined;
}

/**
 * What is wrong with the form, as the server would say it (it checks again): `editing` is the id of
 * the endpoint being changed (its id cannot change), absent for a new one.
 */
export function endpointProblems(d: EndpointDraft, existing: Pick<ModelEndpointView, 'id'>[], editing?: string): EndpointProblem[] {
  const out: EndpointProblem[] = [];
  if (!d.name.trim()) out.push('name');
  else if (d.name.trim().length > BACKEND_LIMITS.maxName) out.push('nameLong');
  if (editing === undefined) {
    const id = d.id.trim();
    if (!ENDPOINT_ID_RE.test(id)) out.push('id');
    else if (isApiBackend(id)) out.push('idReserved');
    else if (existing.some((e) => e.id === id)) out.push('idTaken');
  }
  if (!validBaseUrl(d.baseUrl)) out.push('url');
  const models = d.models;
  if (models.length > BACKEND_LIMITS.maxModels || models.some((m) => m.length > BACKEND_LIMITS.maxModelId)) out.push('models');
  return out;
}

/** What the form sends: the key only when one was typed, or removed. */
export function endpointUpdate(d: EndpointDraft): ModelEndpointUpdate {
  const key = d.apiKey.trim();
  return {
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    models: [...new Set(d.models)],
    ...(key ? { apiKey: key } : d.removeKey ? { apiKey: null } : {}),
  };
}
