import { API_BACKENDS, parseBackendModel, type LabMode, type LabSettings, type LabsView, type ModelBackendsView } from '../shared/types';

/*
 * Settings → Labs (`components/LabsSettings.tsx`): its pure logic. One mode at a time (`LAB_MODES`); RLM
 * needs a sub-model on a model connection set up now, which the server checks again (`validLabs()`).
 */

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
 * What Save sends for `mode` (and, for RLM, the model typed), or why it cannot yet: no model as
 * `<backend>/<model>`, or one whose connection is not set up (`connections`).
 */
export function labDraft(mode: LabMode, model: string, connections: readonly string[]): { settings?: LabSettings; problem?: LabProblem } {
  if (mode !== 'rlm') return { settings: { mode } };
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
