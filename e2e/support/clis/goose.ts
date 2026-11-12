/**
 * Goose: an open agent, ACP (`goose acp`), in Harness Relay's own sandbox below full access
 * (docs/open-agents.md); on Windows it runs with full access only.
 */
import type { CliFacts } from './types';

export const goose: CliFacts = {
  provider: 'goose',
  bin: 'goose',
  name: 'Goose',
  label: 'Goose',
  implemented: true,
  version: 'v1.58.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  listTool: 'tree',
  // In read-only Harness Relay lets plain reading commands run without asking (`echo` among them), so the
  // fake asks to run `env echo e2e-approval`, which prints the same.
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'env echo e2e-approval' },
  // The reason (the user's note) reaches the model as a steer of the running turn.
  decline: 'passed',
  readOnlyWriteAsks: true,
  // In edit mode Harness Relay allows the write (it asks in approve mode), and the sandbox refuses it.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  // Team settings offers Goose's five levels for every model, but an endpoint's provider offers only
  // `off`, so Harness Relay does not set the one picked: the turn runs with `off`. Goose names the model
  // alone (GOOSE_MODEL), its provider apart (`relay-e2e`).
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high', logged: { model: 'e2e-model-mini', effort: 'off' } },
  defaultHome: { in: 'data', path: ['agent-homes', 'goose'] },
  accounts: 'none',
};
