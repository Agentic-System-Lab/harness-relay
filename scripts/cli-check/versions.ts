/**
 * Layer 1 of `scripts/cli-check.ts`: the version each agent CLI was checked with (`CHECKED_VERSIONS`),
 * the newest its maker has published, and the one on this computer; and the issues the CLI versions
 * workflow (`.github/workflows/cli-versions.yml`) keeps, one open for each CLI that is behind.
 *
 * Where each maker says what its newest version is (`VERSION_SOURCES`) is read from the addresses its
 * own installer reads, never from a page meant for people: npm's registry, PyPI, GitHub's releases,
 * Grok's channel file, the version Cursor's install script downloads, Antigravity's manifest and Muse
 * Code's channel. All of them are public; GitHub's API takes the workflow's token when it is given one.
 */
import { CHECKED_VERSIONS } from '../../src/shared/cliVersions';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../../src/shared/types';

export type VersionSource =
  /** npm's registry: the package's `latest` tag. */
  | { kind: 'npm'; package: string }
  /** PyPI: the project's newest release. */
  | { kind: 'pypi'; package: string }
  /** GitHub: the repository's latest release (not a prerelease), its tag read by `tag`. */
  | { kind: 'github'; repo: string; tag: RegExp }
  /** A text file the maker's installer reads, the version its first group. */
  | { kind: 'text'; url: string; pattern: RegExp }
  /** A JSON document the maker's installer reads, the version at `field`. */
  | { kind: 'json'; url: string; field: string };

export const VERSION_SOURCES: Record<Provider, VersionSource> = {
  claude: { kind: 'npm', package: '@anthropic-ai/claude-code' },
  codex: { kind: 'npm', package: '@openai/codex' },
  // What https://x.ai/cli/install.sh installs: the stable channel's version.
  grok: { kind: 'text', url: 'https://x.ai/cli/stable', pattern: /^\s*(\d+\.\d+\.\d+[\w.-]*)/ },
  // Cursor's install script names the version it downloads.
  cursor: { kind: 'text', url: 'https://cursor.com/install', pattern: /downloads\.cursor\.com\/lab\/([\w.-]+)\// },
  // The manifest Antigravity's install script reads (one per system; they name the same version).
  antigravity: {
    kind: 'json',
    url: 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json',
    field: 'version',
  },
  copilot: { kind: 'npm', package: '@github/copilot' },
  // The channel Muse Code's launcher reads.
  muse: { kind: 'json', url: 'https://api.meta.ai/muse-code/channels/muse-stable', field: 'version' },
  opencode: { kind: 'npm', package: 'opencode-ai' },
  goose: { kind: 'github', repo: 'aaif-goose/goose', tag: /^v(\d+\.\d+\.\d+)$/ },
  cline: { kind: 'npm', package: 'cline' },
  openhands: { kind: 'pypi', package: 'openhands' },
  pi: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
};

/** The address a source is read at. */
export function sourceUrl(s: VersionSource): string {
  switch (s.kind) {
    case 'npm':
      return `https://registry.npmjs.org/${s.package.replace('/', '%2F')}/latest`;
    case 'pypi':
      return `https://pypi.org/pypi/${s.package}/json`;
    case 'github':
      return `https://api.github.com/repos/${s.repo}/releases/latest`;
    default:
      return s.url;
  }
}

/** The version in a source's answer, or undefined when it holds none. */
export function latestFrom(s: VersionSource, body: string): string | undefined {
  if (s.kind === 'text') return s.pattern.exec(body)?.[1];
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return undefined;
  }
  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), j);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  switch (s.kind) {
    case 'npm':
      return str(at('version'));
    case 'pypi':
      return str(at('info.version'));
    case 'github': {
      if (at('prerelease') === true || at('draft') === true) return undefined;
      const tag = str(at('tag_name'));
      return tag ? s.tag.exec(tag)?.[1] : undefined;
    }
    case 'json':
      return str(at(s.field));
  }
}

