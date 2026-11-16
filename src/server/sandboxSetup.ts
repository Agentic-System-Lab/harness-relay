import { accessSync, constants, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { SandboxNeedView, SandboxSetupBlock, SandboxSetupView, SandboxUser } from '../shared/types';
import { INSTALL_CACHE, InstallError, InstallJob, installerEnv, nodeBuildFor, nodeTools, putNode, runStep, type CliInstallHost, type NodeBuild } from './cliInstall';
import { HttpError } from './errors';
import { t } from './i18n';
import { runProcess, runShellScript, runSync } from './process';
import { pathHostNode, sandboxNode, sandboxNodeFolder } from './relaySandbox';

/*
 * What the agents' OS sandboxes need that this computer lacks, and installing it, from Settings →
 * Sandboxes and from the dialog that New chat opens while something is missing (`SandboxSetupView`).
 *
 * - macOS: the sandboxes are Seatbelt's, part of macOS. Only the desktop app, whose runtime is not
 *   plain Node, needs a Node.js for Harness Relay's own sandbox (the open agents') when none is on the
 *   login shell's PATH: Node.js's own build, as a CLI's install puts it in (`putNode`), into
 *   `sandboxNodeFolder()`, which the relay sandbox then runs its host on (`relaySandboxTools`).
 * - Linux: the packages the sandboxes run (bubblewrap for Claude Code, Codex, Grok's deny lists,
 *   Copilot and Harness Relay's own; socat for Claude Code and Harness Relay's own; ripgrep for
 *   Harness Relay's own; slirp4netns, iproute2, iptables and util-linux for Copilot's), with the
 *   system's package manager (apt, dnf, pacman, zypper); on Ubuntu 23.10 or later, which keeps
 *   programs from making user namespaces, the AppArmor profile Claude Code's docs give for
 *   `/usr/bin/bwrap`; and in the desktop app the Node.js above. The packages and the profile take
 *   administrator rights: as root, through sudo when it asks no password, or through pkexec, whose
 *   prompt the desktop shows (`adminWay`). Both go in one run of a fixed script (`ADMIN_SCRIPT`), so
 *   that the password is asked once; what it installs is in its environment. Without a way to get
 *   those rights here, each need says what to run in a terminal.
 * - Windows: nothing Harness Relay can install helps (Codex's and Copilot's sandboxes need nothing,
 *   Muse Code's setup is not used by its ACP mode, the others have none there).
 */

/** The package managers Harness Relay installs with, by the program it finds. */
export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper';
const PACKAGE_MANAGERS: readonly { pm: PackageManager; program: string }[] = [
  { pm: 'apt', program: 'apt-get' },
  { pm: 'dnf', program: 'dnf' },
  { pm: 'pacman', program: 'pacman' },
  { pm: 'zypper', program: 'zypper' },
];

/** One Linux package the sandboxes need: the programs that tell it is there, its name for each package manager, and whose sandboxes run it. */
export interface LinuxNeed {
  programs: readonly string[];
  pkg: string | Readonly<Record<PackageManager, string>>;
  for: readonly SandboxUser[];
}

/** What the sandboxes run on Linux (docs/sandboxing.md, Linux). */
export const LINUX_NEEDS: readonly LinuxNeed[] = [
  { programs: ['bwrap'], pkg: 'bubblewrap', for: ['claude', 'codex', 'grok', 'copilot', 'open'] },
  { programs: ['socat'], pkg: 'socat', for: ['claude', 'open'] },
  { programs: ['rg'], pkg: 'ripgrep', for: ['open'] },
  { programs: ['slirp4netns'], pkg: 'slirp4netns', for: ['copilot'] },
  { programs: ['ip'], pkg: { apt: 'iproute2', dnf: 'iproute', pacman: 'iproute2', zypper: 'iproute2' }, for: ['copilot'] },
  {
    programs: ['iptables', 'ip6tables', 'iptables-restore', 'ip6tables-restore'],
    pkg: { apt: 'iptables', dnf: 'iptables-nft', pacman: 'iptables', zypper: 'iptables' },
    for: ['copilot'],
  },
  { programs: ['unshare', 'nsenter'], pkg: 'util-linux', for: ['copilot'] },
];

/** A package's name for `pm` (Debian's when there is no package manager Harness Relay knows). */
const packageName = (n: LinuxNeed, pm: PackageManager | undefined) => (typeof n.pkg === 'string' ? n.pkg : n.pkg[pm ?? 'apt']);

/** Where the programs are looked for besides the PATH: the system's folders, the administrator's included. */
const SYSTEM_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

/** The PATH the administrator's script runs with: the system's folders only. */
const ADMIN_PATH = SYSTEM_DIRS.join(':');

/** Whether programs may make user namespaces only when AppArmor lets them (Ubuntu 23.10 and later): `1`. */
export const USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const APPARMOR_DIR = '/etc/apparmor.d';
/** The AppArmor profile Harness Relay adds, beside any of the user's own. */
export const APPARMOR_FILE = '/etc/apparmor.d/harness-relay-bwrap';
/** Claude Code's docs' profile for `/usr/bin/bwrap`, under a name of its own: bubblewrap may make user namespaces, and nothing else changes. */
export const APPARMOR_PROFILE = [
  'abi <abi/4.0>,',
  'include <tunables/global>',
  '',
  'profile harness-relay-bwrap /usr/bin/bwrap flags=(unconfined) {',
  '  userns,',
  '',
  '  include if exists <local/harness-relay-bwrap>',
  '}',
].join('\n');

/** Whether an AppArmor profile's text lets `/usr/bin/bwrap` make user namespaces (Claude Code's docs' `bwrap`, or Harness Relay's). */
export const letsBwrap = (text: string) => /\/usr\/bin\/bwrap\b/.test(text) && /^\s*userns\b/m.test(text);

/** The exit code `ADMIN_SCRIPT` gives for its own 126 or 127 (a command it runs that cannot run, or is not there), which pkexec keeps for its prompt. */
export const SCRIPT_CANNOT_RUN = 125;

/**
 * What runs with administrator rights, fixed text: the packages (`HARNESS_RELAY_PACKAGES`, with the
 * package manager `HARNESS_RELAY_PM`; apt waits up to two minutes for its lock, which unattended
 * upgrades may hold, and updates its lists only when a package cannot be found), then the AppArmor
 * profile (`HARNESS_RELAY_APPARMOR` into `HARNESS_RELAY_APPARMOR_FILE`, loaded with `apparmor_parser`)
 * unless a profile for `/usr/bin/bwrap` that allows user namespaces is there by then. Each command it
 * runs is printed (`set -x`). It ends with its body's exit code, but `SCRIPT_CANNOT_RUN` for 126 and
 * 127, which pkexec gives when its prompt was dismissed or not allowed.
 */
export const ADMIN_SCRIPT = [
  'install() {',
  '  set -eu',
  '  set -x',
  '  if [ -n "$HARNESS_RELAY_PACKAGES" ]; then',
  '    case "$HARNESS_RELAY_PM" in',
  '      apt)',
  '        export DEBIAN_FRONTEND=noninteractive',
  // An `if`, not `a || { b && c; }`, in which a failing `b` would not stop the script (`-e` is ignored there).
  '        if ! apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends $HARNESS_RELAY_PACKAGES; then',
  '          apt-get -o DPkg::Lock::Timeout=120 update',
  '          apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends $HARNESS_RELAY_PACKAGES',
  '        fi ;;',
  '      dnf) dnf install -y $HARNESS_RELAY_PACKAGES ;;',
  '      pacman) pacman -S --needed --noconfirm $HARNESS_RELAY_PACKAGES ;;',
  '      zypper) zypper --non-interactive install $HARNESS_RELAY_PACKAGES ;;',
  '      *) echo "No package manager Harness Relay knows" >&2; exit 2 ;;',
  '    esac',
  '  fi',
  '  if [ -n "$HARNESS_RELAY_APPARMOR" ]; then',
  '    found=',
  '    for f in /etc/apparmor.d/*; do',
  '      if [ -f "$f" ] && grep -q /usr/bin/bwrap "$f" && grep -Eq "^[[:space:]]*userns" "$f"; then found=1; fi',
  '    done',
  '    if [ -z "$found" ]; then',
  '      printf "%s\\n" "$HARNESS_RELAY_APPARMOR" > "$HARNESS_RELAY_APPARMOR_FILE"',
  '      apparmor_parser -r "$HARNESS_RELAY_APPARMOR_FILE"',
  '    fi',
  '  fi',
  '}',
  '( install )',
  'code=$?',
  'case "$code" in 126|127) exit 125 ;; esac',
  'exit "$code"',
].join('\n');

/** Package names as package managers spell them: nothing a shell would read otherwise (the script splits the list on spaces). */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]*$/;

