import {
  API_BACKENDS,
  accountUsable,
  catalogFor,
  cliSubModelId,
  parseBackendModel,
  parseCliSubModel,
  SUB_MODEL_CLIS,
  type LabMode,
  type LabSettings,
  type LabsView,
  type ModelBackendsView,
  type ProviderModels,
  type ProviderStatus,
  type SubModelCli,
} from '../shared/types';

/*
 * Settings → Labs (`components/LabsSettings.tsx`): its pure logic. One mode at a time (`LAB_MODES`); RLM
 * needs a sub-model on a model connection set up now, or one of the accounts of a CLI it can be asked
 * through (`SUB_MODEL_CLIS`), which the server checks again (`validLabs()`).
 */

/** Where RLM's sub-model is asked: a model connection, or a CLI as one of its accounts (`''`: the default one). */
export type LabSource = { kind: 'connection' } | { kind: 'cli'; provider: SubModelCli; account: string };

/** A source as the source box's value: `connection`, or `cli:<provider>:<account>`. */
export const labSourceKey = (s: LabSource): string => (s.kind === 'connection' ? 'connection' : `cli:${s.provider}:${s.account}`);

/** The source a key names (`labSourceKey`); a model connection for any other. */
export function labSourceOf(key: string): LabSource {
  const m = /^cli:([a-z]+):([a-z0-9]*)$/.exec(key);
  return m && (SUB_MODEL_CLIS as readonly string[]).includes(m[1]!)
    ? { kind: 'cli', provider: m[1] as SubModelCli, account: m[2]! }
    : { kind: 'connection' };
}

/** A saved sub-model as the form shows it: its source, and the model typed for it (through a CLI: empty for the account's default). */
export function labChoice(rlmModel: string | undefined): { source: LabSource; model: string } {
  const cli = rlmModel ? parseCliSubModel(rlmModel) : undefined;
  if (cli) return { source: { kind: 'cli', provider: cli.provider, account: cli.account }, model: cli.model ?? '' };
  return { source: { kind: 'connection' }, model: rlmModel ?? '' };
}

/** One account of a CLI the sub-model can be asked through, as the source box lists it. */
export interface LabCliAccount {
  provider: SubModelCli;
  /** Empty: the default account. */
  account: string;
  /** The name the user gave it; empty = none. */
  label: string;
  /** Signed in (or it could not be told), or with an API key. */
  usable: boolean;
}

/** The accounts of the installed CLIs the sub-model can be asked through, in `SUB_MODEL_CLIS` order, each CLI's default account first. */
export function labCliAccounts(providers: readonly ProviderStatus[]): LabCliAccount[] {
  return SUB_MODEL_CLIS.flatMap((p) => {
    const status = providers.find((s) => s.provider === p);
    if (!status?.installed) return [];
    return status.accounts.map((a) => ({ provider: p, account: a.id, label: a.label, usable: accountUsable(a) }));
  });
}

/** What the model box suggests through a CLI: that account's models (not those of the user's own endpoints, which a model connection asks directly). */
export function labCliModels(catalog: readonly ProviderModels[], source: LabSource): string[] {
  if (source.kind !== 'cli') return [];
  return (catalogFor(catalog, source.provider, source.account || undefined)?.models ?? []).filter((m) => !m.endpoint).map((m) => m.id);
}

/** The model connections a sub-model can be on now: the API backends with a key, and the endpoints (by id). */
export function labConnections(b: ModelBackendsView | undefined): string[] {
  if (!b) return [];
  return [...b.apis.filter((a) => a.keyMasked).map((a) => a.id), ...b.endpoints.map((e) => e.id)];
}

/** What the sub-model box suggests: each endpoint's models as `<id>/<model>`, then `<api>/` for each API backend with a key. */
export function labModelSuggestions(b: ModelBackendsView | undefined): string[] {
  if (!b) return [];
  return [
    ...b.endpoints.flatMap((e) => e.models.map((m) => `${e.id}/${m}`)),
    ...API_BACKENDS.filter((id) => b.apis.some((a) => a.id === id && a.keyMasked)).map((id) => `${id}/`),
  ];
}

/** Why a draft cannot be saved yet. */
export type LabProblem = 'model' | 'connection';

/**
 * What Save sends for `mode` (and, for RLM, the model typed from its source), or why it cannot yet: on a
 * model connection, no model as `<backend>/<model>`, or one whose connection is not set up
 * (`connections`). Through a CLI any model, or none (the account's default), will do.
 */
export function labDraft(
  mode: LabMode,
  model: string,
  connections: readonly string[],
  source: LabSource = { kind: 'connection' },
): { settings?: LabSettings; problem?: LabProblem } {
  if (mode !== 'rlm') return { settings: { mode } };
  if (source.kind === 'cli') {
    const typed = model.trim().replace(/\s+/g, '');
    return {
      settings: {
        mode: 'rlm',
        rlmModel: cliSubModelId({ provider: source.provider, account: source.account, ...(typed ? { model: typed } : {}) }),
      },
    };
  }
  const id = model.trim();
  const parsed = id ? parseBackendModel(id) : undefined;
  if (!parsed) return { problem: 'model' };
  if (!connections.includes(parsed.backend)) return { problem: 'connection' };
  return { settings: { mode: 'rlm', rlmModel: id } };
}

/** Whether a draft differs from what is on now (a setting from the environment counts as not saved: saving keeps it here). */
export function labChanged(view: LabsView | undefined, draft: LabSettings): boolean {
  if (!view) return false;
  if (view.source === 'env') return true;
  return view.mode !== draft.mode || (draft.mode === 'rlm' && view.rlmModel !== draft.rlmModel);
}

/** The environment variable a setting from the environment came from. */
export const labEnvName = (view: LabsView): string => (view.mode === 'rlm' ? 'RELAY_RLM' : 'RELAY_RUN_CODE');
