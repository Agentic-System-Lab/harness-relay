import { useEffect, useId, useRef, useState } from 'react';
import {
  CHECK_LIMITS,
  CONVENTIONAL_COMMIT_PATTERN,
  HOOK_PROVIDERS,
  PROVIDER_LABEL,
  type CheckCommand,
  type CheckHook,
  type CheckList,
  type CheckOutcome,
  type Permission,
} from '../../shared/types';
import { api } from '../api';
import {
  badCommitPattern,
  badPath,
  checksChanges,
  commandProblem,
  flagsOf,
  hookProblem,
  listFrom,
  pathsText,
  ruleCount,
  sameChecks,
} from '../checks';
import { useT } from '../i18n';
import { CommandOutcome } from './ChecksCard';
import { LeadAsk } from './LeadAsk';

interface Props {
  env?: Environment;
  variant: 'defaults' | 'team' | 'template';
  value: CheckList | undefined;
  onChange: (next: CheckList | undefined) => void;
  /** The permission the team has: read-only changes no files, so nothing is checked (absent: a template). */
  permission?: Permission;
  /** The conversation the list is for: its commands can be tried on its working directories (none for a template). */
  convId?: string;
  /**
   * Where the team works, as the editor around has it (the team drawer's working directories, saved or
   * not, or a new chat's): the lead agent reads the project there when asked to write the rules.
   */
  cwds?: string[];
  /** Told while the lead agent writes the rules: the editor around them holds its Save meanwhile. */
  onDrafting?: (busy: boolean) => void;
}

/** What team checks' commands can do on the server's computer (`GET /api/checks/environment`). */
type Environment = { platform: string; sandbox?: string };

