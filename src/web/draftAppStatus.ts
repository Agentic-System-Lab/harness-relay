import { LOCAL_DRAFT_APPS, type DraftApp, type DraftAppAvailability } from '../shared/apps';
import type { Permission } from '../shared/types';
import { api } from './api';

// Relay's own connections can finish while a CLI is still reporting its status.
export const appGroups = {
  local: LOCAL_DRAFT_APPS,
  slack: ['slack'],
  github: ['github'],
  teams: ['teams'],
} as const satisfies Record<string, readonly DraftApp[]>;
export type AppGroup = keyof typeof appGroups;
export const appGroupNames = Object.keys(appGroups) as AppGroup[];

interface Snapshot {
  states: Partial<DraftAppAvailability>;
  failed: DraftApp[];
  checked: Partial<Record<AppGroup, number>>;
}
const empty: Snapshot = { states: {}, failed: [], checked: {} };
const freshFor = 60_000;

type Result = Promise<Partial<DraftAppAvailability> | undefined>;

/** Status for one signed-in Relay window. Each permission has its own answers. */
export class DraftAppStatus {
  private snapshots = new Map<Permission, Snapshot>();
  private pending = new Map<string, { controller: AbortController; confirm: boolean; result: Result }>();
  private listeners = new Set<() => void>();

  snapshot = (permission?: Permission) => (permission && this.snapshots.get(permission)) || empty;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  /** Remove outdated answers before a picker can use them. Other groups can stay ready. */
  prepare(permission: Permission, invalidate = false, groups: readonly AppGroup[] = appGroupNames) {
    const snapshot = this.snapshots.get(permission);
    if (!snapshot) return;
    const stale = groups.filter((group) => {
      const at = snapshot.checked[group];
      return invalidate || (at !== undefined && Date.now() - at >= freshFor);
    });
    if (!stale.length) return;
    const states = { ...snapshot.states };
    const checked = { ...snapshot.checked };
    const unknown = new Set<DraftApp>();
    for (const group of stale) {
      if (invalidate) {
        const key = permission + '/' + group;
        this.pending.get(key)?.controller.abort();
        this.pending.delete(key);
      }
      delete checked[group];
      for (const app of appGroups[group]) {
        unknown.add(app);
        delete states[app];
      }
    }
    this.snapshots.set(permission, { states, checked, failed: snapshot.failed.filter((app) => !unknown.has(app)) });
    this.notify();
  }

  warm(permission: Permission, refresh = false) {
    for (const group of appGroupNames) void this.read(permission, group, refresh ? 'refresh' : 'cached');
  }

  clear() {
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
    this.snapshots.clear();
    this.notify();
  }

  recheck(reason: 'focus' | 'settings') {
    const permissions = new Set<Permission>(['read-only', ...this.snapshots.keys()]);
    for (const permission of permissions) {
      // Returning to the window can coincide with a user's verification. Settings changes invalidate even that answer.
      const groups = appGroupNames.filter((group) => reason === 'settings' || !this.pending.get(permission + '/' + group)?.confirm);
      this.prepare(permission, true, groups);
      this.warm(permission);
    }
  }

  read(permission: Permission, group: AppGroup, mode: 'cached' | 'refresh' | 'confirm'): Result {
    this.prepare(permission, false, [group]);
    const key = permission + '/' + group;
    const request = this.pending.get(key);
    const confirm = mode === 'confirm';
    // Submission must get a fresh answer. Passive reads can join a check already in progress.
    if (request && (!confirm || request.confirm)) return request.result;
    const snapshot = this.snapshot(permission);
    const checked = snapshot.checked[group];
    if (mode === 'cached' && checked !== undefined) return Promise.resolve(snapshot.states);

    request?.controller.abort();
    if (!this.snapshots.has(permission)) this.snapshots.set(permission, empty);
    const controller = new AbortController();
    const check = async () => {
      let answer: DraftAppAvailability | undefined;
      try {
        answer =
          confirm && group === 'slack'
            ? await api.verifyDraftSlack(permission, controller.signal)
            : await api.draftAppAvailability(controller.signal, permission, group);
      } catch {
        // A failed group can be retried independently and cannot authorize a submission.
      }
      if (controller.signal.aborted) return;
      this.pending.delete(key);
      const before = this.snapshot(permission);
      const states = { ...before.states };
      const apps: readonly DraftApp[] = appGroups[group];
      const failed = before.failed.filter((app) => !apps.includes(app));
      for (const app of apps) {
        if (answer) states[app] = answer[app] ?? 'unavailable';
        else {
          delete states[app];
          failed.push(app);
        }
      }
      this.snapshots.set(permission, { states, failed, checked: { ...before.checked, [group]: Date.now() } });
      this.notify();
      return answer;
    };
    const result = check();
    this.pending.set(key, { controller, confirm, result });
    return result;
  }
}
