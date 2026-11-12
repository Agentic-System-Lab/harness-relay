/**
 * Antigravity: ACP (`agy acp`); no sandbox, so below full access it asks before every command and
 * write, and a refusal ends its turn (src/server/agents/antigravity.ts). Its fake is not written
 * yet: these are the values it is expected to have, to be checked then.
 */
import type { CliFacts } from './types';

export const antigravity: CliFacts = {
  provider: 'antigravity',
  bin: 'agy',
  name: 'Antigravity',
  label: 'Antigravity',
  implemented: false,
  version: 'v1.5.999',
  sandbox: 'none',
  belowFullOn: ['darwin', 'linux', 'win32'],
  listTool: 'list_dir',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'ends-turn',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: true, writtenOnceAllowed: true },
  otherCwdWriteAsks: false,
  // agy 1.5.6 does not say it takes HTTP MCP servers (src/server/agents/antigravity.ts): to be checked with its fake.
  mcpHttp: false,
  images: true,
  pickModel: { model: 'gemini-3.8-flash', effort: 'high' },
  defaultHome: { in: 'home', path: ['.gemini'] },
  accounts: 'key-only',
  apiKeyEnv: 'GEMINI_API_KEY',
  apiKeyPlaceholder: 'AIza…',
};
