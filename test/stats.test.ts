import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTALLERS, REPO, UPDATE_INSTALLERS, UPDATES_REPO } from '../site/assets/downloads.js';
import {
  COUNTS_DATABASE,
  REQUESTS_PER_INSTALL,
  REQUESTS_PER_UPDATE,
  SYSTEMS,
  WRANGLER,
  WRANGLER_CONFIG,
  codespacesOf,
  collect,
  countsQuery,
  downloadsOf,
  estimate,
  lastDays,
  main,
  report,
  systemOf,
  wranglerCommand,
  wranglerReason,
  type Release,
  type Sources,
} from '../scripts/stats.ts';

// npm run stats (scripts/stats.ts): the releases' downloads by system, new installs apart from the app's
// updates, GitHub's counts and about how many downloads they are, and the codespaces count, from stand-ins
// for gh and wrangler that answer as they do (wrangler's failures as recorded, test/fixtures/stats/).

type Sys = keyof typeof INSTALLERS;
const installer = (tag: string, system: Sys) => `Harness-Relay-${tag}${INSTALLERS[system]}`;
const copy = (tag: string, system: Sys) => `Harness-Relay-${tag}${UPDATE_INSTALLERS[system]}`;
/** A release with one asset per system, `n(system)` downloads each. */
function release(tag: string, name: (tag: string, s: Sys) => string, n: (s: Sys) => number, more: Partial<Release> = {}): Release {
  return { tag, prerelease: false, draft: false, assets: SYSTEMS.map((s) => ({ name: name(tag, s), downloads: n(s) })), ...more };
}
const each = (v: number) => () => v;
const all = <T>(v: T) => Object.fromEntries(SYSTEMS.map((s) => [s, v])) as Record<Sys, T>;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/stats/${name}`, import.meta.url), 'utf8');

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
    // 2026-11-11's Mac installer was a universal one: a Mac's, under its name then.
    expect(systemOf('Harness-Relay-2026-11-11-mac-universal.dmg', '2026-11-11', INSTALLERS)).toBe('mac');
    expect(systemOf('Harness-Relay-2026-11-11-mac-universal.dmg', '2026-11-11', UPDATE_INSTALLERS)).toBeUndefined();
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
      // Two systems only, the Mac's under its name then, and no copies yet.
      {
        tag: '2026-11-11',
        prerelease: false,
        draft: false,
        assets: [
          { name: 'Harness-Relay-2026-11-11-mac-universal.dmg', downloads: 5 },
          { name: installer('2026-11-11', 'win'), downloads: 2 },
        ],
      },
      // Left out: a release candidate, one GitHub does not mark as a pre-release, a draft, a tag that is no version.
      release('2026-11-14-rc', installer, each(100), { prerelease: true }),
      release('2026-11-13.2-rc.1', installer, each(100)),
      release('2026-11-15', installer, each(100), { draft: true }),
      release('v1.0.0', (_t, s) => installer('v1.0.0', s), each(100)),
    ];
    const copies: Release[] = [
      release('2026-11-14', copy, (s) => (s === 'win' ? 5 : 0)),
      release('2026-11-13.2', copy, each(1)),
      // A release candidate's copies and a draft's: not counted, nor does a draft hide the published copies.
      release('2026-11-14-rc', copy, each(100), { prerelease: true }),
      release('2026-11-13.10', copy, each(100), { draft: true }),
      { tag: '2026-11-13.2', prerelease: false, draft: true, assets: [] },
    ];
    const d = downloadsOf(releases, copies);
    expect(d.repo).toBe(REPO);
    expect(d.updatesRepo).toBe(UPDATES_REPO);
    expect(d.updatesError).toBeUndefined();
    expect(d.releases.map((r) => r.tag)).toEqual(['2026-11-14', '2026-11-13.10', '2026-11-13.2', '2026-11-11']);
    const [r14, r1310, r132, r11] = d.releases;
    expect(r14!.installs).toEqual(all(3));
    expect(r14!.updates).toEqual({ ...all(0), win: 5 });
    // No copies published (a draft's do not count): none, where it has installers.
    expect(r1310!.updates).toEqual(all(0));
    expect(r132!.installs).toEqual({ ...all(1), mac: 4 });
    expect(r132!.updates).toEqual(all(1));
    // No file for a system: none, not 0.
    expect(r11!.installs).toEqual({ ...all(null), mac: 5, win: 2 });
    expect(r11!.updates).toEqual({ ...all(null), mac: 0, win: 0 });
    expect(d.installs).toEqual({ mac: 14, win: 8, 'win-arm64': 6, linux: 6, 'linux-arm64': 6 });
    expect(d.updates).toEqual({ ...all(1), win: 6 });
    // About how many downloads: the new installs' counts halved and rounded, the updates' as they are,
    // each system's and all systems' (from GitHub's own, 40 and 10).
    expect(d.estimate.installs).toEqual({ mac: 7, win: 4, 'win-arm64': 3, linux: 3, 'linux-arm64': 3 });
    expect(d.estimate.updates).toEqual({ ...all(1), win: 6 });
    expect(d.estimate.all).toEqual({ installs: 20, updates: 10 });
    // A file of no system it knows is shown apart, not dropped silently.
    expect(d.other).toEqual([{ tag: '2026-11-14', name: 'Harness-Relay-2026-11-14-mac-arm64.dmg.blockmap', downloads: 50 }]);
  });

  it('takes a new install as two requests GitHub counts and an update as one, as measured', () => {
    expect(REQUESTS_PER_INSTALL).toBe(2);
    expect(REQUESTS_PER_UPDATE).toBe(1);
    expect([0, 1, 2, 3, 102].map((n) => estimate(n, REQUESTS_PER_INSTALL))).toEqual([0, 1, 1, 2, 51]);
    expect([0, 1, 28].map((n) => estimate(n, REQUESTS_PER_UPDATE))).toEqual([0, 1, 28]);
  });

  it('keeps the new installs when the copies cannot be read, the updates unknown', () => {
    const d = downloadsOf([release('2026-11-14', installer, each(3))], undefined, REPO, 'someone/copies', 'someone/copies was not found');
    expect(d.updatesError).toBe('someone/copies was not found');
    expect(d.releases[0]!.installs).toEqual(all(3));
    expect(d.releases[0]!.updates).toEqual(all(null));
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

  it("says why wrangler failed, from what it really prints, without the account's id", () => {
    // D1's own message is in the notes; the text names the API address, the account's id in it.
    const table = Object.assign(new Error('Command failed'), { stdout: fixture('wrangler-no-such-table.out'), stderr: '' });
    expect(wranglerReason(table)).toBe('no such table: codespaces: SQLITE_ERROR [code: 7500]');
    const noNotes = { stdout: JSON.stringify({ error: { text: 'A request to the Cloudflare API (/accounts/0ceab7/d1/database/d4a1/query) failed.' } }) };
    expect(wranglerReason(noNotes)).toBe('A request to the Cloudflare API (/accounts/…/d1/database/…/query) failed.');
    expect(wranglerReason({ stdout: fixture('wrangler-not-signed-in.out') })).toMatch(/^In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN/);
    // No JSON: its last lines.
    expect(wranglerReason({ stderr: 'npm error\nnpm error code E404\nnpm error 404 Not Found - wrangler' })).toBe('npm error code E404 npm error 404 Not Found - wrangler');
  });
});

/** Stand-ins for gh and wrangler, answering as they do, noting their arguments. */
function sources(
  o: { variable?: string | Error; releases?: Release[]; copies?: Release[]; gh?: Error; copiesError?: Error; wrangler?: string | Error } = {},
) {
  const calls: { gh: string[][]; wrangler: string[][] } = { gh: [], wrangler: [] };
  const lines = (rs: Release[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const s: Sources = {
    gh: async (args) => {
      calls.gh.push(args);
      if (args[0] === 'variable') {
        if (o.variable instanceof Error || o.variable === undefined) throw o.variable ?? Object.assign(new Error('failed'), { stderr: 'variable UPDATES_REPO was not found' });
        return `${o.variable}\n`;
      }
      const main = args[1]!.startsWith(`repos/${REPO}/`);
      if (main && o.gh) throw o.gh;
      if (!main && o.copiesError) throw o.copiesError;
      return lines(main ? (o.releases ?? []) : (o.copies ?? []));
    },
    wrangler: async (args) => {
      calls.wrangler.push(args);
      if (o.wrangler instanceof Error) throw o.wrangler;
      return o.wrangler ?? JSON.stringify([{ results: [{ total: 4 }], success: true }, { results: [{ day: '2026-11-15', created: 4 }], success: true }]);
    },
  };
  return { s, calls };
}
const failure = (stderr: string, stdout = '') => Object.assign(new Error('Command failed'), { stderr, stdout });

// 2026-11-14 16:30 UTC is already 2026-11-15 in Taiwan.
const NOW = new Date('2026-11-14T16:30:00Z');
const JQ = '.[] | {tag: .tag_name, prerelease, draft, assets: [.assets[] | {name, downloads: .download_count}]}';

describe('npm run stats: reading and reporting', () => {
  it('reads both repositories through gh, every page, and the count through wrangler, today in Taiwan', async () => {
    const { s, calls } = sources({ releases: [release('2026-11-14', installer, each(2))], copies: [release('2026-11-14', copy, each(1))] });
    const stats = await collect(s, NOW);
    expect(calls.gh).toEqual(
      expect.arrayContaining([
        ['variable', 'get', 'UPDATES_REPO', '--repo', REPO],
        ['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--jq', JQ],
        ['api', `repos/${UPDATES_REPO}/releases?per_page=100`, '--paginate', '--jq', JQ],
      ]),
    );
    expect(calls.gh).toHaveLength(3);
    expect(calls.wrangler).toEqual([['d1', 'execute', COUNTS_DATABASE, '--remote', '--config', WRANGLER_CONFIG, '--json', '--command', countsQuery('2026-11-09')]]);
    expect(stats.downloads).toMatchObject({ updatesRepo: UPDATES_REPO, installs: { mac: 2 }, updates: { mac: 1 } });
    expect(stats.codespaces).toEqual({ total: 4, days: lastDays('2026-11-15').map((day) => ({ day, created: day === '2026-11-15' ? 4 : 0 })) });
  });

  it("reads the copies where the workflow's UPDATES_REPO variable says, checked as the build checks it", async () => {
    const { s, calls } = sources({ variable: 'someone/copies' });
    expect((await collect(s, NOW)).downloads).toMatchObject({ updatesRepo: 'someone/copies' });
    expect(calls.gh.some((a) => a[1] === 'repos/someone/copies/releases?per_page=100')).toBe(true);
    // Not a repository of copies (this one, say): the website's, and it says so.
    const main = (await collect(sources({ variable: REPO }).s, NOW)).downloads;
    expect(main).toMatchObject({ updatesRepo: UPDATES_REPO });
    expect('error' in main ? '' : main.updatesError).toMatch(/^RELAY_UPDATES_REPO: the copies go in a repository of their own/);
    // Not readable (not only not set): the website's, and it says so.
    const denied = (await collect(sources({ variable: failure('HTTP 403: Resource not accessible by integration') }).s, NOW)).downloads;
    expect('error' in denied ? '' : denied.updatesError).toBe(`could not read the workflow's UPDATES_REPO variable (HTTP 403: Resource not accessible by integration); read ${UPDATES_REPO}`);
  });

  it('says why a part cannot be read, and shows the rest', async () => {
    const signedOut = failure('To get started with GitHub CLI, please run:  gh auth login');
    const stats = await collect(sources({ gh: signedOut }).s, NOW);
    expect(stats.downloads).toEqual({ error: `could not read ${REPO} through gh (To get started with GitHub CLI, please run:  gh auth login). Sign gh in: gh auth login` });
    expect(stats.codespaces).toMatchObject({ total: 4 });
    // The copies' repository alone: the new installs still shown, without telling to sign in.
    const copies = (await collect(sources({ releases: [release('2026-11-14', installer, each(2))], copiesError: failure('gh: Not Found (HTTP 404)') }).s, NOW)).downloads;
    expect(copies).toMatchObject({ installs: { mac: 2 }, updatesError: `${UPDATES_REPO} was not found, or gh's account cannot read it (gh: Not Found (HTTP 404))` });
    const offline = (await collect(sources({ gh: failure('error connecting to api.github.com') }).s, NOW)).downloads;
    expect(offline).toEqual({ error: `could not read ${REPO} through gh (error connecting to api.github.com)` });
    // wrangler signed out, as it really says it.
    const c = (await collect(sources({ wrangler: failure('', fixture('wrangler-not-signed-in.out')) }).s, NOW)).codespaces;
    expect('error' in c ? c.error : '').toMatch(/^could not read the count through wrangler \(In a non-interactive environment, .*\)\. Sign wrangler in to the account with the mirror: npx wrangler login$/);
    // No codespace counted yet: the table is made at the first count. As wrangler really says it.
    const none = (await collect(sources({ wrangler: failure('', fixture('wrangler-no-such-table.out')) }).s, NOW)).codespaces;
    expect(none).toEqual({ total: 0, days: lastDays('2026-11-15').map((day) => ({ day, created: 0 })) });
  });

  it('reports about how many downloads, GitHub’s counts, each release, each day, and how to read them', async () => {
    const { s } = sources({
      releases: [
        release('2026-11-14', installer, (sys) => (sys === 'linux' ? 12 : 3)),
        { tag: '2026-11-13', prerelease: false, draft: false, assets: [{ name: installer('2026-11-13', 'mac'), downloads: 1 }, { name: 'notes.txt', downloads: 7 }] },
      ],
      copies: [release('2026-11-14', copy, each(2))],
    });
    const text = report(await collect(s, NOW));
    expect(text).toContain(`  New installs: the installers on ${REPO}.\n  Updates: the app's copies on ${UPDATES_REPO}, an installed app updating.`);
    // About how many downloads: the new installs halved, the updates as they are.
    expect(text).toMatch(/^ {2}About how many downloads +New installs +Updates +Total$/m);
    // All systems' halved from GitHub's own (25 → 13), not added up from halved ones (2 + 2 + 2 + 6 + 2 = 14).
    expect(text).toMatch(/^ {2}macOS +≈ 2 +≈ 2 +≈ 4$/m);
    expect(text).toMatch(/^ {2}Linux x64 +≈ 6 +≈ 2 +≈ 8$/m);
    expect(text).toMatch(/^ {2}All systems +≈ 13 +≈ 10 +≈ 23$/m);
    // GitHub's own.
    expect(text).toMatch(/^ {2}macOS +4 +2 +6$/m);
    expect(text).toMatch(/^ {2}All systems +25 +10 +35$/m);
    expect(text).toMatch(/^ {2}Release +macOS +Win x64 +Win Arm64 +Linux x64 +Linux Arm64 +All$/m);
    expect(text).toMatch(/^ {2}2026-11-14 +3 \/ 2 +3 \/ 2 +3 \/ 2 +12 \/ 2 +3 \/ 2 +24 \/ 10$/m);
    // No file for a system: —.
    expect(text).toMatch(/^ {2}2026-11-13 +1 \/ 0 +— \/ — +— \/ — +— \/ — +— \/ — +1 \/ 0$/m);
    expect(text.search(/^ {2}2026-11-14 /m)).toBeLessThan(text.search(/^ {2}2026-11-13 /m));
    expect(text).toContain('  Not counted, files of no system it knows');
    expect(text).toContain('    2026-11-13  notes.txt  7');
    expect(text).toContain('  In all: 4');
    expect(text).toMatch(/^ {4}2026-11-09 +0$/m);
    expect(text).toMatch(/^ {4}2026-11-15 \(today\) +4$/m);
    expect(text).toContain('So "about how many downloads" is the new installs halved and\nthe updates as they are.');
    expect(text).toContain("an installed app's update,\nasked for through GitHub's API, is one.");
    expect(text).toContain('or one\nwhose read token stopped working) updates from the installer');
    expect(text).toContain('See docs/developer-guide.md, "Download counts".');
    // Updates unknown: said, and ? in their place.
    const unknown = report(await collect(sources({ releases: [release('2026-11-14', installer, each(2))], copiesError: failure('gh: Not Found (HTTP 404)') }).s, NOW));
    expect(unknown).toContain(`  ✗ Updates unknown: ${UPDATES_REPO} was not found`);
    expect(unknown).toMatch(/^ {2}macOS +2 +\? +\?$/m);
    expect(unknown).toMatch(/^ {2}2026-11-14 +2 \/ \? /m);
    // A part that cannot be read says why, the other is still shown.
    const failed = report({ downloads: { error: 'could not read x through gh (y)' }, codespaces: { total: 0, days: [] } });
    expect(failed).toContain('  ✗ could not read x through gh (y)');
    expect(failed).toContain('  In all: 0');
  });

  it('prints the report, or JSON, and says by its exit code when a part could not be read', async () => {
    let out = '';
    const write = (t: string) => void (out += t);
    expect(await main([], sources().s, NOW, write)).toBe(0);
    expect(out).toContain('Downloads of the releases (release candidates left out)');
    out = '';
    expect(await main(['--json'], sources().s, NOW, write)).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ downloads: { repo: REPO, releases: [], estimate: { installs: all(0) } }, codespaces: { total: 4 } });
    // Each part failing alone: 1.
    expect(await main([], sources({ gh: failure('offline') }).s, NOW, write)).toBe(1);
    expect(await main([], sources({ copiesError: failure('gh: Not Found (HTTP 404)') }).s, NOW, write)).toBe(1);
    expect(await main([], sources({ wrangler: failure('', fixture('wrangler-not-signed-in.out')) }).s, NOW, write)).toBe(1);
    // The table not made yet is no failure.
    expect(await main([], sources({ wrangler: failure('', fixture('wrangler-no-such-table.out')) }).s, NOW, write)).toBe(0);
    expect(await main(['--csv'], sources().s, NOW, write)).toBe(2);
  });

  it('starts wrangler through the npm that runs it, directly, and is run by npm run stats', () => {
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
