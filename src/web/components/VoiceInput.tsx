import { useEffect, useRef, useState } from 'react';
import { VOICE_MAX_SECONDS, type VoiceJobView, type VoiceModelId, type VoiceStatus } from '../../shared/types';
import { api } from '../api';
import { dialogsOpen, holdDialogs } from '../dialogs';
import { useT } from '../i18n';
import { Recorder, canRecord } from '../recorder';
import { useVoiceStatus } from '../useVoice';
import { formatBytes } from '../util';
import { encodeWav, formatClock, isSilent, jobPercent, jobSecondsLeft, setupBytes, toBase64, voiceMode } from '../voice';
import { MicIcon } from './icons';
import { useDialog } from './useDialog';
import { settingsHref } from '../route';

type RecState = 'idle' | 'starting' | 'recording' | 'transcribing';

/**
 * The composer's microphone. Before voice input is set up it explains what gets installed and starts
 * the install; once it is ready, press to record, press again to turn the recording into text.
 */
export function VoiceButton({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const t = useT();
  const { status, setStatus, refresh } = useVoiceStatus();
  const [rec, setRec] = useState<RecState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [dialog, setDialog] = useState(false);
  const recorder = useRef<Recorder | null>(null);
  const startedAt = useRef(0);
  // The latest callbacks: a transcript arrives after the user may have typed more.
  const cb = useRef({ onText, onError });
  cb.current = { onText, onError };
  const mode = voiceMode(status, canRecord());

  useEffect(() => () => recorder.current?.cancel(), []);

  const start = async () => {
    setRec('starting');
    const r = new Recorder();
    try {
      await r.start();
    } catch (e) {
      setRec('idle');
      const err = e as DOMException;
      cb.current.onError(err.name === 'NotAllowedError' || err.name === 'SecurityError' ? t.voice.micDenied : t.voice.micFailed(err.message));
      return;
    }
    recorder.current = r;
    startedAt.current = Date.now();
    setSeconds(0);
    setRec('recording');
    // Load the model while the user speaks.
    void api.prepareVoice().catch(() => {});
  };

  const finish = async () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    setRec('transcribing');
    try {
      const samples = await r.stop();
      if (isSilent(samples)) {
        cb.current.onError(t.voice.nothingHeard);
        return;
      }
      const { text } = await api.transcribe(toBase64(encodeWav(samples)));
      if (text.trim()) cb.current.onText(text);
      else cb.current.onError(t.voice.nothingHeard);
    } catch (e) {
      cb.current.onError((e as Error).message);
    } finally {
      setRec('idle');
      void refresh();
    }
  };

  const cancel = () => {
    recorder.current?.cancel();
    recorder.current = null;
    setRec('idle');
  };

  const finishRef = useRef(finish);
  finishRef.current = finish;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  // The clock, the length limit, and Escape to cancel.
  useEffect(() => {
    if (rec !== 'recording') return;
    const timer = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setSeconds(s);
      if (s >= VOICE_MAX_SECONDS) {
        cb.current.onError(t.voice.limitReached(VOICE_MAX_SECONDS));
        void finishRef.current();
      }
    }, 250);
    // No dialog offers itself over a recording, and one opened over it anyway takes Escape for itself.
    const release = holdDialogs();
    const below = dialogsOpen();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || dialogsOpen() > below) return;
      e.preventDefault();
      cancelRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      release();
    };
  }, [rec, t]);

  const onClick = () => {
    if (rec === 'recording') return void finish();
    if (rec !== 'idle') return;
    if (mode === 'unsupported') return cb.current.onError(t.voice.unsupported);
    if (mode === 'ready') return void start();
    setDialog(true);
  };

  const pct = status?.job ? jobPercent(status.job) : undefined;
  const label =
    rec === 'transcribing'
      ? t.voice.transcribing
      : mode === 'installing'
        ? t.voice.installing(pct)
        : mode === 'ready'
          ? t.voice.start
          : t.voice.setup;

  return (
    <>
      {rec === 'recording' ? (
        <span className="voice-recording">
          <button type="button" className="icon-button" onClick={cancel} aria-label={t.voice.cancel} title={t.voice.cancel}>
            ×
          </button>
          <button type="button" className="voice-stop" onClick={onClick} aria-label={t.voice.stop} title={t.voice.recordingHint}>
            <span className="rec-dot" aria-hidden="true" />
            {formatClock(seconds)}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`icon-button mic-button ${mode}`}
          onClick={onClick}
          disabled={rec !== 'idle'}
          aria-label={label}
          title={label}
        >
          {rec === 'idle' ? <MicIcon /> : <span className="spinner" aria-hidden="true" />}
          {mode === 'installing' && <span className="mic-badge" aria-hidden="true" />}
        </button>
      )}
      {dialog && <VoiceSetupDialog status={status} onStatus={setStatus} onClose={() => setDialog(false)} />}
    </>
  );
}

