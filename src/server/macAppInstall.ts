import { lstatSync, mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InstallError, runStep, type CliInstallHost, type InstallJob } from './cliInstall';
import { t } from './i18n';
import { portableInstallEnv } from './portableInstall';
import { runSync } from './process';

// Node's rename() replaces an existing empty directory. Darwin's exclusive rename atomically
// publishes the whole bundle or leaves whoever owns the destination alone, even in that race.
export function publishMacApp(source: string, destination: string, env: NodeJS.ProcessEnv): void {
  const script = [
    "ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);",
    'function run(paths) {',
    '  if ($.renamex_np(paths[0], paths[1], 4) !== 0) throw Error("renamex_np");',
    '}',
  ].join('\n');
  const result = runSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, source, destination], {
    env,
    timeoutMs: 10000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim();
    throw new InstallError(() => [t().macAppPublishFailed(destination), detail].filter(Boolean).join('\n'), result.status);
  }
}

// Finder owns any administrator prompt. The source is a verified bundle on the read-only image.
// Resolve the named items once as aliases, pass the collision policy explicitly and obtain the
// path Finder actually copied. No installer binary or shell runs with administrator privileges.
const FINDER_COPY = `set sourceBundle to (POSIX file (system attribute "RELAY_MAC_SOURCE")) as alias
set appsFolder to (POSIX file (system attribute "RELAY_MAC_APPS")) as alias
try
  with timeout of 600 seconds
    tell application id "com.apple.finder"
      set copiedBundle to duplicate sourceBundle to appsFolder without replacing
      return POSIX path of (copiedBundle as alias)
    end tell
  end timeout
on error messageText number errorNumber
  if errorNumber is -128 then return "cancelled"
  if errorNumber is -1743 then return "denied"
  error messageText number errorNumber
end try`;

export async function installMacApp(
  host: Pick<CliInstallHost, 'env' | 'run' | 'runScript'> & { temp: string; publish: typeof publishMacApp },
  job: InstallJob,
  app: { name: string; apps: string; url: string; signature: string; finder?: boolean },
): Promise<void> {
  const env = portableInstallEnv(host.env);
  const { apps, name } = app;
  const bundle = name + '.app';
  const dest = join(apps, bundle);
  job.abort.signal.throwIfAborted();
  if (lstatSync(dest, { throwIfNoEntry: false })) throw new InstallError(() => t().macAppDestinationExists(dest));

  if (!app.finder) mkdirSync(apps, { recursive: true });
  const stage = app.finder ? undefined : mkdtempSync(join(apps, '.relay-app-'));
  const verify = async (path: string) => {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new InstallError(() => t().macAppMissingBundle(name));
    await runStep(host, job, `Verify the ${name} signature`, {
      bin: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', '--all-architectures', '-R', app.signature, path],
      env,
    });
  };
  try {
    const scratch = mkdtempSync(join(host.temp, 'relay-app-'));
    const image = join(scratch, 'installer.dmg');
    const volume = join(scratch, 'volume');
    let attemptedMount = false;
    try {
      await runStep(host, job, `Download ${name}`, {
        bin: '/usr/bin/curl',
        args: [
          '-q',
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--output',
          image,
          app.url,
        ],
        env,
      });
      mkdirSync(volume);
      attemptedMount = true;
      await runStep(host, job, 'hdiutil attach', {
        bin: '/usr/bin/hdiutil',
        args: ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', volume, image],
        env,
      });
      const source = join(volume, bundle);
      if (!lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new InstallError(() => t().macAppMissingBundle(name));
      if (!stage) {
        await verify(source);
        if (!lstatSync(apps, { throwIfNoEntry: false })?.isDirectory() || lstatSync(dest, { throwIfNoEntry: false }))
          throw new InstallError(() => t().macAppPublishFailed(dest));
        const copy = await runStep(host, job, `Copy ${name} with Finder`, {
          bin: '/usr/bin/osascript',
          args: ['-e', FINDER_COPY],
          env: { ...env, RELAY_MAC_SOURCE: source, RELAY_MAC_APPS: apps },
        });
        const copied = copy.stdout.trim().replace(/\/$/, '');
        if (copied === 'cancelled') {
          job.abort.abort();
          job.abort.signal.throwIfAborted();
        }
        if (copied === 'denied') throw new InstallError(() => t().macAppFinderDenied);
        if (copied !== dest) throw new InstallError(() => t().macAppPublishFailed(dest));
        await verify(dest);
        return;
      }
      const stagedApp = join(stage, bundle);
      // The vendor HFS image carries FinderInfo on its helpers. Omit resource forks and Finder
      // metadata so strict seal verification can run; preserve quarantine on the staged bundle.
      await runStep(host, job, `Copy ${name}`, {
        bin: '/usr/bin/ditto',
        args: ['--norsrc', '--qtn', '--acl', source, stagedApp],
        env,
      });
      await verify(stagedApp);
    } finally {
      if (attemptedMount) {
        // hdiutil may have mounted the image before it reported a failure or was cancelled.
        // Cleanup uses its own timeout and never inherits the cancelled job's signal.
        for (const args of [
          ['detach', volume],
          ['detach', '-force', volume],
        ]) {
          const detached = await host.run({ bin: '/usr/bin/hdiutil', args, env, timeoutMs: 15000 }).catch(() => undefined);
          if (detached?.code === 0) break;
        }
      }
      // A still-mounted volume cannot be removed by rmdir. Leave it and its backing image for
      // ejection in that case; nothing ever recursively removes the mount point or its parent.
      if (lstatSync(volume, { throwIfNoEntry: false })) rmdirSync(volume);
      await rm(image, { force: true });
      rmdirSync(scratch);
    }
    job.abort.signal.throwIfAborted();
    host.publish(join(stage, bundle), dest, env);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 3 });
  }
}
