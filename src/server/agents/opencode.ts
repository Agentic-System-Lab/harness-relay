import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  API_BACKENDS,
  PROVIDER_LABEL,
  isApiBackend,
  parseBackendModel,
  type ModelOption,
  type NativeAgent,
  type NativeMemoryFile,
  type NativeSkill,
  type PlanEntry,
} from '../../shared/types';
import { API_BACKEND_ENV, backendLabel, type BackendRun } from '../backends';
import { commandLine } from '../commands';
import { openRunDatabase } from '../db';
import { t } from '../i18n';
import type { NativeProbe, NativeProblem } from '../native';
import { runProcess } from '../process';
import { freeLoopbackPort } from '../relaySandbox';
import { RpcError, type JsonRpcConnection } from './acp';
import { acpRunner, acpUsage, type AcpAgentSpec, type AcpCallInfo, type AcpSessionState, type AcpToolCall, type AcpTurnDeps } from './acpTurn';
import { openAgentHome, startStateOver, type OpenAgentDefinition, type OpenCatalog, type OpenHomeLayout, type OpenRunContext, type OpenSandboxNeeds } from './open';
import { AgentRunError, type AgentRunner, type RunOptions, type RunResult } from './types';

/*
 * OpenCode: `opencode` (npm `opencode-ai`, a Bun binary) over ACP, `opencode acp` (checked with 1.19.5).
 * See docs/open-agents.md, "OpenCode", for what the user sees; the notes below are for this file.
 *
 * - Home: the four XDG folders under the agent home, `OPENCODE_TEST_HOME` for what it reads from the
 *   user's home (`~/.opencode/`, `~/.claude/CLAUDE.md`, `~/.claude/skills`, `~/.agents/skills`; the
 *   variable's name says test, but it is the only one that moves these without changing HOME for the
 *   commands it runs), `OPENCODE_CONFIG_DIR` pinned to its own config folder (an inherited one would add
 *   the user's), `OPENCODE_AUTH_CONTENT={}` (its `auth.json` could name a URL to fetch config from),
 *   `OPENCODE_PURE` (no external plugins). The config folder holds only what `ensureOpencodeHome` writes,
 *   owner read-only: OpenCode then neither installs `@opencode-ai/plugin` from npm into it (62 MB, and
 *   ~/.npm), nor writes `$schema` into it; its `.gitignore` is there already, since OpenCode crashes when
 *   it cannot write one inside the relay sandbox.
 * - Everything of one run is in `OPENCODE_CONFIG_CONTENT` (parallel runs of one home differ): the model
 *   and only its own provider (`enabled_providers`, so the free "opencode" provider and its default model
 *   never come in), an endpoint as an `@ai-sdk/openai-compatible` provider whose key comes from a variable
 *   (`env`, never a file), the permission rules, the briefing file, the title model turned off.
 * - The project's own OpenCode config (`opencode.json`, `.opencode/`) is never loaded
 *   (`OPENCODE_DISABLE_PROJECT_CONFIG`): merged before Harness Relay's, it keeps its key order, and the
 *   last rule that matches wins, so a repository could turn an "ask" into "allow" (its own
 *   `agent.build.permission` even comes after ours). That flag also drops the project's AGENTS.md, which
 *   is passed back as an instruction file (`opencodeProjectInstructions`, OpenCode's own lookup).
 * - Its data and state folders (its sessions database, logs, tool output, locks) are the conversation
 *   member's own (`ctx.home.state`), never another conversation's or member's.
 * - Each run's cache (`XDG_CACHE_HOME`: ripgrep and LSP binaries it downloads, npm plugins) is in the
 *   run's temp folder; only the model catalog (`models.json`, data) is read from the home's, which the
 *   catalog query refreshes outside any run (read-only to runs). Bun's transpiler cache is off. Snapshots are off (a git
 *   folder in its state another run's commands would use).
 * - `opencode acp` serves its own HTTP API on 127.0.0.1 (port 4096 first) for the whole turn, without a
 *   password unless one is set: each run gets a port and a random `OPENCODE_SERVER_PASSWORD`. Its
 *   commands run through `relay-shell` (read-only), which drops the password, but a command can still
 *   read it from OpenCode's process; so below full access its server is watched (`watchOpencode`).
 * - Approvals: it sends `session/request_permission` for every rule that says "ask"; it ignores any
 *   reason in a rejection and, by default, ends the turn on one (`continue_loop_on_deny` keeps it going,
 *   and the briefing says what a rejection means). After an allowed edit it sends `fs/write_text_file`
 *   although `initialize` said the client cannot write: answered `null`, never done.
 * - Its to-do list only comes as the `todowrite` tool's input (`planOf`); tool calls say what they do
 *   only on their `in_progress` update (`filterUpdate` keeps it for the row); its cost is the session's
 *   total so far (`usage` keeps each session's last total to report the turn's part).
 */

const CLI = PROVIDER_LABEL.opencode;

// --- What the relay sandbox must give OpenCode --------------------------------------------------

/**
 * Hosts OpenCode itself may try at start, refused without asking: its model catalog (turned off in
 * runs with OPENCODE_DISABLE_MODELS_FETCH, so normally never asked for). npm (a plugin install) is not
 * tried, since its config folder is read-only; GitHub (a ripgrep download when `rg` is not on PATH)
 * is left to ask, since the agent's own commands may need it.
 */
export const OPENCODE_QUIET_HOSTS = ['models.opencode.ai'];

/**
 * What OpenCode needs from the relay sandbox besides what `home()` declares (its `statePaths`
 * writable, its `configPaths` read-only, the run's temp folder, the backend's host), checked on macOS:
 * - `localPorts`: the port its own HTTP server listens on (`--port`, chosen per run in `prepare`):
 *   `opencode acp` serves its API on 127.0.0.1 and its ACP side talks to it. Without it, it exits
 *   with `ServeError` before answering `initialize`. Only that port is opened: its commands reach no
 *   other local port, and Harness Relay's never. Its server wants the run's password.
 * - `quietlyDeniedHosts`: `OPENCODE_QUIET_HOSTS`.
 * - The proxy: Bun reads `HTTP_PROXY` / `HTTPS_PROXY` itself (`proxyEnv` is empty).
 * - No PTY, no Unix sockets, no macOS trustd (Bun's TLS goes through the proxy).
 * - Harmless inside the sandbox: "Error starting FSEvents stream" (its file watcher) on stderr.
 */
export function opencodeSandbox(ctx: Pick<OpenRunContext, 'state'>): OpenSandboxNeeds {
  const port = (ctx.state as OpencodeState).port;
  return { ...(port ? { localPorts: [port] } : {}), quietlyDeniedHosts: [...OPENCODE_QUIET_HOSTS] };
}

// --- Its home -----------------------------------------------------------------------------------

/**
 * Where OpenCode keeps what: under its home folder `root` what all runs share (Harness Relay writes it,
 * runs only read it), under `state` (the run's state folder, one per conversation member) what a run
 * writes. Without `state`, the home's own (Harness Relay's starts of OpenCode outside a run).
 */
export function opencodePaths(root: string, state = root) {
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  return {
    /** XDG_CONFIG_HOME: only `opencode/` in it, written by `ensureOpencodeHome`. */
    config,
    configDir: join(config, 'opencode'),
    /** XDG_DATA_HOME: its sessions database, logs, tool output (state, the member's own). */
    data: join(state, 'data'),
    db: join(state, 'data', 'opencode', 'opencode.db'),
    /** XDG_STATE_HOME: its locks (state, the member's own). */
    state: join(state, 'state'),
    /** XDG_CACHE_HOME outside runs (the catalog query): its `models.json`, which runs read. */
    cache,
    models: join(cache, 'opencode', 'models.json'),
    /** OPENCODE_TEST_HOME: an empty folder in place of the user's home for its own lookups. */
    home: join(root, 'home'),
    /** What Harness Relay keeps about each session (its cost so far): never the agent's to write. */
    relay: join(root, 'relay'),
  };
}

/**
 * The config file in its own config folder: what does not change between runs. `lsp` and `formatter`
 * are off at every permission (not only below full access): OpenCode starts project programs by itself
 * for them (a read warms the LSP, which runs `<project>/node_modules/.bin/biome lsp-proxy`, the
 * project's `tsserver.js`…; an edit runs formatters), each with the whole environment, so a single file
 * read in a repository that ships such a binary would run it with no approval and with the server
 * password and the backend key in its environment. Harness Relay surfaces neither diagnostics nor
 * formatting, so turning them off loses nothing; full access keeps them off too, so no run ever starts
 * a project program on its own (the agent still runs one when it chooses to, which asks or is the user's
 * yolo mode). `snapshot` is off as well (its git calls in the agent's state another run would use).
 */
export const OPENCODE_STATIC_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  lsp: false,
  formatter: false,
};

/** The `.gitignore` OpenCode writes into a config folder when there is none (and crashes when it cannot). */
export const OPENCODE_GITIGNORE = ['node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore'].join('\n');

/** The shell wrapper's name in its config folder (`shell` in the run's config). */
export const OPENCODE_SHELL = 'relay-shell';

/** The variable `relay-shell` reads the user's real shell from (set per run; never baked into the script). */
export const OPENCODE_SHELL_ENV = 'HARNESS_RELAY_USER_SHELL';

/** The variable that arms `relay-shell`'s refusal screen (set only below full access, where commands are sandboxed). */
export const OPENCODE_SHELL_SCREEN_ENV = 'HARNESS_RELAY_SCREEN';

/** The variables `relay-shell` takes out of the environment of the commands OpenCode runs. */
export const OPENCODE_SHELL_UNSET = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', OPENCODE_SHELL_ENV, OPENCODE_SHELL_SCREEN_ENV];

