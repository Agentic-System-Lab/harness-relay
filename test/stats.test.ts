import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTALLERS, REPO, UPDATE_INSTALLERS, UPDATES_REPO } from '../site/assets/downloads.js';
import {
  COUNTS_DATABASE,
  SYSTEMS,
  WRANGLER,
  WRANGLER_CONFIG,
  codespacesOf,
  collect,
  countsQuery,
  downloadsOf,
  lastDays,
  main,
  report,
  systemOf,
  wranglerCommand,
  type Release,
  type Sources,
} from '../scripts/stats.ts';

// npm run stats (scripts/stats.ts): the releases' downloads by system, new installs apart from the app's
// updates, and the codespaces count, from stand-ins for gh and wrangler that answer as they do.

const installer = (tag: string, system: keyof typeof INSTALLERS) => `Harness-Relay-${tag}${INSTALLERS[system]}`;
const copy = (tag: string, system: keyof typeof INSTALLERS) => `Harness-Relay-${tag}${UPDATE_INSTALLERS[system]}`;
/** A release with one asset per system, `n(system)` downloads each, and `extra` other files. */
function release(tag: string, name: (tag: string, s: keyof typeof INSTALLERS) => string, n: (s: keyof typeof INSTALLERS) => number, more: Partial<Release> = {}): Release {
  return { tag, prerelease: false, draft: false, assets: SYSTEMS.map((s) => ({ name: name(tag, s), downloads: n(s) })), ...more };
}
const each = (v: number) => () => v;

describe('npm run stats: the downloads', () => {
  it('tells an installer from its copy for the app’s updates, by its whole name, for its own release only', () => {
    for (const s of SYSTEMS) {
      expect(systemOf(installer('2026-11-14', s), '2026-11-14', INSTALLERS), s).toBe(s);
      expect(systemOf(copy('2026-11-14', s), '2026-11-14', UPDATE_INSTALLERS), s).toBe(s);
      // A copy is no installer, nor an installer a copy.
      expect(systemOf(copy('2026-11-14', s), '2026-11-14', INSTALLERS), s).toBeUndefined();
      expect(systemOf(installer('2026-11-14', s), '2026-11-14', UPDATE_INSTALLERS), s).toBeUndefined();
      // Another release's, its release candidate's included.
      expect(systemOf(installer('2026-11-14-rc', s), '2026-11-14', INSTALLERS), s).toBeUndefined();
      expect(systemOf(installer('2026-11-13', s), '2026-11-14', INSTALLERS), s).toBeUndefined();
    }
    for (const other of ['Harness-Relay-2026-11-14-mac-arm64.dmg.blockmap', 'latest-mac.yml', 'Source code (zip)']) {
      expect(systemOf(other, '2026-11-14', INSTALLERS), other).toBeUndefined();
    }
  });

  it('counts each release’s installers as new installs and its copies as updates, by system, releases only, newest first', () => {
    const releases: Release[] = [
      release('2026-11-13.2', installer, (s) => (s === 'mac' ? 4 : 1)),
      // .10 after .9 and .2: by version, not by the order GitHub lists them in.
      release('2026-11-13.10', installer, each(2)),
      release('2026-11-14', installer, each(3), {
        assets: [...release('2026-11-14', installer, each(3)).assets, { name: 'Harness-Relay-2026-11-14-mac-arm64.dmg.blockmap', downloads: 50 }],
      }),
      // Left out: a release candidate, one GitHub does not mark as a pre-release, a draft, a tag that is no version.
      release('2026-11-14-rc', installer, each(100), { prerelease: true }),
      release('2026-11-13.2-rc.1', installer, each(100)),
      release('2026-11-15', installer, each(100), { draft: true }),
      release('v1.0.0', (_t, s) => installer('v1.0.0', s), each(100)),
    ];
    const copies: Release[] = [
      release('2026-11-14', copy, (s) => (s === 'win' ? 5 : 0)),
      release('2026-11-13.2', copy, each(1)),
      // A release candidate's copies, a draft's, and another release's copy in its release: not counted.
      release('2026-11-14-rc', copy, each(100), { prerelease: true }),
      release('2026-11-13.10', copy, each(100), { draft: true }),
      { tag: '2026-11-13.2', prerelease: false, draft: true, assets: [] },
    ];
    // A draft of the same tag in the copies' repository does not hide the published copies.
    const d = downloadsOf(releases, copies);
    expect(d.repo).toBe(REPO);
    expect(d.updatesRepo).toBe(UPDATES_REPO);
    expect(d.releases.map((r) => r.tag)).toEqual(['2026-11-14', '2026-11-13.10', '2026-11-13.2']);
    const [r14, r1310, r132] = d.releases;
    expect(r14!.installs).toEqual({ mac: 3, win: 3, 'win-arm64': 3, linux: 3, 'linux-arm64': 3 });
    expect(r14!.updates).toEqual({ mac: 0, win: 5, 'win-arm64': 0, linux: 0, 'linux-arm64': 0 });
    // No copies (a draft's are not counted).
    expect(r1310!.updates).toEqual({ mac: 0, win: 0, 'win-arm64': 0, linux: 0, 'linux-arm64': 0 });
    expect(r132!.installs.mac).toBe(4);
    expect(r132!.updates).toEqual({ mac: 1, win: 1, 'win-arm64': 1, linux: 1, 'linux-arm64': 1 });
    expect(d.installs).toEqual({ mac: 9, win: 6, 'win-arm64': 6, linux: 6, 'linux-arm64': 6 });
    expect(d.updates).toEqual({ mac: 1, win: 6, 'win-arm64': 1, linux: 1, 'linux-arm64': 1 });
  });
});

