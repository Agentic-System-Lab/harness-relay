import { afterEach, expect, it, vi } from 'vitest';
import { DRAFT_APPS, type DraftAppAvailability } from '../src/shared/apps';
import { api } from '../src/web/api';
import { DraftAppStatus } from '../src/web/draftAppStatus';

const ready = Object.fromEntries(DRAFT_APPS.map((app) => [app, 'ready'])) as DraftAppAvailability;
afterEach(() => vi.restoreAllMocks());

function delayedAnswer() {
  let resolve!: (value: DraftAppAvailability) => void;
  const promise = new Promise<DraftAppAvailability>((done) => (resolve = done));
  return { promise, resolve };
}

it('joins pending startup checks and caches each permission independently', async () => {
  const read = vi.spyOn(api, 'draftAppAvailability').mockResolvedValue(ready);
  const verify = vi.spyOn(api, 'verifyDraftSlack');
  const status = new DraftAppStatus();
  status.warm('read-only');
  status.warm('read-only');
  await status.read('read-only', 'local', 'cached');
  expect(read).toHaveBeenCalledTimes(4);
  expect(status.snapshot('read-only').states).toEqual(ready);
  expect(status.snapshot('edit').states).toEqual({});
  await status.read('edit', 'local', 'cached');
  expect(read).toHaveBeenCalledTimes(5);
  expect(verify).not.toHaveBeenCalled();
});

it('discards late responses from before a settings change or sign-out', async () => {
  const before = delayedAnswer();
  const read = vi
    .spyOn(api, 'draftAppAvailability')
    .mockImplementationOnce(() => before.promise)
    .mockResolvedValue({ ...ready, mail: 'needs-connection' });
  const status = new DraftAppStatus();
  const old = status.read('read-only', 'local', 'cached');
  status.clear();
  await status.read('read-only', 'local', 'cached');
  expect(read.mock.calls[0][0]?.aborted).toBe(true);
  before.resolve(ready);
  expect(await old).toBeUndefined();
  expect(status.snapshot('read-only').states.mail).toBe('needs-connection');
  status.clear();
  expect(status.snapshot('read-only').states).toEqual({});
});

it('rechecks selected apps on submission and keeps a passive Slack read from replacing explicit verification', async () => {
  const passive = delayedAnswer();
  const read = vi
    .spyOn(api, 'draftAppAvailability')
    .mockImplementationOnce(() => passive.promise)
    .mockResolvedValue(ready);
  const verify = vi.spyOn(api, 'verifyDraftSlack').mockResolvedValue(ready);
  const status = new DraftAppStatus();
  const old = status.read('edit', 'slack', 'cached');
  const check = status.read('edit', 'slack', 'confirm');
  expect(status.read('edit', 'slack', 'refresh')).toBe(check);
  await check;
  passive.resolve({ ...ready, slack: 'needs-verification' });
  await old;
  expect(status.snapshot('edit').states.slack).toBe('ready');
  expect(verify).toHaveBeenCalledTimes(1);
  await status.read('edit', 'local', 'cached');
  read.mockResolvedValue({ ...ready, drive: 'needs-assistant' });
  expect((await status.read('edit', 'local', 'confirm'))?.drive).toBe('needs-assistant');
});