/** The shell OpenCode would use: the user's `SHELL` when it is a program, else the platform's. */
export function opencodeUserShell(shell: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (shell && shell.startsWith('/') && !/['\n]/.test(shell) && isFile(shell)) return shell;
  return platform === 'darwin' ? '/bin/zsh' : isFile('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** The exit code `relay-shell` ends a refused command with. */
export const OPENCODE_SHELL_REFUSED = 97;

/** The message `relay-shell` prints (to the model) when it refuses a command. */
export const OPENCODE_SHELL_REFUSAL =
  "Harness Relay refused this command: it hides a command substitution in a form the agent's permission check cannot see " +
  '(an `eval`, or a `$(...)`/backquote quoted or escaped inside a subscript or arithmetic that the shell then re-evaluates, ' +
  'e.g. x=\'a[$(cmd)]\'; a[x]=1). Run the command plainly, so it can be approved, or ask the user.';

/**
 * `relay-shell`: the fixed-text shell OpenCode runs its commands through (`shell` in its config). It is
 * the same for every run and holds no per-run value (the user's real shell comes from the environment,
 * `OPENCODE_SHELL_ENV`), so a command cannot change it for the next one (its config folder is read-only).
 * Before running a `-c` command it always drops OpenCode's server password (and username, and its own
 * variables), so a command cannot read the password to drive OpenCode's own server.
 *
 * Below full access only (the screen is armed by `OPENCODE_SHELL_SCREEN_ENV`, since in full access every
 * command runs without asking anyway), it also refuses the narrow set of forms OpenCode's tree-sitter
 * parse sees as no command — so it never asks about them — yet the shell still runs a command in:
 * - an `eval` as a command word (not `npm run eval`, `python eval.py`, `grep "eval("`);
 * - a line that both evaluates through a subscript or arithmetic (`a[x]=…`, `(( … ))`, `$[ … ]`, a numeric
 *   `[[ … -eq … ]]`, `${name[…]}`, `${!…}`, `${(e)…}`, `declare -i`, `let`) and holds a `$`/backquote that
 *   is quoted or escaped (so not a plain substitution OpenCode would see) — the single-quoted-subscript trap
 *   (`x='a[$(cmd)]'; a[x]=1`) and its escaped and assembled variants;
 * - such a line with `$(( … ))` arithmetic, when it also holds a bracket with a `$`/backquote in it (bash
 *   evaluates a name there again: `x='a[$(cmd)]'; y=$((x+1))`), so plain arithmetic beside a quoted `$`
 *   (`awk '{print $1}'`) still runs.
 * The evaluating forms are looked for outside single quotes, when the line's single-quoted text can be
 * told apart for sure (no double quote, backslash, `#`, here-document or `${`, an even number of single
 * quotes, and no declaration command or `let`, whose quoted argument is itself evaluated: `declare 'a[$(…)]=1'`);
 * otherwise in the whole line. So `awk -F= '/^[A-Z_]+=/ {print $2}' f` runs.
 * It matches its keywords as command words, and calls grep by absolute path
 * (so a missing grep fails closed: the command is refused, never let through). The refusal is a clear
 * message the model sees (`OPENCODE_SHELL_REFUSAL`). A determined evasion that assembles `$(` entirely out
 * of pieces a declaration's name then re-parses can still slip one substitution past the screen; it is
 * bounded by the relay sandbox (in read-only it cannot write, and reads are open anyway), and in edit mode
 * commands run without asking regardless. Everything else runs as the user's shell would.
 */
/** `s` as a POSIX-shell single-quoted literal, so the shell neither expands nor splits it. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function opencodeShellScript(): string {
  // All greps are by absolute path and fail closed. Patterns, as single-quoted literals so this script's own text runs nothing:
  const evalWord = shSingleQuote('(^|[;&|(){}]|&&|\\|\\|)[[:space:]]*eval([[:space:]]|;|$)');
  // A `$` or backquote that is NOT a live substitution: inside single quotes, backslash-escaped, or a lone `$` (as in `$''`/`${d}(`).
  const quotedDollar = shSingleQuote("'[^']*[$\\`]|\\\\[$\\`]|[$]'");
  // Evaluating through a subscript or arithmetic (not `$((` expansion): the shell re-parses a variable here.
  const evalCtx = shSingleQuote(
    '\\[[^]]*\\][+]?=|' + // [ … ]=  a subscript assignment: name[i]=, or [i]=v inside an array literal
      '(^|[^$])\\(\\(|' + // (( … ))  arithmetic command, but not $(( … ))
      '[$]\\[|' + // $[ … ]  old arithmetic
      '[$][{][!(]|' + // ${! … }  indirect, or ${( … )}  zsh flags
      '[$][{][A-Za-z_][A-Za-z0-9_]*\\[|' + // ${name[ … ]}  subscript expansion
      '\\[\\[[^]]*-(eq|ne|lt|gt|le|ge)|' + // [[ … -eq … ]]  numeric test
      '(declare|typeset)[[:space:]]+-[A-Za-z]*i|' + // declare -i  integer (arithmetic) declaration
      '(^|[;&|(){}]|&&|\\|\\||[[:space:]])let([[:space:]]|$)', // let  arithmetic on each argument
  );
  // `$(( … ))` arithmetic, which evaluates a name in it again (bash), and a bracket with a `$`/backquote in
  // it anywhere on the line (a subscript holding a substitution, the payload of the trap).
  const arithExp = shSingleQuote('[$][(][(]');
  const bracketDollar = shSingleQuote('\\[[^]]*[$`]');
  // A declaration command word whose quoted argument puts a `$` in the name part (before `=`): `declare "a$y=1"`.
  const declInject = shSingleQuote('(^|[;&|(){}]|&&|\\|\\||[[:space:]])(declare|typeset|export|local|readonly)[[:space:]]+"[^"=]*[$][^"=]*=');
  // A declaration command word, or `let`, at all: its quoted argument is evaluated, subscript included.
  const declWord = shSingleQuote('(^|[;&|(){}]|&&|\\|\\||[[:space:]])(declare|typeset|export|local|readonly|let)([[:space:]]|$)');
  return `#!/bin/sh
# Written by Harness Relay: OpenCode's shell for the commands it runs. Fixed text; values come from the environment.
__shell=\${${OPENCODE_SHELL_ENV}:-/bin/sh}
__grep=/usr/bin/grep
if [ "$1" = "-c" ] && [ -n "\${${OPENCODE_SHELL_SCREEN_ENV}:-}" ]; then
  __cmd=$2
  if [ ! -x "$__grep" ]; then __refuse=1; fi
  if [ -z "$__refuse" ] && printf '%s' "$__cmd" | "$__grep" -Eq ${evalWord}; then __refuse=1; fi
  if [ -z "$__refuse" ] && printf '%s' "$__cmd" | "$__grep" -Eq ${quotedDollar}; then
    # Where to look for the evaluating forms: outside single quotes when that text can be told apart for sure.
    __live=$__cmd
    case $__cmd in
      *\\"*|*\\\\*|*\\#*|*'<<'*|*'\${'*) ;;
      *)
        if ! printf '%s' "$__cmd" | "$__grep" -Eq ${declWord}; then
          __live= __rest=$__cmd
          while :; do
            case $__rest in
              *\\'*)
                __live=$__live\${__rest%%\\'*}
                __rest=\${__rest#*\\'}
                case $__rest in
                  *\\'*) __rest=\${__rest#*\\'} ;;
                  *) __live=$__cmd; break ;;
                esac ;;
              *) __live=$__live$__rest; break ;;
            esac
          done
        fi ;;
    esac
    if printf '%s' "$__live" | "$__grep" -Eq ${evalCtx}; then __refuse=1; fi
    if printf '%s' "$__live" | "$__grep" -Eq ${arithExp} && printf '%s' "$__cmd" | "$__grep" -Eq ${bracketDollar}; then __refuse=1; fi
    if printf '%s' "$__cmd" | "$__grep" -Eq ${declInject}; then __refuse=1; fi
  fi
  if [ -n "$__refuse" ]; then
    printf '%s\\n' ${shSingleQuote(OPENCODE_SHELL_REFUSAL)} >&2
    exit ${OPENCODE_SHELL_REFUSED}
  fi
fi
unset ${OPENCODE_SHELL_UNSET.join(' ')}
exec "$__shell" "$@"
`;
}

/** What its config folder holds: each file's content and mode. */
function configFiles(): Record<string, { text: string; mode: number }> {
  return {
    'opencode.json': { text: `${JSON.stringify(OPENCODE_STATIC_CONFIG, null, 2)}\n`, mode: 0o444 },
    '.gitignore': { text: OPENCODE_GITIGNORE, mode: 0o444 },
    [OPENCODE_SHELL]: { text: opencodeShellScript(), mode: 0o555 },
  };
}

/** Makes `path` and everything in it writable by its owner again, so it can be removed. */
function unlock(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) unlock(join(path, name));
  }
}

/** Removes everything in `dir` (made writable first), keeping the folder. */
function emptyDir(dir: string): void {
  unlock(dir);
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
}

/** Whether a folder holds exactly `files` (no other entries, each a plain file with that content and mode). */
function holdsExactly(dir: string, files: Record<string, { text: string; mode: number }>): boolean {
  try {
    const names = readdirSync(dir);
    if (names.length !== Object.keys(files).length) return false;
    return names.every((n) => {
      const p = join(dir, n);
      const st = lstatSync(p);
      return n in files && st.isFile() && (st.mode & 0o777) === files[n]!.mode && readFileSync(p, 'utf8') === files[n]!.text;
    });
  } catch {
    return false;
  }
}

/**
 * Makes OpenCode's home as Harness Relay wants it before any start: its XDG config folder holds only
 * `opencode/`, which holds only the static config and the `.gitignore`, owner read-only (0555), and the
 * folder that stands for the user's home is empty and read-only. Anything else found there (a plugin,
 * a tool, skills, agents, another app's config a full-access run left) is removed. Rewritten only when
 * it differs, so starts that run side by side find it as it should be.
 */
export function ensureOpencodeHome(root: string): void {
  const p = opencodePaths(root);
  const files = configFiles();
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(p.config)) {
    if (name === 'opencode') continue;
    unlock(join(p.config, name));
    rmSync(join(p.config, name), { recursive: true, force: true });
  }
  const st = existsSync(p.configDir) ? lstatSync(p.configDir) : undefined;
  if (!st?.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o555 || !holdsExactly(p.configDir, files)) {
    if (st) {
      unlock(p.configDir);
      rmSync(p.configDir, { recursive: true, force: true });
    }
    mkdirSync(p.configDir, { mode: 0o700 });
    for (const [name, f] of Object.entries(files)) {
      writeFileSync(join(p.configDir, name), f.text, { mode: f.mode });
      chmodSync(join(p.configDir, name), f.mode);
    }
    chmodSync(p.configDir, 0o555);
  }
  mkdirSync(p.home, { recursive: true, mode: 0o555 });
  if (readdirSync(p.home).length) emptyDir(p.home);
  chmodSync(p.home, 0o555);
}

/** OpenCode's tables of console accounts: an active one makes it fetch config from the account's server at start. */
export const OPENCODE_ACCOUNT_TABLES = ['account_state', 'control_account', 'account'];

/** OpenCode's table of saved permissions (the "always" answers, per project), which it applies without asking. */
export const OPENCODE_SAVED_PERMISSIONS_TABLE = 'permission';

/**
 * Takes out of OpenCode's database in its home what would widen a later run. The database is its
 * state, which a run's commands may write (the relay sandbox lets OpenCode write it, so they can too):
 * - the console accounts: one planted there would have the next run (a full-access one, say) fetch and
 *   merge config from the account's server;
 * - each session's permission rules (`session.permission`), which OpenCode puts over the agent's own for
 *   every tool call of that session: rules a command wrote there (`[{"permission":"*","pattern":"*",
 *   "action":"allow"}]`) would have the next turn of the resumed session edit, run commands and push
 *   without asking. Harness Relay never sets any; one set while a run goes on is seen by its watch;
 * - the saved permissions, for the same reason (Harness Relay never answers "always").
 * A trigger or view a command planted to put them back is dropped first (`openRunDatabase`), and what
 * was taken out is read back. Throws when that fails (`prepareOpencode` then starts the state over).
 */
export function scrubOpencodeDatabase(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = openRunDatabase(dbPath);
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const emptied = [...OPENCODE_ACCOUNT_TABLES, OPENCODE_SAVED_PERMISSIONS_TABLE].filter((table) => tables.has(table));
    for (const table of emptied) db.exec(`DELETE FROM "${table}"`);
    // `table_xinfo`, not `table_info`: a generated column (one a command defined) is listed too.
    const sessionColumns = tables.has('session') ? (db.prepare('PRAGMA table_xinfo("session")').all() as { name: string }[]).map((c) => c.name) : [];
    const rules = sessionColumns.includes('permission');
    if (rules) db.exec('UPDATE "session" SET "permission" = NULL WHERE "permission" IS NOT NULL');
    const left = [
      ...emptied.map((table) => `SELECT count(*) AS n FROM "${table}"`),
      ...(rules ? ['SELECT count(*) AS n FROM "session" WHERE "permission" IS NOT NULL'] : []),
    ].some((query) => (db.prepare(query).get() as { n: number }).n > 0);
    if (left) throw new Error('rows it removed are still there');
  } finally {
    db.close();
  }
}

