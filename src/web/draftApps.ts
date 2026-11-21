import type { DraftApp, DraftAppAvailability, DraftAppState } from '../shared/apps';
import type { Messages } from './i18n';

export interface DraftAppSelection {
  selected: DraftApp[];
  states: Partial<DraftAppAvailability>;
  removed: DraftApp[];
  failed: DraftApp[];
  open: () => void;
  verifySlack: () => Promise<boolean>;
  retry: () => void;
  onChange: (apps: DraftApp[]) => void;
}

// An expired Slack check still represents the user's choice. Sending explicitly verifies it again.
export function canConfirmSelectedApp(app: DraftApp, state?: DraftAppState): boolean {
  return state === 'ready' || (app === 'slack' && state === 'needs-verification');
}

export function unavailableSelectedApps(selected: readonly DraftApp[], states: Partial<DraftAppAvailability>): DraftApp[] {
  return selected.filter((app) => states[app] !== undefined && !canConfirmSelectedApp(app, states[app]));
}

export function draftAppName(app: DraftApp, t: Messages): string {
  if (app === 'notion') return 'Notion';
  if (app === 'heptabase') return 'Heptabase';
  return t.tools.relay.groups[app];
}

/** The same line is shown in the draft and sent with the task. Selecting an app changes no tool permissions. */
export function requestedApps(apps: readonly DraftApp[], t: Messages): string {
  return apps.length ? t.apps.requestApps(apps.map((app) => draftAppName(app, t))) : '';
}

export function taskWithApps(text: string, apps: readonly DraftApp[], t: Messages): string {
  const body = text.trim();
  return body && apps.length ? body + '\n\n' + requestedApps(apps, t) : body;
}
