/**
 * OpenCode: an open agent, ACP (`opencode acp`), in Harness Relay's own sandbox below full access,
 * which it has on macOS only (docs/open-agents.md); on Linux and Windows it runs with full access only.
 */
import type { CliFacts } from './types';

export const opencode: CliFacts = {
  provider: 'opencode',
  bin: 'opencode',
  name: 'OpenCode',
  label: 'OpenCode',
  implemented: true,
  version: 'v1.19.999',
  sandbox: 'relay',
  belowFullOn: ['darwin'],
  // macOS is the one system it runs below full access on, in Harness Relay's own sandbox (Seatbelt,
  // with its server's port opened); on Windows it keeps its own shell (relay-shell is a POSIX script).
  testedOn: ['linux', 'darwin', 'win32'],
  listTool: 'glob',
  // Its rules ask about every command below full access; Harness Relay asks the user in read-only.
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  // The reason (the user's note) reaches the model through its own server, as the rejection's feedback.
  decline: 'passed',
  readOnlyWriteAsks: true,
  // In edit mode its `external_directory` request is allowed (an edit), and the sandbox refuses the write.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  // An endpoint's models have no effort levels in OpenCode (variants come only with its catalog's models),
  // so Team settings offers none for it: the effort stays the default. OpenCode's own id for the model
  // is its provider's (`relay-<endpoint>/<model>`).
  pickModel: { model: 'e2e/e2e-model-mini', effort: '', logged: { model: 'relay-e2e/e2e-model-mini', effort: '' } },
  defaultHome: { in: 'data', path: ['agent-homes', 'opencode'] },
  accounts: 'none',
};
