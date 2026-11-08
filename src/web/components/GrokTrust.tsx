import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, ConversationSettings } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

/**
 * Whether starting this team should first ask about Grok's trust in its folder: it has a Grok member
 * (an auto team has none yet) and a folder.
 */
export function asksGrokTrust(team: { agents: AgentConfig[]; settings: Pick<ConversationSettings, 'cwd' | 'autoTeam'> }): boolean {
  return !team.settings.autoTeam && Boolean(team.settings.cwd.trim()) && team.agents.some((a) => a.provider === 'grok');
}

export type GrokTrustAnswer = 'trust' | 'skip' | 'cancel';

/** Asked before a team with a Grok member starts in a folder Grok does not trust. */
export function GrokTrustDialog({ cwd, onAnswer }: { cwd: string; onAnswer: (a: GrokTrustAnswer) => void }) {
  const t = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, () => onAnswer('cancel'));
  return (
    <div className="modal-scrim" onClick={() => onAnswer('cancel')}>
      <div
        ref={dialog}
        className="modal grok-trust-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t.grokTrust.dialogTitle}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.grokTrust.dialogTitle}</h2>
          <button className="icon-button" onClick={() => onAnswer('cancel')} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p>{t.grokTrust.dialogBody}</p>
        <p>
          <code className="grok-trust-path">{cwd}</code>
        </p>
        <p className="warn-line small">{t.grokTrust.dialogWarn}</p>
        <footer className="button-row end">
          <button className="ghost" onClick={() => onAnswer('cancel')}>
            {t.common.cancel}
          </button>
          <button className="ghost" onClick={() => onAnswer('skip')}>
            {t.grokTrust.startWithout}
          </button>
          <button className="primary" onClick={() => onAnswer('trust')}>
            {t.grokTrust.trustAndStart}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Whether Grok trusts a folder, with a button to trust it once the user confirms. Untrusted, Grok
 * leaves out the project's own instructions, skills, MCP servers and hooks. `trusted` given: shown
 * as it is (the Grok card); not given: asked for `cwd`, and shown only when it is untrusted.
 */
export function GrokTrustNote({ cwd, trusted: given, onTrusted }: { cwd: string; trusted?: boolean; onTrusted?: () => void }) {
  const t = useT();
  const [trusted, setTrusted] = useState<boolean | undefined>(given);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setTrusted(given), [given]);
  useEffect(() => {
    if (given !== undefined || !cwd.trim()) return;
    setTrusted(undefined);
    setError('');
    // Asking starts grok briefly: wait until the folder stops changing as it is typed.
    const id = window.setTimeout(
      () => api.grokFolderTrust(cwd).then((r) => setTrusted(r.trusted), () => setTrusted(undefined)),
      600,
    );
    return () => window.clearTimeout(id);
  }, [cwd, given]);

  if (trusted === undefined) return null;
  if (trusted) return given !== undefined ? <p className="muted small">✓ {t.grokTrust.trusted}</p> : null;

  const trust = async () => {
    if (!confirm(t.grokTrust.confirm(cwd))) return;
    setBusy(true);
    setError('');
    try {
      setTrusted((await api.grokFolderTrust(cwd, true)).trusted);
      onTrusted?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grok-trust">
      <p className="warn-line small">
        {t.grokTrust.untrusted(cwd)}{' '}
        <button type="button" className="link-button" disabled={busy} onClick={trust}>
          {t.grokTrust.trust}
        </button>
      </p>
      {error && <p className="error-line">{error}</p>}
    </div>
  );
}
