import { describe, expect, it } from 'vitest';
import type { CliInstallView, ProviderStatus } from '../src/shared/types';
import { anyInstalling, cliInstallShown, installsEnded, logTail, statusBeforeInstall, withView } from '../src/web/clis';

const status = (o: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider: 'codex',
  installed: false,
  bin: 'codex',
  auth: { loggedIn: null },
  usingStoredApiKey: false,
  accounts: [],
  checkedAt: 100,
  ...o,
});

const view = (o: Partial<CliInstallView> = {}): CliInstallView => ({
  provider: 'codex',
  method: 'npm',
  command: 'npm install -g @openai/codex',
  dir: '/data/clis/codex',
  ...o,
});

const job = (state: 'running' | 'success' | 'failed' | 'cancelled') => ({ state, startedAt: 1, log: '' });
const ours = { bin: '/data/clis/codex/bin/codex', at: 200, inUse: true };

describe('cliInstallShown', () => {
  it('shows nothing until the status and the install are in, nor for a CLI installed some other way', () => {
    expect(cliInstallShown(undefined, view())).toEqual({ kind: 'none' });
    expect(cliInstallShown(status(), undefined)).toEqual({ kind: 'none' });
    expect(cliInstallShown(status({ installed: true }), view())).toEqual({ kind: 'none' });
  });

  it('offers to install a CLI that is not found, again after a failed or cancelled install', () => {
    expect(cliInstallShown(status(), view())).toEqual({ kind: 'offer', retry: false });
    expect(cliInstallShown(status(), view({ job: job('failed') }))).toEqual({ kind: 'offer', retry: true });
    expect(cliInstallShown(status(), view({ job: job('cancelled') }))).toEqual({ kind: 'offer', retry: true });
  });

  it('says why it cannot be installed here', () => {
    expect(cliInstallShown(status(), view({ blocked: 'npm' }))).toEqual({ kind: 'blocked', block: 'npm' });
  });

  it('shows an install under way, whatever the status says', () => {
    expect(cliInstallShown(status(), view({ job: job('running') }))).toEqual({ kind: 'running' });
    expect(cliInstallShown(status({ installed: true }), view({ job: job('running') }))).toEqual({ kind: 'running' });
  });

  it('offers to remove what Harness Relay installed, and says when another program is in use', () => {
    expect(cliInstallShown(status({ installed: true }), view({ installed: ours, job: job('success') }))).toEqual({ kind: 'ours', inUse: true });
    expect(cliInstallShown(status({ installed: true }), view({ installed: { ...ours, inUse: false } }))).toEqual({ kind: 'ours', inUse: false });
    // Also when the path set instead is not found: it can still be removed.
    expect(cliInstallShown(status(), view({ installed: { ...ours, inUse: false } }))).toEqual({ kind: 'ours', inUse: false });
  });
});

describe('statusBeforeInstall', () => {
  it('takes a "not installed" checked before the install for one still being checked', () => {
    expect(statusBeforeInstall(status({ checkedAt: 150 }), view({ installed: ours }))).toBe(true);
    // Checked since, and still not found: it is not found.
    expect(statusBeforeInstall(status({ checkedAt: 250 }), view({ installed: ours }))).toBe(false);
    expect(statusBeforeInstall(status({ checkedAt: 150, installed: true }), view({ installed: ours }))).toBe(false);
    // Another program in use: its status is its own.
    expect(statusBeforeInstall(status({ checkedAt: 150 }), view({ installed: { ...ours, inUse: false } }))).toBe(false);
    expect(statusBeforeInstall(status({ checkedAt: 150 }), view())).toBe(false);
    expect(statusBeforeInstall(undefined, view({ installed: ours }))).toBe(false);
  });
});

describe('following the installs', () => {
  it('asks again while an install runs, and names each one that ended', () => {
    const before = [view({ job: job('running') }), view({ provider: 'pi', job: job('running') }), view({ provider: 'goose' })];
    expect(anyInstalling(before)).toBe(true);
    expect(anyInstalling([view(), view({ provider: 'pi', job: job('failed') })])).toBe(false);
    const after = [view({ job: job('success') }), view({ provider: 'pi', job: job('running') }), view({ provider: 'goose', job: job('failed') })];
    // Goose's install was never seen running here (another browser started it, say): not named.
    expect(installsEnded(before, after)).toEqual(['codex']);
    expect(installsEnded(after, after)).toEqual([]);
  });

  it('puts one CLI’s answer in its place', () => {
    const list = [view(), view({ provider: 'pi' })];
    const next = withView(list, view({ provider: 'pi', job: job('running') }));
    expect(next.map((v) => [v.provider, v.job?.state])).toEqual([
      ['codex', undefined],
      ['pi', 'running'],
    ]);
    expect(withView([], view()).map((v) => v.provider)).toEqual(['codex']);
  });

  it('shows the last lines of the installer’s output while it runs', () => {
    const log = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n';
    expect(logTail(log, 3)).toBe('line 18\nline 19\nline 20');
    expect(logTail('')).toBe('');
  });
});
