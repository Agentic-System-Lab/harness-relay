'use strict';
/*
 * The fake Cursor (`cursor-agent`; its turns over ACP, `cursor-agent acp`): not written yet. Every
 * start says so on stderr and exits with code 2, and the end-to-end tests treat Cursor as not
 * installed (`implemented: false` in e2e/support/clis/cursor.ts). It exports what every fake module
 * exports (see e2e/fake-cli/fake-cli.cjs), with the values its fake is to have.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keyVerdict } = require('../lib/home.cjs');
const { exitAfterLog } = require('../lib/log.cjs');

module.exports = {
  provider: 'cursor',
  bin: 'cursor-agent',
  aliases: ['agent'],
  label: 'Cursor',
  name: 'Cursor',
  version: '2026.11.99-fake',
  versionRe: /^2026\.11\.99-fake$/m,
  /**
   * The account's folder: `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else ~/.cursor
   * (`cursorConfigDir()`). In a turn `CURSOR_CONFIG_DIR` is a private folder of that turn's own, whose
   * `acp-sessions` links into the account's folder, which is then the home.
   */
  home(env) {
    const config = env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
    try {
      return path.dirname(fs.realpathSync(path.join(config, 'acp-sessions')));
    } catch {
      return config;
    }
  },
  /** The key it was given (CURSOR_API_KEY, CURSOR_AUTH_TOKEN), by `keyVerdict`; null for none. */
  apiKey: (env) => (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN ? keyVerdict(env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) : null),
  main() {
    process.stderr.write(`fake cursor: not implemented yet (e2e/fake-cli/agents/cursor.cjs)\n`, () => exitAfterLog(2));
  },
};
