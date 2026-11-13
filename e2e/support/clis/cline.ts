/**
 * Cline: an open agent, ACP (`cline --acp`), in Harness Relay's own sandbox below full access
 * (docs/open-agents.md). It asks about every tool call, reads too (Harness Relay allows the reads by
 * itself); a refusal reaches its model only as its own fixed words, so the user's note is dropped. It
 * has no to-do list over ACP, and its model never sees a prompt's images (only their paths, in the
 * prompt's text). On Windows it runs with full access only, and Settings cannot list what it loads by
 * itself there (that runs `/bin/sh`).
 */
import type { CliFacts } from './types';

export const cline: CliFacts = {
  provider: 'cline',
  bin: 'cline',
  name: 'Cline',
  label: 'Cline',
  implemented: true,
  version: 'v3.99.999',
  sandbox: 'relay',
  belowFullOn: ['darwin', 'linux'],
  // On macOS in Harness Relay's own sandbox as Seatbelt makes it. Not on Windows: there it runs with
  // full access only, as on Linux with full access, and its own tests could tell nothing more (Settings
  // cannot list what it loads by itself there, which no test of its own looks at); `windows.spec.ts`
  // still starts it there, through npm's shim.
  testedOn: ['linux', 'darwin'],
  listTool: 'read_files',
  approve: { permission: 'read-only', directive: 'e2e:approve', command: 'echo e2e-approval' },
  decline: 'dropped',
  readOnlyWriteAsks: true,
  // Edit mode lets it write without asking; the sandbox refuses a folder the chat was not given.
  outsideWrite: { asks: false, writtenOnceAllowed: false },
  otherCwdWriteAsks: false,
  mcpHttp: true,
  images: false,
  pickModel: { model: 'e2e/e2e-model-mini', effort: 'high', logged: { model: 'e2e-model-mini' } },
  defaultHome: { in: 'data', path: ['agent-homes', 'cline'] },
  accounts: 'none',
  // No to-do list over ACP.
  todoList: false,
};
