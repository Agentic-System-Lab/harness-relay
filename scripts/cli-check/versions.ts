/**
 * Layer 1 of `scripts/cli-check.ts`: the version each agent CLI was checked with (`CHECKED_VERSIONS`),
 * the newest its maker has published, and the one on this computer; and the issues the CLI versions
 * workflow (`.github/workflows/cli-versions.yml`) keeps: an open one only after the Linux check found
 * a failed check or something removed.
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

/**
 * An npm package's name as one segment of a registry address: every character encoded, the scope's
 * `@` kept (`@scope%2Fname`, as npm itself asks for it).
 */
export function npmName(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, '@');
}

/** A GitHub repository (`owner/name`) as two segments of an API address, each encoded. */
export function githubRepo(repo: string): string {
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((p) => !p)) throw new Error(`not a GitHub repository: ${repo}`);
  return parts.map(encodeURIComponent).join('/');
}

/** The address a source is read at. */
export function sourceUrl(s: VersionSource): string {
  switch (s.kind) {
    case 'npm':
      return `https://registry.npmjs.org/${npmName(s.package)}/latest`;
    case 'pypi':
      return `https://pypi.org/pypi/${encodeURIComponent(s.package)}/json`;
    case 'github':
      return `https://api.github.com/repos/${githubRepo(s.repo)}/releases/latest`;
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
  // Only the numbers say which is newer. Another build of the same numbers (Cursor's hash after its
  // date) says nothing, whatever its letters or digits: it is checked. The sources name released
  // versions only (npm's `latest`, GitHub's latest release), never a prerelease.
  return compareVersions(versionCore(l), versionCore(c)) < 0 ? 'ahead' : 'behind';
}

/** A version's numbers, before any `-` suffix: `2026.11.17` of Cursor's `2026.11.17-f532c45`. */
export const versionCore = (v: string): string => v.split('-')[0]!;

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
  const headers: Record<string, string> = { 'user-agent': 'harness-relay-cli-check' };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (s.kind === 'github') {
    headers.accept = 'application/vnd.github+json';
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let url = '';
  try {
    url = sourceUrl(s);
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
    "Once nothing is left to fix and its live tests ran, move the version forward in one commit with the shapes it saved (`--accept`), the user guide's line in both languages, and the other docs that say which version a behaviour was seen with, once tried again with it; close this issue from that pull request.",
    '',
    'The CLI versions workflow (`.github/workflows/cli-versions.yml`) opens this issue only when the check on Linux finds a failed check or something removed. It says so here when a newer version comes out, and closes the issue once the version checked is the newest.',
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
  /**
   * Its title and body change: a newer version than the issue told of, which a comment says (`comment`),
   * or the version checked moved forward and is still behind.
   */
  | { kind: 'update'; provider: Provider; number: number; title: string; body: string; comment?: string }
  /** The version checked caught up (or went past): the issue is closed with a comment. */
  | { kind: 'close'; provider: Provider; number: number; comment: string };

/**
 * What the workflow does with the open issues it keeps (`open`, the label's). An issue is not opened
 * here: the Linux check opens one only when it finds a failed check or something removed (`ci.ts`).
 * One that is open is updated when a newer version comes out or the version checked moved, and closed
 * once the version checked has caught up with the one the issue told of. A CLI whose source could not
 * be read is left as it is, and so is one not in `rows`. A source that names an older version again
 * (a CDN still serving the one before) closes nothing: the version checked has not caught up.
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
      for (const { issue, latest } of mine) {
        if (compareVersions(versionCore(r.checked), versionCore(normalizeVersion(r.provider, latest))) < 0) continue;
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
    // What the source names now against what the issue told of: newer (or another build of the same
    // numbers), the same, or older (a source still serving the one before: the issue stays as it is).
    // No issue yet: nothing is opened. The check opens one only when it finds a problem.
    const told = first && normalizeVersion(r.provider, first.latest);
    const order = told ? compareVersions(versionCore(r.latest!), versionCore(told)) : 0;
    if (first && order < 0) {
      // Older than the issue's: nothing changes.
    } else if (first && told !== r.latest) {
      actions.push({
        kind: 'update',
        provider: r.provider,
        number: first.issue.number,
        title: issueTitle(r),
        body: issueBody(r),
        comment: `${PROVIDER_LABEL[r.provider]} ${r.latest} is out now (this issue told of ${first.latest}). The workflow checks that one.`,
      });
    } else if (first && first.issue.title !== issueTitle(r)) {
      // The version checked moved forward, not yet to the newest: the issue says so, without a comment.
      actions.push({ kind: 'update', provider: r.provider, number: first.issue.number, title: issueTitle(r), body: issueBody(r) });
    }
    // Two open for one CLI (one opened by hand with the marker, say): the later ones are closed.
    for (const { issue } of extra) {
      actions.push({ kind: 'close', provider: r.provider, number: issue.number, comment: `Kept in #${first!.issue.number}.` });
    }
  }
  return actions;
}
