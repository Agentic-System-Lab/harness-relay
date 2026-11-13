import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { UPDATES_REPO } from '../site/assets/downloads.js';
import {
  appImageDownload,
  appImageTarget,
  busyWithoutAsking,
  chatUpdate,
  CHECK_EVERY_MS,
  CHECK_TIMEOUT_MS,
  checkLatest,
  checkNow,
  copyToDownload,
  DOWNLOAD_CONNECTIONS,
  DOWNLOAD_STALL_MS,
  download,
  downloadHeaders,
  installPlan,
  isNewer,
  LATEST_RELEASE_API,
  macAppOf,
  macStaging,
  MIN_PART_BYTES,
  mayAskGitHub,
  takesCandidates,
  MIN_CHECK_GAP_MS,
  newestRelease,
  oneAtATime,
  parseRelease,
  PART_FAILURES,
  placeAppImage,
  RELAUNCH_PID,
  RELAUNCH_TARGET,
  relaunchCommand,
  relaunchEnv,
  RELEASES_API,
  removeAppImageLeftovers,
  removeMacLeftovers,
  stageMacApp,
  swapMacApp,
  UpdateError,
  updateSystem,
  whenIdle,
  WINDOWS_INSTALLER_ARGS,
  type Fetch,
  type Locate,
  type UpdateAsset,
} from '../desktop/src/update';
import { copiesReadable, DEFAULT_UPDATE_SOURCE, updateSourceFrom, type CopiesFetch, type UpdateSource } from '../desktop/src/updateSource';
import { spawnDetached } from '../src/server/process';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-update-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posixIt = process.platform === 'win32' ? it.skip : it;
const macIt = process.platform === 'darwin' ? it : it.skip;

const DOWNLOAD = 'https://github.com/Agentic-System-Lab/harness-relay/releases/download';
/** Where the Release workflow publishes the copies for the app's updates (UPDATES_REPO). */
const COPIES = 'https://github.com/Agentic-System-Lab/harness-relay-updates/releases/download';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Where an app built as the Release workflow builds it downloads its updates from (UPDATES_REPO, no token). */
const SOURCE = DEFAULT_UPDATE_SOURCE;
/** A token as a build may name one (RELAY_UPDATES_TOKEN), for a private copies' repository. */
const TOKEN = `github_pat_${'A1b2'.repeat(10)}`;
/** A private copies' repository, read with TOKEN. */
const PRIVATE: UpdateSource = { repo: 'acme/relay-updates', token: TOKEN };
const parse = (json: unknown) => parseRelease(json, SOURCE);
const newest = (json: unknown, candidates?: boolean) => newestRelease(json, SOURCE, candidates);

/** A release as GitHub lists it (GET /repos/…/releases). */
function githubRelease(tag: string, o: { prerelease?: boolean; draft?: boolean; digest?: boolean; copies?: boolean } = {}) {
  const asset = (end: string) => {
    const name = `Harness-Relay-${tag}${end}`;
    return { name, browser_download_url: `${DOWNLOAD}/${tag}/${name}`, size: 1000, ...(o.digest === false ? {} : { digest: `sha256:${sha(name)}` }) };
  };
  return {
    tag_name: tag,
    draft: o.draft ?? false,
    prerelease: o.prerelease ?? tag.includes('-rc'),
    html_url: `https://github.com/Agentic-System-Lab/harness-relay/releases/tag/${tag}`,
    assets: [
      asset('-mac-arm64.dmg'),
      asset('-win-x64.exe'),
      asset('-win-arm64.exe'),
      asset('-linux-x86_64.AppImage'),
      asset('-linux-arm64.AppImage'),
      // The same installers again for the app's updates, in the release itself, as in 2026-11-12-rc.
      ...(o.copies ? ['-mac-arm64-update.dmg', '-win-x64-update.exe', '-win-arm64-update.exe', '-linux-x86_64-update.AppImage', '-linux-arm64-update.AppImage'].map(asset) : []),
      { name: 'notes.txt', browser_download_url: `${DOWNLOAD}/${tag}/notes.txt` },
    ],
  };
}

describe('where the app downloads its updates from', () => {
  it('is UPDATES_REPO without a token, unless the build names another repository, or a token for a private one', () => {
    expect(DEFAULT_UPDATE_SOURCE).toEqual({ repo: 'Agentic-System-Lab/harness-relay-updates' });
    expect(updateSourceFrom({})).toEqual({ ok: true, value: DEFAULT_UPDATE_SOURCE });
    expect(updateSourceFrom({ RELAY_UPDATES_REPO: ' ', RELAY_UPDATES_TOKEN: '' })).toEqual({ ok: true, value: DEFAULT_UPDATE_SOURCE });
    expect(updateSourceFrom({ RELAY_UPDATES_REPO: ' acme/relay-updates ' })).toEqual({ ok: true, value: { repo: 'acme/relay-updates' } });
    expect(updateSourceFrom({ RELAY_UPDATES_REPO: 'acme-co/relay_updates.v2', RELAY_UPDATES_TOKEN: ` ${TOKEN}\n` })).toEqual({
      ok: true,
      value: { repo: 'acme-co/relay_updates.v2', token: TOKEN },
    });
    expect(updateSourceFrom({ RELAY_UPDATES_TOKEN: TOKEN })).toEqual({ ok: true, value: { repo: UPDATES_REPO, token: TOKEN } });
  });

  it('refuses a repository that is not owner/name, and a token that is not one, never saying the token', () => {
    for (const repo of ['acme', 'acme/', '/u', 'acme/u/x', 'https://github.com/acme/u', 'acme/u.git', 'acme/..', 'acme/.', '-acme/u', 'acme-/u', 'ac--me/u', 'acme/u?x', 'a b/u', 'acme/u#x']) {
      const r = updateSourceFrom({ RELAY_UPDATES_REPO: repo });
      expect(r.ok, repo).toBe(false);
      expect(!r.ok && r.error, repo).toMatch(/^RELAY_UPDATES_REPO: /);
    }
    for (const token of ['short', `${TOKEN}\r\nX-Other: 1`, `Bearer ${TOKEN}`, `${TOKEN}é`, `${TOKEN} ${TOKEN}`, 'github_pat_', `github_pat_${'a'.repeat(19)}`]) {
      const r = updateSourceFrom({ RELAY_UPDATES_TOKEN: token });
      expect(r.ok, token).toBe(false);
      expect(!r.ok && r.error).toMatch(/^RELAY_UPDATES_TOKEN: /);
      expect(!r.ok && r.error).not.toContain(TOKEN);
    }
  });

  it('takes a fine-grained token only: any other kind cannot be kept to one repository, and it goes into every copy of the app', () => {
    for (const token of [`ghp_${'a'.repeat(36)}`, `gho_${'a'.repeat(36)}`, `ghs_${'a'.repeat(36)}`, `ghu_${'a'.repeat(36)}`, 'a'.repeat(40)]) {
      const r = updateSourceFrom({ RELAY_UPDATES_TOKEN: token });
      expect(r.ok, token).toBe(false);
      expect(!r.ok && r.error).toMatch(/^RELAY_UPDATES_TOKEN: not a fine-grained personal access token \(github_pat_…\)/);
      expect(!r.ok && r.error).not.toContain(token);
    }
    expect(updateSourceFrom({ RELAY_UPDATES_TOKEN: `github_pat_11ABC_${'x9'.repeat(40)}` }).ok).toBe(true);
  });

  it('refuses this repository for the copies, in any letter case: its releases hold the installers alone', () => {
    for (const repo of ['Agentic-System-Lab/harness-relay', 'agentic-system-lab/HARNESS-RELAY']) {
      const r = updateSourceFrom({ RELAY_UPDATES_REPO: repo });
      expect(r.ok, repo).toBe(false);
      expect(!r.ok && r.error).toMatch(/^RELAY_UPDATES_REPO: the copies go in a repository of their own/);
    }
    expect(updateSourceFrom({ RELAY_UPDATES_REPO: 'Agentic-System-Lab/harness-relay-updates' }).ok).toBe(true);
  });

  it("is built into the app's main process alone, never into the server's bundle, which agents' runs come near", () => {
    const build = readFileSync(join(__dirname, '../desktop/scripts/build.ts'), 'utf8');
    const bundles = build.split('await build({').slice(1);
    const withSource = bundles.filter((b) => b.includes('__RELAY_UPDATE_SOURCE__'));
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    expect(withSource).toHaveLength(1);
    expect(withSource[0]).toContain("outfile: join(OUT, 'app/main.cjs')");
    expect(build).toContain('__RELAY_UPDATE_SOURCE__: JSON.stringify(updates.value)');
    expect(build).toContain('const updates = updateSourceFrom(process.env);');
  });

  it('downloads with the token, asking for the file itself, only from a private repository', () => {
    expect(downloadHeaders(SOURCE)).toBeUndefined();
    expect(downloadHeaders(PRIVATE)).toEqual({ Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${TOKEN}` });
  });
});

describe('the Release workflow’s check that an app can download the copies', () => {
  const copies = ['Harness-Relay-2026-11-13-mac-arm64-update.dmg', 'Harness-Relay-2026-11-13-win-x64-update.exe'];
  const WORKFLOW = 'ghs_the-workflow-token';
  /** GitHub's API, answering with `answer`, which says where it was asked and with what. */
  function api(answer: () => Response | Promise<Response>) {
    const asked: { url: string; init: Parameters<CopiesFetch>[1] }[] = [];
    const fetch: CopiesFetch = async (url, init) => {
      asked.push({ url, init });
      return answer();
    };
    return { asked, fetch };
  }
  const listing = (assets: unknown[]) => () => new Response(JSON.stringify({ tag_name: '2026-11-13', assets }));
  const both = listing([
    { id: 41, name: copies[0] },
    { id: 42, name: copies[1] },
    { id: 43, name: 'notes.txt' },
  ]);

  it('asks for the release as the app asks: with the read token for a private repository, else with the workflow’s own', async () => {
    const own = api(both);
    expect(await copiesReadable(own.fetch, { source: PRIVATE, tag: '2026-11-13', copies, token: WORKFLOW })).toBeUndefined();
    expect(own.asked).toEqual([
      {
        url: 'https://api.github.com/repos/acme/relay-updates/releases/tags/2026-11-13',
        init: { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${TOKEN}` }, redirect: 'error' },
      },
    ]);
    const open = api(both);
    expect(await copiesReadable(open.fetch, { source: SOURCE, tag: '2026-11-13', copies, token: WORKFLOW })).toBeUndefined();
    expect(open.asked[0]!.url).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay-updates/releases/tags/2026-11-13');
    expect(open.asked[0]!.init.headers.Authorization).toBe(`Bearer ${WORKFLOW}`);
    const anonymous = api(both);
    await copiesReadable(anonymous.fetch, { source: SOURCE, tag: '2026-11-13', copies });
    expect(anonymous.asked[0]!.init.headers.Authorization).toBeUndefined();
  });

  it('says why when the token cannot read the release, a private repository has none, or a copy is not listed, never naming a token', async () => {
    const refused = (status: number) => () => new Response('{"message":"no"}', { status });
    for (const status of [401, 403, 404]) {
      const error = await copiesReadable(api(refused(status)).fetch, { source: PRIVATE, tag: '2026-11-13', copies, token: WORKFLOW });
      expect(error, String(status)).toMatch(new RegExp(`^The app's token \\(UPDATES_READ_TOKEN\\) cannot read the release 2026-11-13 in acme/relay-updates \\(GitHub answered ${status}\\)`));
      expect(error).not.toContain(TOKEN);
      expect(error).not.toContain(WORKFLOW);
    }
    expect(await copiesReadable(api(refused(403)).fetch, { source: PRIVATE, tag: '2026-11-13', copies })).toMatch(/limit on requests/);
    expect(await copiesReadable(api(refused(404)).fetch, { source: PRIVATE, tag: '2026-11-13', copies })).not.toMatch(/limit on requests/);
    const unset = await copiesReadable(api(refused(404)).fetch, { source: { repo: 'acme/relay-updates' }, tag: '2026-11-13', copies, token: WORKFLOW });
    expect(unset).toMatch(/cannot be read without a token of its own \(GitHub answered 404\): for a private repository, set the UPDATES_READ_TOKEN secret/);
    expect(await copiesReadable(api(listing([{ id: 41, name: copies[0] }])).fetch, { source: PRIVATE, tag: '2026-11-13', copies })).toBe(
      `The release 2026-11-13 in acme/relay-updates does not list ${copies[1]}`,
    );
    const odd = await copiesReadable(api(listing([{ id: '41', name: copies[0] }, { id: -1, name: copies[1] }])).fetch, { source: PRIVATE, tag: '2026-11-13', copies });
    expect(odd).toBe(`The release 2026-11-13 in acme/relay-updates does not list ${copies.join(', ')}`);
    expect(await copiesReadable(api(() => new Response('not json')).fetch, { source: PRIVATE, tag: '2026-11-13', copies })).toMatch(/does not list/);
    expect(await copiesReadable(api(() => Promise.reject(new Error('offline'))).fetch, { source: PRIVATE, tag: '2026-11-13', copies })).toBe(
      'GitHub could not be asked for the release 2026-11-13 in acme/relay-updates: offline',
    );
  });

  it('runs in the Release workflow after the copies are published and before the release, with the read token', () => {
    const workflow = readFileSync(join(__dirname, '../.github/workflows/release.yml'), 'utf8');
    const step = workflow.slice(workflow.indexOf('- name: Check that the app can download the copies'), workflow.indexOf('- name: Publish\n'));
    expect(workflow.indexOf("- name: Publish the copies for the app's updates")).toBeLessThan(workflow.indexOf('- name: Check that the app can download the copies'));
    expect(step).toContain("import { copiesReadable, updateSourceFrom } from './desktop/src/updateSource.ts';");
    expect(step).toContain('RELAY_UPDATES_TOKEN: ${{ secrets.UPDATES_READ_TOKEN }}');
    expect(step).toContain('GH_TOKEN: ${{ github.token }}');
    expect(step).toContain("readdirSync('updates')");
    expect(step).toContain("process.exit(1)");
  });
});

