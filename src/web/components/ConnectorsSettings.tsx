import { useEffect, useState } from 'react';
import type { CalendarAccountView, ConnectorsView, MailAccountView, MailSecurity } from '../../shared/types';
import { api } from '../api';
import {
  CALENDAR_PRESETS,
  MAIL_PRESETS,
  calendarForm,
  calendarUpdate,
  mailForm,
  mailUpdate,
  newAccountId,
  withPreset,
  type CalendarForm,
  type MailForm,
} from '../connectors';
import { useT } from '../i18n';

/**
 * Settings → Tool library → Mail and calendar: the accounts Harness Relay's mail and calendar tools
 * use. Passwords go to the credential store and only come back masked; Test signs in without sending
 * anything.
 */
export function ConnectorsSettings() {
  const t = useT();
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [error, setError] = useState('');
  /** The form open: a kind, and the account edited ('' for a new one). */
  const [editing, setEditing] = useState<{ kind: 'mail' | 'calendar'; id: string } | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});

  useEffect(() => {
    api.connectors().then(setView, (e: Error) => setError(e.message));
  }, []);

  const change = async (call: () => Promise<ConnectorsView>): Promise<boolean> => {
    setError('');
    try {
      setView(await call());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const test = async (kind: 'mail' | 'calendar', id: string) => {
    setTested((x) => ({ ...x, [`${kind}:${id}`]: t.connectors.testing }));
    const r = await api.testConnector(kind, id).catch((e: Error) => ({ ok: false, error: e.message }));
    setTested((x) => ({ ...x, [`${kind}:${id}`]: r.ok ? ('message' in r && r.message) || t.connectors.testOk : `✗ ${r.error ?? ''}` }));
  };

  if (!view) return error ? <p className="error-line">{error}</p> : null;
  const row = (kind: 'mail' | 'calendar', a: MailAccountView | CalendarAccountView, detail: string) => (
    <li key={a.id} className="lib-row relay-group">
      <div className="lib-row-main">
        <span className="lib-name">{a.name}</span>
        <code className="lib-detail">{detail}</code>
      </div>
      {tested[`${kind}:${a.id}`] && <p className="small muted">{tested[`${kind}:${a.id}`]}</p>}
      <div className="lib-row-actions">
        <button type="button" className="ghost small-button" onClick={() => test(kind, a.id)}>
          {t.connectors.test}
        </button>
        <button type="button" className="ghost small-button" onClick={() => setEditing({ kind, id: a.id })}>
          {t.tools.edit}
        </button>
        <button
          type="button"
          className="icon-button danger"
          aria-label={t.common.remove}
          onClick={() => confirm(t.connectors.confirmRemove(a.name)) && change(() => api.deleteConnector(kind, a.id))}
        >
          ×
        </button>
      </div>
    </li>
  );

  return (
    <div className="tools-section connectors">
      <h4>{t.connectors.title}</h4>
      <p className="muted small">
        {t.connectors.hint} {t.connectors.passwordsIn(t.settings.keyStorageName[view.secretStorage])}
      </p>
      {error && <p className="error-line">{error}</p>}

      <h5>{t.connectors.mail}</h5>
      <ul className="lib-list">
        {view.mail.map((m) =>
          editing?.kind === 'mail' && editing.id === m.id ? (
            <li key={m.id}>
              <MailEditor account={m} taken={view.mail.map((x) => x.id)} change={change} onDone={() => setEditing(null)} />
            </li>
          ) : (
            row('mail', m, `${m.address} · ${m.imap.host}`)
          ),
        )}
      </ul>
      {editing?.kind === 'mail' && editing.id === '' ? (
        <MailEditor taken={view.mail.map((x) => x.id)} change={change} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="ghost small-button" onClick={() => setEditing({ kind: 'mail', id: '' })}>
          {t.connectors.addMail}
        </button>
      )}

      <h5>{t.connectors.calendar}</h5>
      <ul className="lib-list">
        {view.calendar.map((c) =>
          editing?.kind === 'calendar' && editing.id === c.id ? (
            <li key={c.id}>
              <CalendarEditor account={c} taken={view.calendar.map((x) => x.id)} change={change} onDone={() => setEditing(null)} />
            </li>
          ) : (
            row('calendar', c, c.url)
          ),
        )}
      </ul>
      {editing?.kind === 'calendar' && editing.id === '' ? (
        <CalendarEditor taken={view.calendar.map((x) => x.id)} change={change} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="ghost small-button" onClick={() => setEditing({ kind: 'calendar', id: '' })}>
          {t.connectors.addCalendar}
        </button>
      )}
    </div>
  );
}

type Change = (call: () => Promise<ConnectorsView>) => Promise<boolean>;

function SecuritySelect({ value, onChange, label }: { value: MailSecurity; onChange: (v: MailSecurity) => void; label: string }) {
  const t = useT();
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as MailSecurity)}>
      <option value="tls">{t.connectors.security.tls}</option>
      <option value="starttls">{t.connectors.security.starttls}</option>
      <option value="none">{t.connectors.security.none}</option>
    </select>
  );
}

