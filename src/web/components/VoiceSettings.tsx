import { useEffect, useState } from 'react';
import { VOICE_LANGUAGES, type VoiceStatus } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { useVoiceStatus } from '../useVoice';
import { formatBytes } from '../util';
import { setupBytes, voicePill, type VoicePill } from '../voice';
import { JobProgress } from './VoiceInput';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

const PILL_CLASS: Record<VoicePill, string> = { off: '', installing: 'warn', ready: 'ok', needsModel: 'warn', broken: 'off' };

/** Settings → Voice input: the engine, the install, the models and the spoken language. */
export function VoiceCard() {
  const t = useT();
  const { status, setStatus, error } = useVoiceStatus();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [bin, setBin] = useState('');
  useEffect(() => setBin(status?.bin ?? ''), [status?.bin]);

  const act = async (fn: () => Promise<VoiceStatus>, ok?: string) => {
    setBusy(true);
    setNote('');
    try {
      setStatus(await fn());
      if (ok) setNote(ok);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <section className="card" id={sectionId('voice')}>
        <SectionTitle section="voice">{t.voice.title}</SectionTitle>
        <p className="muted small">{error || t.common.loading}</p>
      </section>
    );
  }

  const { engine, job } = status;
  const running = job?.state === 'running';
  const pill = voicePill(status);
  const canInstall = engine.installed || (engine.installer !== 'none' && !engine.problem);
  const bytes = setupBytes(status);

  return (
    <section className="card voice-card" id={sectionId('voice')}>
      <header className="provider-head">
        <SectionTitle section="voice">{t.voice.title}</SectionTitle>
        <span className={`pill ${PILL_CLASS[pill]}`}>{t.voice.pill[pill]}</span>
      </header>
      <p className="muted small">{t.voice.hint}</p>

      <div className="voice-row">
        <span className="voice-label">{t.voice.engine}</span>
        <div className="voice-value">
          {engine.installed ? (
            <>
              <span className="small">
                whisper.cpp{engine.version && ` ${engine.version}`} · {t.voice.engineSource[engine.source ?? 'path']}
                {t.voice.accel[engine.accel] && ` · ${t.voice.accel[engine.accel]}`}
              </span>
              <code className="small voice-path">{engine.path}</code>
              <span className="muted small">{t.voice.server[status.server]}</span>
            </>
          ) : engine.problem || engine.installerNote ? (
            <p className="warn-line">{engine.problem ?? engine.installerNote}</p>
          ) : (
            <span className="muted small">
              {engine.installer === 'homebrew' ? t.voice.engineMissingHomebrew : t.voice.engineMissingDownload(formatBytes(engine.downloadSize ?? 0))}
            </span>
          )}
        </div>
      </div>

      {job && <JobProgress job={job} onCancel={() => void act(api.cancelVoiceInstall)} />}

      {!status.ready && !running && canInstall && (
        <div className="button-row">
          <button className="primary" onClick={() => void act(() => api.installVoice(status.model))} disabled={busy}>
            {bytes ? t.voice.installSize(formatBytes(bytes)) : t.voice.install}
          </button>
        </div>
      )}

      <div className="voice-row">
        <span className="voice-label">{t.voice.models}</span>
        <div className="voice-value">
          <p className="muted small">{t.voice.modelsHint}</p>
          <ul className="voice-models">
            {status.models.map((m) => {
              const [name, desc] = t.voice.model[m.id];
              const active = m.id === status.model;
              const downloading = running && job?.model === m.id;
              return (
                <li key={m.id} className={active ? 'on' : ''}>
                  <div className="grow">
                    <div className="voice-model-name">
                      <strong>{name}</strong>
                      <span className="muted small">{formatBytes(m.size)}</span>
                      {m.recommended && <span className="pill">{t.voice.recommended}</span>}
                      {active && <span className="pill ok">{t.voice.inUse}</span>}
                      {m.downloaded && !active && <span className="muted small">{t.voice.downloaded}</span>}
                    </div>
                    <div className="muted small">{desc}</div>
                  </div>
                  <div className="button-row">
                    {m.downloaded
                      ? !active && (
                          <button className="ghost small-button" disabled={busy} onClick={() => void act(() => api.updateVoice({ model: m.id }))}>
                            {t.voice.use}
                          </button>
                        )
                      : (
                          <button
                            className="ghost small-button"
                            disabled={busy || running || !canInstall}
                            onClick={() => void act(() => api.installVoice(m.id))}
                          >
                            {t.voice.downloadAndUse}
                          </button>
                        )}
                    {m.downloaded && (
                      <button
                        className="ghost small-button"
                        disabled={busy || downloading}
                        onClick={() => confirm(t.voice.confirmDelete(name)) && void act(() => api.deleteVoiceModel(m.id))}
                      >
                        {t.common.remove}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="voice-row">
        <span className="voice-label">{t.voice.language}</span>
        <div className="voice-value voice-language">
          <div className="segmented" role="radiogroup" aria-label={t.voice.language}>
            {VOICE_LANGUAGES.map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={status.language === l}
                className={status.language === l ? 'on' : ''}
                disabled={busy}
                onClick={() => status.language !== l && void act(() => api.updateVoice({ language: l }))}
              >
                {t.voice.languages[l]}
              </button>
            ))}
          </div>
          <p className="muted small">{t.voice.languageHint}</p>
        </div>
      </div>

      <details className="sub">
        <summary>{t.voice.advanced}</summary>
        <div className="sub-body">
          <label className="field inline">
            <span>{t.voice.bin}</span>
            <input value={bin} placeholder="whisper-server" onChange={(e) => setBin(e.target.value)} spellCheck={false} />
          </label>
          <p className="muted small">{t.voice.binHint}</p>
          <div className="button-row">
            <button className="ghost" disabled={busy || bin.trim() === status.bin} onClick={() => void act(() => api.updateVoice({ bin }), t.settings.saved)}>
              {t.common.save}
            </button>
          </div>
          <p className="muted small">{t.voice.dir(status.dir)}</p>
          <p className="muted small">
            {t.voice.uninstallHint}
            {engine.source === 'homebrew' && ` ${t.voice.uninstallBrew}`}
          </p>
          <div className="button-row">
            <button
              className="ghost"
              disabled={busy || running}
              onClick={() => confirm(t.voice.confirmUninstall) && void act(api.uninstallVoice, t.voice.removed)}
            >
              {t.voice.uninstall}
            </button>
          </div>
        </div>
      </details>

      {note && <p className="muted small">{note}</p>}
    </section>
  );
}
