/**
 * Pi: an open agent, JSONL RPC (`pi --mode rpc`), in Harness Relay's own sandbox below full access,
 * with Harness Relay's gate extension asking for it (docs/open-agents.md). Its fake is not written
 * yet: these are the values it is expected to have, to be checked then.
 */
import type { CliFacts } from './types';

export const pi: CliFacts = {
  provider: 'pi',
  bin: 'pi',
  name: 'Pi',
  label: 'Pi',
  implemented: false,
  version: 'v1.5.998',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  listTool: 'ls',
  // Read-only gives it no command tool: edit mode, and the one kind of command that asks there.
  approve: { permission: 'edit', directive: 'e2e:approve=publish', command: 'npm publish e2e-approval' },
  decline: 'passed',
  // Read-only gives it no write tool, so nothing asks.
  readOnlyWriteAsks: false,
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'pi'] },
  accounts: 'none',
};
