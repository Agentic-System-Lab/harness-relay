import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTES_SOURCES,
  notesFromMarkdown,
  notesFromReleases,
  notesFromText,
  pickLines,
  releaseNotes,
} from '../scripts/cli-check/changelog';
import { parseArgs } from '../scripts/cli-check/args';
import { ciMatrix, fenced, postReports, reportComment, reportMarker, type Report } from '../scripts/cli-check/ci';
import { MUSE_BUILDS, artifactFor, manifestDownload, obtain, thisSystem } from '../scripts/cli-check/obtain';
import { jobsIn } from './workflow-steps';
import { keepIssues } from '../scripts/cli-check/issues';
import { LIVE_CLOUD_CLIS, LIVE_ENDPOINT_CLIS, NO_SHAPES, SHAPES_DIR, liveCommands, verdict } from '../scripts/cli-check/layers';
import {
  MUSE_MODEL,
  callsOf,
  decide,
  marker,
  scenarioOf,
  shellArgs,
  shellTool,
  startModel,
  toolsOf,
  type ScriptedModel,
  writeCall,
} from '../scripts/cli-check/model';
import { HELP_ARGS } from '../scripts/cli-check/probe';
import { NO_RUN, SCENARIOS, guardsShell, guardsTool, type Check, type Ctx, type Outcome } from '../scripts/cli-check/scenarios';
import { KEPT, cliEnv, makeScratch } from '../scripts/cli-check/scratch';
import {
  describeDiff,
  diffShapes,
  flagsIn,
  flagsOf,
  kindsOf,
  memoryRecorder,
  messagesOf,
  pathsOf,
  sameShape,
  shapeOf,
  type Shape,
} from '../scripts/cli-check/shape';
import {
  ISSUE_LABEL,
  VERSION_SOURCES,
  compareVersions,
  fetchLatest,
  githubRepo,
  issueBody,
  issueMarker,
  issueTitle,
  latestFrom,
  normalizeVersion,
  npmName,
  parseMarker,
  planIssues,
  sourceUrl,
  versionCore,
  versionStatus,
  versionTable,
  type VersionRow,
} from '../scripts/cli-check/versions';
import { CLI_RECIPES } from '../src/server/cliInstall';
import { CHECKED_VERSIONS } from '../src/shared/cliVersions';
import { PROVIDERS, isOpenProvider, type Provider } from '../src/shared/types';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** A fetch that answers each address from a table, and keeps what it was asked. */
function fakeFetch(answers: Record<string, { status?: number; body: string }>) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const a = answers[url];
    return new Response(a?.body ?? 'not here', { status: a ? (a.status ?? 200) : 404 });
  };
  return { f, asked };
}

