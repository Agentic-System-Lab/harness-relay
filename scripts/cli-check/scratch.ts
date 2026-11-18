/**
 * The scratch folders every CLI `scripts/cli-check.ts` starts runs in, and the environment that keeps
 * it there: a home, XDG folders, a temporary folder and Harness Relay's data folder of its own, the
 * CLIs' auto-updates off and no browser opened, and none of the developer's own variables but the
 * PATH and the locale, so that no CLI finds a sign-in, a key or a config folder of theirs
 * (Muse Code reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, Copilot signs in with a `GITHUB_TOKEN`).
 *
 * Two fresh folders. Harness Relay's data folder and the temporary folder are in /tmp
 * (`CLI_CHECK_DIR` names another place): its own sandbox puts its sockets in the data folder, whose
 * path must be short (`HOST_TMP_MAX`), and macOS's own temporary folder is too deep for that. The
 * home, the working directories and the folders outside them are in `~/.cache/harness-relay-cli-check`
 * (`CLI_CHECK_WORK_DIR` names another place), outside every temporary folder: the CLIs' sandboxes
 * let commands write in the temporary folders (Codex's `/tmp` and `$TMPDIR`, Muse Code's), which
 * would let a write the check expects refused go through. Only the fresh folders it makes are
 * removed, and only without `--keep`.
 *
 * The server's modules read the environment as they load (the data folder, `config.ts`): `isolate()`
 * must make the scratch environment this process's own before any of them is imported.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Scratch {
  /** The folder in /tmp: the data folder and the temporary folder. */
  root: string;
  /** The folder outside the temporary folders: the home, and each CLI's working directory and outside folder. */
  place: string;
  /** HOME: every CLI's own folders are made here. */
  home: string;
  /** Harness Relay's data folder (`RELAY_DATA_DIR`), with stand-ins for its database and key. */
  data: string;
  env: NodeJS.ProcessEnv;
  /** A CLI's own working directory and folder outside it, with its own switches (`CLI_ENV`) put in `process.env`. */
  forCli(p: string): CliScratch;
  /**
   * Removes the folders (all of them, and nothing else), unless they are kept: with the owner's
   * permissions given back first, since an open agent's run leaves its config read-only.
   */
  dispose(): Promise<void>;
}

export interface CliScratch {
  /** The working directory its runs start in (made a git repository by layer 3). */
  work: string;
  /** A folder outside the working directory, for writes a run must not make. */
  outside: string;
}

/** The developer's variables a run keeps: how to find programs and how to print text. */
const KEPT = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'USER', 'LOGNAME', 'SHELL'];

/**
 * What one CLI's environment adds. Antigravity prints its sign-in link instead of opening a browser
 * when it finds itself over SSH; Cursor, over SSH, refuses to start at all where it cannot reach the
 * login keychain ("Your macOS login keychain is locked"), so only agy is told so.
 */
const CLI_ENV: Record<string, Record<string, string>> = {
  antigravity: { SSH_CONNECTION: '127.0.0.1 22 127.0.0.1 22' },
};

/** A scratch environment as one CLI gets it (`CLI_ENV`). */
export function cliEnv(p: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...(CLI_ENV[p] ?? {}) };
}

export function makeScratch(
  keep = false,
  base = process.env.CLI_CHECK_DIR || '/tmp',
  workBase = process.env.CLI_CHECK_WORK_DIR || join(homedir(), '.cache', 'harness-relay-cli-check'),
): Scratch {
  const root = realpathSync(mkdtempSync(join(base, 'relay-cli-check-')));
  mkdirSync(workBase, { recursive: true, mode: 0o700 });
  const place = realpathSync(mkdtempSync(join(workBase, 'run-')));
  const mk = (d: string) => {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  };
  const home = mk(join(place, 'home'));
  const data = mk(join(root, 'data'));
  mk(join(data, 'tmp'));
  // What a protected read would find: stand-ins, never the real ones.
  writeFileSync(join(data, 'relay.db'), 'RELAY-DB-STAND-IN');
  writeFileSync(join(data, 'secrets.key'), 'RELAY-KEY-STAND-IN', { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  for (const k of KEPT) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: home,
    TMPDIR: mk(join(root, 'tmp')),
    XDG_CONFIG_HOME: mk(join(home, '.config')),
    XDG_DATA_HOME: mk(join(home, '.local', 'share')),
    XDG_CACHE_HOME: mk(join(home, '.cache')),
    XDG_STATE_HOME: mk(join(home, '.local', 'state')),
    RELAY_DATA_DIR: data,
    // Harness Relay's keys in its database, encrypted with the stand-in key: never the system's keyring.
    RELAY_KEYRING: 'off',
    RELAY_KEYRING_SERVICE: 'harness-relay-cli-check',
    // The CLIs' own updates off: a check is of the version given, and never changes a copy.
    DISABLE_AUTOUPDATER: '1',
    COPILOT_AUTO_UPDATE: 'false',
    GROK_DISABLE_AUTOUPDATER: '1',
    NO_AUTO_UPDATE: '1',
    // No browser opened for a sign-in: Cursor's switch (agy's is in `CLI_ENV`).
    NO_OPEN_BROWSER: '1',
    BROWSER: 'false',
    // Goose's keyring is the system's: its secrets in a file in its home instead.
    GOOSE_DISABLE_KEYRING: '1',
    GIT_AUTHOR_NAME: 'cli-check',
    GIT_AUTHOR_EMAIL: 'cli-check@localhost',
    GIT_COMMITTER_NAME: 'cli-check',
    GIT_COMMITTER_EMAIL: 'cli-check@localhost',
  });
  return {
    root,
    place,
    home,
    data,
    env,
    forCli: (p) => {
      for (const [k, v] of Object.entries(CLI_ENV)) {
        if (k === p) Object.assign(process.env, v);
        else for (const name of Object.keys(v)) delete process.env[name];
      }
      return { work: mk(join(place, `work-${p}`)), outside: mk(join(place, `outside-${p}`)) };
    },
    dispose: async () => {
      if (keep) return;
      // Imported here: the server's modules are imported only once `isolate()` ran.
      const { removeTree } = await import('../../src/server/fsRemove');
      removeTree(root, { restore: true });
      removeTree(place, { restore: true });
    },
  };
}

/**
 * Makes `env` this process's whole environment, before the server's modules are imported: they
 * read it as they load (`config.ts`, the data folder) and give it to every CLI they start.
 */
export function isolate(env: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
}
