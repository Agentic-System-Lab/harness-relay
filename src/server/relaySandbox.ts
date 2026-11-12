import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { ApprovalAnswer } from '../shared/types';
import { AgentRunError, type ApprovalRequest } from './agents/types';
import { currentLang, t, withLang } from './i18n';
import { DEFAULT_PORT, DEV_API_PORT, DEV_WEB_PORT, apiPort } from './ports';
import { CONTROL_CHANNEL, CommandNotFoundError, type ControlChannel, runProcess, runSync, sleepSync } from './process';
import {
  RELAY_ROOT,
  agentFolders,
  commandPaths,
  patternPath,
  realPath,
  relayDatabaseFiles,
  relayFolderOverlap,
  relayFolderRefusal,
  relayTmpDir,
  voiceFolder,
} from './protect';
import { runAsync, sweepRunSandboxes, sweepRunSandboxesAsync } from './sandboxProcs';
import { clearUserFlags, removeTree } from './fsRemove';
import { DATA_DIR } from './settings';

/*
 * Harness Relay's own OS sandbox, for the agent CLIs that bring none (the open agents: OpenCode,
 * Goose, Cline, OpenHands, Pi), built on Anthropic's sandbox-runtime (`srt`: Seatbelt on macOS,
 * bubblewrap + seccomp on Linux, a filtering proxy for the network). See docs/sandboxing.md,
 * "Harness Relay's own sandbox".
 *
 * Each sandboxed run gets a host process of its own (`relaySandboxHost.ts`), started through
 * `process.ts` like any CLI, with a private control channel on its fd 3. The host runs one
 * `SandboxManager` for this run alone, so:
 * - its rules (the folders it may write, the hosts it may reach) belong to this run only: runs of
 *   other conversations at the same time have their own proxy, which this run's sandbox cannot
 *   reach (Seatbelt lets it connect to its own proxy's port only; on Linux it has no network but its
 *   own proxy's sockets), and which wants a token only that run's sandbox has;
 * - a host no rule decides is asked about over this run's channel, so the approval goes to this
 *   run's `requestApproval` and to no other. (One `SandboxManager` in the server for every run could
 *   not do that: its ask callback is told the host and port only, and the per-command lists it keys
 *   by a proxy user name are, as its README says, attribution and not a boundary: a sandboxed process
 *   presenting another run's id gets that run's hosts.)
 * - when the run ends, the server stops, or the channel closes, the host stops what the run left and
 *   closes the proxy, so nothing is left behind (on Linux bubblewrap and its PID namespace end with it).
 * The srt CLI would also give each run a proxy of its own, but it cannot ask about a host at all.
 *
 * Every rule is decided here (pure functions, tested offline); the host only applies them.
 */

/** What one sandboxed run may do (below full access; with full access there is no sandbox). */
export interface RelaySandboxSpec {
  permission: 'read-only' | 'edit';
  /** The working directory: read in both modes, written in edit mode only. */
  cwd: string;
  /**
   * The conversation's other working directories (in parallel mode, the agent's worktrees of them),
   * as `cwd`: read in both modes, written in edit mode only, each one's project agent config kept
   * read-only (`PROJECT_AGENT_CONFIG`).
   */
  extraCwds?: string[];
  /** Always writable: the agent's `statePaths` (sessions, logs, caches). */
  writable: string[];
  /** Never writable, also inside the folders above: the agent's `configPaths` (`denyWrite`). */
  readOnly: string[];
  /**
   * Neither readable nor writable (`denyRead` + `denyWrite`): `protectedReads()`. Harness Relay's
   * database and its own temporary folder are added in any case.
   */
  protectedPaths: string[];
  /** Hosts the run may reach without asking: "host" or "host:port" (the model backends it uses). */
  allowedHosts: string[];
  /**
   * Hosts refused without asking, with a reason the model sees, so a host the agent reaches every
   * start (Goose's models.dev catalogue) does not raise an approval card each turn. "host" or
   * "host:port". A denied host always wins over `allowedHosts`.
   */
  quietlyDeniedHosts?: string[];
  /** Asks the user about any other host (kind `fetch`); without it, other hosts are refused. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** The conversation's attachments folder: read in both modes, written in edit mode only. */
  attachmentsDir?: string;
  /**
   * Loopback ports the agent itself listens on and connects to (OpenCode's own HTTP server: pick one
   * with `freeLoopbackPort()` and pass it with `--port`). On macOS the sandbox may listen on these on
   * loopback and connect to them, directly or through the proxy, and to no other local port; on Linux
   * it has a loopback of its own, where any port works and none of this computer's is reachable. With a
   * model backend on loopback too, `NO_PROXY` lists these ports alone, so a client that honours a port
   * there (Node, Bun, httpx) reaches them directly while the backend goes through the proxy. Never one
   * of Harness Relay's, nor a loopback backend's port.
   */
  localPorts?: number[];
  /**
   * Loopback ports the agent only connects to, servers of the user's that it does not run itself
   * (Goose's HTTP MCP servers on this computer). They are reached through the proxy, whose allowlist
   * names each as `127.0.0.1`, `localhost` and `[::1]` at that port; the sandbox may not listen on them,
   * so a command cannot take over the port of one that is down. `NO_PROXY` then leaves loopback out
   * (except `localPorts`), as for a model backend on loopback. Never one of Harness Relay's ports.
   */
  connectPorts?: number[];
  /** The agent needs a pseudo-terminal (OpenHands runs commands in tmux). A per-adapter opt-in. */
  allowPty?: boolean;
  /**
   * On macOS, lets the run's own programs ask the certificate-trust daemon (`com.apple.trustd.agent`)
   * to verify a TLS certificate, which the Security framework needs and sandbox-runtime blocks by
   * default. A per-adapter opt-in for a CLI that verifies certificates that way (Goose, written in
   * Rust, through rustls-platform-verifier). This is the one mach service sandbox-runtime's own
   * `enableWeakerNetworkIsolation` opens; it is a possible way out of the sandbox, because trustd
   * fetches an OCSP or CRL for a certificate from the network itself, outside the proxy, so a program
   * could carry a little data out in what it asks trustd to check. Not needed on Linux, and ignored
   * there. Leave it off for a CLI whose TLS goes through the proxy already (Node, Bun, Python).
   */
  allowTlsTrustd?: boolean;
  /**
   * The agent creates Unix-domain sockets of its own (OpenHands' tmux server). A per-adapter opt-in.
   * Only sockets inside the run's own temporary folder are allowed, and only on macOS: there the
   * agent's `TMUX_TMPDIR` is that folder (the run's TMPDIR), so its socket lands there, fresh each run
   * and removed after. **On Linux sandbox-runtime cannot allow one socket path** (its seccomp filter
   * blocks every AF_UNIX socket unless all are allowed, which this sandbox never does), so the agent
   * must not need one there (its adapter falls back to a plain pseudo-terminal). Never a blanket allow.
   */
  allowUnixSocketsInTmp?: boolean;
  /**
   * The run's folders, made beforehand with `makeRunDirs()` by a caller that needs the temporary
   * folder before the command is wrapped (an adapter writes its config and relocates its caches there).
   * Absent: they are made here. Either way `dispose()` removes them.
   */
  dirs?: RelaySandboxRunDirs;
  /**
   * Folders that hold other runs' own data (each conversation member's state folder, each run's temp
   * folder): not readable (`denyRead`), except what of them this run may write (its own state and temp
   * folder), which stays readable (`allowRead`). Writing is an allow list already, so they are not
   * added to `denyWrite` (that would take the run's own folders too). Each must exist.
   */
  privateRoots?: string[];
}

/** A command that runs `bin args` in the run's sandbox. */
export interface RelaySandboxCommand {
  bin: string;
  args: string[];
  /** The host's environment; it also carries `channel` (spreading it keeps it). */
  env: NodeJS.ProcessEnv;
  /** Pass to `runProcess` (it also finds it on `env`). Without it the host refuses to start anything. */
  channel: ControlChannel;
  /** Why the sandbox could not start, in the user's language, once the process has ended; or undefined. */
  failure(): string | undefined;
  /** Removes the run's temporary folders and closes its channel. Call it once the process has ended. */
  dispose(): Promise<void>;
  /** The run on the server's side (what the host reported: its proxy's ports, its exit). */
  run: RelaySandboxRun;
}

export type SandboxAvailability = { ok: true } | { ok: false; reason: string };

/** What the rules depend on besides the spec (`relaySandboxContext()`; tests pass their own). */
export interface RelaySandboxContext {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  dataDir: string;
  relayRoot: string;
  /** Voice input's folder (`voiceFolder()` of the data folder when left out), which no run may write. */
  voiceDir?: string;
  /** Harness Relay's own ports (the API, and Vite's in development), never reachable from the sandbox. */
  relayPorts: number[];
  /** This computer's own addresses (its network interfaces). */
  localAddresses: string[];
  /** The programs sandbox-runtime runs outside the sandbox, by full path. */
  tools: RelaySandboxTools;
}

