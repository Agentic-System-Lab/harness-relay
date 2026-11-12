'use strict';
/*
 * The fake Antigravity (`agy`; its turns over ACP, `agy acp`): not written yet. Every start says so
 * on stderr and exits with code 2, and the end-to-end tests treat Antigravity as not installed
 * (`implemented: false` in e2e/support/clis/antigravity.ts). It exports what every fake module
 * exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const os = require('node:os');
const path = require('node:path');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'antigravity',
  bin: 'agy',
  aliases: [],
  label: 'Antigravity',
  name: 'Antigravity',
  version: '1.5.999',
  versionRe: /^1\.5\.999$/m,
  /**
   * Its folder: `--gemini-dir` (an added account's), else ~/.gemini.
   */
  home: (env, args) => {
    const i = args.indexOf('--gemini-dir');
    return i >= 0 && args[i + 1] ? args[i + 1] : path.join(os.homedir(), '.gemini');
  },
  /** The key it was given (GEMINI_API_KEY), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.GEMINI_API_KEY ? keyVerdict(env.GEMINI_API_KEY) : null),
  main() {
    process.stderr.write(`fake antigravity: not implemented yet (e2e/fake-cli/agents/antigravity.cjs)\n`, () => exitAfterLog(2));
  },
};
