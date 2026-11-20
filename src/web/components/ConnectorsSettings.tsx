import { useState } from 'react';
import type { CalendarAccountView, OAuthView, ConnectorsView, MailAccountView, MailSecurity } from '../../shared/types';
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
import { OAuthAccounts } from './OAuthAccounts';

/**
 * Settings → Apps and tools → Common apps → Mail or Calendar: the accounts Harness Relay's mail and calendar tools
 * use. Passwords go to the credential store and only come back masked; Test signs in without sending
 * anything. A mail account or calendar reached through an account you sign in to (`oauth`) has no
 * password nor servers to edit: it is removed, and added again from its account.
 */
export function ConnectorsSettings({
  kind,
  view,
  setView,
  oauth,
  setOauth,
}: {
  kind: 'mail' | 'calendar';
  view: ConnectorsView | null;
  setView: (v: ConnectorsView) => void;
  oauth: OAuthView | null;
  setOauth: (v: OAuthView) => void;
}) {
  const t = useT();

  const [error, setError] = useState('');
  /** The account being edited, or an empty ID for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  /** One more after each test of a mail account or calendar reached through a sign-in, which may find that it needs a new one: the accounts are read again. */
  const [oauthTested, setOauthTested] = useState(0);

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

  const test = async (id: string) => {
    setTested((x) => ({ ...x, [id]: t.connectors.testing }));
    const r = await api.testConnector(kind, id).catch((e: Error) => ({ ok: false, error: e.message }));
    setTested((x) => ({ ...x, [id]: r.ok ? ('message' in r && r.message) || t.connectors.testOk : `✗ ${r.error ?? ''}` }));
    if (view?.[kind].some((a) => a.id === id && a.oauth)) setOauthTested((n) => n + 1);
  };

  if (!view) return error ? <p className="error-line">{error}</p> : null;
  const row = (a: MailAccountView | CalendarAccountView, detail: string) => (
    <li key={a.id} className="lib-row relay-group">
      <div className="lib-row-main">
        <span className="lib-name">{a.name}</span>
        <code className="lib-detail">{detail}</code>
      </div>
      {tested[a.id] && <p className="small muted">{tested[a.id]}</p>}
      <div className="lib-row-actions">
        <button type="button" className="ghost small-button" onClick={() => test(a.id)}>
          {t.connectors.test}
        </button>
        {/* One reached through a sign-in has no password nor servers to edit: removed and added again from its account. */}
        {!a.oauth && (
          <button type="button" className="ghost small-button" onClick={() => setEditing(a.id)}>
            {t.tools.edit}
          </button>
        )}
        <button
          type="button"
          className="icon-button danger"
          aria-label={t.common.remove}
          onClick={() =>
            confirm(a.oauth ? t.connectors.removeLinked(a.name) : t.connectors.confirmRemove(a.name)) &&
            change(() => api.deleteConnector(kind, a.id))
          }
        >
          ×
        </button>
      </div>
    </li>
  );

  const mail = kind === 'mail';
  const taken = view[kind].map((a) => a.id);
  const close = () => setEditing(null);
  return (
    <div className="connectors library-connectors">
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      {taken.length > 0 && (
        <ul className="lib-list" aria-label={mail ? t.connectors.mailAccounts : t.connectors.calendar}>
          {mail
            ? view.mail.map((a) =>
                editing === a.id ? (
                  <li key={a.id}>
                    <MailEditor account={a} taken={taken} change={change} onDone={close} />
                  </li>
                ) : (
                  row(a, `${a.address} · ${a.imap.host}`)
                ),
              )
            : view.calendar.map((a) =>
                editing === a.id ? (
                  <li key={a.id}>
                    <CalendarEditor account={a} taken={taken} change={change} onDone={close} />
                  </li>
                ) : (
                  row(a, a.oauth ? a.address || a.username : a.url)
                ),
              )}
        </ul>
      )}
      <OAuthAccounts kind={kind} view={oauth} setView={setOauth} connectors={view} onConnectors={setView} refresh={oauthTested} />
      <p className="small muted">
        {t.connectors.manualHint[kind]}
        {editing !== null && t.connectors.passwordsIn(t.settings.keyStorageName[view.secretStorage])}
      </p>
      {editing === '' ? (
        mail ? (
          <MailEditor taken={taken} change={change} onDone={close} />
        ) : (
          <CalendarEditor taken={taken} change={change} onDone={close} />
        )
      ) : (
        <button type="button" className="ghost small-button" onClick={() => setEditing('')}>
          {mail ? t.connectors.addMail : t.connectors.addCalendar}
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