export interface RelaySandboxTools {
  /** The shell that starts the sandbox, and the one sandbox-runtime runs the command with in it. */
  sh: string;
  bash: string;
  /** Linux only. */
  bwrap?: string;
  socat?: string;
  rg?: string;
  /**
   * The Node that runs the host: this server's own (absent here), or, in the desktop app, whose runtime
   * may not be run as plain Node, a Node 22.12 or later found on PATH (`null` when there is none).
   */
  node?: string | null;
}

/** The folders of one run: the agent's temporary folder and the host's (sandbox-runtime's sockets). */
export interface RelaySandboxRunDirs {
  tmp: string;
  hostTmp: string;
  /**
   * A per-run marker file next to the run's folders (never inside a sandbox-writable one). Every
   * sandboxed process inherits a read-only descriptor to it, so a leftover that kept the descriptor
   * (a backgrounded command, a tmux server) is found by `lsof` even once it has left this host's
   * process group — on macOS, where a process can be re-parented away and its environment cannot be
   * read. The host sweeps it when the run ends; `clearRelaySandboxLeftovers` sweeps the whole folder
   * at startup, for a run whose server was killed before it could. On Linux the sandbox's PID
   * namespace ends the tree with bubblewrap, so nothing is left to sweep. `makeRunDirs` always sets
   * it; it is optional only so a caller that builds its own folders (a test) need not.
   */
  marker?: string;
}

/** Removes a run's folders and its marker (each that exists). Never throws. */
export function removeRunDirs(dirs: RelaySandboxRunDirs): void {
  for (const path of [dirs.tmp, dirs.hostTmp, dirs.marker]) {
    if (!path) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      console.error(`[relay-sandbox] could not remove ${path}:`, (err as Error).message);
    }
  }
}

/** Where each run's temporary folders go: in Harness Relay's data folder, which no sandbox may write. */
export function relaySandboxRoot(dataDir = DATA_DIR): string {
  return join(dataDir, 'relay-sandbox');
}

/**
 * Where each run's host keeps its temporary folder (sandbox-runtime's sockets, its CA bundle and the
 * like): in the data folder too, under a name as short as can be, since a Unix socket's path must fit
 * in 104 bytes on macOS and 108 on Linux.
 */
export function relaySandboxHostRoot(dataDir = DATA_DIR): string {
  return join(dataDir, 'srt');
}

/**
 * The longest a host's temporary folder may be, in bytes (UTF-8): what is left of a socket's path (103
 * bytes on macOS, 107 on Linux) after the longest name sandbox-runtime gives a socket in it (`/srt-mux-
 * <pid>-<n>.sock` on macOS; `/claude-socks-<16 hex>.sock` on Linux). Node on macOS cuts a socket path
 * that is too long instead of failing, so a socket would land elsewhere, outside the private root.
 */
export const HOST_TMP_MAX: Partial<Record<NodeJS.Platform, number>> = { darwin: 81, linux: 72 };

/** How many hex digits name a host's temporary folder. */
const HOST_ID_LENGTH = 6;

/**
 * Why runs cannot have their host's temporary folder in this data folder (its path leaves no room for
 * the sockets), in the user's language; undefined when they can.
 */
export function hostTmpRefusal(dataDir: string, platform: NodeJS.Platform): string | undefined {
  const max = HOST_TMP_MAX[platform];
  // Bytes, not characters: a path in Chinese takes three for each of its characters.
  if (max === undefined || Buffer.byteLength(join(relaySandboxHostRoot(dataDir), 'x'.repeat(HOST_ID_LENGTH))) <= max) return undefined;
  return t().relaySandboxPathTooLong(dataDir, max - HOST_ID_LENGTH - '/srt/'.length);
}

/**
 * The host: bundled beside the server in the desktop app (`relaySandboxHost.mjs`, desktop/scripts/build.ts),
 * else its source, run by Node's own type stripping (`--experimental-strip-types` where it is not on by default).
 */
const BUNDLED_HOST = fileURLToPath(new URL('./relaySandboxHost.mjs', import.meta.url));
export const RELAY_SANDBOX_HOST = existsSync(BUNDLED_HOST) ? BUNDLED_HOST : fileURLToPath(new URL('./relaySandboxHost.ts', import.meta.url));

/** sandbox-runtime's folder, wherever the host resolves it from (the checkout's node_modules, or the bundle's). */
function sandboxRuntimeDir(): string | undefined {
  try {
    const entry = createRequire(RELAY_SANDBOX_HOST).resolve('@anthropic-ai/sandbox-runtime');
    return dirname(dirname(entry)); // …/sandbox-runtime/dist/index.js
  } catch {
    return undefined;
  }
}

/** Programs that sandbox-runtime and the host start outside the sandbox: they are looked for here only. */
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** The port this server listens on, once it does (`noteListeningPort()`): with `PORT=0`, whichever was free. */
let listeningPort: number | undefined;

