import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

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
