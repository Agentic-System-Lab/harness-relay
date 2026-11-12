'use strict';
/*
 * The fake OpenHands (`openhands`, an open agent; its turns over ACP, `openhands acp`): not written
 * yet. Every start says so on stderr and exits with code 2, and the end-to-end tests treat
 * OpenHands as not installed (`implemented: false` in e2e/support/clis/openhands.ts). It exports
 * what every fake module exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to
 * have.
 */
const os = require('node:os');
const path = require('node:path');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'openhands',
  bin: 'openhands',
  aliases: [],
  label: 'OpenHands',
  name: 'OpenHands',
  version: 'OpenHands CLI 1.16.999',
  versionRe: /^OpenHands CLI 1\.16\.999$/m,
  /**
   * Its state, which a run may write (its adapter's only `statePaths`): `OPENHANDS_CONVERSATIONS_DIR`.
   */
  home: (env) => env.OPENHANDS_CONVERSATIONS_DIR || path.join(os.homedir(), '.openhands', 'conversations'),
  /** Open agents have no key of their own: their model backend's reaches them (later: logged as such). */
  apiKey: () => null,
  main() {
    process.stderr.write(`fake openhands: not implemented yet (e2e/fake-cli/agents/openhands.cjs)\n`, () => exitAfterLog(2));
  },
};
