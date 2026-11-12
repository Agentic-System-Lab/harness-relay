/**
 * Cline: an open agent, ACP (`cline --acp`), in Harness Relay's own sandbox below full access
 * (docs/open-agents.md). Its fake is not written yet: these are the values it is expected to have,
 * to be checked then.
 */
import type { CliFacts } from './types';

export const cline: CliFacts = {
  provider: 'cline',
  bin: 'cline',
  name: 'Cline',
  label: 'Cline',
  implemented: false,
  version: 'v3.99.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  listTool: 'read_files',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'cline'] },
  accounts: 'none',
};