describe("GitHub's newest release", () => {
  it('is read with each system’s installer and its checksum', () => {
    const r = parse(githubRelease('2026-11-12.1'))!;
    expect(r.version).toBe('2026-11-12.1');
    expect(r.semver).toBe('2026.1112.1');
    expect(r.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases/tag/2026-11-12.1');
    expect(r.assets.mac).toEqual({
      name: 'Harness-Relay-2026-11-12.1-mac-arm64.dmg',
      url: `${COPIES}/2026-11-12.1/Harness-Relay-2026-11-12.1-mac-arm64-update.dmg`,
      fallback: `${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-mac-arm64.dmg`,
      size: 1000,
      sha256: sha('Harness-Relay-2026-11-12.1-mac-arm64.dmg'),
    });
    expect(Object.keys(r.assets).sort()).toEqual(['linux', 'linux-arm64', 'mac', 'win', 'win-arm64']);
  });

  it("is fetched from each installer's copy for updates in their own repository, so that GitHub counts updates apart, named as the installer", () => {
    const r = parse(githubRelease('2026-11-12.1'))!;
    for (const [system, end] of [
      ['mac', '-mac-arm64'],
      ['win', '-win-x64'],
      ['win-arm64', '-win-arm64'],
      ['linux', '-linux-x86_64'],
      ['linux-arm64', '-linux-arm64'],
    ] as const) {
      const ext = system.startsWith('mac') ? 'dmg' : system.startsWith('win') ? 'exe' : 'AppImage';
      expect(r.assets[system], system).toMatchObject({
        name: `Harness-Relay-2026-11-12.1${end}.${ext}`,
        url: `${COPIES}/2026-11-12.1/Harness-Relay-2026-11-12.1${end}-update.${ext}`,
        fallback: `${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1${end}.${ext}`,
        // The copy is the same file: checked against the installer's checksum.
        sha256: sha(`Harness-Relay-2026-11-12.1${end}.${ext}`),
      });
    }
    // The copies in the release itself (2026-11-12-rc) are left alone, whatever order GitHub lists them in.
    const inline = githubRelease('2026-11-12.1', { copies: true });
    expect(parse(inline)!.assets).toEqual(r.assets);
    inline.assets.reverse();
    expect(parse(inline)!.assets).toEqual(r.assets);
    // No checksum from GitHub: none for the copy either (the update goes by the release page).
    expect(parse(githubRelease('2026-11-12.1', { digest: false }))!.assets.win?.sha256).toBeUndefined();
  });

  it("is fetched from its copy in the repository the app was built to download its updates from, the version, checksum and page still this repository's", () => {
    const r = parseRelease(githubRelease('2026-11-12'), PRIVATE)!;
    expect(r.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases/tag/2026-11-12');
    expect(r.assets.win).toEqual({
      name: 'Harness-Relay-2026-11-12-win-x64.exe',
      url: 'https://github.com/acme/relay-updates/releases/download/2026-11-12/Harness-Relay-2026-11-12-win-x64-update.exe',
      fallback: `${DOWNLOAD}/2026-11-12/Harness-Relay-2026-11-12-win-x64.exe`,
      size: 1000,
      sha256: sha('Harness-Relay-2026-11-12-win-x64.exe'),
    });
  });

  it('can be a release candidate, as the app was built for one; never a draft or a tag that is not a version of ours', () => {
    const rc = parse(githubRelease('2026-11-12-rc.1'))!;
    expect(rc).toMatchObject({ version: '2026-11-12-rc.1', semver: '2026.1112.0-rc.1' });
    expect(rc.assets.mac?.name).toBe('Harness-Relay-2026-11-12-rc.1-mac-arm64.dmg');
    expect(parse(githubRelease('2026-11-12.1-rc.2'))).toMatchObject({ version: '2026-11-12.1-rc.2', semver: '2026.1112.1-rc.2' });
    expect(parse(githubRelease('2026-11-12', { prerelease: true }))?.version).toBe('2026-11-12');
    expect(parse(githubRelease('2026-11-12-rc', { draft: true }))).toBeUndefined();
    expect(parse(githubRelease('2026-11-12', { draft: true }))).toBeUndefined();
    expect(parse(githubRelease('v0.1.0'))).toBeUndefined();
    expect(parse(null)).toBeUndefined();
    expect(parse({ message: 'Not Found' })).toBeUndefined();
  });

  it('is the newest version in the list, a release candidate included, whatever order GitHub lists them in', () => {
    const tags = (...list: string[]) => list.map((tag) => githubRelease(tag));
    expect(newest(tags('2026-11-12-rc', '2026-11-11.1', '2026-11-11', '2026-11-11-rc'))?.version).toBe('2026-11-12-rc');
    expect(newest(tags('2026-11-11', '2026-11-12-rc.1', '2026-11-12-rc'))?.version).toBe('2026-11-12-rc.1');
    // The day's release comes after its release candidates, and its patches after it.
    expect(newest(tags('2026-11-12-rc.2', '2026-11-12', '2026-11-12-rc.1'))?.version).toBe('2026-11-12');
    expect(newest(tags('2026-11-12', '2026-11-12.1', '2026-11-12-rc.3'))?.version).toBe('2026-11-12.1');
    // A release candidate of a patch comes after the release before it, and before the patch.
    expect(newest(tags('2026-11-12.1-rc', '2026-11-12', '2026-11-12-rc.1'))?.version).toBe('2026-11-12.1-rc');
    expect(newest(tags('2026-11-12.1-rc', '2026-11-12.1-rc.1', '2026-11-12'))?.version).toBe('2026-11-12.1-rc.1');
    expect(newest(tags('2026-11-12.1', '2026-11-12.1-rc.1', '2026-11-12'))?.version).toBe('2026-11-12.1');
    // Drafts and tags that are not versions of ours are left out.
    expect(newest([githubRelease('2026-11-13-rc', { draft: true }), githubRelease('v9.0.0'), githubRelease('2026-11-12')])?.version).toBe('2026-11-12');
    expect(newest([])).toBeUndefined();
    expect(newest([githubRelease('2026-11-13', { draft: true })])).toBeUndefined();
    expect(newest({ message: 'Not Found' })).toBeUndefined();
    expect(newest(null)).toBeUndefined();
  });

  it('is a release, never a release candidate, for an app that is a release', () => {
    const tags = (...list: string[]) => list.map((tag) => githubRelease(tag));
    expect(newest(tags('2026-11-13-rc', '2026-11-12.1', '2026-11-12'), false)?.version).toBe('2026-11-12.1');
    expect(newest(tags('2026-11-12.1-rc', '2026-11-12', '2026-11-12-rc.1'), false)?.version).toBe('2026-11-12');
    expect(newest(tags('2026-11-13-rc', '2026-11-13-rc.1'), false)).toBeUndefined();
    expect(parse(githubRelease('2026-11-12-rc'))?.candidate).toBe(true);
    expect(parse(githubRelease('2026-11-12.1'))?.candidate).toBe(false);
  });

  it('may be a release candidate for an app that is one, or a build of your own; a release takes releases only', () => {
    expect(takesCandidates('2026.1112.0-rc')).toBe(true);
    expect(takesCandidates('2026.1112.1-rc.2')).toBe(true);
    expect(takesCandidates('2026.1110.0-dev')).toBe(true);
    expect(takesCandidates('2026.1112.0')).toBe(false);
    expect(takesCandidates('2026.1112.3')).toBe(false);
    // A release candidate is offered the release it is a candidate of, and the next one.
    expect(isNewer(newest([githubRelease('2026-11-12'), githubRelease('2026-11-12-rc.1')], true), '2026.1112.0-rc.1')).toBe(true);
    expect(isNewer(newest([githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')], true), '2026.1112.0-rc.1')).toBe(true);
    // A release is not offered the next day's candidate, only the next release.
    expect(isNewer(newest([githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')], false), '2026.1112.0')).toBe(false);
    expect(isNewer(newest([githubRelease('2026-11-13'), githubRelease('2026-11-13-rc')], false), '2026.1112.0')).toBe(true);
  });

  it('leaves out installers elsewhere, with a name that leaves its folder, or a checksum that is not SHA-256', () => {
    const r = githubRelease('2026-11-12');
    r.assets[0]!.browser_download_url = 'https://evil.example/Harness-Relay-2026-11-12-mac-arm64.dmg';
    r.assets[1]!.name = '../../Harness-Relay-2026-11-12-win-x64.exe';
    (r.assets.find((a) => a.name.endsWith('-linux-x86_64.AppImage')) as { digest?: string }).digest = 'md5:abc';
    const parsed = parse(r)!;
    expect(parsed.assets.mac).toBeUndefined();
    expect(parsed.assets.win).toBeUndefined();
    expect(parsed.assets.linux?.sha256).toBeUndefined();
    // A page elsewhere is replaced by the releases page.
    expect(parse({ ...githubRelease('2026-11-12'), html_url: 'https://evil.example/' })!.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases');
  });

  it('is newer than a build of an earlier day, an earlier patch, a release candidate of its day, or a dev build', () => {
    const latest = parse(githubRelease('2026-11-12'));
    expect(isNewer(latest, '2026.1111.3')).toBe(true);
    expect(isNewer(latest, '2026.1112.0-rc.2')).toBe(true);
    expect(isNewer(latest, '2026.1112.0-dev')).toBe(true);
    expect(isNewer(latest, '0.1.0')).toBe(true);
    expect(isNewer(latest, '2026.1112.0')).toBe(false);
    expect(isNewer(latest, '2026.1112.1')).toBe(false);
    expect(isNewer(latest, '2026.1113.0-dev')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
  });

  it('as a release candidate, is newer than an earlier day or candidate, but not than its day’s release', () => {
    const rc = parse(githubRelease('2026-11-12-rc.1'));
    expect(isNewer(rc, '2026.1111.1')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-rc')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-dev')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-rc.1')).toBe(false);
    expect(isNewer(rc, '2026.1112.0-rc.2')).toBe(false);
    expect(isNewer(rc, '2026.1112.0')).toBe(false);
    // One of a patch is newer than the release it follows, not than the patch.
    const patchRc = parse(githubRelease('2026-11-12.1-rc'));
    expect(isNewer(patchRc, '2026.1112.0')).toBe(true);
    expect(isNewer(patchRc, '2026.1112.1')).toBe(false);
  });

  it('is asked for at GitHub; none yet is no update, any other failure an error', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown): Fetch =>
      async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
      };
    expect((await checkLatest(answer(200, [githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')]), { source: SOURCE }))?.version).toBe('2026-11-13-rc');
    expect(asked[0]).toBe(RELEASES_API);
    expect(RELEASES_API).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay/releases?per_page=20');
    expect(await checkLatest(answer(200, []), { source: SOURCE })).toBeUndefined();
    // A question that stalls is given up on (the app passes AbortSignal.timeout(CHECK_TIMEOUT_MS)), so the next check is not held back.
    const stalled: Fetch = (_url, init) =>
      new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true }));
    await expect(checkLatest(stalled, { source: SOURCE, signal: AbortSignal.timeout(20) })).rejects.toThrow();
    expect(CHECK_TIMEOUT_MS).toBe(30_000);
    expect(await checkLatest(answer(404, { message: 'Not Found' }), { source: SOURCE })).toBeUndefined();
    // A release asks for GitHub's latest release alone: found however many release candidates came out since.
    asked.length = 0;
    expect((await checkLatest(answer(200, githubRelease('2026-11-12.1')), { source: SOURCE, candidates: false }))?.version).toBe('2026-11-12.1');
    expect(asked).toEqual([LATEST_RELEASE_API]);
    expect(LATEST_RELEASE_API).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay/releases/latest');
    // Never a release candidate, should GitHub ever answer with one; none yet is no update.
    expect(await checkLatest(answer(200, githubRelease('2026-11-13-rc')), { source: SOURCE, candidates: false })).toBeUndefined();
    expect(await checkLatest(answer(404, { message: 'Not Found' }), { source: SOURCE, candidates: false })).toBeUndefined();
    await expect(checkLatest(answer(403, { message: 'rate limited' }), { source: SOURCE })).rejects.toThrow('403');
  });

  it("never sends a private copies' repository's token with a check: the releases asked for are this repository's", async () => {
    const asked: { url: string; headers?: Record<string, string> }[] = [];
    const fetch: Fetch = async (url, init) => {
      asked.push({ url, headers: init?.headers });
      return new Response(JSON.stringify([githubRelease('2026-11-12')]));
    };
    const latest = await checkLatest(fetch, { source: PRIVATE });
    expect(latest?.assets.mac?.url).toBe('https://github.com/acme/relay-updates/releases/download/2026-11-12/Harness-Relay-2026-11-12-mac-arm64-update.dmg');
    expect(asked).toEqual([{ url: RELEASES_API, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }]);
    await checkLatest(fetch, { source: PRIVATE, candidates: false });
    expect(asked[1]).toEqual({ url: LATEST_RELEASE_API, headers: asked[0]!.headers });
  });

  it("has one installer for each system: the Mac app for Apple Silicon (none for Intel), the running app's processor's for Windows and Linux", () => {
    expect(updateSystem('darwin', 'arm64')).toBe('mac');
    expect(updateSystem('darwin', 'x64')).toBeUndefined();
    expect(updateSystem('win32', 'x64')).toBe('win');
    expect(updateSystem('win32', 'arm64')).toBe('win-arm64');
    expect(updateSystem('linux', 'x64')).toBe('linux');
    expect(updateSystem('linux', 'arm64')).toBe('linux-arm64');
    expect(updateSystem('linux', 'arm')).toBeUndefined();
    expect(updateSystem('win32', 'ia32')).toBeUndefined();
    expect(updateSystem('freebsd', 'x64')).toBeUndefined();
  });

  it("reads each processor's installer from a release, and the Arm ones' checksums", () => {
    const release = parse(githubRelease('2026-11-12'))!;
    expect(Object.keys(release.assets).sort()).toEqual(['linux', 'linux-arm64', 'mac', 'win', 'win-arm64']);
    expect(release.assets['win-arm64']).toMatchObject({ name: 'Harness-Relay-2026-11-12-win-arm64.exe', sha256: sha('Harness-Relay-2026-11-12-win-arm64.exe') });
    expect(release.assets['linux-arm64']?.name).toBe('Harness-Relay-2026-11-12-linux-arm64.AppImage');
    expect(release.assets.win?.name).toBe('Harness-Relay-2026-11-12-win-x64.exe');
  });
});

describe('how often GitHub is asked', () => {
  it('once an hour, of the 60 an hour GitHub allows an address without signing in', () => {
    expect(CHECK_EVERY_MS).toBe(60 * 60_000);
  });

  it('asks only for a copy that updates itself, with no update nor check under way, and none asked too recently', () => {
    const now = 10_000_000;
    const ok = { updates: true, updating: false, checking: false, askedAt: undefined, now };
    expect(checkNow(ok)).toBe(true);
    expect(checkNow({ ...ok, updates: false })).toBe(false);
    expect(checkNow({ ...ok, updating: true })).toBe(false);
    expect(checkNow({ ...ok, checking: true })).toBe(false);
    expect(checkNow({ ...ok, askedAt: now - 1000 })).toBe(false);
    expect(checkNow({ ...ok, askedAt: now - MIN_CHECK_GAP_MS })).toBe(true);
  });

  it('at most every five minutes, also when the chat asks again sooner: at most 12 of the 60 an hour', () => {
    const at = 1_000_000;
    expect(mayAskGitHub(undefined, at)).toBe(true);
    expect(mayAskGitHub(at, at + MIN_CHECK_GAP_MS - 1)).toBe(false);
    expect(mayAskGitHub(at, at + MIN_CHECK_GAP_MS)).toBe(true);
    expect(MIN_CHECK_GAP_MS).toBe(5 * 60_000);
    // A clock set back does not stop it for good.
    expect(mayAskGitHub(at, at - 5000)).toBe(true);
  });
});

describe('what the chat is told of updates', () => {
  const release = { version: '2026-11-12', semver: '2026.1112.0', page: 'https://github.com/x/y/releases/tag/2026-11-12', candidate: false, assets: {} };

  it('is nothing more for a copy that does not update itself', () => {
    expect(chatUpdate({ updates: false, update: release, updating: { kind: 'installing' }, checking: true, checkedAt: 1, checkFailed: true })).toEqual({ updates: false });
  });

  it('is the newer version, the update under way in whole percent, a check, when it last answered and whether the last one failed', () => {
    expect(chatUpdate({ updates: true, checking: false, checkFailed: false })).toEqual({ updates: true });
    expect(chatUpdate({ updates: true, update: release, updating: { kind: 'downloading', done: 0.429 }, checking: true, checkedAt: 5, checkFailed: true })).toEqual({
      updates: true,
      available: { version: '2026-11-12', page: release.page },
      progress: { kind: 'downloading', percent: 42 },
      checking: true,
      checkedAt: 5,
      checkFailed: true,
    });
    expect(chatUpdate({ updates: true, updating: { kind: 'waiting' }, checking: false, checkFailed: false }).progress).toEqual({ kind: 'waiting' });
  });
});

describe('an update asked for more than once', () => {
  it('runs once at a time: asked again meanwhile, it does nothing; asked after, it runs again', async () => {
    let runs = 0;
    let finish: () => void = () => {};
    const update = oneAtATime(async () => {
      runs++;
      await new Promise<void>((done) => (finish = done));
    });
    const first = update();
    await update(); // a second click while the first asks: nothing
    expect(runs).toBe(1);
    finish();
    await first;
    const again = update();
    expect(runs).toBe(2);
    finish();
    await again;
  });

  it('can run again after one that failed', async () => {
    let runs = 0;
    const update = oneAtATime(async () => {
      runs++;
      throw new Error('download');
    });
    await expect(update()).rejects.toThrow('download');
    await expect(update()).rejects.toThrow('download');
    expect(runs).toBe(2);
  });
});

describe('how this copy of the app updates', () => {
  const asset: UpdateAsset = { name: 'x', url: 'u', sha256: 'a'.repeat(64) };
  const mac = '/Applications/Harness Relay.app/Contents/MacOS/Harness Relay';
  const can = () => true;
  const cannot = () => false;

  it('replaces the Mac app where it is, when it may write there', () => {
    expect(macAppOf(mac)).toBe('/Applications/Harness Relay.app');
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, asset, writable: can })).toEqual({ kind: 'mac', app: '/Applications/Harness Relay.app' });
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, asset, writable: cannot })).toEqual({ kind: 'manual', why: 'read-only' });
    // Run from the disk image, or a translocated copy.
    for (const execPath of ['/Volumes/Harness Relay/Harness Relay.app/Contents/MacOS/Harness Relay', '/private/var/folders/x/T/AppTranslocation/ABC/d/Harness Relay.app/Contents/MacOS/Harness Relay']) {
      expect(installPlan({ platform: 'darwin', packaged: true, execPath, asset, writable: can }), execPath).toEqual({ kind: 'manual', why: 'read-only' });
    }
  });

  it('runs the installer on Windows, and replaces the AppImage on Linux', () => {
    expect(installPlan({ platform: 'win32', packaged: true, execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\harness-relay\\Harness Relay.exe', asset })).toEqual({ kind: 'win' });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/tmp/.mount_x/harness-relay', appImage: '/home/me/Apps/Harness.AppImage', asset, writable: can })).toEqual({
      kind: 'linux',
      appImage: '/home/me/Apps/Harness.AppImage',
    });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/opt/Harness Relay/harness-relay', asset, writable: can })).toEqual({ kind: 'manual', why: 'not-appimage' });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/x', appImage: '/opt/H.AppImage', asset, writable: cannot })).toEqual({ kind: 'manual', why: 'read-only' });
  });

  it('sends anything else to the release page: a build from source, no installer, no checksum', () => {
    expect(installPlan({ platform: 'darwin', packaged: false, execPath: mac, asset, writable: can })).toEqual({ kind: 'manual', why: 'not-packaged' });
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, writable: can })).toEqual({ kind: 'manual', why: 'no-installer' });
    expect(installPlan({ platform: 'win32', packaged: true, execPath: 'x', asset: { ...asset, sha256: undefined } })).toEqual({ kind: 'manual', why: 'no-checksum' });
  });

  it('runs the Windows installer silently, as an update, starting the new version', () => {
    expect(WINDOWS_INSTALLER_ARGS).toEqual(['--updated', '/S', '--force-run']);
  });
});

