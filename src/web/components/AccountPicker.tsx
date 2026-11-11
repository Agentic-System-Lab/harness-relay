import { accountUsable, type ProviderStatus } from '../../shared/types';
import { useT } from '../i18n';
import { accountName, accountOf } from '../util';

interface Props {
  /** The CLI's status, with its accounts. */
  status?: ProviderStatus;
  /** The account picked (absent: the default one). */
  value?: string;
  onChange: (account: string | undefined) => void;
}

/**
 * The account of its CLI an agent (or the lead agent) runs as. Shown only when the CLI has more than
 * one; an account that was removed shows as the default one, which is what runs.
 */
export function AccountPicker({ status, value, onChange }: Props) {
  const t = useT();
  if (!status || status.accounts.length < 2) return null;
  const current = accountOf(status, value);
  return (
    <label className="field account-picker">
      <span>{t.accounts.account}</span>
      <select value={current?.id ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        {status.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {accountName(a, t) +
              (a.auth.account ? ` · ${a.auth.account}` : '') +
              (status.installed && !accountUsable(a) ? ` (${t.settings.pill.notLoggedIn})` : '')}
          </option>
        ))}
      </select>
    </label>
  );
}
