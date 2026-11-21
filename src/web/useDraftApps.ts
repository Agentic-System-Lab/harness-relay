import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DraftApp } from '../shared/apps';
import type { Permission } from '../shared/types';
import { canConfirmSelectedApp, unavailableSelectedApps, type DraftAppSelection } from './draftApps';
import { appGroupNames, appGroups, type DraftAppStatus } from './draftAppStatus';
import { useT } from './i18n';

export function useDraftApps(status: DraftAppStatus, selected: DraftApp[], onChange: (apps: DraftApp[]) => void, permission?: Permission) {
  const t = useT();
  const seen = useRef(false);
  const [removed, setRemoved] = useState<DraftApp[]>([]);
  const previousPermission = useRef<Permission>(undefined);
  const snapshot = useSyncExternalStore(status.subscribe, () => status.snapshot(permission));
  const { states, failed } = snapshot;
  // Keep typing and attachments entered while several independent checks finish.
  const draft = useRef({ selected, onChange });
  draft.current = { selected, onChange };

  useLayoutEffect(() => {
    if (!permission) return;
    const previous = previousPermission.current;
    previousPermission.current = permission;
    const known = status.snapshot(permission).states;
    const conflict = unavailableSelectedApps(draft.current.selected, known).length > 0;
    status.prepare(permission, Boolean((previous && previous !== permission) || conflict));
    const timer = setTimeout(() => status.warm(permission), 0);
    return () => clearTimeout(timer);
  }, [status, permission]);

  useEffect(() => {
    if (!permission) return;
    let timer: ReturnType<typeof setTimeout>;
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      timer = setTimeout(() => status.recheck(permission), 0);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [status, permission]);

  useEffect(() => {
    if (status.snapshot(permission) !== snapshot) return;
    const current = draft.current;
    const lost = unavailableSelectedApps(current.selected, states);
    if (!lost.length) return;
    const next = current.selected.filter((app) => !lost.includes(app));
    draft.current = { ...current, selected: next };
    setRemoved((earlier) => [...new Set([...earlier, ...lost])]);
    current.onChange(next);
  }, [status, permission, snapshot, states]);

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
      onChange(
        next.filter(
          (app) => states[app] === 'ready' || (selected.includes(app) && (!states[app] || canConfirmSelectedApp(app, states[app]))),
        ),
      );
    },
  };

  /** Always recheck the selected apps before creating a conversation or automation, including a folder-creation retry. */
  const verify = async () => {
    if (!selected.length) return;
    if (!permission) throw new Error(t.apps.draftCheckFailed);
    const result = await status.confirmSelection(permission, selected);
    if (result === 'failed') throw new Error(t.apps.draftCheckFailed);
    if (result === 'changed' || selected.some((app) => !draft.current.selected.includes(app))) throw new Error(t.apps.draftReview);
  };
  return { selection, verify, checkingSelection: selected.some((app) => !canConfirmSelectedApp(app, states[app])) };
}
