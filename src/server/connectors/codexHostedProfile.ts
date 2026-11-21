import { HOSTED_APPS } from '../../shared/apps';
import type { HostedApp, HostedAppStatus } from '../../shared/types';

type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const email = (v: unknown) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v);
const leaves = { teams: 'get_profile', slack: 'slack_read_user_profile' } as const;

export function profilePermission(app: HostedApp, reply: unknown): 'allowed' | 'disabled' | 'unknown' {
  if (
    !object(reply) ||
    !Array.isArray(reply.apps) ||
    reply.apps.length !== 1 ||
    !Array.isArray(reply.missingAppIds) ||
    reply.missingAppIds.length
  )
    return 'unknown';
  const item = reply.apps[0];
  if (!object(item) || item.id !== HOSTED_APPS[app].codexConnector || !Array.isArray(item.toolSummaries)) return 'unknown';
  const matches = item.toolSummaries.filter((t) => object(t) && t.name === leaves[app]);
  if (matches.length !== 1 || matches[0].isReadOnly !== true) return 'unknown';
  if (matches[0].isEnabled === false) return 'disabled';
  return matches[0].isEnabled === true ? 'allowed' : 'unknown';
}

/** Obtain the wire name from the thread's own Codex Apps tool catalog, restricted to one
 * provider-published connector ID. A name collision, multiple links, or a required argument
 * makes the current account ambiguous. Never supply a user ID to one of these tools. */
export function profileTool(app: HostedApp, reply: unknown): { name: string; link: string | null } | undefined {
  if (!object(reply) || reply.nextCursor != null || !Array.isArray(reply.data) || reply.data.length !== 1) return;
  const row = reply.data[0];
  if (!object(row) || row.name !== 'codex_apps' || row.pluginId != null || row.httpOrigin !== 'https://chatgpt.com' || !object(row.tools))
    return;
  let found: { name: string; link: string | null } | undefined;
  for (const [name, tool] of Object.entries(row.tools)) {
    if (
      !object(tool) ||
      tool.name !== name ||
      name.split('.').at(-1) !== leaves[app] ||
      !object(tool._meta) ||
      tool._meta.connector_id !== HOSTED_APPS[app].codexConnector
    )
      continue;
    if (
      found ||
      !/^[a-zA-Z0-9_.-]{1,200}$/.test(name) ||
      !object(tool.annotations) ||
      tool.annotations.readOnlyHint !== true ||
      !object(tool.inputSchema) ||
      tool.inputSchema.type !== 'object' ||
      (tool.inputSchema.required !== undefined && (!Array.isArray(tool.inputSchema.required) || tool.inputSchema.required.length))
    )
      return;
    const link = tool._meta.link_id;
    if (
      link != null &&
      (typeof link !== 'string' || !link.length || link.length > 1024 || /[\s\x00-\x1f]/.test(link) || link.startsWith('synthetic_link::'))
    )
      return;
    found = { name, link: typeof link === 'string' ? link : null };
  }
  return found;
}

function failed(raw: unknown): boolean {
  if (!object(raw)) return false;
  return (
    !!raw.error ||
    raw.ok === false ||
    raw.success === false ||
    [raw.status, raw.statusCode, raw.status_code].some((code) => typeof code === 'number' && code >= 400)
  );
}

function profile(app: HostedApp, raw: unknown): boolean {
  if (!object(raw) || failed(raw)) return false;
  if (app === 'slack') {
    const user = object(raw.user) ? raw.user : raw;
    const p = object(user.profile) ? user.profile : undefined;
    return (
      !!p &&
      ((typeof user.id === 'string' && /^[UW][A-Z0-9]+$/.test(user.id)) || email(p.email)) &&
      [p.real_name, p.display_name, p.email].some(text)
    );
  }
  return text(raw.id) && (email(raw.userPrincipalName) || email(raw.mail) || email(raw.email));
}

/** Require recognizable self-profile fields in structured output or a JSON MCP text result.
 * Plain prose, setup links and bot/tool errors never establish an authenticated account. */
export function profileStatus(app: HostedApp, result: unknown): HostedAppStatus {
  if (!object(result)) return 'unknown';
  const auth = object(result._meta) ? result._meta['mcp/www_authenticate'] : undefined;
  if (result.isError === true || auth !== undefined) {
    const challenges = Array.isArray(auth) ? auth : [auth];
    return challenges.some((s) => typeof s === 'string' && /^Bearer(?:\s|$)/i.test(s)) ? 'needs-auth' : 'unknown';
  }
  if (result.isError != null && result.isError !== false) return 'unknown';
  let jsonText: unknown;
  if (Array.isArray(result.content) && result.content.length === 1) {
    const block = result.content[0];
    if (object(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length <= 128 * 1024) {
      try {
        jsonText = JSON.parse(block.text);
      } catch {
        /* Setup instructions or other unstructured text. */
      }
    }
  }
  const candidates = [result.structuredContent, jsonText];
  if (failed(result) || candidates.some((v) => failed(v) || (object(v) && failed(v.data)))) return 'unknown';
  return candidates.some((v) => profile(app, v) || (object(v) && profile(app, v.data))) ? 'connected' : 'unknown';
}
