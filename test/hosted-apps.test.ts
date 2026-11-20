import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_APPS } from '../src/shared/apps';
import type { HostedApp, NativePart, NativeItemsOff } from '../src/shared/types';
import { claudeHostedStatus, codexHostedSnapshot, HostedAppChecks } from '../src/server/connectors/hostedApps';
import { profilePermission, profileStatus, profileTool } from '../src/server/connectors/codexHostedProfile';
import * as processes from '../src/server/process';

const settings = {
  hasAccount: () => true,
  accountHome: () => undefined,
  bin: (p: string) => p,
  env: (_p: string, account?: string) => ({ fixtureAccount: account }),
  nativeOff: () => [],
  nativeItems: () => ({}),
};
const names = { drive: 'google_drive.get_profile', teams: 'microsoft_teams.get_profile', slack: 'slack.slack_read_user_profile' };
function catalog(app: HostedApp) {
  const name = names[app];
  return {
    data: [
      {
        name: 'codex_apps',
        httpOrigin: 'https://chatgpt.com',
        tools: {
          [name]: {
            name,
            _meta: { connector_id: HOSTED_APPS[app].codexConnector, link_id: 'link-fixture' },
            annotations: { readOnlyHint: true },
            inputSchema: { type: 'object' },
          },
        },
      },
    ],
    nextCursor: null,
  };
}

function mockCodex(received?: (method: string) => void) {
  const calls: { method: string; params?: any }[] = [];
  const probe = vi.spyOn(processes, 'converse').mockImplementation(async (opts) => {
    await Promise.resolve();
    const queue: { id?: number; method: string; params?: any }[] = [];
    const write = (m: unknown) => {
      queue.push(m as (typeof queue)[number]);
    };
    let done = false;
    opts.open(write);
    while (queue.length && !done) {
      const m = queue.shift()!;
      calls.push(m);
      received?.(m.method);
      if (m.id === undefined) continue;
      const responses: Record<string, unknown> = {
        initialize: {},
        'account/read': { account: { type: 'chatgpt' } },
        'app/installed': { apps: [{ id: HOSTED_APPS.drive.codexConnector, enabled: true, callable: true }] },
        'config/read': { config: { mcp_servers: { project_script: { command: 'unwanted' } } } },
        'thread/start': { thread: { id: 'ephemeral' } },
        'app/read': {
          apps: [{ id: HOSTED_APPS.drive.codexConnector, toolSummaries: [{ name: 'get_profile', isReadOnly: true, isEnabled: true }] }],
          missingAppIds: [],
        },
        'mcpServerStatus/list': catalog('drive'),
        'mcpServer/tool/call': {
          content: [],
          structuredContent: { user: { emailAddress: 'fixture@example.test', displayName: 'Private' } },
        },
      };
      opts.onMessage({ id: m.id, result: responses[m.method] }, write, () => {
        done = true;
      });
    }
    return { stderr: '', timedOut: false };
  });
  return { calls, probe };
}