/** Notes the port the server got, which `relayPorts()` adds to the one its settings name. */
export function noteListeningPort(port: number): void {
  listeningPort = Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Harness Relay's own ports: this server's (`apiPort()`, and the one it got when that is 0: any free
 * one), 8787, and `npm run dev`'s API and Vite's (`ports.ts`).
 */
export function relayPorts(env: NodeJS.ProcessEnv = process.env, listening: number | undefined = listeningPort): number[] {
  const port = apiPort(env);
  return [...new Set([...(Number.isInteger(port) && port > 0 ? [port] : []), ...(listening ? [listening] : []), DEFAULT_PORT, DEV_API_PORT, DEV_WEB_PORT])];
}

/** This computer's own addresses, without the zone of a link-local one. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.push(a.address.replace(/%.*$/, '').toLowerCase());
  }
  return [...new Set(out)];
}

/** An executable file named `name` in these folders (absolute ones only), or undefined. */
export function findProgram(name: string, dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * The programs sandbox-runtime needs, as this server finds them: in the system's folders first, then
 * on the server's own PATH (the absolute folders on it). Never on the agent's PATH.
 */
export function relaySandboxTools(platform: NodeJS.Platform = process.platform, path = process.env.PATH ?? ''): RelaySandboxTools {
  const dirs = [...SYSTEM_PATH, ...path.split(delimiter).filter((d) => isAbsolute(d))];
  const find = (name: string) => findProgram(name, dirs);
  return {
    sh: find('sh') ?? '/bin/sh',
    bash: find('bash') ?? '/bin/bash',
    ...(platform === 'linux' ? { bwrap: find('bwrap'), socat: find('socat'), rg: find('rg') } : {}),
    ...(process.versions.electron ? { node: hostNodeOnPath(find) } : {}),
  };
}

/** sandbox-runtime's lowest Node (its `engines`). */
const HOST_NODE_MIN = [22, 12];
const nodeVersions = new Map<string, boolean>();

/** A Node on PATH new enough for sandbox-runtime, or null (the desktop app: its runtime is not plain Node). */
function hostNodeOnPath(find: (name: string) => string | undefined): string | null {
  const node = find('node');
  if (!node) return null;
  let ok = nodeVersions.get(node);
  if (ok === undefined) {
    const v = runSync(node, ['--version'], { timeoutMs: 5000 }).stdout?.trim().match(/^v(\d+)\.(\d+)/);
    ok = Boolean(v) && (Number(v![1]) > HOST_NODE_MIN[0]! || (Number(v![1]) === HOST_NODE_MIN[0] && Number(v![2]) >= HOST_NODE_MIN[1]!));
    nodeVersions.set(node, ok);
  }
  return ok ? node : null;
}

/** The Node binary that runs the host. */
export function hostNode(ctx: Pick<RelaySandboxContext, 'tools'>): string {
  return ctx.tools.node ?? process.execPath;
}

export function relaySandboxContext(): RelaySandboxContext {
  return {
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    dataDir: DATA_DIR,
    relayRoot: RELAY_ROOT,
    relayPorts: relayPorts(),
    localAddresses: localAddresses(),
    tools: relaySandboxTools(),
  };
}

// --- Hosts ------------------------------------------------------------------------------------

/** "host" or "host:port", split; undefined when it is neither (a scheme, a path, a bare `*`…). */
export function parseHostEntry(entry: string): { host: string; port?: number } | undefined {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:/[\]@?#]+)(?::(\d{1,5}))?$/.exec(entry.trim());
  if (!m) return undefined;
  const host = m[1]!.toLowerCase();
  const port = m[2] === undefined ? undefined : Number(m[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  const bare = host.replace(/^\[|\]$/g, '');
  const ok = host.startsWith('[')
    ? bare.includes(':')
    : /^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(host);
  return ok ? { host, ...(port !== undefined ? { port } : {}) } : undefined;
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return parts.map(Number);
}

/** An IPv6 address as its eight 16-bit groups (an IPv4 address at its end included), or undefined. */
export function ipv6Groups(host: string): number[] | undefined {
  let h = host.toLowerCase();
  if (!h.includes(':') || !/^[0-9a-f:.]+$/.test(h)) return undefined;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (tail) {
    const v4 = ipv4(tail[1]!);
    if (!v4) return undefined;
    h = `${h.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === '' ? [] : s.split(':'));
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0) || head.length + rest.length + fill !== 8) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

/** The IPv4 address an IPv6 one carries: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) or NAT64 (64:ff9b::a.b.c.d). */
function embeddedIpv4(g: number[]): number[] | undefined {
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  const v4 = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (zeros(5) && g[5] === 0xffff) return v4;
  if (zeros(6) && (g[6] !== 0 || g[7]! > 1)) return v4;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4;
  return undefined;
}

/** A host as one spelling: lower case, without brackets, an IPv6 address in full. */
function normalHost(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const g = ipv6Groups(h);
  return g ? g.map((x) => x.toString(16)).join(':') : h;
}

/**
 * A host as the proxy dials it, whatever spelling the client used: what URL parsing makes of it (so
 * `127.1`, `2130706433`, `0x7f.0.0.1`, `0177.0.0.1` and `0` are the IPv4 addresses they stand for, and
 * a name is in lower case and ASCII), without brackets or a trailing dot. Undefined for one it cannot
 * read. sandbox-runtime does the same before it applies its own rules, but its ask callback gets the
 * host as the client wrote it.
 */
export function canonicalHost(host: string): string | undefined {
  const bare = /^\[(.*)\]$/.exec(host)?.[1] ?? host;
  if (!bare || /[\s/?#@\\[\]]/.test(bare)) return undefined; // not a host alone: URL parsing would read part of it as something else
  try {
    const h = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname;
    return h.replace(/^\[|\]$/g, '').replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Loopback: `localhost` (and names under it), 127.0.0.0/8 and ::1 (also as an IPv4-carrying IPv6 address). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const g = ipv6Groups(h);
  const v4 = g ? embeddedIpv4(g) : ipv4(h);
  if (v4) return v4[0] === 127;
  return Boolean(g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1);
}

/** The cloud metadata services outside link-local. */
const METADATA_V4 = ['100.100.100.200', '168.63.129.16', '192.0.0.192'];
const METADATA_V6 = ['fd00:ec2::254', 'fd20:ce::254', 'fd00:c1::a9fe:a9fe', 'fd00:42::42'].map(normalHost);

/**
 * A destination on this computer or next to it, which the sandbox never asks about: loopback, the
 * unspecified address, link-local (the cloud metadata services among them), multicast, broadcast, the
 * metadata services outside link-local, and this computer's own addresses (`own`).
 */
export function isLocalHost(host: string, own: readonly string[] = []): boolean {
  if (isLoopbackHost(host)) return true;
  const h = normalHost(host);
  if (own.some((a) => normalHost(a) === h)) return true;
  const g = ipv6Groups(h);
  const v4 = g ? embeddedIpv4(g) : ipv4(h);
  if (v4) {
    const dotted = v4.join('.');
    if (own.some((a) => normalHost(a) === dotted)) return true;
    const [a, b] = v4 as [number, number];
    return a === 0 || (a === 169 && b === 254) || a >= 224 || METADATA_V4.includes(dotted);
  }
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // unspecified
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00) return true; // link-local, multicast
  return METADATA_V6.includes(h);
}

const bracket = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/**
 * The run's network rules: the hosts it may reach (`allowedDomains`), Harness Relay's own ports on
 * this computer (`deniedDomains`, which win over any allow), and whether one of the allowed hosts is
 * on loopback (then programs must not reach loopback around the proxy: `NO_PROXY` leaves it out). A
 * host on this computer must name its port, which may not be one of Harness Relay's; one on loopback
 * is allowed by each loopback name, since the proxy refuses a name that leads to loopback unless the
 * address itself is allowed. Throws, with the reason, on an entry it cannot take.
 */
export function relaySandboxHosts(
  allowedHosts: readonly string[],
  ctx: Pick<RelaySandboxContext, 'relayPorts' | 'localAddresses'>,
  quietlyDenied: readonly string[] = [],
): { allowed: string[]; denied: string[]; quietReasons: Record<string, string>; loopback: boolean; loopbackPorts: number[] } {
  const allowed: string[] = [];
  const loopbackPorts: number[] = [];
  let loopback = false;
  for (const entry of allowedHosts) {
    const parsed = parseHostEntry(entry);
    if (!parsed || parsed.host === '*' || (parsed.host.startsWith('*.') && parsed.host.split('.').length < 3)) {
      throw new AgentRunError(t().relaySandboxBadHost(entry));
    }
    const { host, port } = parsed;
    if (isLocalHost(host, ctx.localAddresses)) {
      if (port === undefined) throw new AgentRunError(t().relaySandboxLocalPort(entry));
      if (ctx.relayPorts.includes(port)) throw new AgentRunError(t().relaySandboxRelayPort(entry));
      if (isLoopbackHost(host)) {
        loopback = true;
        loopbackPorts.push(port);
        allowed.push(`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`);
        continue;
      }
    }
    allowed.push(port === undefined ? bracket(host) : `${bracket(host)}:${port}`);
  }
  const local = ['localhost', '*.localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]', ...ctx.localAddresses.map(bracket)];
  const relay = ctx.relayPorts.flatMap((port) => local.map((host) => `${host}:${port}`));
  const quietReasons: Record<string, string> = {};
  for (const entry of quietlyDenied) {
    const parsed = parseHostEntry(entry);
    if (!parsed || parsed.host === '*') throw new AgentRunError(t().relaySandboxBadHost(entry));
    const where = parsed.port === undefined ? bracket(parsed.host) : `${bracket(parsed.host)}:${parsed.port}`;
    quietReasons[where] = DENY_REASONS.quiet(hostLabel(parsed.host, parsed.port));
  }
  return { allowed: [...new Set(allowed)], denied: [...new Set([...relay, ...Object.keys(quietReasons)])], quietReasons, loopback, loopbackPorts: [...new Set(loopbackPorts)] };
}

/** The reasons the model sees for a host it may not reach (English, like every prompt to the agents). */
export const DENY_REASONS = {
  local: (where: string) =>
    `Harness Relay's sandbox does not let programs reach this computer's own addresses or link-local addresses (${where}).`,
  relay: "Harness Relay's own API is not reachable from its sandbox.",
  refused: (where: string) =>
    `${where} is not among the hosts this run may reach, and this conversation refuses anything beyond its permission.`,
  declined: (where: string, note?: string) =>
    `The user declined network access to ${where}.${note ? ` Their message: ${note}` : ''} Do not retry it; continue without it, or explain in your reply why it is needed.`,
  tooMany: (where: string) => `Too many hosts were asked about in this run, so ${where} is refused without asking.`,
  quiet: (where: string) => `${where} is not reachable from Harness Relay's sandbox.`,
};

/** How a host and port read in an approval and in a reason: the host alone for 443 and 80. */
export function hostLabel(host: string, port: number | undefined): string {
  return port === undefined || port === 443 || port === 80 ? bracket(host) : `${bracket(host)}:${port}`;
}

/** Checks `localPorts`: whole numbers from 1024 to 65535, none of Harness Relay's. Throws with the reason. */
export function relaySandboxLocalPorts(
  ports: readonly number[] | undefined,
  ctx: Pick<RelaySandboxContext, 'relayPorts'>,
  /** The allowed hosts: a port of a loopback backend there cannot also be the agent's own. */
  allowed: readonly string[] = [],
): number[] {
  const out = [...new Set(ports ?? [])];
  const backends = allowed.flatMap((entry) => {
    const parsed = parseHostEntry(entry);
    return parsed && parsed.port !== undefined && isLoopbackHost(parsed.host) ? [parsed.port] : [];
  });
  for (const port of out) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AgentRunError(t().relaySandboxBadHost(`localhost:${port}`));
    if (ctx.relayPorts.includes(port)) throw new AgentRunError(t().relaySandboxRelayPort(`localhost:${port}`));
    if (backends.includes(port)) throw new AgentRunError(t().relaySandboxBadHost(`localhost:${port}`));
  }
  return out;
}

/**
 * `connectPorts` as allowed hosts (`localhost:<port>`, which `relaySandboxHosts` names by every
 * loopback name and refuses for Harness Relay's ports). Throws on a port that is not a whole number
 * from 1 to 65535.
 */
export function relaySandboxConnectPorts(ports: readonly number[] | undefined): string[] {
  return [...new Set(ports ?? [])].map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AgentRunError(t().relaySandboxBadHost(`localhost:${port}`));
    return `localhost:${port}`;
  });
}

/** A loopback port nothing listens on now, for an agent's own server (`localPorts`). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port'))));
    });
  });
}

// --- Paths ------------------------------------------------------------------------------------

/** Whether `path` is `dir` or inside it, both by their real paths. */
export function isWithin(path: string, dir: string): boolean {
  const rel = relative(realPath(resolve(dir)), realPath(resolve(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * What decides how other agent CLIs run, in a project: Claude Code's, Codex's and Grok's project
 * settings (hooks, MCP servers, sandbox settings, which they run outside any sandbox or with full
 * access), Cursor's (its rules, subagents, skills and MCP servers; Cursor has no sandbox at all),
 * Antigravity's (`.agents` and its other spellings: its hooks and MCP servers, run outside any sandbox), and
 * the open agents' own project config and plugins. In edit mode the working directory is
 * writable, so these are kept read-only in it: a run cannot plant what a later run, or another agent,
 * would start outside the sandbox. (sandbox-runtime itself keeps `.git/hooks`, `.git/config`,
 * `.gitmodules`, `.mcp.json`, `.vscode`, `.idea` and the shell's dotfiles read-only.)
 */
export const PROJECT_AGENT_CONFIG = [
  '.claude',
  '.codex',
  '.grok',
  '.cursor',
  '.mcp.json',
  '.opencode',
  'opencode.json',
  'opencode.jsonc',
  '.goose',
  '.cline',
  // Cline's rules folder (or file), with its hooks, which Cline runs without asking.
  '.clinerules',
  '.openhands',
  '.pi',
  '.agents',
  // Antigravity reads its project customizations (hooks, MCP servers, plugins) from `.agents`, or
  // `.agent`, `_agents` or `_agent`.
  '.agent',
  '_agents',
  '_agent',
];

/** Paths sandbox-runtime lets every command write unless denied; a run writes its own temporary folder instead. */
function srtDefaultWrites(home: string): string[] {
  return ['/tmp/claude', '/private/tmp/claude', join(home, '.npm/_logs'), join(home, '.claude/debug')];
}

/** Each path, and its real path when that differs (sandbox-runtime resolves links, but a deny should hold by both names). */
function withReal(paths: Iterable<string>): string[] {
  return [...new Set([...paths].flatMap((p) => [p, realPath(p)]))];
}

/**
 * The run's file rules: what it may write (`allowWrite`) and what it may not read (`denyRead`) or
 * write (`denyWrite`, which wins over `allowWrite`); everything else it may read.
 * - read-only: its temporary folder and the agent's state folders;
 * - edit: also the working directory and the attachments folder, without the agent config of the
 *   project (`PROJECT_AGENT_CONFIG`);
 * - never: the protected paths (also not readable) with Harness Relay's database and temporary folder,
 *   the agent's config paths, the folders of the programs the run starts, and what sandbox-runtime
 *   would let it write by default (`/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`).
 */
export function relaySandboxPaths(
  spec: Pick<RelaySandboxSpec, 'permission' | 'cwd' | 'extraCwds' | 'writable' | 'readOnly' | 'protectedPaths' | 'attachmentsDir' | 'privateRoots'>,
  ctx: Pick<RelaySandboxContext, 'home' | 'dataDir'>,
  run: RelaySandboxRunDirs & { programs?: readonly string[] },
): { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] } {
  const edit = spec.permission === 'edit';
  const cwds = [spec.cwd, ...(spec.extraCwds ?? [])];
  const relay = [...relayDatabaseFiles(ctx.dataDir), relayTmpDir(ctx.dataDir)].filter((p) => existsSync(p));
  const denyRead = withReal([...spec.protectedPaths, ...relay]);
  const allowWrite = withReal([
    run.tmp,
    ...spec.writable,
    ...(edit ? [...cwds, ...(spec.attachmentsDir ? [spec.attachmentsDir] : [])] : []),
  ]);
  const denyWrite = withReal([
    ...denyRead,
    ...spec.readOnly,
    ...(edit ? cwds.flatMap((cwd) => PROJECT_AGENT_CONFIG.map((name) => join(cwd, name))) : []),
    ...(run.programs ?? []).map((p) => dirname(p)),
    ...srtDefaultWrites(ctx.home),
  ]);
  // Other runs' folders: not readable; the run's own parts of them still are, except anything
  // protected: what it may write, its own config (read-only: Goose keeps its config in its private
  // state folder), and the host's temp folder, where sandbox-runtime's network bridge sockets are
  // (in the data folder's `srt/`, also a private root).
  const privateRoots = withReal(spec.privateRoots ?? []);
  const own = [...allowWrite.filter((w) => !denyWrite.some((d) => isWithin(w, d))), ...withReal(spec.readOnly), ...withReal([run.hostTmp])];
  const allowRead = [...new Set(own)].filter((p) => privateRoots.some((r) => isWithin(p, r)) && !denyRead.some((d) => isWithin(p, d)));
  return { allowWrite, denyWrite, denyRead: [...new Set([...denyRead, ...privateRoots])], allowRead };
}

/**
 * Why the run may not start with these paths, or undefined:
 * - a path that is not absolute;
 * - a protected or config path whose name has `*`, `?` or `[`, which a sandbox reads as a pattern
 *   (sandbox-runtime is given every path as a literal name, but this keeps the rule the other CLIs'
 *   sandboxes have, `patternPath()`);
 * - in edit mode, a working directory that holds Harness Relay or what decides how the agents run
 *   (`relayFolderRefusal()`);
 * - a folder the run may write that holds or is in Harness Relay's folder (outside its data folder's
 *   worktrees and attachments), holds the data folder or the home folder, or overlaps the other CLIs'
 *   own folders;
 * - a program run outside the sandbox (the host, Node, sandbox-runtime's tools) in a folder the run
 *   may write.
 */
export function relaySandboxRefusal(
  spec: Pick<RelaySandboxSpec, 'permission' | 'cwd' | 'extraCwds' | 'writable' | 'readOnly' | 'protectedPaths' | 'attachmentsDir'>,
  ctx: Pick<RelaySandboxContext, 'home' | 'dataDir' | 'relayRoot' | 'voiceDir'>,
  o: { bins?: string[]; programs?: string[] } = {},
): string | undefined {
  const cwds = [spec.cwd, ...(spec.extraCwds ?? [])];
  const all = [...cwds, ...spec.writable, ...spec.readOnly, ...spec.protectedPaths, ...(spec.attachmentsDir ? [spec.attachmentsDir] : [])];
  const relativePath = all.find((p) => !isAbsolute(p));
  if (relativePath !== undefined) return t().relaySandboxRelative(relativePath);
  const pattern = patternPath([...spec.protectedPaths, ...spec.readOnly]);
  if (pattern) return t().protectedPattern(pattern);
  if (spec.permission === 'edit') {
    for (const cwd of cwds) {
      const why = relayFolderRefusal({ permission: 'edit', cwd }, { bins: o.bins ?? [] });
      if (why) return why;
    }
  }
  const writes = [...spec.writable, ...(spec.permission === 'edit' ? [...cwds, ...(spec.attachmentsDir ? [spec.attachmentsDir] : [])] : [])];
  const voice = ctx.voiceDir ?? voiceFolder(ctx.dataDir);
  const roots = { install: ctx.relayRoot, data: ctx.dataDir, voice };
  const others = agentFolders({ home: ctx.home });
  for (const w of writes) {
    const overlap = relayFolderOverlap(w, roots);
    // Named for what it overlaps: voice input's folder, else Harness Relay's.
    if (overlap) return t().relaySandboxWritable(w, overlap === 'voice' ? voice : ctx.relayRoot);
    if (isWithin(ctx.home, w)) return t().relaySandboxWritable(w, ctx.home);
    const folder = others.find((f) => isWithin(f, w) || isWithin(w, f));
    if (folder) return t().relaySandboxWritable(w, folder);
  }
  for (const program of o.programs ?? []) {
    if (writes.some((w) => isWithin(program, w))) return t().relaySandboxProgram(program);
  }
  return undefined;
}

// --- The command ------------------------------------------------------------------------------

/** Single-quoted for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Variables that change what the programs outside the sandbox do (the shell, `env`, `sandbox-exec`,
 * bubblewrap): taken out of their environment, and set again for the agent inside the sandbox.
 */
const OUTSIDE_ONLY = /^(LD_|DYLD_)|^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|IFS|CDPATH|GLOBIGNORE)$/;
/** Variables of the agent's environment that the sandbox sets itself (the proxy) or that would bypass it. */
const SANDBOX_OWNS = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|GRPC_PROXY|https?_proxy|all_proxy|no_proxy|ftp_proxy|grpc_proxy|TMPDIR|TMP|TEMP|NODE_USE_ENV_PROXY)$/;

/**
 * The environment of the processes that start the sandbox (the agent's, without the variables that
 * would change what they do, and with the system's PATH), and the command the sandbox runs: it sets
 * the agent's own PATH and those variables again, the proxy settings every client needs, and starts
 * the agent.
 * - `NODE_USE_ENV_PROXY=1`: Node's `fetch`, `http` and `https` use `HTTP(S)_PROXY` only when asked
 *   (Node 22.21+ and 24.5+). Bun, Python's `httpx` and `requests`, Rust's `reqwest`, Go and curl read
 *   the proxy variables sandbox-runtime sets by themselves.
 * - `NO_PROXY`: loopback only (programs reach their own loopback directly on Linux, where the sandbox
 *   has one of its own). When a model backend is on loopback it must go through the proxy, so then
 *   only the agent's own ports (`localPorts`) are listed, as `127.0.0.1:<port>` and `localhost:<port>`:
 *   Node, Bun and httpx honour a port there and reach the agent's own server directly, while the
 *   backend and every other loopback port go through the proxy, whose allowlist decides. (No
 *   `[::1]:<port>`: httpx refuses the whole variable for it. curl, and requests for an address, ignore
 *   a port there and use the proxy, which on macOS allows the agent's own ports too.) Not the private
 *   ranges sandbox-runtime lists: the sandbox cannot reach them directly, so a backend on the local
 *   network must go through the proxy too.
 * - `TMPDIR`, `TMP`, `TEMP`: the run's own temporary folder.
 * - `loopbackRelay` (Linux): the loopback ports of this computer the run may reach (a model backend,
 *   a server the agent only connects to) are relayed onto the sandbox's own loopback by `socat`,
 *   through the proxy with the run's own credentials, before the agent starts (`SANDBOX_EXEC_SCRIPT`).
 *   A client that never sends loopback to a proxy (Cline adds `localhost`, `127.0.0.1` and `::1` to
 *   `NO_PROXY` by itself) would otherwise reach the sandbox's own loopback, where nothing listens. The
 *   proxy's allowlist still decides; the relay only carries what the run could send the proxy anyway.
 */
export function relaySandboxEnv(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  o: { tmp: string; loopback: boolean; localPorts?: readonly number[]; loopbackRelay?: { socat: string; ports: readonly number[] } },
): { outerEnv: Record<string, string>; command: string } {
  const outerEnv: Record<string, string> = {};
  const inner: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SANDBOX_OWNS.test(key) || key.startsWith(SANDBOX_EXEC_PREFIX)) continue;
    if (key === 'PATH' || OUTSIDE_ONLY.test(key)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) inner.push([key, value]);
      continue;
    }
    outerEnv[key] = value;
  }
  outerEnv.PATH = SYSTEM_PATH.join(':');
  const noProxy = o.loopback
    ? (o.localPorts ?? []).flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]).join(',')
    : 'localhost,127.0.0.1,::1';
  inner.push(
    ['TMPDIR', o.tmp],
    ['TMP', o.tmp],
    ['TEMP', o.tmp],
    ['NODE_USE_ENV_PROXY', '1'],
    ['NO_PROXY', noProxy],
    ['no_proxy', noProxy],
  );
  // Every value travels in the environment, under names of our own; the command is fixed text.
  for (const [k, v] of inner) outerEnv[`${SANDBOX_EXEC_PREFIX}IN_${k}`] = v;
  const relayed = (o.loopbackRelay?.ports ?? []).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (o.loopbackRelay && relayed.length) {
    outerEnv[`${SANDBOX_EXEC_PREFIX}RELAY_PORTS`] = relayed.join(' ');
    outerEnv[`${SANDBOX_EXEC_PREFIX}SOCAT`] = o.loopbackRelay.socat;
  }
  outerEnv[`${SANDBOX_EXEC_PREFIX}INNER`] = inner.map(([k]) => k).join(' ');
  [bin, ...args].forEach((a, i) => {
    if (typeof a !== 'string') throw new TypeError(`argument ${i} of the sandboxed command is not a string`);
    outerEnv[`${SANDBOX_EXEC_PREFIX}ARG_${i}`] = a;
  });
  outerEnv[`${SANDBOX_EXEC_PREFIX}ARGC`] = String(args.length + 1);
  return { outerEnv, command: SANDBOX_EXEC_SCRIPT };
}

