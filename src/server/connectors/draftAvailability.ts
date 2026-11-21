import { APP_SERVERS, DRAFT_APPS, LOCAL_DRAFT_APPS, type DraftApp, type DraftAppAvailability, type DraftAppState } from '../../shared/apps';
import {
  isEndpointCli,
  isOpenProvider,
  parseBackendModel,
  type HostedProvider,
  type Permission,
  type Provider,
  type RelayToolGroup,
} from '../../shared/types';
import { openhandsNeedsTerminalSwitch } from '../agents/openhands';
import { openAgents } from '../agents/index';
import { sandboxAvailable } from '../relaySandbox';
import { NO_HTTP_MCP } from '../agents/acp';
import { GATEWAY_FULL_ACCESS_ONLY, GATEWAY_OVER_HTTP } from '../gateway';
import type { OAuthService } from '../oauth/service';
import { agentFolderOptions } from '../protect';
import type { ProviderService } from '../providers';
import type { SettingsStore } from '../settings';
import { githubStatus } from './apps';
import { hasDocsScope } from './driveDocuments';
import type { HostedAppChecks } from './hostedApps';
import { checkedVault } from './obsidian';
import type { TeamsGraph } from './teams';

/** Share only concurrent probes. A later open or submission checks the current connections again. */
function joinProbe<K, V>(read: (key: K) => Promise<V>) {
  const pending = new Map<K, Promise<V>>();
  return (key: K) => {
    const current = pending.get(key);
    if (current) return current;
    const result = read(key).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}

export function draftAvailability(
  settings: SettingsStore,
  oauth: OAuthService,
  providers: Pick<ProviderService, 'status'>,
  teams: Pick<TeamsGraph, 'status'>,
  hosted: Pick<HostedAppChecks, 'check'>,
  github = githubStatus,
  platform = process.platform,
  sandbox = sandboxAvailable,
) {
  const accountsFor = joinProbe(async (p: Provider) => {
    const status = await providers.status(p);
    return status.installed ? status.accounts : [];
  });
  const slack = (p: HostedProvider, mode: 'draft' | true) => joinProbe(async (id: string) => hosted.check('slack', p, id, mode));
  const hostedSlack = { claude: slack('claude', 'draft'), codex: slack('codex', 'draft') };
  const verifyCodex = slack('codex', true);
  const checkGithub = joinProbe(async (_: 'github') => github());
  const checkTeams = joinProbe(async (_: 'teams') => teams.status());

  return async (permission: Permission, requested?: DraftApp | 'local', verifySlack = false): Promise<DraftAppAvailability> => {
    const result = Object.fromEntries(DRAFT_APPS.map((app) => [app, 'unavailable'])) as DraftAppAvailability;
    const apps = requested === 'local' ? LOCAL_DRAFT_APPS : requested ? [requested] : DRAFT_APPS;
    const tools = settings.tools;
    const accounts = oauth.store.accounts().filter((a) => a.status === 'connected');
    let sandboxReady: Promise<boolean> | undefined;
    const canRun = async (p: Provider) => {
      const configured = await accountsFor(p);
      if (!configured.length) return false;
      if (permission !== 'full' && isOpenProvider(p)) {
        if (platform === 'win32' || openAgents[p].process.sandboxUnsupported?.(platform)) return false;
        if (p === 'openhands' && openhandsNeedsTerminalSwitch(platform) && !settings.sandboxTerminal(p)) return false;
        sandboxReady ??= sandbox().then((s) => s.ok);
        if (!(await sandboxReady)) return false;
      }
      return configured.some((a) => {
        const signedIn = a.auth.loggedIn === true || a.usingStoredApiKey;
        if (isEndpointCli(p)) {
          const model = parseBackendModel(settings.defaultModel(p, a.id));
          if (model) {
            const backends = settings.backends.view();
            const endpoint = backends.endpoints.find((e) => e.id === model.backend);
            // Grok also needs its own sign-in or API key to start, even when its model runs locally.
            if (endpoint) return !endpoint.keyUnreadable && (p !== 'grok' || signedIn);
            if (backends.deletedEndpoints.includes(model.backend)) return false;
          }
        }
        return signedIn;
      });
    };
    const assistant = async (list: Provider[]): Promise<DraftAppState> => {
      // One signed-in provider with access is enough, even if another CLI cannot be checked.
      const ready = await Promise.all([...new Set(list)].map((p) => canRun(p).catch(() => false)));
      return ready.some(Boolean) ? 'ready' : 'needs-assistant';
    };
    const relay = (group: RelayToolGroup): Promise<DraftAppState> | DraftAppState => {
      const gateway = tools.gatewayStatus();
      if (!gateway.available) return 'unavailable';
      const configured = tools.relayProviders(group);
      return assistant(
        configured.filter(
          (p) => (!gateway.reason || GATEWAY_OVER_HTTP.includes(p)) && (permission === 'full' || !GATEWAY_FULL_ACCESS_ONLY.includes(p)),
        ),
      );
    };
    const official = (app: keyof typeof APP_SERVERS): Promise<DraftAppState> | DraftAppState => {
      const servers = tools.signedInAppServers(app);
      if (!servers.length) return 'needs-connection';
      return assistant(servers.flat().filter((p) => !NO_HTTP_MCP.includes(p)));
    };
    const check = async (app: DraftApp): Promise<DraftAppState> => {
      switch (app) {
        case 'mail':
        case 'calendar': {
          const connectors = app === 'mail' ? settings.connectors.mailAccounts() : settings.connectors.calendarAccounts();
          const connected = connectors.some(
            (c) => !c.oauth || accounts.some((a) => a.id === c.oauth && a.uses.includes(app) && !oauth.clientProblem(a.provider)),
          );
          return connected ? relay(app) : 'needs-connection';
        }
        case 'drive': {
          const granted = accounts.some(
            (a) =>
              a.provider === 'google' &&
              (a.uses.includes('drive') || (a.uses.includes('documents') && hasDocsScope(oauth.store.account(a.id)?.scopes))),
          );
          return granted && !oauth.clientProblem('google') ? relay(app) : 'needs-connection';
        }
        case 'browser':
          return tools.browserStatus().using ? relay(app) : 'needs-install';
        case 'obsidian': {
          const options = agentFolderOptions(settings);
          const valid = tools.obsidianVaults().some(({ path }) => {
            try {
              return checkedVault(path, options) === path;
            } catch {
              return false;
            }
          });
          return valid ? relay(app) : 'needs-connection';
        }
        case 'notion':
        case 'heptabase':
          return official(app);
        case 'github': {
          const state = await checkGithub(app);
          if (state.status === 'missing') return 'needs-install';
          return state.status === 'connected' ? relay(app) : 'needs-connection';
        }
        case 'teams': {
          if (accounts.some((a) => a.provider === 'microsoft' && a.uses.includes('teams')) && !oauth.clientProblem('microsoft'))
            return relay(app);
          const { status } = await checkTeams(app);
          if (status === 'connected') return relay(app);
          if (status === 'missing-powershell' || status === 'missing-module') return 'needs-install';
          return status === 'signed-out' ? 'needs-connection' : 'unavailable';
        }
        case 'slack': {
          const direct = settings.slackPosting.view().status === 'connected' ? await relay(app) : 'needs-connection';
          if (direct === 'ready') return direct;
          const mcp = await official(app);
          if (mcp === 'ready') return mcp;
          const states = (
            await Promise.all(
              (['claude', 'codex'] as const).map(async (p) => {
                const signedIn = (await accountsFor(p).catch(() => [])).filter((a) => a.auth.loggedIn === true);
                const probe = p === 'codex' && verifySlack ? verifyCodex : hostedSlack[p];
                return Promise.all(signedIn.map((a) => probe(a.id).catch(() => 'unknown' as const)));
              }),
            )
          ).flat();
          if (states.includes('connected')) return 'ready';
          if (states.includes('available')) return 'needs-verification';
          if (direct === 'needs-assistant' || mcp === 'needs-assistant') return 'needs-assistant';
          return states.includes('unknown') ? 'unavailable' : 'needs-connection';
        }
      }
    };
    await Promise.all(
      apps.map(async (app) => {
        try {
          result[app] = await check(app);
        } catch {
          result[app] = 'unavailable';
        }
      }),
    );
    return result;
  };
}
