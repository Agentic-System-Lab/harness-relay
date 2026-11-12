import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { OPEN_PROVIDERS, PROVIDER_LABEL, type ModelOption, type NativeItemsOff, type NativePart, type OpenProvider } from '../../shared/types';
import { API_BACKEND_ENV, INHERITED_BACKEND_VARS, backendRun, type BackendRun } from '../backends';
import { clearUserFlags, removeTree } from '../fsRemove';
import { t } from '../i18n';
import type { NativeProbe } from '../native';
import { patternPath, protectedReads, realPath } from '../protect';
import { CommandNotFoundError } from '../process';
import { makeRunDirs, relaySandboxHostRoot, relaySandboxRoot, removeRunDirs, sandboxAvailable, sandboxCommand, type RelaySandboxRunDirs, type RelaySandboxSpec } from '../relaySandbox';
import { DATA_DIR, OPEN_AGENT_HOME_ENV, OPEN_AGENT_ROOTS_ENV } from '../settings';
import { AgentRunError, stateKeys, type AgentRunner, type RunOptions, type RunResult } from './types';

/*
 * What the five open agents (OpenCode, Goose, Cline, OpenHands, Pi) share around their CLI's process,
 * whatever protocol it speaks (the generic ACP turn in `acpTurn.ts`, Pi's JSONL RPC in `pi.ts`):
 * - the model backend of the run (`backendRun()`: `<backend>/<model>`, the keys, the hosts);
 * - the CLI's home, always one of Harness Relay's own (`OPEN_AGENT_HOME_ENV`), with the folders the CLI
 *   writes (`statePaths`) apart from those that decide what it does when it starts (`configPaths`),
 *   which Harness Relay writes before each run (`prepare`) and the relay sandbox keeps read-only;
 * - the state of one conversation member (or of the lead agent's or the group sorter's runs for one
 *   conversation) in a folder of its own, `<home>/private/<key>` (`RunOptions.stateKey`): everything
 *   a run may write, sessions and caches that load code included, is there, and no run of another key
 *   can read or write it, so nothing one conversation's agent writes reaches another conversation's or
 *   another member's run. A member whose last run had a lower permission starts with it emptied
 *   (`freshState`, decided by the orchestrator from the permission it records);
 * - a temp folder of each run's own (`TMPDIR`), where the adapter puts or turns off the caches that load
 *   code (jiti, Node's compile cache, Bun's cache, Python bytecode), so no run can plant code for another;
 * - below full access, the relay sandbox around the process and everything it starts, failing closed.
 * See docs/open-agents.md.
 */

/**
 * Where each run's own temp folder is made: in Harness Relay's data folder, which no sandbox may write
 * (only the run it belongs to gets its folder as writable), not in the system's temporary folder, which
 * every sandbox lets its commands write in.
 */
export const RUN_TMP_DIR = join(DATA_DIR, 'run-tmp');

/** The folder under an open agent's home that holds each state key's own folder. */
export const PRIVATE_DIR = 'private';

/** The state folder of the CLI's starts outside a run (status, models, native), which no run can read or write. */
export const PROBE_STATE = 'probe';

/** Where an open agent's CLI keeps its files, under its home. */
export interface OpenHomeLayout {
  /** Variables that point the CLI into its home (XDG folders, its own home variable…). */
  env: Record<string, string>;
  /**
   * Where the CLI writes sessions, logs and caches: writable under the relay sandbox, and only inside
   * the run's state folder (`state` of `home()`) or its temp folder: a run below full access does not
   * start otherwise.
   */
  statePaths: string[];
  /**
   * Every file or folder that changes what the CLI does when it starts (config, plugins, extensions,
   * custom providers, hooks, skills, instruction files, MCP config, permission files): written by
   * `prepare` before each run, read-only inside the relay sandbox, so an agent cannot widen its own
   * next run. A single file may be listed inside a writable folder (deny single files when the CLI
   * writes next to them, as Pi writes `auth.json.lock` beside `auth.json`).
   */
  configPaths: string[];
}

export interface OpenAgentHome extends OpenHomeLayout {
  /** The home folder itself (`OPEN_AGENT_HOME_ENV`): shared by the runs, never writable by a sandboxed one. */
  root: string;
  /** The run's state folder: its state key's own (`<root>/private/<key>`), where everything it may write goes. */
  state: string;
}

