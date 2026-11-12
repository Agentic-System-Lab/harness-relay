/**
 * OpenHands: an open agent, ACP (`openhands acp`), in Harness Relay's own sandbox below full
 * access, on macOS only with its terminal switch on (docs/open-agents.md). Its fake is not written
 * yet: these are the values it is expected to have, to be checked then.
 */
import type { CliFacts } from './types';

export const openhands: CliFacts = {
  provider: 'openhands',
  bin: 'openhands',
  name: 'OpenHands',
  label: 'OpenHands',
  implemented: false,
  version: 'v1.16.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  listTool: 'file_editor',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  readOnlyWriteAsks: true,
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'openhands'] },
  accounts: 'none',
};
