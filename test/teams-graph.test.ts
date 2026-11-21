import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TeamsGraph } from '../src/server/connectors/teams';
import { CONNECT_TEAMS, INSTALL_TEAMS, POST_TEAMS, PROBE_TEAMS } from '../src/server/connectors/teamsPowerShell';
import { findOnPath } from '../src/server/executable';
import { portableInstallEnv } from '../src/server/portableInstall';
import { t } from '../src/server/i18n';
import { CommandNotFoundError, runProcess } from '../src/server/process';
import { slow } from './timeouts';

const pwsh = findOnPath('pwsh', process.env, process.platform);

type Runner = NonNullable<ConstructorParameters<typeof TeamsGraph>[0]>;
type Call = {
  script: string;
  options: Parameters<Runner>[1];
  complete: (code: number | null) => void;
  requests: { id: number; uri: string; text?: string }[];
};

function helper(installRuntime = vi.fn(async (_signal: AbortSignal) => {})) {
  const calls: Call[] = [];
  const teams = new TeamsGraph(
    (script, options) =>
      new Promise((resolve) => {
        const call: Call = { script, options, complete: resolve, requests: [] };
        calls.push(call);
        const stdin = new Writable({
          write: (data, _encoding, done) => {
            call.requests.push(JSON.parse(data.toString()));
            done();
          },
        });
        options.onSpawn?.({ stdin } as ChildProcess);
      }),
    installRuntime,
  );
  return { teams, calls };
}

const prompt = (url = 'https://login.microsoft.com/device') =>
  'To sign in, use a web browser to open the page ' + url + ' and enter the code ABCD12345 to authenticate.';
function emit(call: Call, payload: unknown) {
  call.options.onLine?.('RELAY ' + JSON.stringify(payload));
}

const tenantId = 'a1234567-1234-1234-1234-123456789abc';
const senderId = 'b1234567-1234-1234-1234-123456789abc';
const teamId = 'c1234567-1234-1234-1234-123456789abc';
const channel = '19:work@thread.tacv2';
const chat = '19:friends@thread.v2';
const sender = 'person@school.example';
const chatLink = 'https://teams.microsoft.com/l/chat/' + encodeURIComponent(chat) + '/conversations';
const channelLink =
  'https://teams.microsoft.com/l/message/' + encodeURIComponent(channel) + '/123?groupId=' + teamId + '&tenantId=' + tenantId;

async function connected() {
  const { teams, calls } = helper();
  await teams.connect();
  const [session] = calls;
  session.options.onLine?.(prompt());
  emit(session, { account: sender, tenantId });
  return { teams, calls, session };
}