/** What the setup needs from the computer; tests swap in fakes. */
export interface SandboxSetupHost extends Pick<CliInstallHost, 'platform' | 'arch' | 'env' | 'isFile' | 'run' | 'runScript' | 'nodeBuild'> {
  /** The desktop app (Electron), whose runtime cannot run Harness Relay's own sandbox's host. */
  electron: boolean;
  /** The server's user id (0: root); undefined on Windows. */
  uid: number | undefined;
  /** Whether a path is a file that may be run. */
  isProgram: (path: string) => boolean;
  /** A small file's text (`/proc`, AppArmor profiles), or undefined. */
  read: (path: string) => string | undefined;
  /** A folder's entries, or none. */
  list: (dir: string) => string[];
  /** Whether sudo runs without asking for a password (`sudo -n true`). */
  sudoWorks: (sudo: string) => boolean;
  /** A Node.js on the PATH the relay sandbox's host can run on (`pathHostNode`). */
  pathNode: () => string | null;
  /** The Node.js Harness Relay put in `nodeDir`, or null (`sandboxNode`). */
  installedNode: () => string | null;
  /** Where that Node.js goes (`sandboxNodeFolder`). */
  nodeDir: string;
}

function isProgram(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readSmall(p: string): string | undefined {
  try {
    const st = statSync(p);
    // `/proc` files say they are empty; AppArmor profiles are small.
    return st.isFile() && st.size <= 256 * 1024 ? readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** How long a `sudo -n true` answer is kept: it changes only when the user changes sudo's settings or signs in again. */
const SUDO_CHECK_MS = 60_000;

export class SandboxSetup {
  private host: SandboxSetupHost;
  private job?: InstallJob;
  /** What the setup under way does: the administrator's step cannot be stopped safely (`cancel`). */
  private stage?: 'node' | 'admin';
  private sudoChecked?: { sudo: string; at: number; ok: boolean };

  constructor(
    private hooks: {
      /** Something was installed (or an install ended): the CLIs' status is asked again. */
      changed?: () => void;
    } = {},
    host: Partial<SandboxSetupHost> = {},
  ) {
    this.host = {
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      electron: Boolean(process.versions.electron),
      uid: process.getuid?.(),
      isFile: (p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      },
      isProgram,
      read: readSmall,
      list,
      run: runProcess,
      runScript: runShellScript,
      sudoWorks: (sudo) => runSync(sudo, ['-n', 'true'], { timeoutMs: 5000, quiet: true }).status === 0,
      pathNode: () => pathHostNode(this.host.env.PATH ?? ''),
      installedNode: () => sandboxNode(),
      nodeDir: sandboxNodeFolder(),
      nodeBuild: () => nodeBuildFor(this.host.platform, this.host.arch, this.host.isFile),
      ...host,
    };
  }

  /** What is missing here, what installs each, and the install under way or the last one. */
  view(): SandboxSetupView {
    const needs = this.needs();
    const admin = needs.some((n) => n.kind !== 'node') ? this.adminWay() : undefined;
    const running = this.job?.state === 'running';
    return {
      platform: this.host.platform,
      needs,
      ...(admin ? { admin } : {}),
      ...(this.job ? { job: this.job.view() } : {}),
      ...(running ? { cancellable: this.stage !== 'admin' } : {}),
    };
  }

  /** Whether the setup is under way (the desktop app's update waits for it, as for the CLIs' installs). */
  running(): number {
    return this.job?.state === 'running' ? 1 : 0;
  }

  /** Starts installing everything missing that can be installed here, in the background; its view says how it goes. */
  install(): SandboxSetupView {
    if (this.job?.state === 'running') throw new HttpError(409, t().sandboxSetupRunning);
    const needs = this.needs().filter((n) => !n.blocked);
    if (!needs.length) throw new HttpError(400, t().sandboxSetupNothing);
    const job = new InstallJob();
    this.job = job;
    job.ended = this.runJob(job, needs);
    return this.view();
  }

  /**
   * Stops the setup under way, while it downloads Node.js. Not once the administrator's step runs: a
   * package manager stopped halfway leaves its database to repair (dpkg "was interrupted"), and
   * through pkexec it runs as root, out of reach of a signal; pkexec's own prompt has its Cancel.
   */
  cancel(): SandboxSetupView {
    if (this.job?.state !== 'running') throw new HttpError(409, t().sandboxSetupNone);
    if (this.stage === 'admin') throw new HttpError(409, t().sandboxSetupCannotStop);
    this.job.abort.abort();
    return this.view();
  }

  /** Stops the setup under way (the server is stopping); settles once it ended. */
  shutdown(): Promise<void> {
    const job = this.job;
    if (job?.state !== 'running') return Promise.resolve();
    job.abort.abort();
    return job.ended;
  }

  private find(name: string): string | undefined {
    const path = (this.host.env.PATH ?? '').split(':').filter((d) => posix.isAbsolute(d));
    for (const dir of [...SYSTEM_DIRS, ...path]) {
      const p = posix.join(dir, name);
      if (this.host.isProgram(p)) return p;
    }
    return undefined;
  }

  private packageManager(): PackageManager | undefined {
    return PACKAGE_MANAGERS.find((m) => this.find(m.program))?.pm;
  }

  /**
   * How an install gets administrator rights here: as root; through sudo when it asks no password;
   * through pkexec when the server runs in a desktop session, whose password prompt it shows.
   */
  private adminWay(): SandboxSetupView['admin'] {
    if (this.host.uid === 0) return 'root';
    const sudo = this.find('sudo');
    if (sudo) {
      const at = Date.now();
      if (!this.sudoChecked || this.sudoChecked.sudo !== sudo || at - this.sudoChecked.at > SUDO_CHECK_MS) {
        this.sudoChecked = { sudo, at, ok: this.host.sudoWorks(sudo) };
      }
      if (this.sudoChecked.ok) return 'sudo';
    }
    const env = this.host.env;
    const desktop = Boolean(env.WAYLAND_DISPLAY || env.DISPLAY) || /^(x11|wayland)$/i.test(env.XDG_SESSION_TYPE ?? '');
    return this.find('pkexec') && desktop ? 'pkexec' : undefined;
  }

  /** Whether AppArmor keeps bubblewrap from making user namespaces here, with no profile that lets it. */
  private apparmorNeeded(): boolean {
    if (this.host.read(USERNS_RESTRICTION)?.trim() !== '1' || !this.find('apparmor_parser')) return false;
    return !this.host.list(APPARMOR_DIR).some((name) => letsBwrap(this.host.read(posix.join(APPARMOR_DIR, name)) ?? ''));
  }

  /** What the sandboxes need that is missing here, in the order an install puts them in. */
  needs(): SandboxNeedView[] {
    const { platform } = this.host;
    const needs: SandboxNeedView[] = [];
    // The desktop app's Node.js for Harness Relay's own sandbox (no root: first).
    if (this.host.electron && (platform === 'darwin' || platform === 'linux') && !this.host.pathNode() && !this.host.installedNode()) {
      const tools = nodeTools(this.host);
      const build = typeof tools === 'string' ? undefined : tools.build;
      const blocked: SandboxSetupBlock | undefined = typeof tools === 'string' ? (tools === 'curl' || tools === 'tar' ? tools : 'node') : undefined;
      needs.push({
        kind: 'node',
        items: build ? [build.version] : [],
        for: ['open'],
        command: build ? nodeCommand(build, this.host.nodeDir, platform) : '',
        ...(blocked ? { blocked } : {}),
      });
    }
    if (platform !== 'linux') return needs;
    const pm = this.packageManager();
    const missing = LINUX_NEEDS.filter((n) => n.programs.some((p) => !this.find(p)));
    const admin = this.adminWay();
    const adminBlock: SandboxSetupBlock | undefined = admin ? undefined : 'admin';
    if (missing.length) {
      const packages = [...new Set(missing.map((n) => packageName(n, pm)))];
      const command = pm
        ? { apt: `sudo apt-get install -y ${packages.join(' ')}`, dnf: `sudo dnf install -y ${packages.join(' ')}`, pacman: `sudo pacman -S --needed ${packages.join(' ')}`, zypper: `sudo zypper install ${packages.join(' ')}` }[pm]
        : packages.join(' ');
      const blocked = pm ? adminBlock : 'packageManager';
      needs.push({ kind: 'packages', items: packages, for: users(missing.flatMap((n) => n.for)), command, ...(blocked ? { blocked } : {}) });
    }
    if (this.apparmorNeeded()) {
      const command = `sudo tee ${APPARMOR_FILE} > /dev/null <<'EOF'\n${APPARMOR_PROFILE}\nEOF\nsudo apparmor_parser -r ${APPARMOR_FILE}`;
      needs.push({ kind: 'apparmor', items: [APPARMOR_FILE], for: ['claude', 'codex', 'grok', 'copilot', 'open'], command, ...(adminBlock ? { blocked: adminBlock } : {}) });
    }
    return needs;
  }

  private async runJob(job: InstallJob, needs: SandboxNeedView[]): Promise<void> {
    const base = installerEnv(this.host.env);
    try {
      if (needs.some((n) => n.kind === 'node')) {
        this.stage = 'node';
        await this.installNode(job, base);
      }
      const admin = needs.filter((n) => n.kind === 'packages' || n.kind === 'apparmor');
      if (admin.length && !job.abort.signal.aborted) {
        this.stage = 'admin';
        await this.runAdmin(job, admin, base);
      }
      if (job.abort.signal.aborted) throw new Error('aborted');
      // What it was to install, checked again.
      const left = this.needs().filter((n) => needs.some((m) => m.kind === n.kind));
      if (left.length) {
        const items = left.flatMap((n) => (n.kind === 'packages' ? n.items : n.kind === 'apparmor' ? n.items : [`Node.js ${n.items[0] ?? ''}`.trim()]));
        throw new InstallError(() => t().sandboxSetupStillMissing(items.join(', ')));
      }
      job.finish('success');
    } catch (err) {
      if (job.abort.signal.aborted) job.finish('cancelled', () => t().cliInstallCancelled);
      else job.finish('failed', err instanceof InstallError ? err.render : () => (err as Error).message);
    } finally {
      this.stage = undefined;
      this.hooks.changed?.();
    }
  }

  /** Node.js's build into `nodeDir`, as a CLI's install puts it in its folder; nothing of it stays when that fails. */
  private async installNode(job: InstallJob, base: NodeJS.ProcessEnv): Promise<void> {
    const dir = this.host.nodeDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    mkdirSync(dir, { recursive: true });
    try {
      await putNode(this.host, job, dir, base, 'Node.js', (version) => `Harness Relay's own sandbox finds no Node.js on the PATH: Node.js ${version} goes into ${dir}`);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      throw err;
    } finally {
      rmSync(join(dir, INSTALL_CACHE), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }

  /** The packages and the AppArmor profile, in one run of `ADMIN_SCRIPT` with administrator rights (one password prompt at most). */
  private async runAdmin(job: InstallJob, needs: SandboxNeedView[], base: NodeJS.ProcessEnv): Promise<void> {
    const admin = this.adminWay();
    if (!admin) throw new InstallError(() => t().sandboxSetupNoAdmin);
    const pm = this.packageManager();
    const packages = needs.find((n) => n.kind === 'packages')?.items ?? [];
    if (packages.some((p) => !PACKAGE_NAME.test(p))) throw new Error(`Not a package name: ${packages.join(' ')}`);
    const apparmor = needs.some((n) => n.kind === 'apparmor');
    const vars: Record<string, string> = {
      PATH: ADMIN_PATH,
      HARNESS_RELAY_PM: pm ?? '',
      HARNESS_RELAY_PACKAGES: packages.join(' '),
      HARNESS_RELAY_APPARMOR: apparmor ? APPARMOR_PROFILE : '',
      HARNESS_RELAY_APPARMOR_FILE: APPARMOR_FILE,
    };
    const what = [
      ...(packages.length ? [`${PACKAGE_MANAGERS.find((m) => m.pm === pm)?.program ?? pm} install ${packages.join(' ')}`] : []),
      ...(apparmor ? [`${APPARMOR_FILE}, apparmor_parser -r`] : []),
    ].join('; ');
    const shown = `${admin === 'root' ? '' : `${admin} `}${what}`;
    if (admin === 'pkexec') job.append('Asking for the administrator password: the desktop shows its prompt\n');
    try {
      if (admin === 'root') {
        await runStep(this.host, job, shown, { bin: this.find('sh') ?? '/bin/sh', args: [], env: { ...base, ...vars } }, ADMIN_SCRIPT);
      } else {
        // sudo and pkexec give the script their own environment: `env` sets what it works on.
        const via = this.find(admin)!;
        const args = [...(admin === 'sudo' ? ['-n'] : []), this.find('env') ?? '/usr/bin/env', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), '/bin/sh', '-c', ADMIN_SCRIPT];
        await runStep(this.host, job, shown, { bin: via, args, env: base });
      }
    } catch (err) {
      // pkexec: 126 when the prompt was dismissed, 127 when not allowed or no prompt could be shown.
      if (admin === 'pkexec' && err instanceof InstallError && (err.code === 126 || err.code === 127)) throw new InstallError(() => t().sandboxSetupAdminRefused, err.code);
      throw err;
    }
  }
}

/**
 * Putting Node.js's build into `dir` by hand, as the setup does: downloaded, its checksum checked
 * (`shasum` on macOS, `sha256sum` on Linux), Node and npm taken out of it. The folder quoted: the
 * desktop app's data folder has a space in it.
 */
export function nodeCommand(build: NodeBuild, dir: string, platform: NodeJS.Platform): string {
  const check = platform === 'darwin' ? 'shasum -a 256 -c -' : 'sha256sum -c -';
  return [
    `curl -fsSLO ${build.url}`,
    `echo "${build.sha256}  ${build.file}" | ${check}`,
    `mkdir -p "${dir}"`,
    `tar -xf ${build.file} -C "${dir}" --strip-components 1 ${build.members.join(' ')}`,
  ].join(' && ');
}

/** The users of what is missing, each once, in a fixed order. */
function users(list: readonly SandboxUser[]): SandboxUser[] {
  const order: SandboxUser[] = ['claude', 'codex', 'grok', 'copilot', 'open'];
  return order.filter((u) => list.includes(u));
}
