import { describe, expect, it, vi } from 'vitest';
import { AppDependencies } from '../src/server/appDependencies';
import type { InstallJob } from '../src/server/cliInstall';

describe('common app prerequisites', () => {
  it('never installs on inspection, deduplicates clicks and verifies the result before offering sign-in', async () => {
    let ready = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const install = vi.fn(async () => {
      await done;
      ready = true;
    });
    const github = { available: () => ready, plan: () => ({ install }) };
    const deps = new AppDependencies({ github, browser: { available: () => false, plan: () => ({ command: 'install chromium' }) } });
    expect(deps.view('github')).toMatchObject({ available: false, canInstall: true });
    expect(deps.view('browser')).toMatchObject({ available: false, canInstall: false, command: 'install chromium' });
    expect(() => deps.install('browser')).toThrow();
    expect(install).not.toHaveBeenCalled();
    expect(deps.install('github').job?.state).toBe('running');
    expect(deps.install('github').job?.state).toBe('running');
    expect(deps.running()).toBe(1);
    finish();
    await vi.waitFor(() => expect(deps.view('github')).toMatchObject({ available: true, job: { state: 'success' } }));
    expect(deps.install('github').available).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('retries failed installations and cancels in-flight work at shutdown', async () => {
    let attempt = 0;
    const dep = {
      available: () => false,
      plan: () => ({
        install: async (job: InstallJob) => {
          if (++attempt === 1) return;
          await new Promise<void>((resolve) => job.abort.signal.addEventListener('abort', () => resolve(), { once: true }));
        },
      }),
    };
    const deps = new AppDependencies({ github: dep, browser: dep });
    deps.install('browser');
    await vi.waitFor(() => expect(deps.view('browser').job?.state).toBe('failed'));
    expect(deps.view('browser').canInstall).toBe(true);
    expect(deps.install('browser').job?.state).toBe('running');
    await deps.shutdown();
    expect(deps.view('browser').job?.state).toBe('cancelled');
    expect(deps.running()).toBe(0);
    expect(() => deps.install('github')).toThrow();
  });
});

it('reserves one host Docker install for simultaneous requests and checks engine readiness independently', async () => {
  let present = false;
  let ready = false;
  let finish!: () => void;
  const install = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    present = true;
  });
  const dep = { available: () => present, plan: () => ({ install }) };
  const docker = {
    ...dep,
    probe: vi.fn(async () => ({ state: ready ? ('ready' as const) : present ? ('unavailable' as const) : ('missing' as const) })),
  };
  const deps = new AppDependencies({ github: dep, browser: dep }, docker);
  expect(await deps.dockerView()).toMatchObject({ state: 'missing', canInstall: true, available: false });
  expect(install).not.toHaveBeenCalled();
  const clicks = await Promise.all([deps.installDocker(), deps.installDocker()]);
  for (const click of clicks) expect(click).toMatchObject({ canInstall: false, job: { state: 'running' } });
  expect(deps.running()).toBe(1);
  finish();
  await vi.waitFor(async () =>
    expect(await deps.dockerView()).toMatchObject({
      state: 'unavailable',
      available: false,
      canInstall: false,
      job: { state: 'success' },
    }),
  );
  await deps.installDocker();
  ready = true;
  expect(await deps.installDocker()).toMatchObject({ state: 'ready', available: true, canInstall: false });
  expect(install).toHaveBeenCalledOnce();
  await deps.shutdown();
  await expect(deps.installDocker()).rejects.toThrow();
});
