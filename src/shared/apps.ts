/** Official MCP endpoints for the catalog and its saved connections. */
export const APP_SERVERS = {
  notion: 'https://mcp.notion.com/mcp',
  heptabase: 'https://api.heptabase.com/mcp',
  slack: 'https://mcp.slack.com/mcp',
} as const;

/** Recognize the official Slack host even when a user types a different path or adds a trailing slash. */
export function isSlackMcp(url: string | undefined): boolean {
  return !!url && URL.canParse(url) && new URL(url).hostname.replace(/\.$/, '') === 'mcp.slack.com';
}

/** The providers' official directory entries and the exact names/IDs returned by their CLIs.
 * Codex plugin/read supplies the app ID; it is distinct from the plugin's directory ID. */
export const HOSTED_APPS = {
  slack: {
    codexPackage: 'slack@openai-curated-remote',
    claudeName: 'claude.ai Slack',
    claudeDirectory: '597f662f-36de-437e-836e-5a81013cbfbe',
    codexPlugin: 'plugin_asdk_app_69a1d78e929881919bba0dbda1f6436d',
    codexConnector: 'asdk_app_69a1d78e929881919bba0dbda1f6436d',
  },
  teams: {
    codexPackage: 'teams@openai-curated-remote',
    claudeName: 'claude.ai Microsoft 365',
    claudeDirectory: 'ce0c9cda-5ea5-44c5-9cf2-40810dfa6582',
    codexPlugin: 'plugin_connector_1p_eba8b52fe53881918408d4b46b957644',
    codexConnector: 'connector_246af0940da3457da0e751171dc1ce60',
  },
  drive: {
    codexPackage: 'google-drive@openai-curated-remote',
    claudeName: 'claude.ai Google Drive',
    claudeDirectory: 'b89f7865-a755-4f86-8062-c3bd651740ce',
    codexPlugin: 'plugin_connector_1p_ab21a553bfbc81919ea8fd1858e3ffa7',
    codexConnector: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
  },
} as const;
