import { useEffect, useRef, useState } from 'react';
import type { HandoverMode, HandoverWindowAt } from '../../shared/types';
import { ApiError, api } from '../api';
import { sseMessages } from '../appPreview';
import { hostOf, preferredMode, screenEvent } from '../handover';
import { isAppWindow } from '../update';
import { HandoverPanel } from './HandoverCard';
import {
  commandActions,
  filledValues,
  formOf,
  interactiveActions,
  proposalOf,
  runTone,
  sessionTone,
  startRequest,
  startsInWorkdir,
  waitingAsks,
  wantsHidden,
  type CommandPart,
  type InteractivePart,
  type SecretsPart,
} from '../handoffs';
import { useI18n, useT } from '../i18n';
import { CommandIcon, KeyIcon } from './icons';
import { LoginLinks } from './LoginLinks';
import '../handoffs.css';

/*
 * The cards of what an agent hands to the user (docs/architecture.md, "Secrets and fixed commands"):
 * the secrets a reply asks for, a fixed command it proposes, and a command it asks the user to run
 * themselves ("Interactive commands"). A value typed here goes to the server once and is never shown
 * again: the card keeps none, and the server never sends one back.
 */

/** Runs a card's call, with its busy state and its error in the card. */
function useCall(): { busy: boolean; error: string; call: (fn: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, call };
}

/** Where a browser for the user alone can open in a window, asked once for the page (none where this computer shows none). */
let windowAsked: Promise<HandoverWindowAt | undefined> | undefined;
function useWindowAt(wanted: boolean): HandoverWindowAt | undefined {
  const [at, setAt] = useState<HandoverWindowAt>();
  useEffect(() => {
    if (!wanted) return;
    windowAsked ??= api.handoverWindow().then(
      (r) => r.windowAt ?? undefined,
      () => {
        // Asked again the next time a card wants it.
        windowAsked = undefined;
        return undefined;
      },
    );
    let live = true;
    void windowAsked.then((w) => live && setAt(w));
    return () => {
      live = false;
    };
  }, [wanted]);
  return at;
}

/**
 * A secrets card's browser for the user alone while it is open in a window on the computer Harness Relay
 * runs on: what to do there, Save selection for each secret the card waits for (read in the server, as in
 * the screencast), and Close; `onEnded` once it closed, the window too (its hand-over's stream says so).
 */
