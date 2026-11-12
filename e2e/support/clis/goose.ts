/**
 * Goose: an open agent, ACP (`goose acp`), in Harness Relay's own sandbox below full access
 * (docs/open-agents.md). Its fake is not written yet: these are the values it is expected to have,
 * to be checked then.
 */
import type { CliFacts } from './types';

export const goose: CliFacts = {
  provider: 'goose',
  bin: 'goose',
  name: 'Goose',
  label: 'Goose',
  implemented: false,
  version: 'v1.58.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  listTool: 'tree',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'passed',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'goose'] },
  accounts: 'none',
};
