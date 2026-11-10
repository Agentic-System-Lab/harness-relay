/**
 * Sharing the server with the user's tailnet, for their phone (docs/remote-access.md): the same
 * `tailscale serve --bg <port>` the guide has people type, run from the app's menu.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { capture, type SpawnResult } from '../../src/server/process';

/** The tailscale command: on PATH, or where the Tailscale apps put it. */
export function findTailscale(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const name = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const sep = platform === 'win32' ? ';' : ':';
  // Windows paths keep their own separators, so the parts are joined with `\` there.
  const joinDir = (dir: string) => (platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : join(dir, name));
  for (const dir of (env.PATH ?? '').split(sep).filter(Boolean)) {
    const candidate = joinDir(dir);
    if (exists(candidate)) return candidate;
  }
  const known =
    platform === 'darwin'
      ? // The Mac app (standalone or App Store) answers the CLI's commands itself.
        ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
      : platform === 'win32'
        ? [`${env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`]
        : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'];
  return known.find((p) => exists(p));
}

export interface TailscaleStatus {
  /** Signed in and connected. */
  running: boolean;
  /** This computer's name in the tailnet (MagicDNS), such as my-computer.tail1234.ts.net. */
  dnsName?: string;
}

/** Reads `tailscale status --json`. */
export function parseStatus(json: string): TailscaleStatus {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string } };
    const dnsName = s.Self?.DNSName?.trim().replace(/\.$/, '').toLowerCase() || undefined;
    return { running: s.BackendState === 'Running', dnsName };
  } catch {
    return { running: false };
  }
}

/** Whether a serve handler's target is this computer's `port`. */
function proxiesTo(target: string, port: number): boolean {
  const m = /^(?:https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])?:?(\d+)\/?$/.exec(target.trim());
  return !!m && Number(m[2]) === port;
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  /** `<name>:<port>` published to the internet (Funnel). */
  AllowFunnel?: Record<string, boolean>;
}

function serveConfig(json: string): ServeConfig | undefined {
  try {
    const config = JSON.parse(json) as ServeConfig | null;
    return config && typeof config === 'object' ? config : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address the tailnet reaches `port` at, from `tailscale serve status --json`, or undefined when
 * the port is not shared. The configuration lists each `<name>:<https port>` with its handlers.
 */
export function servedUrl(json: string, port: number): string | undefined {
  for (const [hostPort, web] of Object.entries(serveConfig(json)?.Web ?? {})) {
    const root = web?.Handlers?.['/'];
    if (!root?.Proxy || !proxiesTo(root.Proxy, port)) continue;
    const host = hostPort.replace(/:443$/, '').toLowerCase();
    return `https://${host}`;
  }
  return undefined;
}

/** The HTTPS ports tried for sharing, in order: Tailscale's usual ones. */
export const HTTPS_PORTS = [443, 8443, 10000] as const;

/**
 * Where to share `port` without taking over what the computer already shares: the first HTTPS port
 * whose `/` nothing else uses, and that is not published to the internet (Funnel: sharing it again
 * for the tailnet only would turn Funnel off for it). Undefined when they are all taken (the user
 * then shares by hand).
 */
export function freeHttpsPort(json: string, port: number): number | undefined {
  const config = serveConfig(json) ?? {};
  return HTTPS_PORTS.find((https) => {
    const tcp = config.TCP?.[String(https)];
    if (tcp?.TCPForward) return false; // the whole port goes elsewhere
    if (Object.entries(config.AllowFunnel ?? {}).some(([hostPort, on]) => on && hostPort.endsWith(`:${https}`))) return false;
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      if (!hostPort.endsWith(`:${https}`)) continue;
      const root = web?.Handlers?.['/'];
      if (root && !(root.Proxy && proxiesTo(root.Proxy, port))) return false;
    }
    return true;
  });
}

/** A page of Tailscale's that the user must open (to turn Serve or HTTPS on), from a command's output. */
export function tailscaleLink(output: string): string | undefined {
  for (const m of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(m[0]);
      if (url.hostname === 'login.tailscale.com' || url.hostname === 'tailscale.com') return url.href;
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

export type ShareResult =
  | { kind: 'shared'; url?: string }
  /** Serve or HTTPS has to be turned on for the tailnet first, on this page. */
  | { kind: 'needs-approval'; link: string }
  /** On Linux, changing Tailscale's settings takes root, or `tailscale set --operator=$USER`. */
  | { kind: 'access-denied'; output: string }
  | { kind: 'failed'; output: string };

/** What `tailscale serve --bg <port>` did, from its exit and its output. */
export function shareOutcome(r: Pick<SpawnResult, 'code' | 'stdout' | 'stderr' | 'timedOut'>): ShareResult {
  const output = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 0 && !r.timedOut) {
    const url = /https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/i.exec(output)?.[0]?.toLowerCase();
    return { kind: 'shared', url };
  }
  const link = tailscaleLink(output);
  if (link) return { kind: 'needs-approval', link };
  if (/access denied|permission denied|operator/i.test(output)) return { kind: 'access-denied', output };
  return { kind: 'failed', output: output || (r.timedOut ? 'timed out' : `exit code ${r.code}`) };
}

/** The tailscale command, with the environment the app runs the CLIs in. */
export class Tailscale {
  private timeouts: { query: number; share: number };

  constructor(
    readonly bin: string,
    private env: NodeJS.ProcessEnv,
    timeouts: { query?: number; share?: number } = {},
  ) {
    this.timeouts = { query: timeouts.query ?? 8000, share: timeouts.share ?? 20_000 };
  }

  async status(): Promise<TailscaleStatus> {
    try {
      const r = await capture(this.bin, ['status', '--json'], this.env, { timeoutMs: this.timeouts.query, maxCapture: 4 * 1024 * 1024 });
      return parseStatus(r.stdout);
    } catch {
      return { running: false };
    }
  }

  /** `tailscale serve status --json`, or undefined when it cannot be read. */
  async serveStatus(): Promise<string | undefined> {
    try {
      const r = await capture(this.bin, ['serve', 'status', '--json'], this.env, { timeoutMs: this.timeouts.query });
      return r.code === 0 ? r.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  async servedUrl(port: number): Promise<string | undefined> {
    const json = await this.serveStatus();
    return json === undefined ? undefined : servedUrl(json, port);
  }

  /**
   * Shares `port` over HTTPS in the tailnet, on `https` (443 unless something else is shared there);
   * the sharing stays on across restarts (`--bg`).
   */
  async share(port: number, https = 443): Promise<ShareResult> {
    try {
      // When Serve is not enabled yet, the command prints a link and waits: it is stopped after a while.
      const args = ['serve', '--bg', ...(https === 443 ? [] : [`--https=${https}`]), String(port)];
      const r = await capture(this.bin, args, this.env, { timeoutMs: this.timeouts.share });
      return shareOutcome(r);
    } catch (err) {
      return { kind: 'failed', output: (err as Error).message };
    }
  }
}