/** The prefix of the variables that carry the sandboxed command's program, arguments and inner environment. */
export const SANDBOX_EXEC_PREFIX = 'HARNESS_RELAY_SBX_';

/**
 * What the sandbox's shell runs: fixed text, the same for every run (AGENTS.md: no path, name or
 * setting in a shell's text). It takes the program and its arguments from `HARNESS_RELAY_SBX_ARG_<i>`
 * (`HARNESS_RELAY_SBX_ARGC` of them), sets again the variables listed in `HARNESS_RELAY_SBX_INNER`
 * (names our own code checked: letters, digits, `_`) from `HARNESS_RELAY_SBX_IN_<name>`, removes all
 * of these, and runs the program. `eval` only ever sees a number or one of those names; every value
 * stays inside a double-quoted variable reference, so nothing in a value is read as shell syntax.
 */
export const SANDBOX_EXEC_SCRIPT = String.raw`i=0
set --
while [ "$i" -lt "$HARNESS_RELAY_SBX_ARGC" ]; do
  eval "set -- \"\$@\" \"\$HARNESS_RELAY_SBX_ARG_$i\""
  unset "HARNESS_RELAY_SBX_ARG_$i"
  i=$((i + 1))
done
for n in $HARNESS_RELAY_SBX_INNER; do
  eval "$n=\"\$HARNESS_RELAY_SBX_IN_$n\"; export $n"
  unset "HARNESS_RELAY_SBX_IN_$n"
done
if [ -n "$HARNESS_RELAY_SBX_RELAY_PORTS" ] && [ -n "$HTTP_PROXY" ]; then
  p=${'$'}{HTTP_PROXY#*://}
  a=$(printf '%s' "${'$'}{p%@*}" | sed 's/%3[Dd]/=/g; s/%2[Bb]/+/g; s/%2[Ff]/\//g; s/%3[Aa]/:/g; s/%40/@/g; s/%25/%/g')
  h=${'$'}{p##*@}
  h=${'$'}{h%%/*}
  for port in $HARNESS_RELAY_SBX_RELAY_PORTS; do
    "$HARNESS_RELAY_SBX_SOCAT" "TCP4-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "PROXY:${'$'}{h%:*}:127.0.0.1:$port,proxyport=${'$'}{h##*:},proxyauth=$a" </dev/null >/dev/null 2>&1 &
    "$HARNESS_RELAY_SBX_SOCAT" "TCP6-LISTEN:$port,bind=[::1],ipv6only=1,fork,reuseaddr" "PROXY:${'$'}{h%:*}:127.0.0.1:$port,proxyport=${'$'}{h##*:},proxyauth=$a" </dev/null >/dev/null 2>&1 &
  done
  k=0
  for port in $HARNESS_RELAY_SBX_RELAY_PORTS; do
    x=$(printf '%04X' "$port")
    while [ "$k" -lt 100 ] && [ -r /proc/net/tcp ]; do
      up=
      while read -r s l r st rest; do
        if [ "$l" = "0100007F:$x" ] && [ "$st" = 0A ]; then up=1; fi
      done < /proc/net/tcp
      [ -n "$up" ] && break
      k=$((k + 1))
      sleep 0.02
    done
  done
fi
unset HARNESS_RELAY_SBX_ARGC HARNESS_RELAY_SBX_INNER HARNESS_RELAY_SBX_RELAY_PORTS HARNESS_RELAY_SBX_SOCAT i n p a h port x k up s l r st rest
exec "$@"`;

