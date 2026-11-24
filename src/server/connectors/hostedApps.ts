import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { HOSTED_APPS } from '../../shared/apps';
import type { HostedApp, HostedAppStatus, HostedProvider } from '../../shared/types';
import { claudeMcpName } from '../agents/claude';
import { codexMcpToolId, codexNativeConfig, codexOverrideArgs } from '../agents/codex';
import { tooOld } from '../cliVersion';
import { converse, runProcess } from '../process';
import { profilePermission, profileStatus, profileTool } from './codexHostedProfile';
import { AGENT_HOME_ENV, type SettingsStore } from '../settings';

type Snapshot = Record<HostedApp, HostedAppStatus>;
type CodexSnapshot = Snapshot & { accountKey?: string };
function codexAccountKey(
  account: { type?: string; id?: string; email?: string; workspaceName?: string; planType?: string } | null,
): string | undefined {
  if (account?.type !== 'chatgpt' || (!account.id && !account.email)) return;
  return createHash('sha256')
    .update(JSON.stringify([account.id, account.email, account.workspaceName, account.planType]))
    .digest('hex');
}
const snapshot = (status: HostedAppStatus): Snapshot => ({ slack: status });

/** The CLI can also find local MCP servers with the same name. Only a named claude.ai scope is evidence. */
export function claudeHostedStatus(app: HostedApp, code: number | null, stdout: string, stderr: string): HostedAppStatus {
  const name = HOSTED_APPS[app].claudeName;
  const lines = (text: string) =>
    stripVTControlCharacters(text)
      .split(/\r?\n/)
      .map((line) => line.trim());
  if (code !== 0) {
    const missing = 'No MCP server named "' + name + '".';
    const first = lines(stderr)[0] || lines(stdout)[0];
    return code === 1 && (first === missing || first.startsWith(missing + ' Configured servers:')) ? 'not-found' : 'unknown';
  }
  const detail = lines(stdout);
  const scope = detail.filter((line) => line.startsWith('Scope:'));
  const status = detail.filter((line) => line.startsWith('Status:'));
  if (detail[0] !== name + ':' || scope.length !== 1 || scope[0] !== 'Scope: claude.ai config' || status.length !== 1) return 'unknown';
  const state = status[0].slice('Status:'.length).trim();
  if (/^(?:[✔✓] )?Connected$/.test(state)) return 'connected';
  if (/^(?:! )?Needs authentication$/i.test(state)) return 'needs-auth';
  if (/^(?:⊘ )?Disabled(?: for this project)?(?: \(|$)/.test(state) || state === '✘ Blocked by enterprise managed policy')
    return 'disabled';
  return 'unknown';
}

async function checkClaude(app: HostedApp, bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<HostedAppStatus> {
  try {
    // Older than Harness Relay supports: not asked (`tooOld()`).
    if (await tooOld('claude', bin, env)) return 'unknown';
    const result = await runProcess({
      bin,
      args: ['mcp', 'get', HOSTED_APPS[app].claudeName],
      cwd: tmpdir(),
      signal,
      env,
      timeoutMs: 15_000,
      maxCapture: 8192,
      keepStart: true,
    });
    return result.timedOut || result.aborted ? 'unknown' : claudeHostedStatus(app, result.code, result.stdout, result.stderr);
  } catch {
    return 'unknown';
  }
}

/** app/installed observes actual non-synthetic runtime tools. Callable is availability, not
 * verification of an upstream OAuth grant. Directory names and third-party copies are irrelevant. */
export function codexHostedSnapshot(data: unknown): Snapshot {
  const result = snapshot('unknown');
  if (!Array.isArray(data) || data.some((row) => !row || typeof row.id !== 'string')) return result;
  for (const app of Object.keys(HOSTED_APPS) as HostedApp[]) {
    const rows = data.filter((row) => row.id === HOSTED_APPS[app].codexConnector);
    if (!rows.length) result[app] = 'not-found';
    else if (rows.length === 1 && typeof rows[0].enabled === 'boolean' && typeof rows[0].callable === 'boolean') {
      const { enabled, callable } = rows[0];
      if (enabled && callable) result[app] = 'available';
      if (!enabled && !callable) result[app] = 'disabled';
    }
  }
  return result;
}

async function checkCodex(
  bin: string,
  env: NodeJS.ProcessEnv,
  overrides: string[],
  verify?: { app: HostedApp; signal: AbortSignal; blocked: (wire?: string) => HostedAppStatus | undefined },
): Promise<CodexSnapshot> {
  let result = snapshot('unknown');
  let accountKey: string | undefined;
  let expected = 1;
  let thread: string;
  let folder: string | undefined;
  try {
    // Older than Harness Relay supports: not asked (Codex 0.27 has no `app-server`, and opens its terminal UI instead).
    if (await tooOld('codex', bin, env)) return result;
    if (verify) folder = await mkdtemp(join(tmpdir(), 'relay-hosted-profile-'));
    // The profile check runs in an empty working folder, with hooks/plugins disabled. No model turn is started.
    const isolation = folder
      ? {
          'features.hooks': false,
          'features.plugins': false,
          'features.shell_snapshot': false,
          'features.memories': false,
          project_doc_max_bytes: 0,
          allow_login_shell: false,
          'history.persistence': 'none',
          'analytics.enabled': false,
          // Verification uses private logs and an ephemeral thread. Giving every check a fresh
          // sqlite_home makes Codex initialize its state database again before the first RPC.
          log_dir: folder,
        }
      : {};
    const { timedOut } = await converse({
      bin,
      env: folder ? { ...env, RUST_LOG: 'off' } : env,
      args: [...overrides, ...codexOverrideArgs(isolation), 'app-server'],
      cwd: folder ?? tmpdir(),
      timeoutMs: verify ? 35_000 : 20_000,
      signal: verify?.signal,
      open: (write) =>
        write({
          id: expected,
          method: 'initialize',
          params: { clientInfo: { name: 'harness_relay', version: '0.1.0' }, capabilities: { experimentalApi: true } },
        }),
      onMessage: (m, write, finish) => {
        if (m.method || m.id !== expected) return;
        if (verify?.signal.aborted) return finish();
        if (verify) {
          const blocked = verify.blocked();
          if (blocked) {
            result[verify.app] = blocked;
            return finish();
          }
        }
        if (m.error || !m.result) return finish();
        const ask = (method: string, params: unknown) => write({ id: ++expected, method, params });
        switch (expected) {
          case 1:
            write({ method: 'initialized' });
            return ask('account/read', { refreshToken: false });
          case 2:
            if (m.result.account?.type !== 'chatgpt') return finish();
            accountKey = codexAccountKey(m.result.account);
            return ask('app/installed', { forceRefresh: true });
          case 3: {
            result = codexHostedSnapshot(m.result.apps);
            if (!verify || result[verify.app] !== 'available') return finish();
            result[verify.app] = 'unknown';
            return ask('config/read', { cwd: folder });
          }
          case 4: {
            const config = m.result.config;
            if (!config || typeof config !== 'object' || Array.isArray(config)) return finish();
            const servers = config.mcp_servers ?? {};
            if (typeof servers !== 'object' || Array.isArray(servers) || Object.hasOwn(servers, 'codex_apps')) return finish();
            // Existing user servers are merged by name. Disable each before the thread is created.
            const mcp_servers = Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }]));
            return ask('thread/start', {
              cwd: folder,
              ephemeral: true,
              sandbox: 'read-only',
              approvalPolicy: 'never',
              baseInstructions: 'Check the selected hosted connection.',
              environments: [],
              runtimeWorkspaceRoots: [],
              config: { ...isolation, mcp_servers },
            });
          }
          case 5:
            thread = m.result.thread?.id;
            if (typeof thread !== 'string' || !thread || thread.length > 256) return finish();
            if (!verify) return finish();
            return ask('app/read', { threadId: thread, appIds: [HOSTED_APPS[verify.app].codexConnector], includeTools: true });
          case 6: {
            if (!verify) return finish();
            const permission = profilePermission(verify.app, m.result);
            if (permission !== 'allowed') {
              result[verify.app] = permission;
              return finish();
            }
            return ask('mcpServerStatus/list', { threadId: thread, serverName: 'codex_apps', detail: 'toolsAndAuthOnly' });
          }
          case 7: {
            if (!verify) return finish();
            const tool = profileTool(verify.app, m.result);
            if (!tool) return finish();
            const blocked = verify.blocked(tool.name);
            if (blocked) {
              result[verify.app] = blocked;
              return finish();
            }
            return ask('mcpServer/tool/call', {
              threadId: thread,
              server: 'codex_apps',
              tool: tool.name,
              arguments: {},
              _meta: { connector_id: HOSTED_APPS[verify.app].codexConnector, ...(tool.link ? { link_id: tool.link } : {}) },
            });
          }
          case 8:
            if (verify) result[verify.app] = profileStatus(m.result);
            if (verify && result[verify.app] === 'connected') {
              result[verify.app] = 'unknown';
              return ask('account/read', { refreshToken: false });
            }
            return finish();
          case 9:
            if (verify && m.result.account?.type === 'chatgpt' && codexAccountKey(m.result.account) === accountKey)
              result[verify.app] = 'connected';
            return finish();
        }
      },
    });
    return timedOut || verify?.signal.aborted ? snapshot('unknown') : { ...result, accountKey };
  } catch {
    return snapshot('unknown');
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

export class HostedAppChecks {
  private readonly codex = new Map<string, Promise<CodexSnapshot>>();

  private readonly verifying = new Map<string, AbortController>();

  // A picker may reuse a recent explicit self-profile check while the same account and plugin remain available.
  private readonly verified = new Map<string, { identity: string; tool?: string; time: number }>();

  constructor(private readonly settings: Pick<SettingsStore, 'bin' | 'env' | 'accountHome' | 'hasAccount' | 'nativeOff' | 'nativeItems'>) {}

  private blocked(app: HostedApp, provider: HostedProvider, account: string, profileTool?: string): HostedAppStatus | undefined {
    if (!this.settings.hasAccount(provider, account)) return 'unknown';
    const off = this.settings.nativeOff(provider, account);
    const items = this.settings.nativeItems(provider, account);
    if (off.includes('mcp')) return 'disabled';
    const official = HOSTED_APPS[app];
    if (provider === 'claude') return items.mcp?.includes('mcp__' + claudeMcpName(official.claudeName)) ? 'disabled' : undefined;
    if (
      off.includes('plugins') ||
      items.mcp?.includes('codex_apps') ||
      items.plugins?.includes(official.codexPackage) ||
      (profileTool && items.mcpTools?.includes(codexMcpToolId('codex_apps', profileTool)))
    )
      return 'disabled';
  }

  async check(app: HostedApp, provider: HostedProvider, account: string, mode: boolean | 'draft' = false): Promise<HostedAppStatus> {
    const verify = mode === true;
    const target = JSON.stringify([provider, account, app]);
    // Match settings.env(): the account's selected home, the inherited default override, or the CLI default.
    // This reads only the folder setting while an RPC is pending, never the keyring.
    const currentHome = () =>
      resolve(this.settings.accountHome(provider, account) || process.env[AGENT_HOME_ENV[provider]] || join(homedir(), '.' + provider));
    const home = currentHome();
    const bin = this.settings.bin(provider);
    // File metadata also distinguishes sign-ins changed outside Relay without reading any credentials.
    const identity = () => {
      let authFile = '';
      try {
        const stat = statSync(join(home, 'auth.json'), { bigint: true, throwIfNoEntry: false });
        if (stat) authFile = [stat.ino, stat.size, stat.mtimeNs].join('/');
      } catch {
        /* Codex can also keep its credentials in the system keyring. */
      }
      return JSON.stringify([home, bin, authFile]);
    };
    const before = provider === 'codex' && verify ? identity() : '';
    let wire: string | undefined;
    const blocked = (name?: string) => {
      if (name) wire = name;
      return (
        this.blocked(app, provider, account, wire) ??
        (currentHome() !== home || this.settings.bin(provider) !== bin ? 'unknown' : undefined)
      );
    };
    const initial = blocked();
    if (initial) {
      this.verified.delete(target);
      this.verifying.get(target)?.abort();
      return initial;
    }
    const env = this.settings.env(provider, account);
    const active = verify ? new AbortController() : undefined;
    if (active) {
      this.verifying.get(target)?.abort();
      this.verifying.set(target, active);
    }
    try {
      let status: HostedAppStatus;
      let accountKey: string | undefined;
      if (provider === 'claude') {
        // Each mcp get, including Verify or returning from the provider, is a new live process.
        status = await checkClaude(app, bin, env, active?.signal);
      } else {
        const args = codexOverrideArgs(
          codexNativeConfig(this.settings.nativeOff(provider, account), this.settings.nativeItems(provider, account)),
        );
        if (active) {
          const result = await checkCodex(bin, env, args, { app, signal: active.signal, blocked });
          status = result[app];
          accountKey = result.accountKey;
        } else {
          const key = JSON.stringify([account, home, bin, args]);
          let running = this.codex.get(key);
          if (!running) {
            running = checkCodex(bin, env, args).finally(() => this.codex.delete(key));
            this.codex.set(key, running);
          }
          const result = await running;
          status = result[app];
          accountKey = result.accountKey;
        }
      }
      if (active?.signal.aborted) return blocked() ?? 'unknown';
      const state = blocked() ?? status;
      if (provider === 'codex') {
        const current = identity();
        if (verify && before !== current) {
          this.verified.delete(target);
          return 'unknown';
        }
        if (verify && state === 'connected' && accountKey) {
          this.verified.set(target, { identity: JSON.stringify([current, accountKey]), tool: wire, time: Date.now() });
        } else if (state !== 'available' || verify) {
          this.verified.delete(target);
        }
        if (mode === 'draft' && state === 'available') {
          const last = this.verified.get(target);
          if (
            last &&
            Date.now() - last.time < 5 * 60_000 &&
            accountKey &&
            last.identity === JSON.stringify([current, accountKey]) &&
            !blocked(last.tool)
          )
            return 'connected';
          this.verified.delete(target);
        }
      }
      return state;
    } finally {
      if (active && this.verifying.get(target) === active) this.verifying.delete(target);
    }
  }
}