function MailEditor({
  account,
  taken,
  change,
  onDone,
}: {
  account?: MailAccountView;
  taken: string[];
  change: Change;
  onDone: () => void;
}) {
  const t = useT();
  const [f, setF] = useState<MailForm>(() => mailForm(account));
  const [saving, setSaving] = useState(false);
  const edit = (patch: Partial<MailForm>) => setF((x) => ({ ...x, ...patch }));
  const save = async () => {
    setSaving(true);
    const id = account?.id ?? newAccountId(f.name, taken);
    if (await change(() => api.saveMailAccount(id, mailUpdate(f)))) onDone();
    setSaving(false);
  };
  const field = (key: keyof MailForm, label: string, type = 'text', placeholder = '') => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={f[key]}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => edit({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <form
      className="mcp-form connector-form"
      aria-label={account ? t.connectors.editMail(account.name) : t.connectors.addMail}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!account && (
        <label className="field">
          <span>{t.connectors.provider}</span>
          <select
            defaultValue=""
            onChange={(e) =>
              e.target.value &&
              edit(
                withPreset(
                  f,
                  MAIL_PRESETS.find((p) => p.id === e.target.value)!,
                ),
              )
            }
          >
            <option value="">{t.connectors.otherProvider}</option>
            {MAIL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {field('name', t.tools.name)}
      {field('address', t.connectors.address, 'text', 'Me <me@example.com>')}
      {field('username', t.connectors.username, 'text', t.connectors.usernamePlaceholder)}
      {field(
        'password',
        t.connectors.password,
        'password',
        account?.password ? t.tools.keepValue(account.password) : t.connectors.appPassword,
      )}
      <div className="connector-servers">
        <span>IMAP</span>
        <input
          aria-label={`IMAP ${t.connectors.host}`}
          value={f.imapHost}
          placeholder="imap.example.com"
          onChange={(e) => edit({ imapHost: e.target.value })}
        />
        <input
          aria-label={`IMAP ${t.connectors.port}`}
          value={f.imapPort}
          inputMode="numeric"
          onChange={(e) => edit({ imapPort: e.target.value })}
        />
        <SecuritySelect label={`IMAP ${t.connectors.securityLabel}`} value={f.imapSecurity} onChange={(v) => edit({ imapSecurity: v })} />
        <span>SMTP</span>
        <input
          aria-label={`SMTP ${t.connectors.host}`}
          value={f.smtpHost}
          placeholder="smtp.example.com"
          onChange={(e) => edit({ smtpHost: e.target.value })}
        />
        <input
          aria-label={`SMTP ${t.connectors.port}`}
          value={f.smtpPort}
          inputMode="numeric"
          onChange={(e) => edit({ smtpPort: e.target.value })}
        />
        <SecuritySelect label={`SMTP ${t.connectors.securityLabel}`} value={f.smtpSecurity} onChange={(v) => edit({ smtpSecurity: v })} />
      </div>
      <p className="muted small">{t.connectors.mailHint}</p>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onDone}>
          {t.common.cancel}
        </button>
        <button type="submit" className="primary" disabled={saving || !f.name.trim() || !f.address.trim()}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

function CalendarEditor({
  account,
  taken,
  change,
  onDone,
}: {
  account?: CalendarAccountView;
  taken: string[];
  change: Change;
  onDone: () => void;
}) {
  const t = useT();
  const [f, setF] = useState<CalendarForm>(() => calendarForm(account));
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<{ name: string; url: string }[] | null>(null);
  const [finding, setFinding] = useState('');
  const edit = (patch: Partial<CalendarForm>) => setF((x) => ({ ...x, ...patch }));
  const find = async () => {
    setFinding(t.connectors.finding);
    setFound(null);
    const r = await api
      .discoverCalendars({
        url: f.url,
        username: f.username,
        ...(f.password ? { password: f.password } : {}),
        ...(account ? { id: account.id } : {}),
      })
      .catch((e: Error) => ({ ok: false, error: e.message, calendars: undefined }));
    if (!r.ok) setFinding(`✗ ${r.error ?? ''}`);
    else {
      setFinding(r.calendars?.length ? '' : t.connectors.noneFound);
      setFound(r.calendars ?? []);
    }
  };
  const save = async () => {
    setSaving(true);
    const id = account?.id ?? newAccountId(f.name, taken);
    if (await change(() => api.saveCalendarAccount(id, calendarUpdate(f)))) onDone();
    setSaving(false);
  };
  const field = (key: keyof CalendarForm, label: string, type = 'text', placeholder = '') => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={f[key]}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => edit({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <form
      className="mcp-form connector-form"
      aria-label={account ? t.connectors.editCalendar(account.name) : t.connectors.addCalendar}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!account && (
        <label className="field">
          <span>{t.connectors.provider}</span>
          <select
            defaultValue=""
            onChange={(e) => {
              const p = CALENDAR_PRESETS.find((x) => x.id === e.target.value);
              if (p) edit({ url: p.url, name: f.name || p.label });
            }}
          >
            <option value="">{t.connectors.otherProvider}</option>
            {CALENDAR_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {field('name', t.tools.name)}
      {field('url', t.connectors.calendarUrl, 'url', 'https://caldav.example.com/')}
      {field('username', t.connectors.username)}
      {field(
        'password',
        t.connectors.password,
        'password',
        account?.password ? t.tools.keepValue(account.password) : t.connectors.appPassword,
      )}
      {field('address', t.connectors.inviteFrom, 'text', 'me@example.com')}
      <div className="form-actions">
        <button type="button" className="ghost small-button" disabled={!f.url.trim() || !f.username.trim()} onClick={find}>
          {t.connectors.find}
        </button>
        {finding && <span className="small muted">{finding}</span>}
      </div>
      {found && found.length > 0 && (
        <div className="field" role="radiogroup" aria-label={t.connectors.foundLabel}>
          {found.map((c) => (
            <label key={c.url} className="check-row">
              <input
                type="radio"
                name="calendar-found"
                checked={f.url === c.url}
                onChange={() => edit({ url: c.url, name: f.name || c.name })}
              />
              {c.name} <code className="small">{c.url}</code>
            </label>
          ))}
        </div>
      )}
      <p className="muted small">{t.connectors.calendarHint}</p>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onDone}>
          {t.common.cancel}
        </button>
        <button type="submit" className="primary" disabled={saving || !f.name.trim() || !f.url.trim()}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}