describe('finding a copy in a private repository', () => {
  const asset = parseRelease(githubRelease('2026-11-12'), PRIVATE)!.assets.mac!;
  const installer = `${DOWNLOAD}/2026-11-12/Harness-Relay-2026-11-12-mac-arm64.dmg`;
  /** GitHub's API, answering with `answer`, which says where it was asked and with what. */
  function api(answer: (url: string) => Response | Promise<Response>) {
    const asked: { url: string; init?: Parameters<Fetch>[1] }[] = [];
    const fetch: Fetch = async (url, init) => {
      asked.push({ url, init });
      return answer(url);
    };
    return { asked, fetch };
  }
  /** The release under the tag in the copies' repository, holding `assets`. */
  const copies = (assets: unknown[]) => new Response(JSON.stringify({ tag_name: '2026-11-12', assets }));

  it('is no question for a public repository: the copy downloaded as found, with no headers', async () => {
    const gh = api(() => {
      throw new Error('asked');
    });
    expect(await copyToDownload(gh.fetch, SOURCE, '2026-11-12', asset)).toEqual({ asset });
    expect(gh.asked).toEqual([]);
  });

  it("asks GitHub's API for the release with the token, and downloads the copy from its address there, the installer itself to fall back on", async () => {
    const gh = api(() => copies([{ id: 7, name: 'notes.txt' }, { id: 41, name: 'Harness-Relay-2026-11-12-mac-arm64-update.dmg' }]));
    const found = await copyToDownload(gh.fetch, PRIVATE, '2026-11-12', asset);
    expect(gh.asked).toEqual([
      {
        url: 'https://api.github.com/repos/acme/relay-updates/releases/tags/2026-11-12',
        init: { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${TOKEN}` }, signal: undefined, redirect: 'error' },
      },
    ]);
    expect(found).toEqual({
      asset: { ...asset, url: 'https://api.github.com/repos/acme/relay-updates/releases/assets/41', fallback: installer },
      headers: downloadHeaders(PRIVATE),
    });
  });

  it('downloads the installer itself, without the token, whenever the copy cannot be had', async () => {
    const plain = { asset: { ...asset, url: installer, fallback: undefined } };
    const answers: (() => Response | Promise<Response>)[] = [
      // The token expired or was revoked, may not read the repository, or is out of requests.
      () => new Response('{"message":"Bad credentials"}', { status: 401 }),
      () => new Response('{"message":"Not Found"}', { status: 404 }),
      () => new Response('{"message":"API rate limit exceeded"}', { status: 403 }),
      // A release without the copy, or an id that is not one.
      () => copies([{ id: 7, name: 'Harness-Relay-2026-11-12-mac-arm64.dmg' }]),
      () => copies([{ id: '41/../../x', name: 'Harness-Relay-2026-11-12-mac-arm64-update.dmg' }]),
      () => copies([{ id: -1, name: 'Harness-Relay-2026-11-12-mac-arm64-update.dmg' }]),
      () => new Response('null'),
      () => new Response('not json'),
      // GitHub cannot be reached.
      () => Promise.reject(new Error('offline')),
    ];
    for (const [i, answer] of answers.entries()) expect(await copyToDownload(api(answer).fetch, PRIVATE, '2026-11-12', asset), String(i)).toEqual(plain);
    // A question that stalls is given up on (main.ts passes AbortSignal.timeout(CHECK_TIMEOUT_MS)): the installer itself.
    const stalled: Fetch = (_url, init) => new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true }));
    expect(await copyToDownload(stalled, PRIVATE, '2026-11-12', asset, AbortSignal.timeout(20))).toEqual(plain);
  });
});

describe('downloading an update', () => {
  const body = Buffer.from('the new installer '.repeat(1000));
  const asset: UpdateAsset = { name: 'H.dmg', url: `${DOWNLOAD}/v/H.dmg`, size: body.length, sha256: sha(body) };
  const serve = (data: Buffer, status = 200): Fetch => async () => new Response(new Uint8Array(data), { status, headers: { 'content-length': String(data.length) } });

  it('fetches the installer itself when its copy for updates is not there, and only then', async () => {
    const copy: UpdateAsset = { ...asset, url: `${COPIES}/v/H-update.dmg`, fallback: `${DOWNLOAD}/v/H.dmg` };
    const asked: string[] = [];
    const answer = (status: (url: string) => number): Fetch => async (url) => {
      asked.push(url);
      const s = status(url);
      return new Response(s === 200 ? new Uint8Array(body) : 'Not Found', { status: s });
    };
    const to = join(dir, 'fallback.dmg');
    await download({ fetch: answer((url) => (url === copy.url ? 404 : 200)), asset: copy, to });
    expect(asked).toEqual([copy.url, copy.fallback]);
    expect(readFileSync(to)).toEqual(body);
    // The copy there: the installer is not asked for.
    asked.length = 0;
    await download({ fetch: answer(() => 200), asset: copy, to });
    expect(asked).toEqual([copy.url]);
    // Another failure is no reason to go elsewhere, and neither is a 404 with nowhere else to go.
    asked.length = 0;
    const busy = (await download({ fetch: answer(() => 503), asset: copy, to }).catch((e: unknown) => e)) as UpdateError;
    expect(busy.failure).toBe('download');
    expect(asked).toEqual([copy.url]);
    const gone = (await download({ fetch: answer(() => 404), asset: copy, to }).catch((e: unknown) => e)) as UpdateError;
    expect(gone.message).toBe('HTTP 404');
    const nowhere = (await download({ fetch: answer(() => 404), asset, to }).catch((e: unknown) => e)) as UpdateError;
    expect(nowhere.failure).toBe('download');
  });

  it("sends a copy's token to GitHub's API alone, and fetches the installer itself without it when the token no longer works", async () => {
    const api: UpdateAsset = { ...asset, url: 'https://api.github.com/repos/acme/relay-updates/releases/assets/7', fallback: `${DOWNLOAD}/v/H.dmg` };
    const headers = downloadHeaders(PRIVATE)!;
    const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/7/h?sig=1';
    const asked: { url: string; init?: Parameters<Fetch>[1] }[] = [];
    const fetch: Fetch = async (url, init) => {
      asked.push({ url, init });
      return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
    };
    const located: { url: string; headers?: Record<string, string> }[] = [];
    const answers =
      (answer: { status: number; location?: string }): Locate =>
      async (url, _signal, h) => {
        located.push({ url, headers: h });
        return answer;
      };
    const signal = expect.any(AbortSignal);
    const failed = (p: Promise<void>) => p.then(() => undefined, (e: unknown) => e as UpdateError);
    const to = join(dir, 'private.dmg');
    // Asked where the file is with the token, and fetched from there without it.
    await download({ fetch, locate: answers({ status: 302, location: CDN }), asset: api, to, headers });
    expect(readFileSync(to)).toEqual(body);
    expect(located).toEqual([{ url: api.url, headers }]);
    expect(asked).toEqual([{ url: CDN, init: { signal } }]);
    // Answered with the file itself: fetched there with the token, following no redirect.
    asked.length = 0;
    await download({ fetch, locate: answers({ status: 200 }), asset: api, to, headers });
    expect(asked).toEqual([{ url: api.url, init: { headers, signal, redirect: 'error' } }]);
    // The token no longer works, the requests every app shares ran out, GitHub's API fails, or the copy
    // is not there: the installer itself, without it.
    for (const status of [401, 403, 404, 429, 500, 502, 503]) {
      asked.length = 0;
      await download({ fetch, locate: answers({ status }), asset: api, to, headers });
      expect(asked, String(status)).toEqual([{ url: api.fallback, init: { signal } }]);
      expect(readFileSync(to)).toEqual(body);
    }
    // Refused where it answered with the file: the installer itself.
    for (const status of [401, 429, 502]) {
      asked.length = 0;
      const refusing: Fetch = async (url, init) => {
        asked.push({ url, init });
        return url === api.url ? new Response('no', { status }) : new Response(new Uint8Array(body));
      };
      await download({ fetch: refusing, locate: answers({ status: 200 }), asset: api, to, headers });
      expect(asked.map((a) => a.url), String(status)).toEqual([api.url, api.fallback]);
      expect(asked[1]!.init).toEqual({ signal });
    }
    // Without the token, a 429 or a 5xx is no reason to go elsewhere, as before.
    asked.length = 0;
    const busy: Fetch = async (url, init) => {
      asked.push({ url, init });
      return new Response('busy', { status: url === asset.url ? 503 : 200 });
    };
    expect((await failed(download({ fetch: busy, asset: { ...asset, fallback: api.fallback }, to })))?.message).toBe('HTTP 503');
    expect(asked.map((a) => a.url)).toEqual([asset.url]);
    // No way to ask where the file is: the installer itself, the token never sent.
    asked.length = 0;
    await download({ fetch, asset: api, to, headers });
    expect(asked).toEqual([{ url: api.fallback, init: { signal } }]);
    // GitHub failing otherwise, or sending anywhere but HTTPS: nothing fetched.
    asked.length = 0;
    expect((await failed(download({ fetch, locate: answers({ status: 400 }), asset: api, to, headers })))?.message).toBe('HTTP 400');
    expect((await failed(download({ fetch, locate: answers({ status: 302, location: 'http://example.com/h' }), asset: api, to, headers })))?.failure).toBe('download');
    expect((await failed(download({ fetch, asset: { ...api, fallback: undefined }, to, headers })))?.failure).toBe('download');
    expect(asked).toEqual([]);
  });

  it('saves the file once its checksum matches, telling how far it got', async () => {
    const to = join(dir, 'ok.dmg');
    const progress: number[] = [];
    await download({ fetch: serve(body), asset, to, onProgress: (d) => progress.push(d) });
    expect(readFileSync(to)).toEqual(body);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it('deletes a download that does not match its checksum, and keeps nothing of a failed one', async () => {
    const to = join(dir, 'bad.dmg');
    const err = await download({ fetch: serve(Buffer.from('something else')), asset, to }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect((err as UpdateError).failure).toBe('checksum');
    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${to}.part`)).toBe(false);
    const failed = await download({ fetch: serve(body, 503), asset, to }).catch((e: unknown) => e);
    expect((failed as UpdateError).failure).toBe('download');
    const offline = await download({ fetch: async () => Promise.reject(new Error('offline')), asset, to }).catch((e: unknown) => e);
    expect((offline as UpdateError).failure).toBe('download');
    expect(existsSync(to)).toBe(false);
  });

  it('gives up on a download that goes without a byte for a while, keeping nothing, so the next update can start', async () => {
    const to = join(dir, 'stalled.dmg');
    // A connection that dropped: a first part comes, then nothing more (as fetch does, it stops when aborted).
    const stalls: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body.subarray(0, 100)));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
          },
        }),
        { headers: { 'content-length': String(body.length) } },
      );
    const err = (await download({ fetch: stalls, asset, to, stallMs: 50 }).catch((e: unknown) => e)) as UpdateError;
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.failure).toBe('download');
    expect(err.message).toMatch(/no data/);
    expect(existsSync(`${to}.part`)).toBe(false);
    // Also when no answer comes at all.
    const silent: Fetch = (_url, init) => new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true }));
    const none = (await download({ fetch: silent, asset, to, stallMs: 50 }).catch((e: unknown) => e)) as UpdateError;
    expect(none.message).toMatch(/no data/);
    expect(DOWNLOAD_STALL_MS).toBe(60_000);
  });

  it('keeps going as long as bytes keep coming, however long it takes', async () => {
    const to = join(dir, 'slow.dmg');
    // 18 parts 25 ms apart: the whole takes over twice the limit, each wait an eighth of it.
    const slow: Fetch = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (let at = 0; at < body.length; at += 1000) {
              await new Promise((r) => setTimeout(r, 25));
              controller.enqueue(new Uint8Array(body.subarray(at, at + 1000)));
            }
            controller.close();
          },
        }),
      );
    await download({ fetch: slow, asset, to, stallMs: 200 });
    expect(readFileSync(to)).toEqual(body);
  });
});