/** A path as a literal name: sandbox-runtime never reads it as a pattern. */
const literal = (path: string) => ({ path, literal: true as const });

/** sandbox-runtime's configuration for a run. */
export function relaySandboxConfig(
  paths: ReturnType<typeof relaySandboxPaths>,
  hosts: ReturnType<typeof relaySandboxHosts>,
  ctx: Pick<RelaySandboxContext, 'platform' | 'tools'>,
  o: { allowPty?: boolean; unixSocketDir?: string; allowTlsTrustd?: boolean; localPorts?: readonly number[] } = {},
): SandboxRuntimeConfig {
  // Only on macOS, and only sockets inside the run's own temporary folder (a `subpath` rule); its
  // seccomp filter cannot allow one socket path on Linux, so there they stay blocked.
  const allowUnixSockets = o.unixSocketDir && ctx.platform === 'darwin' ? [o.unixSocketDir] : [];
  return {
    network: {
      // On macOS the proxy shares the sandbox's loopback, so the agent's own ports are allowed through
      // it as well, for a client that sends them there (curl ignores a port in NO_PROXY). Not on Linux:
      // there the sandbox's loopback is its own, and the proxy would reach this computer's port instead.
      allowedDomains: [
        ...new Set([
          ...hosts.allowed,
          ...(ctx.platform === 'darwin' ? (o.localPorts ?? []).flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]) : []),
        ]),
      ],
      deniedDomains: hosts.denied,
      deniedDomainReasons: Object.fromEntries(hosts.denied.map((d) => [d, hosts.quietReasons[d] ?? DENY_REASONS.relay])),
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets,
      // The one mach service `enableWeakerNetworkIsolation` opens, named on its own so nothing else is
      // (sandbox-runtime reads it from `network`).
      ...(o.allowTlsTrustd && ctx.platform === 'darwin' ? { allowMachLookup: ['com.apple.trustd.agent'] } : {}),
    },
    filesystem: {
      denyRead: paths.denyRead.map(literal),
      allowRead: paths.allowRead.map(literal),
      allowWrite: paths.allowWrite.map(literal),
      denyWrite: paths.denyWrite.map(literal),
      allowGitConfig: false,
    },
    allowPty: Boolean(o.allowPty),
    allowAppleEvents: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowNestedUserNamespaces: false,
    ...(ctx.platform === 'linux'
      ? { bwrapPath: ctx.tools.bwrap, socatPath: ctx.tools.socat, ripgrep: { command: ctx.tools.rg ?? 'rg' } }
      : {}),
  };
}

