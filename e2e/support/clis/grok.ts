/**
 * Grok: ACP; its own sandbox (a profile of its sandbox.toml) keeps it in the chat's folders, except
 * on Windows, where it has none.
 */
import type { CliFacts } from './types';

export const grok: CliFacts = {
  provider: 'grok',
  bin: 'grok',
  name: 'Grok',
  label: 'Grok',
  implemented: true,
  version: 'v1.0.999',
  sandbox: 'own',
  belowFullOn: ['darwin', 'linux', 'win32'],
  unconfinedOn: ['win32'],
  listTool: 'list_dir',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'passed',
  readOnlyWriteAsks: true,
  // It asks, and its sandbox refuses the write even when the user allows it.
  outsideWrite: { asks: true, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'grok-fake-mini', effort: 'high' },
  defaultHome: { in: 'home', path: ['.grok'] },
  accounts: 'sign-in',
  apiKeyEnv: 'XAI_API_KEY',
  apiKeyPlaceholder: 'xai-…',
  signedOutError: 'not authenticated',
};
