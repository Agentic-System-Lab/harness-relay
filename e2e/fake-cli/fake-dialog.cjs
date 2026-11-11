'use strict';
/*
 * A stand-in for zenity, the folder dialog Harness Relay opens on Linux (`src/server/folderPicker.ts`),
 * for the end-to-end tests. `e2e/support/fake-cli.ts` installs it as `zenity` next to the fake CLIs on
 * macOS and Linux, where Linux finds it first on the PATH in a graphical session (a test sets DISPLAY).
 * macOS and Windows open their own dialogs by their full paths, so it is never used there.
 *
 * It shows nothing. It answers with the folders E2E_FAKE_PICK lists (a JSON array), each resolved
 * from the folder it opens at (`--filename`), joined by `--separator` as zenity does; with none (unset
 * or `[]`) it is cancelled: exit code 1, as zenity's Cancel. Each start goes to E2E_FAKE_LOG with its
 * arguments and the character set it was given (`LANG`, `LC_CTYPE`), for the tests to read.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
/** The value of `--name=value`, or undefined. */
const value = (name) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg === undefined ? undefined : arg.slice(name.length + 3);
};

if (process.env.E2E_FAKE_LOG) {
  try {
    const env = { LANG: process.env.LANG ?? null, LC_CTYPE: process.env.LC_CTYPE ?? null };
    fs.appendFileSync(process.env.E2E_FAKE_LOG, JSON.stringify({ cli: 'zenity', pid: process.pid, at: Date.now(), args, env }) + '\n');
  } catch {
    /* the log is a convenience */
  }
}

if (!args.includes('--file-selection') || !args.includes('--directory')) {
  process.stderr.write(`fake zenity: only a folder selection (--file-selection --directory), not ${args.join(' ')}\n`);
  process.exit(255);
}

let picked;
try {
  picked = JSON.parse(process.env.E2E_FAKE_PICK || '[]');
} catch {
  process.stderr.write('fake zenity: E2E_FAKE_PICK is not a JSON array\n');
  process.exit(255);
}
if (!Array.isArray(picked) || !picked.length) process.exit(1);

const start = value('filename') || process.cwd();
// zenity's own separator is `|`.
process.stdout.write(picked.map((p) => path.resolve(start, p)).join(value('separator') ?? '|') + '\n');
