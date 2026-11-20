// Only the isolated test server uses these two local OAuth/MCP services.
import 'tsx';
import { APP_SERVERS } from '../../src/shared/apps.ts';
const replacements = JSON.parse(process.env.E2E_CATALOG_MCP || '{}');
for (const app of ['notion', 'heptabase']) {
  const url = new URL(replacements[app]);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp')
    throw new Error('Expected a local catalog MCP fixture');
  APP_SERVERS[app] = url.href;
}
