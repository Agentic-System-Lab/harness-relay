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
 * - `pr list --repo <owner/name> … --limit <n> --json <fields>` and `run list --repo <owner/name>
 *   [--branch <name>] … --limit <n> --json <fields>`, which an automation that waits for GitHub runs
 *   (`src/server/watch.ts`): the repository's pull requests, or its runs (those on the branch), as the
 *   test wrote them in `fake-github/repos/<owner>/<name>/pulls.json` and `runs.json` (none when not
 *   there), the newest first as gh lists them, at most `--limit`; a repository without a folder there
 *   fails as gh does for one it cannot find;
 * - `api --hostname github.com --method POST user/repos -f name=<name> -F private=true -f description=<text> --jq .full_name`,
 *   which publishing an app asks (`src/server/publish/git.ts`): a bare repository, `relay-test/<name>.git`, in
 *   the folder of stand-in repositories the server pushes to (`RELAY_PUBLISH_GIT_DIR`), its full name
 *   printed; GitHub's HTTP 422 when it has one of that name already;
 * - The active account and account-specific logout on github.com, with state in this test’s own folder.
 * - `--version`.
 * Anything else fails ("not faked"): the files that go along with a page take `gh api` and a git push
 * to GitHub, so a share with files fails before git is started.
 *
 * Its gists are folders in `fake-github/gists/<id>/`, next to E2E_FAKE_LOG (the test's own folder):
 * each with its files and `gist.json` (the description, whether it is public, the files' names).
 * E2E_FAKE_SIGNED_OUT (a list, as for the fake CLIs) with `gh` in it makes it signed out: every
 * command but `--version` and `auth login` fails as gh does without an account, until it is signed in.
 * `auth login --web --hostname github.com` signs it in as gh's device sign-in does without a terminal:
 * it prints its one-time code (ABCD-1234) and GitHub's device page, waits until the test approves it
 * (a file `fake-github/approve`; at most a minute), then keeps the sign-in (`fake-github/signed-in`)
 * and exits 0; or fails as gh does when the code is denied (`fake-github/deny`). Each start goes to E2E_FAKE_LOG with its arguments (`cli: 'gh'`), for the tests to read.
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
  if (!GISTS) fail('fake gh: E2E_FAKE_LOG is not set, so it has nowhere to keep gists');
  const github = path.dirname(GISTS);
  if (args[0] === 'auth' && args[1] === 'login') return login(github);
  const signedOut =
    (process.env.E2E_FAKE_SIGNED_OUT || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .includes('gh') && !fs.existsSync(path.join(github, 'signed-in'));
  if (signedOut || fs.existsSync(path.join(github, 'signed-out'))) {
    fail(
      'To get started with GitHub CLI, please run:  gh auth login\n' +
        'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
      4,
    );
  }
  if (args.join(' ') === 'api --hostname github.com user --jq .login') return process.stdout.write('relay-test');
  if (args.join(' ') === 'auth logout --hostname github.com --user relay-test') {
    fs.mkdirSync(github, { recursive: true });
    fs.writeFileSync(path.join(github, 'signed-out'), 'relay-test');
    fs.rmSync(path.join(github, 'signed-in'), { force: true });
    return;
  }
  if (args.slice(0, 6).join(' ') === 'api --hostname github.com --method POST user/repos') return createRepo();
  const [cmd, sub, ...rest] = args;
  if (cmd === 'gist' && sub === 'create') return create(rest);
  if (cmd === 'gist' && sub === 'delete') return remove(rest);
  if ((cmd === 'pr' || cmd === 'run') && sub === 'list') return list(github, cmd, rest);
  if (cmd === 'api' && rest.length === 1 && rest[0] === '--silent' && /^gists\/[^/?]+$/.test(sub || '')) {
    const id = sub.slice('gists/'.length);
    if (!validId(id) || !fs.existsSync(gistDir(id))) notFound(id);
    return;
  }
  fail(`fake gh: not faked: gh ${args.join(' ')}`);
}

/** A private repository for publishing an app: a bare one in RELAY_PUBLISH_GIT_DIR, as the server's git pushes to it. */
function createRepo() {
  const want = [
    'api',
    '--hostname',
    'github.com',
    '--method',
    'POST',
    'user/repos',
    '-f',
    args[7],
    '-F',
    'private=true',
    '-f',
    'description=Published from Harness Relay',
    '--jq',
    '.full_name',
  ];
  const name = /^name=([a-z0-9-]{1,40})$/.exec(args[7] || '')?.[1];
  const dir = process.env.RELAY_PUBLISH_GIT_DIR;
  if (!name || !dir || args.join(' ') !== want.join(' ')) fail(`fake gh: not faked: gh ${args.join(' ')}`);
  const repo = path.join(dir, 'relay-test', name + '.git');
  if (fs.existsSync(repo)) {
    process.stdout.write('{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}');
    fail('gh: Repository creation failed. (HTTP 422)');
  }
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  require('node:child_process').execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', repo]);
  process.stdout.write(`relay-test/${name}\n`);
}

/** `auth login --web --hostname github.com`, without a terminal: the code, the page, then the test's approval. */
async function login(github) {
  if (args.join(' ') !== 'auth login --web --hostname github.com') fail(`fake gh: not faked: gh ${args.join(' ')}`);
  // Where the test puts its approval, there before any gist is.
  fs.mkdirSync(github, { recursive: true });
  process.stdout.write(
    '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n',
  );
  const approve = path.join(github, 'approve');
  for (let waited = 0; !fs.existsSync(approve); waited += 100) {
    if (fs.existsSync(path.join(github, 'deny'))) fail('error: authorization was denied by the user');
    if (waited > 60_000) fail('error: timed out waiting for authorization');
    await new Promise((done) => setTimeout(done, 100));
  }
  fs.rmSync(path.join(github, 'signed-out'), { force: true });
  fs.writeFileSync(path.join(github, 'signed-in'), 'relay-e2e\n');
  process.stderr.write('✓ Authentication complete.\n✓ Logged in as relay-e2e\n');
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

/** `pr list` or `run list` of a repository the test set up: what its file says, as gh prints it with `--json`. */
function list(github, cmd, rest) {
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const repo = (flag('--repo') || '').replace(/^github\.com\//, '');
  const limit = Number(flag('--limit') || 30);
  if (!flag('--json')) fail(`fake gh: not faked: gh ${cmd} list without --json`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !fs.existsSync(path.join(github, 'repos', ...repo.split('/')))) {
    fail(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);
  }
  const file = path.join(github, 'repos', ...repo.split('/'), cmd === 'pr' ? 'pulls.json' : 'runs.json');
  let items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const branch = flag('--branch');
  if (cmd === 'run' && branch) items = items.filter((r) => r.headBranch === branch);
  process.stdout.write(`${JSON.stringify(items.slice(0, limit))}\n`);
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
