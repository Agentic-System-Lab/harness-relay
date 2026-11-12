/**
 * Codex: `codex app-server`; its own sandbox keeps it in the chat's folders, and it may ask to go
 * beyond it.
 */
import type { CliFacts } from './types';

export const codex: CliFacts = {
  provider: 'codex',
  bin: 'codex',
  name: 'Codex',
  label: 'Codex',
  implemented: true,
  version: 'v0.999.0',
  sandbox: 'own',
  belowFullOn: ['darwin', 'linux', 'win32'],
  listTool: 'Shell',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: true, writtenOnceAllowed: true },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'gpt-fake-mini', effort: 'high' },
  defaultHome: { in: 'home', path: ['.codex'] },
  accounts: 'sign-in',
  // Codex keeps a key itself (`codex login --with-api-key`); the server's own may be OPENAI_API_KEY or CODEX_API_KEY.
  apiKeyEnv: 'OPENAI_API_KEY',
  apiKeyPlaceholder: 'sk-…',
  signedOutError: 'Not logged in',
};
