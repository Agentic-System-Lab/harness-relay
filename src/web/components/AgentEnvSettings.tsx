import { useState } from 'react';
import { MAX_PASS_ENV } from '../../shared/agentEnv';
import { PROVIDER_LABEL, type Provider, type ProviderEnvView, type SettingsView } from '../../shared/types';
import { addPassName, removePassName } from '../agentEnv';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Settings → a CLI's card → Environment variables: what of the environment Harness Relay was started
 * with its default account signs in with, which other providers' keys its runs are not given, and the
 * ones the user passes on to it all the same (src/server/agentEnv.ts). Names only, never a value.
 */
export function AgentEnvSettings({
  provider,
  view,
  onSettings,
}: {
  provider: Provider;
  view: ProviderEnvView;
  onSettings: (s: SettingsView) => void;
}) {
  const t = useT();
  const e = t.agentEnv;
  const cli = PROVIDER_LABEL[provider];
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (list: string[]) => {
    setBusy(true);
    setNote('');
    try {
      onSettings(await api.updateProvider(provider, { passEnv: list }));
      setName('');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = (input: string) => {
    const next = addPassName(view.pass, input);
    if ('error' in next) {
      setNote(next.error === 'full' ? e.errors.full(MAX_PASS_ENV) : e.errors[next.error]);
      return;
    }
    void save(next.list);
  };

  return (
    <details className="sub agent-env">
      <summary>
        {e.title}
        {view.withheld.length > 0 && e.summaryWithheld(view.withheld.length)}
      </summary>
      <div className="sub-body">
        <p className="muted small">
          {e.hint(cli)}
          {provider === 'codex' && ` ${e.codexHint}`}
        </p>
        <p className="small">
          {view.signIn.length ? e.signIn(cli, view.signIn.join(e.sep)) : e.signInNone}
          {view.signIn.length > 1 && e.signInMany}
        </p>
        <div>
          <p className="small">{view.withheld.length ? e.withheld : e.withheldNone}</p>
          {view.withheld.length > 0 && (
            <ul className="env-names">
              {view.withheld.map((n) => (
                <li key={n} className="env-name">
                  <code>{n}</code>
                  <button type="button" className="ghost small-button" disabled={busy} aria-label={e.passOnLabel(n)} onClick={() => add(n)}>
                    {e.passOn}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="small">
            {e.pass}
            {view.pass.length === 0 && ` ${e.passNone}`}
          </p>
          {view.pass.length > 0 && (
            <ul className="env-names">
              {view.pass.map((n) => (
                <li key={n} className="env-name">
                  <code>{n}</code>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={e.stopPassing(n)}
                    title={e.stopPassing(n)}
                    onClick={() => void save(removePassName(view.pass, n))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="input-row">
          <input
            value={name}
            placeholder="OPENAI_API_KEY"
            aria-label={e.addLabel}
            maxLength={128}
            spellCheck={false}
            autoComplete="off"
            onChange={(ev) => setName(ev.target.value)}
            onKeyDown={(ev) => ev.key === 'Enter' && !busy && name.trim() && add(name)}
          />
          <button type="button" className="ghost" disabled={busy || !name.trim()} onClick={() => add(name)}>
            {e.add}
          </button>
        </div>
        <p className="muted small">{e.passHint}</p>
        {note && (
          <p className="small warn-text" role="alert">
            {note}
          </p>
        )}
      </div>
    </details>
  );
}
