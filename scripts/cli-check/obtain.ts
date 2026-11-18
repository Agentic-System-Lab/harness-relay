/**
 * Getting one version of a CLI apart, into a folder of its own, for `scripts/cli-check.ts --bin`: from
 * where its maker publishes it (npm, PyPI through uv, GitHub's releases, the downloads its own installer
 * fetches), never by running its installer script (they edit shell profiles, and some update themselves),
 * with its checksum checked where its maker publishes one (Antigravity's SHA-512, Muse Code's SHA-256;
 * npm checks its own). Used by the CLI versions workflow's checks on Linux, and by hand.
 *
 * `artifactFor()` says where a version is and which file in it is the program, without side effects;
 * `obtain()` gets it. npm installs with `--ignore-scripts`: the program is the platform package's own.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Provider } from '../../src/shared/types';
import { normalizeVersion, type Fetch } from './versions';

export type Os = 'linux' | 'darwin';
export type Arch = 'x64' | 'arm64';

export type Artifact =
  /** An npm package, installed into the folder; `bin` is the program's path from the folder. */
  | { kind: 'npm'; spec: string; bin: string }
  /** A uv tool, installed into the folder (its tools, links and the Python it runs on there). */
  | { kind: 'uv'; spec: string; command: string; python: string }
  /** A file to download: a gzipped program, or an archive (gzip or bzip2 tar) holding it at `bin`. */
  | { kind: 'download'; url: string; format: 'gz' | 'raw' | 'tar.gz' | 'tar.bz2'; bin: string; strip?: number }
  /** A download its maker's manifest names, with its checksum: read when it is obtained. */
  | { kind: 'manifest'; provider: 'antigravity' | 'muse'; version: string };

/** Muse Code's full build of each version checked, which its release manifest's address needs (`muse --version` prints it). */
export const MUSE_BUILDS: Record<string, string> = { '1.4.18': '1.4.18-R8587.1' };

/** Where version `v` of a CLI is, for this system; throws for a system its maker does not publish it for. */
export function artifactFor(p: Provider, v: string, os: Os, arch: Arch): Artifact {
  const x86 = arch === 'x64' ? 'x86_64' : 'aarch64';
  switch (p) {
    case 'claude':
      return { kind: 'npm', spec: `@anthropic-ai/claude-code@${v}`, bin: `node_modules/@anthropic-ai/claude-code-${os}-${arch}/claude` };
    case 'codex':
      return { kind: 'npm', spec: `@openai/codex@${v}`, bin: 'node_modules/.bin/codex' };
    case 'copilot':
      return { kind: 'npm', spec: `@github/copilot@${v}`, bin: `node_modules/@github/copilot-${os}-${arch}/copilot` };
    case 'opencode':
      return { kind: 'npm', spec: `opencode-ai@${v}`, bin: `node_modules/opencode-${os}-${arch}/bin/opencode` };
    case 'cline':
      // Its launcher (`bin/cline`) only finds this, the platform package's own program.
      return { kind: 'npm', spec: `cline@${v}`, bin: `node_modules/@cline/cli-${os}-${arch}/bin/cline` };
    case 'pi':
      return { kind: 'npm', spec: `@earendil-works/pi-coding-agent@${v}`, bin: 'node_modules/.bin/pi' };
    case 'openhands':
      // On Python 3.12, as Settings installs it: on a newer one uv may build its packages from source.
      return { kind: 'uv', spec: `openhands==${v}`, command: 'openhands', python: '3.12' };
    case 'goose':
      return {
        kind: 'download',
        url: `https://github.com/aaif-goose/goose/releases/download/v${v}/goose-${x86}-${os === 'linux' ? 'unknown-linux-gnu' : 'apple-darwin'}.tar.bz2`,
        format: 'tar.bz2',
        bin: 'goose',
      };
    case 'grok':
      return {
        kind: 'download',
        url: `https://x.ai/cli/grok-${v}-${os === 'linux' ? 'linux' : 'macos'}-${x86}.gz`,
        format: 'gz',
        bin: 'grok',
      };
    case 'cursor':
      return {
        kind: 'download',
        url: `https://downloads.cursor.com/lab/${v}/${os}/${arch}/agent-cli-package.tar.gz`,
        format: 'tar.gz',
        bin: 'cursor-agent',
        strip: 1,
      };
    case 'antigravity':
    case 'muse':
      return { kind: 'manifest', provider: p, version: v };
  }
}

/** The system this runs on, as the makers name it, or why it has none. */
export function thisSystem(platform: NodeJS.Platform = process.platform, arch: string = process.arch): { os: Os; arch: Arch } {
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`no CLI is obtained on ${platform} here: macOS and Linux only`);
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`no CLI is obtained for ${arch} here: x64 and arm64 only`);
  return { os: platform, arch };
}

