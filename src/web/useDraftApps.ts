import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DraftApp } from '../shared/apps';
import type { Permission } from '../shared/types';
import type { DraftAppSelection } from './draftApps';
import { appGroupNames, appGroups, type DraftAppStatus } from './draftAppStatus';
import { useT } from './i18n';

export function useDraftApps(status: DraftAppStatus, selected: DraftApp[], onChange: (apps: DraftApp[]) => void, permission?: Permission) {
  const t = useT();
  const seen = useRef(false);
  const [removed, setRemoved] = useState<DraftApp[]>([]);
  const { states, failed } = useSyncExternalStore(status.subscribe, () => status.snapshot(permission));
  // Keep typing and attachments entered while several independent checks finish.
  const draft = useRef({ selected, onChange });
  draft.current = { selected, onChange };

  useEffect(() => {
    if (!permission) return;
    const timer = setTimeout(() => status.warm(permission), 0);
    return () => clearTimeout(timer);
  }, [status, permission]);

  useEffect(() => {
    const current = draft.current;
    const lost = current.selected.filter((app) => states[app] && states[app] !== 'ready');
    if (!lost.length) return;
    const next = current.selected.filter((app) => !lost.includes(app));
    draft.current = { ...current, selected: next };
    setRemoved((earlier) => [...new Set([...earlier, ...lost])]);
    current.onChange(next);
  }, [states]);

  const selection: DraftAppSelection = {
    selected,
    states,
    failed,
    removed,
    open: () => {
      if (permission) status.warm(permission, seen.current);
      seen.current = true;
    },
    verifySlack: async () => Boolean(permission && (await status.read(permission, 'slack', 'confirm'))?.slack === 'ready'),
    retry: () => {
      if (permission) {
        for (const group of appGroupNames)
          if (appGroups[group].some((app) => failed.includes(app))) void status.read(permission, group, 'refresh');
      }
    },
    onChange: (next) => {
      setRemoved([]);
      onChange(next.filter((app) => states[app] === 'ready' || (!states[app] && selected.includes(app))));
    },
  };

  /** Always recheck the selected apps before creating a conversation or automation, including a folder-creation retry. */
  const verify = async () => {
    const needed = appGroupNames.filter((group) => appGroups[group].some((app) => selected.includes(app)));
    if (!needed.length) return;
    if (!permission) throw new Error(t.apps.draftCheckFailed);
    const results = await Promise.all(needed.map((group) => status.read(permission, group, 'confirm')));
    if (results.some((result) => !result)) throw new Error(t.apps.draftCheckFailed);
    if (
      needed.some((group, i) => appGroups[group].some((app) => selected.includes(app) && results[i]?.[app] !== 'ready')) ||
      selected.some((app) => !draft.current.selected.includes(app))
    )
      throw new Error(t.apps.draftReview);
  };
  return { selection, verify, checkingSelection: selected.some((app) => states[app] !== 'ready') };
}