/** The home's variables: also for the catalog and native queries (`openHomeEnv`). */
function homeEnv(root: string, state?: string): Record<string, string> {
  const p = opencodePaths(root, state);
  return {
    XDG_CONFIG_HOME: p.config,
    XDG_DATA_HOME: p.data,
    XDG_STATE_HOME: p.state,
    XDG_CACHE_HOME: p.cache,
    OPENCODE_TEST_HOME: p.home,
    OPENCODE_CONFIG_DIR: p.configDir,
    OPENCODE_MODELS_PATH: p.models,
    OPENCODE_AUTH_CONTENT: '{}',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_PURE: '1',
    // Inherited experiments would turn on web search through mcp.exa.ai and parallel.ai, and the like.
    OPENCODE_EXPERIMENTAL: 'false',
    OPENCODE_ENABLE_EXA: 'false',
    OPENCODE_EXPERIMENTAL_EXA: 'false',
    OPENCODE_ENABLE_PARALLEL: 'false',
    OPENCODE_EXPERIMENTAL_PARALLEL: 'false',
  };
}

export function opencodeHome(root: string, state?: string): OpenHomeLayout {
  const p = opencodePaths(root, state);
  return {
    env: homeEnv(root, state),
    statePaths: [p.data, p.state],
    // The catalog in the cache changes what the runs can pick; the user's-home stand-in must stay empty.
    configPaths: [p.config, p.home, p.cache, p.relay],
  };
}

// --- The run's config ---------------------------------------------------------------------------

/** The variable an endpoint's key is put in for OpenCode's provider config (`env`). */
export const OPENCODE_ENDPOINT_KEY_ENV = 'HARNESS_RELAY_ENDPOINT_KEY';

/**
 * OpenCode's provider id for the run's backend: the API backends' own, and `relay-<id>` for an endpoint,
 * so that one named like a provider OpenCode knows (lmstudio, ollama, groq…) never merges with it.
 */
export function opencodeProviderId(run: Pick<BackendRun, 'kind' | 'backend'>): string {
  return run.kind === 'endpoint' ? `relay-${run.backend}` : run.backend;
}

/** OpenCode's model id for the run (`<provider>/<model>`). */
export function opencodeModelId(run: Pick<BackendRun, 'kind' | 'backend' | 'model'>): string {
  return `${opencodeProviderId(run)}/${run.model}`;
}

/** The skill rule: none at all when skills are left out, else the single skills left out denied. */
function skillRule(o: Pick<RunOptions, 'nativeOff' | 'nativeItems'>): string | Record<string, string> {
  if (o.nativeOff?.includes('skills')) return 'deny';
  const off = o.nativeItems?.skills ?? [];
  return off.length ? { '*': 'allow', ...Object.fromEntries(off.map((name) => [name, 'deny'])) } : 'allow';
}

/**
 * OpenCode's permission rules for the conversation's permission. Its own default allows nearly
 * everything; the last rule that matches wins, so `"*"` comes first.
 * - full access: everything allowed (so nothing asks, a subagent's requests included);
 * - read-only: reading, searching, the web and its to-do list run; every edit, command, MCP tool and
 *   folder outside the project asks (and Harness Relay decides: `acpPermissionDecision`);
 * - edit: edits run too; every command asks, and Harness Relay lets all but pushing and publishing run.
 * Below full access its subagents (`task`) are off: their permission requests never reach the ACP
 * client (OpenCode only asks for the sessions ACP opened), so a subagent that had to ask would hang.
 */
export function opencodePermission(o: Pick<RunOptions, 'permission' | 'nativeOff' | 'nativeItems'>): Record<string, unknown> {
  const skill = skillRule(o);
  if (o.permission === 'full') return { '*': 'allow', skill };
  return {
    '*': 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    todowrite: 'allow',
    skill,
    task: 'deny',
    ...(o.permission === 'edit' ? { edit: 'allow' } : {}),
  };
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The project's instruction files as OpenCode finds them when it reads the project's config: the first
 * of AGENTS.md, CLAUDE.md, CONTEXT.md that exists somewhere from the working directory up to the
 * repository root (the filesystem root outside one), each copy of it on the way.
 */
export function opencodeProjectInstructions(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const name of INSTRUCTION_FILES) {
    const found = dirs.map((d) => join(d, name)).filter(isFile);
    if (found.length) return found;
  }
  return [];
}

/** A base URL as OpenCode's config takes it: `${…}` in it would be filled in from its environment (a key). */
export function opencodeBaseUrl(url: string): string {
  return url.replace(/\$\{/g, '%24%7B');
}

/** The run's config (`OPENCODE_CONFIG_CONTENT`): everything that differs between runs of one home. */
export function opencodeRunConfig(
  o: Pick<RunOptions, 'permission' | 'nativeOff' | 'nativeItems'>,
  run: Pick<BackendRun, 'kind' | 'backend' | 'model' | 'endpoint'>,
  instructions: string[],
): Record<string, unknown> {
  const provider = opencodeProviderId(run);
  const model = opencodeModelId(run);
  const agentsOff = o.nativeOff?.includes('agents') ? ['general', 'explore'] : (o.nativeItems?.agents ?? []);
  const endpoint = run.kind === 'endpoint' ? run.endpoint : undefined;
  const models = endpoint ? [...new Set([...endpoint.models, run.model])] : [];
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: model,
    enabled_providers: [provider],
    ...(endpoint
      ? {
          provider: {
            [provider]: {
              npm: '@ai-sdk/openai-compatible',
              name: endpoint.name || endpoint.id,
              // Its key comes from this variable (set only when the endpoint has one), never from a file.
              env: [OPENCODE_ENDPOINT_KEY_ENV],
              options: { baseURL: opencodeBaseUrl(endpoint.baseUrl) },
              models: Object.fromEntries(models.map((m) => [m, { name: m, tool_call: true }])),
            },
          },
        }
      : {}),
    permission: opencodePermission(o),
    ...(instructions.length ? { instructions } : {}),
    experimental: { continue_loop_on_deny: true },
    agent: {
      // Each new session's title would cost a call to the model of its own.
      title: { disable: true },
      ...Object.fromEntries(agentsOff.map((name) => [name, { disable: true }])),
    },
  };
}

/**
 * The config text: `{env:…}` and `{file:…}` in it would be filled in by OpenCode before it reads the
 * JSON (a path, an endpoint's name or model typed so would read a file or a key into the config), so
 * their brace is written as a JSON escape, which OpenCode reads back as the plain character.
 */
