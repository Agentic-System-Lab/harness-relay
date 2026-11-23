import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { INTERACTIVE_LIMITS, type InteractiveSession } from '../shared/types';
import { maskValues } from '../shared/handoffs';
import { ASKPASS_ENV, ASKPASS_SCRIPT, ASKPASS_SHIM_SOURCE } from './askpassShim';
import { checkEnv } from './checkCommands';
import { removeTree } from './fsRemove';
import type { AskpassGrant, AskpassHandler } from './gateway';
import { linksAndCodes } from './login';
import { CommandNotFoundError, killTree, spawnInteractive, stripAnsi } from './process';
import { relayTmpDir, RUN_TMP_PREFIXES } from './protect';

/*
 * Interactive commands (docs/architecture.md, "Interactive commands"): a command an agent asks the user
 * to run themselves (an `<interactive>` block), which only the user starts, from its card. It runs with
 * the user's rights, outside every sandbox, as a terminal would run it, but without one:
 *
 * - through the fixed shell script check commands use, the command line in the environment, with
 *   `checkEnv()`'s environment (never the server's, which may hold API keys) but not its `CI=1`, which
 *   makes many programs skip their prompts;
 * - in an empty folder of its own in Harness Relay's temporary folder, or in the working directory when
 *   the user chooses so (the card then lists the configuration files there it may load, which agents can
 *   write: `workdirConfigFiles()`);
 * - its output and what the user types visibly shown on the card as a terminal would show them, with
 *   the folder's secret values and everything typed hidden replaced by dots (`maskValues`), the links and
 *   codes picked out; what the user types sent as it is, a line at a time (never trimmed);
 * - a password helper of its own for the programs that ask through one (`sudo -A`, ssh, git:
 *   `askpassShim.ts`), which reaches the server over the gateway's socket with a token for this session
 *   alone, and asks the card for one hidden line;
 * - stopped by its time limit, by Cancel, and with the server; its folder removed when it ends.
 *
 * It never starts on native Windows (no `/bin/sh`), and has no terminal: a program that needs one
 * (a full-screen program, a prompt that checks for one) cannot be answered here.
 */

/** The shell script it runs in: its output and errors together, the command line from the environment (as check commands'). */
const SCRIPT = 'exec 2>&1; eval "$RELAY_CHECK_COMMAND"';

/** The most of its output kept in memory (its end), before masking and the card's own limit. */
const RAW_MAX = 128 * 1024;

/**
 * How long its output may go on once it exited: what it left running in another process group (a
 * `setsid` child, ssh's ControlPersist master) may hold its pipes open, which would keep it from ending.
 */
const EXIT_GRACE_MS = 500;

/**
 * Names at the top of a working directory that a program run there may read its settings (or code:
 * npm's scripts) from, which agents can write: package managers', dotenv files, version managers',
 * git's and the cloud CLIs' folders.
 */
const CONFIG_NAMES =
  /^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|\.?bunfig\.toml|package\.json|\.env(?:\..+)?|\.envrc|\.netrc|\.pypirc|pip\.conf|pyproject\.toml|setup\.cfg|\.python-version|\.node-version|\.nvmrc|\.ruby-version|\.tool-versions|\.?mise\.toml|\.gitconfig|Gemfile|\.bundle|\.cargo|\.config|\.ssh|\.docker|\.aws|\.kube|\.firebaserc|firebase\.json|\.gcloudignore|\.terraformrc|node_modules|\.venv|venv|[Mm]akefile|GNUmakefile|[Jj]ustfile|\.justfile|Rakefile|Taskfile\.ya?ml|deno\.jsonc?|Cargo\.toml|go\.mod)$/i;

/** The most files the card lists (and Start compares with what it listed). */
const CONFIG_FILES_MAX = 100;

/** The hooks in a folder git runs them from: its files but git's own `*.sample` ones. */
function hooksIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.endsWith('.sample') && !lstatSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

