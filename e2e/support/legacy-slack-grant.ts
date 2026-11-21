import { APP_SERVERS } from '../../src/shared/apps';
import type { ToolLibrary } from '../../src/server/tools';

/** Persist the metadata an earlier version wrote after Slack authorized its registered desktop client. */
export function saveLegacySlackGrant(library: ToolLibrary): string {
  const name = 'slack-work';
  library.saveServer(name, { transport: 'http', url: APP_SERVERS.slack, providers: ['claude'] }, 'slack');
  library.mcpSignedIn(
    library.mcpServer(name)!.id,
    {
      issuer: 'https://mcp.slack.com',
      resource: 'https://mcp.slack.com',
      host: 'mcp.slack.com',
      authorize: 'https://slack.com/oauth/v2_user/authorize',
      token: 'https://slack.com/api/oauth.v2.user.access',
      registration: '',
      scopes: ['search:read.public', 'channels:history', 'channels:read'],
      signedInAt: 1700000000000,
      status: 'reauth',
      noRefresh: true,
      clientId: 'registered-test-client',
      redirectUris: ['http://localhost:8787/oauth/callback'],
    },
    {},
  );
  return name;
}
