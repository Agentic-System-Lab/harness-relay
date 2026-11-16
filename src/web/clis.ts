import type { CliInstallBlock, CliInstallView, Provider, ProviderStatus } from '../shared/types';

/**
 * What a CLI's card in Settings shows about installing it from there (`components/CliInstall.tsx`):
 * - `none`: nothing (its status is not in yet, or it is installed some other way);
 * - `offer`: an Install button, as the CLI is not found (`retry`: after an install that failed or was
 *   cancelled, whose words and output are shown with it);
 * - `blocked`: why it cannot be installed here (a program its install needs, or this system);
 * - `running`: its install under way, with Cancel and the installer's output so far;
 * - `ours`: Harness Relay installed it, with Remove (`inUse`: the CLI's executable path is that program).
 */
export type CliInstallShown =
  | { kind: 'none' }
  | { kind: 'offer'; retry: boolean }
  | { kind: 'blocked'; block: CliInstallBlock }
  | { kind: 'running' }
  | { kind: 'ours'; inUse: boolean };

export function cliInstallShown(status: ProviderStatus | undefined, view: CliInstallView | undefined): CliInstallShown {
  if (!status || !view) return { kind: 'none' };
  if (view.job?.state === 'running') return { kind: 'running' };
  if (view.installed) return { kind: 'ours', inUse: view.installed.inUse };
  if (status.installed) return { kind: 'none' };
  if (view.blocked) return { kind: 'blocked', block: view.blocked };
  const ended = view.job?.state;
  return { kind: 'offer', retry: ended === 'failed' || ended === 'cancelled' };
}

/**
 * Whether the CLI's status was checked before Harness Relay installed it (the check after the install
 * is still under way): the card then says it is being checked, not that the CLI is missing.
 */
export function statusBeforeInstall(status: ProviderStatus | undefined, view: CliInstallView | undefined): boolean {
  return Boolean(status && view?.installed?.inUse && !status.installed && (status.checkedAt ?? 0) < view.installed.at);
}

/** Whether some CLI's install is under way (the views are asked again every second until none is). */
export function anyInstalling(views: readonly CliInstallView[]): boolean {
  return views.some((v) => v.job?.state === 'running');
}

/** The CLIs whose install was under way in `before` and has ended in `after`: their status and settings changed. */
export function installsEnded(before: readonly CliInstallView[], after: readonly CliInstallView[]): Provider[] {
  return after
    .filter((v) => v.job && v.job.state !== 'running' && before.some((b) => b.provider === v.provider && b.job?.state === 'running'))
    .map((v) => v.provider);
}

/** The last `lines` lines of an installer's output (while it runs, the card shows only these). */
export function logTail(log: string, lines = 12): string {
  const all = log.replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

/** `views` with `view` in its CLI's place (an answer to an install, a cancel or a removal). */
export function withView(views: readonly CliInstallView[], view: CliInstallView): CliInstallView[] {
  return views.some((v) => v.provider === view.provider) ? views.map((v) => (v.provider === view.provider ? view : v)) : [...views, view];
}

/** How often installs still under way are asked about once Settings is closed. */
export const FOLLOW_MS = 2000;
/** For how long at most: longer than an install may take (20 minutes, and its program's check). */
export const FOLLOW_TRIES = 750;

/**
 * Once Settings is closed with installs under way (`shown`): asks `load` every `FOLLOW_MS` until none
 * is, telling `onEnded` of each CLI whose install ended, so that the sidebar's status follows. An
 * answer that does not come is asked again on the next tick.
 */
export async function followInstalls(
  shown: readonly CliInstallView[],
  load: () => Promise<CliInstallView[]>,
  onEnded: (p: Provider) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let before = shown;
  for (let tries = 0; anyInstalling(before) && tries < FOLLOW_TRIES; tries++) {
    await wait(FOLLOW_MS);
    let after: CliInstallView[];
    try {
      after = await load();
    } catch {
      continue;
    }
    for (const p of installsEnded(before, after)) onEnded(p);
    before = after;
  }
}