/** One run as the adapter's hooks see it. */
export interface OpenRunContext {
  o: RunOptions;
  /** The run's model backend: its model, keys, endpoint and hosts. */
  run: BackendRun;
  home: OpenAgentHome;
  /**
   * The CLI's environment: the server's (`RunOptions.env`), the configured backends' keys, the home's
   * variables and, inside the relay sandbox, `proxyEnv`. `prepare` may add to it (an endpoint's key
   * under the variable its config names, say); keys never go into config files.
   */
  env: NodeJS.ProcessEnv;
  /** Below full access the process runs in the relay sandbox. */
  sandboxed: boolean;
  /** The system it runs on (default: this one's). On Windows it runs only with full access. */
  platform?: NodeJS.Platform;
  /**
   * This run's own temp folder (`TMPDIR`, `TMP` and `TEMP` in `env`), writable inside the sandbox and
   * removed after the run: `prepare` relocates or turns off the CLI's code-loading caches here.
   */
  tmpDir: string;
  /** What the adapter's hooks keep about this run (each run has its own: hooks are shared by parallel runs). */
  state: Record<string, unknown>;
}

/** What every open agent's adapter declares about its CLI's process. */
export interface OpenAgentProcess {
  provider: OpenProvider;
  /**
   * False until the adapter is done and checked against the real CLI: until then every run fails at
   * once with "not implemented yet" (`notImplemented()`), before anything starts.
   */
  implemented: boolean;
  /**
   * The CLI's layout: config and other shared parts under its home folder `root` (written by Harness
   * Relay, read-only for the runs), sessions, logs and caches under `state`, the run's own state
   * folder (outside a run: a folder only Harness Relay's own starts of the CLI use).
   */
  home(root: string, state: string): OpenHomeLayout;
  /**
   * Set only for a CLI that needs every configured API backend's key in its environment, not only the
   * run's own (`BackendRun.env`), with the reason why: the agent's commands inherit them all.
   */
  allBackendKeys?: string;
  /**
   * Variables the CLI needs to send its requests through the relay sandbox's proxy, which srt sets
   * (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`): `NODE_USE_ENV_PROXY=1` for Node 22's `fetch`, say.
   * Only inside the sandbox.
   */
  proxyEnv?: Record<string, string>;
  /**
   * Variables set to an empty string for every run, so that nothing else sets them (a CLI that loads a
   * project's `.env` takes only the variables not set already): base URLs, tracing endpoints…
   */
  emptyEnv?: string[];
  /** The model when the agent has none: undefined = the run fails and says to pick one. */
  defaultModel?(o: RunOptions): string | undefined;
  /** Writes the CLI's config in its home before the process starts: provider, model, permissions, briefing… */
  prepare?(ctx: OpenRunContext): void | Promise<void>;
  /**
   * Why the CLI cannot run in the relay sandbox on this platform, in the user's language, or undefined
   * when it can: such a run is refused before anything starts (OpenCode on Linux).
   */
  sandboxUnsupported?(platform: NodeJS.Platform): string | undefined;
  /**
   * What the CLI needs from the relay sandbox beyond the defaults, each a narrow opt-in that
   * docs/sandboxing.md describes ("Harness Relay's own sandbox"): its own loopback ports, a
   * pseudo-terminal, Unix sockets in the run's temp folder, macOS's certificate-trust daemon, hosts
   * refused without asking. Called after `prepare`, below full access only.
   */
  sandbox?(ctx: OpenRunContext): OpenSandboxNeeds;
  /**
   * Once the CLI's process is gone, before the run's temp folder is removed: stops what the CLI left
   * running by itself outside its process group (OpenHands' tmux server). A failure is logged, not thrown.
   */
  cleanup?(ctx: OpenRunContext): void | Promise<void>;
}

/** The per-adapter opt-ins of the relay sandbox (see `RelaySandboxSpec`). */
export type OpenSandboxNeeds = Pick<RelaySandboxSpec, 'quietlyDeniedHosts' | 'localPorts' | 'connectPorts' | 'allowPty' | 'allowUnixSocketsInTmp' | 'allowTlsTrustd'>;

/** The CLI's own model catalog, its ids as `<backend>/<model>` (models.ts keeps those of configured backends). */
export interface OpenCatalog {
  models: ModelOption[];
  /** Effort levels; undefined = `OpenAgentDefinition.efforts`. */
  efforts?: string[];
  defaultModel?: string;
  defaultEffort?: string;
  error?: string;
}

