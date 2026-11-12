'use strict';
/*
 * The fake Pi (`pi`, an open agent; its turns over JSONL RPC, `pi --mode rpc`): not written yet.
 * Every start says so on stderr and exits with code 2, and the end-to-end tests treat Pi as not
 * installed (`implemented: false` in e2e/support/clis/pi.ts). It exports what every fake module
 * exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const os = require('node:os');
const path = require('node:path');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'pi',
  bin: 'pi',
  aliases: [],
  label: 'Pi',
  name: 'Pi',
  version: '1.5.998',
  versionRe: /^1\.5\.998$/m,
  /**
   * Its state, which a run may write (its adapter's `statePaths`): `PI_CODING_AGENT_SESSION_DIR`.
   */
  home: (env) => env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  /** Open agents have no key of their own: their model backend's reaches them (later: logged as such). */
  apiKey: () => null,
  main() {
    process.stderr.write(`fake pi: not implemented yet (e2e/fake-cli/agents/pi.cjs)\n`, () => exitAfterLog(2));
  },
};
