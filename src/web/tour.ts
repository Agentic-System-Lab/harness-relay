// This browser's last finished or skipped tour. Pre-versioned tours stored '1' in the same key.
const DONE_KEY = 'relay:onboarded';
export const TOUR_VERSION = 40;

/** Ordered like tour.steps in both locales. Each revision is when that step last changed for readers. */
export const TOUR_STEPS: { target?: string; revision: number }[] = [
  { revision: 17 }, // welcome
  { target: 'settings', revision: 20 }, // check agents
  { target: 'pair-phone', revision: 23 }, // connect a phone
  { target: 'settings', revision: 36 }, // model connections
  { target: 'new-chat', revision: 37 }, // new chat
  { revision: 20 }, // auto team
  { revision: 1 }, // modes
  { revision: 9 }, // writing a message
  { revision: 1 }, // while the team replies
  { revision: 18 }, // when the team needs you
  { target: 'settings', revision: 23 }, // notifications and sound
  { target: 'inbox', revision: 18 },
  { revision: 14 }, // permissions
  { revision: 21 }, // team checks
  { revision: 40 }, // files
  { revision: 20 }, // share
  { target: 'new-schedule', revision: 37 },
  { target: 'organize', revision: 17 },
  { target: 'settings', revision: 33 }, // common apps and the tool library
  { target: 'settings', revision: 4 }, // agent sessions
  { target: 'settings', revision: 20 }, // settings
];

export function tourIndices(since: number): number[] {
  return TOUR_STEPS.flatMap((step, index) => (step.revision > since ? [index] : []));
}

function storedVersion(stored: string | null): number {
  const version = Number(stored);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

/** Zero opens the full tour, a positive version opens the changes since then, null means up to date. */
export function pendingTour(): number | null {
  try {
    const seen = storedVersion(localStorage.getItem(DONE_KEY));
    return seen >= TOUR_VERSION ? null : seen;
  } catch {
    return null; // No storage: the full tour stays available from Settings.
  }
}

export function markDone(): void {
  try {
    if (storedVersion(localStorage.getItem(DONE_KEY)) < TOUR_VERSION) localStorage.setItem(DONE_KEY, String(TOUR_VERSION));
  } catch {
    /* storage unavailable */
  }
}
