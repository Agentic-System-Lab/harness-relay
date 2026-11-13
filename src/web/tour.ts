// Whether this browser has seen the guided tour: what the page needs at once, apart from the tour
// itself (components/Onboarding.tsx), which loads only when it opens.

/** The version of the tour this browser last finished (or skipped); before versions, `'1'`. */
const DONE_KEY = 'relay:onboarded';

/**
 * Raise it when the steps change in a way worth seeing: people who finished an earlier version see the tour again
 * once, on their next visit. `test/tour.test.ts` fails when the steps change, as a reminder.
 */
export const TOUR_VERSION = 14;

/** Whether the stored version (`DONE_KEY`) means the current tour was seen; a newer one counts too. */
export function tourSeen(stored: string | null, version = TOUR_VERSION): boolean {
  return Number(stored) >= version;
}

export function onboardingDone(): boolean {
  try {
    return tourSeen(localStorage.getItem(DONE_KEY));
  } catch {
    return true; // no storage: don't show the tour on every visit
  }
}

export function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, String(TOUR_VERSION));
  } catch {
    /* storage unavailable */
  }
}
