import { useEffect, useState } from 'react';
import { PROVIDER_LABEL, cwdsOf, type Conversation, type ConversationSchedule, type LeadAgentSettings, type ProviderModels, type ProviderStatus } from '../../shared/types';
import { api, orCreateCwd } from '../api';
import { useI18n } from '../i18n';
import { useLimits } from '../limits';
import { draftFrom, draftProblems, toUpdate, type ScheduleDraft } from '../schedule';
import { leadLabel } from '../util';
import { autoTeam, lastAutoConfirm, rememberAutoConfirm } from './NewChat';
import { ScheduleForm } from './ScheduleForm';
import { TeamEditor, teamProblems, type Team } from './TeamEditor';

interface Props {
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  onCreated: (c: Conversation) => void;
}

/**
 * A new schedule (New schedule in the sidebar): its message, times and choices, and the settings of the
 * conversation it lives in. Once created, the lead agent designs the team for the message; nothing runs
 * until the schedule sends it.
 */
export function NewSchedule({ providers, catalog, onCreated }: Props) {
  const { t, lang } = useI18n();
  const { maxTeamAgents } = useLimits();
  const [lead, setLead] = useState<LeadAgentSettings | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFrom(undefined, Date.now()));
  /** The user changed the form: its problems are shown from then on. */
  const [touched, setTouched] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        setLead(settings.lead);
        // The default working directory from Settings; asking first unless the last chat did not.
        setTeam((current) => current ?? autoTeam(cwdsOf({ cwd: settings.defaultCwd, extraCwds: settings.defaultExtraCwds }), lastAutoConfirm()));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [lang]);

  if (!team) return <div className="page-center muted">{error || t.common.loading}</div>;

  const edit = (patch: Partial<ScheduleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTouched(true);
    setError('');
  };
  const problems = [...draftProblems(draft, Date.now(), t), ...teamProblems(team, t, { maxAgents: maxTeamAgents })];
  const leadText = lead ? leadLabel(lead) : PROVIDER_LABEL.claude;
  // What the team editor warns about: the runs this schedule starts may have nobody watching.
  const schedule: ConversationSchedule = { ...toUpdate(draft), lang, updatedAt: 0 };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const conv = await orCreateCwd(
        (createCwd) => api.createSchedule({ title: title.trim() || undefined, settings: team.settings, createCwd, schedule: toUpdate(draft) }),
        (missing) => confirm(t.newChat.confirmCreateCwd(missing)),
      );
      rememberAutoConfirm(team.settings.autoConfirm);
      onCreated(conv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page new-chat-page">
      <div className="scroll new-chat-body">
        <div className="page-inner">
          <header className="page-head">
            <h1>{t.newSchedule.title}</h1>
            <p className="muted">{t.newSchedule.intro(leadText)}</p>
          </header>

          <section>
            <div className="section-head">
              <h3>{t.newSchedule.schedule}</h3>
            </div>
            <ScheduleForm draft={draft} onEdit={edit} settings={team.settings} />
          </section>

          <TeamEditor value={team} onChange={setTeam} providers={providers} catalog={catalog} leadLabel={leadText} schedule={schedule} />
        </div>
      </div>

      {/* Outside the scrolling area, so it stays at the bottom of the window. */}
      <footer className="start-dock">
        <div className="start-bar">
          <input className="title-input" value={title} placeholder={t.newSchedule.titlePlaceholder} onChange={(e) => setTitle(e.target.value)} />
          <button className="primary" onClick={create} disabled={busy || problems.length > 0}>
            {busy ? t.newSchedule.creating : t.newSchedule.create}
          </button>
        </div>
        {(error || (touched && problems[0])) && <p className="error-line">{error || problems[0]}</p>}
      </footer>
    </div>
  );
}
