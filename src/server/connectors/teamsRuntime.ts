import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../i18n';
import { installPortableArchive, type ArchiveHost } from '../portableInstall';
import { cliFolder } from '../protect';

export { publishPortableDirectory as publishTeamsDirectory } from '../portableInstall';

// SHA-256 digests from Microsoft's LTS release:
// https://github.com/PowerShell/PowerShell/releases/tag/v7.6.10
const VERSION = '7.6.10';
const SUMS: Record<string, string> = {
  'osx-arm64': 'fb6f1978c7d3266d4ced9391de6519d971ef92bd036e5b8be62f1ccdfbda9477',
  'osx-x64': 'aa55bef6375e7b1a61e860866a38af5f2366ceb4189293e6b73b7777cb1d7793',
  'linux-x64': 'e261cabc91c78a9afe8d1e5f24731ab0d38204735ab2ec94b0af55102652e10d',
  'linux-arm64': '439432cdecf4418413b9a8f547e3ab4d9b40e8e4258913ec3d15fc92c67a9235',
  'linux-arm32': 'c075be079bda46dc64053ae7daaec4811171fe66227306f1e22adaccbfbb2cc9',
  'linux-musl-x64': '5b31557a9a99471692ba9733e058294fb2ea9e50419ac5acb74c0fd278c3d9e0',
  'win-x64': '7d871531806eb1646264e4bbabd9f0c30c23355591bc756bb9909448c29ae166',
  'win-arm64': '1d36ecac1d8f5ac9577cfdfc426af41f3e90cbca6c52445e7db167f532b3a7ab',
  'win-x86': '221bad2ba6eff81f2661c8f467eca286f89173b0e0c044c858f18dbbeacb9891',
};

export function powerShellBuild(platform: NodeJS.Platform, arch: string, musl: boolean) {
  const systems: Partial<Record<NodeJS.Platform, string>> = { darwin: 'osx', linux: musl ? 'linux-musl' : 'linux', win32: 'win' };
  const os = systems[platform];
  if (!os) return;
  const target = os + '-' + (arch === 'arm' ? 'arm32' : arch === 'ia32' ? 'x86' : arch);
  const sha256 = SUMS[target];
  if (!sha256) return;
  const windows = platform === 'win32';
  const file = (windows ? 'PowerShell-' : 'powershell-') + VERSION + '-' + target + (windows ? '.zip' : '.tar.gz');
  return {
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v' + VERSION + '/' + file,
    sha256,
    exe: windows ? 'pwsh.exe' : 'pwsh',
  };
}

export const runtimeFolder = () => join(cliFolder(), 'teams-powershell-' + VERSION);

export const teamsModulesFolder = () => join(cliFolder(), 'teams-modules');

export class TeamsRuntimeError extends Error {}

/** Publish only an intact official archive whose pwsh starts here. A cancelled install leaves any previous runtime in place. */
export async function installTeamsRuntime(
  signal: AbortSignal,
  probe: (executable: string) => Promise<number | null>,
  env: NodeJS.ProcessEnv,
  {
    build = powerShellBuild(
      process.platform,
      process.arch,
      ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1', '/lib/ld-musl-armhf.so.1'].some(existsSync),
    ),
    folder = runtimeFolder(),
    ...host
  }: ArchiveHost & { build?: ReturnType<typeof powerShellBuild>; folder?: string } = {},
): Promise<void> {
  if (!build) throw new TeamsRuntimeError(t().teamsRuntimeUnsupported);
  await installPortableArchive(
    build,
    folder,
    signal,
    env,
    async (exe) => {
      const code = await probe(exe);
      return code === 0 || code === 21;
    },
    (step) => new TeamsRuntimeError({ tools: t().teamsRuntimeTools, download: t().teamsRuntimeDownload, run: t().teamsRuntimeRun }[step]),
    host,
  );
}