describe('downloading an update in parts', () => {
  // 64 KB, which the CDN sends 1 KB at a time: four parts of 16 KB, none split below 4 KB.
  const body = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 31 + (i >> 10)) & 0xff));
  const minPart = 4 * 1024;
  const quarter = body.length / 4;
  const copy: UpdateAsset = { name: 'H.dmg', url: `${COPIES}/v/H-update.dmg`, fallback: `${DOWNLOAD}/v/H.dmg`, size: body.length, sha256: sha(body) };
  /** Where GitHub sends a download: its CDN, signed (a new signature each time it is asked). */
  const CDN = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/h?sig=';

  /**
   * GitHub's address for a download, asked where it leads (`locate`): a redirect to its CDN, or `status`
   * (404) for one in `missing`. It says what it was asked, and with which headers.
   */
  function github(missing: string[] = [], status = 404) {
    const located: string[] = [];
    const headers: (Record<string, string> | undefined)[] = [];
    const locate: Locate = async (url, _signal, h) => {
      located.push(url);
      headers.push(h);
      return missing.includes(url) ? { status } : { status: 302, location: `${CDN}${located.length}` };
    };
    return { located, headers, locate };
  }

  /** Waits `ms`, or until `signal` aborts. */
  const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((done) => {
      if (!ms) return done();
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
    });

  interface Asked {
    conn: number;
    url: string;
    from: number;
    to: number;
    sent: number;
    cancelled: boolean;
    /** What the request sent as its Authorization header, and how it was to take a redirect. */
    authorization?: string;
    redirect?: string;
  }

  /**
   * The CDN, as `n` connections: the range asked for in 1 KB chunks, each `pause(asked)` ms after the
   * last; `answer(asked)` is its status (200 sends the whole file), and the connection drops after
   * `cut(asked)` bytes. It stops when aborted, as fetch does.
   */
  function cdn(data: Buffer, n: number, how: { pause?: (a: Asked) => number; answer?: (a: Asked) => number; cut?: (a: Asked) => number | undefined } = {}) {
    const asked: Asked[] = [];
    const connections = Array.from(
      { length: n },
      (_, conn): Fetch =>
        async (url, init) => {
          const range = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.Range ?? '');
          const a: Asked = {
            conn,
            url,
            from: range ? Number(range[1]) : 0,
            to: range ? Number(range[2]) + 1 : data.length,
            sent: 0,
            cancelled: false,
            authorization: init?.headers?.Authorization,
            redirect: init?.redirect,
          };
          asked.push(a);
          const status = how.answer?.(a) ?? (range ? 206 : 200);
          if (status !== 200 && status !== 206) return new Response('no', { status });
          const bytes = status === 206 ? data.subarray(a.from, a.to) : data;
          const cut = how.cut?.(a);
          const signal = init?.signal;
          const stream = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
              },
              async pull(controller) {
                await pause(how.pause?.(a) ?? 0, signal);
                if (signal?.aborted || a.cancelled) return;
                if (cut !== undefined && a.sent >= cut) return controller.error(new Error('connection reset'));
                if (a.sent >= bytes.length) return controller.close();
                const chunk = bytes.subarray(a.sent, a.sent + 1024);
                a.sent += chunk.length;
                controller.enqueue(new Uint8Array(chunk));
              },
              cancel() {
                a.cancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
          const headers: Record<string, string> =
            status === 206 ? { 'content-range': `bytes ${a.from}-${a.to - 1}/${data.length}` } : { 'content-length': String(data.length) };
          return new Response(stream, { status, headers });
        },
    );
    return { connections, asked };
  }

  /** A fetch for the whole file in one request, which says where it was asked. */
  function single(data: Buffer) {
    const asked: string[] = [];
    const fetch: Fetch = async (url) => {
      asked.push(url);
      return new Response(new Uint8Array(data), { headers: { 'content-length': String(data.length) } });
    };
    return { asked, fetch };
  }

  const failure = (p: Promise<void>) => p.then(() => undefined, (e: unknown) => e as UpdateError);

  it('asks GitHub once where the file is, and fetches it from there, a part on each connection', async () => {
    const gh = github();
    const served = cdn(body, 4);
    const whole = single(body);
    const to = join(dir, 'parts.dmg');
    const progress: number[] = [];
    await download({ fetch: whole.fetch, connections: served.connections, locate: gh.locate, asset: copy, to, minPart, onProgress: (d) => progress.push(d) });
    expect(readFileSync(to)).toEqual(body);
    expect(gh.located).toEqual([copy.url]);
    expect(whole.asked).toEqual([]);
    expect(served.asked.slice(0, 4).map((a) => [a.conn, a.from, a.to])).toEqual([0, 1, 2, 3].map((i) => [i, i * quarter, (i + 1) * quarter]));
    expect(served.asked.every((a) => a.url === `${CDN}1`)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it('uses only as many connections as the file has parts of `minPart`, and one request for a file under two', async () => {
    const six = cdn(body, 6);
    await download({ fetch: single(body).fetch, connections: six.connections, locate: github().locate, asset: copy, to: join(dir, 'parts-four.dmg'), minPart: quarter });
    expect(new Set(six.asked.map((a) => a.conn))).toEqual(new Set([0, 1, 2, 3]));
    // A small file: from GitHub's address itself, as without connections.
    const small = Buffer.from('a small file');
    const whole = single(small);
    const unused = cdn(small, 4);
    const gh = github();
    const to = join(dir, 'parts-small.dmg');
    await download({ fetch: whole.fetch, connections: unused.connections, locate: gh.locate, asset: { ...copy, size: small.length, sha256: sha(small) }, to, minPart });
    expect(readFileSync(to)).toEqual(small);
    expect(whole.asked).toEqual([copy.url]);
    expect(unused.asked).toEqual([]);
    expect(gh.located).toEqual([]);
  });

  it('fetches the installer itself when its copy is not there, and fails on any other answer, keeping nothing', async () => {
    const gh = github([copy.url]);
    const to = join(dir, 'parts-fallback.dmg');
    await download({ fetch: single(body).fetch, connections: cdn(body, 4).connections, locate: gh.locate, asset: copy, to, minPart });
    expect(gh.located).toEqual([copy.url, copy.fallback]);
    expect(readFileSync(to)).toEqual(body);
    const failed = join(dir, 'parts-none.dmg');
    const answers = (answer: { status: number; location?: string }) =>
      failure(download({ fetch: single(body).fetch, connections: cdn(body, 4).connections, locate: async () => answer, asset: copy, to: failed, minPart }));
    expect((await answers({ status: 503 }))?.message).toBe('HTTP 503');
    expect((await answers({ status: 404 }))?.message).toBe('HTTP 404');
    // Sent anywhere but to HTTPS.
    const plain = await answers({ status: 302, location: 'http://release-assets.githubusercontent.com/h' });
    expect(plain).toBeInstanceOf(UpdateError);
    expect(plain?.failure).toBe('download');
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(`${failed}.part`)).toBe(false);
  });

  it("asks GitHub's API with a copy's token, also for a new address, and fetches the parts from its CDN without it", async () => {
    const headers = downloadHeaders(PRIVATE)!;
    const api: UpdateAsset = { ...copy, url: 'https://api.github.com/repos/acme/relay-updates/releases/assets/7' };
    // The parts taken from the slow connection are refused at the first address, which has expired since.
    const gh = github();
    const served = cdn(body, 4, { pause: (a) => (a.conn === 0 ? 40 : 0), answer: (a) => (a.url === `${CDN}1` && a.from % quarter !== 0 ? 403 : 206) });
    const to = join(dir, 'parts-private.dmg');
    await download({ fetch: single(body).fetch, connections: served.connections, locate: gh.locate, asset: api, to, minPart, headers });
    expect(readFileSync(to)).toEqual(body);
    expect(gh.located).toEqual([api.url, api.url]);
    expect(gh.headers).toEqual([headers, headers]);
    expect(served.asked.every((a) => a.url.startsWith(CDN) && a.authorization === undefined)).toBe(true);
    // Answered with the file itself: the parts asked there, with the token, following no redirect.
    const direct = cdn(body, 4);
    await download({ fetch: single(body).fetch, connections: direct.connections, locate: async () => ({ status: 200 }), asset: api, to: join(dir, 'parts-direct.dmg'), minPart, headers });
    expect(direct.asked.length).toBeGreaterThanOrEqual(4);
    expect(direct.asked.every((a) => a.url === api.url && a.authorization === `Bearer ${TOKEN}` && a.redirect === 'error')).toBe(true);
    // The token no longer works, the requests ran out, GitHub's API fails, or the copy is not there: the
    // installer itself, located without it.
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const refused = github([api.url], status);
      const parts = cdn(body, 4);
      await download({ fetch: single(body).fetch, connections: parts.connections, locate: refused.locate, asset: api, to: join(dir, `parts-refused-${status}.dmg`), minPart, headers });
      expect(refused.located, String(status)).toEqual([api.url, api.fallback]);
      expect(refused.headers).toEqual([headers, undefined]);
      expect(parts.asked.every((a) => a.authorization === undefined && a.redirect === undefined)).toBe(true);
    }
    // A public repository's copy: no headers anywhere; a 403 there is no reason to go elsewhere.
    const open = github([copy.url], 403);
    const err = await failure(download({ fetch: single(body).fetch, connections: cdn(body, 4).connections, locate: open.locate, asset: copy, to: join(dir, 'parts-public.dmg'), minPart }));
    expect(err?.message).toBe('HTTP 403');
    expect(open.located).toEqual([copy.url]);
    expect(open.headers).toEqual([undefined]);
  });

  it('finishes from the installer itself, without the token, when GitHub refuses the token on asking again for an expired address', async () => {
    const headers = downloadHeaders(PRIVATE)!;
    const api: UpdateAsset = { ...copy, url: 'https://api.github.com/repos/acme/relay-updates/releases/assets/7' };
    for (const status of [401, 403, 429, 502]) {
      // The copy's first address expires for the parts taken from the slow connection; asked again, the API refuses the token.
      const located: { url: string; headers?: Record<string, string> }[] = [];
      const locate: Locate = async (url, _signal, h) => {
        located.push({ url, headers: h });
        if (url === api.url && located.length > 1) return { status };
        return { status: 302, location: url === api.url ? `${CDN}copy` : `${CDN}installer` };
      };
      const served = cdn(body, 4, { pause: (a) => (a.conn === 0 ? 40 : 0), answer: (a) => (a.url === `${CDN}copy` && a.from % quarter !== 0 ? 403 : 206) });
      const to = join(dir, `parts-relocated-${status}.dmg`);
      await download({ fetch: single(body).fetch, connections: served.connections, locate, asset: api, to, minPart, headers });
      expect(readFileSync(to), String(status)).toEqual(body);
      expect(located).toEqual([
        { url: api.url, headers },
        { url: api.url, headers },
        { url: api.fallback, headers: undefined },
      ]);
      expect(served.asked.some((a) => a.url === `${CDN}installer`)).toBe(true);
      expect(served.asked.every((a) => a.authorization === undefined)).toBe(true);
    }
  });

  it("downloads in one request when the CDN, or GitHub's API answering with the file, sends the whole file for a part: the token at the API alone", async () => {
    const headers = downloadHeaders(PRIVATE)!;
    const api: UpdateAsset = { ...copy, url: 'https://api.github.com/repos/acme/relay-updates/releases/assets/7' };
    const recorded = () => {
      const asked: { url: string; init?: Parameters<Fetch>[1] }[] = [];
      const fetch: Fetch = async (url, init) => {
        asked.push({ url, init });
        return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
      };
      return { asked, fetch };
    };
    // From the CDN: without the token.
    const fromCdn = recorded();
    const gh = github();
    await download({ fetch: fromCdn.fetch, connections: cdn(body, 4, { answer: () => 200 }).connections, locate: gh.locate, asset: api, to: join(dir, 'parts-whole-cdn.dmg'), minPart, headers });
    expect(gh.headers).toEqual([headers]);
    expect(fromCdn.asked).toEqual([{ url: `${CDN}1`, init: { signal: expect.any(AbortSignal) } }]);
    // From GitHub's API itself: asked where it leads again with the token, then fetched there with it, following no redirect.
    const fromApi = recorded();
    const located: (Record<string, string> | undefined)[] = [];
    const direct: Locate = async (_url, _signal, h) => {
      located.push(h);
      return { status: 200 };
    };
    const to = join(dir, 'parts-whole-api.dmg');
    await download({ fetch: fromApi.fetch, connections: cdn(body, 4, { answer: () => 200 }).connections, locate: direct, asset: api, to, minPart, headers });
    expect(readFileSync(to)).toEqual(body);
    expect(located).toEqual([headers, headers]);
    expect(fromApi.asked).toEqual([{ url: api.url, init: { headers, signal: expect.any(AbortSignal), redirect: 'error' } }]);
    // Refused there meanwhile: the installer itself, without it.
    const refusedNow = recorded();
    let asks = 0;
    const thenRefused: Locate = async () => (++asks === 1 ? { status: 200 } : { status: 401 });
    await download({ fetch: refusedNow.fetch, connections: cdn(body, 4, { answer: () => 200 }).connections, locate: thenRefused, asset: api, to, minPart, headers });
    expect(refusedNow.asked).toEqual([{ url: api.fallback, init: { signal: expect.any(AbortSignal) } }]);
  });

  it('gives a connection done with its part the second half of what the slowest one has left', async () => {
    // The first connection sends a KB every 40 ms, the others at once.
    const served = cdn(body, 4, { pause: (a) => (a.conn === 0 ? 40 : 0) });
    const to = join(dir, 'parts-slow.dmg');
    await download({ fetch: single(body).fetch, connections: served.connections, locate: github().locate, asset: copy, to, minPart });
    expect(readFileSync(to)).toEqual(body);
    const slow = served.asked.filter((a) => a.conn === 0);
    expect(slow).toHaveLength(1);
    // It stopped where another connection took over, before the end it asked for.
    expect(slow[0]!.cancelled).toBe(true);
    expect(slow[0]!.sent).toBeLessThan(quarter);
    const taken = served.asked.slice(4);
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every((a) => a.conn !== 0 && a.from > 0 && a.to <= quarter)).toBe(true);
  });

  it('asks for a part again from where its connection dropped, and gives up after a few drops, keeping nothing', async () => {
    const served = cdn(body, 4, { cut: (a) => (a.from === quarter ? 5 * 1024 : undefined) });
    const to = join(dir, 'parts-drop.dmg');
    await download({ fetch: single(body).fetch, connections: served.connections, locate: github().locate, asset: copy, to, minPart });
    expect(readFileSync(to)).toEqual(body);
    expect(served.asked.filter((a) => a.from === quarter + 5 * 1024)).toHaveLength(1);
    // Every connection drops after 2 KB: one more drop than PART_FAILURES fails it.
    const drops = cdn(body, 4, { cut: () => 2048 });
    const failed = join(dir, 'parts-drops.dmg');
    const err = await failure(download({ fetch: single(body).fetch, connections: drops.connections, locate: github().locate, asset: copy, to: failed, minPart }));
    expect(err).toBeInstanceOf(UpdateError);
    expect(err?.failure).toBe('download');
    expect(err?.message).toBe('connection reset');
    expect(drops.asked).toHaveLength(4 + PART_FAILURES);
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(`${failed}.part`)).toBe(false);
  });

  it('finds the file again when its signed address has expired, once however many parts find it, and gives up on one that keeps expiring', async () => {
    // The parts taken from the slow connection are refused at the first address, which has expired since.
    const gh = github();
    const served = cdn(body, 4, { pause: (a) => (a.conn === 0 ? 40 : 0), answer: (a) => (a.url === `${CDN}1` && a.from % quarter !== 0 ? 403 : 206) });
    const to = join(dir, 'parts-expired.dmg');
    await download({ fetch: single(body).fetch, connections: served.connections, locate: gh.locate, asset: copy, to, minPart });
    expect(readFileSync(to)).toEqual(body);
    expect(gh.located).toEqual([copy.url, copy.url]);
    expect(served.asked.some((a) => a.url === `${CDN}2`)).toBe(true);
    // Every address refusing them: located again PART_FAILURES times, then given up on.
    const again = github();
    const refused = cdn(body, 4, { pause: (a) => (a.conn === 0 ? 40 : 0), answer: (a) => (a.from % quarter !== 0 ? 403 : 206) });
    const err = await failure(download({ fetch: single(body).fetch, connections: refused.connections, locate: again.locate, asset: copy, to: join(dir, 'parts-refused.dmg'), minPart }));
    expect(err?.failure).toBe('download');
    expect(err?.message).toBe('HTTP 403');
    expect(again.located).toHaveLength(1 + PART_FAILURES);
  });

  it('downloads in one request, from where GitHub sends it, when the CDN sends the whole file for a part', async () => {
    const whole = single(body);
    const gh = github();
    const to = join(dir, 'parts-whole.dmg');
    await download({ fetch: whole.fetch, connections: cdn(body, 4, { answer: () => 200 }).connections, locate: gh.locate, asset: copy, to, minPart });
    expect(readFileSync(to)).toEqual(body);
    expect(gh.located).toEqual([copy.url]);
    expect(whole.asked).toEqual([`${CDN}1`]);
  });

  it('asks again for a part that goes without a byte, and gives up when none of them gets one', async () => {
    // The second part's first answer sends nothing; the others a KB every 10 ms.
    let first = true;
    const served = cdn(body, 4, {
      pause: (a) => {
        if (a.from !== quarter || !first) return 10;
        first = false;
        return 60_000;
      },
    });
    const to = join(dir, 'parts-stalled.dmg');
    await download({ fetch: single(body).fetch, connections: served.connections, locate: github().locate, asset: copy, to, minPart, stallMs: 300 });
    expect(readFileSync(to)).toEqual(body);
    expect(served.asked.filter((a) => a.from === quarter)).toHaveLength(2);
    // None sends a byte, or GitHub never answers.
    const failed = join(dir, 'parts-silent.dmg');
    const silent = await failure(download({ fetch: single(body).fetch, connections: cdn(body, 4, { pause: () => 60_000 }).connections, locate: github().locate, asset: copy, to: failed, minPart, stallMs: 100 }));
    expect(silent?.failure).toBe('download');
    expect(silent?.message).toMatch(/no data/);
    const never: Locate = (_url, signal) => new Promise((_, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }));
    const unanswered = await failure(download({ fetch: single(body).fetch, connections: cdn(body, 4).connections, locate: never, asset: copy, to: failed, minPart, stallMs: 100 }));
    expect(unanswered?.message).toMatch(/no data/);
    expect(existsSync(`${failed}.part`)).toBe(false);
  });

  it('deletes parts that do not add up to the checksum', async () => {
    const to = join(dir, 'parts-bad.dmg');
    const err = await failure(download({ fetch: single(body).fetch, connections: cdn(Buffer.alloc(body.length), 4).connections, locate: github().locate, asset: copy, to, minPart }));
    expect(err?.failure).toBe('checksum');
    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it('downloads on six connections at most, in parts of a megabyte at least, failing after three failed parts', () => {
    expect(DOWNLOAD_CONNECTIONS).toBe(6);
    expect(MIN_PART_BYTES).toBe(1024 * 1024);
    expect(PART_FAILURES).toBe(3);
  });
});