describe('the Teams Graph PowerShell connection', () => {
  it('a status check only probes the dependency, and disconnected reads never run a program', async () => {
    const { teams, calls } = helper();
    await expect(teams.list()).rejects.toThrow(t().appsConnectFirst);
    expect(calls).toHaveLength(0);
    const probes = [teams.status(), teams.status()];
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(PROBE_TEAMS);
    expect(PROBE_TEAMS).toContain('try { Import-Module -Name $name -ErrorAction Stop } catch { exit 21 }');
    expect(PROBE_TEAMS).not.toMatch(/Connect-MgGraph|Save-PSResource|Save-Module/);
    calls[0].complete(21);
    expect(await Promise.all(probes)).toEqual([{ status: 'missing-module' }, { status: 'missing-module' }]);
    const missing = new TeamsGraph(async () => {
      throw new CommandNotFoundError('pwsh');
    });
    expect(await missing.status()).toEqual({ status: 'missing-powershell' });
  });

  it('downloads a missing module only after an explicit action, into Relay’s folder from the official repository', async () => {
    const { teams, calls } = helper();
    expect(await teams.install()).toEqual({ status: 'installing' });
    expect(await teams.connect()).toEqual({ status: 'installing' });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(INSTALL_TEAMS);
    expect(INSTALL_TEAMS).toContain("$version = '2.41.2'");
    expect(INSTALL_TEAMS).toContain('"https://www.powershellgallery.com/api/v2/package/Microsoft.Graph.Authentication/$version"');
    expect(INSTALL_TEAMS).toMatch(/\$sha512 = '[a-f0-9]{128}'/);
    const verification =
      '(Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $package -Algorithm SHA512).Hash -ne $sha512) { exit 22 }';
    const steps = [
      'Invoke-WebRequest -Uri $uri -OutFile $package',
      verification,
      'ExtractToDirectory($package, $moduleDir)',
      'Import-Module -Name $manifest -ErrorAction Stop',
    ];
    const positions = steps.map((step) => INSTALL_TEAMS.indexOf(step));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(INSTALL_TEAMS).not.toMatch(/Import-Module -Name \$name|Save-PSResource|Save-Module|Install-Module|Install-PSResource/);
    for (const script of [PROBE_TEAMS, INSTALL_TEAMS, CONNECT_TEAMS, POST_TEAMS]) {
      expect(script).toContain(
        "PSModulePath = @($env:RELAY_TEAMS_MODULES, [IO.Path]::Combine($PSHOME, 'Modules'), $userModules, $systemModules)",
      );
    }
    calls[0].complete(22);
    await expect.poll(() => teams.status()).toEqual({ status: 'error', message: t().teamsSetupFailed, retry: 'install' });
    await teams.install();
    calls[1].complete(0);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].script).toBe(PROBE_TEAMS);
    calls[2].complete(0);
    await vi.waitFor(() => expect(calls[2].options.signal?.aborted).toBe(true));
    const state = teams.status();
    calls[3].complete(0);
    expect(await state).toEqual({ status: 'signed-out' });
  });

  // A real pwsh: this ran in under a second on GitHub's Ubuntu runners, and takes 3 to over 5 s on their
  // image of 2026-11-16, past Vitest's own 5 s. The test waits longer than the process may run.
  it.skipIf(!pwsh)('rejects changed package bytes before extracting or importing them', { timeout: slow(30_000) }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-graph-digest-'));
    try {
      const stage = join(dir, 'modules');
      await mkdir(stage);
      const file = join(dir, 'package.fixture');
      await writeFile(file, 'incomplete package');
      // Stand in for the network transfer; run the real checksum and extraction code in PowerShell.
      const download = 'Microsoft.PowerShell.Utility\\Invoke-WebRequest -Uri $uri -OutFile $package -TimeoutSec 90';
      expect(INSTALL_TEAMS).toContain(download);
      const script = INSTALL_TEAMS.replace(download, '[IO.File]::Copy($env:FIXTURE_PACKAGE, $package)');
      expect(script).not.toContain('Invoke-WebRequest');
      const result = await runProcess({
        bin: pwsh!,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        env: {
          ...portableInstallEnv(),
          RELAY_TEAMS_MODULE_STAGE: stage,
          RELAY_TEAMS_MODULES: stage,
          RELAY_TEAMS_USER_MODULES: stage,
          FIXTURE_PACKAGE: file,
        },
        timeoutMs: slow(15_000),
      });
      expect(result.code).toBe(22);
      expect(await readdir(stage)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prepares PowerShell and Graph once, then verifies the module without signing in', async () => {
    const runtime = vi.fn(async (_signal: AbortSignal) => {});
    const { teams, calls } = helper(runtime);
    const installing = { status: 'installing' };
    expect(await Promise.all([teams.install(), teams.install(), teams.connect()])).toEqual([installing, installing, installing]);
    expect(calls).toHaveLength(1);
    calls[0].complete(20);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(await teams.status()).toEqual(installing);
    calls[1].complete(0);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.script)).toEqual([INSTALL_TEAMS, INSTALL_TEAMS, PROBE_TEAMS]);
    calls[2].complete(21);
    await expect.poll(() => teams.status()).toMatchObject({ status: 'error', retry: 'install' });
  });

  it('keeps the desktop busy until cancelled runtime installation finishes cleaning up', async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const runtime = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const graph = new TeamsGraph(async () => 20, runtime);
    expect(graph.running()).toBe(0);
    await graph.install();
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledOnce());
    expect(graph.running()).toBe(1);
    const stopping = graph.shutdown();
    expect(signal.aborted).toBe(true);
    expect(graph.running()).toBe(1);
    finish();
    await stopping;
    expect(graph.running()).toBe(0);
  });

  it('a diagnostic that started before installation returns the newly verified state', async () => {
    let oldProbe!: (code: number) => void;
    let first = true;
    const graph = new TeamsGraph(async (script) => {
      if (script === PROBE_TEAMS && first) {
        first = false;
        return new Promise<number>((resolve) => {
          oldProbe = resolve;
        });
      }
      return 0;
    });
    const before = graph.status();
    await graph.install();
    await vi.waitFor(async () => expect(await graph.status()).toEqual({ status: 'signed-out' }));
    oldProbe(20);
    expect(await before).toEqual({ status: 'signed-out' });
  });

  it('retries a failed runtime download when no pwsh exists and serializes cancellation with a new request', async () => {
    let installed = false;
    let release!: () => void;
    const firstDownload = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = vi.fn(async (signal: AbortSignal) => {
      if (runtime.mock.calls.length === 1) {
        await firstDownload;
        signal.throwIfAborted();
      }
      if (runtime.mock.calls.length === 2) throw new Error('download refused');
      installed = true;
    });
    const run = vi.fn<Runner>(async () => {
      if (!installed) throw new CommandNotFoundError('pwsh');
      return 0;
    });
    const graph = new TeamsGraph(run, runtime);
    await graph.install();
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(1));
    graph.disconnect();
    await graph.install();
    expect(runtime).toHaveBeenCalledTimes(1);
    release();
    await expect.poll(() => graph.status()).toEqual({ status: 'missing-powershell' });
    await graph.install();
    await expect.poll(() => graph.status()).toMatchObject({ status: 'error', retry: 'install' });
    await graph.install();
    await expect.poll(() => graph.status()).toEqual({ status: 'signed-out' });
    expect(runtime).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map(([script]) => script)).not.toContain(CONNECT_TEAMS);
  });

  it.each(['https://login.microsoft.com/device', 'https://microsoft.com/devicelogin'])(
    'returns the code for the official Microsoft sign-in at %s',
    async (url) => {
      const { teams, calls } = helper();
      const pending = { status: 'signing-in' };
      expect(await teams.connect()).toEqual(pending);
      expect(await teams.connect()).toEqual(pending);
      expect(calls).toHaveLength(1);
      expect(calls[0].script).toBe(CONNECT_TEAMS);
      expect(CONNECT_TEAMS).toContain('-UseDeviceCode -ContextScope Process -TenantId organizations -Environment Global');
      calls[0].options.onLine?.(prompt(url + '.other.example') + ' private noise');
      expect(await teams.status()).toEqual(pending);
      calls[0].options.onLine?.(prompt(url));
      expect(await teams.status()).toEqual({ status: 'signing-in', code: 'ABCD12345', url });
      emit(calls[0], { account: 'person@work.example' });
      expect(await teams.status()).toEqual({ status: 'connected', account: 'person@work.example' });
      teams.disconnect();
      expect(calls[0].options.signal?.aborted).toBe(true);
    },
  );

  it.each([
    [24, 'oauthExpired'],
    [23, 'oauthNoTeamsAccess'],
  ] as const)('reports sign-in exit %i without exposing raw SDK exceptions', async (status, message) => {
    const { teams, calls } = helper();
    await teams.connect();
    calls[0].options.onLine?.(prompt());
    calls[0].complete(status);
    await Promise.resolve();
    expect(await teams.status()).toEqual({ status: 'error', message: t()[message] });
    expect(teams.connected()).toBe(false);
  });

  it('requires a fresh device challenge, even if the system module reports an account', async () => {
    const { teams, calls } = helper();
    await teams.connect();
    emit(calls[0], { account: 'another@work.example' });
    expect(teams.connected()).toBe(false);
    expect(await teams.status()).toEqual({ status: 'error', message: t().oauthNoTeamsAccess });
    expect(calls[0].options.signal?.aborted).toBe(true);
    await expect(teams.list()).rejects.toThrow(t().appsConnectFirst);
    expect(calls).toHaveLength(1);
  });

  it('issues only the three GETs, encodes IDs and matches concurrent reads to their own replies', async () => {
    const { teams, session } = await connected();
    const [list, channels, messages] = [teams.list(), teams.list('team'), teams.messages('team', '19:a@thread.tacv2')];
    for (const bad of ['.', '..', '../other', 'x?foo', 'http://example.org', 'a\ncmd', { id: 'a' }]) {
      await expect(teams.list(bad)).rejects.toThrow();
      await expect(teams.messages('team', bad)).rejects.toThrow();
    }
    expect(session.requests.map((r) => r.uri)).toEqual([
      'https://graph.microsoft.com/v1.0/me/joinedTeams',
      'https://graph.microsoft.com/v1.0/teams/team/channels?$select=id,displayName',
      'https://graph.microsoft.com/v1.0/teams/team/channels/19%3Aa%40thread.tacv2/messages?$top=20',
    ]);
    expect(CONNECT_TEAMS).toContain('Invoke-MgGraphRequest -Method GET');
    const reply = (index: number, row: unknown) =>
      emit(session, { id: session.requests[index].id, json: JSON.stringify({ value: [row] }) });
    reply(2, { createdDateTime: '2026-01-02', body: { content: 'a message' }, webUrl: 'https://teams.microsoft.com/' });
    reply(0, { id: 'team', displayName: 'Team name', tenantId: 'private metadata' });
    reply(1, { id: 'channel', displayName: 'Channel name' });
    expect(await Promise.all([list, channels, messages])).toEqual([
      { value: [{ id: 'team', displayName: 'Team name' }] },
      { value: [{ id: 'channel', displayName: 'Channel name' }] },
      [{ time: '2026-01-02', body: 'a message', link: 'https://teams.microsoft.com/' }],
    ]);
    const large = teams.list();
    emit(session, { id: session.requests[3].id, error: 'size' });
    await expect(large).rejects.toThrow(t().appsTooLarge);
    const forbidden = teams.list();
    emit(session, { id: session.requests[4].id, error: 'graph', status: 403 });
    await expect(forbidden).rejects.toThrow('HTTP 403');
    teams.disconnect();
  });

  it('closes and rejects in-flight reads on a fresh SDK challenge; late events cannot reconnect a cancelled or newer session', async () => {
    const { teams, calls, session } = await connected();
    const list = teams.list();
    session.options.onLine?.(prompt());
    await expect(list).rejects.toThrow(t().oauthNoTeamsAccess);
    expect(teams.connected()).toBe(false);
    expect(session.options.signal?.aborted).toBe(true);
    await teams.connect();
    session.complete(23);
    emit(session, { account: 'stale@work.example' });
    expect(await teams.status()).toEqual({ status: 'signing-in' });
    teams.disconnect();
    calls[1].options.onLine?.(prompt());
    emit(calls[1], { account: 'stale@work.example' });
    expect(teams.connected()).toBe(false);
    expect(calls[1].options.signal?.aborted).toBe(true);
  });

  it('gives each sequential Graph GET its own time to finish when several are requested at once', async () => {
    vi.useFakeTimers();
    try {
      const { teams, session } = await connected();
      const results = Promise.all([teams.list(), teams.list('team')]);
      for (const request of session.requests) {
        await vi.advanceTimersByTimeAsync(19000);
        emit(session, { id: request.id, json: '{"value":[]}' });
      }
      expect(await results).toEqual([{ value: [] }, { value: [] }]);
      expect(teams.connected()).toBe(true);
      teams.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds pending requests and closes a hung helper without issuing another sign-in', async () => {
    vi.useFakeTimers();
    try {
      const { teams, session, calls } = await connected();
      const requests = Array.from({ length: 8 }, () => teams.list());
      await expect(teams.list()).rejects.toThrow(t().teamsReadFailed);
      const done = Promise.allSettled(requests);
      await vi.advanceTimersByTimeAsync(30000);
      expect((await done).every((r) => r.status === 'rejected')).toBe(true);
      expect(session.requests).toHaveLength(8);
      expect(session.options.signal?.aborted).toBe(true);
      expect(teams.connected()).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('requests separate posting consent only on demand and binds it to the reading account and tenant', async () => {
    const { teams, calls, session } = await connected();
    expect(teams.canPost()).toBe(false);
    await expect(teams.resolvePost(channelLink)).rejects.toThrow(t().teamsPostingConnect);
    expect(calls).toHaveLength(1);
    expect(CONNECT_TEAMS).not.toContain('ChannelMessage.Send');
    expect(await teams.connectPosting()).toEqual({ status: 'connected', account: sender, posting: { status: 'signing-in' } });
    await teams.connectPosting();
    expect(calls).toHaveLength(2);
    const posting = calls[1];
    expect(posting.script).toBe(POST_TEAMS);
    for (const scope of ['ChannelMessage.Send', 'ChatMessage.Send', 'Chat.ReadBasic', 'User.Read']) expect(POST_TEAMS).toContain(scope);
    expect(POST_TEAMS).toContain('Set-MgRequestContext -MaxRetry 0');
    expect(POST_TEAMS).toContain("contentType = 'text'");
    posting.options.onLine?.(prompt());
    emit(posting, { account: sender, tenantId: teamId });
    expect(await teams.status()).toEqual({
      status: 'connected',
      account: sender,
      posting: { status: 'error', message: t().teamsPostingChanged },
    });
    await teams.connectPosting();
    calls[2].options.onLine?.(prompt());
    emit(calls[2], { account: 'other@school.example', tenantId });
    expect(teams.canPost()).toBe(false);
    await teams.connectPosting();
    calls[3].options.onLine?.(prompt());
    emit(calls[3], { account: sender, tenantId });
    expect(await teams.status()).toEqual({ status: 'connected', account: sender, canPost: true });
    teams.disconnectPosting();
    expect(calls[3].options.signal?.aborted).toBe(true);
    expect(session.options.signal?.aborted).toBe(false);
    expect(await teams.status()).toEqual({ status: 'connected', account: sender });
    teams.disconnect();
  });

  it('keeps destination-specific denials local and invalidates a revoked posting session while preserving read access', async () => {
    const { teams, calls, session } = await connected();
    await teams.connectPosting();
    const writer = calls[1];
    writer.options.onLine?.(prompt());
    emit(writer, { account: sender, tenantId });
    const forbidden = expect(teams.resolvePost(channelLink)).rejects.toThrow('HTTP 403');
    emit(writer, { id: writer.requests[0].id, error: 'graph', status: 403 });
    await forbidden;
    expect(teams.canPost()).toBe(true);
    const revoked = expect(teams.resolvePost(channelLink)).rejects.toThrow(t().teamsPostingConnect);
    emit(writer, { id: writer.requests[1].id, error: 'graph', status: 401 });
    await revoked;
    expect(teams.canPost()).toBe(false);
    expect(writer.options.signal?.aborted).toBe(true);
    expect(session.options.signal?.aborted).toBe(false);
    expect(await teams.status()).toEqual({
      status: 'connected',
      account: sender,
      posting: { status: 'error', message: t().teamsPostingConnect },
    });
    const read = teams.list();
    emit(session, { id: session.requests[0].id, json: '{"value":[]}' });
    await expect(read).resolves.toEqual({ value: [] });
    expect(calls).toHaveLength(2);
    teams.disconnect();
  });

  it.each(['channel', 'chat'] as const)(
    'resolves a %s by Graph metadata and posts only once under the previewed identity',
    async (kind) => {
      const { teams, calls } = await connected();
      await teams.connectPosting();
      const writer = calls[1];
      writer.options.onLine?.(prompt());
      emit(writer, { account: sender, tenantId });
      const me = 'me?$select=id';
      const team = 'teams/' + teamId;
      const channelRoute = team + '/channels/' + encodeURIComponent(channel);
      const chatRoute = 'chats/' + encodeURIComponent(chat);
      const full = (path: string) => 'https://graph.microsoft.com/v1.0/' + path;
      let index = 0;
      async function reply(path: string, value: unknown, body?: string, status?: number) {
        await vi.waitFor(() => expect(writer.requests.length).toBeGreaterThan(index));
        const request = writer.requests[index++];
        expect(request.uri).toBe(full(path));
        expect(request.text).toBe(body);
        emit(writer, status ? { id: request.id, error: 'graph', status } : { id: request.id, json: JSON.stringify(value) });
      }
      async function resolve(id = senderId, hostTenant = tenantId, teamTenant = tenantId) {
        await reply(me, { id });
        if (kind === 'channel') {
          await reply(team + '?$select=id,displayName,tenantId', { id: teamId, tenantId: teamTenant, displayName: 'Real team' });
          await reply(channelRoute + '?$select=id,displayName,tenantId', {
            id: channel,
            tenantId: hostTenant,
            displayName: 'Real channel',
          });
        } else {
          await reply(chatRoute + '?$expand=members', { id: chat, tenantId: hostTenant, members: [{ email: 'colleague@school.example' }] });
        }
      }
      for (const bad of [
        'Marketing',
        chatLink.replace('teams.microsoft.com', 'teams.microsoft.com.example'),
        chatLink + '?tenantId=' + teamId,
        channelLink.replace('groupId=', 'unknown='),
        chatLink.replace('friends', 'a%2Fb'),
      ]) {
        await expect(teams.resolvePost(bad)).rejects.toThrow(t().teamsPostingTarget);
      }
      expect(writer.requests).toHaveLength(0);
      const pending = teams.resolvePost(kind === 'channel' ? channelLink + '&channelName=Forged' : chatLink);
      await resolve();
      const target = await pending;
      expect(target).toMatchObject({
        tenantId,
        senderId,
        sender,
        kind,
        destination: kind === 'channel' ? 'Real team / Real channel' : 'colleague@school.example',
      });
      expect(writer.requests.every((r) => r.text === undefined)).toBe(true);
      const text = 'Hello 你好 <b>plain text</b>\nSecond line';
      const send = teams.sendPost(target, text);
      await resolve();
      await reply((kind === 'channel' ? channelRoute : chatRoute) + '/messages', { id: 'posted' }, text);
      await expect(send).resolves.toBeUndefined();
      const failed = expect(teams.sendPost(target, text)).rejects.toThrow(t().teamsPostFailed);
      await resolve();
      // A blank receipt and a Graph transport failure both leave delivery uncertain.
      await reply((kind === 'channel' ? channelRoute : chatRoute) + '/messages', {}, text, kind === 'chat' ? 503 : undefined);
      await failed;
      const changed = expect(teams.sendPost(target, text)).rejects.toThrow(t().teamsPostingChanged);
      await resolve(teamId);
      await changed;
      // Links can omit tenantId. Use the tenant Graph returns for the team and actual destination.
      const unscopedLink = kind === 'channel' ? channelLink.replace('&tenantId=' + tenantId, '') : chatLink;
      const foreign = expect(teams.resolvePost(unscopedLink)).rejects.toThrow(t().teamsPostingTarget);
      await resolve(senderId, teamId);
      await foreign;
      const moved = expect(teams.sendPost(target, text)).rejects.toThrow(t().teamsPostingTarget);
      await resolve(senderId, kind === 'channel' ? tenantId : teamId, teamId);
      await moved;
      expect(writer.requests.filter((r) => r.text !== undefined)).toHaveLength(2);
      teams.disconnect();
      expect(writer.options.signal?.aborted).toBe(true);
    },
  );
});
