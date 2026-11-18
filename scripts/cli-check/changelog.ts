/**
 * Layer 4 of `scripts/cli-check.ts`: what the maker says changed between the version checked and the
 * new one, the lines about what decides how the CLI runs picked out (`KEYWORDS`), since the change
 * that matters most is the one no recording shows: a new setting that runs something without asking,
 * a project file it now loads by itself, a sandbox flag that means something else. And the slower
 * checks the CLI needs before its version moves forward, with their commands.
 */
import type { Provider } from '../../src/shared/types';
import { compareVersions, githubRepo, normalizeVersion, type Fetch } from './versions';

export type NotesSource =
  /** A CHANGELOG.md, a heading per version (its first group). */
  | { kind: 'markdown'; url: string; heading: RegExp }
  /** GitHub's releases, the version in the tag (its first group); prereleases left out. */
  | { kind: 'releases'; repo: string; tag: RegExp }
  /** The CLI's own command (Antigravity's `agy changelog`), run in the scratch folder. */
  | { kind: 'command'; args: string[] }
  /** None that can be read: where people read them. */
  | { kind: 'none'; where: string };

export const NOTES_SOURCES: Record<Provider, NotesSource> = {
  claude: {
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
    heading: /^## (\d+\.\d+\.\d+)\b/,
  },
  codex: { kind: 'releases', repo: 'openai/codex', tag: /^rust-v(\d+\.\d+\.\d+)$/ },
  grok: { kind: 'none', where: 'no release notes are published for the Grok CLI; read its --help and the docs at https://docs.x.ai' },
  cursor: { kind: 'none', where: 'https://cursor.com/changelog (the CLI’s entries among the editor’s)' },
  antigravity: { kind: 'command', args: ['changelog'] },
  copilot: { kind: 'releases', repo: 'github/copilot-cli', tag: /^v(\d+\.\d+\.\d+)$/ },
  muse: {
    kind: 'none',
    where: 'no release notes are published for Muse Code; read `muse --help` and https://dev.meta.ai/products/muse-code/',
  },
  opencode: { kind: 'releases', repo: 'anomalyco/opencode', tag: /^v(\d+\.\d+\.\d+)$/ },
  goose: { kind: 'releases', repo: 'aaif-goose/goose', tag: /^v(\d+\.\d+\.\d+)$/ },
  cline: { kind: 'releases', repo: 'cline/cline', tag: /^cli-v(\d+\.\d+\.\d+)$/ },
  openhands: { kind: 'releases', repo: 'OpenHands/OpenHands-CLI', tag: /^(\d+\.\d+\.\d+)$/ },
  pi: {
    kind: 'markdown',
    url: 'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md',
    heading: /^## \[(\d+\.\d+\.\d+)\]/,
  },
};

/**
 * What a line must name to be read first: permissions and approvals, sandboxes and trust, what the
 * CLI runs by itself (hooks), its protocols and modes, flags and environment variables, security, and
 * anything removed, renamed or breaking.
 */