describe('hosted connector checks', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['slack', 'drive', 'teams'] as const)('requires the exact hosted Claude name and scope for %s', (app) => {
    const name = HOSTED_APPS[app].claudeName;
    const details = (scope: string, status: string) => name + ':\n  Scope: ' + scope + '\n  Status: ' + status;
    for (const [raw, expected] of [
      ['✔ Connected', 'connected'],
      ['! Needs authentication', 'needs-auth'],
      ['⊘ Disabled for this project (re-enable via /mcp)', 'disabled'],
      ['✘ Failed to connect', 'unknown'],
    ]) {
      expect(claudeHostedStatus(app, 0, details('claude.ai config', raw), '')).toBe(expected);
    }
    expect(claudeHostedStatus(app, 0, details('User config', '✔ Connected'), '')).toBe('unknown');
    expect(claudeHostedStatus(app, 0, details('User config', '✔ Connected') + '\nScope: claude.ai config', '')).toBe('unknown');
    expect(claudeHostedStatus(app, 1, '', 'No MCP server named "' + name + '". Configured servers: private-name')).toBe('not-found');
    expect(claudeHostedStatus(app, 1, '', 'Transport refused: private-host')).toBe('unknown');
  });

  it('launches a fresh named Claude check on return even while the pre-consent check on this profile is pending', async () => {
    let finishFirst!: () => void;
    const previous = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi.spyOn(processes, 'runProcess');
    const answer = (state: string) =>
      ({
        code: 0,
        stdout: 'claude.ai Slack:\nScope: claude.ai config\nStatus: ' + state,
        stderr: '',
        aborted: false,
        timedOut: false,
      }) as Awaited<ReturnType<typeof processes.runProcess>>;
    run.mockImplementationOnce(async () => {
      await previous;
      return answer('! Needs authentication');
    });
    run.mockResolvedValueOnce(answer('✔ Connected')).mockResolvedValueOnce(answer('! Needs authentication'));
    const checks = new HostedAppChecks(settings);
    const pending = checks.check('slack', 'claude', 'second');
    expect(await checks.check('slack', 'claude', 'second', true)).toBe('connected');
    expect(await checks.check('slack', 'claude', 'second', true)).toBe('needs-auth');
    finishFirst();
    expect(await pending).toBe('needs-auth');
    expect(run).toHaveBeenCalledTimes(3);
    for (const [options] of run.mock.calls)
      expect(options).toMatchObject({ bin: 'claude', args: ['mcp', 'get', 'claude.ai Slack'], env: { fixtureAccount: 'second' } });
  });

  it('keeps catalog accessibility, blocked tools and an actual OAuth verification distinct', () => {
    expect(codexHostedSnapshot([{ id: HOSTED_APPS.drive.codexConnector, isAccessible: true, isEnabled: true }]).drive).toBe('unknown');
    expect(codexHostedSnapshot([{ id: HOSTED_APPS.drive.codexConnector, enabled: true, callable: true }])).toEqual({
      drive: 'available',
      slack: 'not-found',
      teams: 'not-found',
    });
    expect(codexHostedSnapshot([{ id: HOSTED_APPS.drive.codexConnector, enabled: false, callable: false }]).drive).toBe('disabled');
    expect(codexHostedSnapshot([{ id: 'third-party-copy', runtimeName: 'Slack', enabled: true, callable: true }]).slack).toBe('not-found');
    expect(codexHostedSnapshot(null).drive).toBe('unknown');
  });

  it('honors policy on the particular profile tool even when other tools in the app are available', () => {
    const response = (toolSummaries: unknown[]) => ({ apps: [{ id: HOSTED_APPS.drive.codexConnector, toolSummaries }], missingAppIds: [] });
    const tool = { name: 'get_profile', isReadOnly: true, isEnabled: true };
    expect(profilePermission('drive', response([tool]))).toBe('allowed');
    expect(profilePermission('drive', response([{ ...tool, isEnabled: false }]))).toBe('disabled');
    expect(profilePermission('teams', response([tool]))).toBe('unknown');
    expect(profilePermission('drive', response([{ ...tool, isReadOnly: false }]))).toBe('unknown');
    expect(profilePermission('drive', response([tool, tool]))).toBe('unknown');
  });

  it('enforces the tool origin, app, link, zero arguments and unique target', () => {
    const match = () => catalog('drive');
    expect(profileTool('drive', match())).toEqual({ name: names.drive, link: 'link-fixture' });
    for (const change of [
      (r: ReturnType<typeof match>) => {
        r.data[0].httpOrigin = 'https://example.test';
      },
      (r: ReturnType<typeof match>) => {
        r.data[0].tools[names.drive]._meta.connector_id = HOSTED_APPS.teams.codexConnector as typeof HOSTED_APPS.drive.codexConnector;
      },
      (r: ReturnType<typeof match>) => {
        r.data[0].tools[names.drive]._meta.link_id = 'synthetic_link::test';
      },
      (r: ReturnType<typeof match>) => {
        Object.assign(r.data[0].tools[names.drive].inputSchema, { required: ['user_id'] });
      },
      (r: ReturnType<typeof match>) => {
        const name = 'another_account.get_profile';
        r.data[0].tools[name] = { ...r.data[0].tools[names.drive], name };
      },
    ]) {
      const r = match();
      change(r);
      expect(profileTool('drive', r)).toBeUndefined();
    }
  });

  it.each([
    ['teams', { id: 'guid', userPrincipalName: 'fixture@example.test' }],
    ['drive', { user: { emailAddress: 'fixture@example.test', permissionId: 'fixture' } }],
    ['slack', { user: { id: 'U12345', profile: { display_name: 'Fixture' } } }],
  ] as const)('checks actual structured %s profile evidence and ignores setup text or failures', (app, data) => {
    const jsonProfile = [{ type: 'text', text: JSON.stringify(data) }];
    expect(profileStatus(app, { structuredContent: { success: false, error: 'Not signed in' }, content: jsonProfile })).toBe('unknown');
    expect(profileStatus(app, { structuredContent: data, content: [{ type: 'text', text: '{"ok":false,"error":"denied"}' }] })).toBe(
      'unknown',
    );
    expect(profileStatus(app, { structuredContent: {}, content: jsonProfile })).toBe('connected');
    expect(profileStatus(app, { structuredContent: data })).toBe('connected');
    expect(profileStatus(app, { isError: null, structuredContent: data })).toBe('connected');
    expect(profileStatus(app, { isError: null, structuredContent: { message: 'Connect on the provider page' } })).toBe('unknown');
    expect(profileStatus(app, { isError: null, structuredContent: data, _meta: { 'mcp/www_authenticate': 'Bearer' } })).toBe('needs-auth');
    expect(profileStatus(app, { content: [{ type: 'text', text: JSON.stringify(data) }] })).toBe('connected');
    for (const other of [
      { content: [{ type: 'text', text: 'Sign in to see your account' }] },
      { isError: true, structuredContent: data },
      { structuredContent: { error: 'denied', data } },
      { structuredContent: { id: 'service' } },
      { isError: true, _meta: { code: 403 } },
    ])
      expect(profileStatus(app, other)).toBe('unknown');
    expect(profileStatus(app, { isError: true, _meta: { 'mcp/www_authenticate': ['Bearer error="invalid_token"'] } })).toBe('needs-auth');
  });

  it('a fresh explicit verification supersedes only an older verification of that app on the same profile', async () => {
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const signals: AbortSignal[] = [];
    const call = vi.spyOn(processes, 'converse').mockImplementation(async (opts) => {
      const signal = opts.signal!;
      signals.push(signal);
      if (signals.length === 1) {
        announce();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { stderr: '', timedOut: false };
    });
    const checks = new HostedAppChecks(settings);
    const older = checks.check('teams', 'codex', 'profile', true);
    await entered;
    await checks.check('teams', 'codex', 'second-profile', true);
    expect(signals[0].aborted).toBe(false);
    await checks.check('teams', 'codex', 'profile', true);
    expect(await older).toBe('unknown');
    expect(signals[0].aborted).toBe(true);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each(['mcp', 'plugins', 'server', 'package', 'tool', 'account', 'home'])(
    'rechecks current %s access before reading and before returning a verified status',
    async (reason) => {
      for (const phase of ['before', 'after']) {
        let changed = false;
        const { calls, probe } = mockCodex((method) => {
          if (method === (phase === 'before' ? 'mcpServerStatus/list' : 'mcpServer/tool/call')) changed = true;
        });
        const checks = new HostedAppChecks({
          ...settings,
          hasAccount: () => !(changed && reason === 'account'),
          accountHome: () => (changed && reason === 'home' ? '/next-cli-home' : '/initial-cli-home'),
          nativeOff: (): NativePart[] => (changed && (reason === 'mcp' || reason === 'plugins') ? [reason] : []),
          nativeItems: (): NativeItemsOff => {
            if (!changed) return {};
            if (reason === 'server') return { mcp: ['codex_apps'] };
            if (reason === 'package') return { plugins: [HOSTED_APPS.drive.codexPackage] };
            if (reason === 'tool') return { mcpTools: [JSON.stringify(['codex_apps', names.drive])] };
            return {};
          },
        });
        expect(await checks.check('drive', 'codex', 'chosen', true)).toBe(
          reason === 'account' || reason === 'home' ? 'unknown' : 'disabled',
        );
        expect(calls.filter((m) => m.method === 'mcpServer/tool/call')).toHaveLength(phase === 'before' ? 0 : 1);
        probe.mockRestore();
      }
    },
  );

  it('separates concurrent passive Codex queries when the same default account moves off its inherited home', async () => {
    const { probe } = mockCodex();
    let configured: string | undefined;
    vi.stubEnv('CODEX_HOME', '/fixture-inherited-codex');
    try {
      const checks = new HostedAppChecks({ ...settings, accountHome: () => configured });
      const previous = checks.check('drive', 'codex', '');
      configured = '/fixture-configured-codex';
      const fresh = checks.check('drive', 'codex', '');
      expect(await fresh).toBe('available');
      expect(await previous).toBe('unknown');
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores a connected Claude result from a previous home including an inherited default', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/fixture-inherited-claude');
    try {
      const run = vi.spyOn(processes, 'runProcess').mockImplementation(async () => {
        await Promise.resolve();
        return {
          code: 0,
          stdout: 'claude.ai Slack:\nScope: claude.ai config\nStatus: ✔ Connected',
          stderr: '',
          aborted: false,
          timedOut: false,
        } as Awaited<ReturnType<typeof processes.runProcess>>;
      });
      const checks = new HostedAppChecks(settings);
      const previous = checks.check('slack', 'claude', '', true);
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/fixture-other-claude');
      expect(await previous).toBe('unknown');
      expect(await checks.check('slack', 'claude', '', true)).toBe('connected');
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('cancels the pending profile check when a passive check observes that access has been disabled', async () => {
    let disabled = false,
      started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    let signal: AbortSignal | undefined;
    vi.spyOn(processes, 'converse').mockImplementation(async (opts) => {
      signal = opts.signal;
      started();
      await new Promise<void>((r) => signal!.addEventListener('abort', () => r(), { once: true }));
      return { stderr: '', timedOut: false };
    });
    const checks = new HostedAppChecks({ ...settings, nativeOff: (): NativePart[] => (disabled ? ['mcp'] : []) });
    const active = checks.check('drive', 'codex', 'account', true);
    await entered;
    disabled = true;
    expect(await checks.check('drive', 'codex', 'account')).toBe('disabled');
    expect(signal!.aborted).toBe(true);
    expect(await active).toBe('disabled');
  });

  it('shares concurrent passive probes per account, and explicitly verifies only in an isolated ephemeral thread', async () => {
    const { calls, probe } = mockCodex();
    const checks = new HostedAppChecks(settings);
    expect(
      await Promise.all([checks.check('drive', 'codex', 'A'), checks.check('teams', 'codex', 'A'), checks.check('slack', 'codex', 'B')]),
    ).toEqual(['available', 'not-found', 'not-found']);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(calls.some((m) => m.method === 'thread/start')).toBe(false);
    expect(await checks.check('drive', 'codex', 'A', true)).toBe('connected');
    expect(probe).toHaveBeenCalledTimes(3);
    const thread = calls.find((m) => m.method === 'thread/start')!.params;
    expect(probe.mock.calls.at(-1)![0].args.some((arg) => arg.startsWith('sqlite_home='))).toBe(false);
    expect(thread.config).not.toHaveProperty('sqlite_home');
    expect(thread).toMatchObject({
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      config: { 'features.hooks': false, 'features.plugins': false, mcp_servers: { project_script: { enabled: false } } },
    });
    expect(existsSync(thread.cwd)).toBe(false);
    expect(calls.filter((m) => m.method === 'mcpServer/tool/call')).toMatchObject([
      {
        params: {
          server: 'codex_apps',
          tool: names.drive,
          arguments: {},
          _meta: { connector_id: HOSTED_APPS.drive.codexConnector, link_id: 'link-fixture' },
        },
      },
    ]);
    expect(calls.some((m) => m.method === 'turn/start')).toBe(false);
  });
});
