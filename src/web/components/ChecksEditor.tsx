import { useEffect, useId, useRef, useState } from 'react';
import {
  CHECK_LIMITS,
  CONVENTIONAL_COMMIT_PATTERN,
  type CheckCommand,
  type CheckList,
  type CheckOutcome,
  type Permission,
} from '../../shared/types';
import { api } from '../api';
import { badCommitPattern, badPath, commandProblem, listFrom, pathsText, ruleCount } from '../checks';
import { useT } from '../i18n';
import { CommandOutcome } from './ChecksCard';

interface Props {
  value: CheckList | undefined;
  onChange: (next: CheckList | undefined) => void;
  /** The permission the team has: read-only changes no files, so nothing is checked (absent: a template). */
  permission?: Permission;
  /** The conversation the list is for: its commands can be tried on its working directories (none for a template). */
  convId?: string;
}

/** What team checks' commands can do on the server's computer (`GET /api/checks/environment`). */
type Environment = { platform: string; sandbox?: string };

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Team checks in Team settings and the template editor (`ConversationSettings.checks`): protected paths,
 * a line each, the commit format, and commands that must succeed. Folded away until it is opened, or
 * while it has rules.
 */
export function ChecksEditor({ value, onChange, permission, convId }: Props) {
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
  const [env, setEnv] = useState<Environment>();
  const [tried, setTried] = useState<Record<string, CheckOutcome | 'running' | string>>({});
  useEffect(() => {
    api.checksEnvironment().then(setEnv, () => undefined);
  }, []);
  const update = (next: { paths?: string; pattern?: string; commands?: CheckCommand[] }) => {
    const p = next.paths ?? paths;
    const c = next.pattern ?? pattern;
    const cmds = next.commands ?? commands;
    setPaths(p);
    setPattern(c);
    setCommands(cmds);
    onChange(listFrom(p, c, before.current, cmds));
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

  return (
    <details className="field checks-editor" open={openAtStart}>
      <summary>
        <span>{t.checks.editorTitle}</span>
        {rules > 0 && <span className="muted small"> · {t.checks.count(rules)}</span>}
      </summary>
      {/* The layout lives on a wrapper: some browsers ignore display: flex on <details>. */}
      <div className="checks-editor-body">
        <p className="small muted">{t.checks.editorHint}</p>
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
      </div>
    </details>
  );
}