export const STRONG =
  /permission|approv|allow-?list|\bdeny|denied|trust|sandbox|seatbelt|bubblewrap|landlock|\bhooks?\b|security|vulnerab|\bacp\b|protocol|stream-json|headless|non-interactive|print mode|app-server|\brpc\b|(?:^|[\s`(])--[a-z][\w-]+|environment variable|breaking|remov|renam|deprecat|no longer/i;

/** What a line may name to be read after those: settings, sessions, what it loads (MCP, plugins, skills), sign-in. */
export const WEAK =
  /setting|config|policy|session|resume|\bmcp\b|plugin|skill|sign[- ]?in|log[- ]?in|\bauth|token|api key|by default|instead of/i;

/** An environment variable's name (case matters). */
const ENV_VAR = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/;

export interface VersionNotes {
  version: string;
  lines: string[];
}

/** The versions after `from`, up to `to`, of a CHANGELOG.md's sections. */
export function notesFromMarkdown(text: string, heading: RegExp, from: string, to?: string): VersionNotes[] {
  const out: VersionNotes[] = [];
  let cur: VersionNotes | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = heading.exec(line);
    if (m) {
      cur = { version: m[1]!, lines: [] };
      out.push(cur);
    } else if (/^## /.test(line)) cur = undefined;
    else if (cur && line.trim()) cur.lines.push(line.trim());
  }
  return inRange(out, from, to);
}

/** The versions after `from`, up to `to`, of GitHub's releases (as its API lists them). */
export function notesFromReleases(releases: unknown, tag: RegExp, from: string, to?: string): VersionNotes[] {
  const list = Array.isArray(releases) ? releases : [];
  const out: VersionNotes[] = [];
  for (const r of list as { tag_name?: string; body?: string; prerelease?: boolean; draft?: boolean }[]) {
    if (r.prerelease || r.draft || typeof r.tag_name !== 'string') continue;
    const m = tag.exec(r.tag_name);
    if (!m) continue;
    out.push({
      version: m[1]!,
      lines: String(r.body ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }
  return inRange(out, from, to);
}

/** Notes printed by the CLI itself (`agy changelog`): a line with a version number starts a version. */
export function notesFromText(text: string, from: string, to?: string): VersionNotes[] {
  const out: VersionNotes[] = [];
  let cur: VersionNotes | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(?:#+\s*)?v?(\d+\.\d+\.\d+)\b/.exec(line);
    if (m) {
      cur = { version: m[1]!, lines: [] };
      out.push(cur);
    } else if (cur && line) cur.lines.push(line);
  }
  return inRange(out, from, to);
}

function inRange(notes: VersionNotes[], from: string, to?: string): VersionNotes[] {
  return notes
    .filter((n) => compareVersions(n.version, from) > 0 && (!to || compareVersions(n.version, to) <= 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The lines worth reading, those `STRONG` (or an environment variable's name) picks out first, then `WEAK`'s; headings left out. */
export function pickLines(lines: readonly string[]): { strong: string[]; weak: string[] } {
  const body = lines.filter((l) => !/^#+\s/.test(l));
  const strong = body.filter((l) => STRONG.test(l) || ENV_VAR.test(l));
  return { strong, weak: body.filter((l) => !strong.includes(l) && WEAK.test(l)) };
}

/** The release notes since `from` as report lines: each version's picked lines, newest first. */
export async function releaseNotes(p: Provider, from: string, to?: string, bin?: string, fetchImpl: Fetch = fetch): Promise<string[]> {
  const s = NOTES_SOURCES[p];
  const [f, t] = [normalizeVersion(p, from), to ? normalizeVersion(p, to) : undefined];
  let notes: VersionNotes[];
  try {
    if (s.kind === 'none') return [`release notes: ${s.where}`];
    if (s.kind === 'command') {
      if (!bin) return ['release notes: give the new CLI with --bin to read them'];
      const { capture } = await import('../../src/server/process');
      const r = await capture(bin, s.args, process.env, { timeoutMs: 60_000, maxCapture: 2_000_000 });
      notes = notesFromText(r.stdout, f, t);
    } else {
      const url = s.kind === 'markdown' ? s.url : `https://api.github.com/repos/${githubRepo(s.repo)}/releases?per_page=100`;
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const res = await fetchImpl(url, {
        headers: {
          'user-agent': 'harness-relay-cli-check',
          ...(s.kind === 'releases'
            ? { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
            : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return [`release notes: ${url}: HTTP ${res.status}`];
      notes =
        s.kind === 'markdown' ? notesFromMarkdown(await res.text(), s.heading, f, t) : notesFromReleases(await res.json(), s.tag, f, t);
    }
  } catch (err) {
    return [`release notes: ${(err as Error).message}`];
  }
  if (!notes.length) return [`release notes: none found after ${f}${t ? ` up to ${t}` : ''}`];
  const out: string[] = [];
  const clip = (l: string) => (l.length > 220 ? `${l.slice(0, 219)}…` : l);
  for (const n of notes) {
    const { strong, weak } = pickLines(n.lines);
    out.push(
      `${n.version}: ${strong.length} lines about permissions, sandboxes, hooks, flags or what was removed; ${weak.length} about settings, sessions and sign-in (of ${n.lines.length})`,
    );
    for (const l of strong.slice(0, 20)) out.push(`  ! ${clip(l)}`);
    if (strong.length > 20) out.push(`  … and ${strong.length - 20} more`);
    for (const l of weak.slice(0, 8)) out.push(`    ${clip(l)}`);
    if (weak.length > 8) out.push(`    … and ${weak.length - 8} more`);
  }
  return out;
}

/** The slower checks a CLI's new version needs, beyond these layers, with their commands. */
export async function slowerChecks(p: Provider, bin?: string): Promise<string[]> {
  const { isOpenProvider } = await import('../../src/shared/types');
  const { GATEWAY_OVER_HTTP } = await import('../../src/server/gateway');
  const out = ['before its version moves forward:'];
  if (isOpenProvider(p)) out.push('  npx tsx scripts/sandbox-check.ts   (Harness Relay’s own sandbox, which it runs in below full access)');
  if (GATEWAY_OVER_HTTP.includes(p)) {
    out.push(
      `  npx tsx scripts/mcp-headers-check.ts ${p}${bin ? ` --bin ${bin}` : ''}   (it gets the gateway over loopback HTTP: its MCP headers must stay in memory)`,
    );
  }
  out.push(
    `  where layer 2 or 3 found a change: the adapter (src/server/agents/), its recorded fixtures (test/fixtures/${p}/, where it has them) and its end-to-end fake (e2e/fake-cli/agents/${p}.cjs)`,
  );
  return out;
}
