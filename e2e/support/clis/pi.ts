/**
 * Pi: an open agent, JSONL RPC (`pi --mode rpc`), in Harness Relay's own sandbox below full access,
 * with Harness Relay's gate extension asking for it (docs/open-agents.md): its fake loads the real
 * gate (src/server/agents/piGate.js) and runs it before each tool call. Below full access its tools
 * are its reading ones in read-only (no command or write tool at all), Pi's defaults in edit mode,
 * where only pushing or publishing asks; with full access there is neither gate nor sandbox.
 */
import type { CliFacts } from './types';

export const pi: CliFacts = {
  provider: 'pi',
  bin: 'pi',
  name: 'Pi',
  label: 'Pi',
  implemented: true,
  version: 'v1.5.998',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  // Its `ls` tool, one of read-only's. Pi's tools in edit mode and with full access have no `ls`: a
  // listing there is a `bash` `ls`, shown as `Bash` (as on Windows, where it runs with full access only).
  listTool: 'List',
  listToolFull: 'Bash',
  // Read-only gives it no command tool: edit mode, and the one kind of command that asks there.
  approve: { permission: 'edit', directive: 'e2e:approve=publish', command: 'npm publish e2e-approval' },
  decline: 'passed',
  // Read-only gives it no write tool, so nothing asks.
  readOnlyWriteAsks: false,
  // Its gate lets an edit run in edit mode without asking; the sandbox refuses it outside the chat's folders.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  // Pi names an endpoint's models by its own provider id for the endpoint.
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high', logged: { model: 'relay-e2e/e2e-model-mini' } },
  defaultHome: { in: 'data', path: ['agent-homes', 'pi'] },
  accounts: 'none',
  // Pi has no to-do lists.
  todoList: false,
  // Read-only gives it no command tool to reach a URL with (`bash` `curl`): edit mode, where the sandbox's proxy asks.
  fetchPermission: 'edit',
};
