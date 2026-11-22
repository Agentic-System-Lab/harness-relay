import { useEffect, useRef, useState } from 'react';
import type { ProviderModels, ProviderStatus, TeamPreset } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { useLimits } from '../limits';
import { revisionOutcome, sameTeam } from '../chat';
import { teamChangeText } from '../copy';
import { blankAgents, fitTemplateAgents, templateKey, templateTextChanges } from '../templates';
import { LeadAsk } from './LeadAsk';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';
import { useDialog } from './useDialog';

/** A template's team as the editor holds it (a template has no working directory). */
function teamOf(p: TeamPreset): Team {
  return {
    // Fresh ids so edits never leak back into the preset object.
    agents: p.agents.map((a) => ({ ...a, id: crypto.randomUUID() })),
    settings: { ...p.settings, cwd: '' },
  };
}

/**
 * The team the editor opens with: a new template's members on the CLIs ready here, a template's
 * own moved off the CLIs that cannot run here (`moved`, their names). Only once the CLIs' statuses
 * have come (`known`); before that, a new template has no members and a template stays as it is.
 */
function opening(preset: TeamPreset | undefined, providers: ProviderStatus[]): { team: Team; moved: string[]; known: boolean } {
  const known = providers.length > 0;
  if (!preset) {
    return {
      team: { agents: blankAgents(providers), settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: '' } },
      moved: [],
      known,
    };
  }
  const team = teamOf(preset);
  const fit = fitTemplateAgents(team.agents, providers);
  return { team: { ...team, agents: fit.agents }, moved: fit.moved, known };
}

interface Props {
  /** The template to edit (a built-in one is saved as a copy of the user's); none: a new template. */
  preset?: TeamPreset;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onSaved: (p: TeamPreset) => void;
  onClose: () => void;
}

/**
 * A template the lead agent may choose for a question, in a dialog: its name, what it is for, its
 * members and how they take turns. The user designs teams here; the lead picks, adapts or replaces
 * them per question.
 */
