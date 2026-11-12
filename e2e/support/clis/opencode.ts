/**
 * OpenCode: an open agent, ACP (`opencode acp`), in Harness Relay's own sandbox below full access,
 * which it has on macOS only (docs/open-agents.md). Its fake is not written yet: these are the
 * values it is expected to have, to be checked then.
 */
import type { CliFacts } from './types';

export const opencode: CliFacts = {
  provider: 'opencode',
  bin: 'opencode',
  name: 'OpenCode',
  label: 'OpenCode',
  implemented: false,
  version: 'v1.19.999',
  sandbox: 'relay',
  belowFullOn: ['darwin'],
  listTool: 'glob',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'passed',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'opencode'] },
  accounts: 'none',
};
