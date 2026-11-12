'use strict';
/*
 * A stand-in for the GitHub CLI (`gh`), which Harness Relay shares conversations with
 * (`src/server/share.ts`), for the end-to-end tests. `e2e/support/fake-cli.ts` installs it as `gh`
 * next to the fake CLIs (a script on macOS and Linux; on Windows their single executable, named
 * `gh`), where the server finds it first on its PATH. It never reaches GitHub.
 *
 * It answers what share.ts asks of gh for a page shared without files:
 * - `gist create --filename <name> --desc <text> -`: keeps the page it reads on stdin as a gist of its
 *   own (secret unless `--public`), and prints its address, `https://gist.github.com/relay-e2e/<id>`;
 * - `gist delete <id> --yes`: deletes it (HTTP 404 for a gist it does not have);
 * - `api gists/<id> --silent`: whether it has that gist (HTTP 404 when it does not);
 * - `--version`.
 * Anything else fails ("not faked"): the files that go along with a page take `gh api` and a git push
 * to GitHub, so a share with files fails before git is started.
 *
 * Its gists are folders in `fake-github/gists/<id>/`, next to E2E_FAKE_LOG (the test's own folder):
 * each with its files and `gist.json` (the description, whether it is public, the files' names).
 * E2E_FAKE_SIGNED_OUT (a list, as for the fake CLIs) with `gh` in it makes it signed out: every
 * command but `--version` fails as gh does without an account. Each start goes to E2E_FAKE_LOG with
 * its arguments (`cli: 'gh'`), for the tests to read.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const LOG = process.env.E2E_FAKE_LOG;
const GISTS = LOG ? path.join(path.dirname(LOG), 'fake-github', 'gists') : undefined;

if (LOG) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ cli: 'gh', pid: process.pid, at: Date.now(), args }) + '\n');
  } catch {
    /* the log is a convenience */
  }
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const validId = (id) => typeof id === 'string' && /^[0-9a-f]{20,}$/.test(id);
const gistDir = (id) => path.join(GISTS, id);
const notFound = (id) => fail(`HTTP 404: Not Found (https://api.github.com/gists/${id})`);

async function main() {
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write('gh version 2.88.1 (2026-03-12)\nhttps://github.com/cli/cli/releases/tag/v2.88.1\n');
    return;
  }
  const signedOut = (process.env.E2E_FAKE_SIGNED_OUT || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('gh');
  if (signedOut) {
    fail(
      'To get started with GitHub CLI, please run:  gh auth login\n' +
        'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
      4,
    );
  }
  if (!GISTS) fail('fake gh: E2E_FAKE_LOG is not set, so it has nowhere to keep gists');

  const [cmd, sub, ...rest] = args;
  if (cmd === 'gist' && sub === 'create') return create(rest);
  if (cmd === 'gist' && sub === 'delete') return remove(rest);
  if (cmd === 'api' && rest.length === 1 && rest[0] === '--silent' && /^gists\/[^/?]+$/.test(sub || '')) {
    const id = sub.slice('gists/'.length);
    if (!validId(id) || !fs.existsSync(gistDir(id))) notFound(id);
    return;
  }
  fail(`fake gh: not faked: gh ${args.join(' ')}`);
}

/** `gist create [--filename <name>] [--desc <text>] [--public] <file | ->`: one file, from stdin or a path. */
async function create(rest) {
  let name;
  let description = '';
  let isPublic = false;
  const sources = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--filename' || a === '-f') name = rest[++i];
    else if (a === '--desc' || a === '-d') description = rest[++i] ?? '';
    else if (a === '--public' || a === '-p') isPublic = true;
    else if (a.startsWith('-') && a !== '-') fail(`unknown flag: ${a}`);
    else sources.push(a);
  }
  if (sources.length !== 1) fail('fake gh: gist create takes one file here (or - for stdin)');
  const data = sources[0] === '-' ? await readStdin() : fs.readFileSync(sources[0]);
  if (!data.length) fail('unable to create a gist from empty content');
  const file = name || (sources[0] === '-' ? 'gistfile0.txt' : path.basename(sources[0]));

  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(gistDir(id), { recursive: true });
  fs.writeFileSync(path.join(gistDir(id), file), data);
  fs.writeFileSync(path.join(gistDir(id), 'gist.json'), JSON.stringify({ id, description, public: isPublic, files: [file] }, null, 2));
  process.stderr.write(`- Creating gist ${file}\n✓ Created ${isPublic ? 'public' : 'secret'} gist ${file}\n`);
  process.stdout.write(`https://gist.github.com/relay-e2e/${id}\n`);
}

/** `gist delete <id> --yes` (without --yes gh would ask, which it cannot here). */
function remove(rest) {
  const id = rest.find((a) => !a.startsWith('-'));
  if (!rest.includes('--yes')) fail('--yes required when not running interactively');
  if (!validId(id) || !fs.existsSync(gistDir(id))) notFound(id);
  fs.rmSync(gistDir(id), { recursive: true, force: true });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

main().catch((err) => fail(`fake gh: ${err && err.stack ? err.stack : err}`));
