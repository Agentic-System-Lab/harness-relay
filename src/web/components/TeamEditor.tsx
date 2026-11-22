import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  PERMISSION_LEVELS,
  PROVIDERS,
  PROVIDER_LABEL,
  catalogFor,
  cwdsOf,
  isOpenProvider,
  inheritedEffort,
  levelSettings,
  permissionLevel,
  type AgentConfig,
  type RelayToolGroup,
  type ConversationSchedule,
  type ConversationSettings,
  type Mode,
  type Provider,
  type ProviderModels,
  type ProviderStatus,
} from '../../shared/types';
import { api } from '../api';
import { cannotSteer } from '../chat';
import { checkProblems } from '../checks';
import { mentionWarning } from '../copy';
import { useT, type Messages } from '../i18n';
import { useLimits } from '../limits';
import { limitProblem, limitSpecOf, limitText, limitsFromText } from '../memberLimits';
import { settingsHref } from '../route';
import { defaultOn, emptyLibraryText, hasTool, itemsFor, noneForCliText, setTool, toolItems, toolsHintText, type ToolItem } from '../tools';
import {
  PROVIDER_COLOR,
  accountName,
  accountOf,
  accountState,
  inheritModelLabel,
  initials,
  newAgent,
  readyAccount,
  switchProvider,
  type ModelChoice,
} from '../util';
import { AccountPicker } from './AccountPicker';
import { ChecksEditor, useChecksEnvironment } from './ChecksEditor';
import { CwdInput } from './CwdInput';
import { GrokTrustNote } from './GrokTrust';
import { CliPicker, revealChosen } from './CliPicker';
import { ModelPicker } from './ModelPicker';

export interface Team {
  agents: AgentConfig[];
  settings: ConversationSettings;
}

interface Props {
  value: Team;
  onChange: (t: Team) => void;
  providers: ProviderStatus[];
  catalog: ProviderModels[];
  /**
   * Edit the members and how they take turns. Default: unless the lead agent designs the team (auto
   * team), where there are members to edit only once it has designed one.
   */
  members?: boolean;
  /** A template: only its members and how they take turns (no working directory or permission). */
  template?: boolean;
  /** Auto team: the members are the lead agent's design waiting for confirmation, not the current team. */
  proposed?: boolean;
  /** Auto team: who designs the team, named in the note. */
  leadLabel?: string;
  /** The creation pages display confirmation and lead review beside the submit button. */
  teamOptionsInEditor?: boolean;
  /** The conversation's schedule: its runs may have nobody watching. */
  schedule?: ConversationSchedule;
  /** The conversation being edited (Team settings): its team checks' commands can be tried there. */
  convId?: string;
  /** Told while the lead agent writes the team checks: the editor around them holds its Save meanwhile. */
  onDrafting?: (busy: boolean) => void;
  /** Reset unfinished check fields when the parent reloads its draft. */
  checksEditorVersion?: number;
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];

/**
 * What keeps the team from being saved; `members` and `template` as for `TeamEditor`, `maxAgents` the
 * server's team limit (`useLimits()`).
 */
export function teamProblems(team: Team, t: Messages, opts: { members?: boolean; template?: boolean; maxAgents?: number } = {}): string[] {
  const p = t.team.problems;
  const out: string[] = [];
  if (opts.members ?? !team.settings.autoTeam) {
    if (team.agents.length === 0) out.push(p.needAgent);
    // A team or template made before the limit was lowered.
    if (opts.maxAgents !== undefined && team.agents.length > opts.maxAgents) out.push(p.tooMany(opts.maxAgents));
    const seen = new Set<string>();
    for (const a of team.agents) {
      if (!NAME_RE.test(a.name)) out.push(p.badName(a.name));
      else if (seen.has(a.name.toLowerCase())) out.push(p.duplicate(a.name));
      seen.add(a.name.toLowerCase());
      const limit = limitProblem(a);
      if (limit) out.push(p.badLimit(a.name, limit.min, limit.max, limit.integer));
    }
  }
  if (!opts.template && !team.settings.cwd.trim()) out.push(p.needCwd);
  out.push(...checkProblems(team.settings.checks, t.checks));
  return out;
}