describe('the versions checked (src/shared/cliVersions.ts)', () => {
  it('has one for every CLI', () => {
    expect(Object.keys(CHECKED_VERSIONS).sort()).toEqual([...PROVIDERS].sort());
  });

  it('is what Settings installs for the open agents, whose versions are pinned', () => {
    for (const p of PROVIDERS.filter(isOpenProvider)) {
      const r = CLI_RECIPES[p];
      const pinned = r.method === 'script' ? JSON.stringify(r.posix?.env?.('/x')) : r.package;
      expect(pinned, p).toContain(CHECKED_VERSIONS[p]);
    }
  });

  it('is what the user guide says each CLI was checked with, in both languages', () => {
    const commands: Record<Provider, string> = {
      claude: 'claude',
      codex: 'codex',
      grok: 'grok',
      cursor: 'cursor-agent',
      antigravity: 'agy',
      copilot: 'copilot',
      muse: 'muse',
      opencode: 'opencode',
      goose: 'goose',
      cline: 'cline',
      openhands: 'openhands',
      pi: 'pi',
    };
    for (const doc of ['docs/user-guide.md', 'docs/user-guide.zh-TW.md']) {
      const lines = read(doc).split('\n');
      for (const p of PROVIDERS) {
        // The CLI's line in "Installing the agent CLIs": a list item or a table row naming its command.
        const line = lines.find((l) => /^(- \[|\| \[)/.test(l) && new RegExp(`[（(]\`${commands[p]}\``).test(l));
        expect(line, `${doc}: ${p}`).toBeDefined();
        expect(line, `${doc}: ${p}`).toContain(CHECKED_VERSIONS[p]);
      }
    }
  });

  it('is the version each saved shape was recorded with, and every CLI has them but those that say why not', () => {
    expect(Object.keys(NO_SHAPES)).toEqual(['antigravity']);
    for (const p of PROVIDERS) {
      const layers = NO_SHAPES[p] ? [] : NO_RUN[p] ? ['probe'] : ['probe', 'run'];
      for (const layer of layers) {
        const f = join(SHAPES_DIR, p, `${layer}.json`);
        expect(existsSync(f), `${p} ${layer}`).toBe(true);
        expect(JSON.parse(readFileSync(f, 'utf8')).version, `${p} ${layer}`).toBe(CHECKED_VERSIONS[p]);
      }
      if (NO_SHAPES[p]) expect(existsSync(join(SHAPES_DIR, p)), p).toBe(false);
    }
  });

  it("holds nothing of the computer it was recorded on: no paths, user names or the developer's own skills", () => {
    for (const p of readdirSync(SHAPES_DIR)) {
      for (const f of readdirSync(join(SHAPES_DIR, p))) {
        const text = readFileSync(join(SHAPES_DIR, p, f), 'utf8');
        // A value kept in a shape is a word, never a path: a slash-led one would be this computer's.
        expect(text, `${p}/${f}`).not.toMatch(/=\/(Users|home|private|tmp|var)\//);
        expect(text, `${p}/${f}`).not.toMatch(/relay-cli-check-|harness-relay-cli-check|cli-check-key|RELAY-DB-/);
      }
    }
  });

  it('saves shapes only for known CLIs and layers', () => {
    for (const p of readdirSync(SHAPES_DIR)) {
      expect(PROVIDERS as readonly string[]).toContain(p);
      for (const f of readdirSync(join(SHAPES_DIR, p))) expect(['probe.json', 'run.json']).toContain(f);
    }
  });
});

describe('layer 1: the newest versions', () => {
  it('reads each kind of source as its maker publishes it', () => {
    expect(latestFrom(VERSION_SOURCES.claude, JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.327' }))).toBe('2.1.327');
    expect(latestFrom(VERSION_SOURCES.openhands, JSON.stringify({ info: { version: '1.16.0' } }))).toBe('1.16.0');
    expect(latestFrom(VERSION_SOURCES.goose, JSON.stringify({ tag_name: 'v1.60.1', prerelease: false }))).toBe('1.60.1');
    expect(latestFrom(VERSION_SOURCES.goose, JSON.stringify({ tag_name: 'v1.61.0', prerelease: true }))).toBeUndefined();
    expect(latestFrom(VERSION_SOURCES.grok, '1.0.88\n')).toBe('1.0.88');
    const cursorScript = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.17-f532c45/${OS}/${ARCH}/agent-cli-package.tar.gz"';
    expect(latestFrom(VERSION_SOURCES.cursor, cursorScript)).toBe('2026.11.17-f532c45');
    expect(latestFrom(VERSION_SOURCES.antigravity, JSON.stringify({ version: '1.5.10', url: 'https://x', sha512: 'f1' }))).toBe('1.5.10');
    expect(latestFrom(VERSION_SOURCES.muse, JSON.stringify({ channel: 'muse-stable', version: '1.4.23-R8977.1' }))).toBe('1.4.23-R8977.1');
    expect(latestFrom(VERSION_SOURCES.claude, 'not json')).toBeUndefined();
  });

  it('encodes every name it puts in an address, a scoped npm package as npm asks for it', () => {
    expect(npmName('@anthropic-ai/claude-code')).toBe('@anthropic-ai%2Fclaude-code');
    // Every slash and anything else an address would read, not only the first slash.
    expect(npmName('@a/b/c?d#e')).toBe('@a%2Fb%2Fc%3Fd%23e');
    expect(npmName('../x')).toBe('..%2Fx');
    expect(githubRepo('aaif-goose/goose')).toBe('aaif-goose/goose');
    expect(githubRepo('a b/c?d')).toBe('a%20b/c%3Fd');
    expect(() => githubRepo('a/b/c')).toThrow('not a GitHub repository');
    expect(() => githubRepo('a')).toThrow('not a GitHub repository');
    expect(sourceUrl({ kind: 'pypi', package: 'open hands' })).toBe('https://pypi.org/pypi/open%20hands/json');
  });

  it('asks npm for a scoped package with its slash escaped', () => {
    expect(sourceUrl(VERSION_SOURCES.claude)).toBe('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
    expect(sourceUrl(VERSION_SOURCES.openhands)).toBe('https://pypi.org/pypi/openhands/json');
    expect(sourceUrl(VERSION_SOURCES.goose)).toBe('https://api.github.com/repos/aaif-goose/goose/releases/latest');
  });

  it("writes versions as Harness Relay does: no leading v, Muse Code's without its build", () => {
    expect(normalizeVersion('goose', 'v1.60.1')).toBe('1.60.1');
    expect(normalizeVersion('muse', '1.4.23-R8977.1')).toBe('1.4.23');
    expect(normalizeVersion('cursor', '2026.11.17-f532c45')).toBe('2026.11.17-f532c45');
  });

  it('compares versions part by part, as numbers', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('0.167.0', '0.170.0')).toBeLessThan(0);
    expect(compareVersions('2026.11.17-f532c45', '2026.11.11-043ef28')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('says whether a CLI is behind', () => {
    expect(versionStatus('claude', '2.1.322', '2.1.327')).toBe('behind');
    expect(versionStatus('claude', '2.1.322', '2.1.322')).toBe('current');
    expect(versionStatus('muse', '1.4.18', '1.4.18-R8587.1')).toBe('current');
    expect(versionStatus('claude', '2.1.330', '2.1.327')).toBe('ahead');
    // Another build of the same day: neither is known to be newer, so it is checked.
    expect(versionStatus('cursor', '2026.11.11-043ef28', '2026.11.11-ffffff0')).toBe('behind');
    // Whatever the hashes' letters or digits: one that sorts before, or is all digits, is not "ahead".
    expect(versionStatus('cursor', '2026.11.11-ffffff0', '2026.11.11-043ef28')).toBe('behind');
    expect(versionStatus('cursor', '2026.11.11-043ef28', '2026.11.11-0412345')).toBe('behind');
    expect(versionStatus('cursor', '2026.11.17-f532c45', '2026.11.11-043ef28')).toBe('ahead');
    expect(versionStatus('claude', '2.1.322', undefined)).toBe('unknown');
    expect(versionCore('2026.11.17-f532c45')).toBe('2026.11.17');
  });

  it("reads a source through fetch, with GitHub's token only for GitHub, and says why one could not be read", async () => {
    const { f, asked } = fakeFetch({
      'https://api.github.com/repos/aaif-goose/goose/releases/latest': { body: JSON.stringify({ tag_name: 'v1.60.1' }) },
      'https://registry.npmjs.org/cline/latest': { body: JSON.stringify({ version: '3.0.75' }) },
      'https://pypi.org/pypi/openhands/json': { status: 503, body: 'down' },
    });
    const env = { GITHUB_TOKEN: 'tok' };
    expect(await fetchLatest('goose', f, env)).toEqual({ latest: '1.60.1' });
    expect(await fetchLatest('cline', f, env)).toEqual({ latest: '3.0.75' });
    expect((await fetchLatest('openhands', f, env)).error).toContain('HTTP 503');
    expect(asked[0]!.headers.authorization).toBe('Bearer tok');
    expect(asked[1]!.headers.authorization).toBeUndefined();
  });

  it('prints the rows as a table', () => {
    const rows: VersionRow[] = [
      { provider: 'claude', checked: '2.1.322', latest: '2.1.327', installed: '2.1.327', status: 'behind' },
      { provider: 'cline', checked: '3.0.74', latest: '3.0.74', status: 'current' },
      { provider: 'muse', checked: '1.4.18', error: 'HTTP 500', status: 'unknown' },
    ];
    const t = versionTable(rows).split('\n');
    expect(t[0]).toMatch(/^CLI\s+checked\s+newest\s+here\s+status$/);
    expect(t[1]).toMatch(/^Claude Code\s+2\.1\.322\s+2\.1\.327\s+2\.1\.327\s+behind$/);
    expect(t[2]).toMatch(/^Cline\s+3\.0\.74\s+3\.0\.74\s+-\s+current$/);
    expect(t[3]).toContain('unknown (HTTP 500)');
  });
});

describe("layer 1: the CLI versions workflow's issues", () => {
  const row = (p: Provider, latest: string, checked = CHECKED_VERSIONS[p]): VersionRow => ({
    provider: p,
    checked,
    latest,
    status: versionStatus(p, checked, latest),
  });
  const behind = (p: Provider, latest: string) => row(p, latest);
  /** An issue the workflow opened for `p` when `latest` was the newest and `checked` the version checked. */
  const issue = (number: number, p: Provider, latest: string, checked = CHECKED_VERSIONS[p]) => ({
    number,
    title: issueTitle(row(p, latest, checked)),
    body: issueBody(row(p, latest, checked)),
  });

  it('marks its issues with the CLI and the version they tell of', () => {
    expect(parseMarker(issueMarker('copilot', '1.0.113'))).toEqual({ provider: 'copilot', latest: '1.0.113' });
    expect(parseMarker('<!-- cli-check provider=nobody latest=1 -->')).toBeUndefined();
    const body = issueBody(behind('claude', '2.1.327'));
    expect(body).toContain('npx tsx scripts/cli-check.ts claude --bin');
    expect(body).toContain(CHECKED_VERSIONS.claude);
    expect(parseMarker(body)).toEqual({ provider: 'claude', latest: '2.1.327' });
  });

  it('opens one for a CLI that is behind and has none', () => {
    const actions = planIssues([behind('claude', '2.1.327')], []);
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'create',
        provider: 'claude',
        title: `Check Claude Code 2.1.327 (checked with ${CHECKED_VERSIONS.claude})`,
      }),
    ]);
  });

  it('leaves one that tells of the newest as it is, and updates one when a newer version came out', () => {
    expect(planIssues([behind('claude', '2.1.327')], [issue(7, 'claude', '2.1.327')])).toEqual([]);
    const [a] = planIssues([behind('claude', '2.1.330')], [issue(7, 'claude', '2.1.327')]);
    expect(a).toMatchObject({ kind: 'update', number: 7, title: expect.stringContaining('2.1.330') });
    expect(a!.kind === 'update' && a!.comment).toContain('2.1.330 is out now');
    expect(a!.kind === 'update' && parseMarker(a!.body)?.latest).toBe('2.1.330');
  });

  it('updates its title and body without a comment when the version checked moved forward but is still behind', () => {
    const [a] = planIssues([row('claude', '2.1.330', '2.1.325')], [issue(7, 'claude', '2.1.330', '2.1.322')]);
    expect(a).toEqual({
      kind: 'update',
      provider: 'claude',
      number: 7,
      title: 'Check Claude Code 2.1.330 (checked with 2.1.325)',
      body: expect.stringContaining('checked with 2.1.325'),
    });
  });

  it('changes nothing when a source names an older version again than the issue told of (a CDN still serving the one before)', () => {
    // Older than the issue's, still newer than the version checked: no update to the older one.
    expect(planIssues([behind('cursor', '2026.11.15-aaaaaaa')], [issue(5, 'cursor', '2026.11.17-f532c45')])).toEqual([]);
    // Back to the version checked: not closed, since the version checked has not caught up with the issue's.
    const current = row('cursor', CHECKED_VERSIONS.cursor);
    expect(current.status).toBe('current');
    expect(planIssues([current], [issue(5, 'cursor', '2026.11.17-f532c45')])).toEqual([]);
  });

  it('closes it once the version checked caught up with the one it told of, or went past it', () => {
    const current = row('claude', '2.1.327', '2.1.327');
    expect(planIssues([current], [issue(7, 'claude', '2.1.327')])).toEqual([expect.objectContaining({ kind: 'close', number: 7 })]);
    const ahead = row('claude', '2.1.327', '2.1.330');
    expect(ahead.status).toBe('ahead');
    const [a] = planIssues([ahead], [issue(7, 'claude', '2.1.327')]);
    expect(a).toMatchObject({ kind: 'close', number: 7, comment: expect.stringContaining('2.1.330 now, the newest or newer') });
  });

  it('closes a second one for the same CLI, and touches only the issues of the CLIs it read', () => {
    const actions = planIssues([behind('codex', '0.170.0')], [issue(9, 'codex', '0.170.0'), issue(12, 'codex', '0.170.0')]);
    expect(actions).toEqual([expect.objectContaining({ kind: 'close', number: 12, comment: 'Kept in #9.' })]);
    // Several CLIs at once: each one's own issues only.
    const many = planIssues(
      [row('claude', '2.1.327', '2.1.327'), behind('codex', '0.170.0')],
      [issue(7, 'claude', '2.1.327'), issue(9, 'codex', '0.170.0'), issue(11, 'copilot', '1.0.113')],
    );
    expect(many).toEqual([expect.objectContaining({ kind: 'close', provider: 'claude', number: 7 })]);
  });

  it("leaves a CLI whose source could not be read, and issues that are not the workflow's", () => {
    const unknown: VersionRow = { provider: 'grok', checked: '1.0.77', error: 'HTTP 500', status: 'unknown' };
    expect(planIssues([unknown], [issue(3, 'grok', '1.0.88'), { number: 4, title: 'Something else', body: 'no marker' }])).toEqual([]);
  });

  it('keeps them through gh: the label, then the open issues, then each action, bodies on stdin', async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const open = [issue(7, 'claude', '2.1.327'), issue(9, 'codex', '0.169.0'), issue(11, 'cline', '3.0.75')];
    // Cline's version checked caught up with the one its issue told of.
    const gh = async (args: string[], stdin?: string) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      return args[0] === 'issue' && args[1] === 'list' ? JSON.stringify(open) : '';
    };
    const rows = [behind('claude', '2.1.330'), behind('codex', '0.170.0'), row('cline', '3.0.75', '3.0.75'), behind('pi', '1.5.2')];
    const lines = await keepIssues(rows, false, gh);
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'label create',
      'issue list',
      'issue edit',
      'issue comment',
      'issue edit',
      'issue comment',
      'issue close',
      'issue create',
    ]);
    expect(calls[0]!.args).toContain('--force');
    expect(calls[2]!.args).toEqual(['issue', 'edit', '7', '--title', expect.stringContaining('2.1.330'), '--body-file', '-']);
    expect(parseMarker(calls[2]!.stdin!)?.latest).toBe('2.1.330');
    expect(calls[3]!.stdin).toContain('2.1.330 is out now');
    expect(calls[6]!.args).toEqual(['issue', 'close', '11', '--comment', expect.stringContaining('3.0.75')]);
    expect(calls[7]!.args).toEqual([
      'issue',
      'create',
      '--title',
      expect.stringContaining('Pi 1.5.2'),
      '--label',
      ISSUE_LABEL,
      '--body-file',
      '-',
    ]);
    expect(calls[7]!.stdin).toContain('npx tsx scripts/cli-check.ts pi');
    expect(lines).toEqual([
      expect.stringMatching(/^Updated #7: /),
      expect.stringMatching(/^Updated #9: /),
      'Closed #11 (Cline)',
      expect.stringMatching(/^Opened an issue: Check Pi 1\.5\.2/),
    ]);
  });

  it('with --dry-run only reads the open issues, and says what it would have done', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return '[]';
    };
    expect(await keepIssues([behind('pi', '1.5.2')], true, gh)).toEqual([
      expect.stringMatching(/^Would have: Opened an issue: Check Pi 1\.5\.2/),
    ]);
    expect(calls).toEqual([['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title,body', '--limit', '200']]);
    expect(await keepIssues([row('cline', '3.0.74')], true, gh)).toEqual(['Issues: nothing to change.']);
  });

  it('updates without a comment when only its title and body change', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return args[1] === 'list' ? JSON.stringify([issue(7, 'claude', '2.1.330', '2.1.322')]) : '';
    };
    await keepIssues([row('claude', '2.1.330', '2.1.325')], false, gh);
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['label create', 'issue list', 'issue edit']);
  });

  it('runs daily on this repository only, reading versions and writing issues for real, and starts no CLI', () => {
    const wf = read('.github/workflows/cli-versions.yml');
    expect(wf).toMatch(/schedule:\s*\n\s*#.*\n\s*- cron: /);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toContain("if: github.repository == 'Agentic-System-Lab/harness-relay'");
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
    expect(wf).toMatch(/uses: actions\/checkout@v\d+\s*\n\s*with:\s*\n\s*persist-credentials: false/);
    // Exactly this: a --dry-run left in would keep no issue.
    expect(wf).toMatch(/run: npx tsx scripts\/cli-check\.ts versions --issues\s*$/m);
  });
});