export function opencodeConfigText(config: Record<string, unknown>): string {
  return JSON.stringify(config).replace(/\{(?=(?:env|file):)/g, '\\u007b');
}

/** Variables the server may have inherited that would point OpenCode elsewhere: set empty for every run. */
export const OPENCODE_EMPTY_ENV = [
  'OPENCODE_CONFIG',
  'OPENCODE_PERMISSION',
  'OPENCODE_DB',
  'OPENCODE_MODELS_URL',
  'OPENCODE_TUI_CONFIG',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  OPENCODE_ENDPOINT_KEY_ENV,
];

/** What `prepare` keeps for the later hooks of the same run. */
interface OpencodeState {
  /** The session's total cost before this turn (`usage` reports the difference). */
  costBefore?: number;
  sessionId?: string;
  /** Each tool call's input so far: its end says nothing of it. */
  inputs?: Map<string, Record<string, unknown>>;
  /** Its server's port (`--port`). */
  port?: number;
  /** The last to-do list each `todowrite` call showed. */
  plans?: Map<string, string>;
  /** The tool calls OpenCode asked Harness Relay about in this turn (`session/request_permission`). */
  asked?: Set<string>;
  /** Each tool call's kind, from its first update. */
  kinds?: Map<string, string>;
  /** Below full access: the watch on its server's events, and how a run is ended for something it saw. */
  watch?: OpencodeWatch;
  foreign?: (detail: string) => void;
}

const stateOf = (ctx: OpenRunContext) => ctx.state as OpencodeState;

/**
 * Why OpenCode cannot run in the relay sandbox here: on Linux the sandbox has a network of its own
 * (bubblewrap's), where OpenCode's server listens on a loopback Harness Relay cannot reach, so its
 * server cannot be watched (`watchOpencode`), and a run that cannot be watched does not run. Anything
 * inside the sandbox that could carry the server's events out (a relay, a helper) is the agent's
 * commands' to reach too, so it could not be trusted either. Checked on Linux arm64 (DGX Spark) with
 * OpenCode 1.19.5 and sandbox-runtime 0.0.82.
 */
export function opencodeSandboxUnsupported(platform: NodeJS.Platform): string | undefined {
  return platform === 'linux' ? t().opencodeNoLinuxSandbox : undefined;
}

/** Writes what the run needs before OpenCode starts: its home, the briefing, its config and variables. */
export async function prepareOpencode(ctx: OpenRunContext, port: () => Promise<number> = freeLoopbackPort): Promise<void> {
  const { o, run, env, tmpDir } = ctx;
  const root = ctx.home.root;
  const p = opencodePaths(root, ctx.home.state);
  ensureOpencodeHome(root);
  try {
    scrubOpencodeDatabase(p.db);
  } catch (err) {
    startStateOver(ctx, new AgentRunError(t().opencodeDatabaseNotChecked((err as Error).message)));
  }
  mkdirSync(p.relay, { recursive: true, mode: 0o700 });

  const instructions = o.nativeOff?.includes('instructions') ? [] : opencodeProjectInstructions(o.cwd);
  const briefing = opencodeBriefing(o);
  if (briefing) {
    const file = join(tmpDir, 'harness-relay-briefing.md');
    writeFileSync(file, `${briefing}\n`, { mode: 0o600 });
    instructions.push(file);
  }
  // relay-shell is a POSIX shell script, which Windows cannot run: there OpenCode keeps its own shell
  // (it runs only with full access there, where relay-shell's screen is off anyway).
  const windows = (ctx.platform ?? process.platform) === 'win32';
  env.OPENCODE_CONFIG_CONTENT = opencodeConfigText({ ...opencodeRunConfig(o, run, instructions), ...(windows ? {} : { shell: join(p.configDir, OPENCODE_SHELL) }) });
  if (run.endpoint?.apiKey) env[OPENCODE_ENDPOINT_KEY_ENV] = run.endpoint.apiKey;
  else delete env[OPENCODE_ENDPOINT_KEY_ENV];
  // Its server's password, for this run only (its ACP side uses the same variable).
  env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString('base64url');
  // relay-shell reads the user's real shell from here (never baked into the fixed-text script), and drops it before the command runs.
  env[OPENCODE_SHELL_ENV] = opencodeUserShell(o.env.SHELL);
  // Arm relay-shell's refusal screen only below full access; in full access every command runs without asking anyway.
  if (ctx.sandboxed) env[OPENCODE_SHELL_SCREEN_ENV] = '1';
  else delete env[OPENCODE_SHELL_SCREEN_ENV];
  env.OPENCODE_SERVER_USERNAME = 'opencode';
  // A port of its own, so that a refusal's reason can be handed to it there (`opencodeRefusalBridge`).
  stateOf(ctx).port = await port();
  // Caches that load code are the run's own; only the catalog is read from the home.
  env.XDG_CACHE_HOME = join(tmpDir, 'cache');
  env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = '0';
  env.BUN_INSTALL_CACHE_DIR = join(tmpDir, 'bun-install');
  // The commands it runs see its XDG folders: give the GitHub CLI back its own (its sign-in).
  if (!o.env.GH_CONFIG_DIR) {
    const gh = join(o.env.XDG_CONFIG_HOME || join(o.env.HOME || homedir(), '.config'), 'gh');
    if (existsSync(gh)) env.GH_CONFIG_DIR = gh;
  }
}

// --- The briefing -------------------------------------------------------------------------------

/**
 * Said in the briefing below full access: OpenCode passes no reason with a rejection, so the model
 * would only read "The user rejected permission to use this specific tool call."
 */
export const OPENCODE_REFUSAL_NOTE =
  'When a tool call of yours is rejected ("The user rejected permission to use this specific tool call", with Harness Relay\'s reason after it when it could be given), Harness Relay refused it: ' +
  "the conversation's permission does not cover it (read-only allows reading and searching files and the web, but no edits and no " +
  'commands; edit allows edits and commands but no pushing or publishing), or the user declined it. Do not retry it or work around ' +
  'it: continue without it, or say in your reply what you would do and why it is needed.';

/** The role briefing, with what a rejection means below full access (in case its reason does not get through). */
export function opencodeBriefing(o: Pick<RunOptions, 'systemPrompt' | 'permission'>): string {
  const brief = o.systemPrompt.trim();
  if (o.permission === 'full') return brief;
  return brief ? `${brief}\n\n${OPENCODE_REFUSAL_NOTE}` : OPENCODE_REFUSAL_NOTE;
}


// --- The turn's hooks ---------------------------------------------------------------------------

/** ACP's kind of one of OpenCode's tools (its own mapping, `acp/tool.ts`). */
export function opencodeToolKind(tool: string): string {
  switch (tool.toLowerCase()) {
    case 'bash':
    case 'shell':
      return 'execute';
    case 'webfetch':
      return 'fetch';
    case 'edit':
    case 'apply_patch':
    case 'patch':
    case 'write':
      return 'edit';
    case 'grep':
    case 'glob':
    case 'list':
      return 'search';
    case 'read':
      return 'read';
    case 'task':
      return 'think';
    default:
      return 'other';
  }
}

/**
 * What a call OpenCode asks about is, where its request alone does not say:
 * - a folder outside the project (`external_directory`, `rawInput {filepath, parentDir}`, or
 *   `{command, directories}` for a command): what the call does comes from its earlier `tool_call`
 *   (a read outside the project reads; one unknown is taken as reading, since an edit or a command asks
 *   on its own once the folder is allowed);
 * - the same call repeated (`doom_loop`, `rawInput {tool, input}`): the kind of that tool;
 * - an MCP tool (`<server>_<tool>`, no input given): its name.
 */
export function describeOpencodeCall(call: AcpToolCall, earlier: AcpToolCall | undefined): Partial<AcpCallInfo> {
  const input = call.rawInput ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  if (text(input.parentDir) || Array.isArray(input.directories)) {
    const command = commandLine(input.command);
    const kind = command ? 'execute' : earlier?.kind && earlier.kind !== 'other' ? earlier.kind : 'read';
    const where = text(input.parentDir) ?? (input.directories as unknown[]).filter((d) => typeof d === 'string').join(', ');
    return {
      kind,
      title: `${command ?? earlier?.title ?? 'tool'} (outside the project: ${where})`,
      ...(command ? { command } : {}),
      ...(text(input.filepath) ? { path: String(input.filepath) } : where ? { path: where } : {}),
    };
  }
  if (call.title === 'doom_loop' && text(input.tool)) {
    const tool = String(input.tool);
    const inner = input.input && typeof input.input === 'object' ? (input.input as Record<string, unknown>) : {};
    const kind = opencodeToolKind(tool);
    const command = kind === 'execute' ? text(inner.command) : undefined;
    const path = text(inner.filePath);
    return { kind, tool, title: `${tool} (the same call again)`, ...(command ? { command } : {}), ...(path ? { path } : {}) };
  }
  if (call.kind === 'other' && text(call.title)) return { tool: call.title };
  return {};
}

/** Its `todowrite` calls: the to-do list, shown as the plan instead of a row. */
export function hideOpencodeTool(update: Record<string, any>): boolean {
  return update.title === 'todowrite';
}

/** The plan in a `todowrite` call's input (`[{content, status, priority}]`); cancelled items are left out. */
export function opencodePlan(update: Record<string, any>): PlanEntry[] | undefined {
  const todos = update.rawInput?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos
    .filter((x) => x && typeof x.content === 'string' && x.status !== 'cancelled')
    .map((x): PlanEntry => ({ text: x.content, status: x.status === 'completed' || x.status === 'in_progress' ? x.status : 'pending' }));
}

const DONE = new Set(['completed', 'failed', 'cancelled']);

/** OpenCode's words for a write the sandbox refused. */
const REFUSED_WRITE = /^Unknown: FileSystem\.(?:writeFile\w*|makeDirectory|remove|rename|copy\w*|symlink|truncate)\s*\((.*)\)\s*$/;

/** A failed call's content, with a write the sandbox refused said in words. */
function sandboxRefusal(c: any): any {
  const text = c?.content?.type === 'text' ? c.content.text : undefined;
  const m = typeof text === 'string' ? REFUSED_WRITE.exec(text.trim()) : null;
  return m ? { ...c, content: { ...c.content, text: t().opencodeWriteRefused(m[1]!) } } : c;
}

/** The first file an `apply_patch` call's patch names (`*** Add File: <path>`…), as `path` for its row. */
function patchPath(raw: Record<string, unknown>): Record<string, string> {
  if (typeof raw.patchText !== 'string' || raw.path !== undefined || raw.filePath !== undefined) return {};
  const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(raw.patchText);
  return m ? { path: m[1].trim() } : {};
}

/**
 * OpenCode's updates before the turn reads them: a tool call's input comes on its `in_progress`
 * updates and not on its end, so the end gets it back (the row then says what the call did).
 */
export function filterOpencodeUpdate(params: { update: Record<string, any> }, ctx: Pick<OpenRunContext, 'state' | 'sandboxed'>): Record<string, any> | undefined {
  const u = params.update;
  if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) return u;
  const id = String(u.toolCallId ?? '');
  if (!id) return u;
  const st = ctx.state as OpencodeState;
  if (typeof u.kind === 'string' && !st.kinds?.has(id)) (st.kinds ??= new Map()).set(id, u.kind);
  if (ctx.sandboxed && DONE.has(u.status)) {
    // Below full access every command asks (but one that only changes folders): one that ran without
    // asking was sent to its server by something else (its session's shell route).
    const command = String(u.rawInput?.command ?? st.inputs?.get(id)?.command ?? '');
    if (st.kinds?.get(id) === 'execute' && command && !st.asked?.has(id) && opencodeWouldAsk(command)) {
      st.foreign?.(`a command ran without being asked about (${command.slice(0, 200)})`);
    }
    // What the sandbox refused, in words (OpenCode says "Unknown: FileSystem.writeFile (<path>)").
    if (u.status === 'failed' && Array.isArray(u.content)) u.content = u.content.map(sandboxRefusal);
  }
  const inputs = (st.inputs ??= new Map());
  const raw = u.rawInput && typeof u.rawInput === 'object' ? (u.rawInput as Record<string, unknown>) : undefined;
  let out = u;
  if (raw && Object.keys(raw).length) {
    const own = { ...raw, ...patchPath(raw) };
    inputs.set(id, { ...inputs.get(id), ...own });
    if (Object.keys(own).length !== Object.keys(raw).length) out = { ...u, rawInput: own };
  } else if (DONE.has(u.status) && inputs.has(id)) out = { ...u, rawInput: inputs.get(id) };
  // A to-do list is shown once per change: its later updates repeat the same list.
  const todos = Array.isArray(out.rawInput?.todos) ? JSON.stringify(out.rawInput.todos) : undefined;
  if (todos !== undefined) {
    const plans = (st.plans ??= new Map());
    if (plans.get(id) === todos) return { ...out, rawInput: {} };
    plans.set(id, todos);
  }
  return out;
}

