import { useRef } from 'react';
import { api } from '../api';
import { reviseRequest, revisionOutcome, sameTeam } from '../chat';
import { teamChangeText } from '../copy';
import { useT } from '../i18n';
import { LeadAsk } from './LeadAsk';
import type { Team } from './TeamEditor';

interface Props {
  convId: string;
  /** The team in the drawer: the one the lead agent changes. */
  team: Team;
  /**
   * The team the drawer's copy was made from (`base`): a new one (the drawer loaded the team again)
   * clears what the lead agent said about the copy before.
   */
  base: Team;
  /** The drawer cannot save its team (it changed underneath): nothing to ask for until it is loaded again. */
  blocked: boolean;
  /** Who the lead agent is (Settings), named in the note. */
  leadText: string;
  onChange: (team: Team) => void;
  /** Told while the lead agent works: the drawer holds still, and cannot be saved meanwhile. */
  onBusy: (busy: boolean) => void;
}

/**
 * The team drawer's "Ask the lead agent": the user says how the team should change, and the lead agent
 * changes the team in the drawer. Nothing is saved: the user reviews the team (what changed is listed)
 * and saves it, or undoes the change. Closing the drawer stops the lead agent.
 */
export function TeamReviser({ convId, team, base, blocked, leadText, onChange, onBusy }: Props) {
  const t = useT();
  /** The drawer now: its team and whether it can save it may change while the lead agent works. */
  const latest = useRef({ team, blocked });
  latest.current = { team, blocked };
  return (
    <LeadAsk
      title={t.revise.title}
      hint={t.revise.hint(leadText)}
      placeholder={t.revise.placeholder}
      working={t.revise.working(leadText)}
      review={t.revise.review}
      unchanged={t.revise.unchanged}
      changedMeanwhile={t.revise.changedMeanwhile}
      blocked={blocked}
      resetKey={base}
      onBusy={onBusy}
      ask={async (request, signal) => {
        const sent = latest.current.team;
        const revision = await api.reviseTeam(convId, reviseRequest(request, sent), signal);
        const outcome = revisionOutcome({ sent, now: latest.current.team, blocked: latest.current.blocked, revision });
        if (outcome.kind === 'stale') return 'stale';
        if (outcome.kind === 'unchanged') return { reason: revision.reason, changes: [], meta: revision.meta };
        onChange(outcome.team);
        return {
          reason: revision.reason,
          changes: outcome.changes.map((c) => teamChangeText(c, t)),
          meta: revision.meta,
          undo: () => onChange(sent),
          // Undo only while the team is still as the lead agent left it: later edits are not thrown away.
          undoable: () => sameTeam(latest.current.team, outcome.team),
        };
      }}
    />
  );
}
