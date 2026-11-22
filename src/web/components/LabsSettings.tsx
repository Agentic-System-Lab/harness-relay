import { useEffect, useState } from 'react';
import { LAB_MODES, type LabMode, type LabsView, type ModelBackendsView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { labChanged, labConnections, labDraft, labEnvName, labModelSuggestions } from '../labs';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

/**
 * Settings → Labs: experimental ways agents use Harness Relay's own tools, off by default, one at a time
 * (`src/server/runCode.ts`): each explained in plain words, with what it is good for and what it costs.
 */
export function LabsCard() {
  const t = useT();
  const l = t.labs;
  const [view, setView] = useState<LabsView>();
  const [backends, setBackends] = useState<ModelBackendsView>();
  const [mode, setMode] = useState<LabMode>('off');
  const [model, setModel] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);

  const show = (v: LabsView) => {
    setView(v);
    setMode(v.mode);
    setModel(v.rlmModel ?? '');
  };
  useEffect(() => {
    api.labs().then(show, (e: Error) => setNote({ text: e.message, error: true }));
    api.backends().then(setBackends, () => undefined);
  }, []);

  const connections = labConnections(backends);
  const draft = labDraft(mode, model, connections);
  const changed = draft.settings ? labChanged(view, draft.settings) : mode !== view?.mode || model !== (view?.rlmModel ?? '');

  const save = async () => {
    if (!draft.settings) return;
    setBusy(true);
    setNote(undefined);
    try {
      show(await api.updateLabs(draft.settings));
      setNote({ text: l.saved });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card labs-card" id={sectionId('labs')} aria-label={l.title}>
      <SectionTitle section="labs">{l.title}</SectionTitle>
      <p className="muted small">{l.hint}</p>
      {view?.unavailable && <p className="warn-line">{l.unavailable(view.unavailable)}</p>}
      {view?.source === 'env' && <p className="muted small">{l.fromEnv(labEnvName(view))}</p>}

      <fieldset className="labs-options" disabled={!view || busy}>
        <legend className="visually-hidden">{l.title}</legend>
        {LAB_MODES.map((m) => {
          const info = l.modes[m];
          return (
            <label key={m} className={`labs-option${mode === m ? ' on' : ''}`}>
              <input
                type="radio"
                name="labs-mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                aria-labelledby={`labs-${m}-title`}
                aria-describedby={`labs-${m}-body`}
              />
              <span className="labs-option-title" id={`labs-${m}-title`}>
                {info.title}
              </span>
              <span className="labs-option-body" id={`labs-${m}-body`}>
                <span className="small">{info.what}</span>
                {'good' in info && (
                  <span className="labs-tradeoffs">
                    <span>
                      <strong className="small">{l.goodFor}</strong>
                      <ul className="small">
                        {info.good.map((g) => (
                          <li key={g}>{g}</li>
                        ))}
                      </ul>
                    </span>
                    <span>
                      <strong className="small">{l.tradeoffs}</strong>
                      <ul className="small">
                        {info.costs.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </span>
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>

      {mode === 'rlm' && (
        <div className="labs-model">
          <label htmlFor="labs-model" className="small">
            {l.modes.rlm.model}
          </label>
          <input
            id="labs-model"
            list="labs-model-suggestions"
            value={model}
            placeholder="anthropic/claude-haiku-5-5"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="labs-model-suggestions">
            {labModelSuggestions(backends).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <p className="muted small">{connections.length ? l.modes.rlm.modelHint : l.modes.rlm.noConnections}</p>
          {model.trim() && draft.problem && <p className="error-line">{l.problems[draft.problem]}</p>}
        </div>
      )}

      <div className="button-row">
        <button className="primary" onClick={() => void save()} disabled={!view || busy || !draft.settings || !changed}>
          {t.common.save}
        </button>
      </div>
      {note && <p className={note.error ? 'error-line' : 'muted small'}>{note.text}</p>}
    </section>
  );
}