/** What voice input installs, and the install's progress once it runs. */
function VoiceSetupDialog({
  status,
  onStatus,
  onClose,
}: {
  status: VoiceStatus | null;
  onStatus: (s: VoiceStatus) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  const [picked, setPicked] = useState<VoiceModelId | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const job = status?.job;
  const running = job?.state === 'running';
  const done = job?.state === 'success' && status?.ready;
  const model = picked ?? status?.model;
  const engine = status?.engine;
  const blocked = engine && !engine.installed && (engine.problem || engine.installerNote);
  const bytes = status && model ? setupBytes(status, model) : 0;

  const install = async () => {
    if (!model) return;
    setBusy(true);
    setError('');
    try {
      onStatus(await api.installVoice(model));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancelInstall = () => api.cancelVoiceInstall().then(onStatus, (e: Error) => setError(e.message));

  const openSettings = () => {
    onClose();
    window.location.hash = settingsHref('voice');
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={ref}
        className="modal voice-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t.voice.dialogTitle}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{t.voice.dialogTitle}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>

        {!status || !engine ? (
          <p className="muted">{t.common.loading}</p>
        ) : running || done ? (
          <>
            <JobProgress job={job!} onCancel={cancelInstall} />
            <p className={running ? 'muted small' : ''}>{running ? t.voice.keepsRunning : t.voice.done}</p>
            {error && <p className="error-line">{error}</p>}
            <div className="button-row end">
              <button className="ghost" onClick={openSettings}>
                {t.voice.openSettings}
              </button>
              <button className="primary" onClick={onClose}>
                {t.common.close}
              </button>
            </div>
          </>
        ) : (
          <>
            {job && <JobProgress job={job} />}
            <p>{t.voice.intro}</p>
            <ul className="voice-items">
              <li>
                {engine.installed
                  ? t.voice.engineReady(engine.path ?? '')
                  : engine.installer === 'homebrew'
                    ? t.voice.engineHomebrew
                    : t.voice.engineDownload(formatBytes(engine.downloadSize ?? 0))}
              </li>
              <li>{t.voice.modelLabel}</li>
            </ul>
            {blocked && <p className="warn-line">{engine.problem ?? engine.installerNote}</p>}
            <div className="voice-pick" role="radiogroup" aria-label={t.voice.modelLabel}>
              {status.models.map((m) => {
                const [name, desc] = t.voice.model[m.id];
                return (
                  <label key={m.id} className={`voice-option ${model === m.id ? 'on' : ''}`}>
                    <input type="radio" name="voice-model" checked={model === m.id} onChange={() => setPicked(m.id)} />
                    <span className="grow">
                      <strong>{name}</strong>
                      <span className="muted small"> · {m.downloaded ? t.voice.downloaded : formatBytes(m.size)}</span>
                      {m.recommended && <span className="pill ok">{t.voice.recommended}</span>}
                      <span className="muted small voice-desc">{desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="muted small">
              {t.voice.storage(status.dir)}
              <br />
              {t.voice.background}
            </p>
            {error && <p className="error-line">{error}</p>}
            <div className="button-row end">
              <button className="ghost" onClick={blocked ? openSettings : onClose}>
                {blocked ? t.voice.openSettings : t.common.cancel}
              </button>
              <button className="primary" onClick={install} disabled={busy || Boolean(blocked)}>
                {bytes ? t.voice.installSize(formatBytes(bytes)) : t.voice.install}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The steps of an install, the current download and the installer's output. */
export function JobProgress({ job, onCancel }: { job: VoiceJobView; onCancel?: () => void }) {
  const t = useT();
  const pct = jobPercent(job);
  const left = jobSecondsLeft(job);
  const at = job.steps.indexOf(job.step);
  const modelName = t.voice.model[job.model][0];
  return (
    <div className={`login-panel voice-job ${job.state}`}>
      <div className="login-state">
        {job.state === 'running' && <span className="pulse" />}
        <strong>{t.voice.jobState[job.state]}</strong>
        {job.state === 'running' && onCancel && (
          <button className="ghost small-button" onClick={onCancel}>
            {t.voice.cancelInstall}
          </button>
        )}
      </div>
      <ol className="voice-steps">
        {job.steps.map((s, i) => {
          const state = job.state === 'success' || i < at ? 'done' : i > at ? 'todo' : job.state === 'running' ? 'now' : 'stopped';
          const text = s === 'engine' ? t.voice.steps.engine : s === 'model' ? t.voice.steps.model(modelName) : t.voice.steps.check;
          return (
            <li key={s} className={state}>
              <span className="step-mark" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'stopped' ? '✕' : i + 1}
              </span>
              <span>{text}</span>
              {state === 'now' && pct === undefined && <span className="spinner" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {job.state === 'running' && pct !== undefined && (
        <div className="voice-progress">
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <span className="muted small">
            {pct}% · {t.voice.progress(formatBytes(job.received ?? 0), formatBytes(job.total ?? 0))}
            {job.bytesPerSecond ? ` · ${t.voice.speed(formatBytes(job.bytesPerSecond))}` : ''}
            {left !== undefined ? ` · ${t.voice.left(formatClock(left))}` : ''}
          </span>
        </div>
      )}
      {job.state === 'failed' && job.error && <p className="error-line">{job.error}</p>}
      <details className="login-output" open={job.state === 'failed'}>
        <summary className="small muted">{t.voice.log}</summary>
        <pre>{job.log.trim() || t.voice.noLog}</pre>
      </details>
    </div>
  );
}
