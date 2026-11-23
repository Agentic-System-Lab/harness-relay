import { ENV_NAME_RE, MAX_PASS_ENV } from '../shared/agentEnv';
import type { Provider, SettingsView } from '../shared/types';

/*
 * The page's part of which model keys of the server's environment each CLI is given (src/server/agentEnv.ts):
 * Settings → a CLI's card → Environment variables (`components/AgentEnvSettings.tsx`), and the notice
 * New chat shows once in this browser while some CLI is not given a key it used to get
 * (`components/WithheldEnvDialog.tsx`).
 */

/** Where this browser keeps that its user saw the notice. */
export const NOTICE_KEY = 'relay:withheld-env-seen';

export function readNoticeSeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* shown again next time */
  }
}

/**
 * The CLIs whose runs are not given some key of the server's environment, with those keys' names, in
 * Settings' order; with `installed`, only the CLIs it says are there (one that is not has no runs).
 */
export function withheldByCli(
  view: SettingsView | undefined,
  installed?: (p: Provider) => boolean,
): { provider: Provider; names: string[] }[] {
  return (view?.providers ?? []).flatMap((p) =>
    p.environment?.withheld.length && (!installed || installed(p.provider))
      ? [{ provider: p.provider, names: p.environment.withheld }]
      : [],
  );
}

/** Whether New chat shows the notice: some installed CLI is not given a key of the server's, and this browser has not seen it. */
export function showNotice(view: SettingsView | undefined, seen: boolean, installed?: (p: Provider) => boolean): boolean {
  return !seen && withheldByCli(view, installed).length > 0;
}

/** Why a name cannot be added to a pass-through list: not a name, there already, or the list is full. */
export type PassNameError = 'name' | 'twice' | 'full';

/** The list with `input` added at its end (trimmed), or why it cannot be. */
export function addPassName(list: readonly string[], input: string): { list: string[] } | { error: PassNameError } {
  const name = input.trim();
  if (!ENV_NAME_RE.test(name)) return { error: 'name' };
  if (list.includes(name)) return { error: 'twice' };
  if (list.length >= MAX_PASS_ENV) return { error: 'full' };
  return { list: [...list, name] };
}

/** The list without `name`. */
export const removePassName = (list: readonly string[], name: string): string[] => list.filter((n) => n !== name);
