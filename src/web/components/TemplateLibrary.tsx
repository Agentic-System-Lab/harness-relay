import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderModels, ProviderStatus, TeamPreset } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { Deferred, lazyPart } from './Deferred';
import { MemberDots } from './MemberDots';

const TemplateEditor = lazyPart(() => import('./TemplateEditor').then((m) => m.TemplateEditor));

type Editing = { key: string; preset?: TeamPreset };

/** The same saved teams are available when starting a chat or an automation. */
export function TemplateLibrary({ providers, catalog }: { providers: ProviderStatus[]; catalog: ProviderModels[] }) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [presets, setPresets] = useState<TeamPreset[]>();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState('');

  // The built-in names and descriptions follow the current language.
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setError('');
    setPresets(undefined);
    api
      .listPresets()
      .then((list) => {
        if (active) setPresets(list);
      })
      .catch((e) => {
        if (active) setError(String(e.message ?? e));
      });
    return () => {
      active = false;
    };
  }, [expanded, lang]);

  const open = (preset?: TeamPreset) => setEditing({ key: preset ? preset.id : `new-${Date.now()}`, preset });

  const saved = (p: TeamPreset) => {
    setPresets((ps) => (ps?.some((x) => x.id === p.id) ? ps.map((x) => (x.id === p.id ? p : x)) : [...(ps ?? []), p]));
    setEditing(null);
  };

  const deletePreset = async (p: TeamPreset) => {
    if (!confirm(t.newChat.confirmDeleteTemplate(p.name))) return;
    try {
      await api.deletePreset(p.id);
      setPresets((ps) => ps?.filter((x) => x.id !== p.id));
      if (editing?.preset?.id === p.id) setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <details className="template-library" onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>{t.newChat.templates}</summary>
        <p className="muted small">{t.newChat.templatesHint}</p>
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        {presets ? (
          <div className="preset-row">
            {presets.map((p) => (
              <div key={p.id} className="preset-card">
                {/* Every card the same size: a long name or description ends in "…" (in full on hover). */}
                <button className="preset-main" onClick={() => open(p)} aria-haspopup="dialog">
                  <span className="preset-top">
                    <MemberDots agents={p.agents} className="preset-dots" max={6} />
                    {p.builtin && <span className="preset-tag">{t.newChat.builtin}</span>}
                  </span>
                  <strong className="preset-name" title={p.name}>
                    {p.name}
                  </strong>
                  {p.description && (
                    <span className="muted small preset-desc" title={p.description}>
                      {p.description}
                    </span>
                  )}
                </button>
                {!p.builtin && (
                  <button className="icon-button preset-delete" aria-label={t.newChat.deleteTemplate} onClick={() => deletePreset(p)}>
                    ×
                  </button>
                )}
              </div>
            ))}
            <div className="preset-card new-template">
              <button className="preset-main" onClick={() => open()} aria-haspopup="dialog">
                <strong className="preset-name">＋ {t.newChat.newTemplate}</strong>
                <span className="muted small preset-desc">{t.newChat.newTemplateDescription}</span>
              </button>
            </div>
          </div>
        ) : (
          !error && (
            <p className="muted small" role="status">
              {t.common.loading}
            </p>
          )
        )}
      </details>
      {editing &&
        createPortal(
          <Deferred onClose={() => setEditing(null)}>
            <TemplateEditor
              key={editing.key}
              preset={editing.preset}
              providers={providers}
              catalog={catalog}
              onSaved={saved}
              onClose={() => setEditing(null)}
            />
          </Deferred>,
          document.body,
        )}
    </>
  );
}
