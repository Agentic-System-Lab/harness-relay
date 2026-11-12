'use strict';
/*
 * The fake Cline (`cline`, an open agent; its turns over ACP, `cline --acp`): not written yet.
 * Every start says so on stderr and exits with code 2, and the end-to-end tests treat Cline as not
 * installed (`implemented: false` in e2e/support/clis/cline.ts). It exports what every fake module
 * exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const os = require('node:os');
const path = require('node:path');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'cline',
  bin: 'cline',
  aliases: [],
  label: 'Cline',
  name: 'Cline',
  version: '3.99.999',
  versionRe: /^3\.99\.999$/m,
  /**
   * Its state, which a run may write (its adapter's `statePaths`): `CLINE_DATA_DIR` (`<state>/data`).
   */
  home: (env) => env.CLINE_DATA_DIR || path.join(os.homedir(), '.cline', 'data'),
  /** Open agents have no key of their own: their model backend's reaches them (later: logged as such). */
  apiKey: () => null,
  main() {
    process.stderr.write(`fake cline: not implemented yet (e2e/fake-cli/agents/cline.cjs)\n`, () => exitAfterLog(2));
  },
};