function WindowedBrowser({
  convId,
  handoverId,
  names,
  onSave,
  onClose,
  onEnded,
}: {
  convId: string;
  handoverId: string;
  names: { name: string; label?: string }[];
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
  onEnded: () => void;
}) {
  const alone = useT().browserHandover.alone;
  const [saving, setSaving] = useState<{ busy?: boolean; done?: string; error?: string }>({});
  const ended = useRef(onEnded);
  ended.current = onEnded;
  // Told only that it ended: the user closed the window, its time ran out, or the card was answered.
  useEffect(() => {
    const stopped = new AbortController();
    const read = async () => {
      for (let attempt = 0; attempt < 8 && !stopped.signal.aborted; attempt++) {
        try {
          const res = await api.handoverScreen(convId, handoverId, stopped.signal);
          attempt = 0;
          const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const { messages, rest } = sseMessages(buffer + value);
            buffer = rest;
            if (messages.some((m) => screenEvent(m)?.type === 'ended')) return void ended.current();
          }
        } catch (error) {
          if (stopped.signal.aborted) return;
          const status = (error as { status?: number }).status;
          if (status === 404 || status === 409) return void ended.current();
        }
        if (stopped.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    };
    void read();
    return () => stopped.abort();
  }, [convId, handoverId]);
  return (
    <div className="handoff-window" role="group" aria-label={alone.title}>
      <p className="small">{alone.inWindow}</p>
      <div className="approval-actions">
        {names.map((a) => (
          <button
            key={a.name}
            type="button"
            className="primary small-button"
            disabled={saving.busy}
            title={a.label}
            onClick={async () => {
              setSaving({ busy: true });
              try {
                await onSave(a.name);
                setSaving({ done: a.name });
              } catch (err) {
                setSaving({ error: (err as Error).message });
              }
            }}
          >
            {alone.saveAs(a.name)}
          </button>
        ))}
        <button type="button" className="ghost small-button" onClick={onClose}>
          {alone.close}
        </button>
      </div>
      {saving.done && (
        <p className="small handover-saved" role="status">
          {alone.saved(saving.done)}
        </p>
      )}
      {saving.error && (
        <p className="error-line small" role="alert">
          {saving.error}
        </p>
      )}
    </div>
  );
}

/** The secrets a reply asks for: a masked field for each, Save and Don't give. */
export function SecretsCard({
  part,
  convId,
  messageId,
  agentName,
}: {
  part: SecretsPart;
  convId: string;
  messageId: string;
  agentName: string;
}) {
  const t = useT();
  const c = t.handoffs.secrets;
  const alone = t.browserHandover.alone;
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const { busy, error, call } = useCall();
  const waiting = waitingAsks(part);
  const filled = filledValues(waiting, values);
  /** The card's browser for the user alone, while it is open here (its panel, or its window): its hand-over id and how it shows. */
  const [browser, setBrowser] = useState<{ id: string; mode: HandoverMode } | undefined>();
  // Answered (here, from the page, or in another browser): its browser has closed with it.
  useEffect(() => {
    if (!waiting.length) setBrowser(undefined);
  }, [waiting.length]);
  /** Where it can open in a window instead (asked once a secret waits); the way offered first, as a hand-over's card does. */
  const windowAt = useWindowAt(waiting.length > 0);
  const first = preferredMode(windowAt ? ['window', 'screencast'] : ['screencast'], {
    desktop: isAppWindow(navigator.userAgent),
    hostname: location.hostname,
  });
  /** An ask's address on this computer or the local network, shown whole, which the user confirms before it opens. */
  const [nearby, setNearby] = useState<{ name: string; message: string; window: boolean } | undefined>();
  const openBrowser = (name: string, o: { confirm?: boolean; window?: boolean } = {}) =>
    void call(async () => {
      try {
        const opened = await api.openSecretsBrowser(convId, messageId, part.id, name, o);
        setBrowser({ id: opened.handoverId, mode: opened.mode });
        setNearby(undefined);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'nearby') return setNearby({ name, message: e.message, window: Boolean(o.window) });
        throw e;
      }
    });
  const saveFromPage = (id: string, name: string) => api.saveSecretSelection(convId, messageId, part.id, id, name).then(() => undefined);
  const closeBrowser = (id: string) => {
    setBrowser(undefined);
    void api.answerHandover(convId, id, { action: 'done' }).catch(() => undefined);
  };
  const answer = async (decline: boolean) => {
    const done = await call(() => api.answerSecrets(convId, messageId, part.id, decline ? { decline: true } : { values: filled }));
    // The values leave the page once sent.
    if (done) setValues({});
  };
  return (
    <section className={`outbox-card handoff-card ${waiting.length ? '' : 'handoff-done'}`} aria-label={c.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <KeyIcon size={16} />
        </span>
        <strong>{c.title}</strong>
        {!waiting.length && <span className="approval-waiting">{c.status[part.asks[0]?.status ?? 'saved']}</span>}
      </header>
      <p className="muted small">{c.folder(part.folder)}</p>
      <ul className="handoff-asks">
        {part.asks.map((a) => {
          const id = `secret-${part.id}-${a.name}`;
          return (
            <li key={a.name} className={`handoff-ask handoff-${a.status}`}>
              <label htmlFor={id}>
                <code>{a.name}</code>
                {a.label && <span> · {a.label}</span>}
              </label>
              {a.reason && <p className="small">{a.reason}</p>}
              {/* The whole address the agent named, which the user can also open in their own browser. */}
              {a.url && a.status === 'waiting' && (
                <p className="small handoff-where">
                  <span className="muted">{alone.where}</span>{' '}
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.url}
                  </a>
                </p>
              )}
              {a.status === 'waiting' ? (
                <>
                  {a.had && <p className="muted small">{c.had}</p>}
                  <div className="handoff-browsers">
                    {windowAt && (
                      <button
                        type="button"
                        className={`${first === 'window' ? 'primary' : 'ghost'} small-button handoff-browser`}
                        disabled={busy}
                        onClick={() => openBrowser(a.name, { window: true })}
                      >
                        {a.url ? alone.openWindowAt(hostOf(a.url)) : alone.openWindow}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost small-button handoff-browser"
                      disabled={busy}
                      onClick={() => openBrowser(a.name)}
                    >
                      {a.url ? alone.openAt(hostOf(a.url)) : alone.open}
                    </button>
                  </div>
                  {nearby?.name === a.name && (
                    <div className="handoff-nearby" role="alert">
                      <p className="warn-line small">{nearby.message}</p>
                      <div className="approval-actions">
                        <button
                          type="button"
                          className="primary small-button"
                          disabled={busy}
                          onClick={() => openBrowser(a.name, { confirm: true, window: nearby.window })}
                        >
                          {alone.openAnyway}
                        </button>
                        <button type="button" className="ghost small-button" onClick={() => setNearby(undefined)}>
                          {t.common.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="input-row">
                    <input
                      id={id}
                      type={shown[a.name] ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={c.placeholder}
                      value={values[a.name] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      className="ghost small-button"
                      aria-pressed={Boolean(shown[a.name])}
                      onClick={() => setShown((s) => ({ ...s, [a.name]: !s[a.name] }))}
                    >
                      {shown[a.name] ? c.hide : c.show}
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted small">{a.status === 'saved' && a.from === 'page' ? alone.fromPage : c.status[a.status]}</p>
              )}
            </li>
          );
        })}
      </ul>
      {/* Open in a window: right under the secrets whose buttons opened it. */}
      {browser?.mode === 'window' && waiting.length > 0 && (
        <WindowedBrowser
          key={browser.id}
          convId={convId}
          handoverId={browser.id}
          names={waiting.map((a) => ({ name: a.name, ...(a.label ? { label: a.label } : {}) }))}
          onSave={(name) => saveFromPage(browser.id, name)}
          onClose={() => closeBrowser(browser.id)}
          onEnded={() => setBrowser(undefined)}
        />
      )}
      {waiting.length > 0 && (
        <>
          <p className="muted small">{c.hint}</p>
          <p className="muted small">{alone.hint}</p>
          {windowAt && <p className="muted small">{windowAt === 'desktop' ? alone.windowDesktop : alone.windowServer}</p>}
          {error && <p className="error-line">{error}</p>}
          <div className="approval-actions">
            <button
              type="button"
              className="primary small-button"
              disabled={busy || !Object.keys(filled).length}
              onClick={() => void answer(false)}
            >
              {c.save}
            </button>
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void answer(true)}>
              {c.decline}
            </button>
          </div>
        </>
      )}
      {browser?.mode === 'screencast' && waiting.length > 0 && (
        <HandoverPanel
          convId={convId}
          handoverId={browser.id}
          reason={alone.line}
          asks={[]}
          onApproval={undefined}
          busy={busy}
          title={alone.title}
          doneLabel={alone.close}
          onHide={() => setBrowser(undefined)}
          onEnded={() => setBrowser(undefined)}
          onDone={() => closeBrowser(browser.id)}
          saveAs={{
            names: waiting.map((a) => ({ name: a.name, ...(a.label ? { label: a.label } : {}) })),
            onSave: (name) => saveFromPage(browser.id, name),
          }}
        />
      )}
    </section>
  );
}

/** A fixed command a reply proposes: save it (or edit it first) or not; once saved, try it and tell the team. */
export function CommandCard({
  part,
  convId,
  messageId,
  agentName,
}: {
  part: CommandPart;
  convId: string;
  messageId: string;
  agentName: string;
}) {
  const t = useT();
  const c = t.handoffs.command;
  const { busy, error, call } = useCall();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formOf(part.proposal));
  const [extra, setExtra] = useState('');
  const [stdin, setStdin] = useState('');
  const [diff, setDiff] = useState<{ changed: string[]; diff: string; missing: string[]; digest: string } | null>(null);
  const actions = commandActions(part);
  const p = part.proposal;
  const run = part.run;
  const edited = editing ? proposalOf(form) : undefined;
  // The code it would run, which Save pins: shown first, for the command as it would be saved (its edits).
  const [code, setCode] = useState<{ diff: string; missing: string[]; digest: string; of: string } | null>(null);
  const codeOf = JSON.stringify(editing ? (edited ?? null) : p);
  const seen = code && code.of === codeOf ? code : null;
  const showCode = () =>
    seen
      ? setCode(null)
      : void call(async () =>
          setCode({ ...(await api.commandCode(convId, messageId, part.id, editing ? edited : undefined)), of: codeOf }),
        );
  const save = () =>
    call(async () => {
      await api.commandCard(convId, messageId, part.id, 'save', editing ? edited : undefined, seen?.digest);
      setEditing(false);
    });
  // Approve sends the digest of the code whose diff the user looked at: a later change is refused.
  const tryIt = (approve?: string) =>
    call(async () => {
      await api.tryCommand(convId, part.commandId!, {
        ...(extra.trim() ? { extra } : {}),
        ...(stdin ? { stdin } : {}),
        ...(approve ? { approve } : {}),
      });
      setDiff(null);
    });
  const toggleDiff = () => (diff ? setDiff(null) : void call(async () => setDiff(await api.commandDiff(convId, part.commandId!))));
  const field = (key: keyof typeof form, label: string, hint?: string, multiline = false) => (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={2} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} spellCheck={false} />
      ) : (
        <input value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} spellCheck={false} />
      )}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
  const tone = run ? runTone(run) : undefined;
  return (
    <section className={`outbox-card handoff-card handoff-command-${part.status}`} aria-label={c.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <CommandIcon size={16} />
        </span>
        <strong>{c.title(p.name)}</strong>
        <span className="approval-waiting">{part.superseded ? c.superseded : c.status[part.status]}</span>
      </header>
      {editing ? (
        <div className="handoff-form">
          {field('name', c.name)}
          {field('run', c.run, undefined, true)}
          {field('hosts', c.hosts, c.hostsHint)}
          {field('secrets', c.secrets, c.secretsHint)}
          {field('cwd', c.folder, c.cwdHint)}
        </div>
      ) : (
        <dl className="outbox-fields">
          <div>
            <dt>{c.run}</dt>
            <dd>
              <code className="handoff-run">{p.run}</code>
            </dd>
          </div>
          <div>
            <dt>{c.folder}</dt>
            <dd>{p.cwd ? `${part.folder}/${p.cwd}` : part.folder}</dd>
          </div>
          <div>
            <dt>{c.hosts}</dt>
            <dd>{p.hosts.length ? p.hosts.join(', ') : c.noHosts}</dd>
          </div>
          {p.secrets.length > 0 && (
            <div>
              <dt>{c.secrets}</dt>
              <dd>
                {p.secrets.map((s) => (
                  <code key={s} className="handoff-secret-name">
                    {s}
                  </code>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      {actions.decide && part.replaces && !part.blocked && <p className="warn-line small">{c.replaces}</p>}
      {actions.decide && part.blocked && <p className="warn-line small">{part.blocked === 'windows' ? c.windows : c.blocked}</p>}
      {actions.decide && part.blocked !== 'windows' && <p className="muted small">{c.hint}</p>}
      {actions.decide && !part.blocked && (
        <div className="handoff-code">
          <button
            type="button"
            className="ghost small-button"
            disabled={busy || (editing && !edited)}
            onClick={showCode}
            aria-expanded={Boolean(seen)}
          >
            {seen ? c.hideCode : c.showCode}
          </button>
          {!seen && <p className="muted small">{c.codeHint}</p>}
          {seen && (seen.diff ? <pre className="outbox-body handoff-diff">{seen.diff}</pre> : <p className="muted small">{c.noCode}</p>)}
          {seen && seen.missing.length > 0 && <p className="muted small">{c.codeNotShown(seen.missing.join(', '))}</p>}
        </div>
      )}
      {run && tone && (
        <div className={`handoff-run-result handoff-${tone.tone}`} role="status">
          <div>
            <strong>{c.result[run.status]}</strong>
            {tone.code && run.exitCode !== undefined && <span className="muted small"> · {c.exitCode(run.exitCode)}</span>}
          </div>
          {run.reason && <p className="small">{run.reason}</p>}
          {run.status === 'changed' && (
            <>
              <p className="small">{c.changedHint}</p>
              {run.changed && run.changed.length > 0 && (
                <ul className="handoff-changed">
                  {run.changed.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="ghost small-button" disabled={busy} onClick={toggleDiff}>
                {diff ? c.hideDiff : c.showDiff}
              </button>
              {diff &&
                (diff.diff ? <pre className="outbox-body handoff-diff">{diff.diff}</pre> : <p className="muted small">{c.noDiff}</p>)}
              {diff && diff.diff && diff.missing.length > 0 && <p className="muted small">{c.someNoDiff(diff.missing.join(', '))}</p>}
            </>
          )}
          {run.output && (
            <>
              <p className="muted small">{c.output}</p>
              <pre className="outbox-body">{run.output}</pre>
            </>
          )}
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
      {actions.decide && (
        <div className="approval-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="primary small-button"
                disabled={busy || !edited || !seen}
                title={seen ? undefined : c.codeHint}
                onClick={() => void save()}
              >
                {c.save}
              </button>
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setForm(formOf(p));
                }}
              >
                {c.cancel}
              </button>
            </>
          ) : (
            <>
              {!part.blocked && (
                <>
                  <button
                    type="button"
                    className="primary small-button"
                    disabled={busy || !seen}
                    title={seen ? undefined : c.codeHint}
                    onClick={() => void save()}
                  >
                    {c.save}
                  </button>
                  <button type="button" className="ghost small-button" disabled={busy} onClick={() => setEditing(true)}>
                    {c.edit}
                  </button>
                </>
              )}
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'dismiss'))}
              >
                {c.dismiss}
              </button>
            </>
          )}
        </div>
      )}
      {part.status === 'saved' && (
        <div className="handoff-try">
          {actions.tryIt && !actions.approve && (
            <label className="field">
              <span>{c.extra}</span>
              <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={c.extraPlaceholder} spellCheck={false} />
            </label>
          )}
          {actions.tryIt && !actions.approve && (
            <label className="field">
              <span>{c.stdin}</span>
              <textarea value={stdin} onChange={(e) => setStdin(e.target.value)} placeholder={c.stdinPlaceholder} rows={2} />
            </label>
          )}
          <div className="approval-actions">
            {actions.approve ? (
              <button
                type="button"
                className="primary small-button"
                disabled={busy || !diff?.digest}
                title={diff ? undefined : c.approveNeedsDiff}
                onClick={() => void tryIt(diff?.digest)}
              >
                {c.approve}
              </button>
            ) : (
              <button type="button" className="primary small-button" disabled={busy || !actions.tryIt} onClick={() => void tryIt()}>
                {run?.status === 'running' ? c.running : c.tryIt}
              </button>
            )}
            {actions.share && (
              <button
                type="button"
                className="ghost small-button"
                disabled={busy}
                onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'share'))}
              >
                {c.share}
              </button>
            )}
            <button
              type="button"
              className="ghost small-button"
              disabled={busy}
              onClick={() => void call(() => api.commandCard(convId, messageId, part.id, 'continue'))}
            >
              {c.continue}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A command a reply asks the user to run themselves (a sign-in, a CLI's login): where it runs and
 * Start; while it runs, its masked output with the links and codes picked out, a line to type into it
 * (hidden or not), its password helper's question and Cancel; once it ended, Send to the team.
 */
export function InteractiveCard({
  part,
  convId,
  messageId,
  agentName,
}: {
  part: InteractivePart;
  convId: string;
  messageId: string;
  agentName: string;
}) {
  const { t, lang } = useI18n();
  const c = t.handoffs.interactive;
  const { busy, error, call } = useCall();
  const [workdir, setWorkdir] = useState(() => startsInWorkdir(part));
  const [line, setLine] = useState('');
  // Hidden while the program seems to ask for a password, until the user says otherwise.
  const [hideChoice, setHideChoice] = useState<boolean | null>(null);
  const [answer, setAnswer] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const s = part.session;
  const actions = interactiveActions(part);
  const running = s?.state === 'running';
  const hide = hideChoice ?? wantsHidden(s?.output ?? '');
  const key = part.status === 'dismissed' ? 'dismissed' : s ? s.state : 'proposed';
  useEffect(() => {
    const el = output.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s?.output]);
  const post = (b: Parameters<typeof api.interactiveCard>[3]) => call(() => api.interactiveCard(convId, messageId, part.id, b));
  const sendLine = async () => {
    if (await post({ action: 'input', text: line, hidden: hide })) {
      setLine('');
      setHideChoice(null);
    }
  };
  const answerAsk = async (refuse: boolean) => {
    if (!s?.asking) return;
    const done = await post(refuse ? { action: 'answer', askId: s.asking.id } : { action: 'answer', askId: s.asking.id, text: answer });
    if (done) {
      setAnswer('');
      setShowAnswer(false);
    }
  };
  const ended = (x: NonNullable<InteractivePart['session']>) => {
    switch (x.state) {
      case 'exited':
        return c.ended.exited(x.exitCode);
      case 'timedOut':
        return c.ended.timedOut(Math.round((x.endsAt - x.startedAt) / 60_000));
      case 'running':
        return c.status.running;
      default:
        return c.ended[x.state];
    }
  };
  const time = (ms: number) => new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  return (
    <section className={`outbox-card handoff-card interactive-card handoff-interactive-${key}`} aria-label={c.label(agentName)}>
      <header className="approval-head">
        <span className="approval-icon" aria-hidden>
          <CommandIcon size={16} />
        </span>
        <strong>{c.title}</strong>
        <span className="approval-waiting">{c.status[key]}</span>
      </header>
      <p className="small interactive-asks">
        {c.asks(agentName)}
        {part.reason && <> {part.reason}</>}
      </p>
      <dl className="outbox-fields">
        <div>
          <dt>{c.command}</dt>
          <dd>
            <code className="handoff-run">{part.run}</code>
          </dd>
        </div>
        {/* Where it runs now, or where it ran: the choice below is for the next run. */}
        {s && (
          <div>
            <dt>{running ? c.where : c.whereRan}</dt>
            <dd>{s.inWorkdir ? c.workdir(part.folder) : c.ownFolder}</dd>
          </div>
        )}
      </dl>
      {part.blocked && <p className="warn-line small">{c[part.blocked]}</p>}
      {actions.start && (
        <fieldset className="interactive-where">
          <legend className="small">{c.where}</legend>
          <label className="check-row">
            <input type="radio" name={`where-${part.id}`} checked={!workdir} onChange={() => setWorkdir(false)} disabled={busy} />
            <span>{c.ownFolder}</span>
          </label>
          <label className="check-row">
            <input type="radio" name={`where-${part.id}`} checked={workdir} onChange={() => setWorkdir(true)} disabled={busy} />
            <span className="interactive-folder">{c.workdir(part.folder)}</span>
          </label>
          {part.workdir && <p className="muted small">{c.agentWantsWorkdir}</p>}
          {workdir &&
            (part.configFiles.length ? (
              <div className="interactive-config">
                <p className="small">{c.configFiles}</p>
                <ul className="handoff-changed">
                  {part.configFiles.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="muted small">{c.noConfigFiles}</p>
            ))}
        </fieldset>
      )}
      {actions.start && !s && (
        <p className="muted small">
          {c.rights} {c.noTerminal}
        </p>
      )}
      {s && (
        <div className={`handoff-run-result handoff-${sessionTone(s)}`}>
          {/* Its state is announced, not each line of its output. */}
          <p role="status">
            <strong>{ended(s)}</strong>
            {running && <span className="muted small"> · {c.stopsAt(time(s.endsAt))}</span>}
          </p>
          {s.reason && <p className="small">{s.reason}</p>}
          {running && s.helper === 'no-node' && <p className="muted small">{c.noNode}</p>}
          <LoginLinks login={s} />
          <p className="muted small">{c.output}</p>
          <pre ref={output} className="outbox-body interactive-output" tabIndex={0}>
            {s.output || c.noOutput}
          </pre>
        </div>
      )}
      {running && s?.asking && (
        <form
          className="interactive-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void answerAsk(false);
          }}
        >
          <label htmlFor={`ask-${part.id}`} className="small">
            {c.helperAsks} <code>{s.asking.prompt}</code>
          </label>
          <div className="input-row">
            <input
              id={`ask-${part.id}`}
              type={showAnswer ? 'text' : 'password'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={c.helperField}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              disabled={busy}
            />
            <button type="button" className="ghost small-button" aria-pressed={showAnswer} onClick={() => setShowAnswer((v) => !v)}>
              {showAnswer ? c.hideAnswer : c.show}
            </button>
          </div>
          <div className="approval-actions">
            <button type="submit" className="primary small-button" disabled={busy}>
              {c.answer}
            </button>
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void answerAsk(true)}>
              {c.refuse}
            </button>
          </div>
        </form>
      )}
      {actions.type && (
        <form
          className="interactive-input"
          onSubmit={(e) => {
            e.preventDefault();
            void sendLine();
          }}
        >
          <label htmlFor={`line-${part.id}`} className="small">
            {c.input}
          </label>
          <div className="input-row">
            <input
              id={`line-${part.id}`}
              type={hide ? 'password' : 'text'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={c.inputPlaceholder}
              value={line}
              onChange={(e) => setLine(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="primary small-button" disabled={busy}>
              {c.send}
            </button>
          </div>
          <label className="check-row small">
            <input type="checkbox" checked={hide} onChange={(e) => setHideChoice(e.target.checked)} />
            <span>{c.hide}</span>
          </label>
        </form>
      )}
      {error && <p className="error-line">{error}</p>}
      {(actions.type || actions.send || actions.sent || actions.start || actions.dismiss) && (
        <div className="approval-actions">
          {actions.type && (
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void post({ action: 'cancel' })}>
              {c.cancel}
            </button>
          )}
          {actions.send && (
            <button type="button" className="primary small-button" disabled={busy} onClick={() => void post({ action: 'send' })}>
              {c.sendTeam}
            </button>
          )}
          {actions.sent && <span className="muted small interactive-sent">{c.sent}</span>}
          {actions.start && (
            <button
              type="button"
              className={`${actions.send ? 'ghost' : 'primary'} small-button`}
              disabled={busy}
              onClick={() => void post({ action: 'start', ...startRequest(part, workdir) })}
            >
              {s ? c.startAgain : workdir ? c.startHere : c.start}
            </button>
          )}
          {actions.dismiss && (
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void post({ action: 'dismiss' })}>
              {c.dismiss}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
