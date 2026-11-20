import type { ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TeamsGraph } from '../src/server/connectors/teams';
import { CONNECT_TEAMS, INSTALL_TEAMS, PROBE_TEAMS } from '../src/server/connectors/teamsPowerShell';
import { t } from '../src/server/i18n';
import { CommandNotFoundError } from '../src/server/process';

type Runner = NonNullable<ConstructorParameters<typeof TeamsGraph>[0]>;
type Call = {
  script: string;
  options: Parameters<Runner>[1];
  complete: (code: number | null) => void;
  requests: { id: number; uri: string }[];
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

async function connected() {
  const { teams, calls } = helper();
  await teams.connect();
  const [session] = calls;
  session.options.onLine?.(prompt());
  emit(session, { account: 'person@school.example' });
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
});
