'use strict';
/*
 * The fake OpenCode (`opencode`, an open agent; its turns over ACP, `opencode acp`): not written
 * yet. Every start says so on stderr and exits with code 2, and the end-to-end tests treat OpenCode
 * as not installed (`implemented: false` in e2e/support/clis/opencode.ts). It exports what every
 * fake module exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const os = require('node:os');
const path = require('node:path');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'opencode',
  bin: 'opencode',
  aliases: [],
  label: 'OpenCode',
  name: 'OpenCode',
  version: '1.19.999',
  versionRe: /^1\.19\.999$/m,
  /**
   * Its state, which a run may write (one of its adapter's `statePaths`): `XDG_DATA_HOME` (`<state>/data`).
   */
  home: (env) => env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  /** Open agents have no key of their own: their model backend's reaches them (later: logged as such). */
  apiKey: () => null,
  main() {
    process.stderr.write(`fake opencode: not implemented yet (e2e/fake-cli/agents/opencode.cjs)\n`, () => exitAfterLog(2));
  },
};