it('preserves explicit verification on focus and discards it after a settings change or sign-out', async () => {
  const first = delayedAnswer();
  const second = delayedAnswer();
  const verify = vi.spyOn(api, 'verifyDraftSlack').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const passive = vi.spyOn(api, 'draftAppAvailability').mockResolvedValue({ ...ready, slack: 'needs-verification' });
  const status = new DraftAppStatus();
  const checking = status.read('read-only', 'slack', 'confirm');
  status.recheck('read-only');
  expect(status.read('read-only', 'slack', 'cached')).toBe(checking);
  expect(passive.mock.calls.map((call) => call[2])).toEqual(['local', 'github', 'teams']);
  first.resolve(ready);
  await checking;
  expect(status.snapshot('read-only').states.slack).toBe('ready');

  const superseded = status.read('read-only', 'slack', 'confirm');
  status.clear();
  expect(verify.mock.calls[1][1]?.aborted).toBe(true);
  second.resolve(ready);
  expect(await superseded).toBeUndefined();
  expect(status.snapshot('read-only').states).toEqual({});
  await status.read('read-only', 'slack', 'cached');
  expect(status.snapshot('read-only').states.slack).toBe('needs-verification');

  const last = delayedAnswer();
  verify.mockReturnValueOnce(last.promise);
  const signedOut = status.read('read-only', 'slack', 'confirm');
  status.clear();
  last.resolve(ready);
  expect(await signedOut).toBeUndefined();
  expect(status.snapshot('read-only').states).toEqual({});
});

it('clears only the expired group being checked until its replacement arrives', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const read = vi.spyOn(api, 'draftAppAvailability').mockResolvedValue(ready);
  const status = new DraftAppStatus();
  status.warm('edit');
  await status.read('edit', 'local', 'cached');
  const local = delayedAnswer();
  read.mockReturnValueOnce(local.promise);
  now.mockReturnValue(161_000);
  const confirm = status.read('edit', 'local', 'confirm');
  expect(status.snapshot('edit').states.drive).toBeUndefined();
  expect(status.snapshot('edit').states.github).toBe('ready');
  expect(status.snapshot('edit').states.teams).toBe('ready');
  expect(status.snapshot('edit').states.slack).toBe('ready');
  expect(status.read('edit', 'local', 'cached')).toBe(confirm);
  expect(read).toHaveBeenCalledTimes(5);
  local.resolve({ ...ready, drive: 'needs-connection' });
  await confirm;
  expect(status.snapshot('edit').states.drive).toBe('needs-connection');
  status.warm('edit');
  await status.read('edit', 'github', 'cached');
  expect(read).toHaveBeenCalledTimes(8);
  expect(status.snapshot('edit').states).toEqual({ ...ready, drive: 'needs-connection' });
});

it('refreshes only the focused draft’s permission', async () => {
  const read = vi.spyOn(api, 'draftAppAvailability').mockResolvedValue(ready);
  const status = new DraftAppStatus();
  for (const permission of ['read-only', 'edit'] as const) {
    status.warm(permission);
    await status.read(permission, 'local', 'cached');
  }
  read.mockClear().mockResolvedValue({ ...ready, mail: 'needs-connection' });
  status.recheck('edit');
  await status.read('edit', 'local', 'cached');
  expect(read.mock.calls.map(([, permission, group]) => [permission, group])).toEqual([
    ['edit', 'local'],
    ['edit', 'slack'],
    ['edit', 'github'],
    ['edit', 'teams'],
  ]);
  expect(status.snapshot('read-only').states.mail).toBe('ready');
  expect(status.snapshot('edit').states.mail).toBe('needs-connection');
});

it('confirms only the selected groups, keeps their responses separate, and distinguishes a failed check from loss of access', async () => {
  const read = vi.spyOn(api, 'draftAppAvailability').mockResolvedValue({ ...ready, slack: 'unavailable' });
  const verify = vi.spyOn(api, 'verifyDraftSlack').mockResolvedValue({ ...ready, mail: 'unavailable' });
  const status = new DraftAppStatus();
  expect(await status.confirmSelection('edit', [])).toBe('ready');
  expect(await status.confirmSelection('edit', ['mail', 'calendar', 'slack'])).toBe('ready');
  expect(read.mock.calls.map(([, permission, group]) => [permission, group])).toEqual([['edit', 'local']]);
  expect(verify).toHaveBeenCalledTimes(1);
  verify.mockResolvedValue({ ...ready, slack: 'needs-verification' });
  expect(await status.confirmSelection('edit', ['slack'])).toBe('changed');
  verify.mockRejectedValue(new Error('offline'));
  expect(await status.confirmSelection('edit', ['slack'])).toBe('failed');
});
