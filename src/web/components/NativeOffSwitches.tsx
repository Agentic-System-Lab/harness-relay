import { useState } from 'react';
import { NATIVE_OFF_SUPPORT, NATIVE_PARTS, type NativePart, type Provider, type ProviderSettingsView, type SettingsView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Switches that leave what a CLI loads by itself (its own skills, MCP servers, instruction files,
 * memory, hooks, subagents, plugins) out of Harness Relay's runs. Saved as soon as one is changed;
 * the CLI's own settings stay.
 */
export function NativeOffSwitches({
  provider,
  settings,
  onSettings,
}: {
  provider: Provider;
  settings?: ProviderSettingsView;
  onSettings: (s: SettingsView) => void;
}) {
  const t = useT();
  const off = settings?.nativeOff ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = async (part: NativePart, leaveOut: boolean) => {
    setBusy(true);
    setError('');
    try {
      onSettings(await api.updateProvider(provider, { nativeOff: leaveOut ? [...off, part] : off.filter((p) => p !== part) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="native-off">
      <legend>{t.native.offTitle}</legend>
      <p className="muted small">{t.native.offHint}</p>
      <ul>
        {NATIVE_PARTS.map((part) => {
          const supported = NATIVE_OFF_SUPPORT[provider].includes(part);
          return (
            <li key={part}>
              <label className={`check-row ${supported ? '' : 'unsupported'}`}>
                <input
                  type="checkbox"
                  checked={supported && off.includes(part)}
                  disabled={!supported || busy || !settings}
                  onChange={(e) => void toggle(part, e.target.checked)}
                />
                <span>{t.native.offParts[part]}</span>
              </label>
              <span className="muted small">{t.native.offNotes[provider][part]}</span>
            </li>
          );
        })}
      </ul>
      {provider === 'codex' && <p className="muted small">{t.native.offCodexThreads}</p>}
      {error && <p className="error-line">{error}</p>}
    </fieldset>
  );
}
