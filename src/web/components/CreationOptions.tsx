import { cwdsOf, type ConversationSchedule, type ProviderModels, type ProviderStatus } from '../../shared/types';
import { useT } from '../i18n';
import { TeamEditor, type Team } from './TeamEditor';

export function CreationOptions({
  team,
  onTeam,
  providers,
  catalog,
  title,
  onTitle,
  titlePlaceholder,
  schedule,
}: {
  team: Team;
  onTeam: (team: Team) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  title: string;
  onTitle: (title: string) => void;
  titlePlaceholder: string;
  schedule?: ConversationSchedule;
}) {
  const t = useT();
  return (
    <details className="chat-options">
      <summary>
        <strong>{t.newChat.options}</strong>
        <span className="muted small">{[t.permissions[team.settings.permission].label, ...cwdsOf(team.settings)].join(' · ')}</span>
      </summary>
      <TeamEditor value={team} onChange={onTeam} providers={providers} catalog={catalog} confirmInEditor={false} schedule={schedule} />
      <label className="field">
        <span>{t.newChat.optionalTitle}</span>
        <input className="title-input" value={title} placeholder={titlePlaceholder} onChange={(e) => onTitle(e.target.value)} />
      </label>
    </details>
  );
}

export function TeamConfirmation({
  automatic,
  onChange,
  automaticLabel,
}: {
  automatic: boolean;
  onChange: (automatic: boolean) => void;
  automaticLabel: string;
}) {
  const t = useT();
  return (
    <fieldset className="team-confirmation">
      <legend>{t.newChat.afterDesign}</legend>
      {[false, true].map((auto) => (
        <label key={String(auto)}>
          <input type="radio" name="team-confirmation" checked={automatic === auto} onChange={() => onChange(auto)} />
          {auto ? automaticLabel : t.newChat.waitForMe}
        </label>
      ))}
    </fieldset>
  );
}