// --- Runs ---------------------------------------------------------------------------------------

/** The most hosts a run asks the user about; any further one is refused. */
const MAX_ASKS = 30;

type HostAnswer = { allow: true } | { allow: false; reason: string };

/** A failure the host reported: a code and what sandbox-runtime said. */
interface HostFailure {
  code: string;
  detail: string;
}

/** The Linux packages the sandbox needs, by how a missing one is reported. */
const LINUX_PACKAGES = [
  { name: 'bubblewrap (bwrap)', pkg: 'bubblewrap', re: /\bbubblewrap\b|\bbwrap\b/ },
  { name: 'socat', pkg: 'socat', re: /\bsocat\b/ },
  { name: 'ripgrep (rg)', pkg: 'ripgrep', re: /\bripgrep\b|\brg\b/ },
];

/**
 * The translated reason for a failure of the sandbox, said once: a missing Linux package is named
 * with the command that installs exactly the missing ones; anything else (on macOS, a missing
 * `sandbox-exec` too) gets the platform's own advice.
 */
export function failureText(f: HostFailure, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (f.code === 'channel') return t().relaySandboxNoChannel;
  if (f.code === 'seccomp') return t().relaySandboxArch(arch);
  if (f.code === 'deps' && platform === 'linux' && /not (installed|found|executable)/.test(f.detail)) {
    const missing = LINUX_PACKAGES.filter((p) => p.re.test(f.detail));
    if (missing.length) return t().relaySandboxMissing(missing.map((m) => m.name).join(', '), missing.map((m) => m.pkg).join(' '));
  }
  return t().relaySandboxFailed(f.detail.trim().replace(/[.。]+$/, ''), platform);
}

/**
 * One sandboxed run, on the server's side: its temporary folders, its channel to the host, and the
 * hosts it asks about. Asks are answered one at a time, each host and port once per run (the answer
 * is kept), at most `MAX_ASKS` of them; a destination on this computer is refused without asking.
 */
export class RelaySandboxRun {
  private channelEnd?: Duplex;
  private attached = false;
  private disposed = false;
  private failed?: HostFailure;
  private answers = new Map<string, Promise<HostAnswer>>();
  private queue: Promise<unknown> = Promise.resolve();
  private asked = 0;
  /** What the host said when the sandbox was up (its proxy's ports, for diagnostics and checks). */
  ready?: { proxyPort: number | null; socksPort: number | null };
  probeOk = false;
  exit?: { code: number | null; signal: string | null };
  private exitListeners: (() => void)[] = [];
  readonly lang = currentLang();

  constructor(
    readonly dirs: RelaySandboxRunDirs,
    private config: Record<string, unknown>,
    private o: {
      requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
      localAddresses: readonly string[];
      platform: NodeJS.Platform;
      arch: string;
      /** The two leftover sweeps run at dispose (tests swap them; true = nothing of the run is left). */
      sweeps?: { bySandbox(tmps: string[]): Promise<boolean>; byMarker(markers: string[]): Promise<boolean> };
    },
  ) {}

  /** Takes the host's end of its channel (the first one only) and sends it the run's rules. */
  readonly attach: ControlChannel = (channel) => {
    if (this.attached || this.disposed) {
      channel.destroy();
      return;
    }
    this.attached = true;
    this.channelEnd = channel;
    createInterface({ input: channel, crlfDelay: Infinity }).on('line', (line) => withLang(this.lang, () => this.onLine(line)));
    channel.on('error', () => undefined);
    this.send({ t: 'config', ...this.config });
  };

