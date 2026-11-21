import type { Messages } from './i18n';

export const DRAFT_APPS = ['mail', 'calendar', 'teams', 'slack', 'drive', 'notion', 'heptabase', 'obsidian', 'github', 'browser'] as const;
export type DraftApp = (typeof DRAFT_APPS)[number];

export interface DraftAppSelection {
  selected: DraftApp[];
  onChange: (apps: DraftApp[]) => void;
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