describe('npm run stats: the codespaces count', () => {
  it('shows the last seven days in Taiwan, oldest first, across months and years', () => {
    expect(lastDays('2026-11-14')).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(lastDays('2027-01-03')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(lastDays('2028-03-01', 2)).toEqual(['2028-02-29', '2028-03-01']);
  });

  it('asks D1 for the total and the days since the first, with a day only', () => {
    expect(countsQuery('2026-11-08')).toBe(
      "SELECT COALESCE(SUM(created), 0) AS total FROM codespaces; SELECT day, created FROM codespaces WHERE day >= '2026-11-08' ORDER BY day",
    );
    expect(() => countsQuery("2026-11-08'; DROP TABLE codespaces; --")).toThrow();
  });

  it("reads wrangler's answer, a day without a row as 0", () => {
    const days = lastDays('2026-11-14');
    const answer = (total: number, rows: { day: string; created: number }[]) =>
      JSON.stringify([
        { results: [{ total }], success: true, meta: {} },
        { results: rows, success: true, meta: {} },
      ]);
    const c = codespacesOf(answer(9, [{ day: '2026-11-10', created: 2 }, { day: '2026-11-14', created: 3 }]), days);
    expect(c.total).toBe(9);
    expect(c.days).toEqual(days.map((day) => ({ day, created: day === '2026-11-10' ? 2 : day === '2026-11-14' ? 3 : 0 })));
    // What wrangler may print before its JSON is passed over.
    expect(codespacesOf(`Cloudflare collects anonymous telemetry\n${answer(0, [])}`, days).total).toBe(0);
    expect(() => codespacesOf(JSON.stringify([{ results: [], success: false }]), days)).toThrow(/two results/);
  });
});

/** Stand-ins for gh and wrangler, answering as they do, noting their arguments. */
function sources(o: { variable?: string | Error; releases?: Release[]; copies?: Release[]; gh?: Error; wrangler?: string | Error } = {}) {
  const calls: { gh: string[][]; wrangler: string[][] } = { gh: [], wrangler: [] };
  const lines = (rs: Release[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const s: Sources = {
    gh: async (args) => {
      calls.gh.push(args);
      if (args[0] === 'variable') {
        if (o.variable instanceof Error || o.variable === undefined) throw o.variable ?? Object.assign(new Error('failed'), { stderr: 'variable UPDATES_REPO was not found' });
        return `${o.variable}\n`;
      }
      if (o.gh) throw o.gh;
      return lines(args[1]!.startsWith(`repos/${REPO}/`) ? (o.releases ?? []) : (o.copies ?? []));
    },
    wrangler: async (args) => {
      calls.wrangler.push(args);
      if (o.wrangler instanceof Error) throw o.wrangler;
      return o.wrangler ?? JSON.stringify([{ results: [{ total: 4 }], success: true }, { results: [{ day: '2026-11-15', created: 4 }], success: true }]);
    },
  };
  return { s, calls };
}

// 2026-11-14 16:30 UTC is already 2026-11-15 in Taiwan.
const NOW = new Date('2026-11-14T16:30:00Z');

describe('npm run stats: reading and reporting', () => {
  it('reads both repositories through gh, every page, and the count through wrangler, today in Taiwan', async () => {
    const { s, calls } = sources({ releases: [release('2026-11-14', installer, each(2))], copies: [release('2026-11-14', copy, each(1))] });
    const stats = await collect(s, NOW);
    expect(calls.gh).toEqual([
      ['variable', 'get', 'UPDATES_REPO', '--repo', REPO],
      ['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--jq', '.[] | {tag: .tag_name, prerelease, draft, assets: [.assets[] | {name, downloads: .download_count}]}'],
      ['api', `repos/${UPDATES_REPO}/releases?per_page=100`, '--paginate', '--jq', '.[] | {tag: .tag_name, prerelease, draft, assets: [.assets[] | {name, downloads: .download_count}]}'],
    ]);
    expect(calls.wrangler).toEqual([['d1', 'execute', COUNTS_DATABASE, '--remote', '--config', WRANGLER_CONFIG, '--json', '--command', countsQuery('2026-11-09')]]);
    expect(stats.downloads).toMatchObject({ updatesRepo: UPDATES_REPO, installs: { mac: 2 }, updates: { mac: 1 } });
    expect(stats.codespaces).toEqual({ total: 4, days: lastDays('2026-11-15').map((day) => ({ day, created: day === '2026-11-15' ? 4 : 0 })) });
  });

  it("reads the copies where the workflow's UPDATES_REPO variable says, when it says", async () => {
    const { s, calls } = sources({ variable: 'someone/copies' });
    const stats = await collect(s, NOW);
    expect(calls.gh[2]![1]).toBe('repos/someone/copies/releases?per_page=100');
    expect(stats.downloads).toMatchObject({ updatesRepo: 'someone/copies' });
    // Not a repository's name: the website's.
    expect((await collect(sources({ variable: 'not a repo' }).s, NOW)).downloads).toMatchObject({ updatesRepo: UPDATES_REPO });
  });

  it('says why a part cannot be read, and shows the other', async () => {
    const gh = Object.assign(new Error('Command failed: gh api'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' });
    const stats = await collect(sources({ gh }).s, NOW);
    expect(stats.downloads).toEqual({ error: 'could not read the releases through gh (To get started with GitHub CLI, please run:  gh auth login). Sign gh in: gh auth login' });
    expect(stats.codespaces).toMatchObject({ total: 4 });
    const wrangler = Object.assign(new Error('Command failed'), { stderr: 'You are not authenticated. Please run `wrangler login`.' });
    const c = (await collect(sources({ wrangler }).s, NOW)).codespaces;
    expect(c).toEqual({ error: 'could not read the count through wrangler (You are not authenticated. Please run `wrangler login`.). Sign wrangler in to the account with the mirror: npx wrangler login' });
    // No codespace counted yet: the table is made at the first count.
    const none = Object.assign(new Error('Command failed'), { stdout: '{"error":{"text":"no such table: codespaces: SQLITE_ERROR"}}' });
    expect((await collect(sources({ wrangler: none }).s, NOW)).codespaces).toEqual({ total: 0, days: lastDays('2026-11-15').map((day) => ({ day, created: 0 })) });
  });

  it('reports the totals by system, each release, and each day, and what the counts mean', async () => {
    const { s } = sources({
      releases: [release('2026-11-14', installer, (sys) => (sys === 'linux' ? 12 : 3)), release('2026-11-13', installer, each(1))],
      copies: [release('2026-11-14', copy, each(2))],
    });
    const text = report(await collect(s, NOW));
    expect(text).toContain(`New installs: the installers on ${REPO}. Updates: the app's copies on ${UPDATES_REPO}, an installed app updating.`);
    expect(text).toMatch(/^ {2}macOS \(Apple Silicon\) +4 +2 +6$/m);
    expect(text).toMatch(/^ {2}Linux x64 +13 +2 +15$/m);
    expect(text).toMatch(/^ {2}All systems +29 +10 +39$/m);
    expect(text).toMatch(/^ {2}Release +macOS +Win x64 +Win Arm64 +Linux x64 +Linux Arm64 +All$/m);
    expect(text).toMatch(/^ {2}2026-11-14 +3 \/ 2 +3 \/ 2 +3 \/ 2 +12 \/ 2 +3 \/ 2 +24 \/ 10$/m);
    expect(text).toMatch(/^ {2}2026-11-13 +1 \/ 0 +1 \/ 0 +1 \/ 0 +1 \/ 0 +1 \/ 0 +5 \/ 0$/m);
    // Newest first.
    expect(text.search(/^ {2}2026-11-14 /m)).toBeLessThan(text.search(/^ {2}2026-11-13 /m));
    expect(text).toContain('  In all: 4');
    expect(text).toMatch(/^ {4}2026-11-09 +0$/m);
    expect(text).toMatch(/^ {4}2026-11-15 \(today\) +4$/m);
    expect(text).toContain('a browser\'s download from GitHub was seen to count as 2');
    expect(text).toContain('See docs/developer-guide.md, "Download counts".');
    // A part that cannot be read says why, the other is still shown.
    const failed = report({ downloads: { error: 'could not read the releases through gh (x)' }, codespaces: { total: 0, days: [] } });
    expect(failed).toContain('  ✗ could not read the releases through gh (x)');
    expect(failed).toContain('  In all: 0');
  });

  it('prints the report, or JSON, and says by its exit code when a part could not be read', async () => {
    let out = '';
    const write = (t: string) => void (out += t);
    expect(await main([], sources().s, NOW, write)).toBe(0);
    expect(out).toContain('Downloads of the releases, as GitHub counts them (release candidates left out)');
    out = '';
    expect(await main(['--json'], sources().s, NOW, write)).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ downloads: { repo: REPO, releases: [] }, codespaces: { total: 4 } });
    out = '';
    expect(await main([], sources({ gh: new Error('offline') }).s, NOW, write)).toBe(1);
    expect(out).toContain('✗ could not read the releases through gh (offline)');
    expect(await main(['--csv'], sources().s, NOW, write)).toBe(2);
  });

  it('runs wrangler through the npm that runs it, without a shell, and is run by npm run stats', () => {
    expect(wranglerCommand(['d1', 'list'], '/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/bin/node')).toEqual([
      '/usr/bin/node',
      ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'exec', '--yes', `--package=${WRANGLER}`, '--', 'wrangler', 'd1', 'list'],
    ]);
    // Without npm (or with another package manager): npx.
    expect(wranglerCommand(['d1', 'list'], '')).toEqual(['npx', ['--yes', WRANGLER, 'd1', 'list']]);
    expect(wranglerCommand(['d1', 'list'], '/usr/lib/node_modules/pnpm/bin/pnpm.cjs')[0]).toBe('npx');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.stats).toBe('tsx scripts/stats.ts');
    // The database the mirror is deployed with.
    expect(readFileSync(WRANGLER_CONFIG, 'utf8')).toContain(`database_name = "${COUNTS_DATABASE}"`);
  });
});
