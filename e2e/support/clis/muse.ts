/**
 * Muse Code: ACP (`muse acp`); below full access its own OS sandbox keeps its commands in the chat's
 * folders, and a permission profile of Harness Relay's (`:ask-me` with deny rules) and the session's
 * mode decide what asks (src/server/agents/muse.ts). Its fake: e2e/fake-cli/agents/muse.cjs, which does
 * not let a command write in a temporary folder, as the real one's sandbox does (every test folder is
 * in one).
 */
import type { CliFacts } from './types';

export const muse: CliFacts = {
  provider: 'muse',
  bin: 'muse',
  name: 'Muse',
  label: 'Muse Code',
  implemented: true,
  version: 'v1.4.999',
  sandbox: 'own',
  belowFullOn: ['darwin', 'linux', 'win32'],
  // Not on macOS, where it runs as on Linux but for the folders its Linux sandbox leaves (removed on
  // Linux only); on Windows its sign-in is copied, not linked, nothing else is linked, and its shell
  // tool is PowerShell. Its fake runs commands below full access on Windows too, in the sandbox it
  // works out; the real muse 1.4.18 runs none there (its ACP mode uses no sandbox on Windows).
  testedOn: ['linux', 'win32'],
  // Its `search` tool (a glob), of kind `search`, which the chat calls Search.
  listTool: 'Search',
  // Read-only is its `promptUnmatched` mode, in which every command asks (in edit mode `echo` runs in its sandbox unasked).
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  // It takes no message with a refusal: the model sees Muse's own "The user rejected this action".
  decline: 'dropped',
  // Read-only: `--disable-write` takes its file tools away, so nothing asks.
  readOnlyWriteAsks: false,
  // Its file tool refuses a path outside the workspace without asking; the command it tries next is
  // allowed by its adapter (edit mode) and refused by its sandbox.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'muse-spark-1.3', effort: 'medium' },
  // Its data folder (sessions), which a turn keeps: its config folder is the turn's own then.
  defaultHome: { in: 'home', path: ['.local', 'share', 'muse'] },
  accounts: 'key-only',
  apiKeyEnv: 'META_API_KEY',
  apiKeyPlaceholder: 'meta-…',
  // An account's folder holds its config folder (`config/muse`) and its data folder (`data/muse`).
  homeIn: ['data', 'muse'],
  // `session/new` fails signed out (src/server/i18n.ts `museSignIn` quotes it).
  signedOutError: 'log in to Muse',
};
