import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_APPS } from '../src/shared/apps';
import type { GithubConnection, HostedAppStatus, Provider, ProviderStatus, TeamsConnection } from '../src/shared/types';
import { draftAvailability } from '../src/server/connectors/draftAvailability';
import { openDatabase } from '../src/server/db';
import { SettingsStore } from '../src/server/settings';
import type { HostedAppChecks } from '../src/server/connectors/hostedApps';

describe('apps that can be selected in a new draft', () => {
  const db = () => openDatabase(':memory:');
  let database: ReturnType<typeof db>, settings: SettingsStore, read: ReturnType<typeof draftAvailability>;
  let loggedIn: boolean | null, installed: boolean;
  const status = vi.fn<(provider: Provider) => Promise<ProviderStatus>>();
  const github = vi.fn<() => Promise<GithubConnection>>();
  const teams = vi.fn<() => Promise<TeamsConnection>>();
  const hosted = vi.fn<HostedAppChecks['check']>();
  beforeEach(() => {
    vi.resetAllMocks();
    status.mockImplementation(async (provider) => {
      const auth = { loggedIn };
      return {
        provider,
        bin: provider,
        auth,
        installed,
        usingStoredApiKey: false,
        accounts: [{ auth, id: '', label: '', usingStoredApiKey: false }],
      };
    });
    installed = true;
    loggedIn = true;
    database = db();
    settings = new SettingsStore(database);
    settings.tools.gatewayStatus = () => ({ available: true });
    teams.mockResolvedValue({ status: 'signed-out' });
    github.mockResolvedValue({ status: 'signed-out' });
    hosted.mockResolvedValue('not-found');
    read = draftAvailability(settings, settings.oauth, { status }, { status: teams }, { check: hosted }, github);
  });
  afterEach(() => database.close());
  it('returns only availability, and local checks never contact Slack, Teams or GitHub', async () => {
    const state = await read('read-only', 'local');
    expect(Object.keys(state).sort()).toEqual([...DRAFT_APPS].sort());
    expect(state).toEqual({
      mail: 'needs-connection',
      calendar: 'needs-connection',
      drive: 'needs-connection',
      notion: 'needs-connection',
      heptabase: 'needs-connection',
      obsidian: 'needs-connection',
      browser: 'needs-install',
      teams: 'unavailable',
      github: 'unavailable',
      slack: 'unavailable',
    });
    for (const probe of [github, teams, hosted, status]) expect(probe).not.toHaveBeenCalled();
  });
  it('requires a usable assistant, the team permission, an installed browser and a usable gateway transport', async () => {
    settings.tools.browserStatus = () => ({ using: 'fixture-browser' });
    const check = async () => (await read('read-only', 'browser')).browser;
    expect(await check()).toBe('needs-assistant');
    settings.tools.update({ relayTools: { browser: ['pi'] } });
    expect(await check()).toBe('needs-assistant');
    expect((await read('full', 'browser')).browser).toBe('ready');
    settings.tools.update({ relayTools: { browser: ['claude'] } });
    expect(await check()).toBe('ready');
    loggedIn = null;
    expect(await check()).not.toBe('ready');
    loggedIn = true;
    installed = false;
    expect(await check()).not.toBe('ready');
    installed = true;
    settings.tools.gatewayStatus = () => ({ available: true, reason: 'no-node' });
    expect(await check()).not.toBe('ready');
    settings.tools.update({ relayTools: { browser: ['codex'] } });
    expect(await check()).toBe('ready');
    settings.tools.gatewayStatus = () => ({ available: false, reason: 'not-started' });
    expect(await check()).toBe('unavailable');
  });
  it.each(['linux', 'win32'] as const)('respects open-agent sandbox support on %s for both gateway and MCP apps', async (platform) => {
    read = draftAvailability(settings, settings.oauth, { status }, { status: teams }, { check: hosted }, github, platform);
    settings.tools.browserStatus = () => ({ using: 'browser' });
    settings.tools.update({ relayTools: { browser: ['opencode'] } });
    vi.spyOn(settings.tools, 'signedInAppServers').mockReturnValue([['opencode']]);
    expect(await read('read-only', 'local')).toMatchObject({ browser: 'needs-assistant', notion: 'needs-assistant' });
    expect(await read('full', 'local')).toMatchObject({ browser: 'ready', notion: 'ready' });
  });
  it('requires each OAuth use and a selected calendar, respects revocation and leaves a separately connected CalDAV calendar usable', async () => {
    settings.tools.update({ relayTools: { mail: ['codex'], calendar: ['codex'], drive: ['codex'] } });
    const oauth = settings.oauth.store;
    oauth.saveClient('google', { clientId: 'test', secret: 'test' });
    const docScope = 'https://www.googleapis.com/auth/documents';
    const identity = { subject: 'sub', email: 'test@example.org' };
    const id = oauth.signedIn('google', identity, ['mail', 'documents', 'calendar'], [docScope], 'fixture', 1).id;
    expect(await read('edit', 'local')).toMatchObject({ mail: 'needs-connection', calendar: 'needs-connection', drive: 'ready' });
    settings.connectors.saveOAuthCalendar('calendar', {
      name: 'Calendar',
      url: 'https://calendar.example.test',
      oauth: id,
      email: identity.email,
    });
    const server = { host: 'example.test', port: 993, security: 'tls' } as const;
    settings.connectors.saveOAuthMail('mail', { name: 'Mail', imap: server, smtp: server, oauth: id, email: identity.email });
    expect(await read('edit', 'local')).toMatchObject({ mail: 'ready', calendar: 'ready', drive: 'ready' });
    oauth.setClientDisabled('google', true);
    expect(await read('edit', 'local')).toMatchObject({
      mail: 'needs-connection',
      calendar: 'needs-connection',
      drive: 'needs-connection',
    });
    oauth.setClientDisabled('google', false);
    oauth.needsSignIn(id, 'revoked');
    expect(await read('read-only', 'local')).toMatchObject({
      mail: 'needs-connection',
      calendar: 'needs-connection',
      drive: 'needs-connection',
    });
    settings.connectors.saveCalendar('other', {
      url: 'https://other.example.test',
      name: 'CalDAV',
      username: 'test',
      password: 'password',
    });
    expect((await read('read-only', 'calendar')).calendar).toBe('ready');
  });
  it('rechecks on-disk vaults and the assistants granted an official MCP connection', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-picker-')));
    try {
      mkdirSync(join(root, '.obsidian'));
      settings.tools.addObsidianVaults([root]);
      settings.tools.update({ relayTools: { obsidian: ['claude'] } });
      expect((await read('edit', 'obsidian')).obsidian).toBe('ready');
      rmSync(join(root, '.obsidian'), { recursive: true });
      expect((await read('edit', 'obsidian')).obsidian).toBe('needs-connection');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    settings.tools.ensureApp('notion');
    expect((await read('read-only', 'notion')).notion).toBe('needs-connection');
    vi.spyOn(settings.tools, 'signedInAppServers').mockReturnValue([['antigravity']]);
    expect((await read('edit', 'notion')).notion).toBe('needs-assistant');
    vi.mocked(settings.tools.signedInAppServers).mockReturnValue([['codex']]);
    expect((await read('edit', 'notion')).notion).toBe('ready');
  });
  it('separates missing, signed out, connected and failed probes, and prevents remote failure from hiding local results', async () => {
    settings.tools.update({ relayTools: { github: ['codex'], teams: ['codex'] } });
    github.mockResolvedValueOnce({ status: 'missing' });
    teams.mockResolvedValueOnce({ status: 'missing-module' });
    expect(await read('read-only')).toMatchObject({ github: 'needs-install', teams: 'needs-install' });
    github.mockRejectedValueOnce(Error('private hostname'));
    expect(await read('read-only')).toMatchObject({ github: 'unavailable', teams: 'needs-connection', mail: 'needs-connection' });
    github.mockResolvedValueOnce({ status: 'connected', login: 'private' });
    teams.mockResolvedValueOnce({ status: 'connected', account: 'private' });
    expect(await read('read-only')).toMatchObject({ github: 'ready', teams: 'ready' });
  });
  it('never reads a Slack profile on open and isolates failed providers from working ones', async () => {
    hosted.mockImplementation(async (_app, p, _account, mode): Promise<HostedAppStatus> => {
      if (p === 'claude') throw Error('offline');
      return mode === true ? 'connected' : 'available';
    });
    expect((await read('edit', 'slack')).slack).toBe('needs-verification');
    expect(hosted.mock.calls.every(([, , , mode]) => mode === 'draft')).toBe(true);
    expect((await read('edit', 'slack', true)).slack).toBe('ready');
    hosted.mockClear();
    vi.spyOn(settings.slackPosting, 'view').mockReturnValue({ status: 'connected', sender: 'private', workspace: 'private' });
    settings.tools.update({ relayTools: { slack: ['codex'] } });
    expect((await read('edit', 'slack')).slack).toBe('ready');
    expect(hosted).not.toHaveBeenCalled();
  });
});
