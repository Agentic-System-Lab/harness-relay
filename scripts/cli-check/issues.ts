/**
 * Keeping the CLI versions workflow's issues through `gh` (`versions --issues`): what `planIssues()`
 * decides, carried out, or with `dryRun` only said. `gh` is given, so that the tests can stand in for it.
 */
import { PROVIDER_LABEL } from '../../src/shared/types';
import { ISSUE_LABEL, planIssues, type IssueAction, type OpenIssue, type VersionRow } from './versions';

/** Runs gh with these arguments (and `stdin`), and gives its output; throws when it fails. */
export type Gh = (args: string[], stdin?: string) => Promise<string>;

/**
 * Keeps the issues, and says what it did, a line each. `dryRun`: it reads the open issues and changes
 * nothing, not even the label.
 */
export async function keepIssues(rows: readonly VersionRow[], dryRun: boolean, gh: Gh): Promise<string[]> {
  // `gh label create --force` makes the label or updates it: the first run has none yet.
  if (!dryRun) {
    await gh([
      'label',
      'create',
      ISSUE_LABEL,
      '--color',
      '5319E7',
      '--description',
      'A new agent CLI version whose check found something to fix',
      '--force',
    ]);
  }
  const open = JSON.parse(
    await gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title,body', '--limit', '200']),
  ) as OpenIssue[];
  const actions = planIssues(rows, open);
  if (!dryRun) for (const a of actions) await applyIssue(a, gh);
  if (!actions.length) return ['Issues: nothing to change.'];
  return actions.map((a) => (dryRun ? `Would have: ${describeIssue(a)}` : describeIssue(a)));
}

/** One action, through gh: bodies and comments on its stdin, never on its command line. */
export async function applyIssue(a: IssueAction, gh: Gh): Promise<void> {
  if (a.kind === 'create') await gh(['issue', 'create', '--title', a.title, '--label', ISSUE_LABEL, '--body-file', '-'], a.body);
  else if (a.kind === 'update') {
    await gh(['issue', 'edit', String(a.number), '--title', a.title, '--body-file', '-'], a.body);
    if (a.comment) await gh(['issue', 'comment', String(a.number), '--body-file', '-'], a.comment);
  } else await gh(['issue', 'close', String(a.number), '--comment', a.comment]);
}

export function describeIssue(a: IssueAction): string {
  if (a.kind === 'create') return `Opened an issue: ${a.title}`;
  if (a.kind === 'update') return `Updated #${a.number}: ${a.title}`;
  return `Closed #${a.number} (${PROVIDER_LABEL[a.provider]})`;
}
