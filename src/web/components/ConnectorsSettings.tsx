import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarAccountView, OAuthAccountView, OAuthView, ConnectorsView, MailAccountView, MailSecurity } from '../../shared/types';
import { api } from '../api';
import {
  CALENDAR_PRESETS,
  ICLOUD_CALENDAR_URL,
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
import { ICloudCalendar } from './ICloudCalendar';
import { oauthClientStatus } from '../oauth';
import { OAuthAccounts } from './OAuthAccounts';

const serviceOrder = ['google', 'apple', 'microsoft', 'other'] as const;
type Service = (typeof serviceOrder)[number];

/**
 * Settings → Apps and tools → Common apps → Mail or Calendar: the accounts Harness Relay's mail and calendar tools
 * use. Passwords go to the credential store and only come back masked; Test signs in without sending
 * anything. A mail account or calendar reached through an account you sign in to (`oauth`) has no
 * password nor servers to edit: it is removed, and added again from its account.
 */
export function ConnectorsSettings({
  kind,
  view,
  reloadConnectors,
  oauth,
  reloadOAuth,
}: {
  kind: 'mail' | 'calendar';
  view: ConnectorsView | null;
  reloadConnectors: () => Promise<void>;
  oauth: OAuthView | null;
  reloadOAuth: () => Promise<void>;
}) {
  const t = useT();

  const [error, setError] = useState('');
  /** The ID of the existing account being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [service, setService] = useState<Service>();
  const [savingAccount, setSavingAccount] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const editFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!editFocus.current) return;
    const id = CSS.escape(editFocus.current);
    if (document.activeElement === document.body)
      panel.current?.querySelector<HTMLElement>(editing ? `[data-editor="${id}"] input` : `[data-edit="${id}"]`)?.focus();
    editFocus.current = null;
  }, [editing]);
  const choices = useRef<HTMLDivElement>(null);
  const returnChoice = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (service || savingAccount || !returnChoice.current) return;
    if (document.activeElement === document.body || document.activeElement === returnChoice.current) returnChoice.current.focus();
    returnChoice.current = null;
  }, [service, savingAccount]);
  const [tested, setTested] = useState<Record<string, string>>({});
  /** One more after each test of a mail account or calendar reached through a sign-in, which may find that it needs a new one: the accounts are read again. */
  const [oauthTested, setOauthTested] = useState(0);

  const change = async (call: () => Promise<ConnectorsView>): Promise<boolean> => {
    setError('');
    try {
      await call();
      await reloadConnectors();
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
  const clientFor = (provider: Service) => oauth?.clients.find((c) => c.provider === provider);
  const accountUnavailable = (id: string | undefined) => {
    if (!id) return false;
    const account = oauth?.accounts.find((a) => a.id === id);
    return !account || oauthClientStatus(clientFor(account.provider)) !== 'ready';
  };
  const renderResource = (resource: MailAccountView | CalendarAccountView, account?: OAuthAccountView) => {
    if (editing === resource.id && !resource.oauth) {
      return (
        <li key={resource.id} data-editor={resource.id}>
          {'imap' in resource ? (
            <MailEditor account={resource} taken={taken} change={change} onDone={close} />
          ) : (
            <CalendarEditor account={resource} taken={taken} change={change} onDone={close} />
          )}
        </li>
      );
    }
    // OAuth-generated names include the email already shown in the account heading.
    const suffix = account && ` · ${account.email}`;
    const name = suffix && resource.name.endsWith(suffix) ? resource.name.slice(0, -suffix.length) : resource.name;
    let detail: string | undefined;
    if ('imap' in resource) detail = account ? resource.imap.host : `${resource.address} · ${resource.imap.host}`;
    else if (!resource.oauth) detail = resource.url;
    else if (!account) detail = resource.address || resource.username;
    return (
      <li key={resource.id} className={account ? 'connector-resource' : 'lib-row relay-group'}>
        <div className="lib-row-main">
          <span className="lib-name">{name}</span>
          {detail && <code className="lib-detail">{detail}</code>}
        </div>
        {tested[resource.id] && (
          <p className="small muted" role="status">
            {tested[resource.id]}
          </p>
        )}
        <div className="lib-row-actions">
          <button
            type="button"
            className="ghost small-button"
            disabled={accountUnavailable(resource.oauth)}
            onClick={() => test(resource.id)}
          >
            {t.connectors.test}
          </button>
          {!resource.oauth && (
            <button
              type="button"
              className="ghost small-button"
              data-edit={resource.id}
              onClick={() => {
                editFocus.current = resource.id;
                setEditing(resource.id);
              }}
            >
              {t.tools.edit}
            </button>
          )}
          <button
            type="button"
            className="ghost small-button danger"
            onClick={() =>
              confirm(resource.oauth ? t.connectors.removeLinked(resource.name) : t.connectors.confirmRemove(resource.name)) &&
              change(() => api.deleteConnector(kind, resource.id))
            }
          >
            {resource.oauth ? t.connectors.oauth.removeResource[kind] : t.common.remove}
          </button>
        </div>
      </li>
    );
  };

  const mail = kind === 'mail';
  const taken = view[kind].map((a) => a.id);
  const close = () => {
    if (document.activeElement === document.body || document.activeElement?.closest('[data-editor]')) editFocus.current = editing;
    setEditing(null);
  };
  const closeService = () => {
    if (document.activeElement === document.body || choices.current?.closest('.library-connectors')?.contains(document.activeElement))
      returnChoice.current = choices.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? null;
    setService(undefined);
  };
  const saveNew: Change = async (call) => {
    setSavingAccount(true);
    try {
      return await change(call);
    } finally {
      setSavingAccount(false);
    }
  };
  const serviceNames = mail
    ? { google: 'Gmail', microsoft: 'Outlook', apple: t.apps.iCloudMail, other: t.apps.otherMail }
    : { apple: t.apps.iCloudCalendar, google: 'Google Calendar', microsoft: 'Outlook', other: t.apps.otherCalendar };
  const choose = mail ? t.apps.chooseMail : t.apps.chooseCalendar;
  const servicePicker = (
    <div className="service-setup">
      <div className="service-choices" ref={choices} role="group" aria-label={choose}>
        <h5>{choose}</h5>
        {serviceOrder.map((key) => (
          <button
            key={key}
            type="button"
            className="ghost service-choice"
            aria-pressed={service === key}
            disabled={savingAccount || (!oauth && (key === 'google' || key === 'microsoft'))}
            onClick={() => setService(service === key ? undefined : key)}
          >
            {serviceNames[key]}
          </button>
        ))}
      </div>
      {service === 'apple' &&
        (mail ? (
          <ICloudMailbox taken={taken} change={saveNew} onDone={closeService} />
        ) : (
          <ICloudCalendar accounts={view.calendar} onSaved={reloadConnectors} onClose={closeService} onSaving={setSavingAccount} />
        ))}
      {service === 'other' &&
        (mail ? (
          <MailEditor taken={taken} change={saveNew} onDone={closeService} />
        ) : (
          <CalendarEditor taken={taken} change={saveNew} onDone={closeService} />
        ))}
    </div>
  );
  return (
    <div className="connectors library-connectors" ref={panel}>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      <OAuthAccounts
        kind={kind}
        view={oauth}
        reloadOAuth={reloadOAuth}
        connectors={view}
        renderResource={renderResource}
        reloadConnectors={reloadConnectors}
        refresh={oauthTested}
        servicePicker={servicePicker}
        provider={service === 'google' || service === 'microsoft' ? service : undefined}
      />
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

function ICloudMailbox({ taken, change, onDone }: { taken: string[]; change: Change; onDone: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving || !email.trim() || !password) return;
    setSaving(true);
    const preset = MAIL_PRESETS.find((p) => p.id === 'icloud')!;
    const account = mailUpdate({ ...withPreset(mailForm(), preset), name: email, address: email, password });
    if (await change(() => api.saveMailAccount(newAccountId(email, taken), account))) onDone();
    setSaving(false);
  };
  return (
    <form
      className="mcp-form connector-form"
      aria-label={t.apps.iCloudMail}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span>{t.apps.mailAddress}</span>
        <input type="email" autoComplete="username" required readOnly={saving} value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>{t.apps.applePassword}</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          readOnly={saving}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <a className="small" href="https://account.apple.com/" target="_blank" rel="noreferrer">
        {t.apps.appleHelp}
      </a>
      <div className="form-actions">
        <button
          className="primary small-button"
          type="submit"
          aria-busy={saving}
          aria-disabled={saving || undefined}
          disabled={!email.trim() || !password}
        >
          {t.common.save}
        </button>
        <button className="ghost small-button" type="button" disabled={saving} onClick={onDone}>
          {t.common.cancel}
        </button>
      </div>
    </form>
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
  const edit = (patch: Partial<MailForm>) =>
    setF((current) => {
      const connectionChanged = (['imapHost', 'smtpHost', 'imapPort', 'smtpPort', 'imapSecurity', 'smtpSecurity'] as const).some(
        (key) => patch[key] !== undefined && patch[key] !== current[key],
      );
      return { ...current, ...patch, ...(connectionChanged ? { password: '' } : {}) };
    });
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
      {(['imap', 'smtp'] as const).map((protocol) => {
        const host = `${protocol}Host` as const;
        const port = `${protocol}Port` as const;
        const security = `${protocol}Security` as const;
        const name = protocol.toUpperCase();
        return (
          <fieldset key={protocol} className="connector-servers">
            <legend>{name}</legend>
            <div className="server-fields">
              <label className="field">
                <span>{t.connectors.host}</span>
                <input
                  aria-label={`${name} ${t.connectors.host}`}
                  value={f[host]}
                  placeholder={`${protocol}.example.com`}
                  onChange={(e) => edit({ [host]: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t.connectors.port}</span>
                <input
                  aria-label={`${name} ${t.connectors.port}`}
                  value={f[port]}
                  inputMode="numeric"
                  onChange={(e) => edit({ [port]: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t.connectors.securityLabel}</span>
                <SecuritySelect
                  label={`${name} ${t.connectors.securityLabel}`}
                  value={f[security]}
                  onChange={(v) => edit({ [security]: v })}
                />
              </label>
            </div>
          </fieldset>
        );
      })}
      <p className="muted small">{t.connectors.mailHint}</p>
      <div className="form-actions">
        <button type="button" className="ghost" disabled={saving} onClick={onDone}>
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
  const discovery = useRef<AbortController | null>(null);
  useEffect(() => () => discovery.current?.abort(), []);
  const edit = (patch: Partial<CalendarForm>) => {
    if ('url' in patch || 'username' in patch || 'password' in patch) {
      discovery.current?.abort();
      setFound(null);
      setFinding('');
    }
    setF((x) => {
      const previous = URL.canParse(x.url) ? new URL(x.url).origin : undefined;
      const changedHost = patch.url !== undefined && previous && (!URL.canParse(patch.url) || new URL(patch.url).origin !== previous);
      return { ...x, ...patch, ...(changedHost ? { password: '' } : {}) };
    });
  };
  const find = async () => {
    discovery.current?.abort();
    const ctl = new AbortController();
    discovery.current = ctl;
    setFinding(t.connectors.finding);
    setFound(null);
    const r = await api
      .discoverCalendars(
        {
          url: f.url,
          username: f.username,
          ...(f.password ? { password: f.password } : {}),
          ...(account ? { id: account.id } : {}),
        },
        ctl.signal,
      )
      .catch((e: Error) => ({ ok: false, error: e.message, calendars: undefined }));
    if (ctl.signal.aborted) return;
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
              edit({ url: p?.url ?? '', name: f.name || p?.label || '', password: '' });
            }}
          >
            <option value="">{t.connectors.otherProvider}</option>
            {CALENDAR_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'icloud' ? t.apps.appleCalendar : p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {f.url === ICLOUD_CALENDAR_URL && (
        <p className="muted small">
          {t.apps.appleHint}{' '}
          <a href="https://support.apple.com/102654" target="_blank" rel="noreferrer">
            {t.apps.appleHelp}
          </a>
        </p>
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
                onChange={() => setF((current) => ({ ...current, url: c.url, name: current.name || c.name }))}
              />
              {c.name} <code className="small">{c.url}</code>
            </label>
          ))}
        </div>
      )}
      <p className="muted small">{t.connectors.calendarHint}</p>
      <div className="form-actions">
        <button type="button" className="ghost" disabled={saving} onClick={onDone}>
          {t.common.cancel}
        </button>
        <button type="submit" className="primary" disabled={saving || !f.name.trim() || !f.url.trim()}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}
