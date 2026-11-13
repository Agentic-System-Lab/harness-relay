/**
 * Cursor: ACP (`cursor-agent acp`); no OS sandbox, so below full access it asks before every
 * command and every write outside the first working directory, and its deny rules (the run's
 * `cli-config.json`) refuse a read-only chat's writes and the protected paths without asking
 * (src/server/agents/cursor.ts). Its fake does not write in a temporary folder unasked, as the real
 * one does (every test folder is in one).
 */
import type { CliFacts } from './types';

export const cursor: CliFacts = {
  provider: 'cursor',
  bin: 'cursor-agent',
  name: 'Cursor',
  label: 'Cursor',
  implemented: true,
  version: 'v2026.11.99-fake',
  sandbox: 'none',
  belowFullOn: ['darwin', 'linux', 'win32'],
  // Not on macOS, where it runs as on Linux; on Windows the run's sessions folder is linked in as a
  // junction (`prepareCursorRun`).
  testedOn: ['linux', 'win32'],
  listTool: 'Read',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  // It takes no message with a refusal: the model sees "Rejected: User rejected".
  decline: 'dropped',
  // Read-only: its own deny rule (`Write(**)`) refuses a write without a card.
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
  // Its `authenticate` fails, as the real one's does without a sign-in (src/server/i18n.ts `cursorSignIn`).
  signedOutError: 'Cursor is not signed in (Failed to open browser for login)',
};
