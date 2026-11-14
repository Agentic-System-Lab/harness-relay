'use strict';
/*
 * Stand-ins for the coding-agent CLIs Harness Relay drives, for the end-to-end tests. Which one a
 * process is comes from the name it runs under (`claude`, `cursor-agent.exe`, …): each CLI's module
 * in `agents/` names its file (`bin`), and `e2e/support/fake-cli.ts` installs this script under each
 * of them (a script on macOS and Linux, a Node single executable on Windows). Everything a test sees
 * names the CLI by its provider id (`cursor` for `cursor-agent`, `antigravity` for `agy`): the log's
 * `cli`, `@<cli>` in directives, `e2e:team=`, E2E_FAKE_SIGNED_OUT and its errors (`fake cursor: …`).
 *
 * The script is made of modules (`fake-cli.cjs`, `lib/*.cjs`, `agents/*.cjs`, Node's built-in modules
 * only), which `fake-cli.ts` bundles into one file when it installs them: a single executable's
 * `require` loads built-in modules only, and the script runs from a folder of its own.
 * - `lib/self.cjs`: which CLI this is, its arguments; `lib/log.cjs`: the log (below);
 * - `lib/rpc.cjs`: line-delimited JSON and JSON-RPC on stdio; `lib/acp.cjs`: an ACP agent's end of it;
 * - `lib/plan.cjs`: what it says (the lead agent's answers, a turn's steps); `lib/home.cjs`: what it
 *   keeps in its home (sign-in, sessions); `lib/files.cjs`: files and folders;
 * - `agents/<provider>.cjs`: one CLI each, exporting `provider`, `bin` (and `aliases`: other names it
 *   answers to, and `aliasRe`, a pattern of them: Muse Code's versioned binary), `label`
 *   (PROVIDER_LABEL), `name` (the member name the fake lead agent gives it), `version` (what
 *   `--version` prints) and `versionRe` (what the build checks that against), `home(env, args)`
 *   (its home for this start: where its sign-in, sessions and marks go; for an open agent a folder
 *   its runs may write in Harness Relay's sandbox), `apiKey(env)` (whether it got the
 *   key a test expects, E2E_EXPECTED_API_KEY: 'expected', 'other' or null, never the key) and
 *   `main(args)` (the start: every static command the server runs, exiting non-zero at once on
 *   anything else, and its turns in its own protocol). A CLI whose fake is not written yet says so and
 *   exits with code 2, whatever it is asked.
 *
 * Each speaks its CLI's own protocol as Harness Relay drives it, with no model behind it (see each
 * module). What it answers depends on the prompt, as a model's would:
 * - the lead agent's prompts: the team for a question (`e2e:team=…`, `e2e:mode=…`, `e2e:rounds=…`,
 *   `e2e:name=…`, `e2e:template=…`, `e2e:badplan`, `e2e:leadreview`; one Claude member by default), the group of a new
 *   conversation (the first group named in its first message), a changed team (`e2e:add=<cli>`), and
 *   a review of the team's replies (`e2e:reviewkind=…`, `e2e:reviewquote=list`, `e2e:badreview`, `e2e:slowreview`);
 * - a turn: a short reply that names the agent and repeats the user's latest message, streamed in
 *   pieces, changed by the directives in that message (DIRECTIVES in `lib/plan.cjs`). A directive
 *   written as `e2e:<name>@<cli>` is for that CLI only, `e2e:write=notes.md@codex` say.
 *
 * Like a model that ignores its briefing, it always tries what a directive asks; whether that
 * happens is decided only by what Harness Relay gave the CLI, as with the real ones (each module
 * says what that is for its CLI). So a test that writes in another folder, or in a read-only chat,
 * tells whether the adapter set the CLI up right.
 *
 * Sessions are kept in the CLI's home (the test's own), and resuming one it never started fails, as
 * the real CLIs do. E2E_FAKE_SIGNED_OUT (a list of provider ids: `codex,grok`) makes those CLIs signed
 * out. Each home (an account's) also keeps its sign-in: signed in until signed out there.
 *
 * E2E_FAKE_LOG names a file that gets a JSON line for each start (its arguments, its home, and
 * whether it got the API key a test expects), each session started or resumed and each prompt (with
 * the images and MCP servers the turn got, its model and effort, and the skills the CLI loaded by
 * itself), and the values (environment or headers) the tool library's MCP servers were given, with
 * the URL of each HTTP one, for the tests to read. Where the file may not be written (inside Harness
 * Relay's own sandbox), a line goes to the test's fake endpoint instead (E2E_FAKE_LOG_URL), which
 * adds it to the same file (`lib/log.cjs`).
 */
const { record } = require('./lib/log.cjs');
const self = require('./lib/self.cjs');

/** Each CLI's module, in Harness Relay's order (PROVIDERS). */
const AGENTS = [
  require('./agents/claude.cjs'),
  require('./agents/codex.cjs'),
  require('./agents/grok.cjs'),
  require('./agents/cursor.cjs'),
  require('./agents/antigravity.cjs'),
  require('./agents/copilot.cjs'),
  require('./agents/muse.cjs'),
  require('./agents/opencode.cjs'),
  require('./agents/goose.cjs'),
  require('./agents/cline.cjs'),
  require('./agents/openhands.cjs'),
  require('./agents/pi.cjs'),
];

const name = self.runName();
const agent = AGENTS.find((a) => a.bin === name || (a.aliases || []).includes(name) || (a.aliasRe && a.aliasRe.test(name)));
if (!agent) {
  process.stderr.write(`fake-cli: run me as ${AGENTS.map((a) => a.bin).join(', ')} (not ${name})\n`, () => process.exit(2));
} else {
  self.use(agent, AGENTS);
  record({ args: self.args, home: self.home(), apiKey: agent.apiKey(process.env) });
  agent.main(self.args);
}