export function TemplateEditor({ preset, providers, catalog, onSaved, onClose }: Props) {
  const t = useT();
  const { maxTeamAgents } = useLimits();
  const builtin = Boolean(preset?.builtin);
  const [name, setName] = useState(() => (preset ? (builtin ? t.template.copyName(preset.name) : preset.name) : ''));
  const [description, setDescription] = useState(preset?.description ?? '');
  const [start] = useState(() => opening(preset, providers));
  const [team, setTeam] = useState<Team>(start.team);
  const [moved, setMoved] = useState(start.moved);
  // What the editor opened with: a template that exists is saved (or copied) only once something
  // changed, or its members moved off CLIs that cannot run here, and closing asks before dropping
  // changes the user made.
  const keyOf = (agents: Team['agents'], settings: Team['settings']) => templateKey({ name, description, agents, settings });
  const [opened, setOpened] = useState(() => keyOf(start.team.agents, start.team.settings));
  const changed = keyOf(team.agents, team.settings) !== opened;
  const unchanged = Boolean(preset) && !changed && moved.length === 0;
  // Opened before the CLIs' statuses came (the page had just loaded): once they do, and while the
  // user has changed nothing, the members are set as they would have been.
  const known = useRef(start.known);
  useEffect(() => {
    if (known.current || !providers.length) return;
    known.current = true;
    if (changed) return;
    const next = opening(preset, providers);
    setTeam(next.team);
    setMoved(next.moved);
    setOpened(keyOf(next.team.agents, next.team.settings));
  }, [providers]); // once, when the statuses first come
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  /** The lead agent writes the template's team checks (in the editor below): Save waits for it too. */
  const [checksDrafting, setChecksDrafting] = useState(false);
  const [error, setError] = useState('');
  /** The template now, for the lead agent's answer: the user may change it while it works. */
  const latest = useRef({ name, description, team });
  latest.current = { name, description, team };
  const problems = [
    ...(name.trim() ? [] : [t.template.needName]),
    ...teamProblems(team, t, { members: true, template: true, maxAgents: maxTeamAgents }),
  ];
  const title = !preset ? t.template.newTitle : builtin ? t.template.builtinTitle(preset.name) : t.template.editTitle(preset.name);
  const close = () => {
    if (changed && !confirm(t.template.confirmDiscard)) return;
    onClose();
  };
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog, close);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const { cwd: _cwd, ...settings } = team.settings;
      const saved = await api.savePreset({
        // A saved template is updated in place; a built-in one becomes a new template of the user's.
        ...(preset && !builtin ? { id: preset.id } : {}),
        name: name.trim(),
        description: description.trim() || undefined,
        agents: team.agents,
        settings,
      });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={close}>
      <div
        ref={dialog}
        className="modal template-editor"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={close} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <div className="template-editor-body">
          {builtin && <p className="muted small">{t.template.builtinNote}</p>}
          {moved.length > 0 && <p className="muted small template-moved">{t.template.moved(moved.join(t.common.listSeparator))}</p>}
          <LeadAsk
            title={t.templateDraft.title}
            hint={t.templateDraft.hint}
            placeholder={t.templateDraft.placeholder}
            submit={t.templateDraft.submit}
            working={t.templateDraft.working}
            review={t.templateDraft.review}
            unchanged={t.templateDraft.unchanged}
            changedMeanwhile={t.templateDraft.changedMeanwhile}
            onBusy={setDrafting}
            ask={async (request, signal) => {
              const sent = latest.current;
              const { mode, rounds, maxHops } = sent.team.settings;
              const r = await api.draftTemplate(
                { request, name: sent.name, description: sent.description, agents: sent.team.agents, settings: { mode, rounds, maxHops } },
                signal,
              );
              const now = latest.current;
              if (now.name !== sent.name || now.description !== sent.description) return 'stale';
              const outcome = revisionOutcome({ sent: sent.team, now: now.team, blocked: false, revision: r });
              if (outcome.kind === 'stale') return 'stale';
              const afterTeam = outcome.kind === 'changed' ? outcome.team : sent.team;
              // A new template's members are only a starting point (one on each CLI, no role): dropping them is not news.
              const fresh = sent.team.agents.every((a) => !a.role.trim());
              const changes = [
                ...(outcome.kind === 'changed'
                  ? outcome.changes.filter((c) => !(fresh && c.kind === 'removed')).map((c) => teamChangeText(c, t))
                  : []),
                ...templateTextChanges(sent, r, t),
              ];
              if (!changes.length) return { reason: r.reason, changes: [], meta: r.meta };
              setTeam(afterTeam);
              setName(r.name);
              setDescription(r.description);
              return {
                reason: r.reason,
                changes,
                meta: r.meta,
                undo: () => {
                  setTeam(sent.team);
                  setName(sent.name);
                  setDescription(sent.description);
                },
                // Only while the template is still as the lead agent left it: later edits are not thrown away.
                undoable: () =>
                  sameTeam(latest.current.team, afterTeam) &&
                  latest.current.name === r.name &&
                  latest.current.description === r.description,
              };
            }}
          />
          {/* While the lead agent writes the template, it holds still. */}
          <fieldset className="team-fieldset template-fieldset" disabled={drafting}>
            <div className="template-fields">
              <label className="field">
                <span>{t.template.name}</span>
                <input value={name} maxLength={100} placeholder={t.template.namePlaceholder} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>{t.template.description}</span>
                <textarea
                  value={description}
                  rows={2}
                  maxLength={2000}
                  placeholder={t.template.descriptionPlaceholder}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>
            <TeamEditor
              value={team}
              onChange={setTeam}
              providers={providers}
              catalog={catalog}
              members
              template
              onDrafting={setChecksDrafting}
            />
          </fieldset>
        </div>
        <footer className="template-editor-foot">
          {error || problems[0] ? (
            <span className="error-line">{error || problems[0]}</span>
          ) : (
            unchanged && <span className="muted small">{builtin ? t.template.unchangedBuiltin : t.template.unchanged}</span>
          )}
          <button type="button" className="ghost" onClick={close}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || drafting || checksDrafting || unchanged || problems.length > 0}
            onClick={save}
          >
            {saving ? t.template.saving : builtin ? t.template.saveCopy : t.template.save}
          </button>
        </footer>
      </div>
    </div>
  );
}