/** Where a manifest's download is, and its checksum: Antigravity's newest only, Muse Code's by its build. */
export async function manifestDownload(
  a: Extract<Artifact, { kind: 'manifest' }>,
  os: Os,
  arch: Arch,
  fetchImpl: Fetch = fetch,
): Promise<{ url: string; hash: 'sha512' | 'sha256'; checksum: string; format: 'tar.gz' | 'raw'; bin: string }> {
  const json = async (url: string) => {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'harness-relay-cli-check' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
  if (a.provider === 'antigravity') {
    const m = await json(
      `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${os}_${arch === 'x64' ? 'amd64' : 'arm64'}.json`,
    );
    if (m.version !== a.version)
      throw new Error(`Antigravity ${a.version} cannot be had: its manifest names only the newest, ${m.version}`);
    return { url: String(m.url), hash: 'sha512', checksum: String(m.sha512), format: 'tar.gz', bin: 'antigravity' };
  }
  // Muse Code: the channel names the newest's full build; an older one is known by its build (MUSE_BUILDS).
  const channel = await json('https://api.meta.ai/muse-code/channels/muse-stable');
  const build =
    normalizeVersion('muse', String(channel.version)) === normalizeVersion('muse', a.version)
      ? String(channel.version)
      : MUSE_BUILDS[a.version];
  if (!build) throw new Error(`Muse Code ${a.version} cannot be had: its full build is not known (MUSE_BUILDS)`);
  const manifest = await json(
    `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${encodeURIComponent(build)}&file=manifest.json`,
  );
  const art = manifest.artifacts?.[`${arch === 'x64' ? 'x86' : 'aarch64'}_${os === 'linux' ? 'linux' : 'macos'}`];
  if (!art?.url || !art?.checksum) throw new Error(`Muse Code ${build} has no build for ${os} ${arch}`);
  return { url: String(art.url), hash: 'sha256', checksum: String(art.checksum), format: 'raw', bin: 'muse' };
}

/**
 * Gets version `v` of a CLI into `dir` (a fresh folder of its own) and gives its program's path. Each
 * download is checked against its maker's checksum when there is one, and the program is checked to be
 * a file before it is given.
 */
export async function obtain(p: Provider, v: string, dir: string, sys = thisSystem(), fetchImpl: Fetch = fetch): Promise<string> {
  const { runProcess } = await import('../../src/server/process');
  mkdirSync(dir, { recursive: true });
  const run = async (bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd = dir) => {
    const r = await runProcess({ bin, args, cwd, env, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`${bin} ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  };
  const program = (path: string) => {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${p} ${v}: no program at ${path}`);
    chmodSync(path, 0o755);
    return path;
  };
  let a = artifactFor(p, v, sys.os, sys.arch);
  let check: { hash: 'sha512' | 'sha256'; checksum: string } | undefined;
  if (a.kind === 'manifest') {
    const m = await manifestDownload(a, sys.os, sys.arch, fetchImpl);
    check = { hash: m.hash, checksum: m.checksum };
    a = { kind: 'download', url: m.url, format: m.format, bin: m.bin };
  }
  if (a.kind === 'npm') {
    await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', dir, a.spec]);
    return program(join(dir, a.bin));
  }
  if (a.kind === 'uv') {
    const env = {
      ...process.env,
      UV_TOOL_DIR: join(dir, 'tools'),
      UV_TOOL_BIN_DIR: join(dir, 'bin'),
      UV_CACHE_DIR: join(dir, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(dir, 'python'),
    };
    await run('uv', ['tool', 'install', '--python', a.python, a.spec], env);
    return program(join(dir, 'bin', a.command));
  }
  const res = await fetchImpl(a.url, {
    headers: { 'user-agent': 'harness-relay-cli-check' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`${a.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (check) {
    const got = createHash(check.hash).update(bytes).digest('hex');
    if (got !== check.checksum.toLowerCase()) throw new Error(`${a.url}: its ${check.hash} is not the one its manifest names`);
  }
  if (a.format === 'gz' || a.format === 'raw') {
    const path = join(dir, a.bin);
    writeFileSync(path, a.format === 'gz' ? gunzipSync(bytes) : bytes, { mode: 0o755 });
    return program(path);
  }
  const archive = join(dir, a.format === 'tar.gz' ? 'archive.tar.gz' : 'archive.tar.bz2');
  writeFileSync(archive, bytes);
  const out = join(dir, 'x');
  mkdirSync(out);
  await run('tar', [a.format === 'tar.gz' ? '-xzf' : '-xjf', archive, '-C', out, ...(a.strip ? [`--strip-components=${a.strip}`] : [])]);
  return program(findFile(out, a.bin) ?? join(out, a.bin));
}

/** A file named `name` in `dir` or the folders in it (an archive's own top folder). */
function findFile(dir: string, name: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isFile() && e.name === name) return path;
    if (e.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}