/** The `_meta` key a refusal's reason goes in, from `rejection` to `opencodeRefusalBridge` (never sent to OpenCode). */
const REASON_KEY = 'harness-relay/refusal-reason';

/** A refusal's reason, carried in the answer for `opencodeRefusalBridge` (OpenCode ignores any reason in an ACP answer). */
export function opencodeRejection(reason: string): Record<string, unknown> {
  return { _meta: { [REASON_KEY]: reason } };
}

/** Where its server is: the port it was given and the run's password. */
export interface OpencodeServer {
  port: number;
  password: string;
}

/**
 * Refuses a pending permission request through OpenCode's own server, with the reason: the model then
 * reads "The user rejected permission to use this specific tool call with the following feedback:
 * <reason>", and the turn goes on. The request is found by its session and tool call (`GET
 * /permission`); `directory` is the session's working directory, which picks OpenCode's instance.
 * True when OpenCode took it (its own answer to the ACP request then finds nothing left to answer).
 */
export async function rejectWithReason(
  server: OpencodeServer,
  directory: string,
  sessionId: string,
  toolCallId: string,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const base = `http://127.0.0.1:${server.port}`;
  const query = `?directory=${encodeURIComponent(directory)}`;
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}` };
  const list = await fetcher(`${base}/permission${query}`, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!list.ok) return false;
  const pending = (await list.json()) as { id?: unknown; sessionID?: unknown; tool?: { callID?: unknown } }[];
  const match = Array.isArray(pending)
    ? pending.find((p) => p?.sessionID === sessionId && (p.tool?.callID === toolCallId || p.id === toolCallId))
    : undefined;
  if (!match || typeof match.id !== 'string') return false;
  const res = await fetcher(`${base}/permission/${encodeURIComponent(match.id)}/reply${query}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ reply: 'reject', message: reason }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  return res.ok;
}

/**
 * Hands each refusal's reason (Harness Relay's, or the user's note) to the model: before the ACP answer
 * goes out, the request is refused through OpenCode's own server with the reason (`rejectWithReason`);
 * the answer itself goes out without it. When that cannot be done the model only sees OpenCode's
 * generic rejection, which the briefing explains (`OPENCODE_REFUSAL_NOTE`).
 */
export function opencodeRefusalBridge(
  conn: Pick<JsonRpcConnection, 'onRequest'>,
  ctx: Pick<OpenRunContext, 'o' | 'env' | 'state'>,
  sessionId: string,
  send: typeof rejectWithReason = rejectWithReason,
): void {
  const original = conn.onRequest;
  if (!original) return;
  const st = stateOf(ctx as OpenRunContext);
  conn.onRequest = async (method, params) => {
    const call = (params as any)?.toolCall?.toolCallId;
    if (method === 'session/request_permission' && typeof call === 'string') (st.asked ??= new Set()).add(call);
    const answer = await original(method, params);
    if (method !== 'session/request_permission' || !answer || typeof answer !== 'object') return answer;
    const { _meta, ...rest } = answer as Record<string, any>;
    const reason = _meta?.[REASON_KEY];
    if (typeof reason !== 'string') {
      // An allowed call: its approval is expected (`watchOpencode`), before the answer goes out.
      const chosen = (answer as any).outcome?.optionId;
      const options = Array.isArray((params as any)?.options) ? ((params as any).options as { optionId?: string; kind?: string }[]) : [];
      if (typeof call === 'string' && options.some((o) => o.optionId === chosen && String(o.kind).startsWith('allow'))) st.watch?.allowed(call);
      return answer;
    }
    const { [REASON_KEY]: _reason, ...meta } = _meta as Record<string, unknown>;
    const out = Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
    const port = st.port;
    const password = ctx.env.OPENCODE_SERVER_PASSWORD;
    const callId = (params as any)?.toolCall?.toolCallId;
    if (port && password && typeof callId === 'string' && callId) {
      const sid = typeof (params as any)?.sessionId === 'string' ? (params as any).sessionId : sessionId;
      await send({ port, password }, ctx.o.cwd, sid, callId, reason).catch((err: Error) => {
        console.warn('[opencode] could not hand a refusal reason to it:', err.message);
        return false;
      });
    }
    return out;
  };
}

/** How long after the event stream closes the watch waits before ending the run, so a turn that is ending can stop it first. */
export const WATCH_CLOSE_GRACE_MS = 1000;

export interface OpencodeWatch {
  ready: Promise<void>;
  /** Harness Relay allowed this tool call: its approval is expected. */
  allowed(toolCallId: string): void;
  /**
   * The turn is being stopped (Harness Relay cancelled it): the process will exit, so its stream closing
   * or failing from now on is expected. Everything else still ends the run.
   */
  closing(): void;
  /** The turn is over: nothing it sees from now on counts. */
  stop(): void;
}

/**
 * Watches OpenCode's own server for what only something other than Harness Relay could have done
 * (below full access). Its server is reachable from the agent's commands (the sandbox must let OpenCode
 * reach it), and its password, though kept out of the commands' environment (`OPENCODE_SHELL`), can be
 * read from OpenCode's process (its environment at start: `sysctl kern.procargs2` on macOS,
 * `/proc/<pid>/environ` on Linux). With it a command could answer OpenCode's permission requests,
 * start sessions or prompts of its own, change its session's rules or open a terminal, outside
 * Harness Relay's decisions. Seen on its event stream (`GET /global/event`):
 * - a permission request approved that Harness Relay did not allow;
 * - a session that is not the run's (or a subagent of it) created or set to work;
 * - permission rules set on the run's session (Harness Relay never sets any);
 * - a terminal (PTY) opened;
 * - the event stream ending or failing before the turn is over (`stop()`, or `closing()` once the
 *   turn is being stopped): the watch is blind from there on, and something driving the server would
 *   go unseen, so the run ends too.
 * Each ends the run with a security error (`onForeign`). `ready` settles once the stream is open.
 */