  private send(msg: Record<string, unknown>): void {
    const end = this.channelEnd;
    if (end && !end.destroyed && end.writable) end.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line) as Record<string, any>;
    } catch {
      return;
    }
    if (msg.t === 'ask' && Number.isInteger(msg.id) && typeof msg.host === 'string') {
      const port = Number.isInteger(msg.port) ? (msg.port as number) : undefined;
      void this.decide(msg.host, port).then(
        (a) => this.send({ t: 'answer', id: msg.id, ...a }),
        () => this.send({ t: 'answer', id: msg.id, allow: false, reason: DENY_REASONS.refused(hostLabel(msg.host, port)) }),
      );
    } else if (msg.t === 'failed' && typeof msg.code === 'string') {
      this.failed = { code: msg.code, detail: String(msg.detail ?? '').slice(0, 2000) };
    } else if (msg.t === 'ready') {
      this.ready = { proxyPort: msg.proxyPort ?? null, socksPort: msg.socksPort ?? null };
    } else if (msg.t === 'probe') {
      this.probeOk = msg.ok === true;
    } else if (msg.t === 'exit') {
      this.exit = { code: msg.code ?? null, signal: msg.signal ?? null };
      for (const listener of this.exitListeners.splice(0)) listener();
    }
  }

  /**
   * Calls `listener` once the host says the sandboxed command has exited (at once when it already has):
   * a moment before the host itself exits, after taking down what it started for the run.
   */
  onExit(listener: () => void): void {
    if (this.exit) listener();
    else this.exitListeners.push(listener);
  }

  /**
   * The answer for a host no rule decided: kept for the run, asked once, one at a time. The host is
   * taken as the proxy dials it (`canonicalHost`), so another spelling of a local address is refused
   * as that address is, and the card names what would be reached.
   */
  decide(host: string, port: number | undefined): Promise<HostAnswer> {
    const canonical = canonicalHost(host);
    if (!canonical) return Promise.resolve({ allow: false, reason: DENY_REASONS.refused(hostLabel(host, port)) });
    const key = `${canonical}:${port ?? ''}`;
    let answer = this.answers.get(key);
    if (!answer) {
      answer = this.ask(canonical, port);
      this.answers.set(key, answer);
    }
    return answer;
  }

  private async ask(host: string, port: number | undefined): Promise<HostAnswer> {
    const where = hostLabel(host, port);
    // A name is never looked up here: the server's resolver is outside the sandbox, so a lookup made
    // for every name a sandboxed command asks about would carry data out in the names, unasked. A
    // name that leads to this computer is asked about like any other; allowed, sandbox-runtime refuses
    // it when it dials (its address guard), so it still never reaches this computer.
    if (isLocalHost(host, this.o.localAddresses)) return { allow: false, reason: DENY_REASONS.local(where) };
    const requestApproval = this.o.requestApproval;
    if (!requestApproval || this.disposed) return Promise.resolve({ allow: false, reason: DENY_REASONS.refused(where) });
    if (++this.asked > MAX_ASKS) return Promise.resolve({ allow: false, reason: DENY_REASONS.tooMany(where) });
    const lang = this.lang;
    const next = this.queue.then((): Promise<HostAnswer> | HostAnswer => {
      // Queued behind another ask: the run may have ended meanwhile. Then nobody is asked (a card put
      // up after the turn would never expire).
      if (this.disposed) return { allow: false, reason: DENY_REASONS.refused(where) };
      return withLang(lang, () => requestApproval({ kind: 'fetch', detail: where, reason: t().relaySandboxHost })).then(
        (a): HostAnswer => (a.allow ? { allow: true } : { allow: false, reason: DENY_REASONS.declined(where, a.note) }),
        (): HostAnswer => ({ allow: false, reason: DENY_REASONS.refused(where) }),
      );
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Why the sandbox did not start, translated now (the language follows the request). */
  failure(): string | undefined {
    const f = this.failed ?? (this.attached ? undefined : { code: 'channel', detail: '' });
    return f ? withLang(currentLang(), () => failureText(f, this.o.platform, this.o.arch)) : undefined;
  }

  /** What the host reported as its failure (code and detail), if any. */
  hostFailure(): HostFailure | undefined {
    return this.failed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.channelEnd?.destroy();
    // The host sweeps what still holds the run's marker before it exits, but the server may have
    // SIGKILLed it first (3 s after SIGTERM). So the server sweeps the marker itself, and keeps the file
    // while anything still holds it, for the startup sweep, which finds holders by the marker's name.
    const marker = this.dirs.marker;
    const mac = this.o.platform === 'darwin' && process.platform === 'darwin';
    // Then whatever is still inside this run's sandbox, found by its Seatbelt profile: a command the
    // CLI started without passing the marker on (Node, Bun and Python close it) that then left the
    // host's group (sandboxProcs.ts). Its folders are removed only after, so it is identified by them.
    // Neither blocks the server: other runs go on while this one is torn down.
    const sweeps = this.o.sweeps ?? { bySandbox: (t: string[]) => sweepRunSandboxesAsync(t), byMarker: sweepMarkersAsync };
    const swept = mac ? await sweeps.bySandbox([this.dirs.tmp]) : true;
    const held = (marker && mac && existsSync(marker) ? !(await sweeps.byMarker([marker])) : false) || !swept;
    // Something of the run survived every round: keep its marker and its temp folder, by which the
    // next server start finds it (the marker sweep, and the sweep by sandbox, which needs the folder).
    removeRunDirs(held ? { ...this.dirs, marker: undefined, tmp: '' } : this.dirs);
  }
}

/** A folder only this user may use, made fresh (an existing link or file in its place is refused). */
function freshDir(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} is not a folder`);
  return path;
}

/**
 * The run's temporary folders, in Harness Relay's data folder (which no sandbox may write, unlike the
 * system's temporary folder, where another CLI's sandboxed command could replace or remove what is in
 * it: sandbox-runtime's sockets, its CA bundle). The host's goes under `relaySandboxHostRoot`, short
 * enough for the sockets sandbox-runtime makes in it; a data folder whose path is too long for that is
 * refused (the run does not start, and says to set `RELAY_DATA_DIR`), never moved to the system's.
 */
export function makeRunDirs(dataDir = DATA_DIR, platform: NodeJS.Platform = process.platform): RelaySandboxRunDirs {
  const tooLong = hostTmpRefusal(dataDir, platform);
  if (tooLong) throw new AgentRunError(tooLong);
  const hostRoot = relaySandboxHostRoot(dataDir);
  const root = relaySandboxRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString('hex');
  const tmp = freshDir(join(root, id));
  const marker = join(root, `${id}.marker`);
  let hostTmp: string | undefined;
  try {
    closeSync(openSync(marker, 'wx', 0o600)); // fresh, owner-only; wx refuses a planted file
    // A short name of its own, apart from the run's id: tried again in the unlikely case it is taken.
    for (let attempt = 0; !hostTmp; attempt++) {
      try {
        hostTmp = freshDir(join(hostRoot, randomBytes(HOST_ID_LENGTH / 2).toString('hex')));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 4) throw err;
      }
    }
    return { tmp, hostTmp, marker };
  } catch (err) {
    for (const path of [tmp, marker]) rmSync(path, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Processes the startup sweep should kill: every holder (`lsof -t`) of a run's marker file, and
 * their descendants (from `ps`), minus this server. Pure, for testing; the impure parts (running
 * `lsof`/`ps`, sending the signal) are in `clearRelaySandboxLeftovers`.
 */
export function leftoverSweepPids(lsofOut: string, psOut: string, self: number): number[] {
  const holders = lsofOut
    .split('\n')
    .map((n) => Number(n.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== self);
  const children = new Map<number, number[]>();
  for (const line of psOut.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = new Set<number>();
  const stack = [...holders];
  while (stack.length) {
    const pid = stack.pop()!;
    if (pid === self || pid <= 1 || out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return [...out];
}

/**
 * At startup (before any run), stops and removes what runs left behind when the server was stopped
 * during them. On macOS it also kills every process still holding a run's marker — a sandboxed
 * command of a run whose server was killed before its host could stop it (a backgrounded writer, a
 * tmux server and its shells all keep the descriptor they inherited) — and its descendants, whatever
 * its parent or process group is now. Only the marker files are looked at, so a shell of the user's
 * that merely has its working directory in the folder is left alone. On Linux the sandbox's PID
 * namespace already ended the tree with bubblewrap, so there is nothing to kill. The hosts' temporary
 * folders (`relaySandboxHostRoot`) are removed too.
 *
 * Returns whether nothing a run left can still be running. When a process survived the sweeps, or
 * they could not tell, everything is kept as it is (the markers and folders by which the next start
 * finds it), and no permission is given back anywhere: a process still running could swap a folder
 * for a link meanwhile (`removeTree`). The caller then removes the open agents' leftovers without
 * restoring permissions either.
 */
export function clearRelaySandboxLeftovers(
  dataDir = DATA_DIR,
  platform: NodeJS.Platform = process.platform,
  /** The macOS sweeps, each true once nothing it looks for is left (swapped in tests). */
  sweeps: { byMarker: (markers: string[]) => boolean; bySandbox: (runTmps: string[]) => boolean } = {
    byMarker: sweepLeftoverProcesses,
    // Without the system's Python, run folders a killed server left cannot be told free: kept.
    bySandbox: (runTmps) => sweepRunSandboxes(runTmps, undefined, undefined, false),
  },
): boolean {
  const root = relaySandboxRoot(dataDir);
  let names: string[] = [];
  try {
    if (existsSync(root)) names = readdirSync(root);
  } catch {
    return false;
  }
  if (platform === 'darwin') {
    const byMarker = sweeps.byMarker(names.filter((n) => n.endsWith('.marker')).map((n) => join(root, n)));
    // And whatever is inside the sandbox of a run that left its folder, holding the marker or not.
    const bySandbox = sweeps.bySandbox(names.filter((n) => /^[0-9a-f]{16}$/.test(n)).map((n) => join(root, n)));
    if (!byMarker || !bySandbox) {
      console.warn(`[relay-sandbox] something a stopped run left may still be running: ${root} is kept as it is until the next start`);
      return false;
    }
  }
  // The hosts' temporary folders too (no sandboxed process can write them: only the hosts did).
  const hostRoot = relaySandboxHostRoot(dataDir);
  let hostNames: string[] = [];
  try {
    hostNames = readdirSync(hostRoot);
  } catch {
    /* none */
  }
  for (const path of [...names.map((n) => join(root, n)), ...hostNames.map((n) => join(hostRoot, n))]) {
    // One entry a run made hard to remove (chflags uchg, chmod 000) never stops the others.
    try {
      clearUserFlags(path, { tree: true });
      removeTree(path, { restore: true });
    } catch (err) {
      console.error(`[relay-sandbox] could not remove ${path}:`, (err as Error).message);
    }
  }
  return true;
}

/** Kills the holders of these marker files, and their descendants (macOS; `leftoverSweepPids`); true once none is left. */
function sweepLeftoverProcesses(markers: string[]): boolean {
  return sweepMarkers(markers);
}

/**
 * Kills the holders of these marker files and their descendants, a few rounds; true once none holds
 * them (or `lsof` cannot be run), false when one still does after the last round.
 */
function sweepMarkers(markers: string[]): boolean {
  if (!markers.length) return true;
  for (let attempt = 0; attempt < 6; attempt++) {
    const lsof = runSync('/usr/sbin/lsof', ['-n', '-P', '-t', '--', ...markers], { timeoutMs: 8000 });
    if (lsof.error) return false; // could not tell: keep the marker for the next start
    const ps = runSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { timeoutMs: 4000 });
    const pids = leftoverSweepPids(lsof.stdout ?? '', ps.stdout ?? '', process.pid);
    if (!pids.length) return true;
    if (attempt === 5) return false;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    sleepSync(100);
  }
  return false;
}

/** `sweepMarkers`, without blocking the server (a run's teardown). */
async function sweepMarkersAsync(markers: string[]): Promise<boolean> {
  if (!markers.length) return true;
  for (let attempt = 0; attempt < 6; attempt++) {
    const lsof = await runAsync('/usr/sbin/lsof', ['-n', '-P', '-t', '--', ...markers]);
    if (lsof.error) return false; // could not tell: keep the marker for the next start
    const ps = await runAsync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid=']);
    const pids = leftoverSweepPids(lsof.stdout ?? '', ps.stdout ?? '', process.pid);
    if (!pids.length) return true;
    if (attempt === 5) return false;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** How Node runs the host: with type stripping, quietly. */
export function hostArgs(features: { typescript?: unknown } = process.features as { typescript?: unknown }, host = RELAY_SANDBOX_HOST): string[] {
  // The bundled host is JavaScript; its source needs type stripping.
  const strip = host.endsWith('.ts') && !features.typescript ? ['--experimental-strip-types'] : [];
  return [...strip, '--disable-warning=ExperimentalWarning', host];
}

/** The host's own environment: nothing of the agent's (it gets that over its channel), no proxy, the system's PATH. */
export function hostEnv(ctx: Pick<RelaySandboxContext, 'home' | 'tools'>, hostTmp: string): NodeJS.ProcessEnv {
  const toolDirs = [ctx.tools.bwrap, ctx.tools.socat, ctx.tools.rg].filter((p): p is string => Boolean(p)).map((p) => dirname(p));
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set([...SYSTEM_PATH, ...toolDirs])].join(':'),
    HOME: ctx.home,
    TMPDIR: hostTmp,
    LANG: process.env.LANG || 'C.UTF-8',
  };
  for (const key of ['USER', 'LOGNAME', 'LC_ALL', 'LC_CTYPE']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** Why the sandbox cannot work here before trying it (the platform, its programs), or undefined. */
export function platformRefusal(ctx: Pick<RelaySandboxContext, 'platform' | 'arch' | 'tools'>): HostFailure | undefined {
  if (ctx.platform === 'win32') return { code: 'windows', detail: '' };
  if (ctx.tools.node === null) return { code: 'node', detail: '' };
  if (ctx.platform === 'darwin') {
    return existsSync('/usr/bin/sandbox-exec') ? undefined : { code: 'deps', detail: '/usr/bin/sandbox-exec not found' };
  }
  if (ctx.platform !== 'linux') return { code: 'platform', detail: ctx.platform };
  const missing = (['bwrap', 'socat', 'rg'] as const).filter((tool) => !ctx.tools[tool]);
  if (missing.length) {
    const names = { bwrap: 'bubblewrap (bwrap)', socat: 'socat', rg: 'ripgrep (rg)' };
    return { code: 'deps', detail: `${missing.map((m) => names[m]).join(', ')} not installed` };
  }
  if (ctx.arch !== 'x64' && ctx.arch !== 'arm64') return { code: 'seccomp', detail: ctx.arch };
  return undefined;
}

function refusalText(f: HostFailure, ctx: Pick<RelaySandboxContext, 'platform' | 'arch'>): string {
  if (f.code === 'windows') return t().relaySandboxWindows;
  if (f.code === 'node') return t().relaySandboxNoNode;
  if (f.code === 'platform') return t().relaySandboxPlatform(f.detail);
  return failureText(f, ctx.platform, ctx.arch);
}

/** The node binary, the host and sandbox-runtime: what the host runs outside the sandbox. */
function hostPrograms(ctx: Pick<RelaySandboxContext, 'tools' | 'relayRoot'>): string[] {
  const t = ctx.tools;
  return [
    hostNode(ctx),
    RELAY_SANDBOX_HOST,
    sandboxRuntimeDir() ?? join(ctx.relayRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime'),
    t.sh,
    t.bash,
    ...[t.bwrap, t.socat, t.rg].filter((p): p is string => Boolean(p)),
  ];
}

const PROBE_EXPECT = 'relay-sandbox-ok';
const PROBE_TTL_OK_MS = 5 * 60_000;
const PROBE_TTL_FAILED_MS = 15_000;
const probeCache = new Map<string, { at: number; result: HostFailure | undefined; ttl: number }>();
const probing = new Map<string, Promise<HostFailure | undefined>>();

/** Forget the last checks (tests; or after installing what was missing). */
export function resetSandboxAvailability(): void {
  probeCache.clear();
}

/**
 * Starts a sandbox for a trivial command, the way a run does (sandbox-runtime, its proxy, on Linux
 * bubblewrap, its network bridge and the seccomp helper), and reports why it did not work.
 */
async function probe(ctx: RelaySandboxContext): Promise<HostFailure | undefined> {
  const dirs = makeRunDirs(ctx.dataDir);
  const paths = { allowWrite: withReal([dirs.tmp]), denyWrite: withReal(srtDefaultWrites(ctx.home)), denyRead: [], allowRead: [] };
  const hosts = { allowed: ['relay-sandbox-probe.invalid'], denied: [], quietReasons: {}, loopback: false, loopbackPorts: [] };
  const run = new RelaySandboxRun(
    dirs,
    {
      srt: relaySandboxConfig(paths, hosts, ctx),
      command: `printf '%s\\n' ${PROBE_EXPECT}`,
      binShell: ctx.tools.bash,
      outerEnv: { PATH: SYSTEM_PATH.join(':'), HOME: ctx.home },
      tmpdir: dirs.tmp,
      probe: { expect: PROBE_EXPECT },
    },
    { localAddresses: ctx.localAddresses, platform: ctx.platform, arch: ctx.arch },
  );
  try {
    const res = await runProcess({
      bin: hostNode(ctx),
      args: hostArgs(),
      cwd: dirs.tmp,
      env: hostEnv(ctx, dirs.hostTmp),
      channel: run.attach,
      timeoutMs: 30_000,
      maxCapture: 1024,
    });
    if (run.probeOk) return undefined;
    return run.hostFailure() ?? { code: 'probe', detail: (res.stderr.trim() || `exit ${res.code}`).slice(-600) };
  } catch (err) {
    return { code: 'probe', detail: (err as Error).message };
  } finally {
    await run.dispose();
  }
}

/**
 * Whether Harness Relay's own sandbox can start on this computer: the platform, the programs it
 * needs, and a real sandbox for a trivial command. The result is kept for a while (shorter when it
 * failed), and translated each time it is asked for.
 */
export async function sandboxAvailable(ctx: RelaySandboxContext = relaySandboxContext()): Promise<SandboxAvailability> {
  const before = platformRefusal(ctx);
  if (before) return { ok: false, reason: refusalText(before, ctx) };
  const tooLong = hostTmpRefusal(ctx.dataDir, ctx.platform);
  if (tooLong) return { ok: false, reason: tooLong };
  const key = JSON.stringify([ctx.platform, ctx.arch, ctx.tools, ctx.dataDir]);
  const cached = probeCache.get(key);
  let result: HostFailure | undefined;
  if (cached && Date.now() - cached.at < cached.ttl) result = cached.result;
  else {
    let running = probing.get(key);
    if (!running) {
      running = probe(ctx).finally(() => probing.delete(key));
      probing.set(key, running);
    }
    result = await running;
    probeCache.set(key, { at: Date.now(), result, ttl: result ? PROBE_TTL_FAILED_MS : PROBE_TTL_OK_MS });
  }
  return result ? { ok: false, reason: refusalText(result, ctx) } : { ok: true };
}

/**
 * The command that runs `bin args` with `env` in a sandbox for `spec`. Refuses (throws an
 * `AgentRunError` with the reason, in the user's language) when the sandbox cannot start here, or the
 * spec would leave a hole (`relaySandboxRefusal`, `relaySandboxHosts`); the host itself fails closed
 * too, before it starts anything, when sandbox-runtime cannot apply the rules.
 *
 * Run what it returns with `runProcess` (passing `channel`, or the `env` it returned), then call
 * `dispose()`. When the process ended without the agent's answer, `failure()` says why when the
 * sandbox was the reason.
 */
export async function sandboxCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spec: RelaySandboxSpec,
  o: { ctx?: RelaySandboxContext; available?: (ctx: RelaySandboxContext) => Promise<SandboxAvailability> } = {},
): Promise<RelaySandboxCommand> {
  if ((spec.permission as string) === 'full') throw new Error('full access runs without the relay sandbox');
  const ctx = o.ctx ?? relaySandboxContext();
  const available = await (o.available ?? sandboxAvailable)(ctx);
  if (!available.ok) throw new AgentRunError(available.reason);
  const found = commandPaths(bin, env, ctx.platform);
  if (!found.length) throw new CommandNotFoundError(bin);
  const programs = hostPrograms(ctx);
  const refusal = relaySandboxRefusal(spec, ctx, { bins: found, programs: [...programs, ...found] });
  if (refusal) throw new AgentRunError(refusal);
  const hosts = relaySandboxHosts([...spec.allowedHosts, ...relaySandboxConnectPorts(spec.connectPorts)], ctx, spec.quietlyDeniedHosts);
  const localPorts = relaySandboxLocalPorts(spec.localPorts, ctx, hosts.allowed);
  const dirs = spec.dirs ?? makeRunDirs(ctx.dataDir);
  let run: RelaySandboxRun;
  try {
    const paths = relaySandboxPaths(spec, ctx, { ...dirs, programs: found });
    const loopbackRelay = ctx.platform === 'linux' && ctx.tools.socat && hosts.loopbackPorts.length ? { socat: ctx.tools.socat, ports: hosts.loopbackPorts } : undefined;
    const { outerEnv, command } = relaySandboxEnv(found[0]!, args, env, { tmp: dirs.tmp, loopback: hosts.loopback, localPorts, loopbackRelay });
    run = new RelaySandboxRun(
      dirs,
      {
        srt: relaySandboxConfig(paths, hosts, ctx, {
          allowPty: spec.allowPty,
          allowTlsTrustd: spec.allowTlsTrustd,
          localPorts,
          unixSocketDir: spec.allowUnixSocketsInTmp ? dirs.tmp : undefined,
        }),
        command,
        binShell: ctx.tools.bash,
        outerEnv,
        tmpdir: dirs.tmp,
        localPorts,
        // macOS: connected to directly as well (Linux relays them instead, `loopbackRelay`).
        ...(ctx.platform === 'darwin' && hosts.loopbackPorts.length ? { loopbackPorts: hosts.loopbackPorts } : {}),
        ...(dirs.marker ? { marker: dirs.marker } : {}),
      },
      { requestApproval: spec.requestApproval, localAddresses: ctx.localAddresses, platform: ctx.platform, arch: ctx.arch },
    );
  } catch (err) {
    removeRunDirs(dirs);
    throw err;
  }
  const hostEnvironment = hostEnv(ctx, dirs.hostTmp);
  Object.defineProperty(hostEnvironment, CONTROL_CHANNEL, { value: run.attach, enumerable: true });
  return {
    bin: hostNode(ctx),
    args: hostArgs(),
    env: hostEnvironment,
    channel: run.attach,
    failure: () => run.failure(),
    dispose: () => run.dispose(),
    run,
  };
}
