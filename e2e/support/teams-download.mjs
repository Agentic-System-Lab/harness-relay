import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installTeamsRuntime as install, powerShellBuild } from '../../src/server/connectors/teamsRuntime.ts';
export * from '../../src/server/connectors/teamsRuntime.ts';

const folder = join(process.env.USERPROFILE, 'e2e-teams');
await mkdir(folder, { recursive: true });
await writeFile(join(folder, 'distribution-loaded'), '');

export async function installTeamsRuntime(signal, probe, env) {
  const release = powerShellBuild(process.platform, process.arch, false);
  if (!release) throw new Error('No fixture runtime for this platform');
  const archive = join(folder, process.platform === 'win32' ? 'package.zip' : 'package.tar.gz');
  const bins = join(process.env.RELAY_DATA_DIR, '..', 'bin');
  const runFile = promisify(execFile);
  if (!existsSync(archive))
    await runFile('tar', [...(process.platform === 'win32' ? ['-a', '-cf'] : ['-czf']), archive, '-C', bins, release.exe], { signal });
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
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
