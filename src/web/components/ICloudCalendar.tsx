import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConnectorsView } from '../../shared/types';
import { api } from '../api';
import { ICLOUD_CALENDAR_URL } from '../connectors';
import { collectionName, discoveredCalendar } from '../../shared/connectorAccounts';
import { useT } from '../i18n';

/** CalDAV discovery and storage are the same as the manual form. Apple users only supply their own credentials. */
export function ICloudCalendar({
  accounts,
  onSaved,
  onClose,
  onSaving,
}: {
  accounts: ConnectorsView['calendar'];
  onSaved: () => Promise<void>;
  onClose: () => void;
  onSaving: (busy: boolean) => void;
}) {
  const t = useT(),
    a = t.apps;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [calendars, setCalendars] = useState<{ name: string; url: string }[]>([]);
  const [chosen, setChosen] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [looking, setLooking] = useState(false);
  const search = useRef<AbortController | null>(null);
  const select = useRef<HTMLSelectElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const focusAfterSearch = useRef(false);
  useLayoutEffect(() => {
    if (looking || !focusAfterSearch.current) return;
    focusAfterSearch.current = false;
    if (document.activeElement === document.body || document.activeElement === submit.current) (select.current ?? submit.current)?.focus();
  }, [looking]);
  useEffect(() => () => search.current?.abort(), []);
  const resetList = () => {
    focusAfterSearch.current = false;
    search.current?.abort();
    search.current = null;
    setLooking(false);
    setChosen('');
    setCalendars([]);
    setStatus('');
  };
  const find = async () => {
    resetList();
    focusAfterSearch.current = document.activeElement === submit.current;
    const controller = new AbortController();
    search.current = controller;
    setLooking(true);
    try {
      const result = await api.discoverCalendars({ url: ICLOUD_CALENDAR_URL, username: email.trim(), password }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setStatus(result.error || t.connectors.noneFound);
        return;
      }
      const found = result.calendars ?? [];
      setCalendars(found);
      if (!found.length) setStatus(t.connectors.noneFound);
      if (found.length === 1 && !discoveredCalendar(accounts, found[0]!, email).added) setChosen(found[0]!.url);
    } catch (e) {
      if (!controller.signal.aborted) setStatus((e as Error).message);
    } finally {
      if (search.current === controller) {
        setLooking(false);
        search.current = null;
      }
    }
  };
  const options = calendars.map((calendar) => {
    const { name, added } = discoveredCalendar(accounts, calendar, email);
    const repeated = calendars.some((other) => other !== calendar && other.name.toLowerCase() === calendar.name.toLowerCase());
    return { ...calendar, label: added ? a.appleAlreadyAdded(name) : repeated ? name + ' · ' + calendar.url : name, added };
  });
  const item = options.find((c) => c.url === chosen && !c.added);
  const save = async () => {
    if (!item || saving) return;
    setStatus('');
    setSaving(true);
    onSaving(true);
    try {
      await api.addDiscoveredCalendar({
        name: collectionName(item.name),
        url: item.url,
        username: email.trim(),
        password,
        address: email.trim(),
      });
      await onSaved();
      onClose();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setSaving(false);
      onSaving(false);
    }
  };
  return (
    <form
      className="mcp-form connector-form"
      aria-label={a.connectApple}
      onSubmit={(e) => {
        e.preventDefault();
        if (calendars.length) void save();
        else void find();
      }}
    >
      <label className="field">
        <span>{a.appleEmail}</span>
        <input
          type="email"
          autoComplete="username"
          required
          disabled={saving}
          value={email}
          onChange={(e) => {
            resetList();
            setEmail(e.target.value);
          }}
        />
      </label>
      <label className="field">
        <span>{a.applePassword}</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          disabled={saving}
          value={password}
          onChange={(e) => {
            resetList();
            setPassword(e.target.value);
          }}
        />
      </label>
      <p className="small muted">
        {a.appleSteps}{' '}
        <a href="https://account.apple.com/" rel="noreferrer" target="_blank">
          {a.appleHelp}
        </a>
      </p>
      {calendars.length > 0 && (
        <label className="field">
          <span>{a.appleChoose}</span>
          <select ref={select} required disabled={saving} value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="" disabled>
              {a.appleChoose}
            </option>
            {options.map((c) => (
              <option key={c.url} value={c.url} disabled={c.added}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {options.length > 0 && options.every((c) => c.added) && (
        <p className="small muted" role="status">
          {a.appleAllAdded}
        </p>
      )}
      {status && (
        <p role="status" className="small">
          {status}
        </p>
      )}
      <div className="form-actions">
        <button
          ref={submit}
          type="submit"
          className="primary small-button"
          aria-busy={saving || looking}
          aria-disabled={saving || undefined}
          disabled={looking || !email.trim() || !password || (!!calendars.length && !item)}
        >
          {calendars.length ? t.common.save : looking ? t.connectors.finding : t.connectors.find}
        </button>
        <button type="button" className="ghost small-button" disabled={saving} onClick={onClose}>
          {t.common.cancel}
        </button>
      </div>
    </form>
  );
}