describe('putting the new version in place', () => {
  it('names a new AppImage after its version when the running one was named after its own', () => {
    expect(appImageTarget('/home/me/Apps/Harness-Relay-2026-11-10-linux-x86_64.AppImage', 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10')).toBe(
      join('/home/me/Apps', 'Harness-Relay-2026-11-12-linux-x86_64.AppImage'),
    );
    // A name the user gave it (a launcher may use it) stays.
    expect(appImageTarget('/home/me/bin/harness-relay.AppImage', 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10')).toBe('/home/me/bin/harness-relay.AppImage');
  });

  posixIt('puts the AppImage in place, runnable, and removes the old one when it was renamed', () => {
    const apps = join(dir, 'apps');
    mkdirSync(apps);
    const old = join(apps, 'Harness-Relay-2026-11-10-linux-x86_64.AppImage');
    writeFileSync(old, 'old');
    const downloaded = join(apps, '.new.download');
    writeFileSync(downloaded, 'new');
    const target = appImageTarget(old, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10');
    placeAppImage(downloaded, target, old);
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(existsSync(old)).toBe(false);
    // In place, under the same name.
    const same = join(apps, 'mine.AppImage');
    writeFileSync(same, 'old');
    writeFileSync(downloaded, 'newer');
    placeAppImage(downloaded, same, same);
    expect(readFileSync(same, 'utf8')).toBe('newer');
  });

  it('swaps the Mac app with the staged one, keeping the old aside until the next start', () => {
    const apps = join(dir, 'Applications');
    const app = join(apps, 'Harness Relay.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'v'), 'old');
    const { staged, old } = macStaging(app);
    expect(staged).toBe(join(apps, '.Harness Relay.app.update'));
    mkdirSync(join(staged, 'Contents'), { recursive: true });
    writeFileSync(join(staged, 'Contents', 'v'), 'new');
    swapMacApp(app);
    expect(readFileSync(join(app, 'Contents', 'v'), 'utf8')).toBe('new');
    expect(readFileSync(join(old, 'Contents', 'v'), 'utf8')).toBe('old');
    expect(existsSync(staged)).toBe(false);
    removeMacLeftovers(app);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(app)).toBe(true);
  });

  it('leaves the Mac app as it was when there is nothing to swap in', () => {
    const app = join(dir, 'Lonely', 'Harness Relay.app');
    mkdirSync(app, { recursive: true });
    expect(() => swapMacApp(app)).toThrow(UpdateError);
    expect(existsSync(app)).toBe(true);
    expect(existsSync(macStaging(app).old)).toBe(false);
  });

  macIt(
    'copies the app out of a disk image and checks its signature, identity and version (macOS)',
    async () => {
      // A small app, signed ad hoc like the real one, in a disk image.
      const src = join(dir, 'dmg-src');
      const bundle = join(src, 'Harness Relay.app');
      mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(bundle, 'Contents', 'MacOS', 'Harness Relay'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bundle, 'Contents', 'MacOS', 'Harness Relay'), 0o755);
      const plist = (id: string, version: string) =>
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>Harness Relay</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
      writeFileSync(join(bundle, 'Contents', 'Info.plist'), plist('io.github.agentic-system-lab.harness-relay', '2026.1112.0'));
      execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', bundle], { stdio: 'ignore' });
      const dmg = join(dir, 'update.dmg');
      execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', src, '-format', 'UDZO', '-volname', 'Harness Relay', dmg]);

      const app = join(dir, 'Apps', 'Harness Relay.app');
      mkdirSync(app, { recursive: true });
      const staged = await stageMacApp({ dmg, app, bundleId: 'io.github.agentic-system-lab.harness-relay', semver: '2026.1112.0', env: process.env });
      expect(staged).toBe(macStaging(app).staged);
      expect(existsSync(join(staged, 'Contents', 'MacOS', 'Harness Relay'))).toBe(true);

      // Another app, or another version, is not put in place.
      for (const [bundleId, semver] of [
        ['com.example.other', '2026.1112.0'],
        ['io.github.agentic-system-lab.harness-relay', '2026.1113.0'],
      ]) {
        const err = await stageMacApp({ dmg, app, bundleId: bundleId!, semver: semver!, env: process.env }).catch((e: unknown) => e);
        expect((err as UpdateError).failure).toBe('verify');
        expect(existsSync(macStaging(app).staged)).toBe(false);
      }
      // A disk image that is not one.
      writeFileSync(join(dir, 'broken.dmg'), 'not a disk image');
      const broken = await stageMacApp({ dmg: join(dir, 'broken.dmg'), app, bundleId: 'x', semver: 'y', env: process.env }).catch((e: unknown) => e);
      expect((broken as UpdateError).failure).toBe('unpack');
    },
    120_000,
  );
});

describe('waiting for the conversations', () => {
  /** A server that answers with the next number of `answers` (the last one again once they run out). */
  function server(answers: (number | undefined)[]) {
    let asked = 0;
    return {
      get asked() {
        return asked;
      },
      busy: async () => answers[Math.min(asked++, answers.length - 1)],
    };
  }
  const never = new Promise<void>(() => {});

  it('switches at once when no conversation has agents at work', async () => {
    const s = server([0]);
    const waiting: (number | undefined)[] = [];
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 1, onWaiting: (n) => waiting.push(n) })).toBe('idle');
    expect(s.asked).toBe(1);
    expect(waiting).toEqual([]);
  });

  it('asks again until none has, saying how many have meanwhile, and asks again when the server does not answer', async () => {
    const s = server([2, 1, undefined, 1, 0]);
    const waiting: (number | undefined)[] = [];
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 1, onWaiting: (n) => waiting.push(n) })).toBe('idle');
    expect(waiting).toEqual([2, 1, undefined, 1]);
    expect(s.asked).toBe(5);
  });

  it('waits between questions', async () => {
    const s = server([1, 0]);
    const started = Date.now();
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 60 })).toBe('idle');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('asks the server while it runs; switches once it stopped by itself; never while it starts or stops, nor once the app quits', () => {
    const at = (server: 'stopped' | 'starting' | 'running' | 'stopping', o: { starting?: boolean; quitting?: boolean } = {}) =>
      busyWithoutAsking(server, { starting: o.starting ?? false, quitting: o.quitting ?? false });
    expect(at('running')).toBe('ask');
    expect(at('stopped')).toBe(0); // a crash: nothing runs
    // A restart from the menu, or a server on its way down: wait on.
    expect(at('stopping')).toBeUndefined();
    expect(at('starting')).toBeUndefined();
    expect(at('stopped', { starting: true })).toBeUndefined(); // the app reads the shell's environment before it starts the server
    // Quitting (also as the system shuts down) never switches, whatever the server does.
    for (const server of ['running', 'stopped', 'starting', 'stopping'] as const) expect(at(server, { quitting: true }), server).toBeUndefined();
  });

  it('does not switch while the number is unknown, however long that lasts', async () => {
    let settled = false;
    let asked = 0;
    let switchNow!: () => void;
    const waiting = whenIdle({
      busy: async () => (asked++, undefined),
      now: new Promise<void>((r) => (switchNow = r)),
      everyMs: 1,
    }).then((how) => ((settled = true), how));
    // Asked again and again (as often as the system's timers allow: every 15.6 ms on Windows).
    await vi.waitFor(() => expect(asked).toBeGreaterThan(5));
    expect(settled).toBe(false);
    switchNow();
    expect(await waiting).toBe('now');
  });

  it('switches at once when the user chooses to, while waiting or while the server is being asked', async () => {
    let switchNow!: () => void;
    const now = new Promise<void>((r) => (switchNow = r));
    const s = server([3]);
    const waiting = whenIdle({ busy: s.busy, now, everyMs: 60_000, onWaiting: () => switchNow() });
    expect(await waiting).toBe('now');

    let go!: () => void;
    const asked = new Promise<void>((r) => (go = r));
    const slow = whenIdle({ busy: () => new Promise<number>(() => {}), now: asked, everyMs: 1 });
    go();
    expect(await slow).toBe('now');
  });
});