/** `core.hooksPath` as a repository's `.git/config` sets it, if it does (its `[core]` section only; fixed commands' pins read it too). */
export function hooksPathOf(config: string): string | undefined {
  let core = false;
  let found: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (section) {
      core = section[1]!.toLowerCase() === 'core';
      continue;
    }
    const m = core ? /^hookspath\s*=\s*(.*)$/i.exec(line) : null;
    if (m)
      found =
        m[1]!
          .replace(/\s+[#;].*$/, '')
          .replace(/^"(.*)"$/, '$1')
          .trim() || undefined;
  }
  return found;
}

/**
 * The configuration files in a working directory a program run there may load, sorted: `CONFIG_NAMES`,
 * the repository's `.git/config`, and the hooks git runs with the user's rights (`git push`'s `pre-push`):
 * those in `.git/hooks` but git's samples, and the folder `core.hooksPath` names instead (its hooks, when
 * it is in the working directory; else the setting itself).
 */
export function workdirConfigFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = names.filter((n) => CONFIG_NAMES.test(n));
  const config = join(dir, '.git', 'config');
  if (existsSync(config)) {
    found.push('.git/config');
    for (const hook of hooksIn(join(dir, '.git', 'hooks'))) found.push(`.git/hooks/${hook}`);
    let hooksPath: string | undefined;
    try {
      hooksPath = hooksPathOf(readFileSync(config, 'utf8'));
    } catch {
      hooksPath = undefined;
    }
    if (hooksPath) {
      const at = isAbsolute(hooksPath) ? hooksPath : join(dir, hooksPath);
      const rel = relative(dir, at);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !hooksPath.startsWith('~')) {
        const shown = rel.split(sep).join('/');
        const hooks = hooksIn(at);
        found.push(...(hooks.length ? hooks.map((h) => `${shown}/${h}`) : [`core.hooksPath = ${hooksPath}`]));
      } else found.push(`core.hooksPath = ${hooksPath}`);
    }
  }
  return [...new Set(found)].sort().slice(0, CONFIG_FILES_MAX);
}

/** What `workdirDigest()` reads at most: of one file, of all of them, and names (the programs a folder installs apart). */
const DIGEST_LIMITS = { file: 4 * 1024 * 1024, total: 64 * 1024 * 1024, entries: 5000, programs: 5000 };

/**
 * What the files `workdirConfigFiles()` listed hold now, in a few characters: each file's size and content,
 * and for a folder (`node_modules`, `.venv`, `venv`, `.cargo`…) the programs it installs (`.bin`, `bin`,
 * `Scripts`: each with what it leads to and, inside the folder, that file's content), then its names; a
 * link inside the working directory followed. Start in the working directory is refused when this changed
 * since the card listed them; `partial` when a limit stopped it, which refuses Start too (too much to tell).
 */