export function useChecksEnvironment() {
  const [env, setEnv] = useState<Environment>();
  useEffect(() => {
    api.checksEnvironment().then(setEnv, () => undefined);
  }, []);
  return env;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Team checks in Team settings and the template editor (`ConversationSettings.checks`): protected paths,
 * a line each, the commit format, commands that must succeed, and hooks around the members' tool calls.
 * Folded away until it is opened, or while it has rules.
 */
export function ChecksEditor({ value, onChange, permission, convId, cwds, env, variant, onDrafting }: Props) {
  const t = useT();
  const pathsId = useId();
  const pathsHint = useId();
  const patternId = useId();
  const patternHint = useId();
  const commandsHint = useId();
  // What the conversation or template had when the editor opened: emptied, a list stays an empty one.
  const before = useRef(value);
  const [paths, setPaths] = useState(() => pathsText(value));
  const [pattern, setPattern] = useState(() => value?.commitPattern ?? '');
  const [commands, setCommands] = useState<CheckCommand[]>(() => value?.commands ?? []);
  const [flags, setFlags] = useState<Pick<CheckList, 'previewApp' | 'autoFix'>>(() => ({
    ...(value?.previewApp ? { previewApp: true as const } : {}),
    ...(value?.autoFix ? { autoFix: true as const } : {}),
  }));
  const [tried, setTried] = useState<Record<string, CheckOutcome | 'running' | string>>({});
  // The hook rows keep their own state: a whole new list (the lead agent's, or Undo) starts them afresh.
  const [hooksKey, setHooksKey] = useState(0);
  const [drafting, setDrafting] = useState(false);
  /** The list now, for the lead agent's answer: the user may change it while it works. */
  const latest = useRef(value);
  latest.current = value;
  const update = (next: {
    paths?: string;
    pattern?: string;
    commands?: CheckCommand[];
    hooks?: CheckHook[];
    flags?: Pick<CheckList, 'previewApp' | 'autoFix'>;
  }) => {
    const p = next.paths ?? paths;
    const c = next.pattern ?? pattern;
    const cmds = next.commands ?? commands;
    const hks = next.hooks ?? value?.hooks;
    const f = next.flags ?? flags;
    setPaths(p);
    setPattern(c);
    setCommands(cmds);
    setFlags(f);
    onChange(listFrom(p, c, before.current, cmds, hks, f));
  };
  /** A whole list in the editor: the lead agent's draft, or the list before it (Undo). */
  const load = (list: CheckList | undefined) => {
    const p = pathsText(list);
    const c = list?.commitPattern ?? '';
    const cmds = list?.commands ?? [];
    const hks = list?.hooks ?? [];
    const f = flagsOf(list);
    setPaths(p);
    setPattern(c);
    setCommands(cmds);
    setFlags(f);
    setTried({});
    setHooksKey((k) => k + 1);
    const next = listFrom(p, c, before.current, cmds, hks, f);
    onChange(next);
    return next;
  };
  const drafter = (
    <LeadAsk
      title={t.checksDraft.title}
      hint={
        variant === 'defaults'
          ? t.checksDraft.hintDefaults
          : variant === 'template'
            ? t.checksDraft.hintTemplate
            : convId || cwds?.some((d) => d.trim())
              ? t.checksDraft.hintProject
              : t.checksDraft.hintNoFolder
      }
      placeholder={t.checksDraft.placeholder}
      submit={t.checksDraft.submit}
      working={t.checksDraft.working}
      review={t.checksDraft.review}
      unchanged={t.checksDraft.unchanged}
      changedMeanwhile={t.checksDraft.changedMeanwhile}
      onBusy={(busy) => {
        setDrafting(busy);
        onDrafting?.(busy);
      }}
      ask={async (request, signal) => {
        const sent = latest.current;
        const dirs = (cwds ?? []).map((d) => d.trim()).filter(Boolean);
        const r = await api.draftChecks(
          {
            request,
            variant,
            ...(sent ? { checks: sent } : {}),
            ...(variant === 'team' && convId ? { convId } : {}),
            ...(variant === 'team' && dirs.length ? { cwd: dirs[0]!, extraCwds: dirs.slice(1) } : {}),
          },
          signal,
        );
        if (!sameChecks(latest.current, sent)) return 'stale';
        // A chat's or new chat's folders that are not there (yet): it read no project, whatever the hint said.
        const reason = variant === 'team' && !r.readIn ? `${r.reason}${r.reason ? ' ' : ''}${t.checksDraft.noProject}` : r.reason;
        const changes = checksChanges(sent, r.checks, t);
        if (!changes.length) return { reason, changes: [], meta: r.meta };
        const after = load(r.checks);
        return {
          reason,
          changes,
          meta: r.meta,
          undo: () => load(sent),
          // Only while the list is still as the lead agent left it: later edits are not thrown away.
          undoable: () => sameChecks(latest.current, after),
        };
      }}
    />
  );
  const setFlag = (name: 'previewApp' | 'autoFix', on: boolean) => {
    const { [name]: _was, ...rest } = flags;
    update({ flags: on ? { ...rest, [name]: true } : rest });
  };
  const setCommand = (id: string, patch: Partial<CheckCommand>) =>
    update({ commands: commands.map((c) => (c.id === id ? Object.assign({}, c, patch) : c)) });
  const tryIt = async (c: CheckCommand) => {
    if (!convId || tried[c.id] === 'running') return;
    setTried((x) => ({ ...x, [c.id]: 'running' }));
    try {
      const outcome = await api.tryCheck(convId, { ...c, run: c.run.trim() }, permission);
      setTried((x) => ({ ...x, [c.id]: outcome }));
    } catch (err) {
      setTried((x) => ({ ...x, [c.id]: (err as Error).message }));
    }
  };
  const wrongPath = badPath(paths);
  const wrongPattern = badCommitPattern(pattern);
  const rules = ruleCount(value);
  // Open when it starts with rules, and stays as the user leaves it: deleting the last rule does not fold it away.
  const [openAtStart] = useState(() => ruleCount(value) > 0);
  // The opening each system has; both while the server's system is not known yet.
  const mac = !env || env.platform === 'darwin';
  const linux = !env || env.platform === 'linux';

  const fields = (
    <div className="checks-editor-body">
      {variant !== 'defaults' && <p className="small muted">{t.checks.editorHint}</p>}
      {drafter}
      {/* While the lead agent writes the rules, they hold still. */}
      <fieldset className="team-fieldset checks-fieldset" disabled={drafting}>
        {permission === 'read-only' && rules > 0 && <p className="small warn-text">{t.checks.readOnlyNote}</p>}
        <div className="checks-field">
          <label htmlFor={pathsId}>{t.checks.protectedPaths}</label>
          <textarea
            id={pathsId}
            rows={3}
            spellCheck={false}
            aria-describedby={pathsHint}
            aria-invalid={Boolean(wrongPath)}
            placeholder={'.env\n*.pem\nsecrets/'}
            value={paths}
            onChange={(e) => update({ paths: e.target.value })}
          />
          <span className="small muted" id={pathsHint}>
            {t.checks.protectedPathsHint} {t.checks.protectedPathsBefore}
          </span>
          {wrongPath && <span className="small warn-text">{t.checks.badPath(wrongPath)}</span>}
        </div>
        <div className="checks-field">
          <label htmlFor={patternId}>{t.checks.commitPattern}</label>
          <div className="checks-pattern">
            <input
              id={patternId}
              type="text"
              spellCheck={false}
              aria-describedby={patternHint}
              aria-invalid={Boolean(wrongPattern)}
              value={pattern}
              onChange={(e) => update({ pattern: e.target.value })}
            />
            <button type="button" className="ghost small-button" onClick={() => update({ pattern: CONVENTIONAL_COMMIT_PATTERN })}>
              {t.checks.conventional}
            </button>
          </div>
          <span className="small muted" id={patternHint}>
            {t.checks.commitPatternHint}
          </span>
          {wrongPattern && <span className="small warn-text">{t.checks.badPattern(wrongPattern)}</span>}
        </div>
        <div className="checks-field checks-flags">
          <label className="check-row">
            <input type="checkbox" checked={Boolean(flags.previewApp)} onChange={(e) => setFlag('previewApp', e.target.checked)} />
            <span>
              {t.checks.previewApp}
              <span className="small muted checks-flag-hint">{t.checks.previewAppHint}</span>
            </span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={Boolean(flags.autoFix)} onChange={(e) => setFlag('autoFix', e.target.checked)} />
            <span>
              {t.checks.autoFix}
              <span className="small muted checks-flag-hint">{t.checks.autoFixHint(CHECK_LIMITS.autoFixes)}</span>
            </span>
          </label>
        </div>
        <div className="checks-field">
          <span className="checks-commands-title">{t.checks.commands}</span>
          <span className="small muted" id={commandsHint}>
            {t.checks.commandsHint}
          </span>
          {env?.platform === 'win32' && <span className="small warn-text">{t.checks.windowsNote}</span>}
          {/* Read-only runs no command: the note above says so. */}
          {env?.sandbox && env.platform !== 'win32' && permission !== 'full' && permission !== 'read-only' && commands.length > 0 && (
            <span className="small warn-text">{t.checks.noSandbox(env.sandbox)}</span>
          )}
          <ul className="checks-commands">
            {commands.map((c) => {
              const problem = c.run.trim() ? commandProblem(c) : undefined;
              const result = tried[c.id];
              return (
                <li key={c.id} className="checks-command-row">
                  <div className="checks-command-line">
                    <input
                      type="text"
                      spellCheck={false}
                      aria-label={t.checks.commandRun}
                      aria-describedby={commandsHint}
                      placeholder="npm test"
                      value={c.run}
                      onChange={(e) => setCommand(c.id, { run: e.target.value })}
                    />
                    <button
                      type="button"
                      className="ghost small-button"
                      aria-label={t.checks.removeCommand}
                      title={t.checks.removeCommand}
                      onClick={() => update({ commands: commands.filter((x) => x.id !== c.id) })}
                    >
                      ×
                    </button>
                  </div>
                  <div className="checks-command-options">
                    <label>
                      <span className="small muted">{t.checks.commandFolder}</span>
                      <input
                        type="text"
                        spellCheck={false}
                        value={c.cwd ?? ''}
                        onChange={(e) => setCommand(c.id, { cwd: e.target.value || undefined })}
                      />
                    </label>
                    <label>
                      <span className="small muted">{t.checks.commandTimeout}</span>
                      <input
                        type="number"
                        min={1}
                        max={CHECK_LIMITS.maxTimeoutMin}
                        value={c.timeoutMin ?? CHECK_LIMITS.timeoutMin}
                        onChange={(e) => setCommand(c.id, { timeoutMin: e.target.value === '' ? undefined : Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  {mac && (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(c.localPorts)}
                        onChange={(e) => setCommand(c.id, { localPorts: e.target.checked || undefined })}
                      />
                      <span>
                        {t.checks.localPorts}
                        <span className="small muted"> · {t.checks.localPortsHint}</span>
                      </span>
                    </label>
                  )}
                  {linux && (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(c.unixSockets)}
                        onChange={(e) => setCommand(c.id, { unixSockets: e.target.checked || undefined })}
                      />
                      <span>
                        {t.checks.unixSockets}
                        <span className="small muted"> · {t.checks.unixSocketsHint}</span>
                      </span>
                    </label>
                  )}
                  {problem === 'folder' && <span className="small warn-text">{t.checks.badFolder(c.cwd ?? '')}</span>}
                  {problem === 'timeout' && <span className="small warn-text">{t.checks.badTimeout(CHECK_LIMITS.maxTimeoutMin)}</span>}
                  {convId && c.run.trim() && !problem && permission !== 'read-only' && (
                    <div className="checks-try">
                      <button type="button" className="ghost small-button" disabled={result === 'running'} onClick={() => void tryIt(c)}>
                        {result === 'running' ? t.checks.trying : t.checks.tryIt}
                      </button>
                      {result === undefined && <span className="small muted">{t.checks.tryFirst}</span>}
                    </div>
                  )}
                  {result !== undefined && result !== 'running' && (
                    <div className="checks-tried" role="status">
                      {typeof result === 'string' ? (
                        <span className="small warn-text">{t.checks.failedAction(result)}</span>
                      ) : (
                        <CommandOutcome o={result} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {commands.length < CHECK_LIMITS.commands && (
            <button
              type="button"
              className="ghost small-button checks-add"
              onClick={() => update({ commands: [...commands, { id: newId(), run: '' }] })}
            >
              {t.checks.addCommand}
            </button>
          )}
        </div>
        {variant !== 'defaults' && (
          <HooksEditor
            key={hooksKey}
            value={value?.hooks}
            onChange={(hooks) => update({ hooks })}
            permission={permission}
            env={env}
            showTitle
          />
        )}
      </fieldset>
    </div>
  );
  if (variant === 'defaults') return fields;
  return (
    <details className="field checks-editor" open={openAtStart}>
      <summary>
        <span>{variant === 'template' ? t.checks.title : t.checks.advancedSettings}</span>
        {rules > 0 && <span className="muted small"> · {t.checks.count(rules)}</span>}
      </summary>
      {fields}
    </details>
  );
}

/** The same hook rows in Team settings, templates and the tool library's Hooks section. */
export function HooksEditor({
  value,
  onChange,
  permission,
  env,
  showTitle,
}: {
  value?: CheckHook[];
  onChange: (hooks: CheckHook[]) => void;
  permission?: Permission;
  env?: Environment;
  showTitle?: boolean;
}) {
  const t = useT();
  const hooksHint = useId();
  const [hooks, setHooks] = useState<CheckHook[]>(value ?? []);
  const update = (rows: CheckHook[]) => {
    setHooks(rows);
    onChange(rows);
  };
  const setHook = (id: string, patch: Partial<CheckHook>) => update(hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  return (
    <div className="checks-field">
      {showTitle && <span className="checks-commands-title">{t.checks.hooks}</span>}
      <span className="small muted" id={hooksHint}>
        {t.checks.hooksHint} {t.checks.hooksWho(HOOK_PROVIDERS.map((p) => PROVIDER_LABEL[p]))}
      </span>
      {env?.platform === 'win32' && <span className="small warn-text">{t.checks.hooksWindowsNote}</span>}
      {env?.sandbox && env.platform !== 'win32' && permission !== 'full' && permission !== 'read-only' && hooks.length > 0 && (
        <span className="small warn-text">{t.checks.noSandbox(env.sandbox)}</span>
      )}
      <ul className="checks-commands checks-hooks">
        {hooks.map((h) => {
          const problem = h.run.trim() ? hookProblem(h) : undefined;
          return (
            <li key={h.id} className="checks-hook-row">
              <div className="checks-hook-head">
                <div className="checks-command-options">
                  <label>
                    <span className="small muted">{t.checks.hookWhen}</span>
                    <select value={h.when} onChange={(e) => setHook(h.id, { when: e.target.value as CheckHook['when'] })}>
                      <option value="before">{t.checks.hookBefore}</option>
                      <option value="after">{t.checks.hookAfter}</option>
                    </select>
                  </label>
                  <label>
                    <span className="small muted">{t.checks.hookTools}</span>
                    <select value={h.tools} onChange={(e) => setHook(h.id, { tools: e.target.value as CheckHook['tools'] })}>
                      {(['command', 'edit', 'any'] as const).map((k) => (
                        <option key={k} value={k}>
                          {t.checks.hookToolsLabel[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="ghost small-button"
                  aria-label={t.checks.removeHook}
                  title={t.checks.removeHook}
                  onClick={() => update(hooks.filter((x) => x.id !== h.id))}
                >
                  ×
                </button>
              </div>
              <div className="checks-command-line">
                <input
                  type="text"
                  spellCheck={false}
                  aria-label={t.checks.hookRun}
                  aria-describedby={hooksHint}
                  placeholder={h.when === 'before' ? './scripts/allow-call.sh' : 'npx prettier --check $RELAY_HOOK_FILES'}
                  value={h.run}
                  onChange={(e) => setHook(h.id, { run: e.target.value })}
                />
              </div>
              <div className="checks-command-options">
                <label>
                  <span className="small muted">{t.checks.commandFolder}</span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={h.cwd ?? ''}
                    onChange={(e) => setHook(h.id, { cwd: e.target.value || undefined })}
                  />
                </label>
                <label>
                  <span className="small muted">{t.checks.hookTimeout}</span>
                  <input
                    type="number"
                    min={1}
                    max={CHECK_LIMITS.maxHookTimeoutSec}
                    value={h.timeoutSec ?? CHECK_LIMITS.hookTimeoutSec}
                    onChange={(e) => setHook(h.id, { timeoutSec: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                </label>
              </div>
              {problem === 'folder' && <span className="small warn-text">{t.checks.badFolder(h.cwd ?? '')}</span>}
              {problem === 'timeout' && <span className="small warn-text">{t.checks.badHookTimeout(CHECK_LIMITS.maxHookTimeoutSec)}</span>}
            </li>
          );
        })}
      </ul>
      {hooks.length < CHECK_LIMITS.hooks && (
        <button
          type="button"
          className="ghost small-button checks-add checks-add-hook"
          onClick={() => update([...hooks, { id: newId(), when: 'before', tools: 'command', run: '' }])}
        >
          {t.checks.addHook}
        </button>
      )}
    </div>
  );
}
