import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';

const profileFixtures = {
  slack: {
    tool: 'slack.slack_read_user_profile',
    profile: { user: { id: 'U012ABC', team_id: 'T012ABC', profile: { display_name: 'e2e-private' } } },
  },
} as const;

export const hostedApps = [
  {
    id: 'slack',
    runtimeId: 'asdk_app_69a1d78e929881919bba0dbda1f6436d',
    name: 'Slack',
    claudeName: 'claude.ai Slack',
    directory: '597f662f-36de-437e-836e-5a81013cbfbe',
    plugin: 'plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d',
  },
] as const;
export type HostedApp = (typeof hostedApps)[number];
export type HostedProvider = 'Claude' | 'Codex';
type Status = 'connected' | 'available-without-account' | 'not-found' | 'unknown';

export const hostedPage = (app: HostedApp, provider: HostedProvider, disconnect: boolean) =>
  provider === 'Codex'
    ? 'https://chatgpt.com/plugins/' + app.plugin
    : disconnect
      ? 'https://claude.ai/customize/connectors'
      : 'https://claude.ai/directory/' + app.directory;

export async function hostConnectorPages(context: BrowserContext, home: string) {
  const state: Record<HostedProvider, Map<HostedApp, Status>> = { Claude: new Map(), Codex: new Map() };
  function set(app: HostedApp, provider: HostedProvider, status: Status) {
    state[provider].set(app, status);
    const account = join(home, provider === 'Claude' ? '.claude' : '.codex');
    mkdirSync(account, { recursive: true });
    let inventory: unknown;
    if (provider === 'Claude') {
      inventory = Object.fromEntries(
        Array.from(state.Claude, ([service, result]) => [
          service.claudeName,
          result === 'connected'
            ? { code: 0, stdout: service.claudeName + ':\n  Scope: claude.ai config\n  Status: ✔ Connected\n' }
            : result === 'not-found'
              ? { code: 1, stderr: 'No MCP server named "' + service.claudeName + '". Configured servers: private-helper.\n' }
              : { code: 1, stderr: 'Provider information unavailable. Internal: e2e-private.\n' },
        ]),
      );
    } else {
      inventory = Array.from(state.Codex.values()).includes('unknown')
        ? { error: 'The CLI could not refresh apps. Internal: e2e-private.' }
        : {
            apps: Array.from(state.Codex)
              .filter(([, result]) => result === 'connected' || result === 'available-without-account')
              .map(([service]) => ({
                id: service.runtimeId,
                runtimeName: service.name,
                enabled: true,
                callable: true,
              })),
          };
    }
    if (provider === 'Codex') {
      const profiles = Object.fromEntries(
        Array.from(state.Codex)
          .filter(([, result]) => result === 'connected' || result === 'available-without-account')
          .map(([service]) => {
            const fixture = profileFixtures[service.id];
            return [
              fixture.tool,
              { connector: service.runtimeId, profile: fixture.profile, authorized: state.Codex.get(service) === 'connected' },
            ];
          }),
      );
      inventory = { ...(inventory as object), profiles };
    }
    writeFileSync(join(account, 'e2e-hosted-connectors.json'), JSON.stringify(inventory));
  }
  // The consent/management page is offline. Only submitting its form changes what the provider CLI can report.
  await context.route(/^https:\/\/(?:claude\.ai|chatgpt\.com)\//, (route) => {
    const url = new URL(route.request().url());
    const provider: HostedProvider = url.hostname === 'claude.ai' ? 'Claude' : 'Codex';
    if (route.request().method() === 'POST' && url.pathname === '/e2e/update-connector') {
      const fields = new URLSearchParams(route.request().postData() || '');
      const app = hostedApps.find((item) => item.id === fields.get('app'));
      const action = fields.get('action');
      if (!app || (action !== 'Allow' && action !== 'Disconnect')) return route.abort();
      set(app, provider, action === 'Allow' ? 'connected' : 'not-found');
      return route.fulfill({ contentType: 'text/html', body: '<p>Updated</p>' });
    }
    const services = hostedApps.filter((app) => [hostedPage(app, provider, false), hostedPage(app, provider, true)].includes(url.href));
    if (!services.length || route.request().method() !== 'GET') return route.abort();
    const body = services
      .map((app) => {
        const action = state[provider].get(app) === 'connected' ? 'Disconnect' : 'Allow';
        return (
          '<form method="post" action="/e2e/update-connector"><input type="hidden" name="app" value="' +
          app.id +
          '"><input type="hidden" name="action" value="' +
          action +
          '"><button>' +
          action +
          ' ' +
          app.name +
          '</button></form>'
        );
      })
      .join('');
    return route.fulfill({ contentType: 'text/html', body });
  });
  return { set };
}