export function workdirDigest(dir: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  let total = 0;
  let entries = 0;
  let programs = 0;
  let partial = false;
  const real = (() => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  const insideDir = (p: string) => {
    const rel = relative(real, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const file = (abs: string) => {
    let fd: number | undefined;
    try {
      fd = openSync(abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const st = fstatSync(fd);
      if (!st.isFile()) return void hash.update('\0not a file');
      hash.update(`\0size ${st.size}`);
      if (st.size > DIGEST_LIMITS.file || total + st.size > DIGEST_LIMITS.total) {
        partial = true;
        return;
      }
      const buf = Buffer.alloc(st.size);
      const n = st.size ? readSync(fd, buf, 0, buf.length, 0) : 0;
      total += n;
      hash.update(buf.subarray(0, n));
    } catch {
      hash.update('\0unreadable');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  /** A link: what it leads to, and that file's content when it is inside the working directory. */
  const link = (at: string) => {
    hash.update(`->${readlinkSync(at)}`);
    let to: string | undefined;
    try {
      to = realpathSync(at);
    } catch {
      return void hash.update('\0dangling');
    }
    if (insideDir(to) && statSync(to).isFile()) file(to);
  };
  const folder = (abs: string, budget: 'entries' | 'programs', withFiles: boolean) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return void hash.update('\0unreadable');
    }
    for (const name of names) {
      if (budget === 'entries' ? ++entries > DIGEST_LIMITS.entries : ++programs > DIGEST_LIMITS.programs) {
        partial = true;
        return;
      }
      const at = join(abs, name);
      hash.update(`\0${name}`);
      try {
        const st = lstatSync(at);
        if (st.isSymbolicLink()) link(at);
        else if (withFiles && st.isFile()) file(at);
      } catch {
        hash.update('\0gone');
      }
    }
  };
  for (const f of files) {
    hash.update(`\0\0${f}`);
    if (f.startsWith('core.hooksPath')) continue;
    const abs = join(dir, f);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      hash.update('\0gone');
      continue;
    }
    if (st.isSymbolicLink()) link(abs);
    else if (st.isFile()) file(abs);
    else if (st.isDirectory()) {
      // The programs it installs first, each read, with their own budget: what a command run there starts.
      for (const bin of ['.bin', 'bin', 'Scripts']) if (existsSync(join(abs, bin))) folder(join(abs, bin), 'programs', true);
      folder(abs, 'entries', false);
    }
  }
  const digest = hash.digest('hex').slice(0, 32);
  return partial ? `partial:${digest}` : digest;
}

/** Where its password helper is, for its environment. */
interface HelperFiles {
  node: string;
  script: string;
  program: string;
  socket: string;
  token: string;
}

/**
 * The environment an interactive command runs with: `checkEnv()`'s (the server's PATH, home, user,
 * shell and locale, nothing else; plain output) without its `CI=1`, Python's output unbuffered so its
 * prompts show at once, and the password helper for sudo, ssh and git when it has one.
 */
export function interactiveEnv(base: NodeJS.ProcessEnv, command: string, helper?: HelperFiles): NodeJS.ProcessEnv {
  const env = checkEnv(base, command);
  delete env.CI;
  env.PYTHONUNBUFFERED = '1';
  if (helper) {
    Object.assign(env, {
      [ASKPASS_ENV.node]: helper.node,
      [ASKPASS_ENV.program]: helper.program,
      [ASKPASS_ENV.socket]: helper.socket,
      [ASKPASS_ENV.token]: helper.token,
      SUDO_ASKPASS: helper.script,
      SSH_ASKPASS: helper.script,
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_ASKPASS: helper.script,
    });
  }
  return env;
}

/**
 * A program's output as a terminal leaves it, for the card: ANSI escapes out, of a line rewritten after
 * carriage returns (a progress bar) its last version only, other control characters out.
 */
export function terminalText(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i]!;
      return '';
    })
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** The end of `text`, at most `max` characters, from the start of a line where one is near. */
function keepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.length - max;
  const nl = text.indexOf('\n', cut);
  if (nl >= 0 && nl - cut < 1000) cut = nl + 1;
  return `…\n${text.slice(cut)}`;
}

/** What a session needs (swapped in tests). */
export interface InteractiveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: typeof spawnInteractive;
  /** Where each session's own folder goes: Harness Relay's temporary folder. */
  tmpDir: () => string;
  /** The password helper's grant (the gateway's), or why there is none. */
  askpass: (ask: AskpassHandler) => AskpassGrant | 'no-node' | 'off';
  timeoutMs: number;
}

export const defaultInteractiveDeps: InteractiveDeps = {
  platform: process.platform,
  env: process.env,
  spawn: spawnInteractive,
  tmpDir: () => relayTmpDir(),
  askpass: () => 'off',
  timeoutMs: INTERACTIVE_LIMITS.timeoutMin * 60_000,
};

/** What a session is given. */
export interface InteractiveStart {
  run: string;
  /** The working directory, when the user chose to run it there; else it runs in an empty folder of its own. */
  workdir?: string;
  /** Values to replace by dots wherever they show (the folder's secrets). */
  masks: readonly string[];
  /** Something on its card changed: its output (`urgent` false), or its state or a question (`urgent`). */
  onChange: (urgent: boolean) => void;
  /** It ended, its folder gone: the card's last change. */
  onEnd: () => void;
}