export function watchOpencode(
  server: OpencodeServer,
  sessionId: string,
  onForeign: (detail: string) => void,
  fetcher: typeof fetch = fetch,
  graceMs = WATCH_CLOSE_GRACE_MS,
): OpencodeWatch {
  const abort = new AbortController();
  const sessions = new Set([sessionId]);
  const asked = new Map<string, string>();
  const allowed = new Set<string>();
  let stopped = false;
  let closing = false;
  const foreign = (detail: string) => {
    if (!stopped) onForeign(detail);
  };
  /**
   * The stream closing or failing is suspicious while the turn runs. A turn that ends stops the watch
   * as soon as the prompt answers, before the process is told to exit (`endTurn`), and one that is
   * stopped says so (`closing()`); the grace covers a stop racing the close.
   */
  const foreignSoon = (detail: string) => {
    if (closing) return;
    setTimeout(() => {
      if (!closing) foreign(detail);
    }, graceMs).unref();
  };
  const handle = (ev: { type?: string; properties?: Record<string, any> }) => {
    const p = ev.properties ?? {};
    switch (ev.type) {
      case 'permission.asked':
        if (typeof p.id === 'string') asked.set(p.id, typeof p.tool?.callID === 'string' ? p.tool.callID : p.id);
        break;
      case 'permission.replied': {
        if (p.reply === 'reject') break; // a refusal widens nothing (OpenCode also refuses the session's other requests with it)
        const call = asked.get(String(p.requestID));
        if (!call || !allowed.has(call)) foreign(`a permission request (${String(p.requestID)}) was answered "${String(p.reply)}" by something other than Harness Relay`);
        break;
      }
      case 'session.created':
      case 'session.updated': {
        const info = p.info ?? {};
        if (typeof info.id !== 'string') break;
        if (typeof info.parentID === 'string' && sessions.has(info.parentID)) sessions.add(info.id);
        if (ev.type === 'session.created' && !sessions.has(info.id)) foreign(`a session Harness Relay did not start was created (${info.id})`);
        else if (sessions.has(info.id) && Array.isArray(info.permission) && info.permission.length) foreign(`permission rules were set on the session (${info.id})`);
        break;
      }
      case 'session.status':
        if ((p.status?.type === 'busy' || p.status?.type === 'retry') && typeof p.sessionID === 'string' && !sessions.has(p.sessionID)) {
          foreign(`a session Harness Relay did not start was set to work (${p.sessionID})`);
        }
        break;
      case 'pty.created':
        foreign('a terminal was opened on its server');
        break;
    }
  };
  const ready = (async () => {
    const res = await fetcher(`http://127.0.0.1:${server.port}/global/event`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}`, accept: 'text/event-stream' },
      signal: abort.signal,
      redirect: 'error',
    });
    if (!res.ok || !res.body) throw new Error(`its event stream answered ${res.status}`);
    return res.body;
  })();
  const read = ready.then(async (body) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      // The stream ended on its own: the watch is now blind, so (unless the turn stopped it) the run ends.
      if (done) return foreignSoon('its event stream closed while the turn was running');
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5)) as { payload?: { type?: string; properties?: Record<string, any> } };
          if (msg.payload) handle(msg.payload);
        } catch {
          // not JSON: not an event of interest
        }
      }
    }
  });
  // A read error (not our abort) is the same blindness: end the run (after the grace, as for a close).
  read.catch((err: Error) => {
    if (!stopped && err?.name !== 'AbortError') foreignSoon(`its event stream failed while the turn was running: ${err?.message ?? err}`);
  });
  return {
    ready: ready.then(() => undefined),
    allowed: (toolCallId) => void allowed.add(toolCallId),
    closing: () => {
      closing = true;
    },
    stop: () => {
      stopped = true;
      abort.abort();
    },
  };
}

/** OpenCode's cd-type commands (`ShellTool` `CWD`): a simple command of one of these is not asked about. */
const OPENCODE_CWD_COMMANDS = new Set(['cd', 'chdir', 'popd', 'pushd', 'push-location', 'set-location']);
/**
 * Builtins bash's grammar (tree-sitter-bash, which OpenCode parses with) makes a `declaration_command`
 * or `unset_command`, never a `command` node, so OpenCode never asks about `declare X=1`, `export X`,
 * `unset X`. A command substitution inside one (`export X=$(id)`) is still its own command and is asked
 * about; the single-quoted-subscript trap forms (`declare 'a[$(…)]=1'`) are refused by `relay-shell`.
 */
const OPENCODE_DECLARATION = new Set(['declare', 'typeset', 'export', 'local', 'readonly', 'unset']);
/** Keywords skipped to reach the real command of a simple command (`time curl …`, `do cat …`, `while cat …`). */
const OPENCODE_SKIP_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'done', 'fi', 'while', 'until', 'case', 'esac', 'in', 'time', '!']);
/**
 * Keywords whose words are only a header, not a command (`for NAME in …`, `select NAME in …`, and
 * `function NAME`, whose body's commands come after the `{` that splits it off).
 */
const OPENCODE_HEADER_KEYWORDS = new Set(['for', 'select', 'function']);

/**
 * Whether OpenCode's `ShellTool.collect` would ask the user about this command. OpenCode parses it with
 * tree-sitter-bash and asks when the tree has a `command` node whose first word is a real program (not a
 * cd-type command). Below full access every such command asks, so one that ran without being asked came
 * in by another path (its session's shell route, which Harness Relay's watch catches). This mirrors
 * OpenCode's decision: a command substitution (`$(…)`, a backquote, anywhere outside single quotes,
 * inside double quotes too) is its own command list, and `declare`/`export`/`unset`, `(( ))`, `[[ ]]`,
 * `[ ]`, assignments, redirections, comments and `for`/`select` headers hold no command of their own.
 * Where it cannot parse plainly it errs towards not asking (so towards not firing), never the other way;
 * the relay sandbox's file and network rules are the real boundary, and `relay-shell` refuses the
 * metaprogramming forms OpenCode misses (`opencodeShellScript`).
 */
export function opencodeWouldAsk(command: string): boolean {
  // Each command substitution is a command list OpenCode parses on its own.
  for (const body of commandSubstitutions(command)) if (opencodeWouldAsk(body)) return true;
  for (const words of shellSegments(command)) if (segmentCommand(words) !== undefined) return true;
  return false;
}

/** The program word of a simple command, or undefined when it has none (assignment, redirection, declaration, test, header). */
export function segmentCommand(words: string[]): string | undefined {
  let i = 0;
  const skip = () => {
    for (;;) {
      const w = words[i];
      if (w === undefined) return;
      if (isAssignment(w)) i++;
      else if (isRedirection(w)) i += bareRedirection(w) ? 2 : 1; // a bare `>` / `2>` takes the next word as its target
      else return;
    }
  };
  skip();
  let w = words[i];
  if (w !== undefined && OPENCODE_HEADER_KEYWORDS.has(w)) return undefined; // a for/select header
  while (w !== undefined && OPENCODE_SKIP_KEYWORDS.has(w)) {
    i++;
    skip();
    w = words[i];
  }
  if (w === undefined || OPENCODE_DECLARATION.has(w) || w === '[') return undefined; // declaration or the `[` test
  if (w.startsWith('$') || w.startsWith('`')) return undefined; // an expansion, not a command name
  const name = commandBase(w);
  return name && !OPENCODE_CWD_COMMANDS.has(name) ? name : undefined;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const isAssignment = (w: string) => ASSIGNMENT.test(w);
const isRedirection = (w: string) => /^[0-9]*(?:>>|&>|>&|<&|<<|[<>])/.test(w) || w === '|&';
/** A redirection operator that takes the following word as its target (`>`, `2>`, `<`, `>>`): ends in `<`/`>`. */
const bareRedirection = (w: string) => /[<>]$/.test(w);

/** A command word's program name: its last path segment, unquoted, lowercased. */
function commandBase(word: string): string {
  const unq = word.replace(/^['"]|['"]$/g, '');
  const base = unq.slice(unq.lastIndexOf('/') + 1);
  return base.toLowerCase();
}

/** The index of the `)` that matches the `(` at `open`, honouring quotes; `command.length` when unmatched. */
function matchParen(command: string, open: number): number {
  let depth = 0;
  for (let j = open; j < command.length; j++) {
    const c = command[j]!;
    if (c === '\\') j++;
    else if (c === "'") j = command.indexOf("'", j + 1) < 0 ? command.length : command.indexOf("'", j + 1);
    else if (c === '"') {
      let k = j + 1;
      while (k < command.length && command[k] !== '"') k += command[k] === '\\' ? 2 : 1;
      j = k;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return command.length;
}

/** The index of the `}` that matches the `{` at `open` (a `${ … }` expansion), honouring quotes and nested `$( )`/`${ }`; `command.length` when unmatched. */
function matchBrace(command: string, open: number): number {
  let depth = 0;
  for (let j = open; j < command.length; j++) {
    const c = command[j]!;
    if (c === '\\') j++;
    else if (c === "'") j = command.indexOf("'", j + 1) < 0 ? command.length : command.indexOf("'", j + 1);
    else if (c === '"') {
      let k = j + 1;
      while (k < command.length && command[k] !== '"') k += command[k] === '\\' ? 2 : 1;
      j = k;
    } else if (c === '`') j = command.indexOf('`', j + 1) < 0 ? command.length : command.indexOf('`', j + 1);
    else if (c === '$' && command[j + 1] === '(') j = matchParen(command, j + 1);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return command.length;
}

/**
 * The bodies of the command substitutions in `command` — `$(…)` and a backquoted span — outside single
 * quotes (inside double quotes too), not an arithmetic expansion (`$(( … ))`). Each is a command list of
 * its own, scanned again by `opencodeWouldAsk`.
 */
export function commandSubstitutions(command: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') i++;
    else if (c === "'") {
      const e = command.indexOf("'", i + 1);
      i = e < 0 ? command.length : e;
    } else if (c === '`') {
      const e = command.indexOf('`', i + 1);
      out.push(command.slice(i + 1, e < 0 ? command.length : e));
      i = e < 0 ? command.length : e;
    } else if (c === '$' && command[i + 1] === '(') {
      const end = matchParen(command, i + 1);
      if (command[i + 2] !== '(') out.push(command.slice(i + 2, end)); // not arithmetic `$(( … ))`
      i = end;
    }
  }
  return out;
}

/**
 * The simple commands of a shell line as word lists, from a skeleton with the command substitutions and
 * single-quoted text removed, the `(( … ))` and `[[ … ]]` regions (which hold no command node) dropped,
 * and comments stripped, split on the metacharacters that separate commands (`; & | && || newline`) and
 * the subshell and group delimiters (`( ) { }`), honouring double quotes and `\` escapes. Not a full
 * shell parser: enough to find each command's first word the way OpenCode's grammar does.
 */
export function shellSegments(command: string): string[][] {
  let s = skeletonLine(command);
  s = s.replace(/\[\[[^\]]*\]\]/g, ' '); // [[ … ]] test
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\(\([^()]*\)\)/g, ' '); // (( … )) arithmetic
  } while (s !== prev);
  // An array assignment's `(…)` is a value, not a subshell, and a function header's `()` is not one either:
  // tree-sitter makes no command node of them, so they must not split into a command (`arr=(a b)`, `f() { … }`,
  // `declare -A m=([k]=v)`). The commands inside a function body (its `{ … }`) are still reached by the split.
  s = s.replace(/([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=)\([^()]*\)/g, '$1 '); // name=( … ) / name[i]=( … ) / name+=( … )
  s = s.replace(/\b[A-Za-z_][A-Za-z0-9_-]*[ \t]*\(\)/g, ' '); // name() function header

  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  const endWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    // An `&` that belongs to a redirection (`2>&1`, `>&2`, `&>file`) is part of the word, not a separator.
    if (c === '&' && s[i + 1] !== '&' && (/[<>]$/.test(word) || s[i + 1] === '>')) {
      word += c;
      hasWord = true;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '{' || c === '}') {
      if ((c === '&' || c === '|') && s[i + 1] === c) i++; // && ||
      endSegment();
      continue;
    }
    word += c;
    hasWord = true;
  }
  endSegment();
  return segments;
}

/**
 * A skeleton of a shell line for `shellSegments`, where each word stays one word and only unquoted
 * metacharacters remain to split on: a single- or double-quoted span becomes `_` (a filler, so an
 * assignment keeps its name and a quoted separator cannot split — `cd "a; rm"` is one command), an
 * unquoted command substitution or arithmetic expansion (`$(…)`, a backquote, `$(( … ))`) becomes a
 * space, `\` escapes keep the next character (a `\` before a newline joins the lines, as the shell does),
 * and a `#` comment to the end of the line is dropped. A
 * command substitution hidden in a quoted span is still found by `commandSubstitutions`, separately.
 */
export function skeletonLine(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') {
      const next = command[++i] ?? '';
      if (next !== '\n') out += next; // a line continuation is no separator
    } else if (c === "'") {
      const e = command.indexOf("'", i + 1);
      out += '_';
      i = e < 0 ? command.length : e;
    } else if (c === '"') {
      let k = i + 1;
      while (k < command.length && command[k] !== '"') k += command[k] === '\\' ? 2 : 1;
      out += '_';
      i = Math.min(k, command.length);
    } else if (c === '`') {
      const e = command.indexOf('`', i + 1);
      out += ' ';
      i = e < 0 ? command.length : e;
    } else if (c === '$' && command[i + 1] === '(') {
      out += ' ';
      i = matchParen(command, i + 1);
    } else if (c === '$' && command[i + 1] === '{') {
      out += '_'; // a `${ … }` parameter expansion is part of its word (a command substitution within is found separately)
      i = matchBrace(command, i + 1);
    } else if (c === '#' && (out === '' || /\s$/.test(out))) {
      const nl = command.indexOf('\n', i);
      if (nl < 0) return out;
      out += '\n';
      i = nl;
    } else {
      out += c;
    }
  }
  return out;
}

/** `fs/write_text_file`, sent after every edit it was allowed: answered as done, never done (it wrote the file itself). */
export function opencodeClientRequest(method: string): { result: unknown } | undefined {
  return method === 'fs/write_text_file' ? { result: null } : undefined;
}

type ConfigOption = NonNullable<AcpSessionState['configOptions']>[number];

/** Sets one of the session's config options, returning the options as they are after it. */
async function setOption(
  conn: Pick<JsonRpcConnection, 'request'>,
  sessionId: string,
  configId: string,
  value: string,
  rejected: (e: string) => string,
): Promise<ConfigOption[] | undefined> {
  try {
    const r = (await conn.request('session/set_config_option', { sessionId, configId, value })) as { configOptions?: ConfigOption[] } | null;
    return r?.configOptions;
  } catch (err) {
    throw new AgentRunError(rejected(rpcText(err)));
  }
}

/**
 * Once the session is there, in OpenCode's own order: its mode (`build`; a resumed session keeps the
 * one it had), its model (one session restores the model it had), then the effort (a model's variants;
 * changing the model resets it). Also reads the session's cost so far, for `usage`.
 */
/**
 * Below full access: watches its server (`watchOpencode`) for the run; what it sees ends the run with a
 * security error (the turn is cancelled and its connection closed). Fails closed: a run whose server
 * cannot be watched does not go on.
 */
async function startWatch(
  conn: Pick<JsonRpcConnection, 'notify' | 'close'>,
  sessionId: string,
  ctx: Pick<OpenRunContext, 'o' | 'env' | 'state'>,
  watch: typeof watchOpencode,
): Promise<void> {
  const st = ctx.state as OpencodeState;
  const port = st.port;
  const password = ctx.env.OPENCODE_SERVER_PASSWORD;
  if (!port || !password) throw new AgentRunError(t().opencodeWatchFailed('no port or password for its server'));
  let ended = false;
  st.foreign = (detail) => {
    if (ended) return;
    ended = true;
    console.warn(`[opencode] ${detail}: the run is ended`);
    st.watch?.stop();
    conn.notify('session/cancel', { sessionId });
    conn.close(new AgentRunError(t().opencodeForeignControl(detail)));
  };
  st.watch = watch({ port, password }, sessionId, (detail) => st.foreign?.(detail));
  // Stopped by the user (or timed out): the process is told to exit, and its stream closes as it does.
  if (ctx.o.signal.aborted) st.watch.closing();
  else ctx.o.signal.addEventListener('abort', () => st.watch?.closing(), { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      st.watch.ready,
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error('its event stream did not open')), 5000);
      }),
    ]);
  } catch (err) {
    st.watch.stop();
    throw new AgentRunError(t().opencodeWatchFailed((err as Error).message));
  } finally {
    clearTimeout(timer);
  }
}

