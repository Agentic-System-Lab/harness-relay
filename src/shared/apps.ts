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