/**
 * A version as Harness Relay writes it: no leading `v`, and Muse Code's without its build
 * (`1.4.18-R8587.1` is 1.4.18, as `muse --version` names it first).
 */
export function normalizeVersion(p: Provider, v: string): string {
  const out = v.trim().replace(/^v(?=\d)/, '');
  return p === 'muse' ? out.replace(/-R\d+(\.\d+)*$/, '') : out;
}

/**
 * Compares two versions part by part (numbers as numbers): negative when `a` is older. Parts that are
 * not numbers (Cursor's build hash) compare as text, so two builds of one day differ but neither is
 * known to be newer: `versionStatus` calls that behind.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * - current: the newest published is the one checked;
 * - behind: a newer one (or another build) was published since;
 * - ahead: the one checked is newer than what the source names (a prerelease, or a source that lags);
 * - unknown: the source could not be read.
 */
export type VersionStatus = 'current' | 'behind' | 'ahead' | 'unknown';

export function versionStatus(p: Provider, checked: string, latest: string | undefined): VersionStatus {
  if (!latest) return 'unknown';
  const [c, l] = [normalizeVersion(p, checked), normalizeVersion(p, latest)];
  if (c === l) return 'current';
  // Two builds of one day (Cursor's) compare as their hashes do, which says nothing: behind.
  return compareVersions(l, c) < 0 && !sameNumbers(l, c) ? 'ahead' : 'behind';
}

const numbers = (v: string) => v.split(/[.-]/).filter((x) => /^\d+$/.test(x));
const sameNumbers = (a: string, b: string) => numbers(a).join('.') === numbers(b).join('.');

