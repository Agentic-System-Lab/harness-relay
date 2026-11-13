/**
 * Copilot: ACP (`copilot --acp`); below full access its own sandbox (`--sandbox`, the policy in the
 * run's home), which keeps commands and its file tools in the chat's working directories, and a
 * refusal ends its turn (src/server/agents/copilot.ts). Its fake: e2e/fake-cli/agents/copilot.cjs.
 */
import type { CliFacts } from './types';

export const copilot: CliFacts = {
  provider: 'copilot',
  bin: 'copilot',
  name: 'Copilot',
  label: 'Copilot',
  implemented: true,
  version: 'v1.0.999',
  sandbox: 'own',
  belowFullOn: ['darwin', 'linux', 'win32'],
  // Not on macOS, where its fake does what it does on Linux (the caches its policy lists there are
  // nothing a fake checks); on Windows the run's folders are linked in as junctions and its session
  // store is not linked (`prepareCopilotRun`), and it starts through npm's shim.
  testedOn: ['linux', 'win32'],
  // Its `view` of a folder is of kind `read`, which the chat calls Read.
  listTool: 'Read',
  // It runs `echo` without asking (it takes it for read-only); edit mode asks before publishing.
  approve: { permission: 'edit', directive: 'e2e:approve=publish', command: 'npm publish e2e-approval' },
  decline: 'ends-turn',
  readOnlyWriteAsks: true,
  // Its file tools keep to its sandbox's policy: a write outside it fails without asking.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'claude-fake-sonnet', effort: 'high' },
  defaultHome: { in: 'home', path: ['.copilot'] },
  accounts: 'sign-in',
  apiKeyEnv: 'COPILOT_GITHUB_TOKEN',
  apiKeyPlaceholder: 'github_pat_…',
  // Its ACP `logout`, which its fake logs as a line of its own (every start of it is `--acp`).
  logout: 'acp logout',
  signedOutError: 'Authentication required',
  // It asks before reading outside the working directories, and its adapter allows any read but of the protected paths.
  skillReadAsks: false,
  // Its sign-in is asked in a home of the question's own, with a copy of the account's sign-in state.
  statusInOwnFolder: false,
};
