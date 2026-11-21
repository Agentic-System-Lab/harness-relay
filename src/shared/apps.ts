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
} as const;

export const DRAFT_APPS = ['mail', 'calendar', 'teams', 'slack', 'drive', 'notion', 'heptabase', 'obsidian', 'github', 'browser'] as const;
export type DraftApp = (typeof DRAFT_APPS)[number];
export type DraftAppState = 'ready' | 'needs-connection' | 'needs-assistant' | 'needs-install' | 'needs-verification' | 'unavailable';
export type DraftAppAvailability = Record<DraftApp, DraftAppState>;

export const LOCAL_DRAFT_APPS = [
  'mail',
  'calendar',
  'drive',
  'notion',
  'heptabase',
  'obsidian',
  'browser',
] as const satisfies readonly DraftApp[];