export interface VersionRow {
  provider: Provider;
  checked: string;
  latest?: string;
  /** Why the newest could not be read. */
  error?: string;
  /** What `--version` said on this computer, when asked. */
  installed?: string;
  status: VersionStatus;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The newest version a CLI's maker has published, read from its source. */
export async function fetchLatest(
  p: Provider,
  fetchImpl: Fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ latest?: string; error?: string }> {
  const s = VERSION_SOURCES[p];
  const url = sourceUrl(s);
  const headers: Record<string, string> = { 'user-agent': 'harness-relay-cli-check' };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (s.kind === 'github') {
    headers.accept = 'application/vnd.github+json';
    if (token) headers.authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { error: `${url}: HTTP ${res.status}` };
    const latest = latestFrom(s, await res.text());
    return latest ? { latest: normalizeVersion(p, latest) } : { error: `${url}: no version in the answer` };
  } catch (err) {
    return { error: `${url}: ${(err as Error).message}` };
  }
}

/** Every CLI's row (or `only`'s), the sources read at once. */
export async function versionRows(only: readonly Provider[] = PROVIDERS, fetchImpl: Fetch = fetch): Promise<VersionRow[]> {
  return Promise.all(
    only.map(async (p) => {
      const { latest, error } = await fetchLatest(p, fetchImpl);
      const checked = CHECKED_VERSIONS[p];
      return {
        provider: p,
        checked,
        ...(latest ? { latest } : {}),
        ...(error ? { error } : {}),
        status: versionStatus(p, checked, latest),
      };
    }),
  );
}

/** The rows as a table for a terminal. */
export function versionTable(rows: readonly VersionRow[]): string {
  const head = ['CLI', 'checked', 'newest', 'here', 'status'];
  const body = rows.map((r) => [
    PROVIDER_LABEL[r.provider],
    r.checked,
    r.latest ?? '?',
    r.installed ?? '-',
    r.error ? `unknown (${r.error})` : r.status,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// The workflow's issues

/** The label of the issues the workflow keeps. */
export const ISSUE_LABEL = 'cli-check';

/** What marks an issue as the workflow's, for which CLI, and the newest version it has told of. */
export function issueMarker(p: Provider, latest: string): string {
  return `<!-- cli-check provider=${p} latest=${latest} -->`;
}

export function parseMarker(body: string): { provider: Provider; latest: string } | undefined {
  const m = /<!-- cli-check provider=([a-z]+) latest=(\S+) -->/.exec(body);
  if (!m || !(PROVIDERS as readonly string[]).includes(m[1]!)) return undefined;
  return { provider: m[1] as Provider, latest: m[2]! };
}

export function issueTitle(r: VersionRow): string {
  return `Check ${PROVIDER_LABEL[r.provider]} ${r.latest} (checked with ${r.checked})`;
}

export function issueBody(r: VersionRow): string {
  return [
    `${PROVIDER_LABEL[r.provider]} ${r.latest} is out; Harness Relay was checked with ${r.checked} (\`src/shared/cliVersions.ts\`).`,
    '',
    'Install it apart (never over the copy you use), then check it, layer by layer, cheapest first:',
    '',
    '```sh',
    `npx tsx scripts/cli-check.ts ${r.provider} --bin <path to the new ${r.provider}>`,
    '```',
    '',
    'What each layer does and what to do when one finds something: [the developer guide, "Checking a CLI\'s new version"](https://github.com/Agentic-System-Lab/harness-relay/blob/main/docs/developer-guide.md#checking-a-clis-new-version).',
    "Once nothing is left to fix, move the version forward with the shapes it saved (`--accept`) and the user guide's line, and close this issue from that pull request.",
    '',
    'This issue is kept by the CLI versions workflow (`.github/workflows/cli-versions.yml`): it says so here when a newer version comes out, and closes the issue once the version checked is the newest.',
    '',
    issueMarker(r.provider, r.latest!),
  ].join('\n');
}

export interface OpenIssue {
  number: number;
  title: string;
  body: string;
}

export type IssueAction =
  | { kind: 'create'; provider: Provider; title: string; body: string }
  /** A newer version than the issue told of: its title and body change, and a comment says so. */
  | { kind: 'update'; provider: Provider; number: number; title: string; body: string; comment: string }
  /** The version checked caught up (or went past): the issue is closed with a comment. */
  | { kind: 'close'; provider: Provider; number: number; comment: string };

/**
 * What the workflow does with the open issues it keeps (`open`, the label's): one open issue for each
 * CLI that is behind, updated when a newer version comes out, closed once it is not behind. A CLI
 * whose source could not be read is left as it is.
 */
export function planIssues(rows: readonly VersionRow[], open: readonly OpenIssue[]): IssueAction[] {
  const actions: IssueAction[] = [];
  const byProvider = new Map<Provider, { issue: OpenIssue; latest: string }[]>();
  for (const issue of open) {
    const m = parseMarker(issue.body);
    if (m) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), { issue, latest: m.latest }]);
  }
  for (const r of rows) {
    const mine = (byProvider.get(r.provider) ?? []).sort((a, b) => a.issue.number - b.issue.number);
    if (r.status === 'unknown') continue;
    if (r.status !== 'behind') {
      for (const { issue } of mine) {
        actions.push({
          kind: 'close',
          provider: r.provider,
          number: issue.number,
          comment: `Harness Relay is checked with ${PROVIDER_LABEL[r.provider]} ${r.checked} now, the newest${r.status === 'ahead' ? ' or newer' : ''}.`,
        });
      }
      continue;
    }
    const [first, ...extra] = mine;
    if (!first) {
      actions.push({ kind: 'create', provider: r.provider, title: issueTitle(r), body: issueBody(r) });
    } else if (normalizeVersion(r.provider, first.latest) !== r.latest) {
      actions.push({
        kind: 'update',
        provider: r.provider,
        number: first.issue.number,
        title: issueTitle(r),
        body: issueBody(r),
        comment: `${PROVIDER_LABEL[r.provider]} ${r.latest} is out now (this issue told of ${first.latest}): check that one instead.`,
      });
    }
    // Two open for one CLI (one opened by hand with the marker, say): the later ones are closed.
    for (const { issue } of extra) {
      actions.push({ kind: 'close', provider: r.provider, number: issue.number, comment: `Kept in #${first!.issue.number}.` });
    }
  }
  return actions;
}
