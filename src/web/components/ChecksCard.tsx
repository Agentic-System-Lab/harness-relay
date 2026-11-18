import { useRef, useState } from 'react';
import type { AgentConfig, ChatMessage, CheckFinding, CheckOutcome } from '../../shared/types';
import { applyAnyway, cardActions, fixCandidates, gatedFiles } from '../checks';
import { useT } from '../i18n';
import { formatDuration } from '../util';

interface Props {
  msg: ChatMessage;
  /** The conversation's latest result: only it offers anything. */
  latest: boolean;
  agents: readonly AgentConfig[];
  running: boolean;
  /** `confirm`: run the commands the run's changes kept from running. */
  onRecheck: (messageId: string, confirm?: boolean) => Promise<unknown>;
  onSkip: (messageId: string) => Promise<unknown>;
  onFix: (messageId: string, agentId: string) => Promise<unknown>;
  /**
   * Apply a member's parallel-mode result that the checks held back: without checking (`force`, its
   * card's "Apply anyway"), or having the commands run that its changed settings held back (`confirm`).
   */
  onApplyAnyway: (agentId: string, how: 'force' | 'confirm') => Promise<unknown>;
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

/** A command's result: its command line, how it ended, why it could not run, what it changed itself, and the end of its output. */
export function CommandOutcome({ o }: { o: CheckOutcome }) {
  const t = useT();
  const ended = [
    o.exitCode !== undefined ? t.checks.exit(o.exitCode) : '',
    o.durationMs !== undefined ? t.checks.took(formatDuration(o.durationMs)) : '',
  ].filter(Boolean);
  return (
    <>
      <div className="checks-rule">
        <span className={`checks-status ${o.status}`}>{t.checks.status[o.status]}</span>
        <span>{t.checks.rules.command}</span>
        <code className="checks-command">{o.command}</code>
        {ended.length > 0 && <span className="muted small">{ended.join(' · ')}</span>}
      </div>
      {o.reason && <p className="small muted checks-reason">{o.reason}</p>}
      {o.wroteFiles?.length ? <p className="small warn-text checks-reason">{t.checks.wrote(o.wroteFiles.join(', '))}</p> : null}
      {o.unsandboxed && <p className="small muted checks-reason">{t.checks.unsandboxed}</p>}
      {o.output && (
        <details className="checks-output small">
          <summary>{t.checks.output}</summary>
          <pre>{o.output}</pre>
        </details>
      )}
    </>
  );
}

/**
 * The team checks' result after the team's replies (`ChatMessage.checks`): each rule and what it found.
 * The latest result offers Check again, and while it fails, Ask a member to fix it and Skip.
 */
export function ChecksCard({ msg, latest, agents, running, onRecheck, onSkip, onFix, onApplyAnyway }: Props) {
  const t = useT();
  const c = msg.checks!;
  const actions = cardActions(msg, latest, running);
  const heldFor = applyAnyway(msg, latest, running);
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
        {c.when === 'apply' && c.applyOf && <span className="muted small">{t.checks.whenApply(c.applyOf.name)}</span>}
      </header>
      <ul className="checks-outcomes">
        {c.outcomes.map((o) =>
          o.rule === 'command' ? (
            <li key={`command:${o.commandId}`}>
              <CommandOutcome o={o} />
            </li>
          ) : (
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
          ),
        )}
      </ul>
      {c.stale && <p className="small warn-text checks-note">{t.checks.stale}</p>}
      {c.when === 'apply' && c.applied && <p className="small muted checks-note">{t.checks.applied}</p>}
      {heldFor && <p className="small warn-text checks-note">{t.checks.held}</p>}
      {c.skippedAt ? (
        <p className="small muted checks-note">{t.checks.skipped}</p>
      ) : (
        c.fixBy && <p className="small muted checks-note">{t.checks.fixBy(c.fixBy)}</p>
      )}
      <div className="plan-actions">
        {actions.recheck && !actions.confirm && (
          <button type="button" className="ghost small-button" onClick={() => void act(() => onRecheck(msg.id))}>
            {t.checks.recheck}
          </button>
        )}
        {actions.confirm && (
          <button
            type="button"
            className="ghost small-button"
            onClick={() => confirm(t.checks.confirmRunAsk(gatedFiles(msg).join('\n'))) && void act(() => onRecheck(msg.id, true))}
          >
            {t.checks.confirmRun}
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
        {heldFor && (
          <button
            type="button"
            className="ghost small-button"
            onClick={() => confirm(t.checks.applyAnywayAsk(c.applyOf!.name)) && void act(() => onApplyAnyway(heldFor, 'force'))}
          >
            {t.checks.applyAnyway}
          </button>
        )}
        {heldFor && gatedFiles(msg).length > 0 && (
          <button
            type="button"
            className="ghost small-button"
            onClick={() => confirm(t.checks.confirmRunAsk(gatedFiles(msg).join('\n'))) && void act(() => onApplyAnyway(heldFor, 'confirm'))}
          >
            {t.checks.confirmApply}
          </button>
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
