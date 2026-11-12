/**
 * OpenHands: an open agent, ACP (`openhands acp`), in Harness Relay's own sandbox below full access,
 * on macOS only with its terminal switch on (docs/open-agents.md; the test servers turn it on). It asks
 * about every action but reading a file (Harness Relay allows those by itself), with one request that
 * names none of them; a refusal reaches its model only as its own fixed words, so the user's note is
 * dropped. It keeps a session in a folder named by its id without dashes. On Windows it runs with full
 * access only, and its model list (LiteLLM's, in its install) is not found there: only the endpoints'.
 */
import type { CliFacts } from './types';

export const openhands: CliFacts = {
  provider: 'openhands',
  bin: 'openhands',
  name: 'OpenHands',
  label: 'OpenHands',
  implemented: true,
  version: 'v1.16.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  // Its row reads `file_editor view`.
  listTool: 'file_editor',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  readOnlyWriteAsks: true,
  // Edit mode lets it write without asking; the sandbox refuses a folder the chat was not given.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: true,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high' },
  defaultHome: { in: 'data', path: ['agent-homes', 'openhands'] },
  accounts: 'none',
};