/** An open agent as the rest of the server knows it: its runner and what Settings asks of it. */
export interface OpenAgentDefinition {
  provider: OpenProvider;
  /** Its process (home, config, sandbox): also used to ask the CLI outside a run. */
  process: OpenAgentProcess;
  runner: AgentRunner;
  /** Effort levels the model picker offers (empty: none, the CLI has no setting). */
  efforts: string[];
  /**
   * The CLI's own catalog of models, when it has one. `env` already points the CLI into its home
   * (`openHomeEnv`). models.ts keeps the models of configured backends and adds each endpoint's.
   */
  models?(bin: string, env: NodeJS.ProcessEnv): Promise<OpenCatalog>;
  /**
   * What the CLI loads by itself for a folder (Settings → its card), asked without a prompt; `env`
   * already points the CLI into its home. native.ts fills in what is left out of the runs (`off`,
   * `items`: the parts and single items Harness Relay's runs leave out, for an adapter that marks
   * what its runs then leave out, `leftOut`, with `asRun`).
   */
  native?(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs?: number, off?: readonly NativePart[], items?: NativeItemsOff): Promise<NativeProbe>;
}

/** The AgentRunError of an open agent whose adapter is not done yet. */
export function notImplemented(provider: OpenProvider): AgentRunError {
  return new AgentRunError(t().openNotImplemented(PROVIDER_LABEL[provider]));
}

/** A runner that refuses every run: for an adapter that is not done yet. */
export function notImplementedRunner(provider: OpenProvider): AgentRunner {
  return {
    provider,
    async run(): Promise<RunResult> {
      throw notImplemented(provider);
    },
  };
}

/**
 * An open agent's home folder, from its environment (`OPEN_AGENT_HOME_ENV`, set by `SettingsStore.env`),
 * created owner-only when missing. For the models and native hooks too, before they start the CLI.
 */