describe('what an update leaves next to the AppImage', () => {
  it('downloads the new AppImage hidden next to the running one', () => {
    expect(appImageDownload('/home/me/Apps/Harness-Relay-2026-11-10-linux-arm64.AppImage', 'Harness-Relay-2026-11-12-linux-arm64.AppImage')).toBe(
      join('/home/me/Apps', '.Harness-Relay-2026-11-12-linux-arm64.AppImage.download'),
    );
  });

  it('removes a download never put in place, and its part, but nothing else', () => {
    const apps = join(dir, 'leftovers');
    mkdirSync(apps);
    const running = join(apps, 'Harness-Relay-2026-11-10-linux-x86_64.AppImage');
    const kept = [running, join(apps, 'notes.download'), join(apps, '.other.AppImage.download'), join(apps, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage')];
    const left = [
      appImageDownload(running, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage'),
      `${appImageDownload(running, 'Harness-Relay-2026-11-13-rc-linux-x86_64.AppImage')}.part`,
    ];
    for (const f of [...kept, ...left]) writeFileSync(f, 'x');
    removeAppImageLeftovers(running);
    for (const f of kept) expect(existsSync(f), f).toBe(true);
    for (const f of left) expect(existsSync(f), f).toBe(false);
  });
});

describe('starting the new version', () => {
  it('opens the Mac app, or runs the AppImage with its arguments, with the pid and the path in the environment only', () => {
    const mac = relaunchCommand('darwin', 42, '/Applications/Harness Relay.app', { PATH: '/bin' });
    expect(mac.bin).toBe('/bin/sh');
    expect(mac.args).toEqual(['-c', expect.stringContaining('exec /usr/bin/open "$target"'), 'sh']);
    expect(mac.env).toEqual({ PATH: '/bin', [RELAUNCH_PID]: '42', [RELAUNCH_TARGET]: '/Applications/Harness Relay.app' });
    const linux = relaunchCommand('linux', 42, '/home/me/H.AppImage', { PATH: '/bin' }, ['--no-sandbox']);
    expect(linux.args).toEqual(['-c', expect.stringContaining('exec "$target" "$@"'), 'sh', '--no-sandbox']);
    expect(linux.env).toEqual({ PATH: '/bin', [RELAUNCH_PID]: '42', [RELAUNCH_TARGET]: '/home/me/H.AppImage' });
    // The script is fixed text, whatever the path.
    expect(relaunchCommand('linux', 7, `/home/me/'$(id)'.AppImage`, {}).args).toEqual(['-c', linux.args[1], 'sh']);
  });

  it("starts the new AppImage without the old one's runtime variables", () => {
    expect(relaunchEnv({ PATH: '/bin', APPIMAGE: '/a', APPDIR: '/tmp/.mount', ARGV0: 'x', OWD: '/home' })).toEqual({ PATH: '/bin' });
  });

  posixIt(
    'waits for the app to exit before starting the new version',
    async () => {
      const marker = join(dir, 'started');
      const app = spawn('/bin/sh', ['-c', 'sleep 0.5'], { stdio: 'ignore' });
      const exited = new Promise((r) => app.on('exit', r));
      const start = relaunchCommand('linux', app.pid!, '/bin/sh', { ...process.env, MARKER: marker }, ['-c', 'date +%s%N > "$MARKER"']);
      await spawnDetached(start.bin, start.args, start.env);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false); // the app still runs
      await exited;
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(marker)).toBe(true);
    },
    20_000,
  );

  posixIt(
    'starts a new version whose path has spaces, quotes and $(…) in it as it is, without the variables that pointed to it',
    async () => {
      const out = join(dir, 'relaunched');
      // Were the path read as shell code, it would make this file and fail to start the new version.
      const folder = join(dir, `new "version" 'here' $(touch $OUT.code)`);
      mkdirSync(folder);
      const target = join(folder, 'H.AppImage');
      writeFileSync(target, '#!/bin/sh\n{ env; printf \'arg=%s\\n\' "$@"; } > "$OUT.part" && mv "$OUT.part" "$OUT"\n');
      chmodSync(target, 0o755);
      const gone = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
      await new Promise((r) => gone.on('exit', r));
      const start = relaunchCommand('linux', gone.pid!, target, { ...process.env, OUT: out }, ['--no-sandbox', 'two words']);
      await spawnDetached(start.bin, start.args, start.env);
      for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
      const seen = readFileSync(out, 'utf8');
      expect(seen).toContain('arg=--no-sandbox\narg=two words\n');
      expect(seen).not.toContain(RELAUNCH_PID);
      expect(seen).not.toContain(RELAUNCH_TARGET);
      expect(existsSync(`${out}.code`)).toBe(false);
    },
    20_000,
  );
});
