import type { Page } from '@playwright/test';
import { DRAFT_APPS, type DraftAppAvailability } from '../../src/shared/apps';

export function appStates(states: Partial<DraftAppAvailability>): DraftAppAvailability {
  return Object.fromEntries(DRAFT_APPS.map((app) => [app, states[app] ?? 'unavailable'])) as DraftAppAvailability;
}

/** Deterministic connections for form tests; broader live connector checks run against the server's discovery endpoint. */
export async function availableDraftApps(page: Page, states: Partial<DraftAppAvailability>) {
  await page.route('**/api/apps/availability?*', (route) => route.fulfill({ json: appStates(states) }));
  // The signed-in shell starts checking at load, before the test opens either composer.
  await page.reload();
}
