import { useState } from 'react';
import type { CliLoginView } from '../../shared/types';
import { copyText } from '../copy';
import { useT } from '../i18n';

/**
 * A running sign-in's steps, from what the CLI printed: the page to open, then the code to enter
 * there (a click copies it). Settings shows them for the CLIs' sign-ins, the share dialog for gh's.
 */
export function LoginLinks({ login }: { login: CliLoginView }) {
  const t = useT();
  const [copied, setCopied] = useState('');
  if (login.state !== 'running') return null;

  // Also where the page is not a secure context (a phone opening it over the network).
  const copy = async (c: string) => {
    if (!(await copyText(c))) return;
    setCopied(c);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <>
      {login.urls.length > 0 && (
        <div className="login-step">
          <span className="step-no">1</span>
          <div>
            <p>{t.settings.openAuthPage}</p>
            {login.urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="login-url">
                {u.length > 90 ? u.slice(0, 89) + '…' : u} ↗
              </a>
            ))}
          </div>
        </div>
      )}

      {login.codes.length > 0 && (
        <div className="login-step">
          <span className="step-no">2</span>
          <div>
            <p>{t.settings.enterCode}</p>
            {login.codes.map((c) => (
              <button key={c} className="device-code" onClick={() => copy(c)} title={t.common.clickToCopy}>
                {c}
                <span className="small muted">{copied === c ? t.common.copied : t.common.copy}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** What the CLI printed, folded unless the sign-in failed. */
export function LoginOutput({ login }: { login: CliLoginView }) {
  const t = useT();
  return (
    <details className="login-output" open={login.state === 'failed'}>
      <summary className="small muted">{t.settings.cliOutput}</summary>
      <pre>{login.output.trim() || t.settings.noOutput}</pre>
    </details>
  );
}
