import type { SandboxSetupView, SandboxUser } from '../shared/types';

/*
 * What the page shows of the agents' sandboxes' setup (`src/server/sandboxSetup.ts`): Settings →
 * Sandboxes (`components/SandboxSetup.tsx`), and the dialog New chat opens while something is missing
 * (`components/SandboxSetupDialog.tsx`), once in this browser: Not now leaves it to Settings.
 */

/** Where this browser keeps that its user answered the dialog (Not now, or an install started). */
export const ASKED_KEY = 'relay:sandbox-setup-asked';

export function readAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* asked again next time */
  }
}

/** Whether New chat opens the dialog: something is missing, no install of it runs, and this browser was not asked yet. */
export function askOnNewChat(view: SandboxSetupView | undefined, asked: boolean): boolean {
  return Boolean(view && view.needs.length && view.job?.state !== 'running' && !asked);
}

/** Whether Install does anything here: some need is not blocked, and no install runs. */
export function canInstall(view: SandboxSetupView | undefined): boolean {
  return Boolean(view && view.job?.state !== 'running' && view.needs.some((n) => !n.blocked));
}

/** Whether the setup is under way (the view is asked again every second while it is). */
export const setupRunning = (view: SandboxSetupView | undefined) => view?.job?.state === 'running';

/** The needs Harness Relay cannot install here, with what to run by hand. */
export const byHand = (view: SandboxSetupView | undefined) => (view?.needs ?? []).filter((n) => n.blocked && n.command);

/** Who a need is for, in words: the CLIs' names, and the open agents' as `open` says. */
export function usersText(users: readonly SandboxUser[], name: (u: Exclude<SandboxUser, 'open'>) => string, open: string, sep = ', '): string {
  return users.map((u) => (u === 'open' ? open : name(u))).join(sep);
}