describe('the command line (scripts/cli-check/args.ts)', () => {
  const ok = (argv: string[], platform: NodeJS.Platform = 'darwin') => {
    const r = parseArgs(argv, platform);
    if ('error' in r) throw new Error(r.error);
    return r;
  };
  const error = (argv: string[], platform: NodeJS.Platform = 'darwin') => {
    const r = parseArgs(argv, platform);
    return 'error' in r ? r.error : undefined;
  };

  it('records one version to compare another with, never saving either', () => {
    expect(ok(['pi', '--bin', '/a/pi', '--record', 'r.json'])).toMatchObject({ provider: 'pi', record: 'r.json' });
    expect(ok(['pi', '--bin', '/b/pi', '--against', 'r.json'])).toMatchObject({ against: 'r.json' });
    expect(ok(['run', 'pi', '--against', 'r.json'])).toMatchObject({ command: 'run', against: 'r.json' });
    expect(error(['pi', '--record', 'r.json', '--accept'])).toContain('never with --against or --record');
    expect(error(['pi', '--record', 'r.json', '--against', 'q.json'])).toContain('go apart');
    expect(error(['--record', 'r.json'])).toContain('--record goes with one CLI');
    expect(error(['changelog', 'pi', '--against', 'r.json'])).toContain('--against goes with one CLI');
  });

  it('reads the command, the CLI and the options', () => {
    expect(ok([])).toMatchObject({ command: 'all', accept: false, keep: false });
    expect(ok(['claude', '--bin', './x/claude', '--accept'])).toMatchObject({
      command: 'all',
      provider: 'claude',
      bin: './x/claude',
      accept: true,
    });
    expect(ok(['run', 'opencode', '--only', 'stop', '--keep'])).toMatchObject({
      command: 'run',
      provider: 'opencode',
      only: 'stop',
      keep: true,
    });
    expect(ok(['versions', '--issues', '--dry-run'])).toMatchObject({ command: 'versions', issues: true, dryRun: true });
    expect(ok(['changelog', 'copilot', '--from', '1.0.109', '--to', '1.0.113'])).toMatchObject({ from: '1.0.109', to: '1.0.113' });
  });

  it('refuses an option it does not know, so that a mistyped --dry-run never keeps the issues for real', () => {
    expect(error(['versions', '--issues', '--dryrun'])).toBe('Unknown option: --dryrun');
    expect(error(['versions', '--issues', '-n'])).toBe('Unknown option: -n');
    expect(error(['versions', '--dry-run'])).toBe('--dry-run goes with versions --issues.');
    expect(error(['probe', 'claude', '--issues'])).toBe('--issues goes with versions.');
  });

  it('refuses what cannot be run', () => {
    expect(error(['probe'])).toBe('probe needs a CLI.');
    expect(error(['nobody'])).toBe('Unknown CLI: nobody');
    expect(error(['claude', 'codex'])).toContain('One CLI at a time');
    expect(error(['--bin', '/x'])).toContain('name the CLI too');
    expect(error(['claude', '--bin'])).toBe('--bin needs a value.');
    expect(error(['run', 'claude'], 'win32')).toBe('Layers 2 and 3 run on macOS and Linux only.');
    expect(error(['versions'], 'win32')).toBeUndefined();
  });
});

