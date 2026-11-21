import { useCallback, useEffect, useRef, useState } from 'react';
import { LOCAL_DRAFT_APPS, type DraftApp, type DraftAppAvailability } from '../shared/apps';
import type { Permission } from '../shared/types';
import { api } from './api';
import type { DraftAppSelection } from './draftApps';
import { useT } from './i18n';

// Checking remote CLI connections can take longer than reading Relay's own connections.
const groups = {
  local: LOCAL_DRAFT_APPS,
  slack: ['slack'],
  github: ['github'],
  teams: ['teams'],
} as const satisfies Record<string, readonly DraftApp[]>;
type Group = keyof typeof groups;
const groupNames = Object.keys(groups) as Group[];
interface Snapshot {
  permission?: Permission;
  states: Partial<DraftAppAvailability>;
  failed: DraftApp[];
}

export function useDraftApps(selected: DraftApp[], onChange: (apps: DraftApp[]) => void, permission?: Permission) {
  const t = useT();
  const [opened, setOpened] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>({ states: {}, failed: [] });
  const [removed, setRemoved] = useState<DraftApp[]>([]);
  const requests = useRef(new Map<Group, AbortController>());
  const active = opened || selected.length > 0;
  // Keep typing and other fields entered while checking. Two simultaneous results must prune the same latest selection.
  const draft = useRef({ selected, onChange });
  draft.current = { selected, onChange };

  const read = useCallback(
    async (group: Group, verifySlack = false) => {
      if (!permission) return;
      const apps: readonly DraftApp[] = groups[group];
      requests.current.get(group)?.abort();
      const controller = new AbortController();
      requests.current.set(group, controller);
      const update = (result?: DraftAppAvailability, failed = false) => {
        setSnapshot((previous) => {
          const states = previous.permission === permission ? { ...previous.states } : {};
          const failures = previous.permission === permission ? previous.failed.filter((app) => !apps.includes(app)) : [];
          for (const app of apps) {
            if (result) states[app] = result[app] ?? 'unavailable';
            else delete states[app];
          }
          return { permission, states, failed: failed ? [...failures, ...apps] : failures };
        });
      };
      update();
      try {
        const result =
          group === 'slack' && verifySlack
            ? await api.verifyDraftSlack(permission, controller.signal)
            : await api.draftAppAvailability(controller.signal, permission, group);
        if (controller.signal.aborted) return;
        update(result);
        const current = draft.current;
        const lost = current.selected.filter((app) => apps.includes(app) && result[app] !== 'ready');
        if (lost.length) {
          const next = current.selected.filter((app) => !lost.includes(app));
          draft.current = { ...current, selected: next };
          setRemoved((earlier) => [...new Set([...earlier, ...lost])]);
          current.onChange(next);
        }
        return result;
      } catch {
        if (!controller.signal.aborted) update(undefined, true);
      }
    },
    [permission],
  );

  useEffect(() => {
    if (!active || !permission) return;
    const refresh = () => {
      for (const group of groupNames) void read(group);
    };
    refresh();
    let timer: ReturnType<typeof setTimeout>;
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      // Returning from another window can cause both events. Hide the old answers immediately.
      clearTimeout(timer);
      for (const controller of requests.current.values()) controller.abort();
      setSnapshot({ permission, states: {}, failed: [] });
      timer = setTimeout(refresh, 0);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      clearTimeout(timer);
      for (const controller of requests.current.values()) controller.abort();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [active, read, permission]);

  const states = snapshot.permission === permission ? snapshot.states : {};
  const failed = snapshot.permission === permission ? snapshot.failed : [];
  const selection: DraftAppSelection = {
    selected,
    states,
    failed,
    removed,
    open: () => {
      setOpened(true);
      if (active) for (const group of groupNames) void read(group);
    },
    verifySlack: async () => (await read('slack', true))?.slack === 'ready',
    retry: () => {
      for (const group of groupNames) if (groups[group].some((app) => failed.includes(app))) void read(group);
    },
    onChange: (next) => {
      setRemoved([]);
      onChange(next.filter((app) => states[app] === 'ready' || (!states[app] && selected.includes(app))));
    },
  };

  /** Recheck the apps in this submission immediately before each create request, including a folder-creation retry. */
  const verify = async () => {
    const needed = groupNames.filter((group) => groups[group].some((app) => selected.includes(app)));
    const results = await Promise.all(needed.map((group) => read(group, group === 'slack')));
    if (results.some((result) => !result)) throw new Error(t.apps.draftCheckFailed);
    if (
      needed.some((group, i) => groups[group].some((app) => selected.includes(app) && results[i]?.[app] !== 'ready')) ||
      selected.some((app) => !draft.current.selected.includes(app))
    )
      throw new Error(t.apps.draftReview);
  };
  return { selection, verify, checkingSelection: selected.some((app) => states[app] !== 'ready') };
}
