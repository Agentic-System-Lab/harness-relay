import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, GrokFolderTrust } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Whether a team waiting for the user's confirmation should say how Grok trusts its folder first: it
 * has a Grok member, and there is a folder.
 */
export function asksGrokTrust(agents: AgentConfig[], cwd: string): boolean {
  return Boolean(cwd.trim()) && agents.some((a) => a.provider === 'grok');
}

/**
 * Whether Grok trusts a folder, with a button to trust it once the user confirms. Untrusted, Grok
 * leaves out the project's own instructions, skills, MCP servers and hooks. `trusted` given: shown
 * as it is (the Grok card), with the `folder` Grok decides trust for; not given: asked for `cwd`,
 * and shown only when it is untrusted.
 */
export function GrokTrustNote({
  cwd,
  folder: givenFolder,
  above: givenAbove = false,
  trusted: given,
  onTrusted,
}: {
  cwd: string;
  folder?: string;
  above?: boolean;
  trusted?: boolean;
  onTrusted?: () => void;
}) {
  const t = useT();
  type Status = Pick<GrokFolderTrust, 'trusted' | 'folder' | 'above'>;
  const unknown = (): Status => ({ trusted: undefined, folder: cwd, above: false });
  const [status, setStatus] = useState<Status>({ trusted: given, folder: givenFolder ?? cwd, above: givenAbove });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The folder shown now: an answer for one typed earlier must not replace the answer for it.
  const current = useRef(cwd);
  useEffect(() => {
    current.current = cwd;
  }, [cwd]);

  useEffect(() => setStatus({ trusted: given, folder: givenFolder ?? cwd, above: givenAbove }), [given, givenFolder, givenAbove, cwd]);
  useEffect(() => {
    if (given !== undefined || !cwd.trim()) return;
    let live = true;
    setStatus(unknown());
    setError('');
    // Asking starts grok briefly: wait until the folder stops changing as it is typed.
    const id = window.setTimeout(
      () =>
        api.grokFolderTrust(cwd).then(
          (r) => live && setStatus(r),
          () => live && setStatus(unknown()),
        ),
      600,
    );
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [cwd, given]);

  const { trusted, folder, above } = status;
  if (trusted === undefined) return null;
  if (trusted) return given !== undefined ? <p className="muted small">✓ {t.grokTrust.trusted}</p> : null;

  const trust = async () => {
    if (!confirm(t.grokTrust.confirm(folder, above ? cwd : undefined))) return;
    const asked = cwd;
    setBusy(true);
    setError('');
    try {
      const r = await api.grokFolderTrust(cwd, folder);
      if (current.current !== asked) return;
      setStatus(r);
      onTrusted?.();
    } catch (e) {
      if (current.current === asked) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grok-trust">
      <p className="warn-line small">
        {t.grokTrust.untrusted(folder)}{' '}
        <button type="button" className="link-button" disabled={busy} onClick={trust}>
          {t.grokTrust.trust}
        </button>
      </p>
      {error && <p className="error-line">{error}</p>}
    </div>
  );
}