describe('the shapes of what a CLI says (scripts/cli-check/shape.ts)', () => {
  it('reads JSON lines and Content-Length frames, and passes over text', () => {
    expect(messagesOf('{"a":1}\nnot json\n  {"b":2}\n[1]\n')).toEqual([{ a: 1 }, { b: 2 }]);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { é: 'ü' } });
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}Content-Length: 2\r\n\r\n{}`;
    expect(messagesOf(framed)).toEqual([JSON.parse(body), {}]);
  });

  it('keeps keys, value types and the words that say what a message is, never text', () => {
    const paths = [
      ...pathsOf({
        type: 'text',
        text: 'Hello there',
        n: 1,
        ok: true,
        none: null,
        list: [],
        obj: {},
        parts: [{ kind: 'edit' }],
        role: 'a long free text',
      }),
    ];
    expect(paths.sort()).toEqual(
      ['list:[]', 'n:number', 'none:null', 'obj:{}', 'ok:boolean', 'parts[].kind=edit', 'role:string', 'text:string', 'type=text'].sort(),
    );
  });

  it('keeps a map of names (sessions, files, models) as one key', () => {
    expect([...pathsOf({ models: { 'gpt-5/mini': { id: 1 }, 'claude@x': { id: 2 } } })]).toEqual(['models.*.id:number']);
    expect([...pathsOf({ permissions: { 'harness-relay-a910fda871b7f117': { extends: ':workspace' } } })]).toEqual([
      'permissions.*.extends:string',
    ]);
  });

  it('names an answer after the request it answers, from either side, and an ACP update after its kind', () => {
    const kinds = kindsOf([
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 1, result: {} } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 0, method: 'session/request_permission' } },
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 0, result: { outcome: {} } } },
      { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 2, method: 'session/load' } },
      { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 2, error: { code: -32000 } } },
    ]);
    expect(kinds).toEqual([
      'to-cli initialize',
      'from-cli initialize result',
      'from-cli session/update:agent_message_chunk',
      'from-cli session/request_permission',
      'to-cli session/request_permission result',
      'to-cli session/load',
      'from-cli session/load error',
    ]);
  });

  it("names Claude Code's control responses after the request they answer, and its messages by type and subtype", () => {
    const kinds = kindsOf([
      { dir: 'to-cli', msg: { type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } } },
      { dir: 'from-cli', msg: { type: 'system', subtype: 'init' } },
      { dir: 'from-cli', msg: { type: 'control_response', response: { subtype: 'success', request_id: 'r1' } } },
      { dir: 'from-cli', msg: { type: 'control_request', request_id: 'c1', request: { subtype: 'can_use_tool' } } },
      { dir: 'to-cli', msg: { type: 'control_response', response: { subtype: 'error', request_id: 'c1' } } },
    ]);
    expect(kinds).toEqual([
      'to-cli control_request:initialize',
      'from-cli system:init',
      'from-cli control_response:initialize',
      'from-cli control_request:can_use_tool',
      'to-cli control_response:can_use_tool:error',
    ]);
  });

  it('records processes through a recorder and gives their shape, a request before its answer', () => {
    const { recorder, spawned } = memoryRecorder();
    const r = recorder.start({ bin: 'cli', args: ['acp'] })!;
    // The answer arrives in stdout before the next request is written: streams are apart.
    r.data('stdout', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'));
    r.data('stdin', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'));
    r.exit(0, null);
    expect(spawned[0]).toMatchObject({ bin: 'cli', args: ['acp'], exit: { code: 0, signal: null } });
    expect(shapeOf(spawned).kinds).toEqual({
      'from-cli initialize result': ['id:number', 'jsonrpc:string', 'result.protocolVersion:number'],
      'to-cli initialize': ['id:number', 'jsonrpc:string', 'method=initialize', 'params:{}'],
    });
  });

  it('says what changed between two shapes, what is gone first', () => {
    const saved: Shape = { kinds: { 'from-cli a': ['x:string', 'y:number'], 'from-cli gone': ['z:string'] }, flags: ['--acp', '--model'] };
    const now: Shape = { kinds: { 'from-cli a': ['x:number', 'y:number'], 'from-cli new': ['w:string'] }, flags: ['--acp', '--yolo'] };
    const d = diffShapes(saved, now);
    expect(sameShape(d)).toBe(false);
    expect(describeDiff(d)).toEqual([
      '- flag --model (its help no longer lists it)',
      '- from-cli gone (not seen this time)',
      '- from-cli a: x:string',
      '+ from-cli new (new)',
      '+ from-cli a: x:number',
      '+ flag --yolo',
    ]);
    expect(sameShape(diffShapes(saved, saved))).toBe(true);
  });

  it('finds the flags a help lists and an argument list passes', () => {
    expect(flagsOf('Usage: cli [options]\n  -m, --model <name>  The model\n  --acp\n  [--resume=<id>] (--no-color)\n')).toEqual([
      '--acp',
      '--model',
      '--no-color',
      '--resume',
    ]);
    expect(flagsIn(['--acp', '--model', 'x', '--sandbox=on', 'prompt'])).toEqual(['--acp', '--model', '--sandbox']);
  });
});

describe('layer 3: the scripted model (scripts/cli-check/model.ts)', () => {
  let model: ScriptedModel | undefined;
  afterEach(async () => {
    await model?.close();
    model = undefined;
  });

  const bash = {
    name: 'Bash',
    schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
  };
  const post = (path: string, body: unknown) =>
    fetch(`${model!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = (sse: string) =>
    sse
      .split('\n\n')
      .map((b) =>
        b
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6),
      )
      .filter((d): d is string => !!d && d !== '[DONE]')
      .map((d) => JSON.parse(d));

  it("finds each CLI's shell tool, by its name or its command parameter", () => {
    const tools = [{ name: 'read', schema: { properties: { path: {} } } }, bash];
    expect(shellTool(tools)?.name).toBe('Bash');
    expect(shellTool([{ name: 'developer__shell', schema: { properties: { command: {} } } }])?.name).toBe('developer__shell');
    expect(shellTool([{ name: 'my_runner_exec', schema: { properties: { cmd: {} } } }])?.name).toBe('my_runner_exec');
    expect(shellTool([{ name: 'read', schema: { properties: { path: {} } } }])).toBeUndefined();
  });

  it("fills a shell tool's arguments from its schema: its command, and each other one it requires", () => {
    const tool = {
      name: 'execute_bash',
      schema: {
        properties: {
          command: { type: 'array' },
          security_risk: { type: 'string', enum: ['LOW', 'HIGH'] },
          is_input: { type: 'boolean' },
          timeout_ms: { type: 'integer' },
          workdir: { type: 'string' },
          optional: { type: 'string' },
        },
        required: ['command', 'security_risk', 'is_input', 'timeout_ms', 'workdir'],
      },
    };
    expect(shellArgs(tool, 'echo hi')).toEqual({
      command: ['bash', '-lc', 'echo hi'],
      security_risk: 'LOW',
      is_input: false,
      timeout_ms: 10_000,
      workdir: '.',
    });
    // Antigravity's: its command in `CommandLine`, and how long to wait before it goes to the background.
    const agy = {
      name: 'run_command',
      schema: {
        properties: { CommandLine: { type: 'string' }, WaitMsBeforeAsync: { type: 'integer', maximum: 5000 } },
        required: ['CommandLine', 'WaitMsBeforeAsync'],
      },
    };
    expect(shellTool([agy])?.name).toBe('run_command');
    expect(shellArgs(agy, 'ls')).toEqual({ CommandLine: 'ls', WaitMsBeforeAsync: 5000 });
  });

  it("reads a request's tools and earlier tool calls in each API", () => {
    expect(toolsOf('chat', { tools: [{ type: 'function', function: { name: 'shell', parameters: { a: 1 } } }] })).toEqual([
      { name: 'shell', schema: { a: 1 } },
    ]);
    expect(
      toolsOf('responses', {
        tools: [
          { type: 'function', name: 'exec_command', parameters: {} },
          { type: 'custom', name: 'apply_patch' },
        ],
      }),
    ).toEqual([{ name: 'exec_command', schema: {} }]);
    expect(
      toolsOf('gemini', { tools: [{ functionDeclarations: [{ name: 'run_shell_command', parametersJsonSchema: { b: 2 } }] }] }),
    ).toEqual([{ name: 'run_shell_command', schema: { b: 2 } }]);
    expect(callsOf('chat', { messages: [{ role: 'assistant', tool_calls: [{}] }, { role: 'tool' }] })).toBe(1);
    expect(callsOf('responses', { input: [{ type: 'function_call' }, { type: 'function_call_output' }] })).toBe(1);
    expect(callsOf('anthropic', { messages: [{ role: 'assistant', content: [{ type: 'tool_use' }] }] })).toBe(1);
    expect(callsOf('gemini', { contents: [{ parts: [{ functionCall: {} }] }] })).toBe(0 + 1);
  });

  it('answers from the scenario the last marker names: a call first, then a reply; a request without one gets a short reply', () => {
    const scenarios = { command: { command: 'echo hi' }, reply: {} };
    expect(scenarioOf(`${marker('reply', 'aaa')} then ${marker('command', 'bbb')}`)).toEqual({ name: 'command', nonce: 'bbb' });
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 0 }, [bash])).toEqual({
      call: { name: 'Bash', args: { command: 'echo hi' } },
    });
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 1 }, [bash]).text).toBe('cli-check command b done.');
    expect(decide(scenarios, { scenario: { name: 'command', nonce: 'b' }, calls: 0 }, []).text).toContain('no shell tool');
    expect(decide(scenarios, { calls: 0 }, [bash])).toEqual({ text: 'cli-check' });
  });

  it('speaks Chat Completions, streamed: the call, then the reply once the call has its result', async () => {
    model = await startModel({ command: { command: 'echo hi', thinking: true } });
    const tools = [
      { type: 'function', function: { name: 'shell', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } } },
    ];
    const first = events(
      await (
        await post('/v1/chat/completions', {
          model: 'm',
          stream: true,
          tools,
          messages: [{ role: 'user', content: marker('command', 'n1') }],
        })
      ).text(),
    );
    expect(first.map((e) => e.choices[0]?.delta).filter(Boolean)).toContainEqual({
      tool_calls: [{ index: 0, id: 'call_cli_check', type: 'function', function: { name: 'shell', arguments: '{"command":"echo hi"}' } }],
    });
    expect(first.find((e) => e.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(first.some((e) => e.choices[0]?.delta?.reasoning_content)).toBe(true);
    const second = events(
      await (
        await post('/v1/chat/completions', {
          stream: true,
          tools,
          messages: [
            { role: 'user', content: marker('command', 'n1') },
            { role: 'assistant', tool_calls: [{ id: 'c' }] },
            { role: 'tool', content: 'hi' },
          ],
        })
      ).text(),
    );
    expect(second.map((e) => e.choices[0]?.delta?.content ?? '').join('')).toBe('cli-check command n1 done.');
    expect(model.requests.map((r) => [r.api, r.calls, r.scenario?.nonce])).toEqual([
      ['chat', 0, 'n1'],
      ['chat', 1, 'n1'],
    ]);
  });

  it('speaks the Responses API and the Anthropic Messages API, streamed and not', async () => {
    model = await startModel({ command: { command: 'ls' } });
    const responses = events(
      await (
        await post('/v1/responses', {
          stream: true,
          tools: [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }],
          input: [{ role: 'user', content: [{ type: 'input_text', text: marker('command', 'r') }] }],
        })
      ).text(),
    );
    expect(responses[0].type).toBe('response.created');
    expect(responses.at(-1).type).toBe('response.completed');
    expect(responses.at(-1).response.output[0]).toMatchObject({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' });
    const anthropic = (await (
      await post('/v1/messages', {
        tools: [{ name: 'Bash', input_schema: bash.schema }],
        messages: [{ role: 'user', content: marker('command', 'a') }],
      })
    ).json()) as any;
    expect(anthropic).toMatchObject({
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
    });
    const streamed = events(
      await (await post('/v1/messages', { stream: true, messages: [{ role: 'user', content: 'title please' }] })).text(),
    );
    expect(streamed.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((await (await post('/v1/messages/count_tokens', {})).json()) as any).toEqual({ input_tokens: 12 });
  });

  it('speaks the Gemini API, serves the model lists and catalogs, and keeps what it does not serve', async () => {
    model = await startModel({ reply: {} });
    const gem = events(
      await (
        await post(`/v1beta/models/gemini-x:streamGenerateContent?alt=sse`, {
          contents: [{ role: 'user', parts: [{ text: marker('reply', 'g') }] }],
        })
      ).text(),
    );
    expect(gem.map((e) => e.candidates[0].content.parts.map((p: any) => p.text).join('')).join('')).toBe('cli-check reply g done.');
    expect(model.requests[0]).toMatchObject({ api: 'gemini', model: 'gemini-x', stream: true });
    expect(((await (await fetch(`${model.url}/v1/models`)).json()) as any).data[0].id).toBe('cli-check-model');
    expect(((await (await fetch(`${model.url}/muse-code/models`)).json()) as any).data[0].id).toBe(MUSE_MODEL);
    expect((await fetch(`${model.url}/api/hello`, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${model.url}/nothing`)).status).toBe(404);
    expect(model.unknown).toEqual(['GET /nothing']);
  });
});

describe("the report's last line", () => {
  it('says to move a newer version forward only when it is newer than the version checked', () => {
    const checked = CHECKED_VERSIONS.openhands;
    // The version checked, run against its own recording on this system (as CI runs a CLI that is current).
    const same = verdict('openhands', 0, checked, checked);
    expect(same).toContain(`found nothing new against ${checked}, run on this system`);
    expect(same).toContain('nothing to move forward');
    expect(same).not.toContain('cliVersions.ts');
    // Another build of the same numbers (Cursor's hash after its date) is checked as a new one, as layer 1 says.
    expect(verdict('cursor', 0, `${CHECKED_VERSIONS.cursor.split('-')[0]}-0000000`)).toContain('move it forward to');
    // A newer one is moved forward once its release notes are read and the live tests run.
    const newer = verdict('openhands', 0, '999.0.0');
    expect(newer).toContain(`found nothing new against ${checked}.`);
    expect(newer).toContain('move it forward to 999.0.0 in src/shared/cliVersions.ts');
    expect(verdict('openhands', 0, undefined)).toContain('move it forward to this version');
    // What a layer found comes first, whatever the version.
    expect(verdict('openhands', 2, checked)).toBe('OpenHands: 2 layer(s) found something to look at (above).');
  });
});

describe('layers 2 and 3: what they run', () => {
  it('asks every CLI for its help, and runs the scenarios on every CLI that can be put on a model of its own', () => {
    expect(Object.keys(HELP_ARGS).sort()).toEqual([...PROVIDERS].sort());
    expect(Object.keys(NO_RUN).sort()).toEqual(['cursor', 'grok']);
    expect(SCENARIOS.map((s) => s.name)).toEqual([
      'reply',
      'command',
      'read-only-write',
      'outside-write',
      'protected-read',
      'stop',
      'guard-write',
      'guard-write-full',
      'guard-tool-write',
    ]);
  });

  it('tells only Antigravity it is over SSH (Cursor refuses to start so where the keychain is out of reach)', () => {
    expect(cliEnv('antigravity', {}).SSH_CONNECTION).toBeTruthy();
    expect(cliEnv('cursor', {}).SSH_CONNECTION).toBeUndefined();
  });

  it("names the live tests' commands, with the cloud ones for the CLIs that have models of their own", () => {
    expect(liveCommands('opencode')).toHaveLength(1);
    expect(liveCommands('claude')[1]).toContain('E2E_LIVE_CLOUD=1');
  });
});

describe('layer 4: release notes (scripts/cli-check/changelog.ts)', () => {
  it('has a source, or says where they are, for every CLI', () => {
    expect(Object.keys(NOTES_SOURCES).sort()).toEqual([...PROVIDERS].sort());
  });

  it("reads a CHANGELOG.md's versions after the one checked, up to the new one, newest first", () => {
    const md = '# Changelog\n\n## [Unreleased]\n- later\n\n## [1.5.3] - x\n- three\n\n## [1.5.2] - x\n- two\n\n## [1.5.1] - x\n- one\n';
    expect(notesFromMarkdown(md, /^## \[(\d+\.\d+\.\d+)\]/, '1.5.1', '1.5.2')).toEqual([{ version: '1.5.2', lines: ['- two'] }]);
    expect(notesFromMarkdown(md, /^## \[(\d+\.\d+\.\d+)\]/, '1.5.1').map((n) => n.version)).toEqual(['1.5.3', '1.5.2']);
  });

  it("reads GitHub's releases, leaving prereleases and other tags out", () => {
    const releases = [
      { tag_name: 'rust-v0.170.0', body: 'a\nb' },
      { tag_name: 'rust-v0.170.0-alpha.4', body: 'x', prerelease: true },
      { tag_name: 'rust-v0.169.1', body: 'c' },
      { tag_name: 'rust-v0.167.0', body: 'old' },
      { tag_name: 'other-v9.0.0', body: 'no' },
    ];
    expect(notesFromReleases(releases, /^rust-v(\d+\.\d+\.\d+)$/, '0.167.0')).toEqual([
      { version: '0.170.0', lines: ['a', 'b'] },
      { version: '0.169.1', lines: ['c'] },
    ]);
  });

  it('reads the notes a CLI prints itself', () => {
    expect(notesFromText('1.5.10\n- new sandbox flag\n\n1.5.6\n- old\n', '1.5.6')).toEqual([
      { version: '1.5.10', lines: ['- new sandbox flag'] },
    ]);
  });

  it('picks out the lines about how it runs, those about permissions, sandboxes, hooks and flags first', () => {
    const { strong, weak } = pickLines([
      '### Fixed',
      '- Fixed the sandbox letting a command write outside',
      '- Added `--yolo`',
      '- Reads `COPILOT_HOME` now',
      '- Sessions resume faster',
      '- Nicer colours',
    ]);
    expect(strong).toEqual(['- Fixed the sandbox letting a command write outside', '- Added `--yolo`', '- Reads `COPILOT_HOME` now']);
    expect(weak).toEqual(['- Sessions resume faster']);
  });

  it('prints them for the versions since the one checked, and says where they are for a CLI that publishes none it can read', async () => {
    const url = 'https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md';
    const { f } = fakeFetch({ [url]: { body: '## [1.5.2] - x\n- Sessions now resume with `--fork`\n- Nicer\n## [1.5.1] - x\n- old\n' } });
    const lines = await releaseNotes('pi', '1.5.1', undefined, undefined, f);
    expect(lines[0]).toMatch(/^1\.5\.2: 1 lines about permissions.*0 about settings.*\(of 2\)$/);
    expect(lines[1]).toBe('  ! - Sessions now resume with `--fork`');
    expect(await releaseNotes('grok', '1.0.77', undefined, undefined, f)).toEqual([
      expect.stringMatching(/^release notes: no release notes are published/),
    ]);
  });
});

describe("layer 3: the scenarios' checks (scripts/cli-check/scenarios.ts)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ctx = (): Ctx => {
    const root = mkdtempSync(join(tmpdir(), 'cli-check-ctx-'));
    dirs.push(root);
    for (const d of ['work', 'outside', 'data']) mkdirSync(join(root, d));
    return {
      provider: 'claude',
      nonce: 'n0nce',
      scratch: { data: join(root, 'data') } as unknown as Ctx['scratch'],
      cli: { work: join(root, 'work'), outside: join(root, 'outside') },
      secret: 'RELAY-DB-SECRET',
      secretFile: join(root, 'data', 'relay.db'),
    };
  };
  const sc = (name: string) => SCENARIOS.find((s) => s.name === name)!;
  const call = (raw = '{}') => ({ ...request(raw), answered: { call: { name: 'Bash', args: {} } } });
  const request = (raw = '{}', tools = ['Bash']) => ({
    api: 'anthropic' as const,
    path: '/v1/messages',
    stream: true,
    raw,
    tools,
    calls: 0,
    answered: { text: 'done' } as { call?: { name: string; args: Record<string, unknown> }; text?: string },
  });
  const outcome = (o: Partial<Outcome>): Outcome => ({ events: [], approvals: [], requests: [], ms: 10, ...o });
  const failed = (checks: Check[]) => checks.filter((c) => c.ok === false).map((c) => c.what);

  it('fails read-only-write when the file it names was written, wherever its command writes it', () => {
    const c = ctx();
    const command = sc('read-only-write').command!(c);
    const file = command.replace(/^echo x > /, '');
    expect(file.startsWith(c.cli.work)).toBe(true);
    writeFileSync(file, 'x');
    expect(failed(sc('read-only-write').checks(outcome({ requests: [call(), request()] }), c))).toContain(
      'SECURITY: a write in read-only went through',
    );
  });

  it('passes read-only-write without a shell tool only when the CLI offered tools, and never for a turn that reached no model', () => {
    const c = ctx();
    const noShell = outcome({ requests: [request('{}', ['read', 'grep', 'ls'])] });
    expect(failed(sc('read-only-write').checks(noShell, c))).toEqual([]);
    expect(failed(sc('read-only-write').checks(outcome({}), c))).toEqual([expect.stringContaining('found no shell tool')]);
    expect(
      failed(sc('read-only-write').checks(outcome({ error: 'unknown flag --sandbox', requests: [request('{}', ['read'])] }), c)),
    ).toEqual([expect.stringContaining('the turn failed')]);
  });

  it("calls each CLI's own write tool with its own parameters, or none when it offers none", () => {
    const tool = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
      name,
      schema: { type: 'object', properties, required },
    });
    expect(writeCall([tool('Write', { file_path: {}, content: {} })], '/w/.env', 'x')?.args).toEqual({
      file_path: '/w/.env',
      content: 'x',
    });
    // An editor tool: its command that makes a file, and Cline's `new_text`.
    expect(
      writeCall([tool('file_editor', { command: { enum: ['view', 'create'] }, path: {}, file_text: {} })], '/w/.env', 'x')?.args,
    ).toEqual({ command: 'create', path: '/w/.env', file_text: 'x' });
    expect(writeCall([tool('editor', { path: {}, old_text: {}, new_text: {} }, ['path', 'new_text'])], '/w/.env', 'x')?.args).toEqual({
      path: '/w/.env',
      new_text: 'x',
    });
    expect(writeCall([tool('apply_patch', { input: {} })], '/w/.env', 'x')?.args).toEqual({
      input: '*** Begin Patch\n*** Add File: /w/.env\n+x\n*** End Patch\n',
    });
    expect(writeCall([tool('bash', { command: {} })], '/w/.env', 'x')).toBeUndefined();
    expect(guardsTool('copilot', 'full', 'darwin')).toBe(true);
    expect(guardsTool('antigravity', 'edit', 'linux')).toBe(true);
    expect(guardsTool('antigravity', 'full', 'linux')).toBe(false);
    expect(guardsTool('muse', 'edit', 'darwin')).toBe(false);
    expect(guardsTool('claude', 'read-only', 'darwin')).toBe(false);
  });

  it('says which CLIs refuse a write to the team’s protected paths before it, with which permission, on which system', () => {
    expect(guardsShell('claude', 'edit', 'linux')).toBe(true);
    expect(guardsShell('claude', 'full', 'darwin')).toBe(true);
    expect(guardsShell('claude', 'full', 'win32')).toBe(false);
    expect(guardsShell('goose', 'edit', 'darwin')).toBe(true);
    expect(guardsShell('goose', 'edit', 'linux')).toBe(false);
    expect(guardsShell('goose', 'full', 'darwin')).toBe(false);
    expect(guardsShell('codex', 'edit', 'darwin')).toBe(true);
    expect(guardsShell('codex', 'full', 'darwin')).toBe(false);
    expect(guardsShell('codex', 'edit', 'linux')).toBe(false);
    expect(guardsShell('copilot', 'edit', 'darwin')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    "guard-write gives the team's protected path to the run, fails a write a CLI says it refuses, warns for the others, and removes the file",
    () => {
      const c = ctx();
      expect(sc('guard-write').extra!(c)).toEqual({ guard: { dirs: [realpathSync(c.cli.work)], patterns: ['.env'] } });
      expect(sc('guard-write').command!(c)).toBe(`echo x > ${join(c.cli.work, '.env')}`);
      expect(failed(sc('guard-write').checks(outcome({ requests: [call()] }), c))).toEqual([]);
      writeFileSync(join(c.cli.work, '.env'), 'x');
      expect(failed(sc('guard-write-full').checks(outcome({ requests: [call()] }), c))).toEqual([
        "the team's protected path was written, though its adapter says it refuses that",
      ]);
      expect(existsSync(join(c.cli.work, '.env'))).toBe(false);
      const other = { ...ctx(), provider: 'copilot' as const };
      writeFileSync(join(other.cli.work, '.env'), 'x');
      const checks = sc('guard-write').checks(outcome({ requests: [call()] }), other);
      expect(failed(checks)).toEqual([]);
      expect(checks.find((x) => x.ok === 'warn')?.what).toContain('does not refuse it before');
    },
  );

  it('fails outside-write on a file outside the working directory, and says when its own refusal, not a sandbox, kept the command in', () => {
    const c = ctx();
    expect(sc('outside-write').command!(c)).toContain(c.cli.outside);
    writeFileSync(join(c.cli.outside, `cli-check-out-${c.nonce}.txt`), 'x');
    expect(failed(sc('outside-write').checks(outcome({ requests: [call()] }), c))).toEqual([
      'SECURITY: a write outside the working directory went through in edit',
    ]);
    const c2 = ctx();
    const asked = sc('outside-write').checks(outcome({ requests: [call()], approvals: [{ kind: 'command', detail: 'echo x' }] }), c2);
    expect(asked.find((x) => x.ok === 'warn')?.what).toContain('the check refused');
    expect(
      sc('outside-write')
        .checks(outcome({ requests: [call()] }), c2)
        .at(-1),
    ).toEqual({ ok: true, what: expect.stringContaining('without asking') });
  });

  it("fails protected-read when the stand-in database's contents reached the model in any request", () => {
    const c = ctx();
    expect(sc('protected-read').command!(c)).toBe(`cat ${c.secretFile}`);
    expect(
      failed(sc('protected-read').checks(outcome({ requests: [call(), request('{"content":"cat: Operation not permitted"}')] }), c)),
    ).toEqual([]);
    expect(failed(sc('protected-read').checks(outcome({ requests: [call(), request(`{"content":"${c.secret}"}`)] }), c))).toEqual([
      'SECURITY: a protected file’s contents reached the model',
    ]);
  });

  it('fails stop when the turn was not stopped, or the command it started is still running', () => {
    const c = ctx();
    expect(failed(sc('stop').checks(outcome({ requests: [call()], aborted: true, error: 'Stopped', leftover: 0 }), c))).toEqual([]);
    expect(failed(sc('stop').checks(outcome({ requests: [call()] }), c))).toEqual([expect.stringContaining('did not end the turn')]);
    expect(failed(sc('stop').checks(outcome({ requests: [call()], aborted: true, leftover: 1 }), c))).toEqual([
      expect.stringContaining('still running'),
    ]);
  });
});

describe('the scratch folders (scripts/cli-check/scratch.ts)', () => {
  it("keeps none of the developer's variables but those it names, with stand-ins of the database and key, and removes both folders", async () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-check-base-'));
    const home = mkdtempSync(join(tmpdir(), 'cli-check-home-'));
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.GITHUB_TOKEN = 'ghp_secret';
    process.env.CLAUDE_CONFIG_DIR = '/somewhere/of/mine';
    try {
      const s = makeScratch(false, base, join(base, 'work'), home);
      const own = Object.keys(s.env).filter((k) => !KEPT.includes(k));
      expect(own).not.toContain('GITHUB_TOKEN');
      expect(s.env.GITHUB_TOKEN).toBeUndefined();
      expect(s.env.CLAUDE_CONFIG_DIR).toBe(join(s.home, '.claude'));
      expect(s.env.HOME).toBe(s.home);
      expect(s.env.GIT_CEILING_DIRECTORIES).toBe(s.place);
      expect(readFileSync(join(s.data, 'relay.db'), 'utf8')).toBe('RELAY-DB-STAND-IN');
      expect(existsSync(s.root) && existsSync(s.place)).toBe(true);
      await s.dispose();
      expect(existsSync(s.root) || existsSync(s.place)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(base, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses working directories inside the home, where the CLIs would load its skills, but on Windows', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-check-home-'));
    try {
      expect(() => makeScratch(false, home, join(home, 'cache', 'check'), home, 'darwin')).toThrow(/inside your home folder/);
      const s = makeScratch(true, home, join(home, 'cache', 'check'), home, 'win32');
      expect(s.place.startsWith(realpathSync(home))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('layer 3: the scripted model, as each API says it', () => {
  let model: ScriptedModel | undefined;
  afterEach(async () => {
    await model?.close();
    model = undefined;
  });
  const post = (path: string, body: unknown) =>
    fetch(`${model!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** Server-sent events as they came: each one's event name and data. */
  const blocks = (sse: string) =>
    sse
      .split('\n\n')
      .filter(Boolean)
      .map((b) => ({
        event: b
          .split('\n')
          .find((l) => l.startsWith('event: '))
          ?.slice(7),
        data: b
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6),
      }));
  const shell = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };

  it('names each Responses API and Anthropic event as its data does, and ends Chat Completions with [DONE]', async () => {
    model = await startModel({ command: { command: 'ls', thinking: true } });
    const msg = marker('command', 'e');
    const responses = blocks(
      await (
        await post('/v1/responses', { stream: true, tools: [{ type: 'function', name: 'shell', parameters: shell }], input: msg })
      ).text(),
    );
    for (const b of responses) expect(JSON.parse(b.data!).type).toBe(b.event);
    const anthropic = blocks(
      await (
        await post('/v1/messages', {
          stream: true,
          thinking: { type: 'enabled' },
          tools: [{ name: 'Bash', input_schema: shell }],
          messages: [{ role: 'user', content: msg }],
        })
      ).text(),
    );
    for (const b of anthropic) expect(JSON.parse(b.data!).type).toBe(b.event);
    const deltas = anthropic
      .map((b) => JSON.parse(b.data!))
      .filter((d) => d.type === 'content_block_delta')
      .map((d) => d.delta);
    expect(deltas).toEqual([
      { type: 'thinking_delta', thinking: 'Thinking about e.' },
      { type: 'signature_delta', signature: 'cli-check-signature' },
      { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
    ]);
    expect(JSON.parse(anthropic.find((b) => b.event === 'message_delta')!.data!).delta.stop_reason).toBe('tool_use');
    const chat = blocks(
      await (await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'a title' }] })).text(),
    );
    expect(chat.at(-1)).toEqual({ event: undefined, data: '[DONE]' });
  });

  it('answers whole when asked not to stream: Chat Completions, the Responses API, the Gemini API', async () => {
    model = await startModel({ command: { command: 'ls' } });
    const msg = marker('command', 'w');
    const chat = (await (
      await post('/v1/chat/completions', {
        tools: [{ type: 'function', function: { name: 'shell', parameters: shell } }],
        messages: [{ role: 'user', content: msg }],
      })
    ).json()) as any;
    expect(chat.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { tool_calls: [{ function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
    });
    const resp = (await (
      await post('/v1/responses', { tools: [{ type: 'function', name: 'shell', parameters: shell }], input: msg })
    ).json()) as any;
    expect(resp).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'function_call', name: 'shell' }] });
    const gem = (await (
      await post('/v1beta/models/g:generateContent', {
        tools: [{ functionDeclarations: [{ name: 'run_shell_command', parameters: shell }] }],
        contents: [{ role: 'user', parts: [{ text: msg }] }],
      })
    ).json()) as any;
    expect(gem.candidates[0].content.parts).toEqual([{ functionCall: { name: 'run_shell_command', args: { command: 'ls' } } }]);
    // Streamed without alt=sse: one JSON array.
    const arr = (await (
      await post('/v1beta/models/g:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    ).json()) as any[];
    expect(Array.isArray(arr) && arr.at(-1).candidates[0].finishReason).toBe('STOP');
  });

  it("calls a tool in a Responses API namespace (Muse Code's) by its name, with its namespace", async () => {
    model = await startModel({ command: { command: 'ls' } });
    const tools = [
      {
        type: 'namespace',
        name: 'muse',
        tools: [
          { type: 'function', name: 'bash', parameters: shell },
          { type: 'function', name: 'read_file', parameters: {} },
        ],
      },
    ];
    expect(toolsOf('responses', { tools })).toEqual([
      { name: 'bash', schema: shell, namespace: 'muse' },
      { name: 'read_file', schema: {}, namespace: 'muse' },
    ]);
    const resp = (await (await post('/v1/responses', { tools, input: marker('command', 'm') })).json()) as any;
    expect(resp.output[0]).toMatchObject({ type: 'function_call', name: 'bash', namespace: 'muse', arguments: '{"command":"ls"}' });
  });

  it("keeps a number within the schema's range, either end", () => {
    const tool = (s: Record<string, unknown>) => ({
      name: 'shell',
      schema: { properties: { command: { type: 'string' }, n: { type: 'integer', ...s } }, required: ['command', 'n'] },
    });
    expect(shellArgs(tool({ minimum: 1 }), 'ls').n).toBe(1);
    expect(
      shellArgs(
        {
          name: 'shell',
          schema: { properties: { command: {}, delay_ms: { type: 'integer', minimum: 20000 } }, required: ['command', 'delay_ms'] },
        },
        'ls',
      ).delay_ms,
    ).toBe(20000);
    expect(shellArgs(tool({ maximum: 5 }), 'ls').n).toBe(0);
  });
});

describe('shapes: results and ids', () => {
  it('compares what the server made of the answers too: a fact that changed, one that is new or gone', () => {
    const saved: Shape = { kinds: {}, results: { status: ['fact:version=read'], usage: ['fact:none=-'] } };
    const now: Shape = { kinds: {}, results: { status: ['fact:version=none'], models: ['fact:models=some'] } };
    const d = diffShapes(saved, now);
    expect(d.changed).toEqual([{ kind: 'result status', added: ['fact:version=none'], removed: ['fact:version=read'] }]);
    expect(d.newKinds).toEqual(['result models']);
    expect(d.goneKinds).toEqual(['result usage']);
  });

  it('pairs answers with their requests by side when both sides use the same id', () => {
    expect(
      kindsOf([
        { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 0, method: 'initialize' } },
        { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 0, method: 'session/request_permission' } },
        { dir: 'from-cli', msg: { jsonrpc: '2.0', id: 0, result: {} } },
        { dir: 'to-cli', msg: { jsonrpc: '2.0', id: 0, result: {} } },
      ]),
    ).toEqual([
      'to-cli initialize',
      'from-cli session/request_permission',
      'from-cli initialize result',
      'to-cli session/request_permission result',
    ]);
  });

  it('keeps a character split between two chunks whole, as Content-Length frames count bytes', () => {
    const { recorder, spawned } = memoryRecorder();
    const r = recorder.start({ bin: 'cli', args: [] })!;
    const bytes = Buffer.from('{"text":"é"}\n');
    r.data('stdout', bytes.subarray(0, 10));
    r.data('stdout', bytes.subarray(10));
    r.exit(0, null);
    expect(messagesOf(spawned[0]!.stdout)).toEqual([{ text: 'é' }]);
  });
});

describe('layer 4 and 5: where their answers come from', () => {
  it("reads GitHub's releases with the token, and says why notes could not be read", async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return url.includes('aaif-goose')
        ? new Response(JSON.stringify([{ tag_name: 'v1.60.1', body: '- New `--resume` flag\n- Faster' }]))
        : new Response('down', { status: 502 });
    };
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'tok';
    try {
      const lines = await releaseNotes('goose', '1.58.1', undefined, undefined, f);
      expect(lines[0]).toMatch(/^1\.60\.1: 1 lines/);
      expect(asked[0]).toMatchObject({
        url: 'https://api.github.com/repos/aaif-goose/goose/releases?per_page=100',
        headers: { authorization: 'Bearer tok' },
      });
      expect(await releaseNotes('codex', '0.167.0', undefined, undefined, f)).toEqual([expect.stringContaining('HTTP 502')]);
      expect(await releaseNotes('antigravity', '1.5.6')).toEqual(['release notes: give the new CLI with --bin to read them']);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  it('says why a version could not be read: an answer without one, a fetch that failed', async () => {
    expect(await fetchLatest('cline', async () => new Response('{}'))).toEqual({
      error: expect.stringContaining('no version in the answer'),
    });
    expect(
      await fetchLatest('cline', async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    ).toEqual({ error: expect.stringContaining('ENOTFOUND') });
  });

  it('names the live tests only for the CLIs they run, as e2e/live/live.ts lists them', () => {
    const live = read('e2e/live/live.ts');
    const list = (name: string) =>
      JSON.parse(`[${new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(live)![1]!.replace(/'/g, '"')}]`);
    expect([...LIVE_ENDPOINT_CLIS].sort()).toEqual([...list('ENDPOINT_CLIS'), ...list('OPEN')].sort());
    expect([...LIVE_CLOUD_CLIS].sort()).toEqual([...list('CLOUD_CLIS')].sort());
    expect(liveCommands('cursor')).toEqual([expect.stringContaining('E2E_LIVE_CLOUD=1')]);
    expect(liveCommands('opencode')).toEqual([expect.stringContaining('E2E_LIVE_OLLAMA')]);
  });
});

describe('getting a version apart (scripts/cli-check/obtain.ts)', () => {
  it("names where each CLI's version is for each system, from its maker", () => {
    expect(artifactFor('claude', '2.1.327', 'linux', 'x64')).toEqual({
      kind: 'npm',
      spec: '@anthropic-ai/claude-code@2.1.327',
      bin: 'node_modules/@anthropic-ai/claude-code-linux-x64/claude',
    });
    expect(artifactFor('copilot', '1.0.113', 'darwin', 'arm64')).toMatchObject({
      bin: 'node_modules/@github/copilot-darwin-arm64/copilot',
    });
    expect(artifactFor('opencode', '1.19.6', 'linux', 'x64')).toMatchObject({ bin: 'node_modules/opencode-linux-x64/bin/opencode' });
    expect(artifactFor('codex', '0.170.0', 'linux', 'x64')).toMatchObject({ bin: 'node_modules/.bin/codex' });
    expect(artifactFor('openhands', '1.16.0', 'linux', 'x64')).toEqual({
      kind: 'uv',
      spec: 'openhands==1.16.0',
      command: 'openhands',
      python: '3.12',
    });
    expect(artifactFor('cline', '3.0.74', 'linux', 'x64')).toMatchObject({ bin: 'node_modules/@cline/cli-linux-x64/bin/cline' });
    expect(artifactFor('goose', '1.60.1', 'linux', 'x64')).toMatchObject({
      url: 'https://github.com/aaif-goose/goose/releases/download/v1.60.1/goose-x86_64-unknown-linux-gnu.tar.bz2',
    });
    expect(artifactFor('goose', '1.60.1', 'darwin', 'arm64')).toMatchObject({
      url: expect.stringContaining('goose-aarch64-apple-darwin.tar.bz2'),
    });
    expect(artifactFor('grok', '1.0.89', 'linux', 'x64')).toMatchObject({
      url: 'https://x.ai/cli/grok-1.0.89-linux-x86_64.gz',
      format: 'gz',
    });
    expect(artifactFor('grok', '1.0.89', 'darwin', 'arm64')).toMatchObject({ url: 'https://x.ai/cli/grok-1.0.89-macos-aarch64.gz' });
    expect(artifactFor('cursor', '2026.11.17-f532c45', 'linux', 'x64')).toMatchObject({
      url: 'https://downloads.cursor.com/lab/2026.11.17-f532c45/linux/x64/agent-cli-package.tar.gz',
      strip: 1,
    });
    expect(artifactFor('muse', '1.4.18', 'linux', 'x64')).toEqual({ kind: 'manifest', provider: 'muse', version: '1.4.18' });
    for (const p of PROVIDERS) expect(() => artifactFor(p, CHECKED_VERSIONS[p], 'linux', 'x64')).not.toThrow();
  });

  it('runs on macOS and Linux, x64 and arm64 only', () => {
    expect(thisSystem('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(() => thisSystem('win32', 'x64')).toThrow('macOS and Linux only');
    expect(() => thisSystem('linux', 'ia32')).toThrow('x64 and arm64 only');
  });

  it("reads Antigravity's manifest, which names only the newest, and Muse Code's by its build", async () => {
    const answers: Record<string, unknown> = {
      'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json': {
        version: '1.5.10',
        url: 'https://g/agy.tgz',
        sha512: 'AB',
      },
      'https://api.meta.ai/muse-code/channels/muse-stable': { version: '1.4.23-R8977.1' },
      'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.23-R8977.1&file=manifest.json': {
        artifacts: { x86_linux: { url: 'https://m/new', checksum: 'c1' } },
      },
      'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.18-R8587.1&file=manifest.json': {
        artifacts: { x86_linux: { url: 'https://m/old', checksum: 'c0' } },
      },
    };
    const f = async (url: string) => (url in answers ? new Response(JSON.stringify(answers[url])) : new Response('no', { status: 404 }));
    expect(await manifestDownload({ kind: 'manifest', provider: 'antigravity', version: '1.5.10' }, 'linux', 'x64', f)).toEqual({
      url: 'https://g/agy.tgz',
      hash: 'sha512',
      checksum: 'AB',
      format: 'tar.gz',
      bin: 'antigravity',
    });
    await expect(manifestDownload({ kind: 'manifest', provider: 'antigravity', version: '1.5.6' }, 'linux', 'x64', f)).rejects.toThrow(
      'names only the newest, 1.5.10',
    );
    expect(await manifestDownload({ kind: 'manifest', provider: 'muse', version: '1.4.23' }, 'linux', 'x64', f)).toMatchObject({
      url: 'https://m/new',
      hash: 'sha256',
    });
    expect(MUSE_BUILDS['1.4.18']).toBe('1.4.18-R8587.1');
    expect(await manifestDownload({ kind: 'manifest', provider: 'muse', version: '1.4.18' }, 'linux', 'x64', f)).toMatchObject({
      url: 'https://m/old',
      checksum: 'c0',
    });
    await expect(manifestDownload({ kind: 'manifest', provider: 'muse', version: '1.4.20' }, 'linux', 'x64', f)).rejects.toThrow(
      'full build is not known',
    );
    // Every version checked can be had, but Antigravity's (NO_SHAPES says why).
    expect(MUSE_BUILDS[CHECKED_VERSIONS.muse]).toBeDefined();
  });

  it("refuses a download whose checksum is not its manifest's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-check-obtain-'));
    try {
      const f = async (url: string) =>
        url.includes('manifests')
          ? new Response(JSON.stringify({ version: '1.5.10', url: 'https://g/agy.tgz', sha512: '00' }))
          : new Response('not the archive');
      await expect(obtain('antigravity', '1.5.10', dir, { os: 'linux', arch: 'x64' }, f)).rejects.toThrow(
        'its sha512 is not the one its manifest names',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the workflow's checks (scripts/cli-check/ci.ts)", () => {
  const row = (p: Provider, latest: string): VersionRow => ({
    provider: p,
    checked: CHECKED_VERSIONS[p],
    latest,
    status: versionStatus(p, CHECKED_VERSIONS[p], latest),
  });
  const withComments = (n: number, p: Provider, latest: string, comments: string[] = []) => ({
    number: n,
    title: issueTitle(row(p, latest)),
    body: issueBody(row(p, latest)),
    comments: comments.map((body) => ({ body })),
  });

  it("checks each CLI that is behind once its issue is open, until its issue holds that version's report", () => {
    const rows = [row('claude', '2.1.327'), row('cline', CHECKED_VERSIONS.cline), row('pi', '1.5.2'), row('codex', '0.170.0')];
    const issues = [
      withComments(1, 'claude', '2.1.327'),
      withComments(2, 'pi', '1.5.2', [`old\n${reportMarker('pi', '1.5.2')}`]),
      // Codex's issue tells of an older version: its newest has no report yet.
      withComments(3, 'codex', '0.169.0', [reportMarker('codex', '0.169.0')]),
    ];
    expect(ciMatrix(rows, issues)).toEqual([
      { cli: 'claude', version: '2.1.327' },
      { cli: 'codex', version: '0.170.0' },
    ]);
    // A CLI with no open issue (its source fails, say) is not checked: there is nowhere to report.
    expect(ciMatrix([row('grok', '1.0.89')], [])).toEqual([]);
    // On a pull request: every CLI's newest, behind or not.
    expect(
      ciMatrix(
        [row('claude', '2.1.327'), row('cline', CHECKED_VERSIONS.cline), { provider: 'muse', checked: '1.4.18', status: 'unknown' }],
        'pull_request',
      ),
    ).toEqual([
      { cli: 'claude', version: '2.1.327' },
      { cli: 'cline', version: CHECKED_VERSIONS.cline },
    ]);
  });

  const report = (o: Partial<Report> = {}): Report => ({
    cli: 'codex',
    version: '0.170.0',
    checked: '0.167.0',
    against: true,
    exit: 0,
    text: '== 2. Codex\n  same shape\n- #60848 Enable tool declarations @akira-oai\n```js\nx\n```\n\u001b[31mred\u001b[0m',
    system: 'Linux (x64)',
    ...o,
  });

  it('posts a report in a fence nothing in it can end, so that its @names notify nobody, with its marker', () => {
    const c = reportComment(report());
    expect(c.startsWith('### Codex 0.170.0, checked on Linux (x64)')).toBe(true);
    expect(c).toContain('against 0.167.0, which it ran there too');
    expect(c).toContain('found nothing new');
    expect(c).toContain('````text\n== 2. Codex');
    expect(c).toContain('@akira-oai\n```js');
    expect(c).not.toContain('\u001b[');
    expect(c.trimEnd().endsWith(reportMarker('codex', '0.170.0'))).toBe(true);
    expect(fenced('a ````` b')).toMatch(/^``````text\n/);
    expect(reportComment(report({ exit: 1 }))).toContain('found something to look at');
    expect(reportComment(report({ error: 'HTTP 404', exit: undefined, text: '' }))).toContain('could not be checked: HTTP 404');
    expect(reportComment(report({ against: false, againstError: 'cannot be had' }))).toContain(
      'recorded on another system (0.167.0 could not be compared with here: cannot be had)',
    );
    expect(reportComment(report({ text: 'x'.repeat(70_000) })).length).toBeLessThan(65_536);
  });

  it("posts each report to its CLI's open issue once", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const issues = [withComments(9, 'codex', '0.170.0'), withComments(7, 'claude', '2.1.327', [reportMarker('claude', '2.1.327')])];
    const gh = async (args: string[], stdin?: string) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      return args[1] === 'list' ? JSON.stringify(issues) : '';
    };
    const lines = await postReports([report(), report({ cli: 'claude', version: '2.1.327' }), report({ cli: 'pi', version: '1.5.2' })], gh);
    expect(lines).toEqual([
      'Codex 0.170.0: reported in #9',
      'Claude Code 2.1.327: already reported in #7',
      'Pi 1.5.2: no open issue to report to',
    ]);
    expect(calls.map((c) => c.args.slice(0, 3).join(' '))).toEqual(['issue list --label', 'issue comment 9']);
    expect(calls[1]!.stdin).toContain(reportMarker('codex', '0.170.0'));
  });

  it('runs what it downloads with a token that reads only, and posts from another job', () => {
    const wf = read('.github/workflows/cli-versions.yml');
    const jobs = jobsIn(wf);
    expect([...jobs.keys()]).toEqual(['versions', 'newest', 'check', 'report']);
    expect(jobs.get('check')).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*strategy:/);
    expect(jobs.get('check')).not.toMatch(/issues: write|GH_TOKEN|GITHUB_TOKEN|secrets\./);
    expect(jobs.get('newest')).not.toMatch(/issues: write/);
    expect(jobs.get('report')).toMatch(/issues: write/);
    expect(jobs.get('report')).toMatch(/needs\.versions\.result == 'success'/);
    expect(jobs.get('check')).toContain('run: npx tsx scripts/cli-check/ci.ts check "$CLI" "$VERSION"');
    expect(wf).toMatch(/^permissions: \{\}$/m);
    for (const [name, text] of jobs) expect(text, name).toMatch(/persist-credentials: false/);
  });
});
