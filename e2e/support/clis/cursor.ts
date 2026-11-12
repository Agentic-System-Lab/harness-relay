/**
 * Cursor: ACP (`cursor-agent acp`); no OS sandbox, so below full access it asks before every
 * command and every write outside the first working directory (src/server/agents/cursor.ts). Its
 * fake is not written yet: these are the values it is expected to have, to be checked then.
 */
import type { CliFacts } from './types';

export const cursor: CliFacts = {
  provider: 'cursor',
  bin: 'cursor-agent',
  name: 'Cursor',
  label: 'Cursor',
  implemented: false,
  version: 'v2026.11.99-fake',
  sandbox: 'none',
  belowFullOn: ['darwin', 'linux', 'win32'],
  listTool: 'Read',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  // Read-only: its own deny rule refuses a write without a card.
  readOnlyWriteAsks: false,
  outsideWrite: { asks: true, writtenOnceAllowed: true },
  otherCwdWriteAsks: true,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'cursor-fake', effort: 'high' },
  defaultHome: { in: 'home', path: ['.config', 'cursor'] },
  accounts: 'key-only',
  apiKeyEnv: 'CURSOR_API_KEY',
  apiKeyPlaceholder: 'key_…',
};
