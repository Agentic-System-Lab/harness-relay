import { useId, useRef, useState } from 'react';
import { CONVENTIONAL_COMMIT_PATTERN, type CheckList, type Permission } from '../../shared/types';
import { badCommitPattern, badPath, listFrom, pathsText, ruleCount } from '../checks';
import { useT } from '../i18n';

interface Props {
  value: CheckList | undefined;
  onChange: (next: CheckList | undefined) => void;
  /** The permission the team has: read-only changes no files, so nothing is checked (absent: a template). */
  permission?: Permission;
}

/**
 * Team checks in Team settings and the template editor (`ConversationSettings.checks`): protected paths,
 * a line each, and the commit format. Folded away until it is opened, or while it has rules.
 */
export function ChecksEditor({ value, onChange, permission }: Props) {
  const t = useT();
  const pathsId = useId();
  const pathsHint = useId();
  const patternId = useId();
  const patternHint = useId();
  // What the conversation or template had when the editor opened: emptied, a list stays an empty one.
  const before = useRef(value);
  const [paths, setPaths] = useState(() => pathsText(value));
  const [pattern, setPattern] = useState(() => value?.commitPattern ?? '');
  const update = (nextPaths: string, nextPattern: string) => {
    setPaths(nextPaths);
    setPattern(nextPattern);
    onChange(listFrom(nextPaths, nextPattern, before.current));
  };
  const wrongPath = badPath(paths);
  const wrongPattern = badCommitPattern(pattern);
  const rules = ruleCount(value);

  return (
    <details className="field checks-editor" open={rules > 0}>
      <summary>
        <span>{t.checks.editorTitle}</span>
        {rules > 0 && <span className="muted small"> · {t.checks.count(rules)}</span>}
      </summary>
      <p className="small muted">{t.checks.editorHint}</p>
      {permission === 'read-only' && rules > 0 && <p className="small warn-text">{t.checks.readOnlyNote}</p>}
      <label htmlFor={pathsId}>{t.checks.protectedPaths}</label>
      <textarea
        id={pathsId}
        rows={3}
        spellCheck={false}
        aria-describedby={pathsHint}
        aria-invalid={Boolean(wrongPath)}
        placeholder={'.env\n*.pem\nsecrets/'}
        value={paths}
        onChange={(e) => update(e.target.value, pattern)}
      />
      <span className="small muted" id={pathsHint}>
        {t.checks.protectedPathsHint}
      </span>
      {wrongPath && <span className="small warn-text">{t.checks.badPath(wrongPath)}</span>}
      <label htmlFor={patternId}>{t.checks.commitPattern}</label>
      <div className="checks-pattern">
        <input
          id={patternId}
          type="text"
          spellCheck={false}
          aria-describedby={patternHint}
          aria-invalid={Boolean(wrongPattern)}
          value={pattern}
          onChange={(e) => update(paths, e.target.value)}
        />
        <button type="button" className="ghost small-button" onClick={() => update(paths, CONVENTIONAL_COMMIT_PATTERN)}>
          {t.checks.conventional}
        </button>
      </div>
      <span className="small muted" id={patternHint}>
        {t.checks.commitPatternHint}
      </span>
      {wrongPattern && <span className="small warn-text">{t.checks.badPattern(wrongPattern)}</span>}
    </details>
  );
}
