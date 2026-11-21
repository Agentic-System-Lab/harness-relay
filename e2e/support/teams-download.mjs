import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { sha256Of } from '../../src/server/executable.ts';
import { installTeamsRuntime as install, powerShellBuild } from '../../src/server/connectors/teamsRuntime.ts';
export * from '../../src/server/connectors/teamsRuntime.ts';

const folder = join(process.env.USERPROFILE, 'e2e-teams');
const release = powerShellBuild(process.platform, process.arch, false);
if (!release) throw new Error('No fixture runtime for this platform');
const windows = process.platform === 'win32';
const archive = join(folder, windows ? 'package.zip' : 'package.tar.gz');
const bins = await realpath(join(process.env.RELAY_DATA_DIR, '..', 'bin'));
const runFile = promisify(execFile);
await mkdir(folder, { recursive: true });
// Git Bash also contributes a GNU tar to PATH on Windows. The system bsdtar writes ZIP and
// understands native drive-letter paths. Store the large fake pwsh.exe without compression.
const tar = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const flags = windows ? ['--format=zip', '--options=zip:compression=store', '-cf'] : ['-czf'];
await runFile(tar, [...flags, archive, release.exe], { cwd: bins });
const digest = await sha256Of(archive);
// Mark the test transport ready only after the real archive and its checksum are available.
await writeFile(join(folder, 'distribution-loaded'), '');

export async function installTeamsRuntime(signal, probe, env) {
  await install(signal, probe, env, {
    build: { ...release, sha256: digest },
    run: async (bin, args, stop) => {
      if (args.at(-1) === release.url && args.includes('--output')) {
        await appendFile(join(folder, 'downloads'), release.url + '\n');
        while (!existsSync(join(folder, 'release-download'))) await delay(40, undefined, { signal: stop });
        const path = args[args.indexOf('--output') + 1];
        if (existsSync(join(folder, 'corrupt-download'))) await writeFile(path, 'incomplete archive');
        else await copyFile(archive, path);
      } else if (args[0] === '-xf') {
        await runFile(bin, args, { signal: stop });
      } else throw new Error('Unexpected fixture command');
      return true;
    },
  });
}