export async function opencodeAfterSession(
  conn: Pick<JsonRpcConnection, 'request' | 'onRequest' | 'notify' | 'close'>,
  session: { sessionId: string; state: AcpSessionState },
  ctx: Pick<OpenRunContext, 'o' | 'run' | 'state' | 'home' | 'env' | 'sandboxed'>,
  watch: typeof watchOpencode = watchOpencode,
): Promise<void> {
  const { sessionId } = session;
  const st = ctx.state as OpencodeState;
  st.sessionId = sessionId;
  opencodeRefusalBridge(conn, ctx, sessionId);
  if (ctx.sandboxed) await startWatch(conn, sessionId, ctx, watch);
  st.costBefore = readSessionCost(ctx.home.root, sessionId);
  let options = (session.state.configOptions ?? []) as ConfigOption[];
  const current = (id: string) => options.find((c) => c?.id === id)?.currentValue;

  const mode = current('mode');
  if (mode !== undefined && mode !== 'build') {
    options = (await setOption(conn, sessionId, 'mode', 'build', (e) => t().openRejectedMode(CLI, 'build', e))) ?? options;
  }
  const model = opencodeModelId(ctx.run);
  if (current('model') !== model) {
    options = (await setOption(conn, sessionId, 'model', model, (e) => t().openRejectedModel(CLI, ctx.run.id, e))) ?? options;
  }
  // No effort given: OpenCode's own choice (a new session takes the model's first variant), or the session's.
  const effort = ctx.o.effort;
  if (!effort) return;
  const effortOption = options.find((c) => c?.category === 'thought_level' || c?.id === 'effort');
  if (!effortOption) return; // this model has no effort levels in OpenCode (an endpoint's)
  if (effortOption.currentValue === effort) return;
  await setOption(conn, sessionId, effortOption.id, effort, (e) => t().openRejectedEffort(CLI, effort, e));
}

/** A JSON-RPC error's own message, without the data RpcError appends. */
function rpcText(err: unknown): string {
  if (err instanceof RpcError) {
    const data = err.data === undefined || err.data === null ? '' : typeof err.data === 'string' ? err.data : JSON.stringify(err.data);
    return data && err.message.endsWith(`: ${data}`) ? err.message.slice(0, -data.length - 2) : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const COST_FILE = /^[A-Za-z0-9_-]{1,100}$/;

/** The session's total cost when its last turn ended, as Harness Relay kept it (undefined: not known). */
export function readSessionCost(root: string, sessionId: string): number | undefined {
  if (!COST_FILE.test(sessionId)) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(opencodePaths(root).relay, `${sessionId}.json`), 'utf8')) as { total?: unknown };
    return typeof v.total === 'number' && Number.isFinite(v.total) ? v.total : undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionCost(root: string, sessionId: string, total: number): void {
  if (!COST_FILE.test(sessionId)) return;
  try {
    const dir = opencodePaths(root).relay;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ total }), { mode: 0o600 });
  } catch (err) {
    console.warn('[opencode] could not keep the session cost:', (err as Error).message);
  }
}

/**
 * Tokens and cost of the turn: the tokens are those of the turn's last model call (all ACP gives);
 * OpenCode's `usage_update` cost is the session's total, so the turn's is that minus the total
 * kept when the session's previous turn ended (the whole total for a session not seen before).
 */
export function opencodeUsage(
  result: Record<string, any> | undefined,
  last: Parameters<typeof acpUsage>[1],
  ctx: Pick<OpenRunContext, 'state' | 'home'>,
): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  const usage = acpUsage(result, last);
  const st = ctx.state as OpencodeState;
  if (usage.costUsd === undefined || !st.sessionId) return usage;
  writeSessionCost(ctx.home.root, st.sessionId, usage.costUsd);
  return { ...usage, costUsd: Math.max(0, usage.costUsd - (st.costBefore ?? 0)) };
}

// --- Errors -------------------------------------------------------------------------------------