export function openAgentHome(env: NodeJS.ProcessEnv): string {
  const root = env[OPEN_AGENT_HOME_ENV];
  if (!root) throw new AgentRunError(t().openNoHome);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** The environment an open agent's CLI is asked with outside a run (status, models, native): its home's variables. */
export function openHomeEnv(agent: Pick<OpenAgentProcess, 'home'>, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = openAgentHome(env);
  const state = join(root, PRIVATE_DIR, PROBE_STATE);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { ...env, ...agent.home(root, state).env };
}

/**
 * A state key's folder name: the key itself when it is a plain name (the orchestrator's keys are), else
 * a hash of it, so no key can name a folder outside `private/` or another key's.
 */
export function stateFolderName(key: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(key) ? key : `key-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** A state key's folder in an open agent's home `home`. */
export function stateFolder(home: string, key: string): string {
  return join(home, PRIVATE_DIR, stateFolderName(key));
}

/** How a state folder set aside to be removed is named in `private/` (never a key's: those start alnum). */
const SET_ASIDE = '.gone-';

/** How a state key's sealed folder is named in `private/` (never a key's either). */
const SEALED = '.sealed-';

/**
 * A state key's sealed folder in an open agent's home: what the server keeps about the key's state
 * for its later runs (Goose's extension list as a session started), beside the state folder. No run
 * may read or write it (it is in a private root, outside every run's own folders), so a command
 * cannot change what the next run is given back. Emptied with the state folder.
 */
export function sealedFolder(home: string, key: string): string {
  return join(home, PRIVATE_DIR, `${SEALED}${stateFolderName(key)}`);
}

/**
 * Empties a folder in an open agent's `private/` folder so that the next run starts with a new, empty
 * one: it is renamed aside first (which needs only `private/` to be writable, not anything a run may
 * have changed in it), then removed best-effort (`removeTree`, without changing permissions); what a run
 * locked (`chmod 000`) stays aside until the next start (`clearOpenRunLeftovers`). Throws only when it
 * cannot be renamed.
 */
function emptyPrivateFolder(dir: string): void {
  try {
    lstatSync(dir);
  } catch {
    return; // nothing there
  }
  const aside = join(dirname(dir), `${SET_ASIDE}${randomBytes(8).toString('hex')}`);
  try {
    renameSync(dir, aside);
  } catch (err) {
    // A run may have made its folder immutable (chflags uchg): clear that flag on it, and try again.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    clearUserFlags(dir);
    renameSync(dir, aside);
  }
  removeTree(aside);
}

/**
 * Empties a state key's folder in an open agent's home, before a run with more permission than the
 * one that last wrote it (the orchestrator does it before the run starts, and keeps a flag in its
 * database until it is done). Throws when it cannot.
 */
export function emptyStateFolder(home: string, key: string): void {
  emptyPrivateFolder(stateFolder(home, key));
  // Only the server writes it, so nothing in it can keep it from going.
  rmSync(sealedFolder(home, key), { recursive: true, force: true });
}

/**
 * Starts a run's state over while `prepare` runs, before the CLI starts, when what an earlier run's
 * commands could have left in it could not be taken out (`err`: OpenCode's or Goose's database could
 * not be checked or cleared). The state folder is emptied and made again, and its key's sealed folder
 * goes with it. A run that would resume a session then fails with `err`, so that the orchestrator
 * starts a fresh session with the whole history (as after any failed resume); any other run goes on in
 * the empty folder. Throws as well when the folder cannot be emptied.
 */
export function startStateOver(ctx: Pick<OpenRunContext, 'o' | 'home'>, err: Error): void {
  console.warn(`[open] ${ctx.home.state} starts over, empty:`, err.message);
  emptyPrivateFolder(ctx.home.state);
  if (ctx.o.stateKey) rmSync(sealedFolder(ctx.home.root, ctx.o.stateKey), { recursive: true, force: true });
  mkdirSync(ctx.home.state, { recursive: true, mode: 0o700 });
  if (ctx.o.sessionId) throw err instanceof AgentRunError ? err : new AgentRunError(err.message);
}

/**
 * Removes what every open agent kept for a deleted conversation: each member's state folder (`agentIds`)
 * and the lead agent's and the group sorter's (`homes`: each open agent's home). A failure is logged.
 */
export function removeConversationState(homes: readonly string[], conversationId: string, agentIds: readonly string[]): void {
  const keys = [
    ...agentIds.map((a) => stateKeys.member(conversationId, a)),
    stateKeys.lead(conversationId),
    stateKeys.revise(conversationId),
    stateKeys.sort(conversationId),
  ];
  for (const home of homes) {
    for (const key of keys) {
      try {
        emptyStateFolder(home, key);
      } catch (err) {
        console.warn(`[open] could not remove ${stateFolder(home, key)}:`, (err as Error).message);
      }
    }
  }
}

/**
 * What runs of a server that stopped during them left behind (call at start, before any run): every
 * folder in `RUN_TMP_DIR`, and the state folders of runs without a key (`private/run-*`) and those set
 * aside to be removed (`private/.gone-*`) in each open agent's home. `restore`: only once the sweeps
 * of leftover processes found nothing left (`clearRelaySandboxLeftovers`), owner permissions are given
 * back so that what a run locked goes too; else what is locked stays until a later start.
 */
export function clearOpenRunLeftovers(homes: readonly string[], runTmp = RUN_TMP_DIR, { restore = true }: { restore?: boolean } = {}): void {
  const clear = (dir: string, keep: (name: string) => boolean) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) if (!keep(name)) removeTree(join(dir, name), { restore });
  };
  clear(runTmp, () => false);
  for (const home of homes) clear(join(home, PRIVATE_DIR), (name) => !name.startsWith('run-') && !name.startsWith(SET_ASIDE));
}

/** Whether `path` is `dir` or inside it (real paths). */
function inside(path: string, dir: string): boolean {
  const rel = relative(realPath(dir), realPath(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The folders whose content belongs to other runs, which a sandboxed run may not read (only its own
 * parts of them, which it may write): every open agent's `private/` folder (the folder of each
 * conversation member's state) beside this home, made when missing (the sandbox may refuse a path that
 * does not exist), those in the folders the homes were in before (`before`, from `OPEN_AGENT_ROOTS_ENV`:
 * what runs kept there is no other run's to read either; left out while they do not exist), and the
 * folders of each run's temp folders in Harness Relay's data folder (the run's own, its sandbox host's,
 * and a full-access run's), which the server makes when it starts (`dataDirs`; left out while they do
 * not exist).
 */
export function privateRoots(
  root: string,
  dataDirs: string[] = [relaySandboxRoot(), relaySandboxHostRoot(), RUN_TMP_DIR],
  before: readonly string[] = [],
): string[] {
  const homes = [...new Set([join(root, PRIVATE_DIR), ...OPEN_PROVIDERS.map((p) => join(dirname(root), p, PRIVATE_DIR))])];
  for (const dir of homes) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const earlier = before.flatMap((r) => OPEN_PROVIDERS.map((p) => join(r, p, PRIVATE_DIR))).filter((dir) => !homes.includes(dir) && existsSync(dir));
  return [...new Set([...homes, ...earlier, ...dataDirs.filter((dir) => existsSync(dir))])];
}

/** The folders an open agent's homes were in before, from its run's environment (`OPEN_AGENT_ROOTS_ENV`). */
export function openAgentRootsBefore(env: NodeJS.ProcessEnv): string[] {
  try {
    const roots: unknown = JSON.parse(env[OPEN_AGENT_ROOTS_ENV] ?? '[]');
    return Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string' && isAbsolute(r)) : [];
  } catch {
    return [];
  }
}

/** What `startOpenProcess` needs from the relay sandbox (swapped in tests). */
export interface OpenProcessDeps {
  sandboxAvailable: typeof sandboxAvailable;
  sandboxCommand: typeof sandboxCommand;
  /** Makes a sandboxed run's folders (its temp folder is the run's `tmpDir`). */
  makeRunDirs: () => RelaySandboxRunDirs;
  platform: NodeJS.Platform;
  /** Where each run's temp folder is made (default `RUN_TMP_DIR`). */
  runTmpDir?: string;
  /** The folders other runs' data is in (default `privateRoots()` of the home and the folders it was in before). */
  privateRoots?: (root: string, before: string[]) => string[];
}

export const defaultOpenDeps: OpenProcessDeps = { sandboxAvailable, sandboxCommand, makeRunDirs: () => makeRunDirs(), platform: process.platform };

/** An open agent's process, ready to spawn through `runProcess` (wrapped in the relay sandbox below full access). */
export interface OpenProcess {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  ctx: OpenRunContext;
  /**
   * Why the relay sandbox stopped the run, in the user's language, once the process has ended without
   * the agent's answer; undefined when the sandbox was not the reason (or there was none).
   */
  failure(): string | undefined;
  /** Ends what the sandbox started for the run (its proxy) and removes the run's temp folder; call once the process is gone. */
  dispose(): Promise<void>;
}

/**
 * Gets an open agent's process ready for one run: refuses an adapter that is not done, reads the run's
 * backend and model, checks the relay sandbox below full access (failing closed, and on native Windows
 * refusing), creates the home, the run's state folder (emptied first with `freshState`) and its own temp
 * folder, lets the adapter write its config (`prepare`), builds the arguments (`args`) and, below full
 * access, wraps it all in the relay sandbox: writes only to the agent's `statePaths` (inside the state
 * folder) and the run's temp folder (and in edit mode the working directory and the attachments
 * folder), its `configPaths` read-only, the protected paths neither readable nor writable, other runs'
 * state and temp folders not readable (`privateRoots`), and only the run's backend reachable. The
 * environment holds only the run's own backend's key: the server's are taken out.
 */
export async function startOpenProcess(
  agent: OpenAgentProcess,
  o: RunOptions,
  args: (ctx: OpenRunContext) => string[],
  deps: OpenProcessDeps = defaultOpenDeps,
): Promise<OpenProcess> {
  const cli = PROVIDER_LABEL[agent.provider];
  if (!agent.implemented) throw notImplemented(agent.provider);
  const run = backendRun(o.backends, o.model, cli, agent.defaultModel?.(o), Boolean(agent.allBackendKeys));
  const sandboxed = o.permission !== 'full';
  let protectedPaths: string[] = [];
  if (sandboxed) {
    if (deps.platform === 'win32') throw new AgentRunError(t().openNoWindowsSandbox(cli));
    const refused = agent.sandboxUnsupported?.(deps.platform);
    if (refused) throw new AgentRunError(refused);
    const available = await deps.sandboxAvailable();
    // The reason already says what failed and how to fix it, in the user's language: passed on as it is.
    if (!available.ok) throw new AgentRunError(available.reason);
    protectedPaths = o.protectedPaths ?? protectedReads();
    // A path the sandbox would read as a pattern would be left unprotected: the run does not start.
    const pattern = patternPath(protectedPaths);
    if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
  }
  const root = openAgentHome(o.env);
  // The state key's own folder; without a key, the run's own, removed after it.
  const keyed = Boolean(o.stateKey);
  const state = join(root, PRIVATE_DIR, keyed ? stateFolderName(o.stateKey!) : `run-${randomBytes(8).toString('hex')}`);
  if (o.freshState || !keyed) emptyPrivateFolder(state);
  if (o.freshState && keyed) rmSync(sealedFolder(root, o.stateKey!), { recursive: true, force: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const home: OpenAgentHome = { root, state, ...agent.home(root, state) };
  // Sandboxed, the run's temp folder is the sandbox's own (its TMPDIR, where Unix sockets may go), made
  // now so that `prepare` can relocate the CLI's caches into it.
  const dirs = sandboxed ? deps.makeRunDirs() : undefined;
  const tmpDir = dirs ? dirs.tmp : makeRunTmp(agent.provider, deps.runTmpDir);
  const removeTmp = () => {
    if (dirs) removeRunDirs(dirs);
    else removeTree(tmpDir);
    if (!keyed) removeTree(state);
  };
  // Only the run's own backend's key (`run.env`): none the server holds or inherited.
  const inherited = { ...o.env };
  for (const name of [...Object.values(API_BACKEND_ENV), ...INHERITED_BACKEND_VARS]) delete inherited[name];
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...run.env,
    ...home.env,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    ...(sandboxed ? agent.proxyEnv : {}),
    ...Object.fromEntries((agent.emptyEnv ?? []).map((name) => [name, ''])),
  };
  const ctx: OpenRunContext = { o, run, home, env, sandboxed, platform: deps.platform, tmpDir, state: {} };
  const cleanup = async () => {
    try {
      await agent.cleanup?.(ctx);
    } catch (err) {
      console.warn(`[${agent.provider}] could not clean up after the run:`, (err as Error).message);
    }
  };
  try {
    try {
      await agent.prepare?.(ctx);
    } catch (err) {
      if (err instanceof AgentRunError) throw err;
      throw new AgentRunError(t().openPrepareFailed(cli, (err as Error).message));
    }
    const argv = args(ctx);
    if (!sandboxed) {
      return {
        bin: o.bin,
        args: argv,
        env: ctx.env,
        ctx,
        failure: () => undefined,
        dispose: async () => {
          await cleanup();
          removeTmp();
        },
      };
    }
    // What a run may write is its own: a state path outside its state folder would be shared with others.
    const shared = home.statePaths.find((p) => !inside(p, state) && !inside(p, tmpDir));
    if (shared) throw new AgentRunError(t().openStateShared(cli, shared));
    const spec: RelaySandboxSpec = {
      permission: o.permission as RelaySandboxSpec['permission'],
      cwd: o.cwd,
      ...(o.addDirs?.length ? { extraCwds: [...o.addDirs] } : {}),
      writable: [...home.statePaths, tmpDir],
      privateRoots: deps.privateRoots ? deps.privateRoots(root, openAgentRootsBefore(o.env)) : privateRoots(root, undefined, openAgentRootsBefore(o.env)),
      readOnly: [...home.configPaths],
      protectedPaths,
      allowedHosts: [...run.hosts],
      ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
      ...(o.requestApproval ? { requestApproval: o.requestApproval } : {}),
      ...agent.sandbox?.(ctx),
      dirs: dirs!,
    };
    let wrapped: Awaited<ReturnType<OpenProcessDeps['sandboxCommand']>>;
    try {
      wrapped = await deps.sandboxCommand(o.bin, argv, ctx.env, spec);
    } catch (err) {
      // The sandbox's own refusals (and a missing program) are already complete: passed on once.
      if (err instanceof AgentRunError || err instanceof CommandNotFoundError) throw err;
      throw new AgentRunError(t().openSandboxUnavailable(cli, (err as Error).message.trim().replace(/[.。]+$/, '')));
    }
    return {
      bin: wrapped.bin,
      args: wrapped.args,
      env: wrapped.env,
      ctx,
      failure: () => wrapped.failure(),
      dispose: async () => {
        await cleanup();
        let disposed = false;
        try {
          // The sandbox removes the run's folders itself, but keeps its marker and temp folder while
          // anything of the run still holds on, for the next server start to find it: not removed here.
          await wrapped.dispose();
          disposed = true;
        } finally {
          if (!disposed) removeTmp();
          else if (!keyed) removeTree(state);
        }
      },
    };
  } catch (err) {
    await cleanup();
    removeTmp();
    throw err;
  }
}

/** A new temp folder for one run, owner-only, under `dir` (`RUN_TMP_DIR`). */
function makeRunTmp(provider: OpenProvider, dir = RUN_TMP_DIR): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${provider}-${randomBytes(6).toString('hex')}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}
