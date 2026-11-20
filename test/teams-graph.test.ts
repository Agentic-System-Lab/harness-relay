import type { ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TeamsGraph } from '../src/server/connectors/teams';
import { CONNECT_TEAMS, INSTALL_TEAMS, POST_TEAMS, PROBE_TEAMS } from '../src/server/connectors/teamsPowerShell';
import { t } from '../src/server/i18n';
import { CommandNotFoundError } from '../src/server/process';

type Runner = NonNullable<ConstructorParameters<typeof TeamsGraph>[0]>;
type Call = {
  script: string;
  options: Parameters<Runner>[1];
  complete: (code: number | null) => void;
  requests: { id: number; uri: string; text?: string }[];
};

function helper() {
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
    expect(PROBE_TEAMS).not.toMatch(/Connect-MgGraph|Install-PSResource|Install-Module/);
    calls[0].complete(21);
    expect(await Promise.all(probes)).toEqual([{ status: 'missing-module' }, { status: 'missing-module' }]);
    const missing = new TeamsGraph(async () => {
      throw new CommandNotFoundError('pwsh');
    });
    expect(await missing.status()).toEqual({ status: 'missing-powershell' });
  });

  it('installs only after an explicit action, using the official repository and current user', async () => {
    const { teams, calls } = helper();
    expect(await teams.install()).toEqual({ status: 'installing' });
    expect(await teams.connect()).toEqual({ status: 'installing' });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe(INSTALL_TEAMS);
    expect(INSTALL_TEAMS).toContain('https://www.powershellgallery.com/api/v2');
    expect(INSTALL_TEAMS).toContain("AbsoluteUri.TrimEnd('/') -ne $gallery");
    expect(INSTALL_TEAMS).toContain("SourceLocation.TrimEnd('/') -ne $gallery");
    expect(INSTALL_TEAMS).toContain('-Scope CurrentUser -Repository PSGallery');
    calls[0].complete(22);
    await Promise.resolve();
    expect(await teams.status()).toEqual({ status: 'error', message: t().teamsSetupFailed });
    await teams.install();
    calls[1].complete(0);
    await Promise.resolve();
    const state = teams.status();
    calls[2].complete(0);
    expect(await state).toEqual({ status: 'signed-out' });
    expect(calls.map((c) => c.script)).toEqual([INSTALL_TEAMS, INSTALL_TEAMS, PROBE_TEAMS]);
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
      async function reply(path: string, value: unknown, body?: string) {
        await vi.waitFor(() => expect(writer.requests.length).toBeGreaterThan(index));
        const request = writer.requests[index++];
        expect(request.uri).toBe(full(path));
        expect(request.text).toBe(body);
        emit(writer, { id: request.id, json: JSON.stringify(value) });
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
      expect(writer.requests.filter((r) => r.text !== undefined)).toHaveLength(1);
      teams.disconnect();
      expect(writer.options.signal?.aborted).toBe(true);
    },
  );
});