/**
 * A failed turn's message for the user: OpenCode reports the backend's own error (a bad key, a model
 * the endpoint does not have, an endpoint it cannot reach) as `Internal error: <message>` with its
 * service's data; it is said as the backend's answer, with where to fix it.
 */
export function opencodeRunError(err: unknown, o: Pick<RunOptions, 'model' | 'backends'>): unknown {
  if (!(err instanceof AgentRunError) || err.aborted) return err;
  const parsed = parseBackendModel(o.model ?? '');
  const label = parsed && o.backends ? backendLabel(o.backends, parsed.backend) : (parsed?.backend ?? CLI);
  const m = /^Internal error: ([\s\S]*?)(?:: (\{[\s\S]*\}))?$/.exec(err.message);
  if (m) {
    let data: Record<string, unknown> = {};
    try {
      data = m[2] ? (JSON.parse(m[2]) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    if (data.service === 'session' && typeof data.errorName === 'string') return new AgentRunError(t().opencodeBackendError(label, m[1].trim().replace(/[.。]$/, '')));
  }
  if (/provider authentication required/i.test(err.message)) return new AgentRunError(t().opencodeAuthRequired(label));
  // Another of its errors (a failed resume, say): without the data JSON-RPC appended to its message.
  const plain = err.message.replace(OPENCODE_ERROR_DATA, '');
  return plain === err.message ? err : new AgentRunError(plain);
}

/** The data OpenCode's errors carry, as RpcError appends it to the message: `: {"service":"session"…}`. */
const OPENCODE_ERROR_DATA = /: \{"(?:service|errorName)":"[^"]*"(?:,"(?:service|errorName)":"[^"]*")*\}/g;

// --- Catalog and what it loads by itself --------------------------------------------------------

/** Dummy keys that only make OpenCode list the API backends' models (no API is called to list them). */
const CATALOG_KEYS = Object.fromEntries(API_BACKENDS.map((id) => [API_BACKEND_ENV[id], 'harness-relay-catalog']));

/**
 * The models of `opencode models --verbose`, which prints each model's id (`provider/model`) on a line
 * and its details as JSON after it: the API backends' models that call tools and answer in text, with
 * their effort levels (OpenCode's variants of the model).
 */
export function parseOpencodeModels(text: string): ModelOption[] {
  const out: ModelOption[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[a-z0-9-]+\/\S+$/.test(id) || lines[i + 1] !== '{') continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== '}') end++;
    let info: Record<string, any>;
    try {
      info = JSON.parse(lines.slice(i + 1, end + 1).join('\n')) as Record<string, any>;
    } catch {
      continue;
    }
    i = end;
    const parsed = parseBackendModel(id);
    if (!parsed || !isApiBackend(parsed.backend)) continue;
    const caps = info.capabilities ?? {};
    if (caps.toolcall !== true || caps.output?.text === false || info.status === 'deprecated') continue;
    const efforts = Object.keys(info.variants ?? {}).filter((v) => v !== 'default');
    out.push({ id, ...(typeof info.name === 'string' && info.name ? { label: info.name } : {}), ...(efforts.length ? { efforts } : {}) });
  }
  return out;
}

/** The environment of a query outside a run (catalog, what it loads by itself): its home, nothing of a run. */
function queryEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  ensureOpencodeHome(openAgentHome(env));
  const out: NodeJS.ProcessEnv = { ...env, ...Object.fromEntries(OPENCODE_EMPTY_ENV.map((n) => [n, ''])), ...extra };
  return out;
}

export async function opencodeModels(bin: string, env: NodeJS.ProcessEnv, run = runProcess): Promise<OpenCatalog> {
  const root = openAgentHome(env);
  const res = await run({
    bin,
    args: ['models', '--verbose'],
    cwd: root,
    env: queryEnv(env, { ...CATALOG_KEYS, OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [...API_BACKENDS] }) }),
    timeoutMs: 60_000,
    maxCapture: 32 * 1024 * 1024,
    keepStart: true,
  });
  if (res.timedOut) return { models: [], error: t().timedOut };
  const models = parseOpencodeModels(res.stdout);
  if (res.code !== 0 && !models.length) return { models: [], error: res.stderr.trim().split('\n').slice(-3).join(' ') || t().exitedWithoutTurn(CLI, res.code) };
  return { models };
}

/** Its skills, from `opencode debug skill` (a JSON list of `{name, description, location, content}`). */
export function parseOpencodeSkills(text: string, cwd: string): NativeSkill[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(text.slice(text.indexOf('[')));
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const inside = (p: string) => p === cwd || p.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep);
  return list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as any).name === 'string')
    .map((s) => {
      const location = typeof s.location === 'string' ? s.location : '';
      const builtIn = location === '<built-in>';
      return {
        id: String(s.name),
        name: String(s.name),
        description: typeof s.description === 'string' ? s.description : '',
        source: builtIn ? 'built-in' : inside(location) ? 'project' : 'user',
        ...(builtIn || !location ? {} : { path: location }),
      };
    });
}

/** Its subagents, from `opencode agent list` (`<name> (<mode>)` lines, each followed by its rules). */
export function parseOpencodeAgents(text: string): NativeAgent[] | undefined {
  const agents: NativeAgent[] = [];
  let any = false;
  for (const line of text.split('\n')) {
    const m = /^(\S+) \((primary|subagent|all)\)$/.exec(line);
    if (!m) continue;
    any = true;
    if (m[2] === 'primary') continue;
    agents.push({ id: m[1], name: m[1], description: '', source: m[1] === 'general' || m[1] === 'explore' ? 'built-in' : 'config' });
  }
  return any ? agents : undefined;
}

/**
 * What OpenCode loads by itself for a folder, as Harness Relay starts it (its project config never):
 * its skills (`opencode debug skill`), its subagents (`opencode agent list`), and the project's
 * instruction files (the files its own lookup finds, which Harness Relay passes on).
 */
export async function opencodeNative(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 30_000, run = runProcess): Promise<NativeProbe> {
  const probeEnv = queryEnv(env);
  const ask = (args: string[]) => run({ bin, args, cwd, env: probeEnv, timeoutMs, maxCapture: 8 * 1024 * 1024, keepStart: true });
  const [skillsRes, agentsRes] = await Promise.all([ask(['debug', 'skill']), ask(['agent', 'list'])]);
  const problems: NativeProblem[] = [];
  const failed = (res: Awaited<ReturnType<typeof runProcess>>, part: 'skills' | 'agents'): void => {
    if (res.timedOut) problems.push({ kind: 'timeout' });
    else if (res.stderr.trim()) problems.push({ kind: 'failed', detail: res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) });
    else problems.push({ kind: 'no-answer', part });
  };
  const skills = skillsRes.code === 0 ? parseOpencodeSkills(skillsRes.stdout, resolve(cwd)) : undefined;
  if (!skills) failed(skillsRes, 'skills');
  const agents = agentsRes.code === 0 ? parseOpencodeAgents(agentsRes.stdout) : undefined;
  if (!agents) failed(agentsRes, 'agents');
  const memory: NativeMemoryFile[] = opencodeProjectInstructions(cwd).map((path) => ({ path, kind: 'instructions' }));
  return {
    provider: 'opencode',
    cwd,
    skills: skills ?? [],
    mcpServers: [],
    memory,
    ...(agents ? { agents } : {}),
    memoryFromFiles: true,
    nativeOff: [],
    nativeItems: {},
    asRun: false,
    problems,
    checkedAt: Date.now(),
  };
}

// --- The adapter --------------------------------------------------------------------------------

export const opencodeAcp: AcpAgentSpec = {
  provider: 'opencode',
  implemented: true,
  // Its server on a port of its own (0 would take 4096 first), for `opencodeRefusalBridge`.
  args: (ctx) => ['acp', '--port', String(stateOf(ctx).port ?? 0)],
  home: opencodeHome,
  proxyEnv: {},
  emptyEnv: OPENCODE_EMPTY_ENV,
  prepare: (ctx) => prepareOpencode(ctx),
  sandboxUnsupported: opencodeSandboxUnsupported,
  sandbox: opencodeSandbox,
  // Both are set in `afterSession`, in OpenCode's order (the model resets the effort).
  model: { via: 'config' },
  effort: { via: 'config' },
  briefing: 'custom',
  afterSession: (conn, session, ctx) => opencodeAfterSession(conn, session, ctx),
  describeCall: (call, earlier) => describeOpencodeCall(call, earlier),
  hideTool: hideOpencodeTool,
  planOf: opencodePlan,
  clientRequest: opencodeClientRequest,
  // The prompt answered: the turn is over, and its stream closes as the process exits after it (told to
  // when its stdin closes, next), which is no security event. Until here the watch stays armed.
  endTurn: (_result, ctx) => (ctx.state as OpencodeState).watch?.stop(),
  // However else the turn ends, the process is disposed, which runs this (`OpenAgentProcess.cleanup`).
  cleanup: (ctx) => (ctx.state as OpencodeState).watch?.stop(),
  rejection: opencodeRejection,
  filterUpdate: filterOpencodeUpdate,
  usage: opencodeUsage,
};

/** OpenCode's runner: the generic ACP turn, with its errors said as the backend's. */
export function opencodeRunner(deps: Partial<AcpTurnDeps> = {}): AgentRunner {
  const inner = acpRunner(opencodeAcp, deps);
  return {
    provider: 'opencode',
    async run(o) {
      try {
        return await inner.run(o);
      } catch (err) {
        throw opencodeRunError(err, o);
      }
    },
  };
}

export const opencodeAgent: OpenAgentDefinition = {
  provider: 'opencode',
  process: opencodeAcp,
  runner: opencodeRunner(),
  // Effort levels are per model (its variants), from the catalog; an endpoint's models have none.
  efforts: [],
  models: (bin, env) => opencodeModels(bin, env),
  native: (bin, env, cwd, timeoutMs) => opencodeNative(bin, env, cwd, timeoutMs),
};
