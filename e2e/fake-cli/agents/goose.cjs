'use strict';
/*
 * The fake Goose (`goose`, an open agent; its turns over ACP, `goose acp`): not written yet. Every
 * start says so on stderr and exits with code 2, and the end-to-end tests treat Goose as not
 * installed (`implemented: false` in e2e/support/clis/goose.ts). It exports what every fake module
 * exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const os = require('node:os');
const path = require('node:path');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'goose',
  bin: 'goose',
  aliases: [],
  label: 'Goose',
  name: 'Goose',
  version: '1.58.999',
  versionRe: /^1\.58\.999$/m,
  /**
   * Its state, which a run may write (one of its adapter's `statePaths`): `<GOOSE_PATH_ROOT>/data`.
   */
  home: (env) => path.join(env.GOOSE_PATH_ROOT || os.homedir(), 'data'),
  /** Open agents have no key of their own: their model backend's reaches them (later: logged as such). */
  apiKey: () => null,
  main() {
    process.stderr.write(`fake goose: not implemented yet (e2e/fake-cli/agents/goose.cjs)\n`, () => exitAfterLog(2));
  },
};
