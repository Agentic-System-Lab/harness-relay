import { useEffect, useRef, useState } from 'react';
import {
  API_BACKEND_LABEL,
  BACKEND_LIMITS,
  ENDPOINT_METADATA_UNAVAILABLE,
  type ApiBackend,
  type ModelBackendsView,
  type ModelEndpointView,
} from '../../shared/types';
import { api, ApiError } from '../api';
import {
  endpointDraft,
  endpointProblems,
  endpointSlug,
  endpointUpdate,
  limitDraft,
  limitsShown,
  normalizedBaseUrl,
  parseModelList,
  tokenCount,
  validBaseUrl,
  withLimit,
  type EndpointDraft,
  type EndpointProblem,
} from '../backends';
import { MODEL_LIMIT_RANGE } from '../../shared/modelLimits';
import { useT } from '../i18n';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

type Note = { text: string; error?: boolean };

/**
 * Settings → Model connections: what the open agents (OpenCode, Goose, Cline, OpenHands, Pi) run their
 * models on. An API key for OpenAI, Anthropic and xAI each, and the user's own OpenAI-compatible
 * endpoints. Keys are only ever shown masked.
 */
export function BackendsCard({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [view, setView] = useState<ModelBackendsView | null>(null);
  const [note, setNote] = useState<Note>({ text: '' });

  useEffect(() => {
    api.backends().then(setView, (e: Error) => setNote({ text: e.message, error: true }));
  }, []);

  const apply = async (call: () => Promise<ModelBackendsView>, done: string): Promise<boolean> => {
    try {
      setView(await call());
      setNote({ text: done });
      onChanged();
      return true;
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
      // A change can fail part way (an endpoint saved while the credential store refused its key):
      // show what is saved now, and let the model menus and the agents' status catch up.
      api.backends().then(setView, () => undefined);
      onChanged();
      return false;
    }
  };

  const b = t.settings.backends;
  const firstStorage = view?.apis[0]?.keyStorage;
  const sharedStorage = view?.apis.every((a) => a.keyStorage === firstStorage) && firstStorage;
  return (
    <section className="card" id={sectionId('backends')}>
      <SectionTitle section="backends">{b.title}</SectionTitle>
      <details className="sub model-connection backend-keys">
        <summary aria-labelledby="model-keys-title" aria-describedby="model-keys-access">
          <span className="connection-title" id="model-keys-title">
            {b.providerKeys}
          </span>
          <span className="connection-access muted small" id="model-keys-access">
            {b.hint}
          </span>
        </summary>
        <div className="sub-body">
          {view?.apis.map((a) => (
            <ApiKeyRow
              key={a.id}
              id={a.id}
              view={a}
              showStorage={!sharedStorage}
              onSave={(key) => apply(() => api.setBackendKey(a.id, key), key ? t.settings.keySaved : t.settings.keyRemoved)}
            />
          ))}

          {sharedStorage && <p className="muted small">{t.settings.keyStorage(t.settings.keyStorageName[sharedStorage])}</p>}
        </div>
      </details>
      <details className="sub model-connection backend-endpoints">
        <summary aria-labelledby="model-endpoint-title" aria-describedby="model-endpoint-access">
          <span className="connection-title" id="model-endpoint-title">
            {b.endpoints}
          </span>
          <span id="model-endpoint-access" className="connection-access muted small">
            {b.endpointAccess}
          </span>
        </summary>
        <div className="sub-body">
          <p className="muted small">{b.endpointsHint}</p>
          {view && <Endpoints endpoints={view.endpoints} apply={apply} />}

          {view && view.deletedEndpoints.length > 0 && (
            <>
              <h4>{b.deletedEndpoints}</h4>
              <p className="muted small">{b.deletedEndpointsHint}</p>
              {view.deletedEndpoints.map((id) => (
                <div key={id} className="field">
                  <span>
                    <code>{id}/…</code>
                  </span>
                  <div className="button-row">
                    <button className="ghost" onClick={() => void apply(() => api.forgetDeletedEndpoint(id), b.forgotten(id))}>
                      {b.forgetDeleted}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </details>

      {note.text && (
        <p role={note.error ? 'alert' : 'status'} className={note.error ? 'error-line' : 'muted small'}>
          {note.text}
        </p>
      )}
    </section>
  );
}

function ApiKeyRow({
  id,
  view,
  showStorage,
  onSave,
}: {
  id: ApiBackend;
  view: ModelBackendsView['apis'][number];
  showStorage: boolean;
  onSave: (key: string | null) => Promise<boolean>;
}) {
  const t = useT();
  const b = t.settings.backends;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (value: string | null) => {
    setBusy(true);
    if (await onSave(value)) setKey('');
    setBusy(false);
  };
  return (
    <div className="field">
      <span>
        {API_BACKEND_LABEL[id]} · <span className="muted small">{view.keyMasked ? b.keySet(view.keyMasked) : b.notSet}</span>
      </span>
      {showStorage && <p className="muted small">{t.settings.keyStorage(t.settings.keyStorageName[view.keyStorage])}</p>}
      {view.keyUnreadable && <p className="warn-line">{b.keyUnreadable}</p>}
      <div className="input-row">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          aria-label={`${API_BACKEND_LABEL[id]} ${b.apiKeys}`}
        />
        <button className="primary" onClick={() => void run(key)} disabled={busy || !key.trim()}>
          {t.common.save}
        </button>
        {view.keyMasked && (
          <button className="ghost" onClick={() => void run(null)} disabled={busy}>
            {t.common.remove}
          </button>
        )}
      </div>
    </div>
  );
}

function Endpoints({
  endpoints,
  apply,
}: {
  endpoints: ModelEndpointView[];
  apply: (call: () => Promise<ModelBackendsView>, done: string) => Promise<boolean>;
}) {
  const t = useT();
  const b = t.settings.backends;
  /** Each edit has a distinct identity, even when a user returns to the same endpoint during a save. */
  const [editing, setEditing] = useState<{ id: string }>();
  const current = endpoints.find((e) => e.id === editing?.id);
  const save = async (draft: EndpointDraft) => {
    const id = draft.id.trim();
    const update = endpointUpdate(draft);
    const saved = await apply(async () => {
      try {
        return await api.saveEndpoint(id, update);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== ENDPOINT_METADATA_UNAVAILABLE) throw err;
        if (!window.confirm(`${err.message}\n\n${b.confirmUnverifiedModels}`)) throw err;
        return api.saveEndpoint(id, { ...update, allowMissingMetadata: true });
      }
    }, b.saved);
    if (saved) setEditing((open) => (open === editing ? undefined : open));
  };

  return (
    <>
      {!endpoints.length && <p className="muted small">{b.noEndpoints}</p>}
      {endpoints.map((e) =>
        editing?.id === e.id ? (
          <EndpointForm key={e.id} endpoint={e} endpoints={endpoints} onCancel={() => setEditing(undefined)} onSave={save} />
        ) : (
          <div key={e.id} className="field">
            <span>
              {e.name} <code>{e.id}/…</code>
            </span>
            <p className="muted small">
              {e.baseUrl}
              {e.models.length ? ` · ${e.models.join(', ')}` : ''}
              {e.keyMasked ? ` · ${b.keySet(e.keyMasked)}` : ''}
              {e.keyUnreadable && ` · ${b.keyUnreadable}`}
            </p>
            <EndpointLimitsLine endpoint={e} />
            <div className="button-row">
              <button className="ghost" onClick={() => setEditing({ id: e.id })}>
                {b.editEndpoint}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  if (confirm(b.confirmDelete(e.name))) void apply(() => api.deleteEndpoint(e.id), b.deleted);
                }}
              >
                {b.deleteEndpoint}
              </button>
            </div>
          </div>
        ),
      )}
      {editing?.id === '' && !current ? (
        <EndpointForm endpoints={endpoints} onCancel={() => setEditing(undefined)} onSave={save} />
      ) : (
        <div className="button-row">
          <button className="ghost" onClick={() => setEditing({ id: '' })} disabled={editing !== undefined}>
            ＋ {b.addEndpoint}
          </button>
        </div>
      )}
    </>
  );
}

/** An endpoint's line in the list: its models' context windows (where each comes from) and output limits. */
function EndpointLimitsLine({ endpoint }: { endpoint: ModelEndpointView }) {
  const b = useT().settings.backends;
  const shown = limitsShown(endpoint);
  if (!shown.length) return null;
  const items = shown.map((l) =>
    b.limitItem(l.model, l.context ? tokenCount(l.context) : undefined, Boolean(l.fromServer), l.output ? tokenCount(l.output) : undefined),
  );
  return <p className="muted small">{b.limitsSummary(items.join(' · '))}</p>;
}

function EndpointForm({
  endpoint,
  endpoints,
  onSave,
  onCancel,
}: {
  /** The endpoint to change; absent for a new one. */
  endpoint?: ModelEndpointView;
  endpoints: ModelEndpointView[];
  onSave: (d: EndpointDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const b = t.settings.backends;
  const [d, setD] = useState<EndpointDraft>(() => endpointDraft(endpoint));
  /** A new endpoint's id follows its name until the id is typed. */
  const [idTyped, setIdTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [extraModels, setExtraModels] = useState('');
  const [catalog, setCatalog] = useState<string[]>();
  const [catalogError, setCatalogError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const selected = new Set([...d.models, ...parseModelList(extraModels)]);
  const saveDraft = { ...d, models: [...selected] };
  const problems = endpointProblems(saveDraft, endpoints, endpoint?.id);
  const choices = [...new Set([...(catalog ?? []), ...(endpoint?.models ?? []), ...d.models])];
  const changedUrl = endpoint && normalizedBaseUrl(d.baseUrl) !== endpoint.baseUrl;
  const resetCatalog = () => {
    request.current?.abort();
    setLoading(false);
    setCatalog(undefined);
    setCatalogError('');
  };
  const loadModels = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setCatalogError('');
    try {
      const { apiKey, baseUrl } = endpointUpdate(d);
      const result = await api.endpointModels({ baseUrl, endpointId: endpoint?.id, apiKey }, controller.signal);
      if (!controller.signal.aborted) setCatalog(result.models);
    } catch (error) {
      if (!controller.signal.aborted) setCatalogError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const problemText = (p: EndpointProblem): string =>
    p === 'models'
      ? b.problems.models(BACKEND_LIMITS.maxModels, BACKEND_LIMITS.maxModelId)
      : p === 'nameLong'
        ? b.problems.nameLong(BACKEND_LIMITS.maxName)
        : p === 'limits'
          ? b.problems.limits(tokenCount(MODEL_LIMIT_RANGE.minContext), tokenCount(MODEL_LIMIT_RANGE.maxContext))
          : b.problems[p];
  const set = (patch: Partial<EndpointDraft>) => {
    if ('baseUrl' in patch || 'apiKey' in patch || 'removeKey' in patch) resetCatalog();
    setD((cur) => {
      const next = { ...cur, ...patch };
      if (patch.baseUrl !== undefined && cur.apiKey) {
        const before = normalizedBaseUrl(cur.baseUrl);
        if (before && before !== normalizedBaseUrl(patch.baseUrl)) next.apiKey = '';
      }
      return next;
    });
  };

  return (
    <fieldset className="endpoint-editor sub-body" disabled={busy}>
      <label className="field">
        <span>{b.name}</span>
        <input
          value={d.name}
          placeholder={b.namePlaceholder}
          onChange={(e) => set({ name: e.target.value, ...(!endpoint && !idTyped ? { id: endpointSlug(e.target.value) } : {}) })}
        />
      </label>
      <label className="field">
        <span>{b.id}</span>
        <input
          value={d.id}
          disabled={Boolean(endpoint)}
          spellCheck={false}
          onChange={(e) => {
            setIdTyped(true);
            set({ id: e.target.value });
          }}
        />
      </label>
      <label className="field">
        <span>{b.baseUrl}</span>
        <input value={d.baseUrl} placeholder={b.baseUrlPlaceholder} spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} />
      </label>
      <label className="field">
        <span>{b.endpointKey}</span>
        <input
          type="password"
          value={d.apiKey}
          autoComplete="off"
          placeholder={endpoint?.keyMasked && !changedUrl ? b.endpointKeyKeep : ''}
          onChange={(e) => set({ apiKey: e.target.value, removeKey: false })}
        />
      </label>
      {changedUrl && endpoint?.keyMasked && <p className="muted small">{b.keyAtNewUrl}</p>}
      {endpoint?.keyMasked && !changedUrl && (
        <label className="check-row">
          <input type="checkbox" checked={d.removeKey} onChange={(e) => set({ removeKey: e.target.checked, apiKey: '' })} />
          <span>{b.removeKey}</span>
        </label>
      )}
      <div className="button-row">
        <button type="button" className="ghost" disabled={!validBaseUrl(d.baseUrl) || loading || busy} onClick={() => void loadModels()}>
          {loading ? b.loadingModels : b.loadModels}
        </button>
      </div>
      {catalogError && (
        <p role="alert" className="error-line">
          {catalogError}
        </p>
      )}
      {catalog?.length === 0 && (
        <p role="status" className="muted small">
          {b.noModelsFound}
        </p>
      )}
      {choices.length > 0 && (
        <fieldset className="endpoint-models">
          <legend>{b.chooseModels}</legend>
          {choices.length > BACKEND_LIMITS.maxModels && <p className="muted small">{b.selectionLimit(BACKEND_LIMITS.maxModels)}</p>}
          <div className="endpoint-model-options">
            {choices.map((model) => (
              <label className="check-row" key={model}>
                <input
                  type="checkbox"
                  checked={selected.has(model)}
                  disabled={!selected.has(model) && selected.size >= BACKEND_LIMITS.maxModels}
                  onChange={(event) => {
                    if (event.target.checked) set({ models: [...d.models, model] });
                    else {
                      set({ models: d.models.filter((id) => id !== model) });
                      setExtraModels(
                        parseModelList(extraModels)
                          .filter((id) => id !== model)
                          .join('\n'),
                      );
                    }
                  }}
                />
                <span>{model}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <details className="sub">
        <summary>{b.manualModels}</summary>
        <label className="field sub-body">
          <span>{b.models}</span>
          <textarea
            rows={3}
            value={extraModels}
            placeholder={b.modelsPlaceholder}
            spellCheck={false}
            onChange={(event) => setExtraModels(event.target.value)}
          />
        </label>
      </details>
      {saveDraft.models.length > 0 && (
        <details className="sub">
          <summary>{b.limitsTitle}</summary>
          <div className="sub-body">
            <p className="muted small">{b.limitsHint}</p>
            {saveDraft.models.map((model) => {
              const typed = limitDraft(d, model);
              // What the server reported is of the address it was saved with.
              const saved = !changedUrl && endpoint?.limits && Object.hasOwn(endpoint.limits, model) ? endpoint.limits[model] : undefined;
              const reported = saved?.reported?.context;
              return (
                <fieldset key={model} className="endpoint-models">
                  <legend>
                    <code>{model}</code>
                  </legend>
                  <div className="endpoint-limit-fields">
                    <label className="field">
                      <span>{b.contextWindow}</span>
                      <input
                        inputMode="numeric"
                        value={typed.context}
                        placeholder={reported ? b.fromServer(tokenCount(reported)) : b.askedAtSave}
                        spellCheck={false}
                        onChange={(e) => set({ limits: withLimit(d, model, { context: e.target.value }) })}
                      />
                    </label>
                    <label className="field">
                      <span>{b.outputLimit}</span>
                      <input
                        inputMode="numeric"
                        value={typed.output}
                        placeholder={b.outputUnset}
                        spellCheck={false}
                        onChange={(e) => set({ limits: withLimit(d, model, { output: e.target.value }) })}
                      />
                    </label>
                  </div>
                </fieldset>
              );
            })}
          </div>
        </details>
      )}
      {problems.map((p) => (
        <p key={p} className="warn-line">
          {problemText(p)}
        </p>
      ))}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || loading || problems.length > 0}
          onClick={async () => {
            setBusy(true);
            await onSave(saveDraft);
            setBusy(false);
          }}
        >
          {busy ? b.checkingBeforeSave : t.common.save}
        </button>
        <button className="ghost" onClick={onCancel} disabled={busy}>
          {t.common.cancel}
        </button>
      </div>
    </fieldset>
  );
}
