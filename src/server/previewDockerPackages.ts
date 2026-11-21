import { t } from './i18n';
import { createHash } from 'node:crypto';

export interface LockedPreviewPackage {
  url: string;
  integrity: string;
}

const NAME = /^(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t().previewDocker.invalidLock);
  return value as Record<string, unknown>;
}

export function parsePreviewPackage(bytes: Buffer | string): Record<string, unknown> {
  try {
    return object(JSON.parse(bytes.toString()));
  } catch {
    throw new Error(t().previewDocker.invalidLock);
  }
}

/** npm start also defaults to node server.js when the project has no explicit start script. */
export function hasPreviewScript(project: Record<string, unknown>, name: 'start' | 'build', hasServerFile: () => boolean): boolean {
  const scripts = project.scripts === undefined ? {} : object(project.scripts);
  const command = scripts[name];
  return (typeof command === 'string' && Boolean(command.trim())) || (name === 'start' && command === undefined && hasServerFile());
}

function checkSpec(spec: unknown): void {
  // Registry tags and semver ranges only. Local files, aliases, git and URLs have other syntax.
  if (typeof spec !== 'string' || !/^[0-9A-Za-z.*^~<>=+| \t-]*$/.test(spec) || /^\.{1,2}$/.test(spec)) {
    throw new Error(t().previewDocker.spec);
  }
}

function checkSpecs(pkg: Record<string, unknown>): void {
  if (pkg.workspaces) throw new Error(t().previewDocker.standalone);
  for (const field of DEPENDENCIES) {
    if (pkg[field] === undefined) continue;
    Object.values(object(pkg[field])).forEach(checkSpec);
  }
  if (pkg.overrides !== undefined) {
    const pending = Object.values(object(pkg.overrides));
    while (pending.length) {
      const override = pending.pop();
      if (typeof override === 'string') {
        if (!override.startsWith('$') || !NAME.test(override.slice(1))) checkSpec(override);
      } else {
        for (const child of Object.values(object(override))) pending.push(child);
      }
    }
  }
}

function matches(constraint: unknown, value: string): boolean {
  if (!Array.isArray(constraint)) return true;
  return (
    !constraint.includes('!' + value) &&
    (constraint.includes(value) || constraint.every((part) => typeof part === 'string' && part.startsWith('!')))
  );
}

/** File prerequisites checked before offering Docker setup and again on the actual snapshot. */
export function previewNpmFileProblem(has: (name: string) => boolean): string | undefined {
  if (!has('package-lock.json')) return t().previewDocker.lock;
  if (has('npm-shrinkwrap.json') || has('.npmrc')) return t().previewDocker.config;
}

/** Validate every lock entry before making a network request, including entries for other platforms. */
export function lockedPreviewPackages(
  files: ReadonlyMap<string, Buffer>,
  mode?: 'server' | 'build',
): Record<'arm64' | 'x64', LockedPreviewPackage[]> {
  const fileProblem = previewNpmFileProblem((name) => files.has(name));
  if (fileProblem) throw new Error(fileProblem);
  const lock = parsePreviewPackage(files.get('package-lock.json')!);
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new Error(t().previewDocker.lockVersion);
  const manifest = files.get('package.json');
  if (!manifest) throw new Error(t().previewDocker.manifest);
  const project = parsePreviewPackage(manifest);
  checkSpecs(project);
  if (mode) {
    const script = mode === 'build' ? 'build' : 'start';
    if (!hasPreviewScript(project, script, () => files.has('server.js'))) throw new Error(t().previewDocker.script(script));
  }
  const entries = Object.entries(object(lock.packages));
  if (entries.length > 2001) throw new Error(t().previewDocker.count);
  const packages = { arm64: new Map<string, LockedPreviewPackage>(), x64: new Map<string, LockedPreviewPackage>() };
  const digests = new Map<string, string>();
  for (const [path, value] of entries) {
    const pkg = object(value);
    checkSpecs(pkg);
    if (!path) continue;
    const names = path.split(/(?:^|\/)node_modules\//);
    const name = names.at(-1)!;
    if (names.shift() !== '' || !names.every((n) => NAME.test(n)) || pkg.link || (pkg.name !== undefined && pkg.name !== name)) {
      throw new Error(t().previewDocker.spec);
    }
    if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) throw new Error(t().previewDocker.invalidLock);
    const url = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${pkg.version}.tgz`;
    if (url !== pkg.resolved || typeof pkg.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity)) {
      throw new Error(t().previewDocker.tarball);
    }
    const other = digests.get(url);
    if (other && other !== pkg.integrity) throw new Error(t().previewDocker.integrity);
    digests.set(url, pkg.integrity);
    for (const arch of ['arm64', 'x64'] as const) {
      if (pkg.optional === true && (!matches(pkg.os, 'linux') || !matches(pkg.cpu, arch) || !matches(pkg.libc, 'glibc'))) continue;
      packages[arch].set(url, { url, integrity: pkg.integrity });
    }
  }
  return { arm64: Array.from(packages.arm64.values()), x64: Array.from(packages.x64.values()) };
}

/** The host treats the tarball as opaque bytes. Only the networkless npm inside Docker unpacks it. */
export async function fetchPreviewPackage(pkg: LockedPreviewPackage, signal: AbortSignal, max: number, get = fetch): Promise<Buffer> {
  const response = await get(pkg.url, { signal, redirect: 'error', credentials: 'omit' });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(t().previewDocker.fetch(pkg.url, response.status));
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  const hash = createHash('sha512');
  try {
    if (Number(response.headers.get('content-length')) > max) throw new Error(t().previewDocker.downloadSize);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error(t().previewDocker.downloadSize);
      chunks.push(Buffer.from(value));
      hash.update(value);
    }
  } finally {
    await reader.cancel();
  }
  if ('sha512-' + hash.digest('base64') !== pkg.integrity) throw new Error(t().previewDocker.integrity);
  return Buffer.concat(chunks, size);
}
