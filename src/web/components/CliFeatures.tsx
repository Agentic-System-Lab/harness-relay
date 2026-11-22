import { useState } from 'react';
import { type Provider, type ProviderAccountUpdate, type ProviderAccountView, type SettingsView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import {
  cliFeaturesState,
  hasSubagentSwitch,
  hasUltracodeSwitch,
  hasWorkflowSwitch,
  subagentsFullAccessOnly,
  withNativeOn,
  withSubagents,
} from '../native';

/**
 * Whether one account's runs of a CLI may use its own subagents and workflows (docs/architecture.md,
 * "What each CLI loads by itself"): subagents on by default, workflows off, each saved as soon as it
 * is changed. A CLI with no switch for them says so; its own default applies.
 */
export function CliFeatures({
  provider,
  account,
  onSettings,
}: {
  provider: Provider;
  account?: ProviderAccountView;
  onSettings: (s: SettingsView) => void;
}) {
  const t = useT();
  const c = t.cliFeatures;
  const [saving, setSaving] = useState<Pick<ProviderAccountUpdate, 'nativeOff' | 'nativeOn'> | null>(null);
  const [error, setError] = useState('');
  const off = saving?.nativeOff ?? account?.nativeOff ?? [];
  const on = saving?.nativeOn ?? account?.nativeOn ?? [];
  const busy = saving !== null || !account;
  const save = async (update: Pick<ProviderAccountUpdate, 'nativeOff' | 'nativeOn'>) => {
    if (!account) return;
    setError('');
    setSaving(update);
    try {
      onSettings(await api.updateAccount(provider, account.id, update));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };
  const state = cliFeaturesState(provider, off, on);
  const summary = [
    state.subagents === undefined ? c.subagentsDefault : state.subagents ? c.subagentsOn : c.subagentsOff,
    ...(state.workflows === undefined ? [] : [state.workflows ? (state.ultracode ? c.ultracodeOn : c.workflowsOn) : c.workflowsOff]),
  ].join(' · ');

  return (
    <details className="sub cli-features">
      <summary>
        {c.title}
        <span className="badge">{summary}</span>
      </summary>
      <div className="sub-body">
        <p className="muted small">{c.hint}</p>
        {hasSubagentSwitch(provider) && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={state.subagents ?? true}
              disabled={busy}
              onChange={(e) => void save({ nativeOff: withSubagents(off, e.target.checked) })}
            />
            <span>{c.subagents}</span>
          </label>
        )}
        <p className="muted small">{t.native.offNotes[provider].subagents}</p>
        {subagentsFullAccessOnly(provider) && <p className="muted small">{c.fullAccessOnly}</p>}
        {hasWorkflowSwitch(provider) && (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={state.workflows ?? false}
                disabled={busy}
                onChange={(e) => void save({ nativeOn: withNativeOn(on, 'workflows', e.target.checked) })}
              />
              <span>{c.workflows}</span>
            </label>
            <p className="muted small">{c.workflowsNote[provider]}</p>
          </>
        )}
        {hasUltracodeSwitch(provider) && (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={state.ultracode ?? false}
                disabled={busy || !state.workflows}
                onChange={(e) => void save({ nativeOn: withNativeOn(on, 'ultracode', e.target.checked) })}
              />
              <span>{c.ultracode}</span>
            </label>
            <p className="muted small">{c.ultracodeNote}</p>
          </>
        )}
        {error && <p className="error-line">{error}</p>}
      </div>
    </details>
  );
}
