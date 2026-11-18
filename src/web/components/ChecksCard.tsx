import { useRef, useState } from 'react';
import type { AgentConfig, ChatMessage, CheckFinding } from '../../shared/types';
import { cardActions, fixCandidates } from '../checks';
import { useT } from '../i18n';

interface Props {
  msg: ChatMessage;
  /** The conversation's latest result: only it offers anything. */
  latest: boolean;
  agents: readonly AgentConfig[];
  running: boolean;
  onRecheck: (messageId: string) => Promise<unknown>;
  onSkip: (messageId: string) => Promise<unknown>;
  onFix: (messageId: string, agentId: string) => Promise<unknown>;
}

/** One finding: the file and what happened to it, or the commit and its subject; and whose turn it was in. */
function Finding({ f }: { f: CheckFinding }) {
  const t = useT();
  const where = f.folder ? ` · ${f.folder}` : '';
  const whose = f.by ? (f.worktree ? t.checks.inWorktree(f.by) : t.checks.by(f.by)) : '';
  return (
    <li>
      <code>{f.commit ?? f.path}</code>
      {f.commit ? <span className="checks-subject"> {f.subject}</span> : <span> {f.change ? t.checks.change[f.change] : ''}</span>}
      {(where || whose) && (
        <span className="muted">
          {where}
          {whose && ` · ${whose}`}
        </span>
      )}
    </li>
  );
}

/**
 * The team checks' result after the team's replies (`ChatMessage.checks`): each rule and what it found.
 * The latest result offers Check again, and while it fails, Ask a member to fix it and Skip.
 */
export function ChecksCard({ msg, latest, agents, running, onRecheck, onSkip, onFix }: Props) {
  const t = useT();
  const c = msg.checks!;
  const actions = cardActions(msg, latest, running);
  // A ref, not state: a quick double click arrives before React re-renders.
  const busy = useRef(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(t.checks.failedAction((err as Error).message));
    } finally {
      busy.current = false;
    }
  };
  const candidates = actions.fix ? fixCandidates(msg, agents) : [];

  return (
    <section className={`plan-card checks-card ${c.status}${c.stale ? ' stale' : ''}`} aria-label={t.checks.title}>
      <header className="plan-head">
        <strong>{t.checks.title}</strong>
        <span className={`checks-status ${c.status}`}>{t.checks.status[c.status]}</span>
        {c.when === 'pause' && <span className="muted small">{t.checks.whenPause}</span>}
        {c.when === 'recheck' && <span className="muted small">{t.checks.whenRecheck}</span>}
      </header>
      <ul className="checks-outcomes">
        {c.outcomes.map((o) => (
          <li key={o.rule}>
            <div className="checks-rule">
              <span className={`checks-status ${o.status}`}>{t.checks.status[o.status]}</span>
              <span>{t.checks.rules[o.rule]}</span>
            </div>
            {o.reason && <p className="small muted checks-reason">{o.reason}</p>}
            {Boolean(o.findings?.length) && (
              <ul className="checks-findings small">
                {o.findings!.map((f, i) => (
                  <Finding key={i} f={f} />
                ))}
                {Boolean(o.more) && <li className="muted">{t.checks.more(o.more!)}</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {c.stale && <p className="small warn-text checks-note">{t.checks.stale}</p>}
      {c.skippedAt ? (
        <p className="small muted checks-note">{t.checks.skipped}</p>
      ) : (
        c.fixBy && <p className="small muted checks-note">{t.checks.fixBy(c.fixBy)}</p>
      )}
      <div className="plan-actions">
        {actions.recheck && (
          <button type="button" className="ghost small-button" onClick={() => void act(() => onRecheck(msg.id))}>
            {t.checks.recheck}
          </button>
        )}
        {candidates.length > 0 && (
          <select
            className="small-button checks-fix"
            aria-label={t.checks.fix}
            value=""
            onChange={(e) => {
              const agentId = e.target.value;
              if (agentId) void act(() => onFix(msg.id, agentId));
            }}
          >
            <option value="">{t.checks.fix}</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {t.checks.fixAs(a.name)}
              </option>
            ))}
          </select>
        )}
        {actions.skip && (
          <button
            type="button"
            className="ghost small-button"
            onClick={() => confirm(t.checks.skipConfirm) && void act(() => onSkip(msg.id))}
          >
            {t.checks.skip}
          </button>
        )}
        <span className="msg-meta muted small">{t.checks.afterFact}</span>
      </div>
      {error && (
        <p className="small warn-text plan-note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
