import { BACKEND_LIMITS, ENDPOINT_ID_RE, isApiBackend, type ModelEndpointUpdate, type ModelEndpointView } from '../shared/types';
import type { TokenLimits } from '../shared/types';
import { validContext, validOutput } from '../shared/modelLimits';

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
  /** The context windows and output limits typed, by model id (empty: none set, the server's figure applies). */
  limits: Record<string, LimitDraft>;
}

/** One model's context window and output limit as typed. */
export interface LimitDraft {
  context: string;
  output: string;
}

export type EndpointProblem = 'name' | 'nameLong' | 'id' | 'idTaken' | 'idReserved' | 'url' | 'models' | 'limits';

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
    // Only what the user set: what the server reported is shown beside, not as a value of their own.
    limits: Object.fromEntries(
      Object.entries(e?.limits ?? {}).flatMap(([model, l]) =>
        l.context || l.output ? [[model, { context: l.context ? String(l.context) : '', output: l.output ? String(l.output) : '' }]] : [],
      ),
    ),
  };
}

/**
 * A number of tokens as typed: digits, with commas, spaces or underscores between them as the user
 * groups them (`32,768`); '' for none; NaN for anything else.
 */
export function tokensTyped(text: string): number | '' {
  const raw = text.trim();
  if (!raw) return '';
  if (!/^\d[\d,_ ]*$/.test(raw)) return NaN;
  return Number(raw.replace(/[,_ ]/g, ''));
}

/** What is typed for one model's limits (both empty when nothing is). */
export function limitDraft(d: Pick<EndpointDraft, 'limits'>, model: string): LimitDraft {
  return Object.hasOwn(d.limits, model) ? d.limits[model]! : { context: '', output: '' };
}

/** The limits typed, with `patch` for one model. */
export function withLimit(d: Pick<EndpointDraft, 'limits'>, model: string, patch: Partial<LimitDraft>): Record<string, LimitDraft> {
  return Object.fromEntries([...Object.entries(d.limits).filter(([m]) => m !== model), [model, { ...limitDraft(d, model), ...patch }]]);
}

/** The limits typed for `models`, as the server takes them; undefined when one is not a number it takes. */
export function limitsTyped(d: Pick<EndpointDraft, 'limits'>, models: readonly string[]): Record<string, TokenLimits> | undefined {
  const out: [string, TokenLimits][] = [];
  for (const model of models) {
    const typed = Object.hasOwn(d.limits, model) ? d.limits[model] : undefined;
    if (!typed) continue;
    const context = tokensTyped(typed.context);
    const output = tokensTyped(typed.output);
    if ((context !== '' && !validContext(context)) || (output !== '' && !validOutput(output))) return undefined;
    if (context !== '' && output !== '' && output >= context) return undefined;
    if (context === '' && output === '') continue;
    out.push([model, { ...(context !== '' ? { context } : {}), ...(output !== '' ? { output } : {}) }]);
  }
  return Object.fromEntries(out);
}

/** What an endpoint's line says of a model's limits: its context window and where it comes from, and its output limit. */
export interface LimitShown {
  model: string;
  context?: number;
  /** The context window is the server's (else the user's). */
  fromServer?: boolean;
  output?: number;
}

/** The limits of an endpoint's models to show on its line, in their order: those that have any. */
export function limitsShown(e: Pick<ModelEndpointView, 'models' | 'limits'>): LimitShown[] {
  return e.models.flatMap((model) => {
    const l = e.limits && Object.hasOwn(e.limits, model) ? e.limits[model] : undefined;
    const context = l?.context ?? l?.reported?.context;
    const output = l?.output;
    if (!context && !output) return [];
    return [
      {
        model,
        ...(context ? { context, ...(l?.context ? {} : { fromServer: true }) } : {}),
        ...(output ? { output } : {}),
      },
    ];
  });
}

/** A number of tokens as the page shows it: `32,768`. */
export function tokenCount(n: number): string {
  return n.toLocaleString('en-US');
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
  if (!limitsTyped(d, models)) out.push('limits');
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
    // Always sent, so that a value taken out is taken out (a model with none gets the server's figure).
    limits: limitsTyped(d, [...new Set(d.models)]) ?? {},
  };
}