/** Messages a session's failures say, in the request's language (passed in, so this module has no strings of its own). */
export interface InteractiveWords {
  windows: string;
  notStarted: (why: string) => string;
}

/** One interactive command's run from its card (`InteractiveSession` is what the card shows of it). */
export class InteractiveRun {
  readonly startedAt = Date.now();
  private child?: ChildProcess;
  private raw = '';
  private masks: string[];
  private state: InteractiveSession['state'] = 'running';
  private exitCode?: number | null;
  private reason?: string;
  private endedAt?: number;
  private readonly endsAt: number;
  private timer?: NodeJS.Timeout;
  private asking?: { id: string; prompt: string; resolve: (line: string | undefined) => void };
  private grant?: AskpassGrant;
  private helper: InteractiveSession['helper'] = 'off';
  private dir?: string;
  private finished = false;

  constructor(
    private o: InteractiveStart,
    private words: InteractiveWords,
    private deps: InteractiveDeps = defaultInteractiveDeps,
  ) {
    this.masks = [...o.masks];
    this.endsAt = this.startedAt + deps.timeoutMs;
  }

  get running(): boolean {
    return this.state === 'running';
  }

  /** Starts it (its card then follows it); a start that fails ends it at once, saying why. */
  start(): void {
    if (this.deps.platform === 'win32') return this.fail(this.words.windows);
    try {
      this.dir = mkdtempSync(join(this.deps.tmpDir(), RUN_TMP_PREFIXES.interactive));
      chmodSync(this.dir, 0o700);
      const work = join(this.dir, 'work');
      mkdirSync(work, { mode: 0o700 });
      const env = interactiveEnv(this.deps.env, this.o.run, this.helperFiles());
      const child = this.deps.spawn('/bin/sh', ['-c', SCRIPT], env, { cwd: this.o.workdir ?? work });
      this.child = child;
      const onData = (chunk: Buffer) => this.add(chunk.toString('utf8'));
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.stdin?.on('error', () => {});
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (this.state === 'running') {
          this.state = 'failed';
          this.reason = err.code === 'ENOENT' ? new CommandNotFoundError('/bin/sh').message : err.message;
          this.endedAt = Date.now();
        }
        this.finish();
      });
      child.on('exit', (code) => {
        if (this.state === 'running') {
          this.state = 'exited';
          this.exitCode = code;
          this.endedAt = Date.now();
          this.endAsking();
          this.o.onChange(true);
        }
        // What it started and left running goes too, so its output ends and the card can close; and
        // its pipes close a moment later, whatever still holds them (one that left its process group).
        this.kill();
        setTimeout(() => {
          if (this.finished) return;
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
          this.finish();
        }, EXIT_GRACE_MS).unref?.();
      });
      child.on('close', () => this.finish());
      this.timer = setTimeout(() => this.stop('timedOut'), this.deps.timeoutMs);
      this.timer.unref?.();
    } catch (err) {
      this.fail(this.words.notStarted((err as Error).message));
    }
  }

  /** Its password helper, when the gateway can give one: its token, script and program written in the session's folder. */
  private helperFiles(): HelperFiles | undefined {
    const grant = this.deps.askpass((prompt) => this.ask(prompt));
    if (grant === 'no-node' || grant === 'off') {
      this.helper = grant;
      return undefined;
    }
    this.grant = grant;
    const dir = this.dir!;
    const files = {
      node: grant.node,
      script: join(dir, 'askpass'),
      program: join(dir, 'askpass.mjs'),
      socket: grant.socketPath,
      token: join(dir, 'askpass.token'),
    };
    writeFileSync(files.token, grant.token, { mode: 0o600 });
    writeFileSync(files.program, ASKPASS_SHIM_SOURCE, { mode: 0o600 });
    writeFileSync(files.script, ASKPASS_SCRIPT, { mode: 0o700 });
    chmodSync(files.script, 0o700);
    this.helper = 'on';
    return files;
  }

  /** It could not start: the card says why. */
  private fail(reason: string): void {
    this.state = 'failed';
    this.reason = reason;
    this.endedAt = Date.now();
    this.finish();
  }

  private add(text: string): void {
    this.raw += text;
    if (this.raw.length > RAW_MAX) {
      // From the start of a line, so that no value is cut in two (and then not masked).
      const from = this.raw.length - RAW_MAX;
      const nl = this.raw.indexOf('\n', from);
      this.raw = this.raw.slice(nl >= 0 ? nl + 1 : from);
    }
    this.o.onChange(false);
  }

  /** A line break before what comes next, unless the output ends with one. */
  private newline(): string {
    return this.raw && !this.raw.endsWith('\n') ? '\n' : '';
  }

  /**
   * The user typed a line into it: sent as it is, with a line break. Shown on the card as a terminal
   * echoes it, unless `hidden`: then it is masked wherever it shows (should the program print it).
   * False when it does not run any more.
   */
  write(text: string, hidden: boolean): boolean {
    const stdin = this.child?.stdin;
    if (this.state !== 'running' || !stdin?.writable) return false;
    if (hidden) this.addMasks([text, text.trim()]);
    stdin.write(`${text}\n`);
    this.add(hidden ? this.newline() : `${text}\n`);
    return true;
  }

  /** Its password helper asks: the card asks the user for one hidden line (one question at a time). */
  private ask(prompt: string): Promise<string | undefined> {
    if (this.state !== 'running' || this.asking) return Promise.resolve(undefined);
    const shown = terminalText(prompt).replace(/\s+/g, ' ').trim().slice(0, INTERACTIVE_LIMITS.prompt);
    return new Promise((resolve) => {
      this.asking = { id: randomUUID(), prompt: shown, resolve };
      // The transcript shows the question, as a terminal would.
      this.raw += `${this.newline()}${shown}\n`;
      this.o.onChange(true);
    });
  }

  /** The user's answer to its helper's question (`line`), or their refusal (undefined). False when it is not the question asked. */
  answer(askId: string, line: string | undefined): boolean {
    const asking = this.asking;
    if (!asking || asking.id !== askId || this.state !== 'running') return false;
    this.asking = undefined;
    if (line !== undefined) this.addMasks([line, line.trim()]);
    asking.resolve(line);
    this.o.onChange(true);
    return true;
  }

  private endAsking(): void {
    const asking = this.asking;
    this.asking = undefined;
    asking?.resolve(undefined);
  }

  /** More values to mask (a secret saved for the folder meanwhile). */
  addMasks(values: readonly string[]): void {
    for (const v of values) if (v && !this.masks.includes(v)) this.masks.push(v);
  }

  /** Stops it: the user's Cancel, its time limit, the server stopping or its conversation going. */
  stop(why: 'cancelled' | 'timedOut' | 'stopped'): void {
    if (this.state !== 'running') return;
    this.state = why;
    this.endedAt = Date.now();
    this.endAsking();
    this.o.onChange(true);
    this.kill();
  }

  /** Its process group: SIGTERM, then SIGKILL to what is left. */
  private kill(): void {
    const child = this.child;
    if (!child) return;
    killTree(child, 'SIGTERM');
    setTimeout(() => killTree(child, 'SIGKILL'), 2000).unref?.();
  }

  /** Its output is over: its folder (the helper's token in it) goes, and its card's last change. */
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.endAsking();
    this.grant?.revoke();
    if (this.dir) removeTree(this.dir);
    this.o.onEnd();
  }

  view(): InteractiveSession {
    const output = keepEnd(maskValues(terminalText(this.raw), this.masks), INTERACTIVE_LIMITS.output);
    const { urls, codes } = linksAndCodes(output);
    return {
      state: this.state,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      inWorkdir: Boolean(this.o.workdir),
      output,
      urls,
      codes,
      ...(this.asking ? { asking: { id: this.asking.id, prompt: maskValues(this.asking.prompt, this.masks) } } : {}),
      helper: this.helper,
      ...(this.reason ? { reason: maskValues(this.reason, this.masks) } : {}),
    };
  }
}
