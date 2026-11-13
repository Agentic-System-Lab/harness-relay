/**
 * Antigravity: ACP (`agy acp`); no sandbox, so below full access it asks before every command and
 * write (its adapter allows a write in the chat's working directories in edit mode), and a refusal
 * ends its turn (src/server/agents/antigravity.ts). Its fake: e2e/fake-cli/agents/antigravity.cjs.
 */
import type { CliFacts } from './types';

export const antigravity: CliFacts = {
  provider: 'antigravity',
  bin: 'agy',
  name: 'Antigravity',
  label: 'Antigravity',
  implemented: true,
  version: 'v1.5.999',
  sandbox: 'none',
  belowFullOn: ['darwin', 'linux', 'win32'],
  // Not on macOS, where it runs as on Linux; on Windows its account's home reaches the probes as
  // `USERPROFILE`, not `HOME` (`antigravityProbeEnv`).
  testedOn: ['linux', 'win32'],
  // Its `list_dir` is of kind `read`, which the chat calls Read.
  listTool: 'Read',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'ends-turn',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: true, writtenOnceAllowed: true },
  otherCwdWriteAsks: false,
  // agy 1.5.6 does not say it takes HTTP MCP servers (no `mcpCapabilities`), so they are left out of its runs.
  mcpHttp: false,
  images: true,
  // Medium is a thinking level of this model only: set once the model is.
  pickModel: { model: 'gemini-fake-flash', effort: 'medium' },
  // Its `.gemini` folder; an added account's is `<the account's folder>/.gemini` too.
  defaultHome: { in: 'home', path: ['.gemini'] },
  accounts: 'key-only',
  apiKeyEnv: 'GEMINI_API_KEY',
  apiKeyPlaceholder: 'AIza…',
  homeIn: ['.gemini'],
  // Its ACP `logout`, in an `agy acp` of its own (the default account's: no --gemini-dir).
  logout: 'acp',
  signedOutError: 'Authentication required',
  // It asks before reading outside the workspace, and its adapter allows any read but of the protected paths.
  skillReadAsks: false,
  usage: { plan: 'Google AI Pro', limit: '5-hour limit · Gemini 3.1 Pro' },
};
