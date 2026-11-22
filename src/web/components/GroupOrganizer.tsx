import { useEffect, useId, useRef, useState } from 'react';
import { REVISE_REQUEST_MAX, type ConversationGroup, type GroupSuggestion } from '../../shared/types';
import { api } from '../api';
import { chosenCount, createKey, moveBlocked, moveKey, renameKey, reorganizeOf, suggestionKeys, targetName } from '../groups';
import { useT } from '../i18n';
import { Logo, LogoSpinner } from './Logo';
import { MetaText, hasMeta } from './MessageItem';
import { useDialog } from './useDialog';

/**
 * The sidebar's "Organize groups", in a dialog: the lead agent reads the conversations' titles and
 * suggests groups to make or rename and conversations to move; the user ticks the ones they want and
 * applies them together. Nothing changes until then. Closing the dialog stops the lead agent.
 */
export function GroupOrganizer({
  groups,
  onApplied,
  onClose,
}: {
  groups: ConversationGroup[];
  onApplied: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const d = t.groupsDraft;
  const titleId = useId();
  const hintId = useId();
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<GroupSuggestion>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, onClose);

  const ask = async () => {
    if (busy) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError('');
    try {
      const s = await api.suggestGroups(request.trim(), ctrl.signal);
      setSuggestion(s);
      setChosen(new Set(suggestionKeys(s)));
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setBusy(false);
    }
  };
  const toggle = (key: string, on: boolean) =>
    setChosen((c) => {
      const next = new Set(c);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const apply = async () => {
    if (!suggestion) return;
    setApplying(true);
    setError('');
    try {
      await api.reorganizeGroups(reorganizeOf(suggestion, chosen));
      onApplied();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const count = suggestion ? chosenCount(suggestion, chosen) : 0;
  const empty = suggestion && !suggestion.create.length && !suggestion.rename.length && !suggestion.move.length;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal group-organizer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id={titleId}>
            <Logo size={18} /> {d.title}
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <div className="group-organizer-body">
          <p className="muted small" id={hintId}>
            {d.hint}
          </p>
          <textarea
            rows={2}
            value={request}
            maxLength={REVISE_REQUEST_MAX}
            placeholder={d.placeholder}
            aria-label={d.placeholder}
            aria-describedby={hintId}
            readOnly={busy}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="team-reviser-actions">
            {busy && (
              <span className="muted small" role="status">
                <LogoSpinner /> {d.working}
              </span>
            )}
            <button
              type="button"
              className={`${busy ? 'ghost' : suggestion ? 'ghost' : 'primary'} small-button`}
              disabled={applying}
              onClick={() => (busy ? abort.current?.abort() : void ask())}
            >
              {busy ? d.stop : suggestion ? d.again : d.ask}
            </button>
          </div>
          {error && (
            <p className="error-line small" role="alert">
              {error}
            </p>
          )}
          {suggestion && !busy && (
            <div className="group-organizer-result" role="status">
              {suggestion.reason && <p>{suggestion.reason}</p>}
              {empty && <p className="muted small">{d.none}</p>}
              {suggestion.create.length > 0 && (
                <fieldset className="group-organizer-section">
                  <legend>{d.create}</legend>
                  {suggestion.create.map((c) => (
                    <label key={c.key} className="check-row">
                      <input
                        type="checkbox"
                        checked={chosen.has(createKey(c.key))}
                        onChange={(e) => toggle(createKey(c.key), e.target.checked)}
                      />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {suggestion.rename.length > 0 && (
                <fieldset className="group-organizer-section">
                  <legend>{d.rename}</legend>
                  {suggestion.rename.map((r) => (
                    <label key={r.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={chosen.has(renameKey(r.id))}
                        onChange={(e) => toggle(renameKey(r.id), e.target.checked)}
                      />
                      <span>{d.renameLine(r.from, r.name)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {suggestion.move.length > 0 && (
                <fieldset className="group-organizer-section">
                  <legend>{d.move}</legend>
                  {suggestion.move.map((m) => {
                    const blocked = moveBlocked(suggestion, chosen, m.to);
                    const to = targetName(suggestion, groups, chosen, m.to, t);
                    return (
                      <label key={m.convId} className={`check-row ${blocked ? 'blocked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={chosen.has(moveKey(m.convId)) && !blocked}
                          disabled={blocked}
                          onChange={(e) => toggle(moveKey(m.convId), e.target.checked)}
                        />
                        <span>
                          <span className="group-organizer-title">{m.title}</span> <span className="muted">{d.moveTo(to)}</span>
                          {blocked && <span className="small muted"> · {d.needsGroup(to)}</span>}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {hasMeta(suggestion.meta) && <MetaText m={suggestion.meta} />}
            </div>
          )}
        </div>
        {suggestion && !empty && !busy && (
          <footer className="template-editor-foot">
            <button type="button" className="link-button" onClick={() => setChosen(new Set(suggestionKeys(suggestion)))}>
              {d.all}
            </button>
            <button type="button" className="link-button" onClick={() => setChosen(new Set())}>
              {d.noneSelected}
            </button>
            <button type="button" className="primary" disabled={applying || count === 0} onClick={() => void apply()}>
              {applying ? d.applying : d.apply(count)}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
