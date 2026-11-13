/**
 * Claude Code: stream-json; its own permission rules keep it in the chat's folders (`--permission-
 * mode`, `--add-dir`).
 */
import type { CliFacts } from './types';

export const claude: CliFacts = {
  provider: 'claude',
  bin: 'claude',
  name: 'Claude',
  label: 'Claude Code',
  implemented: true,
  version: 'v2.1.999',
  sandbox: 'own',
  belowFullOn: ['darwin', 'linux', 'win32'],
  // On macOS it stands for the five CLIs with a sign-in, whose fakes do there what they do on Linux;
  // on Windows it has no sandbox settings (`claudeSandboxSettings`).
  testedOn: ['linux', 'darwin', 'win32'],
  listTool: 'Bash',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'passed',
  // Read-only: it has no file tools at all, so nothing asks.
  readOnlyWriteAsks: false,
  outsideWrite: { asks: true, writtenOnceAllowed: true },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'opus', effort: 'high' },
  defaultHome: { in: 'home', path: ['.claude'] },
  accounts: 'sign-in',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  apiKeyPlaceholder: 'sk-ant-…',
  logout: 'auth logout',
  signedOutError: 'Not logged in',
  usage: { plan: 'max', limit: '5-hour limit' },
};