export function LeadReviewOption({ enabled, onChange }: { enabled: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const hint = useId();
  return (
    <div className="field auto-team lead-review">
      <label className="check-row">
        <input type="checkbox" aria-describedby={hint} checked={enabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{t.team.leadReview}</span>
      </label>
      <span className="small muted" id={hint}>
        {enabled ? t.team.leadReviewHint.on : t.team.leadReviewHint.off}
      </span>
    </div>
  );
}

/**
 * Steering (`ConversationSettings.steer`): a message sent while members work goes into their running
 * turns. Says which members' CLIs cannot take one, while it is on.
 */
export function SteerOption({ enabled, agents, onChange }: { enabled: boolean; agents: AgentConfig[]; onChange: (on: boolean) => void }) {
  const t = useT();
  const hint = useId();
  const cannot = cannotSteer(agents);
  return (
    <div className="field auto-team steer-option">
      <label className="check-row">
        <input type="checkbox" aria-describedby={hint} checked={enabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{t.team.steer}</span>
      </label>
      <span className="small muted" id={hint}>
        {enabled ? t.team.steerHint.on : t.team.steerHint.off}
        {enabled && cannot.length > 0 && <> {t.team.steerUnsupported(cannot.map((a) => `@${a.name}`).join(', '))}</>}
      </span>
    </div>
  );
}

export function TeamEditor({
  value,
  onChange,
  providers,
  catalog,
  members,
  template = false,
  proposed = false,
  leadLabel,
  teamOptionsInEditor = true,
  schedule,
  convId,
  checksEditorVersion,
  onDrafting,
}: Props) {
  const t = useT();
  /** The team now: the lead agent's checks (or their Undo) land on it, not on the team as it was when they were asked for. */
  const latest = useRef(value);
  latest.current = value;
  const checksEnv = useChecksEnvironment();
  const { maxTeamAgents } = useLimits();
  const { agents, settings } = value;
  /** Per member: the model, effort and account picked for each CLI, so switching a member's CLI and back restores them. */
  const kept = useRef(new Map<string, Partial<Record<Provider, ModelChoice>>>());
  /** The tool library's items; null until it has loaded, when a member's Tools say nothing yet (not "empty"). */
  const [tools, setTools] = useState<ToolItem[] | null>(null);
  const [toolsError, setToolsError] = useState('');
  useEffect(() => {
    api.tools().then(
      (lib) => setTools(toolItems(lib)),
      (e: Error) => setToolsError(e.message),
    );
  }, []);
  const auto = Boolean(settings.autoTeam) && !template;
  const confirmHint = useId();
  const cwdId = useId();
  const addMemberId = useId();
  const showMembers = members ?? !auto;
  // Members renamed or removed: the schedule's message may @mention someone the team no longer has.
  const names = agents.map((a) => a.name).join('\n');
  const scheduleText = schedule?.text;
  const missing = useMemo(
    () => (scheduleText && names ? mentionWarning(scheduleText, names.split('\n'), t, 'team') : undefined),
    [scheduleText, names, t],
  );
  const setAgents = (next: AgentConfig[]) => onChange({ ...value, agents: next });
  const setSettings = (patch: Partial<ConversationSettings>) => onChange({ ...value, settings: { ...settings, ...patch } });
  // The permission as the picker shows it ("Approve for me" is Edit reviewed by the lead agent), and
  // what the other levels do beyond it.
  const level = permissionLevel(settings);
  // One row that scrolls sideways where the levels do not fit: the chosen one is scrolled into view.
  const levelsRow = useRef<HTMLDivElement>(null);
  useEffect(() => revealChosen(levelsRow.current), [level]);
  const approvals = settings.approvals === 'deny' ? 'deny' : 'ask';
  const updateAgent = (id: string, patch: Partial<AgentConfig>) => setAgents(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...agents];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    setAgents(next);
  };

  const checksEditor = (
    <ChecksEditor
      key={checksEditorVersion}
      variant={template ? 'template' : 'team'}
      value={settings.checks}
      env={checksEnv}
      permission={template ? undefined : settings.permission}
      convId={template ? undefined : convId}
      cwds={template ? undefined : cwdsOf(settings)}
      onDrafting={onDrafting}
      onChange={(checks) => {
        const now = latest.current;
        const { checks: _old, ...rest } = now.settings;
        const next = { ...now, settings: checks === undefined ? rest : { ...rest, checks } };
        latest.current = next;
        onChange(next);
      }}
    />
  );

  return (
    <div className="team-editor">
      {showMembers && (
        <section>
          <div className="section-head">
            <h3>{!auto ? t.team.members : proposed ? t.team.proposedMembers : t.team.currentMembers}</h3>
            <span className="muted small">{settings.mode === 'relay' ? t.team.relayOrder : t.team.order}</span>
          </div>
          {auto && !proposed && <p className="muted small current-note">{t.team.currentNote}</p>}
          {missing && <p className="small warn-text">{missing}</p>}

          <div className="agent-grid">
            {agents.map((a, i) => {
              const status = providers.find((p) => p.provider === a.provider);
              const state = accountState(status, a.account);
              const account = accountOf(status, a.account);
              const multi = (status?.accounts.length ?? 0) > 1;
              return (
                <div key={a.id} className="agent-card" style={{ ['--accent' as string]: PROVIDER_COLOR[a.provider] }}>
                  <div className="agent-card-head">
                    <span className="avatar">{initials(a.name)}</span>
                    <label className="handle-input">
                      <span>@</span>
                      <input
                        value={a.name}
                        onChange={(e) => updateAgent(a.id, { name: e.target.value.replace(/[\s@]/g, '') })}
                        aria-label={t.team.agentName}
                        maxLength={32}
                      />
                    </label>
                    <div className="card-actions">
                      <button className="icon-button" aria-label={t.team.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button
                        className="icon-button"
                        aria-label={t.team.moveDown}
                        disabled={i === agents.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={t.common.remove}
                        onClick={() => setAgents(agents.filter((x) => x.id !== a.id))}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <CliPicker
                    value={a.provider}
                    label={t.team.codingAgent}
                    onPick={(p) => {
                      const next = switchProvider(a, p, kept.current.get(a.id) ?? {});
                      kept.current.set(a.id, next.kept);
                      updateAgent(a.id, { provider: p, model: next.value.model, effort: next.value.effort, account: next.value.account });
                    }}
                  />

                  <label className="field">
                    <span>{t.team.role}</span>
                    <textarea
                      value={a.role}
                      rows={5}
                      placeholder={t.team.rolePlaceholder}
                      onChange={(e) => updateAgent(a.id, { role: e.target.value })}
                    />
                  </label>

                  <AccountPicker status={status} value={a.account} onChange={(account) => updateAgent(a.id, { account })} />

                  <AgentModelPicker
                    key={`${a.provider}|${a.account ?? ''}`}
                    agent={a}
                    catalog={catalogFor(catalog, a.provider, a.account)}
                    onChange={(v) => updateAgent(a.id, v)}
                  />

                  <AgentLimitField key={`limit|${a.provider}`} agent={a} onChange={(limits) => updateAgent(a.id, { limits })} />

                  <AgentTools agent={a} items={tools} error={toolsError} onChange={(next) => updateAgent(a.id, { tools: next })} />

                  {state !== 'ok' && status && (
                    <p className="warn-line">
                      {!status.installed
                        ? t.team.cliMissing(PROVIDER_LABEL[a.provider])
                        : isOpenProvider(a.provider)
                          ? t.team.noBackend(PROVIDER_LABEL[a.provider])
                          : multi && account
                            ? t.accounts.notLoggedIn(PROVIDER_LABEL[a.provider], accountName(account, t))
                            : t.team.notLoggedIn(PROVIDER_LABEL[a.provider])}
                      <a href={settingsHref(a.provider)}>{t.team.goSettings}</a>
                    </p>
                  )}
                </div>
              );
            })}

            <div className="agent-card add-card">
              <span id={addMemberId} className="muted small">
                {t.team.addMember}
              </span>
              {/* Beside members the card is as tall as theirs and this list scrolls; on a row of its own it lists every CLI (styles.css, .add-card).
                  Named: a list that scrolls takes the focus itself where all its buttons are disabled (a full team). */}
              <div className="add-card-list" role="group" aria-labelledby={addMemberId}>
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    className="add-agent"
                    style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
                    disabled={agents.length >= maxTeamAgents}
                    onClick={() => {
                      const agent = newAgent(
                        p,
                        agents.map((a) => a.name),
                      );
                      const account = readyAccount(providers.find((s) => s.provider === p));
                      setAgents([...agents, account ? { ...agent, account } : agent]);
                    }}
                  >
                    ＋ {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h3>{t.team.rules}</h3>
        </div>
        {auto && teamOptionsInEditor && (
          <div className="field auto-team">
            {/* With members to edit, the note above them says how the lead agent chooses the team. */}
            {leadLabel && !showMembers && (
              <p className="muted small auto-note">
                {t.newChat.autoNote(leadLabel)} <a href={settingsHref('lead')}>{t.newChat.changeLead}</a>
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                aria-describedby={confirmHint}
                checked={Boolean(settings.autoConfirm)}
                onChange={(e) => setSettings({ autoConfirm: e.target.checked || undefined })}
              />
              <span>{t.team.autoConfirm}</span>
            </label>
            <span className="small muted" id={confirmHint}>
              {settings.autoConfirm ? t.team.autoConfirmHint.on : t.team.autoConfirmHint.off}
            </span>
          </div>
        )}
        {!template && teamOptionsInEditor && (
          <LeadReviewOption enabled={Boolean(settings.leadReview)} onChange={(on) => setSettings({ leadReview: on || undefined })} />
        )}
        {!template && teamOptionsInEditor && (
          <SteerOption enabled={Boolean(settings.steer)} agents={agents} onChange={(on) => setSettings({ steer: on || undefined })} />
        )}
        {template && checksEditor}
        {showMembers && (
          <div className="option-row">
            {MODES.map((m) => (
              <button
                key={m}
                className={`option-card ${settings.mode === m ? 'on' : ''}`}
                onClick={() => setSettings({ mode: m })}
                aria-pressed={settings.mode === m}
              >
                <strong>{t.modes[m].label}</strong>
                <span>{t.modes[m].hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="settings-grid">
          {showMembers &&
            (settings.mode === 'relay' ? (
              <label className="field field-with-unit">
                <span>{t.team.relayLimit}</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={settings.maxHops}
                  onChange={(e) => setSettings({ maxHops: Number(e.target.value) })}
                />
                <span className="unit muted small">{t.team.hopsUnit}</span>
              </label>
            ) : (
              <label className="field field-with-unit">
                <span>{t.team.rounds}</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={settings.rounds}
                  onChange={(e) => setSettings({ rounds: Number(e.target.value) })}
                />
                <span className="unit muted small">{t.team.roundsUnit}</span>
              </label>
            ))}

          {!template && (
            // Give long paths the full row under the field label.
            <div className="field grow">
              <span>
                <label htmlFor={cwdId}>{t.team.cwd}</label>
              </span>
              <CwdInput
                id={cwdId}
                value={cwdsOf(settings).filter((d) => d.trim())}
                placeholder="/path/to/project"
                onChange={(dirs) => setSettings({ cwd: dirs[0] ?? '', extraCwds: dirs.length > 1 ? dirs.slice(1) : undefined })}
              />
            </div>
          )}
        </div>
        {!template && agents.some((a) => a.provider === 'grok') && <GrokTrustNote cwd={settings.cwd} />}

        {/* A template has no working directory or permission: the conversation decides them. */}
        {!template && (
          <div className="field">
            <span>{t.team.permission}</span>
            <div ref={levelsRow} className="segmented wide levels">
              {PERMISSION_LEVELS.map((p) => (
                <button
                  key={p}
                  className={`${level === p ? 'on' : ''} ${p === 'full' ? 'danger' : ''}`}
                  onClick={() => setSettings(levelSettings(p, settings))}
                  aria-pressed={level === p}
                >
                  {t.permissions[p].label}
                </button>
              ))}
            </div>
            <span className={`small ${settings.permission === 'full' ? 'danger-text' : 'muted'}`}>{t.permissions[level].hint}</span>
            {schedule?.enabled && settings.permission === 'full' && <span className="small danger-text">{t.schedule.fullWarning}</span>}
            {settings.permission !== 'read-only' && (
              <span className="small muted">
                {showMembers && (settings.mode === 'parallel' ? t.team.parallelNote : t.team.sharedNote)}
                {t.team.gitInitNote}
              </span>
            )}
          </div>
        )}

        {!template && settings.permission !== 'full' && level !== 'auto' && (
          <div className="field">
            <span>{t.team.approvals}</span>
            <div className="segmented wide" role="radiogroup" aria-label={t.team.approvals}>
              {(['ask', 'deny'] as const).map((v) => {
                const on = approvals === v;
                return (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={on}
                    className={on ? 'on' : ''}
                    onClick={() => setSettings({ approvals: v === 'ask' ? undefined : 'deny' })}
                  >
                    {v === 'ask' ? t.team.approvalsAsk : t.team.approvalsDeny}
                  </button>
                );
              })}
            </div>
            <span className="small muted">{t.team.approvalsHint[approvals]}</span>
            {schedule?.enabled && approvals === 'ask' && (
              <span className="small muted">{t.schedule.approvalsOverride[schedule.approvals]}</span>
            )}
          </div>
        )}
        {!template && checksEditor}
      </section>
    </div>
  );
}

/** The tool library items this agent gets, as chips; "Change" opens the list to tick them. */
function AgentTools({
  agent,
  items: all,
  error,
  onChange,
}: {
  agent: AgentConfig;
  /** Null while the library loads. */
  items: ToolItem[] | null;
  /** The library could not be loaded: say so rather than call it empty. */
  error: string;
  onChange: (tools: AgentConfig['tools']) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const items = itemsFor(all ?? [], agent.provider);
  const given = items.filter((i) => hasTool(agent, i));
  const label = (i: ToolItem) =>
    i.kind === 'relay'
      ? t.tools.relay.groups[i.name as RelayToolGroup]
      : i.kind !== 'memory'
        ? i.name
        : i.name === 'all'
          ? t.team.toolMemory
          : t.team.toolProviderMemory(PROVIDER_LABEL[agent.provider]);
  const kind = (i: ToolItem) => (i.kind === 'mcp' ? 'MCP' : i.kind === 'skill' ? 'Skill' : i.kind === 'relay' ? 'Relay' : '');
  return (
    <div className="field agent-tools">
      <span>{t.team.tools}</span>
      {error ? (
        <p className="warn-line small">{error}</p>
      ) : !all ? null : items.length === 0 ? (
        <p className="muted small">
          {/* Not empty, but nothing for this CLI: only other CLIs' memory notes (itemsFor leaves them out). */}
          {all.length ? noneForCliText(t, agent.provider) : emptyLibraryText(t, agent.provider)}{' '}
          <a href={settingsHref('tools')}>{t.team.goToolLibrary}</a>
        </p>
      ) : (
        <>
          <div className="agent-tools-summary">
            {given.length ? (
              given.map((i) => (
                <span key={i.key} className="tool-chip" title={i.problem}>
                  {kind(i) && <span className="tool-kind">{kind(i)}</span>}
                  {label(i)}
                </span>
              ))
            ) : (
              <span className="muted small">{t.team.toolsNone}</span>
            )}
            <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? t.team.toolsDone : t.team.toolsEdit}
            </button>
          </div>
          {open && (
            <>
              <p className="muted small">{toolsHintText(t, agent.provider)}</p>
              <ul>
                {items.map((i) => (
                  <li key={i.key}>
                    <label className="check-row">
                      <input type="checkbox" checked={hasTool(agent, i)} onChange={(e) => onChange(setTool(agent, i, e.target.checked))} />
                      {kind(i) && <span className="tool-kind">{kind(i)}</span>}
                      <span>{label(i)}</span>
                      {!defaultOn(i, agent.provider) && <span className="muted small">· {t.team.toolOffByDefault}</span>}
                      {i.problem && (
                        <span className="warn-line small" title={i.problem}>
                          · {t.team.toolProblem}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The member's own limit, for a CLI that has one (`AGENT_LIMITS`): a line with its value (or none) that
 * Change opens into the field and what it does, as the member's tools do, so the card stays short; open
 * while what is typed is not a limit the CLI takes. Empty is no limit.
 */
function AgentLimitField({ agent, onChange }: { agent: AgentConfig; onChange: (limits: AgentConfig['limits']) => void }) {
  const t = useT();
  const label = useId();
  const hint = useId();
  // As typed (a number field's value is only a number once it is whole), for the CLI the field is keyed by.
  const [text, setText] = useState(() => limitText(agent));
  const [open, setOpen] = useState(false);
  const spec = limitSpecOf(agent);
  if (!spec) return null;
  const cli = agent.provider as keyof typeof t.team.limit.label;
  const bad = Boolean(limitProblem(agent));
  const shown = open || bad;
  // Closed, the line shows what the member holds now (a team saved meanwhile, the lead agent's change),
  // never what was typed when the editor opened; opening the field starts from it.
  const held = limitText(agent);
  return (
    <div className="field agent-limit">
      <span id={label}>{t.team.limit.label[cli]}</span>
      <div className="agent-tools-summary">
        {!shown && <span className={held ? 'small' : 'muted small'}>{held || t.team.limit.placeholder}</span>}
        {!bad && (
          <button
            type="button"
            className="link-button"
            aria-expanded={shown}
            onClick={() => {
              if (!open) setText(held);
              setOpen(!open);
            }}
          >
            {shown ? t.team.limit.done : t.team.limit.change}
          </button>
        )}
      </div>
      {shown && (
        <>
          <input
            type="number"
            inputMode={spec.integer ? 'numeric' : 'decimal'}
            min={spec.min}
            max={spec.max}
            step={spec.integer ? 1 : 0.01}
            value={text}
            placeholder={t.team.limit.placeholder}
            aria-labelledby={label}
            aria-describedby={hint}
            aria-invalid={bad ? true : undefined}
            onChange={(e) => {
              setText(e.target.value);
              onChange(limitsFromText(agent, e.target.value));
            }}
          />
          <span className="small muted" id={hint}>
            {t.team.limit.hint[cli](spec.min, spec.max)}
          </span>
        </>
      )}
    </div>
  );
}

function AgentModelPicker({
  agent,
  catalog,
  onChange,
}: {
  agent: AgentConfig;
  catalog?: ProviderModels;
  onChange: (v: { model: string; effort: string }) => void;
}) {
  const t = useT();
  return (
    <ModelPicker
      catalog={catalog}
      model={agent.model ?? ''}
      effort={agent.effort ?? ''}
      onChange={onChange}
      inheritModelLabel={inheritModelLabel(catalog, agent.provider, t)}
      inheritEffortLabel={(model) => {
        const e = catalog && inheritedEffort(catalog, model);
        return t.team.defaultModel(e ? t.effortLabel(e) : t.team.cliDecides);
      }}
    />
  );
}
