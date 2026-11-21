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
  status.recheck();
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
