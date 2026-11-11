import { useEffect, useState } from 'react';
import { API_BACKEND_LABEL, BACKEND_LIMITS, type ApiBackend, type ModelBackendsView, type ModelEndpointView } from '../../shared/types';
import { api } from '../api';
import { endpointDraft, endpointProblems, endpointSlug, endpointUpdate, type EndpointDraft, type EndpointProblem } from '../backends';
import { useT } from '../i18n';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

type Note = { text: string; error?: boolean };

/**
 * Settings → Model backends: what the open agents (OpenCode, Goose, Cline, OpenHands, Pi) run their
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
      return false;
    }
  };

  const b = t.settings.backends;
  return (
    <section className="card" id={sectionId('backends')}>
      <SectionTitle section="backends">{b.title}</SectionTitle>
      <p className="muted small">{b.hint}</p>
      <p className="muted small">{b.noSubscription}</p>
      <p className="muted small">{b.modelIds}</p>

      <h4>{b.apiKeys}</h4>
      {view?.apis.map((a) => (
        <ApiKeyRow
          key={a.id}
          id={a.id}
          view={a}
          onSave={(key) => apply(() => api.setBackendKey(a.id, key), key ? t.settings.keySaved : t.settings.keyRemoved)}
        />
      ))}

      <h4>{b.endpoints}</h4>
      <p className="muted small">{b.endpointsHint}</p>
      {view && <Endpoints endpoints={view.endpoints} apply={apply} />}

      {note.text && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </section>
  );
}

function ApiKeyRow({
  id,
  view,
  onSave,
}: {
  id: ApiBackend;
  view: ModelBackendsView['apis'][number];
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
      <p className="muted small">
        {t.settings.keyStorage(t.settings.keyStorageName[view.keyStorage])}
        {view.keyUnreadable && ` ${b.keyUnreadable}`}
      </p>
      <div className="input-row">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" aria-label={`${API_BACKEND_LABEL[id]} ${b.apiKeys}`} />
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
  /** The endpoint being edited: its id, '' for a new one, undefined for none. */
  const [editing, setEditing] = useState<string | undefined>();
  const current = endpoints.find((e) => e.id === editing);

  return (
    <>
      {!endpoints.length && <p className="muted small">{b.noEndpoints}</p>}
      {endpoints.map((e) =>
        editing === e.id ? (
          <EndpointForm
            key={e.id}
            endpoint={e}
            endpoints={endpoints}
            onCancel={() => setEditing(undefined)}
            onSave={async (d) => {
              if (await apply(() => api.saveEndpoint(e.id, endpointUpdate(d)), b.saved)) setEditing(undefined);
            }}
          />
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
            <div className="button-row">
              <button className="ghost" onClick={() => setEditing(e.id)}>
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
      {editing === '' && !current ? (
        <EndpointForm
          endpoints={endpoints}
          onCancel={() => setEditing(undefined)}
          onSave={async (d) => {
            if (await apply(() => api.saveEndpoint(d.id.trim(), endpointUpdate(d)), b.saved)) setEditing(undefined);
          }}
        />
      ) : (
        <div className="button-row">
          <button className="ghost" onClick={() => setEditing('')} disabled={editing !== undefined}>
            ＋ {b.addEndpoint}
          </button>
        </div>
      )}
    </>
  );
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
  const problems = endpointProblems(d, endpoints, endpoint?.id);
  const problemText = (p: EndpointProblem): string =>
    p === 'models'
      ? b.problems.models(BACKEND_LIMITS.maxModels, BACKEND_LIMITS.maxModelId)
      : p === 'nameLong'
        ? b.problems.nameLong(BACKEND_LIMITS.maxName)
        : b.problems[p];
  const set = (patch: Partial<EndpointDraft>) => setD((cur) => ({ ...cur, ...patch }));

  return (
    <div className="sub-body">
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
        <span>{b.models}</span>
        <textarea rows={3} value={d.models} placeholder={b.modelsPlaceholder} spellCheck={false} onChange={(e) => set({ models: e.target.value })} />
      </label>
      <label className="field">
        <span>{b.endpointKey}</span>
        <input
          type="password"
          value={d.apiKey}
          autoComplete="off"
          placeholder={endpoint?.keyMasked ? b.endpointKeyKeep : ''}
          onChange={(e) => set({ apiKey: e.target.value, removeKey: false })}
        />
      </label>
      {endpoint?.keyMasked && (
        <label className="field inline">
          <input type="checkbox" checked={d.removeKey} onChange={(e) => set({ removeKey: e.target.checked, apiKey: '' })} />
          <span>{b.removeKey}</span>
        </label>
      )}
      {problems.map((p) => (
        <p key={p} className="warn-line">
          {problemText(p)}
        </p>
      ))}
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || problems.length > 0}
          onClick={async () => {
            setBusy(true);
            await onSave(d);
            setBusy(false);
          }}
        >
          {t.common.save}
        </button>
        <button className="ghost" onClick={onCancel} disabled={busy}>
          {t.common.cancel}
        </button>
      </div>
    </div>
  );
}
